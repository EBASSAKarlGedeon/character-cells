// Character Cells — relationship layer (slice 9)
// Pura's Relationship Tracker behavioural rules, adopted onto cells (spec
// "Relationship layer", docs/CHARACTER-CELLS-SPEC.md). Division of labor:
//   - CODE owns the vocabularies (route emoji palette, conditions, stage
//     ladders) and the STAGE, which is DERIVED from BOND — the tick engine's
//     Sparks/Grudge-only movement makes Pura's "most scenes move nothing /
//     one rung max / can slide backwards" automatic, with no double bookkeeping.
//   - The BOOKKEEPER owns the judgment: trust, likes/dislikes (discoveries
//     only), keepsake, threshold, condition, route name, tangled pins.
// The panel renders the card from this data, so none of Pura's format-law
// fragility applies here.

import { getState } from './state.js';

/** Route emoji palette (DECIDED 2026-11-11: generous, curated — names stay free text). */
export const ROUTE_EMOJI = Object.freeze([
    // warm & bloom
    '🌱', '🌸', '💐', '🌹', '🕊️', '🪶', '🧸', '🏠',
    // fated & patient
    '🔮', '🧵', '🧲', '🌙', '✨', '⏳', '🌅', '🕰️',
    // conflict & edge
    '⚔️', '🔥', '🗡️', '🩸', '⛓️', '🏹', '⚡', '🕸️',
    // dark & tragic
    '🕯️', '🥀', '🌑', '🕳️', '💀', '🪞', '🧨', '🚪',
    // cold & apart
    '❄️', '🧊', '🌊', '🌫️', '🐦', '🌉', '🎭', '🎲',
    // roles & bonds
    '🤝', '🫂', '🛡️', '🎓', '🐉', '🩹', '💍', '👑',
    // odd flavours
    '🎶', '🧪', '🍂', '🍯', '🗝️', '🐍', '🌘', '⚓',
]);

/** Emotional weather (condition) — fixed vocabulary, Pura's list. */
export const CONDITIONS = Object.freeze([
    '💚 STABLE', '💛 SHIFTING', '💔 HEARTBROKEN', '🖤 BETRAYED', '💢 RESENTFUL',
    '🔥 PASSIONATE', '❄️ COLD', '🫧 INFATUATED', '💀 SEVERED', '🩹 MENDING',
    '⛓️ OBSESSED', '😶 NUMB', '🌧️ GRIEVING', '🤝 RECONCILING', '⚡ VOLATILE',
]);

/** Tangled stages — the ONLY stages the bookkeeper may pin (judgment exception). */
export const TANGLED_STAGES = Object.freeze([
    'Complicated', 'Codependent', 'Estranged', 'Rivals', 'Frenemies', 'Unrequited', 'Forbidden',
]);

export const WARM_LADDER = Object.freeze([
    'Stranger', 'Noticed', 'Acquaintance', 'Familiar', 'Friendly', 'Close', 'Confidant', 'Intimate', 'Treasured', 'Devoted',
]);
export const COLD_LADDER = Object.freeze([
    'Wary', 'Guarded', 'Resentful', 'Hostile', 'Bitter', 'Vengeful', 'Archenemy', 'Nemesis',
]);

const GENERIC_EMOJI = '❔';
export const DRIFT_UP = '💗 HEART EVENT';
export const DRIFT_DOWN = '🥀 FALLING OUT';
export const DRIFT_HOLD = '🌫️ HOLDING';

/**
 * Lazily add the rel block to an NPC cell (old chats migrate for free).
 * Returns null for the user cell — the user has no "relates to user" card.
 */
export function ensureRel(cell) {
    if (!cell || cell.fixed) return null;
    if (!cell.rel || typeof cell.rel !== 'object') cell.rel = {};
    const r = cell.rel;
    for (const k of ['condition', 'route', 'keepsake', 'threshold', 'stagePin', 'stagePinBand', 'lastStage', 'drift']) {
        if (typeof r[k] !== 'string') r[k] = '';
    }
    if (!Array.isArray(r.likes)) r.likes = [];
    if (!Array.isArray(r.dislikes)) r.dislikes = [];
    if (typeof r.trust !== 'number' || isNaN(r.trust)) r.trust = 0;
    if (typeof r.severed !== 'boolean') r.severed = false;
    if (typeof r.originTried !== 'boolean') r.originTried = false; // origin call: once per cell, ever
    return r;
}

/**
 * Stage from BOND (the band technique mirrors tiers.js). BOND clamp is
 * −10..+20 (DECIDED 2026-11-11: the cold ladder gained Bitter/Vengeful/
 * Archenemy below Hostile; Nemesis stays the absolute bottom). Exact edges
 * are tuning dials.
 */
export function stageFor(bond) {
    const b = Math.max(-10, Math.min(20, Number(bond) || 0));
    if (b <= -10) return 'Nemesis';
    if (b <= -8) return 'Archenemy';
    if (b <= -6) return 'Vengeful';
    if (b === -5) return 'Bitter';
    if (b === -4) return 'Hostile';
    if (b === -3) return 'Resentful';
    if (b === -2) return 'Guarded';
    if (b === -1) return 'Wary';
    if (b === 0) return 'Stranger';
    if (b === 1) return 'Noticed';
    if (b <= 3) return 'Acquaintance';
    if (b <= 5) return 'Familiar';
    if (b <= 8) return 'Friendly';
    if (b <= 11) return 'Close';
    if (b <= 14) return 'Confidant';
    if (b <= 16) return 'Intimate';
    if (b <= 18) return 'Treasured';
    return 'Devoted';
}

/** Comparable rank across ladders: warm 0..9 upward, cold −1..−8 downward. */
export function stageRank(stage) {
    const w = WARM_LADDER.indexOf(stage);
    if (w >= 0) return w;
    const c = COLD_LADDER.indexOf(stage);
    if (c >= 0) return -(c + 1);
    return 0;
}

/**
 * Effective stage: a tangled pin (bookkeeper judgment) holds while BOND stays
 * in the band it was pinned at; crossing a band boundary releases it.
 */
export function stageOf(cell) {
    const r = cell && cell.rel;
    const band = stageFor(cell?.bonds?.user);
    if (r && r.stagePin && TANGLED_STAGES.includes(r.stagePin)) {
        if (r.stagePinBand === band) return r.stagePin;
        r.stagePin = '';
        r.stagePinBand = '';
    }
    return band;
}

/** Drift label: what the stage did since the last stamp (bookkeeper pass / tick). */
export function driftOf(cell) {
    const r = cell && cell.rel;
    if (!r || !r.lastStage) return '';
    const now = stageOf(cell);
    if (now === r.lastStage) return DRIFT_HOLD;
    return stageRank(now) > stageRank(r.lastStage) ? DRIFT_UP : DRIFT_DOWN;
}

/** Stamp the current stage as "seen" — call at the END of each bookkeeper pass and tick. */
export function markRelStamps() {
    const s = getState();
    for (const c of s.cells) {
        if (c.fixed || !c.rel) continue;
        c.rel.lastStage = stageOf(c);
    }
}

/**
 * Route value → { emoji, name }. The emoji must be palette; the name is free
 * text capped at 4 words. Off-palette or missing emoji is NOT a rejection:
 * the name is kept under the generic ❔ (hand-fixable in the panel).
 */
export function parseRoute(value) {
    const raw = String(value || '').trim().replace(/^["']+|["']+$/g, '').trim();
    if (!raw) return null;
    let bestIdx = Infinity, bestEmoji = '';
    for (const e of ROUTE_EMOJI) {
        const i = raw.indexOf(e);
        if (i >= 0 && i < bestIdx) { bestIdx = i; bestEmoji = e; }
    }
    let emoji, name;
    if (bestEmoji) {
        emoji = bestEmoji;
        name = (raw.slice(0, bestIdx) + raw.slice(bestIdx + bestEmoji.length)).trim();
    } else {
        emoji = GENERIC_EMOJI;
        // a leading non-letter is most likely an off-palette emoji — strip it, keep the name
        const m = raw.match(/^[^\p{L}\p{N}]/u);
        name = m ? raw.slice(m[0].length).trim() : raw;
    }
    const words = name.split(/\s+/).filter(Boolean).slice(0, 4).join(' ');
    if (!words) return null;
    return { emoji, name: words };
}

/** Condition value → canonical "emoji WORD" or ❔ + raw (same fallback rule as routes). */
export function parseCondition(value) {
    const raw = String(value || '').trim().replace(/^["']+|["']+$/g, '').trim();
    if (!raw) return null;
    for (const c of CONDITIONS) {
        const sp = c.indexOf(' ');
        const emoji = c.slice(0, sp), word = c.slice(sp + 1);
        if (raw === c) return c;
        if (raw.startsWith(emoji)) return c;
        if (raw.toLowerCase().replace(/[^a-z]/g, '') === word.toLowerCase()) return c;
    }
    // strip a leading off-palette emoji, keep the words (same as parseRoute)
    const m = raw.match(/^[^\p{L}\p{N}]/u);
    return `${GENERIC_EMOJI} ${m ? raw.slice(m[0].length).trim() : raw}`;
}
