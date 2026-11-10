// Character Cells — panel renderer
// Renders the state as the same collapsible <details> look as the FF5 internal-states
// block, but generated from data and editable. One panel, two doors (wand + mes button).

export function renderStateHtml(state) {
    const cells = state.cells || [];
    const world = state.world || { notes: [], time: '', turn: 0 };

    const tiers = { main: [], secondary: [], minor: [], offstage: [] };
    for (const c of cells) (tiers[c.tier] || tiers.minor).push(c);

    const esc = escapeHtml;

    const cellSections = (list, emptyLabel) => {
        if (!list.length) return `<div class="cc-empty">${emptyLabel}</div>`;
        return list.map(c => cellDetails(c, esc)).join('\n');
    };

    return `
<div class="cc-panel">
  <div class="cc-header">🎬 INTERNAL STATES <span class="cc-turn">(Turn: ${esc(String(world.turn || 0))})</span> <span class="cc-time">${esc(world.time || '')}</span></div>

  <details class="cc-world">
    <summary>📓 GM'S NOTEBOOK (${world.notes.length})</summary>
    <div class="cc-body">
      ${world.notes.length ? world.notes.map(n => `
        <div class="cc-note" data-note-id="${esc(n.id)}">
          <span class="cc-note-type cc-note-${esc(n.type)}">[${esc(n.type)}]</span>
          <span class="cc-note-text" contenteditable="true" data-field="note-text">${esc(n.text)}</span>
          <button class="cc-del menu_button" data-del-note="${esc(n.id)}" title="Delete note">✖</button>
        </div>`).join('') : '<div class="cc-empty">- [R] No active notes.</div>'}
      <div class="cc-row">
        <select class="cc-note-new-type menu_button">
          <option value="R">[R] Reminder</option><option value="T">[T] Thread</option><option value="D">[D] Debug</option>
        </select>
        <input class="cc-note-new-text text_input" type="text" placeholder="New note…">
        <button class="cc-add menu_button" data-add-note="1">＋</button>
      </div>
    </div>
  </details>

  <details>
    <summary>👤 CHARACTERS (${cells.length})</summary>
    <div class="cc-body">
      <details class="cc-tier"><summary>🥇 Main (${tiers.main.length})</summary><div class="cc-body">${cellSections(tiers.main, 'No main characters.')}</div></details>
      <details class="cc-tier"><summary>🥈 Secondary (${tiers.secondary.length})</summary><div class="cc-body">${cellSections(tiers.secondary, 'None.')}</div></details>
      <details class="cc-tier"><summary>🥉 Minor (${tiers.minor.length})</summary><div class="cc-body">${cellSections(tiers.minor, 'None.')}</div></details>
      <details class="cc-tier"><summary>💤 Offstage (${tiers.offstage.length})</summary><div class="cc-body">${cellSections(tiers.offstage, 'None.')}</div></details>
      <div class="cc-row">
        <input class="cc-char-new-name text_input" type="text" placeholder="New character name…">
        <button class="cc-add menu_button" data-add-char="1">＋</button>
      </div>
    </div>
  </details>

  <details>
    <summary>🧠 INTERNAL THOUGHTS</summary>
    <div class="cc-body">${cellThoughts(cells, esc)}</div>
  </details>
</div>`;
}

function cellThoughts(cells, esc) {
    const withThoughts = cells.filter(c => (c.thoughts || '').trim());
    if (!withThoughts.length) return '<div class="cc-empty">No active thoughts.</div>';
    return withThoughts.map(c => `
      <div class="cc-thought" data-cell-id="${esc(c.id)}">
        <b>${esc(c.name)}</b> | <span contenteditable="true" data-field="thoughts">${esc(c.thoughts || '')}</span>
      </div>`).join('<br>');
}

function cellDetails(c, esc) {
    const mems = c.memories || [];
    const bond = c.bonds || { user: 0, sparks: 0, grudge: 0 };
    const agenda = c.agenda || { goal: '', step: 0, max: 0, location: '' };
    return `
    <details class="cc-cell" data-cell-id="${esc(c.id)}">
      <summary>
        <span class="cc-cell-name">${esc(c.name)}</span>
        <select class="cc-tier-select menu_button" data-field="tier">
          ${['main', 'secondary', 'minor', 'offstage'].map(t => `<option value="${t}" ${c.tier === t ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
      </summary>
      <div class="cc-body">
        <div class="cc-field"><label>Identity</label><span contenteditable="true" data-field="identity">${esc(c.identity || '')}</span></div>
        <div class="cc-field"><label>Status</label><span contenteditable="true" data-field="status">${esc(c.status || '')}</span></div>
        <div class="cc-field"><label>Agenda</label><span contenteditable="true" data-field="agenda-goal">${esc(agenda.goal || '')}</span></div>
        <div class="cc-field"><label>Step</label><input type="number" class="cc-num" data-field="agenda-step" value="${esc(String(agenda.step || 0))}" min="0"> / <input type="number" class="cc-num" data-field="agenda-max" value="${esc(String(agenda.max || 0))}" min="0"> @ <span contenteditable="true" data-field="agenda-location">${esc(agenda.location || '')}</span></div>
        <div class="cc-field"><label>BOND / Sparks / Grudge</label>
          <input type="number" class="cc-num" data-field="bond-user" value="${esc(String(bond.user ?? 0))}">
          <input type="number" class="cc-num" data-field="bond-sparks" value="${esc(String(bond.sparks ?? 0))}">
          <input type="number" class="cc-num" data-field="bond-grudge" value="${esc(String(bond.grudge ?? 0))}">
        </div>
        <div class="cc-field"><label>Inventory</label><span contenteditable="true" data-field="inventory">${esc((c.inventory || []).join(', '))}</span></div>
        <div class="cc-field"><label>Titles</label><span contenteditable="true" data-field="titles">${esc((c.titles || []).join(', '))}</span></div>
        <div class="cc-field"><label>Archetype</label><span contenteditable="true" data-field="archetype">${esc(c.archetype || '')}</span></div>
        <details class="cc-memories"><summary>🧠 Memories (${mems.length})</summary>
          <div class="cc-body">
            ${mems.length ? mems.map(m => `
              <div class="cc-memory" data-mem-id="${esc(m.id)}">
                <span class="cc-mem-imp" title="Importance">${'●'.repeat(m.importance || 1)}</span>
                <span class="cc-mem-text" contenteditable="true" data-field="mem-text">${esc(m.what)}</span>
                <span class="cc-mem-witness">👁 ${esc((m.witnesses || []).join(', ') || '—')}</span>
                <span class="cc-mem-turn">#${esc(String(m.turn ?? '?'))}</span>
                <button class="cc-del menu_button" data-del-mem="${esc(m.id)}" title="Forget memory">✖</button>
              </div>`).join('') : '<div class="cc-empty">No memories.</div>'}
          </div>
        </details>
        <button class="cc-del menu_button cc-del-cell" data-del-cell="${esc(c.id)}" title="Remove character from state">Remove character</button>
      </div>
    </details>`;
}

function escapeHtml(s) {
    return String(s ?? '')
        .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
