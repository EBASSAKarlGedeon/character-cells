// Character Cells — slice 8: import state from an FF5 internal-states block.
// Deterministic parse of the MOST RECENT <internal_states> block in the open
// chat (exact final values written by FF5 itself), seeds cells + world, no
// model call. Runs BEFORE clean copy + seeded backfill (see backfill.js).
//
// Lenient by design: per-section regexes, parse what matches, skip what
// doesn't, never fail the whole import. parseStateBlock() is pure (no ST
// state access) so it can be exercised without a running tavern.

import { chat, characters, this_chid, saveChatDebounced } from '../../../../script.js';
import { selected_group } from '../../../../scripts/group-chats.js';
import { getState, addCell } from './state.js';
import { LOG_PREFIX } from './config.js';

// ================================================================ extraction

/**
 * Most recent <internal_states> block in the chat (newest message first).
 * Models sometimes omit the closing </internal_states> tag (block ends at
 * <!-- GFX_END --> or end of message), so the block boundary accepts all
 * three endings: closing tag, GFX_END comment, or end of text.
 */
export function findLatestStateBlock(messages) {
    for (let i = (messages || []).length - 1; i >= 0; i--) {
        const text = String(messages[i]?.mes || '');
        const blocks = text.match(/<internal_states[\s\S]*?(?:<\/internal_states>|(?=<!-- GFX_END -->)|$)/g);
        if (blocks && blocks.length) return blocks[blocks.length - 1];
    }
    return null;
}

/** Split a block into { title, body } pairs by <summary> markers (no tag balancing). */
export function splitSections(html) {
    const s = String(html || '');
    const sumRe = /<summary[^>]*>([\s\S]*?)<\/summary>/gi;
    const marks = [];
    let m;
    while ((m = sumRe.exec(s))) marks.push({ title: m[1].replace(/<[^>]+>/g, '').trim(), start: m.index + m[0].length });
    return marks.map((mark, i) => ({
        title: mark.title,
        body: s.slice(mark.start, i + 1 < marks.length ? marks[i + 1].start : s.length),
    }));
}

function section(sections, re) {
    return sections.find(sec => re.test(sec.title)) || null;
}

/** HTML → plain text: line breaks for <br>, tags stripped, entities decoded. */
function htmlToText(html) {
    return String(html || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/\r/g, '');
}

/** Split on top-level commas only (paren-bracket aware): "Stomach (a, b), c" → 2 parts. */
export function splitList(text) {
    const parts = [];
    let cur = '', depth = 0;
    for (const ch of String(text || '')) {
        if (ch === '(' || ch === '[') depth++;
        if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
        if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
        cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts.filter(Boolean);
}

const cleanVal = (s) => {
    const v = String(s || '').trim().replace(/[.;]+$/, '').trim();
    return /^none$/i.test(v) ? '' : v;
};
const splitSemis = (s) => cleanVal(s) ? cleanVal(s).split(';').map(p => p.trim()).filter(Boolean) : [];
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ================================================================ section parsers

/**
 * "- Name | Label: value | Label2: value2 ..." → { _first: 'Name', label: value, ... }.
 * Parts without a colon (like "(Step 1/1 → complete)") are dropped here; parsers
 * that need them re-extract them from the raw line.
 */
function parsePipeLine(lineText) {
    const m = String(lineText || '').match(/^-\s*(.+)$/);
    if (!m) return null;
    const parts = m[1].split('|').map(p => p.trim()).filter(Boolean);
    const out = { _first: parts[0] };
    for (const p of parts.slice(1)) {
        const c = p.indexOf(':');
        if (c > 0) out[p.slice(0, c).trim().toLowerCase()] = p.slice(c + 1).trim();
    }
    return out;
}

function parseAgendas(lines) {
    const out = [];
    for (const line of lines) {
        const f = parsePipeLine(line);
        if (!f || !f._first) continue;
        const entry = { name: f._first, goal: '', step: null, max: null, aware: [], fibs: '', circle: [], body: '' };
        if (f.agenda) entry.goal = cleanVal(f.agenda);
        // "(Step 1/3 → active — ...)" or "(Step ongoing)" — no colon, so from the raw line.
        const sm = line.match(/\(Step\s*(\d+)\s*\/\s*(\d+)/i);
        if (sm) { entry.step = parseInt(sm[1], 10); entry.max = parseInt(sm[2], 10); }
        entry.aware = splitSemis(f.aware);
        entry.fibs = cleanVal(f.fibs);
        entry.circle = splitSemis(f.circle);
        entry.body = cleanVal(f.body);
        out.push(entry);
    }
    return out;
}

/** "- Name | Location text" (FF5 has no "Location:" label; accept it if present). */
function parseLocations(lines) {
    const out = [];
    for (const line of lines) {
        const m = line.match(/^-\s*(.+?)\s*\|\s*(.+)$/);
        if (!m) continue;
        const loc = cleanVal(m[2].replace(/^location:\s*/i, ''));
        if (m[1].trim() && loc) out.push({ name: m[1].trim(), location: loc });
    }
    return out;
}

function parseBonds(lines) {
    const out = [];
    for (const line of lines) {
        const m = line.match(/^-\s*(.+?)\s*↔\s*(.+?)\s*\|\s*BOND:\s*(-?\d+)\s*\|\s*Sparks:\s*(-?\d+)\s*\|\s*Grudge:\s*(-?\d+)/i);
        if (m) out.push({ name: m[1].trim(), other: m[2].trim(), user: parseInt(m[3], 10), sparks: parseInt(m[4], 10), grudge: parseInt(m[5], 10) });
    }
    return out;
}

function parseFactions(lines) {
    const out = [];
    for (const line of lines) {
        const f = parsePipeLine(line);
        if (!f || !f._first) continue;
        out.push({
            name: f._first,
            goal: cleanVal(f.goal),
            intel: cleanVal(f.intel),
            fibs: cleanVal(f.fibs),
            fstate: cleanVal(f.state),
            conflict: cleanVal(f.conflict),
            relations: cleanVal(f.relations),
        });
    }
    return out;
}

function parseQuests(lines) {
    const out = [];
    for (const line of lines) {
        const m = line.match(/^-\s*(Main|Side):\s*(Active|Complete)\s*[—–-]+\s*(.+?)\s*\|\s*Progress:\s*(.+?)\s*\|\s*Reward:\s*(.+)$/i);
        if (m) out.push({ type: m[1][0].toUpperCase() + m[1].slice(1).toLowerCase(), name: m[3].trim(), progress: m[4].trim(), reward: m[5].trim() });
    }
    return out;
}

/**
 * Active/Locked bullet records; Fired/Pruned are prose → skipped.
 * "- Active: [BULLET: x] (weight: 2, age: 9/12) [depends: y] [secret]; [BULLET: ...]"
 */
function parseChekhov(text) {
    const bullets = [];
    let status = null;
    for (const rawLine of String(text || '').split('\n')) {
        const line = rawLine.trim().replace(/^-\s*/, '');
        if (/^Active:/i.test(line)) status = 'active';
        else if (/^Locked:/i.test(line)) status = 'locked';
        else if (/^(Fired|Pruned):/i.test(line)) status = null;
        if (!status || !line) continue;
        const chunks = line.replace(/^[A-Za-z]+:\s*/, '').split(/;\s*(?=\[BULLET:)/);
        for (const chunk of chunks) {
            const bm = chunk.match(/\[BULLET:\s*([^\]]*)\]/);
            if (!bm) continue;
            const b = { text: bm[1].trim(), status, weight: 1, age: 0, depends: '', secret: false };
            const w = chunk.match(/weight:\s*(\d+)/i);
            if (w) b.weight = Math.max(1, Math.min(3, parseInt(w[1], 10)));
            const a = chunk.match(/age:\s*(\d+)/i);
            if (a) b.age = parseInt(a[1], 10);
            const d = chunk.match(/\[depends:\s*([^\]]*)\]/i) || chunk.match(/\[LOCKED:\s*([^\]]*)\]/i);
            if (d) b.depends = d[1].trim();
            if (/\[secret\]/i.test(chunk)) b.secret = true;
            bullets.push(b);
        }
    }
    return bullets;
}

function parseNotes(lines) {
    const out = [];
    for (const line of lines) {
        const m = line.match(/^-\s*\[([RTD])\]\s*(.+)$/i);
        if (m) out.push({ type: m[1].toUpperCase(), text: m[2].trim() });
    }
    return out;
}

function parseThoughts(lines) {
    const out = [];
    for (const line of lines) {
        const m = line.match(/^-\s*(.+?)\s*\|\s*(.+)$/);
        if (m) out.push({ name: m[1].trim(), text: m[2].trim() });
    }
    return out;
}

/** INV & SKILLS → the user cell only (FF5 tracks {{user}}'s gear/skills there). */
function parseUserBlock(text) {
    const user = { inventory: [], titles: [], status: '', mods: '' };
    for (const rawLine of String(text || '').split('\n')) {
        const line = rawLine.trim();
        let m;
        if ((m = line.match(/^-?\s*Inv:\s*(.+)$/i))) {
            user.inventory = splitList(m[1]).filter(t => !/^none\.?$/i.test(t));
        } else if ((m = line.match(/^-?\s*Titles\/Skills:\s*(.+)$/i))) {
            const titlesPart = m[1].replace(/^Titles:\s*/i, '');
            user.titles.push(...splitList(titlesPart).map(t => t.replace(/\.+$/, '').trim()).filter(t => t && !/^none\.?$/i.test(t)));
        } else if ((m = line.match(/^-?\s*(Unique|Extra|Common|Intrinsic|Resist|Arts):\s*(.+)$/i))) {
            const cat = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
            user.titles.push(...splitList(m[2]).map(t => `${cat}: ${t.replace(/\.+$/, '').trim()}`).filter(t => !/:\s*none\.?$/i.test(t)));
        } else if ((m = line.match(/^-?\s*Status:\s*(.+)$/i))) {
            user.status = m[1].trim();
        } else if ((m = line.match(/^-?\s*Mods:\s*(.+)$/i))) {
            user.mods = m[1].trim();
        }
    }
    return user;
}

const ROLL_KEYS = { 'task': 'task', 'locked dc': 'dc', 'user roll': 'user', 'npc roll': 'npc', 'delta': 'delta', 'outcome': 'outcome' };

function parseDnd(text) {
    const roll = {};
    for (const rawLine of String(text || '').split('\n')) {
        const parts = rawLine.trim().replace(/^-\s*/, '').split('|').map(p => p.trim()).filter(Boolean);
        for (const p of parts) {
            const c = p.indexOf(':');
            if (c <= 0) continue;
            const key = ROLL_KEYS[p.slice(0, c).trim().toLowerCase()];
            if (key) roll[key] = p.slice(c + 1).trim();
        }
    }
    return roll;
}

function parseCombat(text) {
    const combat = {};
    for (const rawLine of String(text || '').split('\n')) {
        const parts = rawLine.trim().replace(/^-\s*/, '').split('|').map(p => p.trim()).filter(Boolean);
        for (const p of parts) {
            const c = p.indexOf(':');
            if (c <= 0) continue;
            const key = p.slice(0, c).trim().toLowerCase();
            if (['mode', 'engagement', 'wounds', 'exchange'].includes(key)) combat[key] = p.slice(c + 1).trim();
        }
    }
    return combat;
}

function parsePhysics(text) {
    const out = {};
    for (const rawLine of String(text || '').split('\n')) {
        const m = rawLine.trim().match(/^-\s*(Env|Physics):\s*(.+)$/i);
        if (m) out[m[1].toLowerCase()] = m[2].trim();
    }
    return out;
}

// ================================================================ full parse

/**
 * Parse one internal-states block into a plain seed object.
 * Pure function — no ST state access. Missing sections are simply absent.
 * npc records merge every name-bearing section; AGENDAS names (first seen,
 * usually the full canonical form) win the identity.
 */
export function parseStateBlock(html) {
    const sections = splitSections(html);
    const parsed = { turn: null, npcs: [], factions: [], quests: [], chekhov: [], notes: [], thoughts: [], user: null, roll: {}, combat: {}, env: '', physics: '' };

    const tm = (sections[0]?.title || '').match(/turn\s*:\s*(\d+)/i);
    if (tm) parsed.turn = parseInt(tm[1], 10);

    const linesOf = (body) => htmlToText(body).split('\n').map(l => l.trim()).filter(l => l.startsWith('-'));

    const ag = section(sections, /agenda/i);
    const agendas = ag ? parseAgendas(linesOf(ag.body)) : [];
    const loc = section(sections, /location/i);
    const locations = loc ? parseLocations(linesOf(loc.body)) : [];
    const bo = section(sections, /bond/i);
    const bonds = bo ? parseBonds(linesOf(bo.body)) : [];
    const fa = section(sections, /faction/i);
    if (fa) parsed.factions.push(...parseFactions(linesOf(fa.body)));
    const qu = section(sections, /quest/i);
    if (qu) parsed.quests.push(...parseQuests(linesOf(qu.body)));
    const ch = section(sections, /chekhov/i);
    if (ch) parsed.chekhov.push(...parseChekhov(htmlToText(ch.body)));
    const no = section(sections, /notebook/i);
    if (no) parsed.notes.push(...parseNotes(linesOf(no.body)));
    const th = section(sections, /thought/i);
    const thoughts = th ? parseThoughts(linesOf(th.body)) : [];
    const iv = section(sections, /inv\s*&\s*skills/i);
    if (iv) parsed.user = parseUserBlock(htmlToText(iv.body));
    const dn = section(sections, /dnd/i);
    if (dn) parsed.roll = parseDnd(htmlToText(dn.body));
    const co = section(sections, /combat/i);
    if (co) parsed.combat = parseCombat(htmlToText(co.body));
    const ph = section(sections, /physics/i);
    if (ph) { const p = parsePhysics(htmlToText(ph.body)); parsed.env = p.env || ''; parsed.physics = p.physics || ''; }

    // Merge NPC records across sections, prefix-matching short names ("Asahi" ↔ "Asahi Ishikawa").
    const merged = new Map(); // norm → record
    const ensure = (name) => {
        const n = normName(name);
        if (!n) return null;
        for (const [k, rec] of merged) {
            if (n.length >= 4 && k.length >= 4 && (k.startsWith(n) || n.startsWith(k))) return rec;
        }
        const rec = { name: String(name).trim(), agenda: null, bonds: null, location: '', thoughts: '' };
        merged.set(n, rec);
        return rec;
    };
    for (const a of agendas) { const rec = ensure(a.name); if (rec && !rec.agenda) rec.agenda = a; }
    for (const l of locations) { const rec = ensure(l.name); if (rec && !rec.location) rec.location = l.location; }
    for (const b of bonds) { const rec = ensure(b.name); if (rec && !rec.bonds) rec.bonds = b; }
    for (const t of thoughts) { const rec = ensure(t.name); if (rec && !rec.thoughts) rec.thoughts = t.text; }
    parsed.npcs = [...merged.values()];
    return parsed;
}

// ================================================================ seeding

/** Fuzzy-match a name against already-known cells (exact, then prefix both ways). */
function matchOrCreateCell(known, name) {
    const n = normName(name);
    if (!n) return null;
    const hit = known.find(k => k.norm === n)
        || known.find(k => n.length >= 4 && k.norm.length >= 4 && (k.norm.startsWith(n) || n.startsWith(k.norm)));
    if (hit) return hit.cell;
    const cell = addCell(name, 'minor');
    known.push({ norm: n, cell });
    return cell;
}

/** Seed parsed values into the chat's state. Returns per-section counts for the toast. */
export function seedState(parsed) {
    const state = getState();
    const counts = { cells: 0, bonds: 0, agendas: 0, thoughts: 0, chekhov: 0, notes: 0, quests: 0, factions: 0, user: 0, turn: 0 };
    const known = state.cells.map(c => ({ norm: normName(c.name), cell: c }));

    for (const npc of parsed.npcs) {
        const cell = matchOrCreateCell(known, npc.name);
        if (!cell || cell.fixed) continue; // never re-seed the user cell as an NPC
        counts.cells++;
        if (npc.agenda) {
            const a = npc.agenda;
            cell.agenda = cell.agenda || {};
            if (a.goal) cell.agenda.goal = a.goal;
            if (a.step != null) cell.agenda.step = a.step;
            if (a.max != null) cell.agenda.max = a.max;
            if (a.aware.length) cell.aware = a.aware;
            if (a.fibs) cell.fibs = a.fibs;
            if (a.circle.length) cell.circle = a.circle;
            if (a.body) cell.status = a.body;
            counts.agendas++;
        }
        if (npc.location) {
            cell.agenda = cell.agenda || {};
            cell.agenda.location = npc.location;
        }
        if (npc.bonds) {
            cell.bonds = { user: npc.bonds.user, sparks: npc.bonds.sparks, grudge: npc.bonds.grudge };
            counts.bonds++;
        }
        if (npc.thoughts) { cell.thoughts = npc.thoughts; counts.thoughts++; }
    }

    const userCell = state.cells.find(c => c.fixed);
    if (parsed.user && userCell) {
        if (parsed.user.inventory.length) userCell.inventory = parsed.user.inventory;
        if (parsed.user.titles.length) userCell.titles = parsed.user.titles;
        if (parsed.user.status) userCell.status = parsed.user.status;
        if (parsed.user.mods) userCell.mods = parsed.user.mods;
        if (parsed.user.inventory.length || parsed.user.titles.length || parsed.user.status || parsed.user.mods) counts.user = 1;
    }

    const uid = () => 'x' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
    if (parsed.chekhov.length) {
        state.world.chekhov = parsed.chekhov.map(b => ({ id: uid(), text: b.text, status: b.status, weight: b.weight, age: b.age, depends: b.depends, secret: b.secret }));
        counts.chekhov = parsed.chekhov.length;
    }
    if (parsed.notes.length) {
        state.world.notes = parsed.notes.map(n => ({ id: uid(), type: n.type, text: n.text }));
        counts.notes = parsed.notes.length;
    }
    if (parsed.quests.length) {
        state.world.quests = parsed.quests.map(q => ({ id: uid(), type: q.type, name: q.name, progress: q.progress, reward: q.reward }));
        counts.quests = parsed.quests.length;
    }
    if (parsed.factions.length) {
        state.world.factions = parsed.factions.map(f => ({ id: uid(), name: f.name, goal: f.goal, intel: f.intel, fibs: f.fibs, fstate: f.fstate, conflict: f.conflict, relations: f.relations }));
        counts.factions = parsed.factions.length;
    }
    for (const k of ['task', 'dc', 'user', 'npc', 'delta', 'outcome']) if (parsed.roll[k]) state.world.roll[k] = parsed.roll[k];
    for (const k of ['mode', 'engagement', 'wounds', 'exchange']) if (parsed.combat[k]) state.world.combat[k] = parsed.combat[k];
    if (parsed.env) state.world.env = parsed.env;
    if (parsed.physics) state.world.physics = parsed.physics;
    if (parsed.turn != null) { state.world.turn = parsed.turn; counts.turn = 1; }

    // Mark imported → backfill runs in SEEDED mode (ledger only, no double-count).
    state.imported = { turn: parsed.turn ?? 0, at: new Date().toISOString() };
    return counts;
}

// ================================================================ entry point

/** Panel button: import the most recent internal-states block into this chat's state. */
export async function importInternalStates() {
    if (selected_group) {
        toastr.warning('Import is not available for group chats yet.', 'Character Cells');
        return;
    }
    const char = characters[this_chid];
    if (!char || !Array.isArray(chat) || !chat.length) {
        toastr.warning('No chat open.', 'Character Cells');
        return;
    }
    const block = findLatestStateBlock(chat);
    if (!block) {
        toastr.info('No internal-states block found in this chat — nothing to import.', 'Character Cells');
        return;
    }
    const parsed = parseStateBlock(block);
    const empty = !parsed.npcs.length && !parsed.chekhov.length && !parsed.notes.length && !parsed.user;
    if (empty) {
        toastr.info('Found a state block but nothing in it could be parsed — nothing to import.', 'Character Cells');
        return;
    }
    const c = seedState(parsed);
    saveChatDebounced();
    toastr.success(
        `Imported from internal states: ${c.cells} character(s), ${c.bonds} bond card(s), ${c.agendas} agenda(s), ` +
        `${c.chekhov} bullet(s), ${c.notes} note(s), ${c.quests} quest(s), ${c.factions} faction(s), turn ${parsed.turn ?? '?'}. ` +
        `Fired/pruned bullets and unparsable lines were skipped.`,
        'Character Cells', { timeOut: 12000 });
    console.log(`${LOG_PREFIX} import:`, c);
}
