// Character Cells — pre-generation tick engine (FF5 mechanics port, slice 1)
// Every FF5 rule runs HERE, before the narrator writes its next scene — hooked
// on GENERATION_AFTER_COMMANDS, which Generate() AWAITS before assembling the
// prompt. So dice, agenda ticks, Chekhov aging and bond cycles are already
// decided and injected when the narrator starts writing.
//
// The dice are the point: FF5's DnD sim exists to kill positivity bias, which
// only works if the roll happens BEFORE the narrator describes the outcome.
// So the task roll is pre-generation: one cheap referee call reads the user's
// incoming action and decides whether a skilled action with a real failure
// condition is being attempted (task command) and whether the exchange is an
// intimate NSFW scene (nowsim — World Sim pauses). The code then locks the DC
// and rolls real d20s. The narrator receives the outcome and must write it.
//
// Ported mechanics (spec "FF5 mechanics port"):
//   - Agenda: off-screen NPCs tick +1/turn; completion fires its effect;
//     completed agendas refresh to a new mundane one.
//   - Chekhov: bullets age +1/turn (time-locked stay frozen), prune at 12,
//     d20 firing checks against threshold = base(weight) − age − proximity
//     (from the last scene's appear roles), age ≥ 4 gate, nat-1 jam,
//     nat-20 cascade (−4 threshold to the rest), max 20 active.
//   - Bonds: every 5th turn Sparks check (≥7 → BOND+1), every 3rd turn
//     Grudge check (≥5 → BOND−1) with decay; BOND never rises directly.
//   - DnD: task detection (cheap call) + locked DC + real dice, pre-generation.
//   - World Sim: one d20 per turn, band → event category (both tables).
//
// Everything that needs narrative judgment stays with the bookkeeper — the
// tick only executes rules; it never invents story.

import { chat } from '../../../../script.js';
import { getState, hasState, findCell } from './state.js';
import { cheapCall } from './llm.js';
import { parseCommand, applyCommand } from './commands.js';
import { markRelStamps } from './rel.js';
import { getSettings } from './settings.js';
import { LOG_PREFIX } from './config.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const d20 = () => 1 + Math.floor(Math.random() * 20);

// ---------------------------------------------------------------- world sim

const STANDARD_TABLE = [
    { band: [1, 2], event: 'CALM', desc: 'Quiet moment; ambient detail welcome' },
    { band: [3, 4], event: 'ENTER_CHECK', desc: 'An off-screen NPC may enter soon (or send word)' },
    { band: [5, 6], event: 'BACKGROUND_INCIDENT', desc: 'Minor off-screen event, audible or referenced' },
    { band: [7, 8], event: 'MOOD_SWING', desc: 'A noticeable tone pivot in an on-screen character' },
    { band: [9, 10], event: 'GOSSIP_SURGE', desc: 'An off-screen rumor reaches an unintended ear' },
    { band: [11, 12], event: 'CHANCE_MEETING', desc: 'Two off-screen NPCs cross paths (offstage)' },
    { band: [13, 14], event: 'OVERHEARD_DETAIL', desc: 'An off-screen NPC gains useful intel' },
    { band: [15, 16], event: 'TASK_SHIFT', desc: 'An off-screen task concludes early or runs late' },
    { band: [17, 18], event: 'MUNDANE_INTERRUPTION', desc: 'Knock, door slam, or ambient break' },
    { band: [19, 20], event: 'CALM', desc: 'Quiet moment; ambient detail welcome' },
];

const DUO_TABLE = [
    { band: [1, 2], event: 'CALM', desc: 'Quiet; ambient detail welcome' },
    { band: [3, 4], event: 'ENV_SHIFT', desc: 'Lights flicker, window rattles, weather shifts' },
    { band: [5, 6], event: 'MOOD_SWING', desc: 'A sudden emotional shift in one present character' },
    { band: [7, 8], event: 'PHYSICAL_REACTION', desc: 'Shiver, stomach growl, limb fallen asleep' },
    { band: [9, 10], event: 'MEMORY_TRIGGER', desc: 'A sensory cue brings up a vivid memory' },
    { band: [11, 12], event: 'OBJECT_DISCOVERY', desc: 'An unnoticed physical detail becomes relevant' },
    { band: [13, 14], event: 'OUTSIDE_INTRUSION', desc: 'Distant siren, shouting neighbor, rain surge' },
    { band: [15, 16], event: 'POWER_SHIFT', desc: 'Confidence turns timid, or timid turns bold' },
    { band: [17, 18], event: 'MUNDANE_INTERRUPTION', desc: 'Phone buzzes, wrong number, ambient noise' },
    { band: [19, 20], event: 'CALM', desc: 'Quiet; ambient detail welcome' },
];

/** Standard table needs 3+ named NPCs with off-screen ones; else duo. */
function pickWorldSimTable(s) {
    const npcs = s.cells.filter(c => !c.fixed);
    const offscreen = npcs.filter(c => !(s.present || []).includes(c.id));
    if (npcs.length <= 2 || offscreen.length === 0) return DUO_TABLE;
    return STANDARD_TABLE;
}

function rollWorldSim(s, turn) {
    const table = pickWorldSimTable(s);
    const roll = d20();
    const row = table.find(r => roll >= r.band[0] && roll <= r.band[1]) || table[0];
    s.world.worldsim = { roll, event: row.event, desc: row.desc, table: table === DUO_TABLE ? 'duo' : 'standard', turn };
    return `worldsim: d20=${roll} → ${row.event}`;
}// ---------------------------------------------------------------- agenda tick

/**
 * Off-screen agendas tick +1/turn. On completion the FF5 completion effects
 * fire in code, and a fresh mundane agenda replaces the old one.
 * Returns log lines.
 */
function tickAgendas(s, turn, log) {
    const present = s.present || [];
    for (const cell of s.cells) {
        if (cell.fixed) continue;
        const a = cell.agenda;
        if (!a || !a.goal) continue;         // no agenda yet → bookkeeper will set one
        if (present.includes(cell.id)) continue; // on-screen: no ticking
        a.step = (Number(a.step) || 0) + 1;
        if (a.step < (Number(a.max) || 1)) {
            log.push(`agenda tick: ${cell.name} ${a.step}/${a.max}`);
            continue;
        }
        // --- completion effects (FF5 Internal Agenda)
        const goal = String(a.goal || '').toLowerCase();
        if (/rest|recover|sleep|heal/.test(goal)) {
            cell.status = 'healthy';
            cell.bonds.grudge = 0;
            log.push(`agenda complete (rest): ${cell.name} → healthy, grudge cleared`);
        } else if (/reconcil|apolog|make up/.test(goal)) {
            cell.bonds.user = clamp((Number(cell.bonds.user) || 0) + 1, -10, 20);
            log.push(`agenda complete (reconcile): ${cell.name} BOND+1`);
        } else if (/research|investigat|study|search/.test(goal)) {
            // plant a passive W1 Chekhov seed from what was investigated
            const bullets = s.world.chekhov || [];
            if (bullets.length < 20) {
                bullets.push({ id: uid(), text: `Findings from: ${a.goal}`, status: 'active', weight: 1, age: 0, depends: '', secret: false });
                log.push(`agenda complete (research): Chekhov seed planted for ${cell.name}`);
            }
        }
        // travel/move → the new location IS the arrival; no extra effect needed.
        // repair/build → FF5 adds to NPC inventory; inventory text is free-form,
        // so the refresh below notes it in the new agenda instead.
        // mundane → nothing beyond the refresh.
        // --- refresh: new mundane agenda (FF5 default steps)
        const mundane = ['rest', 'eat', 'work', 'wander', 'study', 'train'];
        const m = mundane[Math.floor(Math.random() * mundane.length)];
        cell.agenda = { goal: m, step: 0, max: 1 + Math.floor(Math.random() * 3), location: a.location || '' };
        log.push(`agenda refresh: ${cell.name} → "${m}" (${cell.agenda.max} steps)`);
    }
}

// ---------------------------------------------------------------- bond ticks

/**
 * FF5 Relationships RPG cycles: Sparks check every 5th turn, Grudge check
 * every 3rd. Trackers (lastCheck values) live on the cell so they persist.
 */
function tickBonds(s, turn, log) {
    for (const cell of s.cells) {
        if (cell.fixed) continue;
        const b = cell.bonds;
        cell.tick = cell.tick || { sparks: 0, grudge: 0 };
        // positive-interaction bookkeeping: did the bookkeeper add Sparks since the last check?
        const sparked = (Number(b.sparks) || 0) > (Number(cell.tick.lastSparks) || 0);
        cell.tick.lastSparks = Number(b.sparks) || 0;

        // --- Sparks check (every 5th turn)
        cell.tick.sparks = (Number(cell.tick.sparks) || 0) + 1;
        if (cell.tick.sparks >= 5) {
            cell.tick.sparks = 0;
            if ((Number(b.sparks) || 0) >= 7) {
                b.user = clamp((Number(b.user) || 0) + 1, -10, 20);
                b.sparks = 0;
                log.push(`bond check: ${cell.name} SPARKS→BOND+1 (now ${b.user})`);
            } else if (!sparked) {
                b.sparks = Math.max(0, (Number(b.sparks) || 0) - 1);
                log.push(`bond check: ${cell.name} sparks decay −1 (now ${b.sparks})`);
            } else {
                log.push(`bond check: ${cell.name} sparks ${b.sparks} (building, not yet 7)`);
            }
        }
        // --- Grudge check (every 3rd turn)
        cell.tick.grudge = (Number(cell.tick.grudge) || 0) + 1;
        if (cell.tick.grudge >= 3) {
            cell.tick.grudge = 0;
            if ((Number(b.grudge) || 0) >= 5) {
                b.user = clamp((Number(b.user) || 0) - 1, -10, 20);
                b.grudge = 0;
                log.push(`bond check: ${cell.name} GRUDGE≥5 → BOND−1 (now ${b.user})`);
            } else if ((Number(b.grudge) || 0) > 0) {
                b.grudge -= 1;
                log.push(`bond check: ${cell.name} grudge decay (now ${b.grudge})`);
            }
        }
    }
}

// ---------------------------------------------------------------- chekhov tick

/**
 * FF5 Chekhov aging + firing. Aging and pruning always; FIRING only when
 * enabled (autoChekhov). Proximity modifiers come from the last scene's
 * appear roles (tiers.js tierLog), as the spec decided.
 * @returns {{log:string[], fired:string[]}}
 */
function tickChekhov(s, turn, log) {
    const bullets = Array.isArray(s.world.chekhov) ? s.world.chekhov : [];
    const fired = [];
    if (!bullets.length) return { log, fired };

    // last scene's participation: proximity modifiers
    const tierLog = Array.isArray(s.tierLog) ? s.tierLog : [];
    const roles = tierLog.length ? tierLog[tierLog.length - 1].roles : {};

    // age everything unlocked; prune at 12; keep at most 20 active
    for (const b of bullets) {
        if ((b.status || 'active') !== 'active') continue;
        if (b.lockedUntilTurn && turn < b.lockedUntilTurn) continue; // time lock frozen
        b.age = (Number(b.age) || 0) + 1;
        if (b.age >= 12) {
            b.status = 'fired';
            b.firedNote = 'aged out (never fired)';
            log.push(`chekhov prune: "${(b.text || '').slice(0, 40)}" aged out`);
        }
    }
    let active = bullets.filter(b => (b.status || 'active') === 'active');
    if (active.length > 20) {
        active.sort((x, y) => ((y.weight || 1) - (x.weight || 1)) || ((y.age || 0) - (x.age || 0)));
        for (const b of active.slice(20)) {
            b.status = 'fired';
            b.firedNote = 'capacity prune';
        }
        log.push(`chekhov capacity: pruned to 20`);
    }

    // --- firing engine (5 checks/turn among age-eligible, highest weight first)
    if (!getSettings().autoChekhov) return { log, fired };
    active = bullets.filter(b => (b.status || 'active') === 'active' && (Number(b.age) || 0) >= 4)
        .sort((x, y) => ((y.weight || 1) - (x.weight || 1)) || ((y.age || 0) - (x.age || 0)));
    const eligible = active.slice(0, 5);
    const cascade = []; // nat-20 later grants −4 to the rest
    for (const b of eligible) {
        const w = clamp(Number(b.weight) || 1, 1, 3);
        let threshold = (w === 1 ? 18 : w === 2 ? 13 : 8) - (Number(b.age) || 0);
        // proximity from the last scene's appear roles
        const text = String(b.text || '').toLowerCase();
        for (const id of Object.keys(roles)) {
            const cell = findCell(id);
            if (!cell) continue;
            const subject = text.includes(cell.name.toLowerCase()) || text.includes(cell.id);
            if (!subject) continue;
            if (roles[id] === 'spoke') threshold -= 2;
            else threshold -= 1; // acted or present on stage
        }
        if (cascade.length) threshold -= 4; // a nat-20 fired earlier this turn
        if (threshold < 1) threshold = 1;   // always some chance
        const roll = d20();
        if (roll === 1) {
            b.status = 'fired';
            b.firedNote = 'JAMMED (nat 1)';
            log.push(`chekhov JAM (nat 1): "${(b.text || '').slice(0, 40)}"`);
            continue;
        }
        if (roll === 20 && !cascade.length) {
            cascade.push(b.id);
            log.push(`chekhov nat-20 cascade: remaining thresholds −4`);
        }
        if (roll >= threshold) {
            b.status = 'fired';
            fired.push({ text: b.text, secret: !!b.secret });
            log.push(`chekhov FIRED (d20=${roll} ≥ ${threshold}): "${(b.text || '').slice(0, 40)}"`);
        }
    }
    return { log, fired };
}

// ---------------------------------------------------------------- task (DnD)

const REFeree_SYSTEM = 'You are a dice referee for a roleplay session. You read what the user is about to attempt and output at most a few state-command lines. You never write prose, never narrate, never comment. Output ONLY command lines, one per line, in the exact grammar given. If nothing applies, output nothing at all.';

/**
 * Pre-generation referee call: does the user's incoming action (or an NPC they
 * directly challenge) attempt a skilled action with a REAL failure condition?
 * Queues task(...) for the roller, and nowsim() when the exchange is intimate
 * NSFW (World Sim pauses there, per FF5). One cheap call, never fatal.
 */
async function refereeCall() {
    // find the last user message and the AI reply before it (context)
    let userIdx = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i].is_user && !chat[i].is_system) { userIdx = i; break; }
    }
    if (userIdx < 0) return;
    const userText = String(chat[userIdx].mes || '').slice(0, 2000);
    const prevAi = userIdx > 0 ? String(chat[userIdx - 1].mes || '').replace(/<internal_states[\s\S]*?<\/internal_states>/g, '').slice(0, 1500) : '';
    const s = getState();
    const cells = s.cells.map(c => `${c.name} (id ${c.id}${c.fixed ? ', user' : `, bond ${c.bonds?.user ?? 0}`}, inv: ${(c.inventory || []).join('/') || 'none'}, titles: ${(c.titles || []).join('/') || 'none'}, mods: ${c.mods || 'none'})`).join('; ');
    const prompt = `TRACKED STATE: ${cells}

PREVIOUS EXCHANGE (context, AI side):
${prevAi || '(none)'}

USER'S NEW MESSAGE (the action being attempted now):
${userText}

COMMANDS (one per line, or nothing):
task(<actorId>, action="...", easy|mod|hard|impossible)   # a skilled action WITH a real failure condition is being attempted. Actor = the user's cell id, or an NPC they directly challenge/dare into an attempt. Trivial acts auto-pass. Pure conversation, expression, movement = NO task. Difficulty by the actor's proficiency.
nowsim()                                                  # this exchange is/becomes an intimate NSFW scene — pause the World Sim roll this turn

RULES:
- Dice are law: if a task is real, its outcome must be undecided — that is why you are called BEFORE the scene is written.
- No speculation about what happens next. Only what the user's message attempts.
- No explanations. Command lines only, or nothing.`;
    try {
        const reply = await cheapCall(REFeree_SYSTEM, prompt, 150);
        const lines = String(reply || '').split('\n').map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
            const cmd = parseCommand(line);
            if (!cmd) continue;
            try { applyCommand(cmd, 0, {}); } catch (e) {
                console.warn(`${LOG_PREFIX} referee command failed:`, line, e);
            }
        }
        return lines.length;
    } catch (err) {
        console.warn(`${LOG_PREFIX} referee call failed (no task this turn):`, err);
        return 0;
    }
}

/**
 * Resolve the queued task: lock DC by band, roll real d20s, apply modifiers
 * (bond→DC per FF5, inventory/title mods), compute Δ and the outcome band.
 * The outcome is for the ACTOR's side. Never fudged, never re-rolled.
 * @returns {string[]} log lines
 */
function resolveTask(s, turn, log) {
    const t = s.world.task;
    if (!t) return;
    s.world.task = null; // consume it either way
    const actor = findCell(t.actor);
    // Lock the DC within the difficulty band (Easy 1-5 / Mod 5-10 / Hard 10-15 / Impossible 15-20)
    const BAND = { easy: [1, 5], mod: [5, 10], hard: [10, 15], impossible: [15, 20] };
    const b = BAND[t.difficulty] || BAND.mod;
    const dc = (Number(t.dc) > 0 && Number(t.dc) <= 20) ? Number(t.dc)
        : (b[0] + Math.floor(Math.random() * (b[1] - b[0] + 1)));
    // --- DC modifiers: bond (FF5) + inventory/title buffs (FF5 <internal_inv>)
    let dcMod = 0;
    const bond = actor ? (Number(actor.bonds.user) || 0) : 0;
    if (bond >= 15) dcMod -= 4; else if (bond >= 8) dcMod -= 2; else if (bond >= 4) dcMod -= 1;
    else if (bond <= -5) dcMod += 4; else if (bond <= -3) dcMod += 2;
    // actor.mods is free text like "+1 sword, -2 injured" — sum the signed numbers.
    const mods = actor ? String(actor.mods || '') : '';
    dcMod += (mods.match(/[+-]\d+/g) || []).reduce((acc, m) => acc + parseInt(m, 10), 0);
    const userRoll = d20(), npcRoll = d20();
    const isUserActor = !!actor?.fixed;
    const actorRoll = isUserActor ? userRoll : npcRoll;
    const delta = actorRoll + dcMod - dc;
    const band = (d, roll) => {
        if (roll === 20 || d >= 8) return 'crit success';
        if (d >= 0) return 'success';
        if (d >= -3) return 'near miss';
        if (d >= -7) return 'failure';
        return 'crit failure';
    };
    const outcome = band(delta, actorRoll);
    s.world.roll = {
        task: `${actor ? actor.name : t.actor} attempts ${t.action}`,
        dc, user: userRoll, npc: npcRoll,
        delta: `${delta >= 0 ? '+' : ''}${delta}`,
        outcome, turn,
    };
    log.push(`task: ${t.action.slice(0, 40)} DC ${dc} (mods ${dcMod >= 0 ? '+' : ''}${dcMod}), d20=${actorRoll} Δ${delta} → ${outcome.toUpperCase()}`);
}

// ---------------------------------------------------------------- entry point

/**
 * Run one full pre-generation tick. The referee call (task detection) is
 * awaited, so Generate() waits for the dice before building the prompt.
 * @returns {{ changes: string[], fired: string[] }}
 */
export async function runTick() {
    if (!hasState()) return { changes: [], fired: [] }; // no state → nothing to run
    const s = getState();
    const turn = (Number(s.world.turn) || 0) + 1;
    const log = [];
    // 1. Referee: detect the attempted task (dice decide BEFORE the scene is written)
    await refereeCall();
    resolveTask(s, turn, log);
    // 2. Mechanical ticks
    tickAgendas(s, turn, log);
    tickBonds(s, turn, log);
    markRelStamps(); // bond ticks can move the derived stage — stamp for the drift label
    const chekhovResult = tickChekhov(s, turn, log);
    // 3. World Sim — skipped when the referee flagged an intimate NSFW exchange
    if (getSettings().worldSimEnabled) {
        if (s.world.worldsimSkip === 'next') {
            s.world.worldsimSkip = false; // consume the flag for THIS tick
            log.push('worldsim: skipped (intimate NSFW)');
        } else {
            log.push(rollWorldSim(s, turn));
        }
    }
    s.world.turn = turn; // the tick OWNS the turn counter (one tick per generation)
    // Fired bullets ride on the world state so the inject (which runs next,
    // before the generation) can surface them. Reset every turn — a fire is
    // surfaced exactly once, in the turn it fired.
    s.world.chekhovFired = chekhovResult.fired;
    if (log.length) console.log(`${LOG_PREFIX} tick @turn ${turn}:\n  ` + log.join('\n  '));
    return { changes: log, fired: chekhovResult.fired };
}

/** Panel/CC TOOLS convenience: rerun the world-sim roll only (/cc-worldsim now). */
export function rerollWorldSim() {
    const s = getState();
    return rollWorldSim(s, (Number(s.world.turn) || 0) + 1);
}

function uid() {
    return 'x' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
}
