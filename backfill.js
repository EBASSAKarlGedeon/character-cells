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
import { getState, getLedger, hasState, chatToken, sameChat, makeWorldState } from './state.js';
import { stripInternalStates, countStateBlocks } from './strip.js';

export { stripInternalStates }; // the strip logic lives in strip.js (pure → unit-testable in Node)
import { buildBookkeeperStateSummary } from './inject.js';
import { parseCommand, applyCommand, AUTO_CREATE_CAP } from './commands.js';
import { logScene, applyAutoTier } from './tiers.js';
import { cheapCall } from './llm.js';
import { LOG_PREFIX } from './config.js';

// ================================================================ 1. strip-copy (block stripping: strip.js)

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
    let removedSwipes = 0; // C9: blocks inside swipes are counted and stripped too
    const cleaned = chat.map(m => {
        const c = { ...m };
        if (c.mes && countStateBlocks(c.mes)) {
            removed += countStateBlocks(c.mes);
            c.mes = stripInternalStates(c.mes);
        }
        if (Array.isArray(c.swipes) && c.swipes.some(s => countStateBlocks(s))) {
            removedSwipes += c.swipes.reduce((n, s) => n + countStateBlocks(s), 0);
            c.swipes = c.swipes.map(stripInternalStates);
        }
        return c;
    });
    if (!removed && !removedSwipes) {
        toastr.info('No internal-states blocks found in this chat — nothing to clean.', 'Character Cells');
        return;
    }

    // C10: the copy carries the cell state over ONLY for an IMPORTED chat (slice 8: the
    // Import button seeds exact final values first — resetting would lose them; the HTML
    // blocks are stripped from the copy's text, so import must run before cleaning; the
    // backfill is then SEEDED = ledger-only). A chat that was never imported gets a FRESH
    // state (cells, ledger, world): the backfill replays the whole history with accumulating
    // ops (bond, inventory…), which would double-count on top of live-play state.
    // Backfill progress resets either way.
    let carriedState = null;
    if (hasState() && chat_metadata.character_cells.imported) {
        carriedState = JSON.parse(JSON.stringify(chat_metadata.character_cells));
        carriedState.backfill = { running: false };
        delete carriedState.backfill.progress;
    }
    const metadata = { ...chat_metadata, character_cells: carriedState || makeFreshState() };

    toastr.info(`Cleaning ${removed + removedSwipes} state block(s)…`, 'Character Cells');
    await saveChat({ chatName: newName, withMetadata: metadata, chatData: cleaned, force: true });
    await openCharacterChat(newName);
    toastr.success(`Clean copy created (${removed} state block(s) removed from messages, ${removedSwipes} from swipes). Now run the backfill from the panel.`, 'Character Cells', { timeOut: 8000 });
    console.log(`${LOG_PREFIX} strip-copy: ${removed} message + ${removedSwipes} swipe state block(s) removed → ${newName}`);
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
 * it stopped (including the virtual turn counter). A FAILED batch is recorded in
 * `backfill.failed` and retried first on the next run; `backfill.done` is set
 * only when no batch failed, and a done run is not repeated.
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

    // SEEDED MODE (slice 8): the state was imported from a final internal-states
    // block, so the backfill does LEDGER work only — accumulating commands are
    // stripped from the grammar AND filtered here, so imported values are never
    // double-counted.
    const seeded = !!state.imported;
    state.backfill = state.backfill || {};
    // C10 (DECIDED): a NON-seeded backfill replays the whole history including accumulating
    // ops (bond, inventory…). On top of live-play state that double-counts, so a fresh run
    // starts from a clean slate — cells, ledger and world are reset first. (The strip-copy
    // already hands over a fresh state; this covers running the backfill directly on a
    // chat that still holds live state, so it asks first.)
    const resuming = Number(state.backfill.progress) > 0 || (Array.isArray(state.backfill.failed) && state.backfill.failed.length > 0);
    if (!seeded && !resuming) {
        const live = state.cells.some(c => !c.fixed) || (Array.isArray(state.ledger) && state.ledger.length > 0) || Number(state.world?.turn) > 0;
        if (live) {
            const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
                && window.confirm('This chat already has tracked state (cells / ledger / turn). A backfill replays the WHOLE history and would double-count on top of it.\n\nReset cells, ledger and world first, then backfill?');
            if (!ok) { toastr.info('Backfill not started — existing state kept.', 'Character Cells'); return; }
            resetStateForReplay(state);
        }
    }

    backfillRunning = true;
    backfillCancel = false;
    const token = chatToken(); // B1: a backfill belongs to ONE chat
    const BATCH = 4; // messages per call
    const startTime = Date.now();
    let totalCommands = 0;
    let batches = 0;
    state.backfill.running = true;
    // Turn accounting fix (all backfills): events stamp with a LOCAL virtual
    // turn counter incremented by turn() commands — historical turns instead
    // of everything stamped with the current world.turn. C4: persisted at every
    // checkpoint and restored on resume, so a resumed run continues the clock.
    let virtualTurn = Number(state.backfill.virtualTurn) || 0;
    // C1: batches that failed earlier are retried FIRST; failures in this run are recorded.
    const queue = (Array.isArray(state.backfill.failed) ? state.backfill.failed : []).map(Number).filter(Number.isFinite);
    const pendingFailed = new Set(queue);
    const stopped = () => {
        console.warn(`${LOG_PREFIX} backfill aborted: chat changed`);
        toastr.warning('Backfill stopped — you switched chats. Run it again in the original chat to resume.', 'Character Cells');
    };

    try {
        let i = Number(state.backfill.progress) || 0;
        if (i > 0 || queue.length) toastr.info(`Resuming backfill at message ${i + 1}/${chat.length}${queue.length ? ` (+${queue.length} failed batch(es) to retry)` : ''}…`, 'Character Cells');

        while (!backfillCancel) {
            if (!sameChat(token)) { stopped(); return; } // C3: never apply/save into another chat
            const isRetry = queue.length > 0;
            if (!isRetry && i >= chat.length) break;
            const start = isRetry ? queue.shift() : i;
            const { text, endIdx } = batchSceneText(start, BATCH);
            if (!text) { if (isRetry) { pendingFailed.delete(start); continue; } break; }
            batches++;
            const sceneRoles = {}; // C5: per batch — a stale role map would be logged again for every later batch
            let ok = false;
            try {
                const reply = await cheapCall(SYSTEM_PROMPT, buildBackfillPrompt(text, seeded), 2048);
                if (!sameChat(token)) { stopped(); return; }
                const lines = String(reply || '').split('\n').map(l => l.trim()).filter(Boolean);
                // Two passes: char_add first (cells must exist before other
                // commands reference them), everything else second.
                const cmds = lines.map(line => ({ line, cmd: parseCommand(line) })).filter(x => x.cmd && (!seeded || SEEDED_OPS.has(x.cmd.op)));
                const creates = [], rest = [];
                for (const x of cmds) (x.cmd.op === 'char_add' ? creates : rest).push(x);
                let applied = 0;
                let created = 0;
                for (const { line, cmd } of [...creates, ...rest]) {
                    if (cmd.op === 'char_add' && created >= AUTO_CREATE_CAP) continue;
                    try {
                        const r = applyCommand(cmd, virtualTurn, sceneRoles, { onTurn: () => { virtualTurn++; } });
                        if (r && r.startsWith('char_add:') && !r.includes('already tracked')) created++;
                        if (r && !String(r).startsWith('skip') && r !== 'dup') applied++;
                    } catch (e) {
                        console.warn(`${LOG_PREFIX} backfill: command failed (msg ${start}): ${line}`, e); // C2: never swallow silently
                    }
                }
                totalCommands += applied;
                if (Object.keys(sceneRoles).length) logScene({ ...sceneRoles });
                ok = true;
            } catch (err) {
                if (!sameChat(token)) { stopped(); return; } // C3: catch path too — skip the save
                console.warn(`${LOG_PREFIX} backfill batch failed at msg ${start}:`, err);
            }
            if (ok) pendingFailed.delete(start); else pendingFailed.add(start); // C1: recorded, never silently skipped
            if (!isRetry) { state.backfill.progress = endIdx; i = endIdx; }
            state.backfill.virtualTurn = virtualTurn; // C4
            state.backfill.failed = [...pendingFailed];
            saveChatDebounced();
            progress?.(`Batch ${batches} — message ${Math.min(i, chat.length)}/${chat.length} (${totalCommands} commands${pendingFailed.size ? `, ${pendingFailed.size} failed` : ''})`);
        }

        state.backfill.running = false;
        state.backfill.failed = [...pendingFailed];
        if (backfillCancel) {
            saveChatDebounced();
            toastr.info(`Backfill cancelled at message ${state.backfill.progress}/${chat.length}. Run it again to resume.`, 'Character Cells');
            return;
        }
        if (pendingFailed.size) {
            // C1: never `done` with a failed batch — the next run retries exactly those.
            saveChatDebounced();
            toastr.warning(`Backfill finished with ${pendingFailed.size} FAILED batch(es) (${batches} run, ${totalCommands} state changes) — NOT marked done. Run it again to retry just those.`, 'Character Cells', { timeOut: 12000 });
            console.warn(`${LOG_PREFIX} backfill incomplete: failed batch start(s) ${[...pendingFailed].join(', ')}`);
            return;
        }
        state.backfill.done = true;
        delete state.backfill.progress;
        delete state.backfill.failed;
        delete state.backfill.virtualTurn;
        // C7 (DECIDED): sync the world clock to the replayed history. A fresh (reset) world
        // lands exactly on the final virtual turn; a SEEDED chat keeps its imported turn
        // unless the replay ran further — the hot window / digests use world.turn.
        state.world.turn = Math.max(Number(state.world.turn) || 0, virtualTurn);
        saveChatDebounced();
        // Free bonus: seed tier detection from the full participation history.
        const tierChanges = applyAutoTier();
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        toastr.success(
            `Backfill complete: ${batches} batches (0 failed), ${totalCommands} state changes` +
            `${tierChanges.length ? `, tiers: ${tierChanges.join('; ')}` : ''} — ${elapsed}s. Ledger: ${getLedger().length} events, turn ${state.world.turn}.`,
            'Character Cells', { timeOut: 10000 });
        console.log(`${LOG_PREFIX} backfill done: ${batches} batches, ${totalCommands} commands, ${tierChanges.length} tier changes, world.turn → ${state.world.turn}`);
    } finally {
        backfillRunning = false;
        const s = sameChat(token) ? getState() : state; // never touch another chat's state
        if (s.backfill) { s.backfill.running = false; if (sameChat(token)) saveChatDebounced(); }
    }
}

/** C10: wipe everything the replay rebuilds (cells, ledger, world, tier history, digests). Keeps backfill/import bookkeeping. */
function resetStateForReplay(s) {
    s.world = makeWorldState();
    s.cells = [];
    s.ledger = [];
    s.tierLog = [];
    s.digests = {};
    s.digestRetry = {};
    delete s.present;
    delete s.povId;
    getState(); // re-adds the user cell on the same state object
}

export function cancelBackfill() { backfillCancel = true; }
export function isBackfillRunning() { return backfillRunning; }

/** Ops allowed in SEEDED mode: ledger work only (final values were imported). */
const SEEDED_OPS = new Set(['memory_add', 'witness', 'appear', 'turn']);

/** Prompt for one backfill batch. State summary + batch scene + grammar. */
function buildBackfillPrompt(sceneText, seeded = false) {
    const grammar = seeded
        ? `OUTPUT GRAMMAR — one command per line, nothing else:
memory_add(what="...", who=<cellId>,<cellId>,... , imp=<1-3>)   # an event worth remembering; who = every character present who saw it
witness(<eventId>, <cellId>)                                    # an existing event (from recent_events) that this character also witnessed
appear(<cellId>, spoke|acted|present)                           # who took part and how
turn()                                                          # emit once when the scene ends a story turn

RULES:
- This chat's state was IMPORTED from the story's final values (bonds, inventory, agendas, bullets are already exact). Do NOT re-derive or re-apply them.
- Your ONLY job is the event ledger: what happened, who saw it. Relationship moments belong in memory_add even though the numbers are already set.
- Only what the scene text actually shows. No speculation.
- Cell ids MUST come from CURRENT STATE. Never invent ids.
- appear: emit for EVERY character who took part, exactly once each. USER is a participant — use their cell id from CURRENT STATE.
- imp: 3 = plot-critical, 2 = notable, 1 = minor color.`
        : `OUTPUT GRAMMAR — one command per line, nothing else:
char_add(name="...", desc="...", present=onstage|offstage, location="...")  # a NEW named character taking part — create their cell FIRST (see rules)
memory_add(what="...", who=<cellId>,<cellId>,... , imp=<1-3>)   # an event worth remembering; who = every character present who saw it
witness(<eventId>, <cellId>)                                    # an existing event (from recent_events) that this character also witnessed
bond(<cellId>, sparks|grudge, <+1|-1|+2|-2>)                    # relationship shift the scene shows (direct BOND drops: bond(<cellId>, user, -1|-2))
agenda_step(<cellId>) / agenda_set(<cellId>, goal="...", location="...", max=<n>)
status(<cellId>, "...") / presence(<cellId>, on|off) / appear(<cellId>, spoke|acted|present)
inv(<cellId>, +item|-item) / title(<cellId>, +name|-name)
plant(text="...", weight=<1-3>, secret=<true|false>)            # a promise/setup/secret the story planted in this scene
thought(<cellId>, "...") / note_add(type=R|T|D, text="...")
chekhov(<chekhovId>, active|locked|fired) / turn()

RULES:
- Only what the scene text actually shows. No speculation.
- Cell ids MUST come from CURRENT STATE. Never invent ids.
- This is an EARLY scene: if a NAMED character takes part here who has no cell in CURRENT STATE, create them with char_add FIRST (desc = one line, only what this scene shows), then emit their other commands. NEVER for the user, groups/crowds, or someone merely mentioned. At most ${AUTO_CREATE_CAP} new characters per batch.
- appear: emit for EVERY character who took part, exactly once each. USER is a participant — use their cell id from CURRENT STATE.
- imp: 3 = plot-critical, 2 = notable, 1 = minor color.
- BOND never rises directly: positive shifts go to Sparks; only insults/betrayals lower BOND directly.`;

    return `CURRENT STATE (JSON):
${buildBookkeeperStateSummary()}

HISTORICAL SCENE (an early exchange from this chat's past):
${sceneText}

${grammar}`;
}
