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
import { hasState, getState } from './state.js';
import { getSettings } from './settings.js';
import { landmarksKnownTo, recentEventsKnownTo, getDigest } from './digest.js';
import { stageOf } from './rel.js';
import { LOG_PREFIX } from './config.js';

const INJECT_KEY = 'character_cells';
// Depth 4 in-chat: above the last few chat messages, below Authors Note depth 2.
const INJECT_DEPTH = 4;

const TIER_ORDER = { main: 0, secondary: 1, minor: 2, offstage: 3 };

/** "a, b, c" from an array, 'none' when empty. */
const csv = (arr) => (Array.isArray(arr) && arr.length ? arr.join(', ') : 'none');
const orDash = (s) => (String(s || '').trim() || '—');

/**
 * Recent memories this cell may know: ledger filtered by witness, inside the hot
 * window BY TURN (not array position), landmarks excluded (they have their own
 * line), sorted by turn, newest 12 (capped to keep the block cheap).
 */
function knownMemories(cell) {
    const turn = Number(getState().world?.turn) || 0;
    return recentEventsKnownTo(cell.id, turn).map(e => e.what).slice(-12);
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

/**
 * Relationship layer (slice 9): one compact segment about this NPC's bond with
 * the user. Only present when a rel block exists — old/empty cells stay silent.
 * In perspective mode this is used ONLY for the POV character (their own inner
 * state); other NPCs' rels are unknowable to a perspective and stay out.
 */
function relSegment(c) {
    const r = c.rel;
    if (!r) return '';
    const b = c.bonds || {};
    if (r.severed) return `Rel: 💀 SEVERED (this bond is over)`;
    const bits = [`Rel: ${stageOf(c)}`, `heart ${b.user ?? 0} / trust ${r.trust ?? 0}`];
    if (r.condition) bits.push(r.condition);
    if (r.route) bits.push(`route: ${r.route}`);
    if ((r.likes || []).length) bits.push(`likes: ${r.likes.join(', ')}`);
    if ((r.dislikes || []).length) bits.push(`dislikes: ${r.dislikes.join(', ')}`);
    if (r.threshold) bits.push(`next: ${r.threshold}`);
    return bits.join(' | ');
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
        relSegment(c),
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
    // B4: in perspective mode a world item is shown in detail only when it is
    // witness-tagged (`witnesses: [cellId]`) for the POV character.
    const witnessed = (item) => !!opts.povId && Array.isArray(item.witnesses) && item.witnesses.includes(opts.povId);
    const factions = world.factions || [];
    if (factions.length) {
        L.push('FACTIONS:');
        for (const f of factions) {
            if (opts.perspective && !witnessed(f)) { L.push(`- ${orDash(f.name)}`); continue; } // name only: goal/state/conflict/relations not witnessed
            const parts = [`- ${orDash(f.name)}`, `Goal: ${orDash(f.goal)}`];
            if (!opts.perspective) parts.push(`Intel: ${orDash(f.intel)}`, `Fibs: ${orDash(f.fibs)}`);
            parts.push(`State: ${orDash(f.fstate)}`, `Conflict: ${orDash(f.conflict)}`, `Relations: ${orDash(f.relations)}`);
            L.push(parts.join(' | '));
        }
    }

    const quests = world.quests || [];
    if (quests.length) {
        L.push('QUESTS:');
        for (const q of quests) {
            if (opts.perspective && !witnessed(q)) { L.push(`- ${q.type || 'Side'}: ${orDash(q.name)}`); continue; } // progress/reward not witnessed
            L.push(`- ${q.type || 'Side'}: ${orDash(q.name)} — [${orDash(q.progress)}] | Reward: ${orDash(q.reward)}`);
        }
    }

    if (!opts.perspective) {
        const notes = (world.notes || []);
        if (notes.length) {
            L.push('GM NOTES:');
            for (const n of notes) L.push(`- [${n.type}] ${n.text}`);
        }
    }

    // Perspective mode: only witness-tagged, non-secret plants — everything else is absent, not flagged.
    const active = (world.chekhov || []).filter(c => (c.status || 'active') === 'active'
        && (!opts.perspective || (!c.secret && witnessed(c))));
    if (active.length) {
        L.push('CHEKHOV PLANTS (planted, not yet fired — do not resolve early):');
        for (const c of active) {
            L.push(`- ${c.text} (weight ${c.weight ?? 1}, age ${c.age ?? 0})${c.secret ? ' [secret — reveal only to those who know]' : ''}`);
        }
    }

    const roll = world.roll || {};
    if (roll.task && Number(roll.turn) === Number(world.turn)) {
        L.push(`DND TASK SIM: Task: ${orDash(roll.task)} | DC: ${orDash(roll.dc)} | Roll: ${opts.perspective ? orDash(roll.user) : `${orDash(roll.user)}/${orDash(roll.npc)}`} | Delta: ${orDash(roll.delta)} | Outcome: ${orDash(roll.outcome)} | (Apply this outcome in the scene; never mention dice, DCs or modifiers in prose.)`);
    }

    const ws = world.worldsim;
    // Perspective mode: a POV character can perceive ambient scene texture, but
    // never off-screen shifts (StandardTable categories) — those don't exist for them.
    const ambient = !opts.perspective || !ws || ws.table !== 'standard';
    if (ws && Number(ws.turn) === Number(world.turn) && ambient) {
        // Category ONLY — the canned desc is panel text; handed to the narrator it
        // gets copied verbatim ("Lights flicker, window rattles…").
        L.push(`WORLD SIM: This turn's off-screen/ambient development is of type ${ws.event}. Invent a fresh, concrete detail that fits THIS scene and setting — do not reuse stock phrasing, and never mention the roll or the category.`);
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

}

/**
 * B3: a block holding only its header (no content lines) is empty → '' so a fresh
 * chat injects nothing. TURN is appended last and never counts as content.
 */
function finishBlock(L, world) {
    if (L.length <= 1) return '';
    if (world.turn) L.push(`TURN: ${world.turn}`);
    return L.join('\n');
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

    // The user's own scope (FF5 <internal_inv>) — only when it has content (B3)
    const uStatus = String(user.status || '').trim().toLowerCase();
    if ((user.inventory || []).length || (user.titles || []).length || String(user.mods || '').trim() || (uStatus && uStatus !== 'healthy')) {
        L.push(`USER: Inv: ${csv(user.inventory)} | Titles/Skills: ${csv(user.titles)} | Status: ${orDash(user.status)} | Mods: ${orDash(user.mods)}`);
    }

    pushWorldSections(L, world);

    return finishBlock(L, world);
}

/**
 * B5 (DECIDED, option A): whose perspective does Main Character mode use?
 * Exactly one main-tier cell → that cell, remembered as `state.povId`. Zero or
 * several mains → KEEP the last POV (while that cell still exists), so a tier
 * shuffle never silently flips a single-voice chat to the omniscient block with
 * every secret in it. Only a chat that has never had a POV returns null (→ group block).
 */
export function resolvePov(state = getState()) {
    const npcs = (state.cells || []).filter(c => !c.fixed);
    const mains = npcs.filter(c => c.tier === 'main');
    if (mains.length === 1) { state.povId = mains[0].id; return mains[0]; }
    return (state.povId && npcs.find(c => c.id === state.povId)) || null;
}

/**
 * Perspective rebuild (Main Character mode): the whole block from ONE main-tier
 * character's knowledge for single-voice generation — the hard wall. Facts the
 * character doesn't hold are not in the prompt at all, so the model cannot leak
 * them even by accident.
 *
 * Returns null only when no POV has ever been established (see resolvePov) —
 * the caller then uses the group (omniscient) block.
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
    const mc = resolvePov(state);
    if (!mc) return null; // no POV established yet → group (omniscient) block

    const L = [];
    L.push(`[Main Character mode — you write as ${mc.name}. Everything below is what YOU know. Anything not in this block or in the recent scene, you do not know: do not reference it, react to it, or hint at it.]`);

    // YOU — the POV character's own full cell (their inner life is theirs to use)
    const a = mc.agenda || {};
    const b = mc.bonds || {};
    const youParts = [
        orDash(mc.identity) !== '—' ? mc.identity : '',
        `BOND ${b.user ?? 0} SPARKS ${b.sparks ?? 0} GRUDGE ${b.grudge ?? 0}`,
        a.goal ? `Agenda: ${a.goal} (step ${a.step ?? 0}/${a.max ?? 0}) @ ${orDash(a.location)}` : '',
        relSegment(mc), // the POV character knows their own heart and trust
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
    const uStat = String(user.status || '').trim().toLowerCase();
    if ((user.titles || []).length || (uStat && uStat !== 'healthy')) {
        L.push(`USER: Titles/Skills: ${csv(user.titles)} | Status: ${orDash(user.status)}`);
    }

    pushWorldSections(L, world, { perspective: true, povId: mc.id });

    return finishBlock(L, world);
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

/** Unregister the injection entirely, so nothing from any earlier chat/state stays in the prompt. */
function clearInjection() {
    setExtensionPrompt(INJECT_KEY, '', extension_prompt_types.NONE, INJECT_DEPTH);
}

export async function updateInjection() {
    const seq = ++updateSeq; // only the latest run may register a block
    try {
        let value = '';
        let kind = 'off';
        if (injectionEnabled && hasState()) {
            const state = getState();
            const mcMode = !!getSettings().mainCharacterMode;
            const pov = mcMode ? resolvePov(state) : null;
            // B7: resolve digests ONLY for cells whose line will be injected with one —
            // the POV alone in perspective mode; main/secondary (full lines) otherwise.
            // Minor/offstage cells never show a digest, so they never trigger a rebuild.
            // Failures return '' — never block the injection.
            const digests = {};
            try {
                const currentTurn = Number(state.world.turn) || 0;
                const targets = pov ? [pov] : state.cells.filter(c => !c.fixed && (c.tier === 'main' || c.tier === 'secondary'));
                for (const cell of targets) digests[cell.id] = await getDigest(cell.id, currentTurn);
            } catch { /* digest unavailable → blocks just omit the blur */ }

            if (mcMode) {
                const perspective = buildPerspectiveBlock(digests);
                if (perspective !== null) {
                    // null = no POV ever established → group block below.
                    // '' = the POV has nothing to inject yet — final, never fall back here.
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
                (kind === 'omniscient' && getSettings().mainCharacterMode ? ' (Main Character mode has no POV yet — needs one main-tier character once)' : ''));
            lastBlockKind = kind;
        }
        if (value) {
            setExtensionPrompt(INJECT_KEY, value, extension_prompt_types.IN_CHAT, INJECT_DEPTH, false, extension_prompt_roles.SYSTEM);
        } else {
            clearInjection();
        }
    } catch (err) {
        // B2: a builder error must never leave the previous chat's block registered.
        console.warn(`${LOG_PREFIX} injection build failed — injection cleared:`, err);
        lastBlockKind = 'error';
        if (seq === updateSeq) clearInjection();
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
