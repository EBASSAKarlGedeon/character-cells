// Character Cells — bookkeeper pass (slice 3)
// After each AI reply, a second cheap model call reads the new scene text plus a
// compact summary of the current state, and emits change commands (one per line).
// The app parses them and applies the valid ones to the state JSON. The narrator
// model never touches state; the bookkeeper never writes prose.
//
// The call goes through generateRaw() with its own system prompt — no chat history,
// no preset formatting — mirroring Summaryception's "clean call" isolation.

import { generateRaw, chat, saveChatDebounced, eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import {
    getState, slug, addEvent, findEvent, getLedger,
} from './state.js';
import { updateInjection } from './inject.js';
import { LOG_PREFIX } from './config.js';

const SETTINGS_KEY = 'character_cells';

// ---------------------------------------------------------------- settings

const settings = { bookkeeperEnabled: false, bookkeeperDelayMs: 1500 };
let _extension_settings = null;

/** Called by index.js at init with the extension_settings object. */
export function initBookkeeper(extension_settings) {
    _extension_settings = extension_settings;
    const stored = extension_settings[SETTINGS_KEY];
    if (stored && typeof stored === 'object') {
        settings.bookkeeperEnabled = !!stored.bookkeeperEnabled;
        if (typeof stored.bookkeeperDelayMs === 'number') settings.bookkeeperDelayMs = stored.bookkeeperDelayMs;
    }
}

function persistSettings() {
    if (_extension_settings) {
        _extension_settings[SETTINGS_KEY] = settings;
        saveSettingsDebounced();
    }
}

let busy = false;
let lastErrorShown = 0;

export function isBookkeeperEnabled() {
    return settings.bookkeeperEnabled;
}

export function setBookkeeperEnabled(v) {
    settings.bookkeeperEnabled = !!v;
    persistSettings();
}

// ---------------------------------------------------------------- prompts

/** Compact JSON-ish dump of the state the bookkeeper needs to see. */
function buildStateSummary() {
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
chekhov(<chekhovId>, active|locked|fired)                       # plant state change
turn()                                                          # call once if meaningful time passed

RULES:
- Only what the scene text actually shows. No speculation.
- Cell ids MUST come from CURRENT STATE. Never invent ids.
- who lists for memory_add: every character who witnessed the event, comma-separated. Never widen who on an event that already exists — use witness() instead.
- imp: 3 = plot-critical, 2 = notable, 1 = minor color.
- No explanations, no blank commentary. Commands only.`;
}

// ---------------------------------------------------------------- execution

/** Resolve a name/id to a cell. Tries exact id, exact slug, then substring on name. */
function resolveCell(token) {
    const t = String(token || '').trim().toLowerCase();
    if (!t) return null;
    const cells = getState().cells || [];
    return cells.find(c => c.id === t)
        || cells.find(c => slug(c.name) === t)
        || cells.find(c => c.name.toLowerCase() === t)
        || cells.find(c => c.name.toLowerCase().includes(t) && t.length >= 4)
        || null;
}

/** Parse one command line into { op, args } or null. */
function parseCommand(line) {
    const m = line.match(/^\s*(memory_add|witness|bond|agenda_step|agenda_set|status|presence|chekhov|turn)\s*\((.*)\)\s*;?\s*$/i);
    if (!m) return null;
    return { op: m[1].toLowerCase(), raw: m[2] };
}

/** Split "a=1, b="x, y", c=2" style args on top-level commas. */
function splitArgs(raw) {
    const parts = [];
    let cur = '', depth = 0, inQ = false;
    for (const ch of raw) {
        if (inQ) { cur += ch; if (ch === '"') inQ = false; continue; }
        if (ch === '"') { inQ = true; cur += ch; continue; }
        if (ch === '(' || ch === '[') depth++;
        if (ch === ')' || ch === ']') depth--;
        if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
        cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
}

const val = (s) => String(s || '').replace(/^["']|["']$/g, '').trim();
const intOf = (s) => { const n = parseInt(s, 10); return isNaN(n) ? 0 : n; };

/** Apply one parsed command to the state. Returns a short result string for the log. */
function applyCommand(cmd, currentTurn) {
    const parts = splitArgs(cmd.raw);
    const kv = {};
    for (const p of parts) {
        const eq = p.indexOf('=');
        if (eq > 0) kv[p.slice(0, eq).trim().toLowerCase()] = p.slice(eq + 1).trim();
    }

    switch (cmd.op) {
        case 'memory_add': {
            const what = val(kv.what ?? (parts.find(p => !p.includes('=')) || ''));
            if (!what) return 'skip: no what';
            const who = (kv.who || '').split(',').map(val).filter(Boolean);
            const witnesses = [];
            for (const w of who) {
                const cell = resolveCell(w);
                if (cell && !witnesses.includes(cell.id)) witnesses.push(cell.id);
            }
            if (!witnesses.length) return `skip: no valid witness for "${what.slice(0, 40)}"`;
            const ev = addEvent(what, witnesses, currentTurn, intOf(kv.imp) || 1);
            return ev ? `memory: "${what.slice(0, 40)}" → ${ev.witnesses.join(',')}` : 'dup';
        }
        case 'witness': {
            const ev = findEvent(val(parts[0]));
            if (!ev) return 'skip: unknown event';
            const cell = resolveCell(parts[1]);
            if (!cell) return 'skip: unknown cell';
            if (!ev.witnesses.includes(cell.id)) ev.witnesses.push(cell.id); // additive only
            return `witness: ${cell.name} ← ${ev.id}`;
        }
        case 'bond': {
            const cell = resolveCell(parts[0]);
            const field = val(parts[1]).toLowerCase();
            const delta = intOf(parts[2]);
            if (!cell || !['user', 'sparks', 'grudge'].includes(field) || !delta) return 'skip: bad bond';
            cell.bonds[field] = Math.max(-10, Math.min(20, (Number(cell.bonds[field]) || 0) + delta));
            return `bond: ${cell.name}.${field} ${delta > 0 ? '+' : ''}${delta}`;
        }
        case 'agenda_step': {
            const cell = resolveCell(parts[0]);
            if (!cell) return 'skip: unknown cell';
            cell.agenda = cell.agenda || {};
            cell.agenda.step = (Number(cell.agenda.step) || 0) + 1;
            return `agenda_step: ${cell.name}`;
        }
        case 'agenda_set': {
            const cell = resolveCell(parts[0]);
            if (!cell) return 'skip: unknown cell';
            cell.agenda = cell.agenda || {};
            if (kv.goal) cell.agenda.goal = val(kv.goal);
            if (kv.location) cell.agenda.location = val(kv.location);
            if (kv.max !== undefined) cell.agenda.max = intOf(kv.max);
            return `agenda_set: ${cell.name}`;
        }
        case 'status': {
            const cell = resolveCell(parts[0]);
            const text = val(kv.status ?? parts.slice(1).join(','));
            if (!cell || !text) return 'skip: bad status';
            cell.status = text;
            return `status: ${cell.name} = ${text}`;
        }
        case 'presence': {
            const cell = resolveCell(parts[0]);
            const on = val(parts[1]).toLowerCase() === 'on';
            if (!cell) return 'skip: unknown cell';
            const s = getState();
            s.present = Array.isArray(s.present) ? s.present : [];
            const i = s.present.indexOf(cell.id);
            if (on && i < 0) s.present.push(cell.id);
            if (!on && i >= 0) s.present.splice(i, 1);
            return `presence: ${cell.name} ${on ? 'on' : 'off'}`;
        }
        case 'chekhov': {
            const id = val(parts[0]);
            const st = val(parts[1]).toLowerCase();
            const item = (getState().world.chekhov || []).find(c => c.id === id);
            if (!item || !['active', 'locked', 'fired'].includes(st)) return 'skip: bad chekhov';
            item.status = st;
            return `chekhov: ${id} → ${st}`;
        }
        case 'turn': {
            getState().world.turn = (Number(getState().world.turn) || 0) + 1;
            return 'turn +1';
        }
    }
    return 'skip: unknown op';
}

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
        const applied = [];
        for (const line of lines) {
            const cmd = parseCommand(line);
            if (!cmd) continue; // never crash a turn on a malformed line
            try {
                applied.push(applyCommand(cmd, turn0));
            } catch (e) {
                console.warn(`${LOG_PREFIX} bookkeeper command failed:`, line, e);
            }
        }
        if (applied.length) {
            console.info(`${LOG_PREFIX} bookkeeper applied:\n  ` + applied.join('\n  '));
            updateInjection();
            saveChatDebounced();
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
