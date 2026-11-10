// Character Cells extension — Loreweaver
// Slice 1: state store + drawer panel (internal-states look, editable) + slash commands.
// State lives in chat_metadata so it saves/syncs with the chat. See docs/CHARACTER-CELLS-SPEC.md.

import { getContext, extension_settings, renderExtensionTemplateAsync } from '../../extensions.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../slash-commands/SlashCommandArgument.js';
import { saveChatDebounced, eventSource, event_types } from '../../../script.js';
import { getState, addCell, findCell, setTier, removeCell, addMemory, stateStats } from './state.js';
import { renderStateHtml } from './render.js';

const MODULE_NAME = 'character_cells';

// ---------------------------------------------------------------- panel

function openPanel() {
    const state = getState();
    const html = renderStateHtml(state);
    const dlg = $('#cc_dialog');
    if (dlg.length) dlg.remove();
    $('<div id="cc_dialog" class="dialog-popup wide_dialogs_popup"><div class="cc-dialog-inner"></div></div>')
        .appendTo('body');
    $('#cc_dialog .cc-dialog-inner').html(html);
    bindPanelEvents($('#cc_dialog'));
    $('#cc_dialog').dialog({
        title: 'Character Cells — Internal States',
        width: 620,
        height: 700,
        modal: false,
        resizable: true,
        close: () => { $('#cc_dialog').remove(); },
    });
}

function refreshPanelIfOpen() {
    const dlg = $('#cc_dialog');
    if (!dlg.length) return;
    dlg.find('.cc-dialog-inner').html(renderStateHtml(getState()));
    bindPanelEvents(dlg);
}

// ---------------------------------------------------------------- editing

function bindPanelEvents($root) {
    $root.off('.cc').on('change.cc', '[data-field]', function () {
        const $el = $(this);
        const field = $el.data('field');
        const value = $el.is('[contenteditable]') ? $el.text().trim() : $el.val();
        applyField($el, field, value);
        saveChatDebounced();
    });

    $root.on('click.cc', '[data-del-cell]', function () {
        removeCell($(this).data('del-cell'));
        refreshPanelIfOpen();
        saveChatDebounced();
    });

    $root.on('click.cc', '[data-del-mem]', function () {
        const memId = String($(this).data('del-mem'));
        const cellId = $(this).closest('.cc-cell').data('cell-id');
        const cell = findCell(cellId);
        if (cell) {
            cell.memories = cell.memories.filter(m => m.id !== memId);
            refreshPanelIfOpen();
            saveChatDebounced();
        }
    });

    $root.on('click.cc', '[data-del-note]', function () {
        const noteId = String($(this).data('del-note'));
        const world = getState().world;
        world.notes = world.notes.filter(n => n.id !== noteId);
        refreshPanelIfOpen();
        saveChatDebounced();
    });

    $root.on('click.cc', '[data-add-char]', function () {
        const $inp = $root.find('.cc-char-new-name');
        const name = $inp.val().trim();
        if (name) { addCell(name, 'minor'); $inp.val(''); refreshPanelIfOpen(); saveChatDebounced(); }
    });

    $root.on('click.cc', '[data-add-note]', function () {
        const type = $root.find('.cc-note-new-type').val();
        const $inp = $root.find('.cc-note-new-text');
        const text = $inp.val().trim();
        if (text) {
            getState().world.notes.push({ id: 'n' + Date.now().toString(36), type, text });
            $inp.val(''); refreshPanelIfOpen(); saveChatDebounced();
        }
    });
}

/** Route a field edit from the panel back into the state object. */
function applyField($el, field, value) {
    const state = getState();
    const $cell = $el.closest('[data-cell-id]');
    const cellId = $cell.data('cell-id');
    const cell = cellId ? findCell(cellId) : null;
    const num = v => (isNaN(Number(v)) ? 0 : Number(v));

    switch (field) {
        case 'tier': if (cell) cell.tier = value; break;
        case 'identity': if (cell) cell.identity = value; break;
        case 'status': if (cell) cell.status = value; break;
        case 'archetype': if (cell) cell.archetype = value; break;
        case 'agenda-goal': if (cell) cell.agenda.goal = value; break;
        case 'agenda-step': if (cell) cell.agenda.step = num(value); break;
        case 'agenda-max': if (cell) cell.agenda.max = num(value); break;
        case 'agenda-location': if (cell) cell.agenda.location = value; break;
        case 'bond-user': if (cell) cell.bonds.user = num(value); break;
        case 'bond-sparks': if (cell) cell.bonds.sparks = num(value); break;
        case 'bond-grudge': if (cell) cell.bonds.grudge = num(value); break;
        case 'inventory': if (cell) cell.inventory = value.split(',').map(s => s.trim()).filter(Boolean); break;
        case 'titles': if (cell) cell.titles = value.split(',').map(s => s.trim()).filter(Boolean); break;
        case 'thoughts': if (cell) cell.thoughts = value; break;
        case 'note-text': {
            const noteId = String($el.closest('[data-note-id]').data('note-id'));
            const note = state.world.notes.find(n => n.id === noteId);
            if (note) note.text = value;
            break;
        }
    }
}

// ---------------------------------------------------------------- buttons

function addWandButton() {
    const buttonHtml = `
        <div id="character_cells_open" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-users-viewfinder extensionsMenuExtensionButton" /></div>` +
        'Character Cells' +
        '</div>';
    $('#extensionsMenu').append(buttonHtml);
    $('#character_cells_open').on('click', openPanel);
}

function addMessageButton() {
    // One click from chat: state icon in every message's actions row.
    const icon = '<div title="Character Cells" class="mes_button mes_cc_state fa-solid fa-users-viewfinder" data-i18n="[title]Character Cells"></div>';
    $('#chat').on('click', '.mes_cc_state', function () {
        openPanel();
    });
    // Append the icon to each message's extra actions row (shown under the "…" menu).
    const observer = new MutationObserver(() => {
        $('#chat .mes_buttons .extraMesButtons').each(function () {
            if (!$(this).find('.mes_cc_state').length) $(this).append(icon);
        });
    });
    observer.observe(document.getElementById('chat'), { childList: true, subtree: true });
}

// ---------------------------------------------------------------- events

function initEventHandlers() {
    // When a chat loads/changes, nothing to do eagerly — state is read lazily from chat_metadata.
    eventSource.on(event_types.CHAT_CHANGED, () => {
        refreshPanelIfOpen();
    });
}

// ---------------------------------------------------------------- slash commands

function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'cc-state',
        aliases: ['cells'],
        helpString: 'Open the Character Cells panel.',
        callback: () => { openPanel(); return ''; },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'cc-add',
        helpString: 'Add a character to the state. Usage: /cc-add name=Kael tier=main',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'name', description: 'character name', typeList: [ARGUMENT_TYPE.STRING], isRequired: true,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'tier', description: 'main / secondary / minor / offstage',
                typeList: [ARGUMENT_TYPE.ENUM],
                enumList: ['main', 'secondary', 'minor', 'offstage'],
                defaultValue: 'minor',
            }),
        ],
        callback: (_args, _value) => {
            const name = String(_args.name ?? '').trim();
            if (!name) return 'Usage: /cc-add name=Kael tier=main';
            const tier = String(_args.tier ?? 'minor');
            const cell = addCell(name, tier);
            saveChatDebounced();
            return `Added/updated ${cell.name} (${cell.tier})`;
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'cc-promote',
        helpString: 'Promote a character one tier (offstage→minor→secondary→main). Usage: /cc-promote Kael',
        positionalArgumentList: [SlashCommandArgument.fromProps({
            description: 'character name', typeList: [ARGUMENT_TYPE.STRING], isRequired: true,
        })],
        callback: (_args, name) => {
            const ladder = ['offstage', 'minor', 'secondary', 'main'];
            const cell = findCell(slugOf(name)) || findCell(slugOf(String(name)));
            if (!cell) return `No character "${name}" in state. Use /cc-add first.`;
            const i = ladder.indexOf(cell.tier);
            cell.tier = ladder[Math.min(i + 1, ladder.length - 1)];
            saveChatDebounced();
            return `${cell.name} promoted to ${cell.tier}`;
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'cc-demote',
        helpString: 'Demote a character one tier. Usage: /cc-demote Kael',
        positionalArgumentList: [SlashCommandArgument.fromProps({
            description: 'character name', typeList: [ARGUMENT_TYPE.STRING], isRequired: true,
        })],
        callback: (_args, name) => {
            const ladder = ['offstage', 'minor', 'secondary', 'main'];
            const cell = findCell(slugOf(String(name)));
            if (!cell) return `No character "${name}" in state.`;
            const i = ladder.indexOf(cell.tier);
            cell.tier = ladder[Math.max(i - 1, 0)];
            saveChatDebounced();
            return `${cell.name} demoted to ${cell.tier}`;
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'cc-stats',
        helpString: 'Show character-cells state statistics for this chat.',
        callback: () => {
            const s = stateStats();
            return `cells=${s.cells} memories=${s.memories} notes=${s.notes} size=${(s.jsonBytes / 1024).toFixed(1)}KB`;
        },
    }));
}

function slugOf(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ---------------------------------------------------------------- init

jQuery(() => {
    addWandButton();
    addMessageButton();
    initEventHandlers();
    registerSlashCommands();
    console.debug('[Character Cells] initialized');
});
