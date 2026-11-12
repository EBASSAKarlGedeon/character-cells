// Character Cells — Option C: digests + landmarks
// The ledger is IMMUTABLE — nothing here edits or deletes events. Instead:
//  - LANDMARKS: importance-3 events are always injected verbatim (witness-
//    filtered), no matter how old — the "boss fight at turn 300" guarantee.
//  - DIGESTS: everything older than the hot window that is not an injected
//    landmark is summarized per cell by cheap isolated calls (ALL cold events,
//    in chunks, rolling the summary forward), cached per cell, rebuilt only
//    when the cold event set (ids + witnesses + text) actually changes. The
//    narrative model gets: recent events verbatim + landmarks verbatim + one
//    digest paragraph.
// A bad digest loses nothing: /cc-digest regenerates it from the full ledger.
// Events are ordered BY TURN everywhere here (never by array position): the
// ledger is append-ordered, but backfill/import events carry virtual turns.

import { getState, eventsKnownTo } from './state.js';
import { cheapCall } from './llm.js';
import { LOG_PREFIX } from './config.js';

// Tuning constants (kept together, like tiers.js)
export const HOT_WINDOW_TURNS = 40;   // events newer than this are "recent"
export const LANDMARK_CAP = 10;       // max landmarks injected per character
const DIGEST_CHUNK_EVENTS = 80;       // events one digest call reads (older ones roll forward in more calls)
const RETRY_AFTER_MS = 5 * 60 * 1000; // after a failed build, wait before trying again

const byTurn = (a, b) => (Number(a.turn) || 0) - (Number(b.turn) || 0);

/** Every event a cell may know, oldest → newest BY TURN (stable: ledger order breaks ties). */
function knownSorted(cellId) {
    return eventsKnownTo(cellId).slice().sort(byTurn);
}

/** Landmark events a cell may know: imp-3, witnessed, the newest LANDMARK_CAP by turn (chronological). */
export function landmarksKnownTo(cellId) {
    return knownSorted(cellId).filter(e => e.importance >= 3).slice(-LANDMARK_CAP);
}

/** Inside the hot window? (clock = world.turn; backfill syncs it to its final virtual turn). */
function isHot(e, currentTurn) {
    return (currentTurn - (Number(e.turn) || 0)) <= HOT_WINDOW_TURNS;
}

/**
 * Recent events for a cell: witnessed, inside the hot window BY TURN, and NOT
 * already shown as a landmark. Chronological.
 */
export function recentEventsKnownTo(cellId, currentTurn) {
    const lm = new Set(landmarksKnownTo(cellId).map(e => e.id));
    return knownSorted(cellId).filter(e => !lm.has(e.id) && isHot(e, currentTurn));
}

/** Cold events for a cell: witnessed, older than the hot window, not an injected landmark. Chronological. */
function coldEvents(cellId, currentTurn) {
    const lm = new Set(landmarksKnownTo(cellId).map(e => e.id));
    return knownSorted(cellId).filter(e => !lm.has(e.id) && !isHot(e, currentTurn));
}

/** Cheap deterministic hash of the cold set: ids, witnesses, turn and text. */
function hashEvents(list) {
    const s = list.map(e => `${e.id}\u0001${(e.witnesses || []).slice().sort().join(',')}\u0001${e.turn}\u0001${e.what}`).join('\u0002');
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return `${h.toString(36)}-${list.length}`;
}

/**
 * Is the cached digest for this cell stale? Stale = the cold event SET changed
 * (any event id, witness list or text) — not just its size / newest id.
 */
function isStale(cellId, dig, currentTurn) {
    if (!dig || typeof dig.text !== 'string' || !dig.text.trim()) return true;
    const cold = coldEvents(cellId, currentTurn);
    if (cold.length === 0) return false; // nothing cold → digest unnecessary
    return dig.hash !== hashEvents(cold);
}

const SYSTEM = 'You compress a character\'s old memories into one short paragraph for a roleplay context. Never invent events, never add commentary. Output ONLY the paragraph.';

/**
 * Get the digest text for a cell, rebuilding it if stale. Rebuild = cheap
 * isolated calls over ALL cold events (chunks of DIGEST_CHUNK_EVENTS, each call
 * folding its chunk into the summary so far). Never throws: on failure returns
 * the last good digest ('' if none) and records a retry-after time so a broken
 * endpoint is not hammered on every message event.
 * @param {boolean} [force] ignore the retry-after (manual /cc-digest)
 * @returns {Promise<string>} '' when nothing old to summarize
 */
export async function getDigest(cellId, currentTurn, force = false) {
    const state = getState();
    state.digests = state.digests || {};
    state.digestRetry = state.digestRetry || {};
    const dig = state.digests[cellId];
    const cold = coldEvents(cellId, currentTurn);

    if (!cold.length) {
        // Nothing older than the hot window → no digest needed at all.
        if (dig) delete state.digests[cellId];
        delete state.digestRetry[cellId];
        return '';
    }
    if (!isStale(cellId, dig, currentTurn)) return dig.text;
    const retry = state.digestRetry[cellId];
    if (!force && retry && Date.now() < Number(retry.until)) return dig?.text || '';

    const hash = hashEvents(cold);
    try {
        let text = '';
        for (let i = 0; i < cold.length; i += DIGEST_CHUNK_EVENTS) {
            const events = cold.slice(i, i + DIGEST_CHUNK_EVENTS).map(e => `- (turn ${e.turn}, imp ${e.importance}) ${e.what}`);
            const prompt = `These are events a character witnessed long ago (older than the recent past). ${text ? 'Fold the EVENTS below into the SUMMARY SO FAR (which covers even older events) and output the updated summary as' : 'Compress ALL of them into'} ONE concise paragraph (max ~120 words), preserving: who did what to whom, promises/threats made, injuries, relationship shifts, unresolved plot threads. Skip trivial color. Write it as neutral reference notes, addressed to "you" (the character).
${text ? `\nSUMMARY SO FAR:\n${text}\n` : ''}
EVENTS (oldest first):
${events.join('\n')}`;
            const reply = String(await cheapCall(SYSTEM, prompt, 300) || '').trim();
            if (!reply) throw new Error('empty digest');
            text = reply;
        }
        state.digests[cellId] = {
            text,
            coldCount: cold.length,
            lastColdId: cold[cold.length - 1].id,
            hash,
            builtAtTurn: currentTurn,
        };
        delete state.digestRetry[cellId];
        console.log(`${LOG_PREFIX} digest rebuilt for ${cellId} (${cold.length} cold events, ${text.length} chars)`);
        return text;
    } catch (err) {
        state.digestRetry[cellId] = { until: Date.now() + RETRY_AFTER_MS };
        console.warn(`${LOG_PREFIX} digest build failed for ${cellId} (retry in ${RETRY_AFTER_MS / 60000} min):`, err);
        return dig?.text || ''; // last good digest beats nothing
    }
}

/** Force-rebuild all cached digests (/cc-digest). Returns count rebuilt. */
export async function rebuildAllDigests() {
    const state = getState();
    state.digests = {};
    state.digestRetry = {};
    const currentTurn = Number(state.world.turn) || 0;
    let rebuilt = 0;
    for (const cell of state.cells) {
        if (cell.fixed) continue; // the user cell is not injected as an NPC
        if (!coldEvents(cell.id, currentTurn).length) continue;
        await getDigest(cell.id, currentTurn, true);
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
