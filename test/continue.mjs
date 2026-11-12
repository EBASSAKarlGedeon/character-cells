// Live-play continuation test: open the (cells-clean) copy, send 5 REAL messages
// through the app's own send button (main connection), and verify per message:
//   - the reply lands (chat grows),
//   - the bookkeeper runs and the LEDGER grows,
//   - the LEDGER BROWSER DOM updates live (no reload / chat switch),
//   - world.turn ticks.
// Usage: node test/continue.mjs  (Loreweaver on :8000, main connection + bookkeeper profile set)
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const APP_URL = process.env.CC_E2E_URL || 'http://127.0.0.1:8000/';
const DEBUG_PORT = 9338;
const CHAT_NOEXT = 'ReVardanis — Starting Life Under the Voice - 2026-09-27@23h41m10s371ms (cells-clean) 2026-11-12 15h17';
const CHAR_NAME = 'ReVardanis — Starting Life Under the Voice';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const N_MSGS = 5;
const MSGS = [
    'I check on the magisteel refinement in the workshop and ask how the first ingot turned out.',
    'I take Yumiella aside and ask how she is holding up after the river incident.',
    'I call a brief meeting with Kaijin and Rigurd about the refugee housing plans.',
    'I spend the evening training my mana control in the courtyard.',
    'Before bed, I write down everything that happened today in my journal.',
];

const profile = mkdtempSync(path.join(tmpdir(), 'cc-cont-'));
const edge = spawn(EDGE, [
    `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' });
const cleanup = () => { try { edge.kill(); } catch {} };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

async function waitFor(url, ms = 10000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        try { return await (await fetch(url)).json(); } catch { await new Promise(r => setTimeout(r, 250)); }
    }
    throw new Error('timed out');
}

let failures = 0;
const check = (name, pass, detail = '') => {
    if (!pass) failures++;
    console.log(`${pass ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`);
};

try {
    const targets = await waitFor(`http://127.0.0.1:${DEBUG_PORT}/json`);
    const page = targets.find(t => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let msgId = 0; const pending = new Map(); const consoleLines = [];
    ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
        if (m.method === 'Runtime.consoleAPICalled') {
            consoleLines.push(`[${m.params.type}] ` + m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300));
        }
        if (m.method === 'Runtime.exceptionThrown') {
            consoleLines.push('[EXC] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 300));
        }
    };
    const send = (method, params = {}) => new Promise((res) => {
        const id = ++msgId; pending.set(id, res);
        ws.send(JSON.stringify({ id, method, params }));
    });
    const evalJs = async (expr) => {
        const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
        if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text };
        return r.result?.result?.value;
    };
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: APP_URL });

    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        if (await evalJs(`(() => { try { return !!SillyTavern.getContext().SlashCommandParser.commands['cc-add']; } catch { return false; } })()`) === true) break;
        await new Promise(r => setTimeout(r, 500));
    }

    // ---- one page-side flow: open chat, then send 5 messages --------------------
    const R = await evalJs(`(async () => {
        const out = { perMsg: [] };
        const script = await import('/script.js');
        const st = await import('/scripts/extensions/third-party/character-cells/state.js');
        try {
            // --- open character + the clean copy
            if (!script.characters.length) await script.getCharacters();
            for (let i = 0; i < 90 && !script.characters.some(c => c.name === ${JSON.stringify(CHAR_NAME)}); i++) {
                await new Promise(r => setTimeout(r, 1000));
                if (!script.characters.length) await script.getCharacters();
            }
            const idx = script.characters.findIndex(c => c.name === ${JSON.stringify(CHAR_NAME)});
            if (idx < 0) { out.fatal = 'character not found'; return out; }
            out.selDebug = [];
            for (let i = 0; i < 20 && String(script.this_chid) !== String(idx); i++) {
                try { await script.selectCharacterById(idx, { switchMenu: false }); out.selDebug.push('ok@' + i); }
                catch (e) { out.selDebug.push('err@' + i + ':' + String(e).slice(0, 120)); }
                await new Promise(r => setTimeout(r, 1500));
            }
            if (String(script.this_chid) !== String(idx)) { out.fatal = 'this_chid stuck at ' + script.this_chid + ' (idx=' + idx + ') attempts: ' + out.selDebug.join('; '); return out; }
            await script.openCharacterChat(${JSON.stringify(CHAT_NOEXT)});
            await new Promise(r => setTimeout(r, 2500));
            out.start = { len: script.chat.length, ledger: (st.getState().ledger||[]).length,
                         turn: Number(st.getState().world?.turn) || 0,
                         browserSummary: (document.querySelector('#character_cells_container .cc-ledger-summary')||{}).textContent?.trim().slice(0,80) || '(no container)' };

            const summaryText = () => (document.querySelector('#character_cells_container .cc-ledger-summary')||{}).textContent?.trim() || '';

            for (let n = 0; n < ${N_MSGS}; n++) {
                const before = { ledger: (st.getState().ledger||[]).length, len: script.chat.length,
                                 turn: Number(st.getState().world?.turn) || 0, sum: summaryText() };
                // --- send through the REAL UI
                const ta = document.querySelector('#send_textarea');
                ta.value = ${JSON.stringify(MSGS)}[n];
                ta.dispatchEvent(new Event('input', { bubbles: true }));
                document.querySelector('#send_but').click();
                // --- wait for the reply to land and finish streaming
                const t0 = Date.now();
                let lastLen = -1, stable = 0;
                while (Date.now() - t0 < 240000) {
                    await new Promise(r => setTimeout(r, 2000));
                    const L = script.chat.length;
                    const lastMes = String(script.chat[L-1]?.mes || '');
                    if (L >= before.len + 2 && lastMes.length === lastLen && lastMes.length > 0) { stable++; if (stable >= 2) break; }
                    else { stable = 0; lastLen = lastMes.length; }
                }
                const gotReply = script.chat.length >= before.len + 2 && String(script.chat[script.chat.length-1]?.mes || '').length > 0;
                // --- wait for the bookkeeper (delay 1.5s + model call)
                const t1 = Date.now();
                while (Date.now() - t1 < 90000 && (st.getState().ledger||[]).length === before.ledger) {
                    await new Promise(r => setTimeout(r, 2000));
                }
                await new Promise(r => setTimeout(r, 1000));
                const after = { ledger: (st.getState().ledger||[]).length, len: script.chat.length,
                                turn: Number(st.getState().world?.turn) || 0, sum: summaryText() };
                const newEvents = (st.getState().ledger||[]).slice(before.ledger).map(e => ({ what: String(e.what).slice(0, 70), imp: e.importance, turn: e.turn }));
                out.perMsg.push({ n: n+1, gotReply, before, after, newEvents });
            }
            await script.saveChat(); // HARD FLUSH — the harness kills the browser right after
            await new Promise(r => setTimeout(r, 1500));
            // --- disk verification via the app's own API
            const s = st.getState();
            out.final = { ledger: (s.ledger||[]).length, cells: s.cells.length, turn: Number(s.world?.turn) || 0,
                          chat: script.characters[script.this_chid].chat };
            const rr = await fetch('/api/chats/get', { method: 'POST', headers: SillyTavern.getContext().getRequestHeaders(),
                body: JSON.stringify({ ch_name: script.characters[script.this_chid].name,
                                       file_name: (script.characters[script.this_chid].chat || '').replace(/(\\.jsonl)+$/, ''),
                                       avatar_url: script.characters[script.this_chid].avatar }) });
            const dd = await rr.json();
            const diskCc = dd?.[0]?.chat_metadata?.character_cells;
            out.onDisk = { file: script.characters[script.this_chid].chat, ledger: diskCc?.ledger?.length, cells: diskCc?.cells?.length };
        } catch (e) { out.fatal = String(e) + (e && e.stack ? ' | ' + String(e.stack).split('\\n').slice(0,3).join(' ') : ''); }
        return out;
    })()`);

    if (R.__error) { check('live flow', false, R.__error); }
    else {
        check('clean copy opened', (R.start?.len ?? 0) > 100, `${R.start?.len} messages, ledger=${R.start?.ledger}, turn=${R.start?.turn}`);
        const rows = R.perMsg || [];
        for (const m of rows) {
            check(`msg ${m.n}: reply generated`, m.gotReply, `chat ${m.before.len}→${m.after.len}`);
            const grew = m.after.ledger > m.before.ledger;
            check(`msg ${m.n}: bookkeeper added events (no reload)`, grew,
                `ledger ${m.before.ledger}→${m.after.ledger}, turn ${m.before.turn}→${m.after.turn}`);
            const sumGrew = m.after.sum !== m.before.sum;
            check(`msg ${m.n}: ledger browser DOM updated live`, sumGrew, `"${(m.after.sum || '').slice(0, 60)}"`);
            if (m.newEvents?.length) console.log(`   new: ${m.newEvents.map(e => e.what).join(' | ')}`);
        }
        const grewAll = rows.length === N_MSGS && rows.every(m => m.after.ledger > m.before.ledger);
        check('all 5 messages bookkept', grewAll, `ledger ${R.start?.ledger} → ${R.final?.ledger}`);
        check('world clock ticked', (R.final?.turn ?? 0) > (R.start?.turn ?? 0), `turn ${R.start?.turn} → ${R.final?.turn}`);
        check('state persisted to disk after hard save', (R.onDisk?.ledger ?? 0) >= (R.final?.ledger ?? 999),
            `file="${(R.onDisk?.file || '').slice(-30)}", disk ledger=${R.onDisk?.ledger}, cells=${R.onDisk?.cells}`);
        if (R.fatal) console.log('FATAL:', R.fatal);
    }
    console.log('\n---- report ----');
    console.log(JSON.stringify(R, null, 2).slice(0, 6000));
    const rel = consoleLines.filter(l => /character-cells|bookkeeper|ledger/i.test(l));
    if (rel.length) console.log('\n---- extension console (last 25) ----\n' + rel.slice(-25).join('\n'));
    const errLines = consoleLines.filter(l => /^\[error\]|^\[EXC\]/i.test(l));
    if (errLines.length) console.log('\n---- page errors ----\n' + errLines.slice(-10).join('\n'));
} catch (err) {
    check('continuation harness', false, String(err));
} finally {
    cleanup();
}
console.log(`\n${failures === 0 ? 'CONTINUATION TESTS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
