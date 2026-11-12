// E2E smoke test for the Character Cells extension inside a real Loreweaver app.
// Launches headless Edge with CDP, loads the app, waits for the extension to
// register, then asserts commands, UI anchors, live execution, and console health.
// Run: node test/e2e.mjs   (requires the Loreweaver server already running)
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const APP_URL = process.env.CC_E2E_URL || 'http://127.0.0.1:8000/';
const DEBUG_PORT = 9333;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const NEED = "['cc-state','cc-add','cc-promote','cc-demote','cc-autotier','cc-stats','cc-inject','cc-bookkeeper','cc-event','cc-mode','cc-digest','cc-backfill','cc-worldsim','cc-ledger']";

const profile = mkdtempSync(path.join(tmpdir(), 'cc-e2e-'));
const edge = spawn(EDGE, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--window-size=1400,900',
    'about:blank',
], { stdio: 'ignore' });

const cleanup = () => { try { edge.kill(); } catch {} };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

async function waitFor(url, ms = 10000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        try { return await (await fetch(url)).json(); }
        catch { await new Promise(r => setTimeout(r, 250)); }
    }
    throw new Error(`timed out waiting for ${url}`);
}

let failures = 0;
const check = (name, pass, detail = '') => {
    if (!pass) failures++;
    console.log(`${pass ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`);
};

try {
    // ---- connect CDP --------------------------------------------------
    const targets = await waitFor(`http://127.0.0.1:${DEBUG_PORT}/json`);
    const page = targets.find(t => t.type === 'page');
    if (!page) throw new Error('no page target in Edge');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let msgId = 0;
    const pending = new Map();
    const consoleErrors = [];
    ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
        if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
            const text = m.params.args.map(a => a.value ?? a.description ?? '').join(' ');
            consoleErrors.push(text);
        }
        if (m.method === 'Runtime.exceptionThrown') {
            const d = m.params.exceptionDetails;
            consoleErrors.push((d.exception?.description || d.text || 'exception'));
        }
    };
    const send = (method, params = {}) => new Promise((res) => {
        const id = ++msgId;
        pending.set(id, res);
        ws.send(JSON.stringify({ id, method, params }));
    });
    const evalJs = async (expr, awaitPromise = false) => {
        const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
        return r.result?.result?.value;
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: APP_URL });

    // ---- wait for app shell -------------------------------------------
    const shellDeadline = Date.now() + 30000;
    while (Date.now() < shellDeadline) {
        if (await evalJs('typeof SillyTavern === "object"') === true) break;
        await new Promise(r => setTimeout(r, 500));
    }

    // ---- poll until our extension registers its commands ---------------
    const extDeadline = Date.now() + 30000;
    let registered = false;
    while (Date.now() < extDeadline) {
        registered = await evalJs(`(() => {
            try {
                const cmds = SillyTavern.getContext().SlashCommandParser.commands;
                return ${NEED}.every(n => !!cmds[n]);
            } catch { return false; }
        })()`) === true;
        if (registered) break;
        await new Promise(r => setTimeout(r, 500));
    }
    check('app shell loaded', await evalJs('typeof SillyTavern === "object"') === true);
    check('extension settings registered', await evalJs(
        `!!(SillyTavern.getContext().extensionSettings.character_cells)`) === true);
    check('all 14 cc-* slash commands registered', registered);

    const missing = await evalJs(`(() => {
        const cmds = SillyTavern.getContext().SlashCommandParser.commands;
        return ${NEED}.filter(n => !cmds[n]).join(',');
    })()`);
    if (!registered) console.log(`  missing: ${missing}`);

    check('drawer menu button injected', await evalJs(`(() => {
        const el = document.querySelector('#extensionsMenu');
        return el ? el.innerHTML.includes('character_cells_open') : false;
    })()`) === true);

    // Exercise real extension logic in-page: run a cc command end-to-end.
    const stats = await evalJs(`(async () => {
        try {
            const out = await SillyTavern.getContext().SlashCommandParser.commands['cc-stats'].callback();
            return { ok: true, len: String(out ?? '').length };
        } catch (e) { return { ok: false, err: String(e) }; }
    })()`, true);
    check('cc-stats executes in a fresh chat',
        stats?.ok === true,
        stats?.ok ? `output ${stats.len} chars` : `err: ${stats?.err}`);

    // Core loop: mutate state via a command, verify it lands in chat metadata.
    const mutation = await evalJs(`(async () => {
        try {
            const ctx = SillyTavern.getContext();
            const cmds = ctx.SlashCommandParser.commands;
            await cmds['cc-add'].callback({ name: 'E2E Testchar', tier: 'secondary' });
            const md = ctx.chatMetadata;
            const cells = md?.character_cells?.cells ?? [];
            const cell = cells.find(c => c.name === 'E2E Testchar');
            return { ok: !!cell, tier: cell?.tier, count: cells.length };
        } catch (e) { return { ok: false, err: String(e) }; }
    })()`, true);
    check('cc-add creates a cell in chat metadata', mutation?.ok === true,
        mutation?.ok ? `tier=${mutation.tier}, ${mutation.count} cells` : `err: ${mutation?.err}`);

    const extErrors = consoleErrors.filter(e => /character-cells|cells/i.test(e));
    check('no console errors from the extension', extErrors.length === 0,
        extErrors.length ? extErrors.slice(0, 3).join(' | ') : '');
} catch (err) {
    check('e2e harness itself', false, String(err));
} finally {
    cleanup();
}

console.log(`\n${failures === 0 ? 'ALL E2E CHECKS PASSED' : failures + ' E2E CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
