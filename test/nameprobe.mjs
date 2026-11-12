import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = mkdtempSync(path.join(tmpdir(), 'cc-np-'));
const edge = spawn(EDGE, ['--remote-debugging-port=9337', `--user-data-dir=${profile}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { edge.kill(); } catch {} });
const wait = async (url, ms = 10000) => {
    const dl = Date.now() + ms;
    while (Date.now() < dl) { try { return await (await fetch(url)).json(); } catch { await new Promise(r => setTimeout(r, 250)); } }
    throw new Error('timeout');
};
const targets = await wait('http://127.0.0.1:9337/json');
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pend = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description ?? r;
};
await send('Page.enable');
await send('Page.navigate', { url: 'http://127.0.0.1:8000/' });
await new Promise(r => setTimeout(r, 12000));
console.log(await evalJs(`(async () => {
    const s = await import('/script.js');
    if (!s.characters.length) await s.getCharacters();
    const hits = s.characters.filter(c => c.name.toLowerCase().includes('revardanis'));
    return hits.map(c => JSON.stringify(c.name) + ' codepoints=' + Array.from(c.name).map(ch => ch.codePointAt(0)).join(','));
})()`));
edge.kill();
