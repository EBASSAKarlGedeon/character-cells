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

const INJECT_KEY = 'character_cells';
// Depth 4 in-chat: above the last few chat messages, below Authors Note depth 2.
const INJECT_DEPTH = 4;

const TIER_ORDER = { main: 0, secondary: 1, minor: 2, offstage: 3 };

/** "a, b, c" from an array, 'none' when empty. */
const csv = (arr) => (Array.isArray(arr) && arr.length ? arr.join(', ') : 'none');
const orDash = (s) => (String(s || '').trim() || '—');

/** Memories this cell may know: from the shared event ledger, filtered by witness. */
function knownMemories(cell) {
    return eventsKnownTo(cell.id)
        .map(e => e.what)
        .slice(0, 12); // capped to keep the block cheap
}

/** Full line for main/secondary cells. */
function fullCellLine(c) {
    const a = c.agenda || {};
    const b = c.bonds || {};
    const knows = knownMemories(c);
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
 * Build the injected state text. Exported for the /cc-inject preview command.
 * @returns {string} '' when there is nothing worth injecting.
 */
export function buildStateBlock() {
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
        for (const c of mains) L.push(fullCellLine(c));
        for (const c of minors) L.push(minorCellLine(c));
    }

    // The user's own scope (FF5 <internal_inv>)
    L.push(`USER: Inv: ${csv(user.inventory)} | Titles/Skills: ${csv(user.titles)} | Status: ${orDash(user.status)} | Mods: ${orDash(user.mods)}`);

    const factions = world.factions || [];
    if (factions.length) {
        L.push('FACTIONS:');
        for (const f of factions) L.push(`- ${orDash(f.name)} | Goal: ${orDash(f.goal)} | Intel: ${orDash(f.intel)} | State: ${orDash(f.fstate)} | Conflict: ${orDash(f.conflict)} | Relations: ${orDash(f.relations)}`);
    }

    const quests = world.quests || [];
    if (quests.length) {
        L.push('QUESTS:');
        for (const q of quests) L.push(`- ${q.type || 'Side'}: ${orDash(q.name)} — [${orDash(q.progress)}] | Reward: ${orDash(q.reward)}`);
    }

    const notes = (world.notes || []);
    if (notes.length) {
        L.push('GM NOTES:');
        for (const n of notes) L.push(`- [${n.type}] ${n.text}`);
    }

    const active = (world.chekhov || []).filter(c => (c.status || 'active') === 'active');
    if (active.length) {
        L.push('CHEKHOV PLANTS (planted, not yet fired — do not resolve early):');
        for (const c of active) L.push(`- ${c.text} (weight ${c.weight ?? 1}, age ${c.age ?? 0})${c.secret ? ' [secret — reveal only to those who know]' : ''}`);
    }

    const roll = world.roll || {};
    if (roll.task) {
        L.push(`DND TASK SIM: Task: ${orDash(roll.task)} | DC: ${orDash(roll.dc)} | User roll: ${orDash(roll.user)} | NPC roll: ${orDash(roll.npc)} | Delta: ${orDash(roll.delta)} | Outcome: ${orDash(roll.outcome)}`);
    }

    const combat = world.combat || {};
    if (combat.mode && combat.mode !== 'N/A') {
        L.push(`COMBAT: Mode: ${combat.mode} | Engagement: ${orDash(combat.engagement)} | Wounds: ${orDash(combat.wounds)} | Exchange: ${orDash(combat.exchange)}`);
    }

    if (world.env || world.physics) {
        L.push(`WORLD: Env: ${orDash(world.env)} | Physics: ${orDash(world.physics)}`);
    }

    if (world.turn) L.push(`TURN: ${world.turn}`);

    // Only the header if nothing else has content yet — skip injecting an empty shell.
    return L.length > 1 ? L.join('\n') : '';
}

/** Master switch for the injection (/cc-inject on|off). Default on. */
export let injectionEnabled = true;
export function setInjectionEnabled(v) { injectionEnabled = !!v; updateInjection(); }

/** Recompute and (re)register the injection. Safe to call anytime. */
export function updateInjection() {
    const value = injectionEnabled && hasState() ? buildStateBlock() : '';
    if (value) {
        setExtensionPrompt(INJECT_KEY, value, extension_prompt_types.IN_CHAT, INJECT_DEPTH, false, extension_prompt_roles.SYSTEM);
    } else {
        setExtensionPrompt(INJECT_KEY, '', extension_prompt_types.NONE, INJECT_DEPTH);
    }
}
