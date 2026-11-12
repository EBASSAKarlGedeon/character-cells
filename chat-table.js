// Character Cells — chat-rendered state table (B7)
// A collapsible, DISPLAY-ONLY table appended under the latest AI message. It is
// DOM only: never written into message text, so it can't leak into the prompt,
// the chat file, or a swipe. Shows the state as it stands right now (after the
// bookkeeper pass), so it lives on the newest AI message only and moves along.

import { chat, eventSource, event_types } from '../../../../script.js';
import { getState, hasState } from './state.js';
import { stageOf } from './rel.js';
import { getSettings } from './settings.js';
import { LOG_PREFIX } from './config.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const dash = (v) => (v === undefined || v === null || v === '' ? '—' : esc(v));
let openState = false; // remember whether the user keeps the table expanded

function buildHtml() {
    const s = getState();
    const world = s.world || {};
    const present = new Set(s.present || []);
    const npcs = (s.cells || []).filter(c => !c.fixed && c.tier !== 'offstage');
    const user = (s.cells || []).find(c => c.fixed) || {};

    const rows = npcs.map(c => {
        const b = c.bonds || {};
        const r = c.rel || {};
        const a = c.agenda || {};
        return `<tr>
  <td>${present.has(c.id) ? '●' : '○'} ${esc(c.name)}<small> ${esc(c.tier)}</small></td>
  <td>${b.user ?? 0}</td><td>${b.sparks ?? 0}</td><td>${b.grudge ?? 0}</td>
  <td>${dash(stageOf(c))}</td>
  <td>${dash(r.route)} ${r.condition ? esc(r.condition) : ''}</td>
  <td>${dash(c.status)}</td>
  <td>${a.goal ? `${esc(a.goal)} (${a.step ?? 0}/${a.max ?? 0})` : '—'}</td>
</tr>`;
    }).join('');

    const lines = [];
    lines.push(`<b>Turn ${world.turn || 0}</b>`);
    const roll = world.roll || {};
    if (roll.task && Number(roll.turn) === Number(world.turn)) {
        lines.push(`🎲 ${esc(roll.task)} — DC ${dash(roll.dc)}, roll ${dash(roll.user)}/${dash(roll.npc)} → <b>${dash(roll.outcome)}</b>`);
    }
    const ws = world.worldsim;
    if (ws && Number(ws.turn) === Number(world.turn)) lines.push(`🌎 ${esc(ws.event)}`);
    for (const f of (world.chekhovFired || [])) lines.push(`💥 fired: ${esc(f.text)}`);
    const active = (world.chekhov || []).filter(c => (c.status || 'active') === 'active' && !c.secret).length;
    if (active) lines.push(`🔫 ${active} active plant(s)`);
    lines.push(`🎒 ${esc((user.inventory || []).join(', ') || '—')} · status: ${dash(user.status)}`);

    return `<details class="cc-chat-table" ${openState ? 'open' : ''}>
  <summary>📊 Internal States — turn ${world.turn || 0}</summary>
  ${npcs.length ? `<table><thead><tr><th>Character</th><th>Bond</th><th>Sparks</th><th>Grudge</th><th>Stage</th><th>Route</th><th>Body</th><th>Agenda</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="cc-ct-none">No tracked characters yet.</div>'}
  <div class="cc-ct-lines">${lines.map(l => `<div>${l}</div>`).join('')}</div>
</details>`;
}

/** (Re)draw the table under the newest AI message; remove it everywhere else. */
export function renderChatTable() {
    try {
        $('#chat .cc-chat-table').remove();
        if (getSettings().chatTables === false || !hasState()) return;
        let idx = -1;
        for (let i = chat.length - 1; i >= 0; i--) {
            if (!chat[i].is_user && !chat[i].is_system) { idx = i; break; }
        }
        if (idx < 0) return;
        const $mes = $(`#chat .mes[mesid="${idx}"]`);
        if (!$mes.length) return;
        $mes.find('.mes_text').first().after(buildHtml());
        $mes.find('.cc-chat-table').on('toggle', function () { openState = this.open; });
    } catch (err) {
        console.warn(`${LOG_PREFIX} chat table failed:`, err);
    }
}

export function initChatTable() {
    const draw = () => setTimeout(renderChatTable, 50);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, draw);
    eventSource.on(event_types.MESSAGE_SWIPED, draw);
    eventSource.on(event_types.MESSAGE_DELETED, draw);
    eventSource.on(event_types.CHAT_CHANGED, () => setTimeout(renderChatTable, 400));
}
