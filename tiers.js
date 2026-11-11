// Character Cells — tier auto-detection
// Tracks, per scene, who appeared and how actively (spoke / acted / background),
// and promotes/demotes cells automatically over a rolling window. A manual
// override (/cc-promote, /cc-demote, panel dropdown) PINS the cell — auto
// detection stops touching it until the pin is released.
//
// DECIDED weights (spec open question "on-screen vs spoke vs acted"):
// spoke = 3 (active voice), acted = 2 (did something on stage), present = 1
// (visible but passive). Score = sum over the last WINDOW scenes.

import { getState, findCell, slug, setTier } from './state.js';
import { updateInjection } from './inject.js';
import { getSettings, persistSettings } from './settings.js';
import { LOG_PREFIX } from './config.js';

export const TIERS = ['main', 'secondary', 'minor', 'offstage'];

// ---- tuning constants (kept together so the dials live in one place)
const WINDOW = 30;        // scenes the rolling score looks back over
const ABSENT_LIMIT = 6;   // consecutive absent scenes before forced demotion
const MAIN_MIN = 18;      // score band: >= this → main
const SECONDARY_MIN = 9;  // score band: >= this → secondary
const MINOR_MIN = 3;      // score band: >= this → minor, below → offstage
const HYSTERESIS = 2;     // consecutive agreeing turns before a tier change applies

// ---- scene participation log (stored on the state, so it rides with the chat)

/**
 * Record one scene's participation. roles: Map of cellId → 'spoke'|'acted'|'present'.
 * Called by the bookkeeper after it parses the scene (appear commands), and by
 * /cc-tier-log for hand-logging. Trims the log to the last WINDOW entries.
 */
export function logScene(roles) {
    const s = getState();
    if (!Array.isArray(s.tierLog)) s.tierLog = [];
    const entry = { turn: Number(s.world.turn) || 0, roles: {} };
    for (const [id, role] of Object.entries(roles)) {
        if (!['spoke', 'acted', 'present'].includes(role)) continue;
        if (findCell(id) || id === 'user') entry.roles[id] = role;
    }
    if (!Object.keys(entry.roles).length) return false;
    s.tierLog.push(entry);
    if (s.tierLog.length > WINDOW) s.tierLog.splice(0, s.tierLog.length - WINDOW);
    return true;
}

const WEIGHT = { spoke: 3, acted: 2, present: 1 };

/** Rolling score + absence count per cell id, over the tier log. */
function computeScores() {
    const s = getState();
    const log = Array.isArray(s.tierLog) ? s.tierLog : [];
    const scores = {};   // cellId → score
    const absent = {};   // cellId → consecutive scenes (within window) not seen
    const seen = {};     // cellId → last seen index in the log
    log.forEach((entry, i) => {
        for (const id of Object.keys(entry.roles)) {
            scores[id] = (scores[id] || 0) + WEIGHT[entry.roles[id]];
            seen[id] = i;
        }
    });
    for (const id of Object.keys(seen)) absent[id] = log.length - 1 - seen[id];
    return { scores, absent };
}

/** Tier the scores currently suggest for a cell (null = keep current). */
function suggestedTier(id, { scores, absent }) {
    if (!(id in scores)) return null; // never in the log → no data, no suggestion
    const score = scores[id] || 0;
    const gap = absent[id] ?? 0;
    if (gap >= ABSENT_LIMIT) return 'offstage';
    if (score >= MAIN_MIN) return 'main';
    if (score >= SECONDARY_MIN) return 'secondary';
    if (score >= MINOR_MIN) return 'minor';
    return 'offstage';
}

/**
 * Run auto-detection: recompute scores, then move any unpinned cell whose
 * suggested tier has agreed for HYSTERESIS consecutive turns.
 * Called after each bookkeeper run (when the log just changed).
 * @returns {string[]} human-readable change lines, for the console log
 */
export function applyAutoTier() {
    if (!getSettings().autoTierEnabled) return [];
    const s = getState();
    const { scores, absent } = computeScores();
    const changes = [];
    for (const cell of s.cells) {
        if (cell.fixed) continue; // user cell is never tiered
        if (cell.tierPinned) continue; // manual override wins
        const suggested = suggestedTier(cell.id, { scores, absent });
        if (!suggested || suggested === cell.tier) {
            cell.tierStreak = 0; // agreement reset — current tier matches
            continue;
        }
        cell.tierStreak = (Number(cell.tierStreak) || 0) + 1;
        if (cell.tierStreak >= HYSTERESIS) {
            const from = cell.tier;
            cell.tier = suggested;
            cell.tierStreak = 0;
            changes.push(`${cell.name}: ${from} → ${suggested}`);
        }
    }
    if (changes.length) {
        console.log(`${LOG_PREFIX} auto-tier: ${changes.join('; ')}`);
        updateInjection();
    }
    return changes;
}

// ---- manual override (pins)

/** Pin a cell to an explicit tier (manual override — auto stops touching it). */
export function pinTier(id, tier) {
    const cell = findCell(id);
    if (!cell || cell.fixed) return null;
    if (!TIERS.includes(tier)) return null;
    setTier(id, tier);
    cell.tierPinned = true;
    cell.tierStreak = 0;
    return cell;
}

/** Release the pin — the cell becomes auto-tiered again from its current tier. */
export function unpinTier(id) {
    const cell = findCell(id);
    if (!cell || cell.fixed) return null;
    cell.tierPinned = false;
    cell.tierStreak = 0;
    return cell;
}

export function isAutoTierEnabled() {
    return getSettings().autoTierEnabled;
}

export function setAutoTierEnabled(v) {
    const settings = getSettings();
    settings.autoTierEnabled = !!v;
    persistSettings();
    if (settings.autoTierEnabled) applyAutoTier();
}
