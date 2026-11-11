// Character Cells — chat conversion + ledger backfill
// Two jobs:
//  1. STRIP-COPY: create a copy of the current chat with FF5 internal-states
//     blocks removed (prose/dialogue/legit GFX kept, original chat untouched),
//     switch to it, and reset the cell state for a clean rebuild.
//  2. BACKFILL: walk the cleaned chat from turn 0 in small batches, one cheap
//     bookkeeper-style call per batch (Summaryception's "process backlog"),
//     building cells/bonds/events from real history; seeds tier detection.
// (Option C digests live in digest.js.)

import { chat, chat_metadata, characters, this_chid, saveChat, openCharacterChat, saveChatDebounced } from '../../../../script.js';
import { selected_group } from '../../../../scripts/group-chats.js';
import { getState, getLedger } from './state.js';
import { buildBookkeeperStateSummary } from './inject.js';
import { parseCommand, applyCommand } from './commands.js';
import { logScene, applyAutoTier } from './tiers.js';
import { cheapCall } from './llm.js';
import { LOG_PREFIX } from './config.js';

// ================================================================ 1. strip-copy

/**
 * Remove every FF5 internal-states block from a message text. Handles the
 * GFX-wrapped and bare forms; leaves prose, dialogue, the time/location
 * header, and non-state GFX (phone screens, letters) untouched.
 * Exported for tests.
 */
export function stripInternalStates(text) {
    let s = String(text || '');
    s = s.replace(/<!-- GFX_START -->\s*<internal_states[\s\S]*?<\/internal_states>\s*<!-- GFX_END -->/g, '');
    s = s.replace(/<internal_states[\s\S]*?<\/internal_states>/g, '');
    s = s.replace(/\n{3,}/g, '\n\n').trim();
    return s;
}

function countStateBlocks(text) {
    return (String(text || '').match(/<internal_states/g) || []).length;
}

/** Create a cleaned copy of the current chat and switch to it. */
export async function cleanCopyChat() {
    if (selected_group) {
        toastr.warning('Strip-copy is not available for group chats yet.', 'Character Cells');
        return;
    }
    const char = characters[this_chid];
    if (!char || !Array.isArray(chat) || !chat.length) {
        toastr.warning('No chat open to copy.', 'Character Cells');
        return;
    }
    const srcName = char.chat || 'chat';
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', 'h');
    const newName = `${srcName} (cells-clean) ${stamp}.jsonl`;

    let removed = 0;
    const cleaned = chat.map(m => {
        const c = { ...m };
        if (c.mes && countStateBlocks(c.mes)) {
            removed += countStateBlocks(c.mes);
            c.mes = stripInternalStates(c.mes);
        }
        if (Array.isArray(c.swipes) && c.swipes.some(s => countStateBlocks(s))) {
            c.swipes = c.swipes.map(stripInternalStates);
        }
        return c;
    });
    if (!removed) {
        toastr.info('No internal-states blocks found in this chat — nothing to clean.', 'Character Cells');
        return;
    }

    // Fresh state for the copy: the backfill rebuilds it from real history.
    const metadata = { ...chat_metadata, character_cells: makeFreshState() };

    toastr.info(`Cleaning ${removed} state block(s)…`, 'Character Cells');
    await saveChat({ chatName: newName, withMetadata: metadata, chatData: cleaned, force: true });
    await openCharacterChat(newName);
    toastr.success(`Clean copy created (${removed} state block(s) removed). Now run the backfill from the panel.`, 'Character Cells', { timeOut: 8000 });
    console.log(`${LOG_PREFIX} strip-copy: ${removed} state block(s) removed → ${newName}`);
}

function makeFreshState() {
    return {
        version: 1,
        world: {
            notes: [], factions: [], quests: [], chekhov: [], roll: {},
            combat: { mode: 'N/A', engagement: 'N/A', wounds: 'None', exchange: 'N/A' },
            env: '', physics: '', time: '', turn: 0,
        },
        cells: [], ledger: [], tierLog: [], digests: {},
    };
}

// ================================================================ 2. backfill

const SYSTEM_PROMPT = 'You are a state tracker for a roleplay session. You read a short scene and the current tracked state, then output state-change commands. You never write prose, never narrate, never comment. Output ONLY command lines, one per line, in the exact grammar given. If nothing in the scene changes the state, output nothing.';

let backfillRunning = false;
let backfillCancel = false;

/** Consecutive non-system messages, batch size counted in messages. */
function batchSceneText(startIdx, batchSize) {
    const msgs = [];
    let i = startIdx;
    while (i < chat.length && msgs.length < batchSize) {
        const m = chat[i];
        if (m.is_system) { i++; continue; }
        msgs.push(`${m.is_user ? 'USER' : 'AI'}: ${String(m.mes || '').trim()}`);
        i++;
    }
    return { text: msgs.join('\n\n'), endIdx: i };
}

/**
 * Backfill the ledger from the chat's full history, batch by batch.
 * Progress is checkpointed into the state, so a cancelled run resumes where
 * it stopped. A completed run is marked `backfill.done` and not repeated.
 */
export async function backfillLedger(progress = null) {
    if (backfillRunning) {
        toastr.warning('A backfill is already running.', 'Character Cells');
        return;
    }
    const state = getState();
    if (state.backfill?.done) {
        toastr.info('This chat was already backfilled.', 'Character Cells');
        return;
    }
    if (!Array.isArray(chat) || chat.length < 2) {
        toastr.warning('Chat has no history to backfill.', 'Character Cells');
        return;
    }

    backfillRunning = true;
    backfillCancel = false;
    const BATCH = 4; // messages per call
    const startTime = Date.now();
    let totalCommands = 0;
    let batches = 0;
    state.backfill = state.backfill || {};
    state.backfill.running = true;
    const sceneRoles = {};

    try {
        let i = Number(state.backfill.progress) || 0;
        if (i > 0) toastr.info(`Resuming backfill at message ${i + 1}/${chat.length}…`, 'Character Cells');

        while (i < chat.length && !backfillCancel) {
            const { text, endIdx } = batchSceneText(i, BATCH);
            if (!text) break;
            batches++;
            try {
                const reply = await cheapCall(SYSTEM_PROMPT, buildBackfillPrompt(text), 600);
                const lines = String(reply || '').split('\n').map(l => l.trim()).filter(Boolean);
                const turn0 = Number(state.world.turn) || 0;
                let applied = 0;
                for (const line of lines) {
                    const cmd = parseCommand(line);
                    if (!cmd) continue;
                    try {
                        const r = applyCommand(cmd, turn0, sceneRoles);
                        if (r && !String(r).startsWith('skip') && r !== 'dup') applied++;
                    } catch { /* malformed line — skip */ }
                }
                totalCommands += applied;
                if (Object.keys(sceneRoles).length) logScene({ ...sceneRoles });
            } catch (err) {
                console.warn(`${LOG_PREFIX} backfill batch failed at msg ${i}:`, err);
            }
            state.backfill.progress = endIdx;
            saveChatDebounced();
            progress?.(`Batch ${batches} — message ${endIdx}/${chat.length} (${totalCommands} commands)`);
            i = endIdx;
        }

        state.backfill.running = false;
        if (backfillCancel) {
            toastr.info(`Backfill cancelled at message ${state.backfill.progress}/${chat.length}. Run it again to resume.`, 'Character Cells');
            return;
        }
        state.backfill.done = true;
        delete state.backfill.progress;
        saveChatDebounced();
        // Free bonus: seed tier detection from the full participation history.
        const tierChanges = applyAutoTier();
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        toastr.success(
            `Backfill complete: ${batches} batches, ${totalCommands} state changes` +
            `${tierChanges.length ? `, tiers: ${tierChanges.join('; ')}` : ''} — ${elapsed}s. Ledger: ${getLedger().length} events.`,
            'Character Cells', { timeOut: 10000 });
        console.log(`${LOG_PREFIX} backfill done: ${batches} batches, ${totalCommands} commands, ${tierChanges.length} tier changes`);
    } finally {
        backfillRunning = false;
        const s = getState();
        if (s.backfill) { s.backfill.running = false; saveChatDebounced(); }
    }
}

export function cancelBackfill() { backfillCancel = true; }
export function isBackfillRunning() { return backfillRunning; }

/** Prompt for one backfill batch. State summary + batch scene + grammar. */
function buildBackfillPrompt(sceneText) {
    return `CURRENT STATE (JSON):
${buildBookkeeperStateSummary()}

HISTORICAL SCENE (an early exchange from this chat's past):
${sceneText}

OUTPUT GRAMMAR — one command per line, nothing else:
memory_add(what="...", who=<cellId>,<cellId>,... , imp=<1-3>)   # an event worth remembering; who = every character present who saw it
witness(<eventId>, <cellId>)                                    # an existing event (from recent_events) that this character also witnessed
bond(<cellId>, user|sparks|grudge, <+1|-1|+2|-2>)               # relationship shift the scene shows
agenda_step(<cellId>) / agenda_set(<cellId>, goal="...", location="...", max=<n>)
status(<cellId>, "...") / presence(<cellId>, on|off) / appear(<cellId>, spoke|acted|present)
chekhov(<chekhovId>, active|locked|fired) / turn()

RULES:
- Only what the scene text actually shows. No speculation.
- Cell ids MUST come from CURRENT STATE. Never invent ids.
- appear: emit for EVERY character who took part, exactly once each. USER is a participant — use their cell id from CURRENT STATE.
- imp: 3 = plot-critical, 2 = notable, 1 = minor color.
- This is an EARLY scene: characters who act here but have no cell in CURRENT STATE were not tracked yet. Skip commands for them; later batches will cover them.`;
}
