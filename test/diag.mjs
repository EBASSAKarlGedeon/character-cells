// Quick diagnostic: why isn't the character list loading?
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = mkdtempSync(path.join(tmpdir(), 'cc-diag-'));
const edge = spawn(EDGE, ['--remote-debugging-port=9336', `--user-data-dir=${profile}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { edge.kill(); } catch {} });

const wait = async (url, ms = 10000) => {
    const dl = Date.now() + ms;
    while (Date.now() < dl) { try { return await (await fetch(url)).json(); } catch { await new Promise(r => setTimeout(r, 250)); } }
    throw new Error('timeout');
};
const targets = await wait('http://127.0.0.1:9336/json');
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pend = new Map(); const logs = [];
ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled') logs.push(`[${m.params.type}] ` + m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 250));
    if (m.method === 'Runtime.exceptionThrown') logs.push('[EXC] ' + (m.params.exceptionDetails.exception?.description || '').slice(0, 250));
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description ?? r;
};
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: 'http://127.0.0.1:8000/' });
await new Promise(r => setTimeout(r, 15000));

console.log('characters.length:', await evalJs(`(async () => {
    const s = await import('/script.js');
    if (!s.characters.length) { try { await s.getCharacters(); } catch (e) { return 'getCharacters threw: ' + e; } }
    return s.characters.length;
})()`));
console.log('api probe:', await evalJs(`(async () => {
    const r = await fetch('/api/characters/all', { method: 'POST', headers: SillyTavern.getContext().getRequestHeaders(), body: '{}' });
    const text = await r.text();
    return 'status=' + r.status + ' len=' + text.length + ' head=' + text.slice(0, 200);
})()`));
console.log('this_chid:', await evalJs(`(async () => { const s = await import('/script.js'); return String(s.this_chid); })()`));
console.log('\n---- console (last 15) ----');
logs.slice(-15).forEach(l => console.log(l));
edge.kill();
