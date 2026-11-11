// Character Cells — shared bookkeeper command grammar
// ONE parser + applier used by BOTH the live bookkeeper (bookkeeper.js) and the
// backfill (backfill.js), so the two can never drift apart. Adding a command
// here makes it available to both.

import { getState, slug, addCell, addEvent, findEvent } from './state.js';
import { ensureRel, parseRoute, parseCondition, stageFor, TANGLED_STAGES } from './rel.js';

/** New tracked entries auto-creation may create per model call (junk flood guard). */
export const AUTO_CREATE_CAP = 4;

/** Resolve a name/id to a cell. Tries exact id, exact slug, then substring on name. */
export function resolveCell(token) {
    const t = String(token || '').trim().toLowerCase();
    if (!t) return null;
    const cells = getState().cells || [];
    return cells.find(c => c.id === t)
        || cells.find(c => slug(c.name) === t)
        || cells.find(c => c.name.toLowerCase() === t)
        || cells.find(c => c.name.toLowerCase().includes(t) && t.length >= 4)
        || null;
}

/** Parse one command line into { op, raw } or null. */
export function parseCommand(line) {
    const m = line.match(/^\s*(memory_add|witness|bond|agenda_step|agenda_set|status|presence|appear|chekhov|turn|task|note_add|note_del|inv|title|thought|plant|nowsim|char_add|faction_add|quest_add|trust|rel)\s*\((.*)\)\s*;?\s*$/i);
    if (!m) return null;
    return { op: m[1].toLowerCase(), raw: m[2] };
}

/** Split "a=1, b="x, y", c=2" style args on top-level commas. */
export function splitArgs(raw) {
    const parts = [];
    let cur = '', depth = 0, inQ = false;
    for (const ch of raw) {
        if (inQ) { cur += ch; if (ch === '"') inQ = false; continue; }
        if (ch === '"') { inQ = true; cur += ch; continue; }
        if (ch === '(' || ch === '[') depth++;
        if (ch === ')' || ch === ']') depth--;
        if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
        cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
}

const val = (s) => String(s || '').replace(/^["']|["']$/g, '').trim();
const intOf = (s) => { const n = parseInt(s, 10); return isNaN(n) ? 0 : n; };

/**
 * Apply one parsed command to the state.
 * @param {{op:string, raw:string}} cmd
 * @param {number} currentTurn
 * @param {object} sceneRoles collector for appear() roles (caller-owned)
 * @param {{onTurn?:function}} [opts] onTurn: reroute turn() to a caller-owned
 *   counter (backfill keeps a LOCAL virtual turn; the live bookkeeper doesn't)
 * @returns {string} short result string for the log
 */
export function applyCommand(cmd, currentTurn, sceneRoles, opts = {}) {
    const parts = splitArgs(cmd.raw);
    const kv = {};
    for (const p of parts) {
        const eq = p.indexOf('=');
        if (eq > 0) kv[p.slice(0, eq).trim().toLowerCase()] = p.slice(eq + 1).trim();
    }

    switch (cmd.op) {
        case 'memory_add': {
            const what = val(kv.what ?? (parts.find(p => !p.includes('=')) || ''));
            if (!what) return 'skip: no what';
            const who = (kv.who || '').split(',').map(val).filter(Boolean);
            const witnesses = [];
            for (const w of who) {
                const cell = resolveCell(w);
                if (cell && !witnesses.includes(cell.id)) witnesses.push(cell.id);
            }
            if (!witnesses.length) return `skip: no valid witness for "${what.slice(0, 40)}"`;
            const ev = addEvent(what, witnesses, currentTurn, intOf(kv.imp) || 1);
            return ev ? `memory: "${what.slice(0, 40)}" → ${ev.witnesses.join(',')}` : 'dup';
        }
        case 'witness': {
            const ev = findEvent(val(parts[0]));
            if (!ev) return 'skip: unknown event';
            const cell = resolveCell(parts[1]);
            if (!cell) return 'skip: unknown cell';
            if (!ev.witnesses.includes(cell.id)) ev.witnesses.push(cell.id); // additive only
            return `witness: ${cell.name} ← ${ev.id}`;
        }
        case 'bond': {
            const cell = resolveCell(parts[0]);
            const field = val(parts[1]).toLowerCase();
            const delta = intOf(parts[2]);
            if (!cell || !['user', 'sparks', 'grudge'].includes(field) || !delta) return 'skip: bad bond';
            // FF5 rule: BOND never rises directly — positive user-bond becomes Sparks.
            if (field === 'user' && delta > 0) {
                cell.bonds.sparks = Math.min(15, (Number(cell.bonds.sparks) || 0) + delta);
                return `bond: ${cell.name}.user +${delta} → redirected to SPARKS (FF5: BOND rises only via sparks)`;
            }
            cell.bonds[field] = Math.max(-10, Math.min(20, (Number(cell.bonds[field]) || 0) + delta));
            return `bond: ${cell.name}.${field} ${delta > 0 ? '+' : ''}${delta}`;
        }
        case 'agenda_step': {
            const cell = resolveCell(parts[0]);
            if (!cell) return 'skip: unknown cell';
            cell.agenda = cell.agenda || {};
            cell.agenda.step = (Number(cell.agenda.step) || 0) + 1;
            return `agenda_step: ${cell.name}`;
        }
        case 'agenda_set': {
            const cell = resolveCell(parts[0]);
            if (!cell) return 'skip: unknown cell';
            cell.agenda = cell.agenda || {};
            if (kv.goal) cell.agenda.goal = val(kv.goal);
            if (kv.location) cell.agenda.location = val(kv.location);
            if (kv.max !== undefined) cell.agenda.max = intOf(kv.max);
            return `agenda_set: ${cell.name}`;
        }
        case 'status': {
            const cell = resolveCell(parts[0]);
            const text = val(kv.status ?? parts.slice(1).join(','));
            if (!cell || !text) return 'skip: bad status';
            cell.status = text;
            return `status: ${cell.name} = ${text}`;
        }
        case 'presence': {
            const cell = resolveCell(parts[0]);
            const on = val(parts[1]).toLowerCase() === 'on';
            if (!cell) return 'skip: unknown cell';
            const s = getState();
            s.present = Array.isArray(s.present) ? s.present : [];
            const i = s.present.indexOf(cell.id);
            if (on && i < 0) s.present.push(cell.id);
            if (!on && i >= 0) s.present.splice(i, 1);
            return `presence: ${cell.name} ${on ? 'on' : 'off'}`;
        }
        case 'appear': {
            const cell = resolveCell(parts[0]);
            const role = val(parts[1]).toLowerCase();
            if (!cell) return 'skip: unknown cell';
            if (!['spoke', 'acted', 'present'].includes(role)) return 'skip: bad appear role';
            if (sceneRoles) sceneRoles[cell.id] = role;
            return `appear: ${cell.name} (${role})`;
        }
        case 'chekhov': {
            const id = val(parts[0]);
            const st = val(parts[1]).toLowerCase();
            const item = (getState().world.chekhov || []).find(c => c.id === id);
            if (!item || !['active', 'locked', 'fired'].includes(st)) return 'skip: bad chekhov';
            item.status = st;
            return `chekhov: ${id} → ${st}`;
        }
        case 'turn': {
            if (typeof opts.onTurn === 'function') { opts.onTurn(); return 'turn (local counter)'; }
            getState().world.turn = (Number(getState().world.turn) || 0) + 1;
            return 'turn +1';
        }
        case 'task': {
            // The bookkeeper only DETECTS the skilled action; the tick engine
            // resolves it (locks DC, rolls the real dice) before the next scene.
            const cell = resolveCell(parts[0]);
            if (!cell) return 'skip: unknown actor';
            const action = val(kv.action ?? parts.slice(1).join(','));
            const difficulty = val(kv.difficulty || parts[parts.length - 1]).toLowerCase();
            if (!action) return 'skip: no action';
            if (!['easy', 'mod', 'hard', 'impossible'].includes(difficulty)) {
                // tolerate a bare DC number too
                const n = parseInt(difficulty, 10);
                if (n >= 1 && n <= 20) {
                    getState().world.task = { actor: cell.id, action, dc: n, difficulty: 'mod' };
                    return `task: ${cell.name} "${action.slice(0, 40)}" DC ${n} (queued)`;
                }
                return 'skip: bad difficulty (easy|mod|hard|impossible)';
            }
            getState().world.task = { actor: cell.id, action, difficulty };
            return `task: ${cell.name} "${action.slice(0, 40)}" (${difficulty}, queued)`;
        }
        case 'note_add': {
            const type = val(kv.type ?? parts[0]).toUpperCase();
            const text = val(kv.text ?? parts.slice(1).join(','));
            if (!['R', 'T', 'D'].includes(type) || !text) return 'skip: bad note';
            const notes = getState().world.notes;
            notes.push({ id: uid(), type, text });
            if (notes.length > 20) notes.shift(); // FF5: max 20, prune oldest
            return `note: [${type}] ${text.slice(0, 40)}`;
        }
        case 'note_del': {
            const id = val(parts[0]);
            const notes = getState().world.notes;
            const i = notes.findIndex(n => n.id === id);
            if (i < 0) return 'skip: unknown note';
            notes.splice(i, 1);
            return `note deleted: ${id}`;
        }
        case 'inv': {
            const cell = resolveCell(parts[0]);
            const item = val(kv.item ?? parts.slice(1).join(','));
            if (!cell || !item) return 'skip: bad inv';
            cell.inventory = cell.inventory || [];
            if (item.startsWith('-')) {
                const drop = item.slice(1).trim().toLowerCase();
                cell.inventory = cell.inventory.filter(i => i.toLowerCase() !== drop);
                return `inv: ${cell.name} −${drop}`;
            }
            cell.inventory.push(item);
            return `inv: ${cell.name} +${item}`;
        }
        case 'title': {
            const cell = resolveCell(parts[0]);
            const name = val(kv.title ?? parts.slice(1).join(','));
            if (!cell || !name) return 'skip: bad title';
            cell.titles = cell.titles || [];
            if (name.startsWith('-')) {
                const drop = name.slice(1).trim().toLowerCase();
                cell.titles = cell.titles.filter(t => t.toLowerCase() !== drop);
                return `title: ${cell.name} −${drop}`;
            }
            cell.titles.push(name);
            return `title: ${cell.name} +${name}`;
        }
        case 'thought': {
            const cell = resolveCell(parts[0]);
            const text = val(kv.text ?? parts.slice(1).join(','));
            if (!cell || !text) return 'skip: bad thought';
            cell.thoughts = text;
            return `thought: ${cell.name}`;
        }
        case 'plant': {
            // Load a NEW Chekhov bullet (the fire decision stays with the engine).
            const text = val(kv.text ?? parts[0] ?? parts.join(','));
            if (!text) return 'skip: no plant';
            const bullets = getState().world.chekhov;
            if (bullets.some(b => b.text === text)) return 'dup';
            if (bullets.filter(b => (b.status || 'active') === 'active').length >= 20) return 'skip: chekhov at capacity';
            bullets.push({
                id: uid(), text,
                status: 'active',
                weight: Math.max(1, Math.min(3, intOf(kv.weight) || 1)),
                age: 0, depends: val(kv.depends || ''), secret: val(kv.secret || '') === 'true',
            });
            return `plant: "${text.slice(0, 40)}" (W${intOf(kv.weight) || 1})`;
        }
        case 'nowsim': {
            // Referee flag: intimate NSFW exchange — World Sim pauses this turn.
            getState().world.worldsimSkip = 'next';
            return 'nowsim: world sim paused this turn';
        }
        case 'char_add': {
            // Auto character creation: fuzzy-match FIRST (name variants merge
            // into the existing cell), create only when genuinely new.
            const name = val(kv.name ?? parts[0]);
            if (!name) return 'skip: no name';
            const existing = resolveCell(name);
            if (existing) {
                if (existing.fixed) return `skip: ${existing.name} is the user cell`;
                if (kv.desc && !existing.identity) existing.identity = val(kv.desc);
                return `char_add: ${existing.name} already tracked — merged`;
            }
            const cell = addCell(name, 'minor'); // tier/unpinned: auto-tier settles later
            if (kv.desc) cell.identity = val(kv.desc);
            const present = val(kv.present).toLowerCase();
            if (present === 'offstage') {
                // Named off-screen mover: agenda location set, never on stage.
                cell.agenda = cell.agenda || {};
                if (kv.location) cell.agenda.location = val(kv.location);
                return `char_add: ${cell.name} (offstage${kv.location ? `, ${val(kv.location)}` : ''})`;
            }
            return `char_add: ${cell.name} (minor, unpinned)`;
        }
        case 'faction_add': {
            // Upsert by name: reuse the exact existing faction to update it.
            const name = val(kv.name ?? parts[0]);
            if (!name) return 'skip: no faction name';
            const factions = getState().world.factions || (getState().world.factions = []);
            let f = factions.find(x => x.name.toLowerCase() === name.toLowerCase())
                || factions.find(x => name.length >= 4 && (x.name.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(x.name.toLowerCase())));
            let created = false;
            if (!f) {
                f = { id: uid(), name, goal: '', intel: '', fibs: '', fstate: '', conflict: '', relations: '' };
                factions.push(f);
                created = true;
            }
            for (const [field, key] of [['goal', 'goal'], ['intel', 'intel'], ['fibs', 'fibs'], ['fstate', 'state'], ['conflict', 'conflict'], ['relations', 'relations']]) {
                if (kv[key]) f[field] = val(kv[key]);
            }
            return `${created ? 'faction_add' : 'faction_upd'}: ${f.name}`;
        }
        case 'quest_add': {
            // Upsert by name: same quest name = progress/reward update.
            const name = val(kv.name ?? parts.slice(1).join(','));
            if (!name) return 'skip: no quest name';
            const quests = getState().world.quests || (getState().world.quests = []);
            let q = quests.find(x => x.name.toLowerCase() === name.toLowerCase())
                || quests.find(x => name.length >= 4 && (x.name.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(x.name.toLowerCase())));
            let created = false;
            if (!q) {
                const type = val(kv.type || 'Side').toLowerCase();
                q = { id: uid(), type: type === 'main' ? 'Main' : 'Side', name, progress: '', reward: '' };
                quests.push(q);
                created = true;
            }
            if (kv.type) q.type = val(kv.type).toLowerCase() === 'main' ? 'Main' : 'Side';
            if (kv.progress) q.progress = val(kv.progress);
            if (kv.reward) q.reward = val(kv.reward);
            return `${created ? 'quest_add' : 'quest_upd'}: ${q.type}: ${q.name}`;
        }
        case 'trust': {
            // Slice 9: trust is the NPC's separate-from-heart number. Judgment
            // only (bookkeeper emits it on earned evidence); no automatic tick.
            const cell = resolveCell(parts[0]);
            const delta = intOf(parts[1]);
            if (!cell) return 'skip: unknown cell';
            if (cell.fixed) return 'skip: user cell has no rel';
            if (!delta) return 'skip: bad trust delta';
            const counts = (opts.relCounts = opts.relCounts || {});
            const key = cell.id + ':trust';
            counts[key] = (counts[key] || 0) + 1;
            if (counts[key] > 2) return `skip: trust cap for ${cell.name} (2/turn)`;
            const r = ensureRel(cell);
            r.trust = Math.max(-5, Math.min(20, (Number(r.trust) || 0) + delta));
            return `trust: ${cell.name} ${delta > 0 ? '+' : ''}${delta} (now ${r.trust})`;
        }
        case 'rel': {
            // Slice 9: relationship-card fields. Vocabulary is validated here
            // (code owns it); the free-text judgment is the bookkeeper's.
            const cell = resolveCell(parts[0]);
            const field = val(parts[1]).toLowerCase();
            if (!cell) return 'skip: unknown cell';
            if (cell.fixed) return 'skip: user cell has no rel';
            const value = val(kv.value ?? parts.slice(2).join(','));
            const r = ensureRel(cell);
            const counts = (opts.relCounts = opts.relCounts || {});
            const once = (name, limit = 1) => {
                const key = cell.id + ':' + name;
                counts[key] = (counts[key] || 0) + 1;
                return counts[key] > limit;
            };
            switch (field) {
                case 'condition': {
                    if (once('condition')) return `skip: condition cap for ${cell.name}`;
                    const c = parseCondition(value);
                    if (!c) return 'skip: no condition';
                    if (r.condition === c) return 'dup';
                    r.condition = c;
                    return `rel: ${cell.name} condition → ${c}`;
                }
                case 'route': {
                    if (once('route')) return `skip: route cap for ${cell.name}`;
                    const p = parseRoute(value);
                    if (!p) return 'skip: no route name';
                    const route = `${p.emoji} ${p.name}`;
                    if (r.route === route) return 'dup';
                    r.route = route;
                    return `rel: ${cell.name} route → ${route}`;
                }
                case 'likes':
                case 'dislikes': {
                    // Append-only DISCOVERIES: one new entry per list per turn,
                    // capped lists (the panel hand-edit can prune).
                    if (once(field)) return `skip: ${field} cap for ${cell.name}`;
                    if (!value) return `skip: no ${field} entry`;
                    if (r[field].some(x => x.toLowerCase() === value.toLowerCase())) return 'dup';
                    if (r[field].length >= 8) return `skip: ${field} full (8)`;
                    r[field].push(value);
                    return `rel: ${cell.name} ${field} + ${value}`;
                }
                case 'keepsake': {
                    // The moment the NPC replays most = a LEDGER event id.
                    if (once('keepsake')) return `skip: keepsake cap for ${cell.name}`;
                    const ev = findEvent(value);
                    if (!ev) return 'skip: unknown keepsake event id';
                    if (r.keepsake === ev.id) return 'dup';
                    r.keepsake = ev.id;
                    return `rel: ${cell.name} keepsake → "${ev.what.slice(0, 40)}"`;
                }
                case 'threshold': {
                    if (once('threshold')) return `skip: threshold cap for ${cell.name}`;
                    if (!value) return 'skip: no threshold';
                    if (r.threshold === value) return 'dup';
                    r.threshold = value;
                    return `rel: ${cell.name} threshold → ${value.slice(0, 50)}`;
                }
                case 'severed': {
                    if (once('severed')) return `skip: severed cap for ${cell.name}`;
                    const on = ['true', 'on', 'yes', '1'].includes(value.toLowerCase());
                    if (r.severed === on) return 'dup';
                    r.severed = on;
                    return `rel: ${cell.name} severed ${on ? 'TRUE — bond ended' : 'cleared'}`;
                }
                case 'stage': {
                    // The ONE judgment exception to band-derived stage: a tangled
                    // pin. It releases automatically when BOND changes band.
                    if (once('stage')) return `skip: stage cap for ${cell.name}`;
                    const named = TANGLED_STAGES.find(t => t.toLowerCase() === value.trim().toLowerCase());
                    if (!named) return 'skip: only tangled stages are pinnable (Complicated|Codependent|Estranged|Rivals|Frenemies|Unrequited|Forbidden)';
                    if (r.stagePin === named) return 'dup';
                    r.stagePin = named;
                    r.stagePinBand = stageFor(cell.bonds?.user);
                    return `rel: ${cell.name} stage pinned → ${named} (releases when BOND changes band)`;
                }
                default:
                    return 'skip: bad rel field';
            }
        }
    }
    return 'skip: unknown op';
}

function uid() {
    return 'x' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
}
