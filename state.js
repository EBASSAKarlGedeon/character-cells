// Character Cells — state store
// Slice 1: per-chat state file (character cells + world threads), stored in chat_metadata
// so it rides along with the existing chat save/sync with zero new plumbing.

// NOTE: third-party load path → 4 levels up to /script.js (see index.js comment).
import { chat_metadata, name1, getCurrentChatId, this_chid } from '../../../../script.js';

const STATE_KEY = 'character_cells';
const SNAP_KEY = 'character_cells_snaps';

// ---------------------------------------------------------------- chat guard (B1)
// Every async continuation (bookkeeper timer, LLM awaits, origin calls, tick)
// must prove it still belongs to the chat that dispatched it. getState() reads
// the LIVE chat_metadata, so a chat switch mid-flight would otherwise run the
// whole pass against — and save into — the wrong chat.
let stateEpoch = 0;

/** Opaque token for "this chat, this state lineage". Capture at event time. */
export function chatToken() {
    return `${getCurrentChatId() ?? ''}|${this_chid ?? ''}|${stateEpoch}`;
}

/** Still the same chat (and no snapshot restore since)? */
export function sameChat(token) {
    return token === chatToken();
}

/** @typedef {'main'|'secondary'|'minor'|'offstage'} Tier */

/** The user is a fixed cell: always present, never tiered/promoted/deleted. */
export const USER_CELL_ID = 'user';

/**
 * Fresh cell for a character. Everything optional except id/tier/name.
 * @returns {object}
 */
export function makeCell(name, tier = 'minor', fixed = false) {
    return {
        fixed: fixed,
        id: slug(name),
        name: name,
        tier: tier, // main / secondary / minor / offstage
        tierPinned: false,      // true = manual override; auto-tiering skips it
        tierStreak: 0,          // consecutive agreeing auto-tier suggestions (hysteresis)
        identity: '',           // compressed persona description
        archetype: '',          // reserved for the personality model (later)
        bonds: { user: 0, sparks: 0, grudge: 0 },   // FF5 relationship engine numbers
        agenda: { goal: '', step: 0, max: 0, location: '' }, // off-screen life
        status: 'healthy',      // injuries/conditions (FF5 "Body")
        aware: [],              // FF5 agenda line: secrets this NPC knows
        fibs: '',               // FF5 agenda line: lies told
        circle: [],             // FF5 agenda line: allies/allies-of-record
        inventory: [],          // FF5 inv items
        titles: [],             // FF5 titles/skills (roll modifiers)
        mods: '',               // FF5 inv line: active roll modifiers (user cell)
        memories: [],           // [{ id, what, witnesses: [id], importance: 1-3, turn }]
    };
}

/** Fresh world state (today's GM Notebook + threads + FF5 world sections). */
export function makeWorldState() {
    return {
        notes: [],              // [{ id, type: 'R'|'T'|'D', text }] — GM notebook entries
        factions: [],           // [{ id, name, goal, intel, fibs, fstate, conflict, relations }]
        quests: [],             // [{ id, type: 'Main'|'Side', name, progress, reward }]
        chekhov: [],            // [{ id, text, status: active|locked|fired, weight, age, depends, secret }]
        roll: {},               // { task, dc, user, npc, delta, outcome } — last DND sim roll
        combat: { mode: 'N/A', engagement: 'N/A', wounds: 'None', exchange: 'N/A' },
        env: '',                // FF5 "Env" physics line
        physics: '',            // FF5 "Physics" line
        time: '',               // free text for now, e.g. "Day 3, morning, palace library"
        turn: 0,
    };
}

/**
 * The shared memory EVENT LEDGER (DECIDED 2026-11-11): every memory is stored ONCE,
 * tagged with the cells that witnessed it. Per-character knowledge is derived at
 * injection time by filtering this ledger — store shared, show filtered.
 * Shape: [{ id, what, witnesses: [cellId], importance: 1-3, turn }]
 */
export function makeEvent(what, witnesses, turn, importance = 1) {
    return {
        id: 'e' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
        what: String(what || ''),
        witnesses: (witnesses || []).map(w => String(w)),
        importance: Math.max(1, Math.min(3, Number(importance) || 1)),
        turn: Number(turn) || 0,
    };
}

export function slug(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unnamed';
}

/** Get (or lazily create) this chat's state object. Mutating the return value mutates the chat. */
export function getState() {
    if (!chat_metadata[STATE_KEY]) {
        chat_metadata[STATE_KEY] = { version: 1, world: makeWorldState(), cells: [] };
    }
    const s = chat_metadata[STATE_KEY];
    // The user cell always exists (FF5: inventory/titles/status tracked for {{user}} only).
    // Identified by the `fixed` flag, NOT by id: the id is the persona name's slug, which is
    // rarely 'user' — the old id-based check re-added a duplicate user cell on every read.
    for (const c of s.cells) if (!c.fixed && c.id === USER_CELL_ID) c.fixed = true; // older saves
    let seenUser = false;
    s.cells = s.cells.filter(c => {
        if (c.fixed) { if (seenUser) return false; seenUser = true; } // collapse old duplicates
        return true;
    });
    if (!seenUser) {
        s.cells.unshift(makeCell(name1 || USER_CELL_ID, 'main', true));
    }
    // Lightweight migration for chats created before a schema addition.
    const w = s.world;
    for (const k of ['factions', 'quests', 'chekhov']) if (!Array.isArray(w[k])) w[k] = [];
    if (!w.roll || typeof w.roll !== 'object') w.roll = {};
    if (!w.combat || typeof w.combat !== 'object') w.combat = { mode: 'N/A', engagement: 'N/A', wounds: 'None', exchange: 'N/A' };
    return s;
}

// ---------------------------------------------------------------- snapshots (B3)
// Ring of pre-tick state snapshots, persisted with the chat so swipes/deletes
// after a reload still rewind. `at` = index of the AI message the tick was for.
const SNAP_MAX = 5;

function snaps() {
    if (!Array.isArray(chat_metadata[SNAP_KEY])) chat_metadata[SNAP_KEY] = [];
    return chat_metadata[SNAP_KEY];
}

/** Snapshot the CURRENT state as the pre-tick state of the AI message at index `at`. */
export function takeSnapshot(at) {
    if (!chat_metadata[STATE_KEY]) return;
    const list = snaps();
    const i = list.findIndex(x => x.at === at);
    if (i >= 0) list.splice(i, 1);
    list.push({ at, state: JSON.parse(JSON.stringify(chat_metadata[STATE_KEY])) });
    list.sort((a, b) => a.at - b.at);
    while (list.length > SNAP_MAX) list.shift();
}

function applySnapshot(snap) {
    chat_metadata[STATE_KEY] = JSON.parse(JSON.stringify(snap.state));
    stateEpoch++; // invalidates every in-flight pass dispatched before the rewind
}

/** Swipe/regenerate: rewind to the pre-tick state of the AI message at `at`. */
export function restoreSnapshotAt(at) {
    const list = snaps();
    const snap = list.find(x => x.at === at);
    if (!snap) return false;
    applySnapshot(snap);
    return true;
}

/**
 * After a tail deletion: ticks whose AI message no longer exists (at >= chat
 * length) are discarded; state rewinds to the pre-tick state of the EARLIEST of
 * them (= the state after the last surviving AI message).
 */
export function restoreAfterDelete(chatLength) {
    const list = snaps();
    const gone = list.filter(x => x.at >= chatLength);
    if (!gone.length) return false;
    applySnapshot(gone[0]); // list is sorted by `at`
    chat_metadata[SNAP_KEY] = list.filter(x => x.at < chatLength);
    return true;
}

export function clearSnapshots() {
    delete chat_metadata[SNAP_KEY];
}

export function saveStateRef() {
    // chat_metadata is saved with the chat by ST's own saveChat; caller triggers that.
    // Kept as a named export so callers don't hardcode the key.
    return STATE_KEY;
}

/** True if this chat already has cell state. Does NOT lazily create it (unlike getState). */
export function hasState() {
    return !!chat_metadata[STATE_KEY];
}

export function findCell(id) {
    return getState().cells.find(c => c.id === id) || null;
}

export function addCell(name, tier = 'minor') {
    const s = getState();
    const existing = findCell(slug(name));
    if (existing) return existing;
    const cell = makeCell(name, tier);
    s.cells.push(cell);
    return cell;
}

export function setTier(id, tier) {
    const cell = findCell(id);
    if (!cell || cell.fixed) return null; // user cell is never tiered
    cell.tier = tier;
    return cell;
}

export function removeCell(id) {
    const s = getState();
    const i = s.cells.findIndex(c => c.id === id);
    if (i >= 0 && !s.cells[i].fixed) s.cells.splice(i, 1); // user cell is protected
}

/** Add a memory to a cell's known list (dedup by text within the same cell). */
export function addMemory(cellId, what, witnesses, turn, importance = 1) {
    const cell = findCell(cellId);
    if (!cell) return null;
    if (cell.memories.some(m => m.what === what)) return cell.memories.find(m => m.what === what);
    const mem = { id: 'm' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36), what, witnesses, importance, turn };
    cell.memories.push(mem);
    return mem;
}

// ---------------------------------------------------------------- event ledger

/** The chat's shared event ledger, lazily created. Stored ONCE per event, witness-tagged. */
export function getLedger() {
    const s = getState();
    if (!Array.isArray(s.ledger)) s.ledger = [];
    return s.ledger;
}

/** Record an event once (dedup by text). Returns the event. */
export function addEvent(what, witnesses, turn, importance = 1) {
    const whatStr = String(what || '').trim();
    if (!whatStr) return null;
    const ledger = getLedger();
    const existing = ledger.find(e => e.what === whatStr);
    if (existing) {
        // Never widen an existing witness list (Summaryception rule).
        return existing;
    }
    const ev = makeEvent(whatStr, witnesses, turn, importance);
    ledger.push(ev);
    return ev;
}

/** Events a cell may know: it witnessed them (or is the user cell, which saw everything on stage). */
export function eventsKnownTo(cellId) {
    return getLedger().filter(e => (e.witnesses || []).includes(cellId));
}

/** Event lookup by id (ledger ids are strings like 'eabc123'). */
export function findEvent(id) {
    return getLedger().find(e => e.id === id) || null;
}

/** Serialized size guard — keep the state small enough to be cheap to inject. */
export function stateStats() {
    const s = getState();
    return {
        cells: s.cells.length,
        memories: s.cells.reduce((n, c) => n + c.memories.length, 0),
        events: (Array.isArray(s.ledger) ? s.ledger.length : 0),
        notes: s.world.notes.length,
        jsonBytes: JSON.stringify(s).length,
    };
}
