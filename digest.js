// Character Cells — Option C: digests + landmarks
// The ledger is IMMUTABLE — nothing here edits or deletes events. Instead:
//  - LANDMARKS: importance-3 events are always injected verbatim (witness-
//    filtered), no matter how old — the "boss fight at turn 300" guarantee.
//  - DIGESTS: everything older than the hot window that is not a landmark is
//    summarized per cell by one cheap isolated call, cached per cell, rebuilt
//    only when the cold window actually grows. The narrative model gets:
//    recent events verbatim + landmarks verbatim + one digest paragraph.
// A bad digest loses nothing: /cc-digest regenerates it from the full ledger.

import { generateRaw } from '../../../../script.js';
import { getState, getLedger, eventsKnownTo } from './state.js';
import { LOG_PREFIX } from './config.js';

// Tuning constants (kept together, like tiers.js)
export const HOT_WINDOW_TURNS = 40;   // events newer than this are "recent"
export const LANDMARK_CAP = 10;       // max landmarks injected per character
const DIGEST_MAX_EVENTS = 80;         // cap the events one digest call reads

/** Landmark events a cell may know: imp-3, witnessed, most recent first. */
export function landmarksKnownTo(cellId) {
    return eventsKnownTo(cellId)
        .filter(e => e.importance >= 3)
        .slice(-LANDMARK_CAP);
}

/**
 * Cold events for a cell: witnessed, older than the hot window, not landmarks.
 * @returns {number} count (0 = digest is up to date / nothing cold)
 */
function coldEvents(cellId, currentTurn) {
    return eventsKnownTo(cellId).filter(e =>
        e.importance < 3 &&
        (currentTurn - (Number(e.turn) || 0)) > HOT_WINDOW_TURNS);
}

/**
 * Is the cached digest for this cell stale?
 * Stale = the cold event set changed since the digest was built
 * (tracked by count + newest cold turn, cheap and good enough).
 */
function isStale(cellId, dig, currentTurn) {
    if (!dig || typeof dig.text !== 'string' || !dig.text.trim()) return true;
    const cold = coldEvents(cellId, currentTurn);
    if (cold.length === 0) return false; // nothing cold → digest unnecessary
    if (cold.length !== dig.coldCount) return true;
    return cold[cold.length - 1].id !== dig.lastColdId;
}

/**
 * Get the digest text for a cell, rebuilding it if stale. Rebuild = ONE cheap
 * isolated generateRaw call (same isolation pattern as the bookkeeper).
 * Never throws: on failure returns the last good digest, or '' if none.
 * @returns {Promise<string>} '' when nothing old to summarize
 */
export async function getDigest(cellId, currentTurn) {
    const state = getState();
    state.digests = state.digests || {};
    const dig = state.digests[cellId];
    const cold = coldEvents(cellId, currentTurn);

    if (!cold.length) {
        // Nothing older than the hot window → no digest needed at all.
        if (dig) delete state.digests[cellId];
        return '';
    }
    if (!isStale(cellId, dig, currentTurn)) return dig.text;

    // Build: summarize ONLY the cold events this cell witnessed.
    const events = cold.slice(-DIGEST_MAX_EVENTS).map(e => `- (turn ${e.turn}, imp ${e.importance}) ${e.what}`);
    const SYSTEM = 'You compress a character\'s old memories into one short paragraph for a roleplay context. Never invent events, never add commentary. Output ONLY the paragraph.';
    const prompt = `These are events a character witnessed long ago (older than the recent past). Compress ALL of them into ONE concise paragraph (max ~120 words), preserving: who did what to whom, promises/threats made, injuries, relationship shifts, unresolved plot threads. Skip trivial color. Write it as neutral reference notes, addressed to "you" (the character).

EVENTS (oldest first):
${events.join('\n')}`;

    try {
        const reply = await generateRaw({
            prompt,
            systemPrompt: SYSTEM,
            responseLength: 300,
            trimNames: false,
        });
        const text = String(reply || '').trim();
        if (!text) throw new Error('empty digest');
        state.digests[cellId] = {
            text,
            coldCount: cold.length,
            lastColdId: cold[cold.length - 1].id,
            builtAtTurn: currentTurn,
        };
        console.log(`${LOG_PREFIX} digest rebuilt for ${cellId} (${cold.length} cold events, ${text.length} chars)`);
        return text;
    } catch (err) {
        console.warn(`${LOG_PREFIX} digest build failed for ${cellId}:`, err);
        return dig?.text || ''; // last good digest beats nothing
    }
}

/** Force-rebuild all cached digests (/cc-digest). Returns count rebuilt. */
export async function rebuildAllDigests() {
    const state = getState();
    state.digests = {};
    const currentTurn = Number(state.world.turn) || 0;
    let rebuilt = 0;
    for (const cell of state.cells) {
        if (cell.fixed) continue; // the user cell is not injected as an NPC
        if (!coldEvents(cell.id, currentTurn).length) continue;
        await getDigest(cell.id, currentTurn);
        rebuilt++;
    }
    return rebuilt;
}

/** How many cells currently have (or need) a digest — for panel display. */
export function digestStats() {
    const state = getState();
    const currentTurn = Number(state.world.turn) || 0;
    let cached = 0, stale = 0, needed = 0;
    for (const cell of state.cells) {
        if (cell.fixed) continue;
        const cold = coldEvents(cell.id, currentTurn).length;
        if (!cold) continue;
        needed++;
        const dig = state.digests?.[cell.id];
        if (dig && !isStale(cell.id, dig, currentTurn)) cached++;
        else stale++;
    }
    return { cached, stale, needed, hotWindow: HOT_WINDOW_TURNS, landmarkCap: LANDMARK_CAP };
}
