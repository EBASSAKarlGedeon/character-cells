// Character Cells — state store
// Slice 1: per-chat state file (character cells + world threads), stored in chat_metadata
// so it rides along with the existing chat save/sync with zero new plumbing.

// NOTE: third-party load path → 4 levels up to /script.js (see index.js comment).
import { chat_metadata, name1 } from '../../../../script.js';

const STATE_KEY = 'character_cells';

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
    if (!s.cells.some(c => c.id === USER_CELL_ID)) {
        s.cells.unshift(makeCell(name1 || USER_CELL_ID, 'main', true));
    }
    // Lightweight migration for chats created before a schema addition.
    const w = s.world;
    for (const k of ['factions', 'quests', 'chekhov']) if (!Array.isArray(w[k])) w[k] = [];
    if (!w.roll || typeof w.roll !== 'object') w.roll = {};
    if (!w.combat || typeof w.combat !== 'object') w.combat = { mode: 'N/A', engagement: 'N/A', wounds: 'None', exchange: 'N/A' };
    return s;
}

export function saveStateRef() {
    // chat_metadata is saved with the chat by ST's own saveChat; caller triggers that.
    // Kept as a named export so callers don't hardcode the key.
    return STATE_KEY;
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
    if (id === USER_CELL_ID) return null; // user cell is never tiered
    const cell = findCell(id);
    if (cell) cell.tier = tier;
    return cell;
}

export function removeCell(id) {
    if (id === USER_CELL_ID) return; // protected
    const s = getState();
    const i = s.cells.findIndex(c => c.id === id);
    if (i >= 0) s.cells.splice(i, 1);
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

/** Serialized size guard — keep the state small enough to be cheap to inject. */
export function stateStats() {
    const s = getState();
    return {
        cells: s.cells.length,
        memories: s.cells.reduce((n, c) => n + c.memories.length, 0),
        notes: s.world.notes.length,
        jsonBytes: JSON.stringify(s).length,
    };
}
