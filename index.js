// Character Cells extension — Loreweaver
// Slice 1: state store + drawer panel (internal-states look, editable) + slash commands.
// State lives in chat_metadata so it saves/syncs with the chat. See docs/CHARACTER-CELLS-SPEC.md.

// NOTE: loaded as a third-party extension (/scripts/extensions/third-party/<name>/),
// so relative paths need one more level up than built-in extensions.
import { getContext, extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { saveChatDebounced, eventSource, event_types, name1 } from '../../../../script.js';
import { getState, hasState, addCell, findCell, setTier, removeCell, addMemory, stateStats, addEvent, getLedger } from './state.js';
import { renderStateHtml } from './render.js';
import { updateInjection, buildStateBlock, setInjectionEnabled } from './inject.js';
import { initBookkeeper, initBookkeeperEvents, isBookkeeperEnabled, setBookkeeperEnabled } from './bookkeeper.js';
import { LOG_PREFIX } from './config.js';

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

    $root.on('click.cc', '[data-add-faction]', function () {
        const name = $root.find('[data-sec="factions"] .cc-new').val().trim();
        if (name) {
            getState().world.factions.push({ id: uid(), name, goal: '', intel: '', fibs: '', fstate: '', conflict: '', relations: '' });
            $root.find('[data-sec="factions"] .cc-new').val('');
            refreshPanelIfOpen(); saveChatDebounced();
        }
    });
    $root.on('click.cc', '[data-del-faction]', function () {
        const id = String($(this).data('del-faction'));
        getState().world.factions = getState().world.factions.filter(f => f.id !== id);
        refreshPanelIfOpen(); saveChatDebounced();
    });

    $root.on('click.cc', '[data-add-quest]', function () {
        const $sec = $root.find('[data-sec="quests"]');
        const name = $sec.find('.cc-new').val().trim();
        if (name) {
            getState().world.quests.push({ id: uid(), type: $sec.find('.cc-qtype').val(), name, progress: '', reward: '' });
            $sec.find('.cc-new').val('');
            refreshPanelIfOpen(); saveChatDebounced();
        }
    });
    $root.on('click.cc', '[data-del-quest]', function () {
        const id = String($(this).data('del-quest'));
        getState().world.quests = getState().world.quests.filter(q => q.id !== id);
        refreshPanelIfOpen(); saveChatDebounced();
    });

    $root.on('click.cc', '[data-add-chekhov]', function () {
        const $sec = $root.find('[data-sec="chekhov"]');
        const text = $sec.find('.cc-new').val().trim();
        if (text) {
            getState().world.chekhov.push({ id: uid(), text, status: 'active', weight: 1, age: 0, depends: '', secret: false });
            $sec.find('.cc-new').val('');
            refreshPanelIfOpen(); saveChatDebounced();
        }
    });
    $root.on('click.cc', '[data-del-chekhov]', function () {
        const id = String($(this).data('del-chekhov'));
        getState().world.chekhov = getState().world.chekhov.filter(c => c.id !== id);
        refreshPanelIfOpen(); saveChatDebounced();
    });

    $root.on('click.cc', '[data-add-char]', function () {
        const $inp = $root.find('[data-sec="cast"] .cc-new');
        const name = $inp.val().trim();
        if (name) { addCell(name, 'minor'); $inp.val(''); refreshPanelIfOpen(); saveChatDebounced(); }
    });
}

/** Route a field edit from the panel back into the state object. */
function applyField($el, field, value) {
    const state = getState();
    const world = state.world;
    const $cell = $el.closest('[data-cell-id], [data-user-cell]');
    const isUserCell = $cell.is('[data-user-cell]');
    const cell = isUserCell ? getState().cells.find(c => c.fixed)
        : ($cell.data('cell-id') ? findCell(String($cell.data('cell-id'))) : null);
    const $fac = $el.closest('[data-faction-id]');
    const faction = $fac.length ? world.factions.find(f => f.id === String($fac.data('faction-id'))) : null;
    const $quest = $el.closest('[data-quest-id]');
    const quest = $quest.length ? world.quests.find(q => q.id === String($quest.data('quest-id'))) : null;
    const $ch = $el.closest('[data-chekhov-id]');
    const ch = $ch.length ? world.chekhov.find(c => c.id === String($ch.data('chekhov-id'))) : null;
    const num = v => (isNaN(Number(v)) ? 0 : Number(v));
    const list = v => value.split(',').map(s => s.trim()).filter(Boolean);

    switch (field) {
        case 'tier': if (cell && !cell.fixed) cell.tier = value; break;
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
        case 'inventory': if (cell) cell.inventory = list(value); break;
        case 'titles': if (cell) cell.titles = list(value); break;
        case 'mods': if (cell) cell.mods = value; break;
        case 'aware': if (cell) cell.aware = list(value); break;
        case 'fibs': if (cell) cell.fibs = value; break;
        case 'circle': if (cell) cell.circle = list(value); break;
        case 'thoughts': if (cell) cell.thoughts = value; break;
        case 'faction-name': if (faction) faction.name = value; break;
        case 'faction-goal': if (faction) faction.goal = value; break;
        case 'faction-intel': if (faction) faction.intel = value; break;
        case 'faction-fibs': if (faction) faction.fibs = value; break;
        case 'faction-state': if (faction) faction.fstate = value; break;
        case 'faction-conflict': if (faction) faction.conflict = value; break;
        case 'faction-relations': if (faction) faction.relations = value; break;
        case 'quest-name': if (quest) quest.name = value; break;
        case 'quest-progress': if (quest) quest.progress = value; break;
        case 'quest-reward': if (quest) quest.reward = value; break;
        case 'chekhov-text': if (ch) ch.text = value; break;
        case 'chekhov-weight': if (ch) ch.weight = num(value); break;
        case 'chekhov-age': if (ch) ch.age = num(value); break;
        case 'chekhov-depends': if (ch) ch.depends = value; break;
        case 'note-text': {
            const noteId = String($el.closest('[data-note-id]').data('note-id'));
            const note = world.notes.find(n => n.id === noteId);
            if (note) note.text = value;
            break;
        }
        case 'roll-task': world.roll.task = value; break;
        case 'roll-dc': world.roll.dc = value; break;
        case 'roll-user': world.roll.user = value; break;
        case 'roll-npc': world.roll.npc = value; break;
        case 'roll-delta': world.roll.delta = value; break;
        case 'roll-outcome': world.roll.outcome = value; break;
        case 'combat-mode': world.combat.mode = value; break;
        case 'combat-engagement': world.combat.engagement = value; break;
        case 'combat-wounds': world.combat.wounds = value; break;
        case 'combat-exchange': world.combat.exchange = value; break;
        case 'env': world.env = value; break;
        case 'physics': world.physics = value; break;
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
    // Chat switch → recompute injection and redraw the panel.
    eventSource.on(event_types.CHAT_CHANGED, () => {
        updateInjection();
        refreshPanelIfOpen();
    });
    // State-affecting chat events → recompute injection only (redrawing the panel
    // here would wipe in-progress hand edits mid-generation).
    for (const ev of [event_types.MESSAGE_SENT, event_types.MESSAGE_RECEIVED, event_types.MESSAGE_DELETED, event_types.MESSAGE_SWIPED]) {
        eventSource.on(ev, updateInjection);
    }
    // Re-inject before every generation so the block always reflects the current state.
    eventSource.makeLast(event_types.GENERATION_STARTED, updateInjection);
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
            const cell0 = findCell(slugOf(String(name)));
            if (cell0 && cell0.fixed) return 'The user cell cannot be promoted or demoted.';
            if (!cell0) return `No character "${name}" in state. Use /cc-add first.`;
            const ladder = ['offstage', 'minor', 'secondary', 'main'];
            const i = ladder.indexOf(cell0.tier);
            cell0.tier = ladder[Math.min(i + 1, ladder.length - 1)];
            saveChatDebounced();
            return `${cell0.name} promoted to ${cell0.tier}`;
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'cc-demote',
        helpString: 'Demote a character one tier. Usage: /cc-demote Kael',
        positionalArgumentList: [SlashCommandArgument.fromProps({
            description: 'character name', typeList: [ARGUMENT_TYPE.STRING], isRequired: true,
        })],
        callback: (_args, name) => {
            const cell0 = findCell(slugOf(String(name)));
            if (cell0 && cell0.fixed) return 'The user cell cannot be promoted or demoted.';
            if (!cell0) return `No character "${name}" in state.`;
            const ladder = ['offstage', 'minor', 'secondary', 'main'];
            const i = ladder.indexOf(cell0.tier);
            cell0.tier = ladder[Math.max(i - 1, 0)];
            saveChatDebounced();
            return `${cell0.name} demoted to ${cell0.tier}`;
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'cc-stats',
        helpString: 'Show character-cells state statistics for this chat.',
        callback: () => {
            const s = stateStats();
            return `cells=${s.cells} memories=${s.memories} events=${s.events} notes=${s.notes} size=${(s.jsonBytes / 1024).toFixed(1)}KB`;
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'cc-inject',
        helpString: 'Preview the exact internal-states block that gets injected into the prompt. Usage: /cc-inject (shows it) | /cc-inject off (disables) | /cc-inject on (re-enables)',
        positionalArgumentList: [SlashCommandArgument.fromProps({
            description: 'on / off / (empty = show the block)', typeList: [ARGUMENT_TYPE.STRING],
        })],
        callback: (_args, value) => {
            const arg = String(value ?? '').trim().toLowerCase();
            if (arg === 'off') {
                setInjectionEnabled(false);
                return 'Character Cells injection disabled.';
            }
            if (arg === 'on') {
                setInjectionEnabled(true);
                return 'Character Cells injection enabled.';
            }
            const block = buildStateBlock(); // preview regardless of the on/off switch
            if (!block) return 'No cell state in this chat yet — nothing would be injected.';
            return block;
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'cc-bookkeeper',
        helpString: 'Toggle or check the bookkeeper pass (auto state updates after each AI reply). Usage: /cc-bookkeeper on | off | (empty = status)',
        positionalArgumentList: [SlashCommandArgument.fromProps({
            description: 'on / off / (empty = status)', typeList: [ARGUMENT_TYPE.STRING],
        })],
        callback: (_args, value) => {
            const arg = String(value ?? '').trim().toLowerCase();
            if (arg === 'on') { setBookkeeperEnabled(true); return 'Bookkeeper ENABLED — it will update state after each AI reply.'; }
            if (arg === 'off') { setBookkeeperEnabled(false); return 'Bookkeeper DISABLED.'; }
            return `Bookkeeper is ${isBookkeeperEnabled() ? 'ENABLED' : 'DISABLED'}. Use /cc-bookkeeper on|off.`;
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'cc-event',
        helpString: 'Add a shared memory event. Usage: /cc-event what="Kael saw the letter" who=Sylpha,Miyu imp=2',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({ name: 'what', description: 'the event', typeList: [ARGUMENT_TYPE.STRING], isRequired: true }),
            SlashCommandNamedArgument.fromProps({ name: 'who', description: 'comma-separated character names/ids who witnessed it', typeList: [ARGUMENT_TYPE.STRING], isRequired: true }),
            SlashCommandNamedArgument.fromProps({ name: 'imp', description: 'importance 1-3', typeList: [ARGUMENT_TYPE.NUMBER] }),
        ],
        callback: (_args, value) => {
            let what = String(_args.what ?? '').trim();
            let who = String(_args.who ?? '').trim();
            const imp = Number(_args.imp) || 1;
            // Fallback: if the parser delivered no named args, parse the raw remainder.
            if (!what || !who) {
                const s = String(value ?? '');
                const get = (re) => s.match(re)?.[1]?.trim() ?? '';
                what = what || get(/what\s*=\s*"([^"]*)"/) || get(/what\s*=\s*(\S+)/);
                who = who || get(/who\s*=\s*([\s\S]*?)(?=\s+imp\s*=|$)/);
            }
            console.log(`${LOG_PREFIX} /cc-event args:`, { what, who, imp });
            if (!what || !who) return 'Usage: /cc-event what="..." who=Name1,Name2 imp=2';
            const state = getState();
            const resolve = (w) => {
                const t = w.trim().toLowerCase();
                const c = state.cells.find(x => x.id === t)
                    || state.cells.find(x => slugOf(x.name) === t)
                    || state.cells.find(x => x.name.toLowerCase() === t);
                if (c) return c.id;
                // 'user' or the persona name → the fixed user cell
                if (t === 'user' || (name1 && t === slugOf(name1))) {
                    return state.cells.find(x => x.fixed)?.id ?? null;
                }
                return null;
            };
            const witnesses = [...new Set(who.split(',').map(resolve).filter(Boolean))];
            if (!witnesses.length) {
                const known = state.cells.map(c => c.name).join(', ') || '(none)';
                console.warn(`${LOG_PREFIX} /cc-event: no cell matched who="${who}". Cells in state: ${known}`);
                return `No matching character for who="${who}". Cells in state: ${known}`;
            }
            const turn = Number(state.world.turn) || 0;
            const ev = addEvent(what, witnesses, turn, imp);
            saveChatDebounced(); updateInjection();
            console.log(`${LOG_PREFIX} event added (${ev.id}): "${what}" → witnesses: ${ev.witnesses.join(', ')}`);
            return `Event added (${ev.id}): "${what}" witnessed by ${ev.witnesses.join(', ')}. Ledger size: ${getLedger().length}`;
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'cc-ledger',
        helpString: 'List the shared event ledger (who witnessed what). Usage: /cc-ledger',
        callback: () => {
            const ledger = getLedger();
            console.log(`${LOG_PREFIX} ledger queried: ${ledger.length} event(s)`);
            if (!ledger.length) return 'Ledger is empty.';
            const turn = Number(getState().world.turn) || 0;
            return ledger.map(e => `[${e.id}] ${e.what} — w: ${e.witnesses.join(', ')} (imp ${e.importance}, turn ${e.turn})`).join('\n') + `\nTotal: ${ledger.length} events, current turn ${turn}`;
        },
    }));
}

function slugOf(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function uid() {
    return 'x' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
}

// ---------------------------------------------------------------- init

jQuery(() => {
    initBookkeeper(extension_settings);
    addWandButton();
    addMessageButton();
    initEventHandlers();
    registerSlashCommands();
    initBookkeeperEvents();
    console.log(`${LOG_PREFIX} initialized (bookkeeper ${isBookkeeperEnabled() ? 'ON' : 'OFF'})`);
});
