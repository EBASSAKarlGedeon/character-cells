// Character Cells — panel renderer
// Mimics the FF5 internal-states block VERBATIM: flat stack of colored section
// bars (teal/purple/orange groups), dense "Name | Field: value" lines, and
// BOND progress-bar cards. Generated from state data; values are editable inline.

import { stageOf, driftOf, WARM_LADDER, COLD_LADDER, DRIFT_UP, DRIFT_DOWN } from './rel.js';
import { findEvent } from './state.js';

const esc = escapeHtml;

/** A dense "- <b>Label:</b> value | ..." line with editable value slots. */
function line(parts) {
    return `- ${parts}`;
}

function editable(value, field, placeholder = '') {
    return `<span class="cc-ed" contenteditable="true" data-field="${field}" data-ph="${esc(placeholder)}">${esc(value) || placeholder}</span>`;
}

function section(id, icon, title, group, bodyHtml, open = false) {
    return `
<details class="cc-sec cc-${group}" data-sec="${id}" ${open ? 'open' : ''}>
  <summary>${icon} ${esc(title)}</summary>
  <div class="cc-sec-body">${bodyHtml}</div>
</details>`;
}

// CC TOOLS section — strip-copy / backfill / digest controls.
// stateSummary comes from index.js's scope (passed via options), not the state object.
function toolsSection(state) {
    const bf = state.backfill || {};
    const running = !!bf.running;
    const progress = bf.progress ? `message ${bf.progress}` : '';
    const ds = digestInfo();
    const backfillLabel = bf.done ? 'Backfill done — run again to redo'
        : running ? `STOP backfill (${progress})`
        : bf.progress ? `RESUME backfill (${progress})`
        : 'Backfill ledger from chat history';
    return `
<details class="cc-sec cc-orange" data-sec="tools">
  <summary>🧰 CC TOOLS</summary>
  <div class="cc-sec-body">
    <div class="cc-tools-row">
      <button class="menu_button" data-cc-import="1">Import state from internal states</button>
      <div class="cc-tools-note">For OLD FF5 chats: parses the most recent internal-states block (exact final values, no model call), creates NPC cells and seeds the turn counter. Old-chat order: Import → Clean copy → Backfill. The backfill then runs in seeded mode (ledger only).</div>
    </div>
    <div class="cc-tools-row">
      <button class="menu_button" data-cc-clean-copy="1">Clean copy (strip internal states)</button>
      <div class="cc-tools-note">Creates a copy of this chat with all old internal-states blocks removed; original untouched. Carries over existing cell state (so a run Import first isn't lost).</div>
    </div>
    <div class="cc-tools-row">
      <button class="menu_button" data-cc-backfill="1">${backfillLabel}</button>
      <div class="cc-tools-note">Rebuilds the event ledger from the cleaned chat's full history — one cheap call per 4 messages. Cancelable, resumable, costs one call per batch.</div>
      ${running ? '<div class="cc-backfill-progress">running…</div>' : ''}
    </div>
    <div class="cc-tools-row">
      <button class="menu_button" data-cc-digest="1">Rebuild digests</button>
      <div class="cc-tools-note">Re-summarizes old (pre-hot-window) memories per character. The ledger is never touched — digests are cached views. ${ds}</div>
    </div>
  </div>
</details>`;
}

let _digestInfoFn = null;
/** index.js injects the digest-stats formatter to avoid a render→digest import cycle. */
export function setDigestInfo(fn) { _digestInfoFn = fn; }
function digestInfo() {
    try { return _digestInfoFn ? _digestInfoFn() : ''; } catch { return ''; }
}

export function renderStateHtml(state) {
    const world = state.world || {};
    const cells = state.cells || [];
    const userCell = cells.find(c => c.fixed);   // user cell is the fixed one (id is the persona slug)
    const npcs = cells.filter(c => !c.fixed);    // everyone else is an NPC
    const factions = world.factions || [];
    const quests = world.quests || [];
    const chekhov = world.chekhov || [];
    const roll = world.roll || {};
    const combat = world.combat || {};
    const notes = world.notes || [];

    // ---- NPC AGENDAS (teal)
    const agendas = npcs.length ? npcs.map(c => {
        const a = c.agenda || {};
        return line(
            `<b>${esc(c.name)}</b> | Agenda: ${editable(a.goal || '', 'agenda-goal', '—')} | ` +
            `(Step ${editable(String(a.step ?? 0), 'agenda-step')} / ${editable(String(a.max ?? 0), 'agenda-max')}) | ` +
            `Aware: ${editable((c.aware || []).join(', '), 'aware', 'none')} | ` +
            `Fibs: ${editable(c.fibs || '', 'fibs', 'none')} | ` +
            `Circle: ${editable((c.circle || []).join(', '), 'circle', 'none')} | ` +
            `Body: ${editable(c.status || '', 'status', '—')}`
        );
    }).join('<br>') : '<div class="cc-none">- None</div>';
    const agendasSec = section('agendas', '👤', 'NPC AGENDAS', 'teal', agendas);

    // ---- NPC LOCATIONS (teal)
    const locs = npcs.length ? npcs.map(c =>
        line(`<b>${esc(c.name)}</b> | Location: ${editable((c.agenda && c.agenda.location) || '', 'agenda-location', 'unknown')}`)
    ).join('<br>') : '<div class="cc-none">- None</div>';
    const locationsSec = section('locations', '👤', 'NPC LOCATIONS', 'teal', locs);

    // ---- NPC INVENTORIES (teal) — one editable line per NPC (FF5 inv scope per character)
    const invs = npcs.length ? npcs.map(c => `
      <div class="cc-item" data-cell-id="${esc(c.id)}">
        ${line(`<b>${esc(c.name)}</b> | Inv: ${editable((c.inventory || []).join(', '), 'inventory', 'none')}`)}
      </div>`).join('') : '<div class="cc-none">- None</div>';
    const inventoriesSec = section('inventories', '🎒', 'NPC INVENTORIES', 'teal', invs);

    // ---- FACTIONS (teal)
    const facBody = (factions.length ? factions.map(f => `
      <div class="cc-item" data-faction-id="${esc(f.id)}">
        ${line(
            `<b>${editable(f.name || '', 'faction-name', 'Name')}</b> | Goal: ${editable(f.goal || '', 'faction-goal', '—')} | ` +
            `Intel: ${editable(f.intel || '', 'faction-intel', 'none')} | Fibs: ${editable(f.fibs || '', 'faction-fibs', 'none')} | ` +
            `State: ${editable(f.fstate || '', 'faction-state', '—')} | Conflict: ${editable(f.conflict || '', 'faction-conflict', 'none')} | ` +
            `Relations: ${editable(f.relations || '', 'faction-relations', 'none')}`
        )}
        <button class="cc-x" data-del-faction="${esc(f.id)}">✖</button>
      </div>`).join('') : '<div class="cc-none">- None</div>') +
      `<div class="cc-row"><input class="cc-new text_input" placeholder="New faction name…"><button class="cc-plus" data-add-faction="1">＋</button></div>`;
    const factionsSec = section('factions', '🚩', 'FACTIONS', 'teal', facBody);

    // ---- BONDS (teal) — progress-bar cards, one per NPC
    const bondCards = npcs.length ? npcs.map(c => {
        const b = c.bonds || {};
        const bond = Number(b.user ?? 0), sparks = Number(b.sparks ?? 0), grudge = Number(b.grudge ?? 0);
        const pct = (v, min, max) => Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100));
        return `
    <div class="cc-bond-card" data-cell-id="${esc(c.id)}">
      <div class="cc-bond-title">${esc((c.name || '').toUpperCase())} <span class="cc-arrow">&harr;</span> USER</div>
      <div class="cc-bond-row"><span class="cc-bond-label ${bond < 0 ? 'l-bond-neg' : 'l-bond'}">BOND: ${editable(String(bond), 'bond-user')}</span>
        <div class="cc-track"><div class="cc-fill ${bond < 0 ? 'f-bond-neg' : 'f-bond'}" style="width:${bond < 0 ? pct(-bond, 0, 5) : pct(bond, 0, 20)}%"></div></div></div>
      <div class="cc-bond-row"><span class="cc-bond-label l-sparks">SPARKS: ${editable(String(sparks), 'bond-sparks')}</span>
        <div class="cc-track"><div class="cc-fill f-sparks" style="width:${pct(sparks, 0, 15)}%"></div></div></div>
      <div class="cc-bond-row"><span class="cc-bond-label l-grudge">GRUDGE: ${editable(String(grudge), 'bond-grudge')}</span>
        <div class="cc-track"><div class="cc-fill f-grudge" style="width:${pct(grudge, 0, 10)}%"></div></div></div>
    </div>`;
    }).join('') : '<div class="cc-none">- None</div>';
    const bondsSec = section('bonds', '💚', 'BONDS', 'teal', bondCards);

    // ---- RELATIONSHIPS (teal) — slice 9: Pura-style route cards, rendered from
    // data (no format-law fragility). Stage derives from BOND; trust / likes /
    // dislikes / keepsake / threshold are bookkeeper-maintained, hand-editable.
    const relCards = npcs.length ? npcs.map(c => {
        const r = c.rel || {};
        const bond = Number((c.bonds || {}).user ?? 0);
        const stage = stageOf(c);
        const cold = bond < 0;
        const path = (cold ? COLD_LADDER : WARM_LADDER)
            .map(s => s === stage ? `<span class="cc-rel-here">${esc(s)}</span>` : esc(s))
            .join('<span class="cc-rel-arrow">&gt;</span>');
        const drift = driftOf(c);
        const driftCls = drift === DRIFT_UP ? 'cc-drift-up' : drift === DRIFT_DOWN ? 'cc-drift-down' : 'cc-drift-hold';
        const keepsakeEv = r.keepsake ? findEvent(r.keepsake) : null;
        const keepsakeNote = keepsakeEv ? `<span class="cc-rel-keepsake-text">"${esc(keepsakeEv.what)}"</span>`
            : (r.keepsake ? `<span class="cc-rel-keepsake-text">${esc(r.keepsake)}</span>` : '');
        return `
    <div class="cc-rel-card${r.severed ? ' cc-rel-severed' : ''}" data-cell-id="${esc(c.id)}">
      <div class="cc-rel-head">${esc((c.name || '').toUpperCase())} &harr; USER
        <span class="cc-rel-route">${editable(r.route || '', 'rel-route', 'route')}</span>
        <span class="cc-rel-cond">${editable(r.condition || '', 'rel-condition', 'condition')}</span>
        ${drift ? `<span class="cc-rel-drift ${driftCls}">${esc(drift)}</span>` : ''}
        ${r.severed ? '<span class="cc-rel-sev-badge">💀 SEVERED</span>' : `<button class="cc-x cc-rel-sev-btn" title="Sever this bond — the card retires after this" data-rel-sever="${esc(c.id)}">💀</button>`}
      </div>
      <div class="cc-rel-ladder">${path}${r.stagePin ? ` <span class="cc-rel-pin">${esc(r.stagePin)} 📌 <button class="cc-x" title="Release the tangled stage pin" data-rel-unpin="${esc(c.id)}">♻</button></span>` : ''}</div>
      <div class="cc-rel-row"><span class="cc-bond-label l-bond">HEART: ${esc(String(bond))}</span> <span class="cc-rel-hint">(moves via sparks/grudge only)</span> | <span class="cc-bond-label l-sparks">TRUST: ${editable(String(r.trust ?? 0), 'rel-trust')}</span></div>
      <div class="cc-rel-row">Likes: ${editable((r.likes || []).join(', '), 'rel-likes', 'still a mystery')} | Dislikes: ${editable((r.dislikes || []).join(', '), 'rel-dislikes', 'still a mystery')}</div>
      <div class="cc-rel-row">Keepsake: ${editable(r.keepsake || '', 'rel-keepsake', 'none')} ${keepsakeNote} | Next: ${editable(r.threshold || '', 'rel-threshold', 'no threshold yet')}</div>
    </div>`;
    }).join('') : '<div class="cc-none">- None</div>';
    const relSec = section('relationships', '💞', 'RELATIONSHIPS', 'teal', relCards);

    // ---- QUESTS (purple)
    const questBody = (quests.length ? quests.map(q => `
      <div class="cc-item" data-quest-id="${esc(q.id)}">
        ${line(
            `<b>${esc(q.type || 'Side')}:</b> ${editable(q.name || '', 'quest-name', '—')} — [${editable(q.progress || '', 'quest-progress', 'No active quest')}] | Reward: ${editable(q.reward || '', 'quest-reward', 'N/A')}`
        )}
        <button class="cc-x" data-del-quest="${esc(q.id)}">✖</button>
      </div>`).join('') : '<div class="cc-none">- Main: None — [No active quest] | Progress: N/A | Reward: N/A<br>- Side: None — [No active quest] | Reward: N/A</div>') +
      `<div class="cc-row"><select class="cc-qtype menu_button"><option>Main</option><option>Side</option></select><input class="cc-new text_input" placeholder="New quest…"><button class="cc-plus" data-add-quest="1">＋</button></div>`;
    const questsSec = section('quests', '📜', 'QUESTS', 'purple', questBody);

    // ---- CHEKHOV'S GUN (purple)
    const chLines = (status) => {
        const items = chekhov.filter(c => (c.status || 'active') === status);
        if (!items.length) return 'None';
        return items.map(c => `<span data-chekhov-id="${esc(c.id)}">[${editable(c.text || '', 'chekhov-text')}]` +
            ` (weight: ${editable(String(c.weight ?? 1), 'chekhov-weight')}, age: ${editable(String(c.age ?? 0), 'chekhov-age')}/${esc(String(world.turn || 0))})` +
            `${c.depends ? ` [depends: ${editable(c.depends, 'chekhov-depends')}]` : ''}${c.secret ? ' [secret]' : ''}` +
            `<button class="cc-x" data-del-chekhov="${esc(c.id)}">✖</button></span>`).join('<br>') + '<br>';
    };
    const chBody =
        line(`<b>Active:</b> ${chLines('active')}`) + '<br>' +
        line(`<b>Locked:</b> ${chLines('locked')}`) + '<br>' +
        line(`<b>Fired:</b> ${chLines('fired')}`) +
        `<div class="cc-row"><input class="cc-new text_input" placeholder="New Chekhov plant…"><button class="cc-plus" data-add-chekhov="1">＋</button></div>`;
    const chekhovSec = section('chekhov', '🔫', "CHEKHOV'S GUN", 'purple', chBody);

    // ---- GM'S NOTEBOOK (purple)
    const noteBody = (notes.length ? notes.map(n => `
      <div class="cc-item cc-note" data-note-id="${esc(n.id)}">
        ${line(`<span class="cc-note-type cc-note-${esc(n.type)}">[${esc(n.type)}]</span> ${editable(n.text || '', 'note-text')}`)}
        <button class="cc-x" data-del-note="${esc(n.id)}">✖</button>
      </div>`).join('') : '<div class="cc-none">- [R] No active notes.</div>') +
      `<div class="cc-row"><select class="cc-ntype menu_button"><option value="R">[R]</option><option value="T">[T]</option><option value="D">[D]</option></select><input class="cc-new text_input" placeholder="New note…"><button class="cc-plus" data-add-note="1">＋</button></div>`;
    const notesSec = section('notes', '📓', "GM'S NOTEBOOK", 'purple', noteBody);

    // ---- INTERNAL THOUGHTS (purple)
    const thinkers = npcs.filter(c => (c.thoughts || '').trim());
    const thoughtsBody = thinkers.length ? thinkers.map(c =>
        line(`<b>${esc(c.name)}</b> | ${editable(c.thoughts || '', 'thoughts')}`)
    ).join('<br>') : '<div class="cc-none">- None</div>';
    const thoughtsSec = section('thoughts', '🧠', 'INTERNAL THOUGHTS', 'purple', thoughtsBody);

    // ---- DND TASK SIM (orange)
    const rl = (label, field, val, ph = 'N/A') => line(`<b>${label}:</b> ${editable(val || '', field, ph)}`);
    const dndBody =
        rl('Task', 'roll-task', roll.task) + '<br>' +
        rl('Locked DC', 'roll-dc', roll.dc) + '<br>' +
        rl('User Roll', 'roll-user', roll.user) + ' | ' + rl('NPC Roll', 'roll-npc', roll.npc).slice(2) + ' | ' + rl('Delta', 'roll-delta', roll.delta) + '<br>' +
        rl('Outcome', 'roll-outcome', roll.outcome);
    const dndSec = section('dnd', '🎲', 'DND TASK SIM', 'orange', dndBody);

    // ---- COMBAT (orange)
    const combatBody = line(
        `<b>Mode:</b> ${editable(combat.mode || '', 'combat-mode', 'N/A')} | ` +
        `<b>Engagement:</b> ${editable(combat.engagement || '', 'combat-engagement', 'N/A')} | ` +
        `<b>Wounds:</b> ${editable(combat.wounds || '', 'combat-wounds', 'None')} | ` +
        `<b>Exchange:</b> ${editable(combat.exchange || '', 'combat-exchange', 'N/A')}`
    );
    const combatSec = section('combat', '⚔️', 'COMBAT', 'orange', combatBody);

    // ---- PHYSICS, ENGINE & WORLD (orange)
    const physicsBody =
        line(`<b>Env:</b> ${editable(world.env || '', 'env', '—')}`) + '<br><br>' +
        line(`<b>Physics:</b> ${editable(world.physics || '', 'physics', '—')}`);
    const physicsSec = section('physics', '🌌', 'PHYSICS, ENGINE & WORLD', 'orange', physicsBody);

    // ---- WORLD SIM (orange) — the per-generation d20 fate roll. The roll / table /
    // turn stamp come from the tick engine and are display-only; the narrator-facing
    // Event and Desc are editable (hand edits are the authority, as everywhere else).
    const ws = world.worldsim || null;
    let worldsimBody = ws ? (
        line(`<b>Roll:</b> d20=${esc(String(ws.roll ?? ''))} | Table: ${esc(ws.table || 'standard')} | Turn: ${esc(String(ws.turn ?? ''))}`) + '<br>' +
        line(`<b>Event:</b> ${editable(ws.event || '', 'worldsim-event', '—')}`) + '<br>' +
        line(`<b>Desc:</b> ${editable(ws.desc || '', 'worldsim-desc', '—')}`)
    ) : '<div class="cc-none">- Not rolled yet — rolls happen each generation.</div>';
    worldsimBody += `<div class="cc-row"><button class="menu_button" data-worldsim-reroll="1">🎲 Reroll now</button></div>`;
    const worldsimSec = section('worldsim', '🌎', 'WORLD SIM', 'orange', worldsimBody);

    // ---- USER (purple) — Loreweaver addition: the user's own drawer, separate from the NPCs.
    // The user is not an NPC, so they get their own section (inventory/titles/status/mods)
    // instead of appearing in NPC AGENDAS / NPC LOCATIONS / CAST & TIERS.
    const u = userCell || {};
    // Plain block (not .cc-item — that's a flex row for one-line entries with a
    // delete button; the USER drawer is a multi-line stack and must read as one).
    const userBody = `<div class="cc-user-block" data-user-cell="1">` +
        line(`<b>Inv:</b> ${editable((u.inventory || []).join(', '), 'inventory', 'none')}`) + '<br>' +
        line(`<b>Titles/Skills:</b> ${editable((u.titles || []).join(', '), 'titles', 'none')}`) + '<br>' +
        line(`<b>Status:</b> ${editable(u.status || '', 'status', 'none')}`) + '<br>' +
        line(`<b>Mods:</b> ${editable(u.mods || '', 'mods', 'none')}`) +
        `</div>`;
    const userSec = section('user', '🫵', 'USER', 'purple', userBody);

    // ---- CAST & TIERS (teal) — Loreweaver addition: tier control + membership.
    // A pinned cell shows 📌 and an unpin button (♻) — auto-tiering is not
    // touching it; clicking ♻ releases it back to auto management.
    const castBody = (npcs.length ? npcs.map(c => `
      <div class="cc-item" data-cell-id="${esc(c.id)}">
        ${line(`<b>${esc(c.name)}</b> | tier: <select class="cc-tier-select menu_button" data-field="tier">
          ${['main', 'secondary', 'minor', 'offstage'].map(t => `<option value="${t}" ${c.tier === t ? 'selected' : ''}>${t}</option>`).join('')}
        </select>${c.tierPinned ? ` 📌 <button class="cc-x" title="Release pin — let auto-tiering manage this character again" data-unpin-cell="${esc(c.id)}">♻</button>` : ''}`)}
        <button class="cc-x" data-del-cell="${esc(c.id)}">✖</button>
      </div>`).join('') : '<div class="cc-none">- No characters yet.</div>') +
      `<div class="cc-row"><input class="cc-new text_input" placeholder="New character name…"><button class="cc-plus" data-add-char="1">＋</button></div>`;
    const castSec = section('cast', '👥', 'CAST & TIERS', 'teal', castBody);

    return `
<div class="cc-panel">
  <div class="cc-topbar">🎬 INTERNAL STATES <span class="cc-turn">(TURN: ${esc(String(world.turn || 0))})</span></div>
  ${userSec}
  ${castSec}
  ${agendasSec}
  ${locationsSec}
  ${inventoriesSec}
  ${factionsSec}
  ${bondsSec}
  ${relSec}
  ${questsSec}
  ${chekhovSec}
  ${notesSec}
  ${thoughtsSec}
  ${dndSec}
  ${combatSec}
  ${physicsSec}
  ${worldsimSec}
  ${toolsSection(state)}
</div>`;
}

function escapeHtml(s) {
    return String(s ?? '')
        .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
