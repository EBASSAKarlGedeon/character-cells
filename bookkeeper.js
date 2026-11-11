// Character Cells — bookkeeper pass (slice 3)
// After each AI reply, a second cheap model call reads the new scene text plus a
// compact summary of the current state, and emits change commands (one per line).
// The app parses them and applies the valid ones to the state JSON. The narrator
// model never touches state; the bookkeeper never writes prose.
//
// The call goes through generateRaw() with its own system prompt — no chat history,
// no preset formatting — mirroring Summaryception's "clean call" isolation.
// The command grammar lives in commands.js (shared with the backfill).

import { generateRaw, chat, saveChatDebounced, eventSource, event_types } from '../../../../script.js';
import { getState, getLedger } from './state.js';
import { updateInjection } from './inject.js';
import { parseCommand, applyCommand } from './commands.js';
import { logScene, applyAutoTier } from './tiers.js';
import { initSettings, getSettings, persistSettings } from './settings.js';
import { LOG_PREFIX } from './config.js';

// ---------------------------------------------------------------- settings

const settings = { bookkeeperEnabled: false, bookkeeperDelayMs: 1500 };

/** Called by index.js at init (settings themselves live in settings.js). */
export function initBookkeeper(extension_settings) {
    initSettings(extension_settings);
    Object.assign(settings, {
        bookkeeperEnabled: getSettings().bookkeeperEnabled,
        bookkeeperDelayMs: getSettings().bookkeeperDelayMs,
    });
}

let busy = false;
let lastErrorShown = 0;

export function isBookkeeperEnabled() {
    return settings.bookkeeperEnabled;
}

export function setBookkeeperEnabled(v) {
    settings.bookkeeperEnabled = !!v;
    getSettings().bookkeeperEnabled = settings.bookkeeperEnabled;
    persistSettings();
}

// ---------------------------------------------------------------- prompts

/** Compact JSON-ish dump of the state the bookkeeper needs to see. Shared with the backfill. */
export function buildStateSummary() {
    const s = getState();
    const world = s.world || {};
    const out = { turn: world.turn || 0 };
    out.cells = (s.cells || []).map(c => ({
        id: c.id, name: c.name, tier: c.tier,
        bonds: c.bonds, agenda: c.agenda, status: c.status,
    }));
    const ledger = getLedger();
    if (ledger.length) {
        // Recent events WITH ids, so the bookkeeper can attach witnesses to them.
        out.recent_events = ledger.slice(-20).map(e => ({ id: e.id, what: e.what, w: e.witnesses }));
    }
    if ((world.chekhov || []).length) {
        out.chekhov = world.chekhov.map(c => ({ id: c.id, text: c.text, status: c.status || 'active' }));
    }
    if ((world.quests || []).length) out.quests = world.quests;
    return JSON.stringify(out);
}

const SYSTEM_PROMPT = `You are a state tracker for a roleplay session. You read a short scene and the current tracked state, then output state-change commands. You never write prose, never narrate, never comment. Output ONLY command lines, one per line, in the exact grammar given. If nothing in the scene changes the state, output nothing.`;

function buildBookkeeperPrompt(sceneText) {
    return `CURRENT STATE (JSON):
${buildStateSummary()}

NEW SCENE (the latest exchange that just happened):
${sceneText}

OUTPUT GRAMMAR — one command per line, nothing else:
memory_add(what="...", who=<cellId>,<cellId>,... , imp=<1-3>)   # an event worth remembering; who = every character present who saw it (use cell ids from CURRENT STATE)
witness(<eventId>, <cellId>)                                    # an existing event (from recent_events) that this character also witnessed now
bond(<cellId>, user|sparks|grudge, <+1|-1|+2|-2>)               # relationship shift the scene shows
agenda_step(<cellId>)                                           # this NPC advanced one step toward their agenda goal
agenda_set(<cellId>, goal="...", location="...", max=<n>)       # set/change an NPC's agenda
status(<cellId>, "...")                                         # body/condition change (injured, drunk, wet, ...)
presence(<cellId>, on|off)                                      # character entered or left the scene
appear(<cellId>, spoke|acted|present)                           # this character took part in THIS scene: spoke = had dialogue, acted = did something on stage, present = visible but passive. One line per participating character.
chekhov(<chekhovId>, active|locked|fired)                       # plant state change
turn()                                                          # call once if meaningful time passed

RULES:
- Only what the scene text actually shows. No speculation.
- Cell ids MUST come from CURRENT STATE. Never invent ids.
- who lists for memory_add: every character who witnessed the event, comma-separated. Never widen who on an event that already exists — use witness() instead.
- appear: emit for EVERY character who took part, exactly once each. The user counts too — use their cell id.
- imp: 3 = plot-critical, 2 = notable, 1 = minor color.
- No explanations, no blank commentary. Commands only.`;
}

// ---------------------------------------------------------------- execution

/** The scene text = the last user message + the last AI reply (the exchange just finished). */
function buildSceneText() {
    const msgs = [];
    for (let i = chat.length - 1; i >= 0 && msgs.length < 2; i--) {
        const m = chat[i];
        if (m.is_system) continue;
        msgs.unshift(`${m.is_user ? getState().cells.find(c => c.fixed)?.name || 'User' : 'AI'}: ${String(m.mes || '').trim()}`);
    }
    return msgs.join('\n\n');
}

async function runBookkeeper() {
    if (busy || !settings.bookkeeperEnabled) return;
    const sceneText = buildSceneText();
    if (!sceneText) return;
    busy = true;
    try {
        const reply = await generateRaw({
            prompt: buildBookkeeperPrompt(sceneText),
            systemPrompt: SYSTEM_PROMPT,
            responseLength: 400,
            trimNames: false,
        });
        const lines = String(reply || '').split('\n').map(l => l.trim()).filter(Boolean);
        const turn0 = Number(getState().world.turn) || 0;
        const sceneRoles = {};
        const applied = [];
        for (const line of lines) {
            const cmd = parseCommand(line);
            if (!cmd) continue; // never crash a turn on a malformed line
            try {
                applied.push(applyCommand(cmd, turn0, sceneRoles));
            } catch (e) {
                console.warn(`${LOG_PREFIX} bookkeeper command failed:`, line, e);
            }
        }
        // Tier auto-detection: the appear() roles are this scene's participation record.
        if (Object.keys(sceneRoles).length) {
            logScene(sceneRoles);
            applied.push(...applyAutoTier());
        }
        if (applied.length) {
            console.log(`${LOG_PREFIX} bookkeeper applied (${applied.length} change(s)):\n  ` + applied.join('\n  '));
            updateInjection();
            saveChatDebounced();
        } else {
            console.log(`${LOG_PREFIX} bookkeeper ran: 0 changes this turn`);
        }
    } catch (err) {
        console.warn(`${LOG_PREFIX} bookkeeper call failed:`, err);
        // Surface repeated failures once per 5 minutes, never block the turn.
        if (Date.now() - lastErrorShown > 5 * 60 * 1000) {
            lastErrorShown = Date.now();
            toastr.warning('Bookkeeper call failed — state not auto-updated this turn.', 'Character Cells');
        }
    } finally {
        busy = false;
    }
}

export function initBookkeeperEvents() {
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        if (!settings.bookkeeperEnabled) return;
        setTimeout(() => {
            runBookkeeper().finally(() => saveChatDebounced());
        }, settings.bookkeeperDelayMs);
    });
}
