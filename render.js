// Character Cells — panel renderer
// Mimics the FF5 internal-states block VERBATIM: flat stack of colored section
// bars (teal/purple/orange groups), dense "Name | Field: value" lines, and
// BOND progress-bar cards. Generated from state data; values are editable inline.

const esc = escapeHtml;

/** A dense "- <b>Label:</b> value | ..." line with editable value slots. */
function line(parts) {
    return `- ${parts}`;
}

function editable(value, field, placeholder = '') {
    return `<span class="cc-ed" contenteditable="true" data-field="${field}" data-ph="${esc(placeholder)}">${esc(value) || placeholder}</span>`;
}

function section(id, icon, title, group, bodyHtml, open = true) {
    return `
<details class="cc-sec cc-${group}" data-sec="${id}" ${open ? 'open' : ''}>
  <summary>${icon} ${esc(title)}</summary>
  <div class="cc-sec-body">${bodyHtml}</div>
</details>`;
}

export function renderStateHtml(state) {
    const world = state.world || {};
    const cells = state.cells || [];
    const userCell = cells.find(c => c.id === 'user');
    const npcs = cells.filter(c => c.id !== 'user');
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

    // ---- INV & SKILLS (purple) — the user's personal cell (FF5 scope)
    const u = userCell || {};
    const invBody =
        line(`<b>Inv:</b> ${editable((u.inventory || []).join(', '), 'inventory', 'none')}`) + '<br>' +
        line(`<b>Titles/Skills:</b> ${editable((u.titles || []).join(', '), 'titles', 'none')}`) + '<br>' +
        line(`<b>Status:</b> ${editable(u.status || '', 'status', 'none')}`) + '<br>' +
        line(`<b>Mods:</b> ${editable(u.mods || '', 'mods', 'none')}`);
    const invSec = section('inv', '🎒', 'INV & SKILLS', 'purple', invBody);

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

    // ---- CAST & TIERS (teal) — Loreweaver addition: tier control + membership
    const castBody = (npcs.length ? npcs.map(c => `
      <div class="cc-item" data-cell-id="${esc(c.id)}">
        ${line(`<b>${esc(c.name)}</b> | tier: <select class="cc-tier-select menu_button" data-field="tier">
          ${['main', 'secondary', 'minor', 'offstage'].map(t => `<option value="${t}" ${c.tier === t ? 'selected' : ''}>${t}</option>`).join('')}
        </select>`)}
        <button class="cc-x" data-del-cell="${esc(c.id)}">✖</button>
      </div>`).join('') : '<div class="cc-none">- No characters yet.</div>') +
      `<div class="cc-row"><input class="cc-new text_input" placeholder="New character name…"><button class="cc-plus" data-add-char="1">＋</button></div>`;
    const castSec = section('cast', '👥', 'CAST & TIERS', 'teal', castBody);

    return `
<div class="cc-panel">
  <div class="cc-topbar">🎬 INTERNAL STATES <span class="cc-turn">(TURN: ${esc(String(world.turn || 0))})</span></div>
  ${agendasSec}
  ${locationsSec}
  ${factionsSec}
  ${bondsSec}
  ${questsSec}
  ${invSec}
  ${chekhovSec}
  ${notesSec}
  ${thoughtsSec}
  ${dndSec}
  ${combatSec}
  ${physicsSec}
  ${castSec}
</div>`;
}

function escapeHtml(s) {
    return String(s ?? '')
        .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
