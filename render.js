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
    return `<span class="cc-ed" contenteditable="true" data-field="${field}" data-ph="${esc(placeholder)}">${esc(value)}</span>`;
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
    <div class="cc-tools-row">
      <button class="menu_button" data-cc-repair="1">Repair internal states</button>
      <div class="cc-tools-note">One bookkeeper audit call: compares the tracked state against the cards, the lorebook and the last 6 messages, and emits only the commands that fix drift — fills missed drawers, corrects bad values. Use whenever the state looks stale and you don't want to reset it.</div>
    </div>
    <div class="cc-tools-row">
      <button class="menu_button" data-cc-reset="1">Reset internal states</button>
      <div class="cc-tools-note">Wipes ALL tracked state for THIS chat — cells, ledger, memories, turn counter, dice, world sim, digests — and starts from zero. Chat messages are untouched. Cannot be undone.</div>
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

    // ---- CHARACTERS (teal) — ONE card per NPC: tier + agenda + location + body +
    // knowledge + inventory. Replaces the old NPC AGENDAS / LOCATIONS / INVENTORIES /
    // CAST sections (same data, one place). The card carries data-cell-id so every
    // edit inside it routes to the right cell.
    const fld = (label, inner, wide = false) =>
        '<div class="cc-f' + (wide ? ' cc-f-wide' : '') + '"><span class="cc-fl">' + label + '</span><span class="cc-fv">' + inner + '</span></div>';
    const castCards = npcs.length ? npcs.map(c => {
        const a = c.agenda || {};
        return '<div class="cc-card" data-cell-id="' + esc(c.id) + '">' +
          '<div class="cc-card-head"><span class="cc-card-name">' + esc(c.name) + '</span>' +
            '<span class="cc-card-tools"><select class="cc-tier-select menu_button" data-field="tier" title="Tier — changing it pins the character">' +
              ['main', 'secondary', 'minor', 'offstage'].map(t => '<option value="' + t + '"' + (c.tier === t ? ' selected' : '') + '>' + t + '</option>').join('') +
            '</select>' +
            (c.tierPinned ? '<span title="Tier pinned — auto-tiering is off for this character">📌</span><button class="cc-x" title="Release pin — let auto-tiering manage this character again" data-unpin-cell="' + esc(c.id) + '">♻</button>' : '') +
            '<button class="cc-x" title="Delete character" data-del-cell="' + esc(c.id) + '">✖</button></span></div>' +
          '<div class="cc-grid">' +
            fld('Agenda', editable(a.goal || '', 'agenda-goal', 'no agenda'), true) +
            fld('Step', editable(String(a.step ?? 0), 'agenda-step') + ' <span class="cc-sep">/</span> ' + editable(String(a.max ?? 0), 'agenda-max')) +
            fld('Location', editable(a.location || '', 'agenda-location', 'unknown')) +
            fld('Body', editable(c.status || '', 'status', 'healthy')) +
            fld('Inventory', editable((c.inventory || []).join(', '), 'inventory', 'nothing'), true) +
            fld('Aware of', editable((c.aware || []).join(', '), 'aware', 'nothing'), true) +
            fld('Fibs', editable(c.fibs || '', 'fibs', 'none')) +
            fld('Circle', editable((c.circle || []).join(', '), 'circle', 'none')) +
          '</div></div>';
    }).join('') : '<div class="cc-none">No characters yet.</div>';
    const castBody = castCards +
      '<div class="cc-row"><input class="cc-new text_input" placeholder="New character name…"><button class="cc-plus" data-add-char="1">＋</button></div>';
    const castSec = section('cast', '👥', 'CHARACTERS (' + npcs.length + ')', 'teal', castBody);

    // ---- FACTIONS (teal) — families, crews, organisations. One card each.
    const facBody = (factions.length ? factions.map(f =>
      '<div class="cc-card" data-faction-id="' + esc(f.id) + '">' +
        '<div class="cc-card-head"><span class="cc-card-name">' + editable(f.name || '', 'faction-name', 'Name') + '</span>' +
          '<span class="cc-card-tools"><button class="cc-x" title="Delete faction" data-del-faction="' + esc(f.id) + '">✖</button></span></div>' +
        '<div class="cc-grid">' +
          fld('Goal', editable(f.goal || '', 'faction-goal', '—'), true) +
          fld('State', editable(f.fstate || '', 'faction-state', '—')) +
          fld('Conflict', editable(f.conflict || '', 'faction-conflict', 'none')) +
          fld('Intel', editable(f.intel || '', 'faction-intel', 'none'), true) +
          fld('Fibs', editable(f.fibs || '', 'faction-fibs', 'none')) +
          fld('Relations', editable(f.relations || '', 'faction-relations', 'none')) +
          fld('Witnesses', editable((f.witnesses || []).join(', '), 'faction-witnesses', 'none'), true) +
        '</div></div>').join('') : '<div class="cc-none">No factions yet — families, crews and organisations show up here once the story establishes them.</div>') +
      '<div class="cc-row"><input class="cc-new text_input" placeholder="New faction name…"><button class="cc-plus" data-add-faction="1">＋</button></div>';
    const factionsSec = section('factions', '🚩', 'FACTIONS (' + factions.length + ')', 'teal', facBody);

    // ---- RELATIONSHIPS (teal) — one card per NPC: route/condition chips, stage
    // ladder, the three bars (BOND / SPARKS / GRUDGE — the old separate BONDS
    // section lived here too), trust, likes, keepsake. Stage derives from BOND.
    const bar = (label, cls, fcls, field, v, pctVal) =>
      '<div class="cc-bond-row"><span class="cc-bond-label ' + cls + '">' + label + ' ' + editable(String(v), field) + '</span>' +
      '<div class="cc-track"><div class="cc-fill ' + fcls + '" style="width:' + pctVal + '%"></div></div></div>';
    const pct = (v, min, max) => Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100));
    const relCards = npcs.length ? npcs.map(c => {
        const r = c.rel || {};
        const b = c.bonds || {};
        const bond = Number(b.user ?? 0), sparks = Number(b.sparks ?? 0), grudge = Number(b.grudge ?? 0);
        const stage = stageOf(c);
        const cold = bond < 0;
        const path = (cold ? COLD_LADDER : WARM_LADDER)
            .map(s => '<span class="cc-step' + (s === stage ? ' cc-rel-here' : '') + '">' + esc(s) + '</span>')
            .join('');
        const drift = driftOf(c);
        const driftCls = drift === DRIFT_UP ? 'cc-drift-up' : drift === DRIFT_DOWN ? 'cc-drift-down' : 'cc-drift-hold';
        const keepsakeEv = r.keepsake ? findEvent(r.keepsake) : null;
        const keepsakeNote = keepsakeEv ? '<div class="cc-rel-keepsake-text">"' + esc(keepsakeEv.what) + '"</div>' : '';
        return '<div class="cc-rel-card' + (r.severed ? ' cc-rel-severed' : '') + '" data-cell-id="' + esc(c.id) + '">' +
          '<div class="cc-rel-head"><span class="cc-card-name">' + esc(c.name) + ' <span class="cc-arrow">&harr;</span> You</span>' +
            '<span class="cc-chip">' + editable(r.route || '', 'rel-route', 'route') + '</span>' +
            '<span class="cc-chip">' + editable(r.condition || '', 'rel-condition', 'condition') + '</span>' +
            (drift ? '<span class="cc-rel-drift ' + driftCls + '">' + esc(drift) + '</span>' : '') +
            (r.severed ? '<span class="cc-rel-sev-badge">💀 SEVERED</span>'
                : '<button class="cc-x cc-rel-sev-btn" title="Sever this bond — the card retires after this" data-rel-sever="' + esc(c.id) + '">💀</button>') +
          '</div>' +
          '<div class="cc-rel-ladder">' + path + (r.stagePin ? '<span class="cc-rel-pin">' + esc(r.stagePin) + ' 📌 <button class="cc-x" title="Release the tangled stage pin" data-rel-unpin="' + esc(c.id) + '">♻</button></span>' : '') + '</div>' +
          bar('BOND', bond < 0 ? 'l-bond-neg' : 'l-bond', bond < 0 ? 'f-bond-neg' : 'f-bond', 'bond-user', bond, bond < 0 ? pct(-bond, 0, 5) : pct(bond, 0, 20)) +
          bar('SPARKS', 'l-sparks', 'f-sparks', 'bond-sparks', sparks, pct(sparks, 0, 15)) +
          bar('GRUDGE', 'l-grudge', 'f-grudge', 'bond-grudge', grudge, pct(grudge, 0, 10)) +
          '<div class="cc-grid cc-rel-grid">' +
            fld('Trust', editable(String(r.trust ?? 0), 'rel-trust')) +
            fld('Keepsake', editable(r.keepsake || '', 'rel-keepsake', 'none')) +
            fld('Likes', editable((r.likes || []).join(', '), 'rel-likes', 'still a mystery'), true) +
            fld('Dislikes', editable((r.dislikes || []).join(', '), 'rel-dislikes', 'still a mystery'), true) +
            fld('Next', editable(r.threshold || '', 'rel-threshold', 'no threshold yet'), true) +
          '</div>' + keepsakeNote +
        '</div>';
    }).join('') : '<div class="cc-none">No characters yet.</div>';
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
        `<div class="cc-item" data-cell-id="${esc(c.id)}">` + line(`<b>${esc(c.name)}</b> | ${editable(c.thoughts || '', 'thoughts')}`) + '</div>'
    ).join('') : '<div class="cc-none">- None</div>';
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

    return `
<div class="cc-panel">
  <div class="cc-topbar">🎬 INTERNAL STATES <span class="cc-turn">(TURN: ${esc(String(world.turn || 0))})</span></div>
  ${castSec}
  ${relSec}
  ${factionsSec}
  ${userSec}
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
