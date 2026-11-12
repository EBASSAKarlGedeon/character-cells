// Character Cells — settings + Event Ledger browser (Extensions panel block)
// A permanent inline-drawer block in the Extensions settings panel (the same
// UI family as Summaryception's snippet browser). Top: the bookkeeper profile
// dropdown — the Connection Manager profile all cheap calls (bookkeeper,
// backfill, digests) ride without switching the narrator's connection.
// Below: the immutable event ledger — filter by character / importance / text;
// edit `what`, importance and witnesses inline; delete; add. The ledger is
// never auto-pruned — this browser is the only place an event can be removed,
// and only by hand.

import { eventSource, event_types, saveChatDebounced, name1 } from '../../../../script.js';
import { getState, getLedger, findCell, slug, addEvent } from './state.js';
import { updateInjection } from './inject.js';
import { getSettings, persistSettings } from './settings.js';
import { setBookkeeperEnabled } from './bookkeeper.js';
import { AUTO_CREATE_CAP } from './commands.js';
import { LOG_PREFIX } from './config.js';

let ConnectionManagerRequestService = null;
try {
    ({ ConnectionManagerRequestService } = await import('../../shared.js'));
} catch { /* Connection Manager not installed — dropdown shows a note instead */ }

let $container = null;
let filter = { text: '', who: '', imp: '' };

/** Human label for one event's tier info (landmark / recent / digest candidate). */
function ageLabel(ev, currentTurn) {
    const age = currentTurn - (Number(ev.turn) || 0);
    if (ev.importance >= 3) return 'landmark';
    if (age <= 40) return 'recent';
    return 'cold';
}


function escHtml(s) {
    return String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/** Rows for the visible events — stacked layout (id/age/delete on top, text, then meta). */
function rowsHtml(shown, ledgerTotal, currentTurn) {
    if (!shown.length) return '<div class="cc-ledger-none">No events match. (Ledger total: ' + ledgerTotal + ')</div>';
    return shown.map(e => {
        const who = (e.witnesses || []).map(w => findCell(w)?.name || w).join(', ') || 'nobody';
        const age = ageLabel(e, currentTurn);
        return `
      <div class="cc-ledger-row" data-ev-id="${escHtml(e.id)}">
        <div class="cc-ledger-top">
          <span class="cc-ledger-id">[${escHtml(e.id)}]</span>
          <span class="cc-ledger-age cc-age-${age}">${age}</span>
          <button class="cc-ledger-del" title="Delete this event (manual only — the ledger is never auto-pruned)" data-ev-del="${escHtml(e.id)}">✖</button>
        </div>
        <div class="cc-ledger-what" contenteditable="true" data-ev-field="what">${escHtml(e.what)}</div>
        <div class="cc-ledger-meta">
          imp <span contenteditable="true" data-ev-field="imp">${escHtml(e.importance)}</span> ·
          turn <span contenteditable="true" data-ev-field="turn">${escHtml(e.turn)}</span> ·
          witnesses <span contenteditable="true" data-ev-field="witnesses">${escHtml(who)}</span>
        </div>
      </div>`;
    }).join('');
}

function render() {
    if (!$container) return;
    const state = getState();
    const ledger = getLedger();
    const currentTurn = Number(state.world.turn) || 0;

    // -- filters
    const whoOptions = state.cells.map(c => `<option value="${c.id}" ${filter.who === c.id ? 'selected' : ''}>${c.name}${c.fixed ? ' (user)' : ''}</option>`).join('');
    const shown = ledger.filter(e => {
        if (filter.imp && e.importance !== Number(filter.imp)) return false;
        if (filter.who && !(e.witnesses || []).includes(filter.who)) return false;
        if (filter.text && !e.what.toLowerCase().includes(filter.text.toLowerCase())) return false;
        return true;
    });

    const rows = rowsHtml(shown, ledger.length, currentTurn);

    $container.html(`
    <div class="character_cells_settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b data-i18n="Character Cells">Character Cells</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <div class="cc-bk-profile">
            <label for="cc_bk_profile">Bookkeeper connection profile <span class="cc-bk-profile-note">(cheap model for state updates, backfill & digests — does not change your active connection)</span></label>
            ${ConnectionManagerRequestService
                ? `<select id="cc_bk_profile"></select>`
                : `<div class="cc-bk-profile-note">Connection Manager extension is not available — cheap calls use the active connection.</div>`}
          </div>
          <div class="cc-bk-profile">
            <label for="cc_set_maxtokens">Profile max tokens <span class="cc-bk-profile-note">(sent as max_tokens on every bookkeeper-profile call; reasoning models spend it on thinking before the answer — default 32000)</span></label>
            <input id="cc_set_maxtokens" type="number" class="text_pole" min="256" max="200000" step="1000" value="${getSettings().profileMaxTokens}">
          </div>
          <div class="cc-bk-toggles">
            <label class="cc-bk-toggle"><input type="checkbox" id="cc_set_bookkeeper" ${getSettings().bookkeeperEnabled ? 'checked' : ''}> Bookkeeper state tracking (auto-updates state after each reply)</label>
            <label class="cc-bk-toggle"><input type="checkbox" id="cc_set_chattables" ${getSettings().chatTables !== false ? 'checked' : ''}> Show the internal-states table under the latest AI message (display only — never sent to the model)</label>
            <label class="cc-bk-toggle"><input type="checkbox" id="cc_set_autocells" ${getSettings().bookkeeperAutoCells !== false ? 'checked' : ''}> Auto-create characters, factions & quests (max ${AUTO_CREATE_CAP} per turn)</label>
          </div>
          <div class="cc-ledger-summary">
            ${ledger.length} event(s) · turn ${currentTurn} · shown: ${shown.length}
            — the ledger is immutable; this browser is for inspection and <i>manual</i> fixes only.
          </div>
          <div class="cc-ledger-filters">
            <input id="cc_ledger_filter_text" class="text_input" placeholder="Filter text…" value="${filter.text}">
            <select id="cc_ledger_filter_who" class="text_input"><option value="">all characters</option>${whoOptions}</select>
            <select id="cc_ledger_filter_imp" class="text_input">
              <option value="">all importance</option>
              ${[1, 2, 3].map(i => `<option value="${i}" ${filter.imp == i ? 'selected' : ''}>imp ${i}${i === 3 ? ' (landmark)' : ''}</option>`).join('')}
            </select>
          </div>
          <div class="cc-ledger-list">${rows}</div>
          <div class="cc-ledger-add">
            <input id="cc_ledger_add_what" class="text_input" placeholder='New event: "what happened"…'>
            <input id="cc_ledger_add_who" class="text_input" placeholder="witnesses (comma-separated names)">
            <select id="cc_ledger_add_imp" class="text_input"><option value="1">imp 1</option><option value="2">imp 2</option><option value="3">imp 3 (landmark)</option></select>
            <button id="cc_ledger_add_btn" class="menu_button">Add event</button>
          </div>
        </div>
      </div>
    </div>`);
}

/** Rebuild if visible; keep filter inputs focused value intact. */
function refresh() {
    if (!$container || !$container.is(':visible') && !$container.parents('.drawer-content').hasClass('openDrawer')) {
        // Still cheap to re-render; the drawer content is hidden anyway.
    }
    render();
}

function bind() {
    // drawer toggle is handled by ST's global inline-drawer handler

    $container.on('change', '#cc_set_bookkeeper', function () {
        setBookkeeperEnabled($(this).prop('checked'));
    });
    $container.on('change', '#cc_set_chattables', function () {
        getSettings().chatTables = $(this).prop('checked');
        persistSettings();
        import('./chat-table.js').then(m => m.renderChatTable());
    });
    $container.on('change', '#cc_set_maxtokens', function () {
        const v = Math.round(Number($(this).val()));
        getSettings().profileMaxTokens = v >= 256 ? v : 32000;
        $(this).val(getSettings().profileMaxTokens);
        persistSettings();
    });
    $container.on('change', '#cc_set_autocells', function () {
        getSettings().bookkeeperAutoCells = $(this).prop('checked');
        persistSettings();
    });

    $container.on('input', '#cc_ledger_filter_text', function () {
        filter.text = $(this).val();
        updateList();
    });
    $container.on('change', '#cc_ledger_filter_who', function () {
        filter.who = $(this).val();
        updateList();
    });
    $container.on('change', '#cc_ledger_filter_imp', function () {
        filter.imp = $(this).val();
        updateList();
    });

    // inline edits
    $container.on('blur', '[data-ev-field]', function () {
        const $el = $(this);
        const field = $el.data('ev-field');
        const value = $el.text().trim();
        const id = $el.closest('[data-ev-id]').data('ev-id');
        const ev = getLedger().find(e => e.id === id);
        if (!ev) return;
        let changed = false;
        if (field === 'what' && value && value !== ev.what) { ev.what = value; changed = true; }
        if (field === 'imp') { const n = Math.max(1, Math.min(3, Number(value) || 1)); if (n !== ev.importance) { ev.importance = n; changed = true; } }
        if (field === 'turn') { const n = Number(value) || 0; if (n !== ev.turn) { ev.turn = n; changed = true; } }
        if (field === 'witnesses') {
            // resolve names to cell ids; unknown names kept as-is? No: dropped, with a console note
            const state = getState();
            const parts = value.split(',').map(s => s.trim()).filter(Boolean);
            const ids = [];
            for (const p of parts) {
                const t = p.toLowerCase();
                const c = state.cells.find(x => x.id === t) || state.cells.find(x => x.name.toLowerCase() === t) || state.cells.find(x => slug(x.name) === t);
                if (c) ids.push(c.id);
                else console.warn(`${LOG_PREFIX} ledger browser: witness "${p}" matched no cell — dropped`);
            }
            if (JSON.stringify(ids) !== JSON.stringify(ev.witnesses)) { ev.witnesses = ids; changed = true; }
        }
        if (changed) { saveChatDebounced(); updateInjection(); }
    });

    $container.on('click', '[data-ev-del]', function () {
        const id = String($(this).data('ev-del'));
        const ledger = getLedger();
        const i = ledger.findIndex(e => e.id === id);
        if (i >= 0) {
            ledger.splice(i, 1);
            console.log(`${LOG_PREFIX} ledger browser: deleted event ${id} (manual)`);
            saveChatDebounced(); updateInjection(); updateList();
        }
    });

    $container.on('click', '#cc_ledger_add_btn', function () {
        const what = $('#cc_ledger_add_what').val().trim();
        const whoRaw = $('#cc_ledger_add_who').val().trim();
        const imp = Number($('#cc_ledger_add_imp').val()) || 1;
        if (!what) return;
        const state = getState();
        const ids = [];
        for (const p of whoRaw.split(',').map(s => s.trim()).filter(Boolean)) {
            const t = p.toLowerCase();
            const c = state.cells.find(x => x.id === t) || state.cells.find(x => x.name.toLowerCase() === t) || state.cells.find(x => slug(x.name) === t);
            if (c) ids.push(c.id);
        }
        if (!ids.length) { toastr.warning('No valid witness name given.', 'Character Cells'); return; }
        addEvent(what, ids, Number(state.world.turn) || 0, imp);
        saveChatDebounced(); updateInjection();
        $('#cc_ledger_add_what').val(''); $('#cc_ledger_add_who').val('');
        updateList();
    });
}

/** Refresh ONLY the dynamic parts (summary, witness options, list) inside
 * the already-mounted drawer. Never touch the drawer frame: replacing it
 * would reset ST's inline-drawer toggle state and collapse it mid-use. */
function updateList() {
    if (!$container) return;
    const state = getState();
    const ledger = getLedger();
    const currentTurn = Number(state.world.turn) || 0;

    const whoOptions = state.cells.map(c => `<option value="${c.id}" ${filter.who === c.id ? 'selected' : ''}>${c.name}${c.fixed ? ' (user)' : ''}</option>`).join('');
    $container.find('#cc_ledger_filter_who').html(`<option value="">all characters</option>${whoOptions}`);

    const shown = ledger.filter(e => {
        if (filter.imp && e.importance !== Number(filter.imp)) return false;
        if (filter.who && !(e.witnesses || []).includes(filter.who)) return false;
        if (filter.text && !e.what.toLowerCase().includes(filter.text.toLowerCase())) return false;
        return true;
    });

    $container.find('.cc-ledger-summary').html(`
            ${ledger.length} event(s) · turn ${currentTurn} · shown: ${shown.length}
            — the ledger is immutable; this browser is for inspection and <i>manual</i> fixes only.`);

    const rows = rowsHtml(shown, ledger.length, currentTurn);
    $container.find('.cc-ledger-list').html(rows);
}

/** Wire the bookkeeper profile dropdown via the Connection Manager's own
 * helper: it lists supported profiles, groups them by API type and keeps
 * itself updated when profiles are created/edited/deleted. Selection is
 * persisted in extension settings (empty = active connection). */
function initProfileDropdown() {
    if (!ConnectionManagerRequestService) return;
    const settings = getSettings();
    try {
        ConnectionManagerRequestService.handleDropdown(
            '#cc_bk_profile',
            settings.bookkeeperProfileId || '',
            (profile) => {
                settings.bookkeeperProfileId = profile?.id || '';
                persistSettings();
                console.log(`${LOG_PREFIX} bookkeeper profile: ${profile ? `"${profile.name}"` : '(none — active connection)'}`);
            },
        );
    } catch (err) {
        console.warn(`${LOG_PREFIX} profile dropdown failed to mount:`, err);
        $container.find('#cc_bk_profile').replaceWith(
            '<div class="cc-bk-profile-note">Could not load the profile list — cheap calls use the active connection.</div>');
    }
}

/** Mount into the Extensions panel (extensions_settings2 column). */
export function initLedgerBrowser() {
    $container = $('<div id="character_cells_container" class="extension_container"></div>');
    $('#extensions_settings2').append($container);
    render();
    initProfileDropdown();
    bind();
    // Re-render when the chat changes (ledger belongs to the chat)
    eventSource.on(event_types.CHAT_CHANGED, updateList);
    console.log(`${LOG_PREFIX} ledger browser mounted`);
}
