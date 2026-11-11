// Character Cells — shared bookkeeper command grammar
// ONE parser + applier used by BOTH the live bookkeeper (bookkeeper.js) and the
// backfill (backfill.js), so the two can never drift apart. Adding a command
// here makes it available to both.

import { getState, slug, addEvent, findEvent } from './state.js';

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
    const m = line.match(/^\s*(memory_add|witness|bond|agenda_step|agenda_set|status|presence|appear|chekhov|turn)\s*\((.*)\)\s*;?\s*$/i);
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
 * @returns {string} short result string for the log
 */
export function applyCommand(cmd, currentTurn, sceneRoles) {
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
            getState().world.turn = (Number(getState().world.turn) || 0) + 1;
            return 'turn +1';
        }
    }
    return 'skip: unknown op';
}
