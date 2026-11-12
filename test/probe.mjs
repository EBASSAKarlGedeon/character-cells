// Diagnostic probe v2: capture ALL console output and check the injected script tag.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const DEBUG_PORT = 9334;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = mkdtempSync(path.join(tmpdir(), 'cc-probe-'));
const edge = spawn(EDGE, [
    `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => { try { edge.kill(); } catch {} });

async function waitFor(url, ms = 10000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        try { return await (await fetch(url)).json(); }
        catch { await new Promise(r => setTimeout(r, 250)); }
    }
    throw new Error('timed out');
}

const targets = await waitFor(`http://127.0.0.1:${DEBUG_PORT}/json`);
const page = targets.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0; const pending = new Map(); const log = [];
ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Log.entryAdded') log.push(`[${m.params.entry.level}] ${m.params.entry.text} ${m.params.entry.url || ''}`);
    if (m.method === 'Runtime.consoleAPICalled') log.push(`[${m.params.type}] ` + m.params.args.map(a => a.value ?? a.description ?? JSON.stringify(a.preview?.properties?.map(p=>p.value) ?? '')).join(' '));
    if (m.method === 'Runtime.exceptionThrown') log.push('[EXC] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
};
const send = (method, params = {}) => new Promise((res) => {
    const id = ++msgId; pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
});
const evalJs = async (expr, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
    return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description ?? r;
};
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Page.navigate', { url: 'http://127.0.0.1:8000/' });
await new Promise(r => setTimeout(r, 12000));

console.log('script tag for character-cells:',
    await evalJs(`(() => { const s = document.querySelector('script[src*="character-cells"]'); return s ? s.src + ' (present)' : 'NOT FOUND'; })()`));
console.log('cc commands:',
    await evalJs(`(() => { try { return Object.keys(SillyTavern.getContext().SlashCommandParser.commands).filter(n => n.startsWith('cc-')).join(', ') || '(none)'; } catch(e) { return 'ERR ' + e; } })()`));
console.log('\n---- console lines mentioning cells/activate/extension ----');
for (const line of log) if (/cells|activat|extension/i.test(line)) console.log(line);
console.log('---- total console lines:', log.length, '----');
edge.kill();
