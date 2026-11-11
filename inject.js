// Character Cells — witness-filtered prompt injection (slice 2)
// Builds the internal-states TEXT block from state data and injects it into every
// generation via setExtensionPrompt (IN_CHAT, near the end so the cached prefix
// above it survives). The narrator writes prose only — the block carries the
// instruction not to re-output it.
//
// Witness filtering (the memory-mixing fix): each NPC line carries ONLY that
// NPC's own knowledge — its memories plus memories it witnessed. Facts a
// character never saw are never in their context, so the model cannot leak them.

import { extension_prompt_types, extension_prompt_roles, setExtensionPrompt } from '../../../../script.js';
import { hasState, getState, eventsKnownTo } from './state.js';
import { getSettings } from './settings.js';
import { landmarksKnownTo, getDigest } from './digest.js';
import { LOG_PREFIX } from './config.js';

const INJECT_KEY = 'character_cells';
// Depth 4 in-chat: above the last few chat messages, below Authors Note depth 2.
const INJECT_DEPTH = 4;

const TIER_ORDER = { main: 0, secondary: 1, minor: 2, offstage: 3 };

/** "a, b, c" from an array, 'none' when empty. */
const csv = (arr) => (Array.isArray(arr) && arr.length ? arr.join(', ') : 'none');
const orDash = (s) => (String(s || '').trim() || '—');

/** Recent memories this cell may know: ledger filtered by witness, newest 12. */
function knownMemories(cell) {
    return eventsKnownTo(cell.id)
        .map(e => e.what)
        .slice(-12); // capped to keep the block cheap (newest win)
}

/**
 * Knowledge section for one cell: LANDMARKS (imp-3, always verbatim) + recent
 * events + the cached digest for everything older. `digest` is pre-resolved
 * text ('' = none); passing it in keeps buildStateBlock() synchronous.
 */
function knowledgeParts(cell, digest = '') {
    const landmarks = landmarksKnownTo(cell.id).map(e => e.what);
    const parts = [];
    if (landmarks.length) parts.push(`Landmarks (never forget): ${landmarks.join(' | ')}`);
    const recent = knownMemories(cell);
    if (recent.length) parts.push(`Knows (recent): ${recent.join(' | ')}`);
    if (digest) parts.push(`Longer ago (summary): ${digest}`);
    return parts;
}

/** Full line for main/secondary cells. */
function fullCellLine(c, digest = '') {
    const a = c.agenda || {};
    const b = c.bonds || {};
    const knows = knowledgeParts(c, digest);
    const parts = [
        `${c.name} (${c.tier})`,
        orDash(c.identity) !== '—' ? c.identity : '',
        `BOND ${b.user ?? 0} SPARKS ${b.sparks ?? 0} GRUDGE ${b.grudge ?? 0}`,
        a.goal ? `Agenda: ${a.goal} (step ${a.step ?? 0}/${a.max ?? 0}) @ ${orDash(a.location)}` : '',
        `Body: ${orDash(c.status)}`,
        (c.aware || []).length ? `Aware: ${csv(c.aware)}` : '',
        c.fibs ? `Fibs: ${c.fibs}` : '',
        (c.circle || []).length ? `Circle: ${csv(c.circle)}` : '',
        (c.inventory || []).length ? `Inv: ${csv(c.inventory)}` : '',
        c.thoughts ? `Thinks: ${c.thoughts}` : '',
        knows.length ? `Knows ONLY: ${knows.join(' | ')}` : '',
    ];
    return `- ${parts.filter(Boolean).join(' | ')}`;
}

/** Compact line for minor cells; offstage cells are omitted entirely. */
function minorCellLine(c) {
    const a = c.agenda || {};
    return `- ${c.name} (${c.tier}): ${orDash(c.identity)} @ ${orDash(a.location)} | Body: ${orDash(c.status)}`;
}

/**
 * World-level sections shared by both block builders. In perspective mode
 * (opts.perspective) the sections shrink to what one character can perceive:
 * faction intel/fibs and secret Chekhov plants are dropped entirely.
 * GM NOTES are omniscient-only: they are author tools, and a perspective
 * generation has no way to know which notes that character has seen.
 */
function pushWorldSections(L, world, opts = {}) {
    const factions = world.factions || [];
    if (factions.length) {
        L.push('FACTIONS:');
        for (const f of factions) {
            const parts = [`- ${orDash(f.name)}`, `Goal: ${orDash(f.goal)}`];
            if (!opts.perspective) parts.push(`Intel: ${orDash(f.intel)}`, `Fibs: ${orDash(f.fibs)}`);
            parts.push(`State: ${orDash(f.fstate)}`, `Conflict: ${orDash(f.conflict)}`, `Relations: ${orDash(f.relations)}`);
            L.push(parts.join(' | '));
        }
    }

    const quests = world.quests || [];
    if (quests.length) {
        L.push('QUESTS:');
        for (const q of quests) L.push(`- ${q.type || 'Side'}: ${orDash(q.name)} — [${orDash(q.progress)}] | Reward: ${orDash(q.reward)}`);
    }

    if (!opts.perspective) {
        const notes = (world.notes || []);
        if (notes.length) {
            L.push('GM NOTES:');
            for (const n of notes) L.push(`- [${n.type}] ${n.text}`);
        }
    }

    const active = (world.chekhov || []).filter(c => (c.status || 'active') === 'active');
    if (active.length) {
        L.push('CHEKHOV PLANTS (planted, not yet fired — do not resolve early):');
        for (const c of active) {
            if (opts.perspective && c.secret) continue; // secrets the POV doesn't hold are absent, not flagged
            L.push(`- ${c.text} (weight ${c.weight ?? 1}, age ${c.age ?? 0})${c.secret ? ' [secret — reveal only to those who know]' : ''}`);
        }
    }

    const roll = world.roll || {};
    if (roll.task && Number(roll.turn) === Number(world.turn)) {
        L.push(`DND TASK SIM: Task: ${orDash(roll.task)} | DC: ${orDash(roll.dc)} | Roll: ${orDash(roll.user)}/${orDash(roll.npc)} | Delta: ${orDash(roll.delta)} | Outcome: ${orDash(roll.outcome)} | (Apply this outcome in the scene; never mention dice, DCs or modifiers in prose.)`);
    }

    const ws = world.worldsim;
    // Perspective mode: a POV character can perceive ambient scene texture, but
    // never off-screen shifts (StandardTable categories) — those don't exist for them.
    const ambient = !opts.perspective || ws.table !== 'standard';
    if (ws && Number(ws.turn) === Number(world.turn) && ambient) {
        L.push(`WORLD SIM: This turn's roll: ${ws.event} — ${ws.desc} (improvise the specifics naturally; never mention the roll)`);
    }

    // Chekhov bullets that FIRED this turn: the narrator must weave them in now.
    // Secrets stay hidden from a perspective that doesn't hold them.
    const fired = (world.chekhovFired || []).filter(f => !opts.perspective || !f.secret);
    if (fired.length) {
        L.push('CHEKHOV FIRES (weave these into THIS scene naturally — do not mention the mechanic):');
        for (const f of fired) L.push(`- ${f.text}`);
    }

    const combat = world.combat || {};
    if (combat.mode && combat.mode !== 'N/A') {
        L.push(`COMBAT: Mode: ${combat.mode} | Engagement: ${orDash(combat.engagement)} | Wounds: ${orDash(combat.wounds)} | Exchange: ${orDash(combat.exchange)}`);
    }

    if (world.env || world.physics) {
        L.push(`WORLD: Env: ${orDash(world.env)} | Physics: ${orDash(world.physics)}`);
    }

    if (world.turn) L.push(`TURN: ${world.turn}`);
}

/**
 * Build the injected state text (omniscient block — group narration).
 * `digests` (optional): map cellId → digest text, pre-resolved by the caller
 * (updateInjection resolves asynchronously; /cc-inject preview passes {}).
 * Exported for the /cc-inject preview command.
 * @returns {string} '' when there is nothing worth injecting.
 */
export function buildStateBlock(digests = {}) {
    if (!hasState()) return '';
    const state = getState();
    const world = state.world || {};
    const cells = state.cells || [];
    const user = cells.find(c => c.fixed) || {};
    const npcs = cells.filter(c => !c.fixed)
        .sort((x, y) => (TIER_ORDER[x.tier] ?? 9) - (TIER_ORDER[y.tier] ?? 9));
    const mains = npcs.filter(c => c.tier === 'main' || c.tier === 'secondary');
    const minors = npcs.filter(c => c.tier === 'minor');

    const L = [];
    L.push('[Internal States — data the app tracks for you. It is authoritative: stay consistent with it, never re-output it, never mention it.]');

    // Cast, knowledge-filtered per NPC (the memory-mixing fix)
    if (mains.length || minors.length) {
        L.push('CAST:');
        for (const c of mains) L.push(fullCellLine(c, digests[c.id] || ''));
        for (const c of minors) L.push(minorCellLine(c));
    }

    // The user's own scope (FF5 <internal_inv>)
    L.push(`USER: Inv: ${csv(user.inventory)} | Titles/Skills: ${csv(user.titles)} | Status: ${orDash(user.status)} | Mods: ${orDash(user.mods)}`);

    pushWorldSections(L, world);

    // Only the header if nothing else has content yet — skip injecting an empty shell.
    return L.length > 1 ? L.join('\n') : '';
}

/**
 * Perspective rebuild (Main Character mode): the whole block from ONE main-tier
 * character's knowledge for single-voice generation — the hard wall. Facts the
 * character doesn't hold are not in the prompt at all, so the model cannot leak
 * them even by accident.
 *
 * Returns null when Main Character mode can't apply (no exactly-one main-tier
 * cell) — the caller then falls back to the omniscient block.
 * @param {object} digests optional cellId → digest text map
 * @returns {string|null}
 */
export function buildPerspectiveBlock(digests = {}) {
    if (!hasState()) return null;
    const state = getState();
    const world = state.world || {};
    const cells = state.cells || [];
    const user = cells.find(c => c.fixed) || {};
    const npcs = cells.filter(c => !c.fixed);
    const mains = npcs.filter(c => c.tier === 'main');
    if (mains.length !== 1) return null; // exactly one voice, or no perspective rebuild
    const mc = mains[0];

    const L = [];
    L.push(`[Main Character mode — you write as ${mc.name}. Everything below is what YOU know. Anything not in this block or in the recent scene, you do not know: do not reference it, react to it, or hint at it.]`);

    // YOU — the POV character's own full cell (their inner life is theirs to use)
    const a = mc.agenda || {};
    const b = mc.bonds || {};
    const youParts = [
        orDash(mc.identity) !== '—' ? mc.identity : '',
        `BOND ${b.user ?? 0} SPARKS ${b.sparks ?? 0} GRUDGE ${b.grudge ?? 0}`,
        a.goal ? `Agenda: ${a.goal} (step ${a.step ?? 0}/${a.max ?? 0}) @ ${orDash(a.location)}` : '',
        `Body: ${orDash(mc.status)}`,
        (mc.aware || []).length ? `Aware: ${csv(mc.aware)}` : '',
        mc.fibs ? `Fibs: ${mc.fibs}` : '',
        (mc.circle || []).length ? `Circle: ${csv(mc.circle)}` : '',
        (mc.inventory || []).length ? `Inv: ${csv(mc.inventory)}` : '',
        mc.thoughts ? `Thinks: ${mc.thoughts}` : '',
    ];
    L.push(`YOU (${mc.name}): ${youParts.filter(Boolean).join(' | ')}`);

    // OTHERS, AS YOU KNOW THEM — observable sketch only: who they are and what
    // a stranger could see. No bonds, agendas, thoughts or inventories of others.
    const others = npcs.filter(c => c.id !== mc.id && c.tier !== 'offstage');
    if (others.length) {
        L.push('OTHERS, AS YOU KNOW THEM:');
        for (const c of others) L.push(`- ${c.name}: ${orDash(c.identity)} | Body: ${orDash(c.status)}`);
    }

    // WHAT YOU KNOW — landmarks verbatim + recent verbatim + the digest blur
    const knowParts = knowledgeParts(mc, digests[mc.id] || '');
    if (knowParts.length) {
        L.push('WHAT YOU KNOW:');
        for (const k of knowParts) L.push(`- ${k}`);
    }

    // The user, as observable from outside: titles and condition, not pockets.
    L.push(`USER: Titles/Skills: ${csv(user.titles)} | Status: ${orDash(user.status)}`);

    pushWorldSections(L, world, { perspective: true });

    return L.length > 1 ? L.join('\n') : '';
}

/** Master switch for the injection (/cc-inject on|off). Default on. */
export let injectionEnabled = true;
export function setInjectionEnabled(v) { injectionEnabled = !!v; updateInjection(); }

/** The block that would be injected right now — for the /cc-inject preview. */
export function previewBlock() {
    if (getSettings().mainCharacterMode) {
        const perspective = buildPerspectiveBlock();
        if (perspective !== null) return perspective;
    }
    return buildStateBlock();
}

/** Recompute and (re)register the injection. Async: digest rebuilds are LLM calls. */
let lastBlockKind = '';
let updateSeq = 0;
export async function updateInjection() {
    const seq = ++updateSeq; // only the latest run may register a block
    let value = '';
    let kind = 'off';
    if (injectionEnabled && hasState()) {
        // Resolve per-cell digests up front (cheap: cached; a stale one costs
        // one small call). Failures return '' — never block the injection.
        const digests = {};
        try {
            const state = getState();
            const currentTurn = Number(state.world.turn) || 0;
            for (const cell of state.cells) {
                if (cell.fixed) continue;
                digests[cell.id] = await getDigest(cell.id, currentTurn);
            }
        } catch { /* digest unavailable → blocks just omit the blur */ }

        if (getSettings().mainCharacterMode) {
            const perspective = buildPerspectiveBlock(digests);
            if (perspective !== null) {
                // null = can't apply (not exactly one main cell) → fallback below.
                // '' = the POV has nothing to inject yet — that is final, never
                // fall back to the omniscient block here.
                value = perspective;
                kind = perspective ? 'perspective' : 'none';
            }
        }
        if (!value && kind !== 'none') {
            value = buildStateBlock(digests);
            kind = value ? 'omniscient' : 'none';
        }
    }
    if (seq !== updateSeq) return; // a newer update superseded this one
    if (kind !== lastBlockKind) {
        console.log(`${LOG_PREFIX} injection block: ${kind}` +
            (kind === 'omniscient' && getSettings().mainCharacterMode ? ' (Main Character mode needs exactly one main-tier character)' : ''));
        lastBlockKind = kind;
    }
    if (value) {
        setExtensionPrompt(INJECT_KEY, value, extension_prompt_types.IN_CHAT, INJECT_DEPTH, false, extension_prompt_roles.SYSTEM);
    } else {
        setExtensionPrompt(INJECT_KEY, '', extension_prompt_types.NONE, INJECT_DEPTH);
    }
}

/** Compact state summary for the backfill's bookkeeper-style calls. */
export function buildBookkeeperStateSummary() {
    const s = getState();
    const world = s.world || {};
    const out = { turn: world.turn || 0 };
    out.cells = (s.cells || []).map(c => ({ id: c.id, name: c.name, tier: c.tier, bonds: c.bonds, agenda: c.agenda, status: c.status }));
    const ledger = Array.isArray(s.ledger) ? s.ledger : [];
    if (ledger.length) out.recent_events = ledger.slice(-20).map(e => ({ id: e.id, what: e.what, w: e.witnesses }));
    if ((world.chekhov || []).length) out.chekhov = world.chekhov.map(c => ({ id: c.id, text: c.text, status: c.status || 'active' }));
    if ((world.quests || []).length) out.quests = world.quests;
    return JSON.stringify(out);
}
