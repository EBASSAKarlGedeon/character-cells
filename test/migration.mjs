// Migration test: real chat → import → clean copy → PARTIAL backfill (4 batches, then cancel).
// Uses the app's own openCharacterChat path so chat_metadata bindings stay consistent.
// Usage: node test/migration.mjs   (needs Loreweaver on :8000 with a bookkeeper profile)
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const APP_URL = process.env.CC_E2E_URL || 'http://127.0.0.1:8000/';
const DEBUG_PORT = 9335;
const CHAT_FILE = 'ReVardanis — Starting Life Under the Voice - 2026-09-27@23h41m10s371ms.jsonl';
const CHAT_FILE_NOEXT = CHAT_FILE.replace(/\.jsonl$/, '');
const CHAR_NAME = 'ReVardanis — Starting Life Under the Voice';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BATCHES_TO_RUN = 4; // partial backfill, then cancel (resumable)

const profile = mkdtempSync(path.join(tmpdir(), 'cc-mig-'));
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
    await send('Runtime.enable'); // capture console for model-call errors
    await send('Page.enable');
    await send('Page.navigate', { url: APP_URL });

    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        if (await evalJs(`(() => { try { return !!SillyTavern.getContext().SlashCommandParser.commands['cc-add']; } catch { return false; } })()`) === true) break;
        await new Promise(r => setTimeout(r, 500));
    }
    check('extension loaded', await evalJs(`(() => { try { return !!SillyTavern.getContext().SlashCommandParser.commands['cc-add']; } catch { return false; } })()`));

    // ============ page-side migration flow (one eval, no interleaving) ============
    const R = await evalJs(`(async () => {
        const out = {};
        const script = await import('/script.js');
        const st = await import('/scripts/extensions/third-party/character-cells/state.js');
        try {
            // --- character + chat via the app's own path
            if (!script.characters.length) await script.getCharacters();
            for (let i = 0; i < 90 && !script.characters.some(c => c.name === ${JSON.stringify(CHAR_NAME)}); i++) {
                await new Promise(r => setTimeout(r, 1000));
                if (!script.characters.length) await script.getCharacters();
            }
            const idx = script.characters.findIndex(c => c.name === ${JSON.stringify(CHAR_NAME)});
            if (idx < 0) { out.fatal = 'character not found among ' + script.characters.length; return out; }
            for (let i = 0; i < 15 && String(script.this_chid) !== String(idx); i++) {
                await script.selectCharacterById(idx, { switchMenu: false });
                await new Promise(r => setTimeout(r, 1000));
            }
            if (String(script.this_chid) !== String(idx)) { out.fatal = 'this_chid stuck at ' + script.this_chid; return out; }
            await script.openCharacterChat(${JSON.stringify(CHAT_FILE_NOEXT)});
            await new Promise(r => setTimeout(r, 2500)); // let getChat + render settle
            out.chatLen = script.chat.length;
            out.origBlocks = script.chat.filter(m => (m.mes||'').includes('<internal_states')).length;

            // --- STEP 1: import
            const imp = await import('/scripts/extensions/third-party/character-cells/import-states.js');
            await imp.importInternalStates();
            const s1 = st.getState();
            out.afterImport = { cells: s1.cells.length, imported: !!s1.imported };

            // --- STEP 2: clean copy
            const bf = await import('/scripts/extensions/third-party/character-cells/backfill.js');
            await bf.cleanCopyChat();
            await new Promise(r => setTimeout(r, 2500)); // openCharacterChat(new copy) inside
            const s2 = st.getState();
            out.afterCopy = { chat: script.characters[script.this_chid].chat, cells: s2.cells.length,
                              imported: !!s2.imported, len: script.chat.length,
                              leftoverBlocks: script.chat.filter(m => (m.mes||'').includes('<internal_states')).length };

            // --- STEP 3: PARTIAL backfill — run until N batches, then cancel.
            const p = bf.backfillLedger(null); // not awaited yet
            const seen = new Set();
            let advances = 0, failures = 0, cancelled = false;
            const t0 = Date.now();
            while (Date.now() - t0 < 240000) { // 4 min cap
                const s = st.getState();
                const prog = Number(s.backfill?.progress) || 0;
                if (!seen.has(prog) && prog > 0) { seen.add(prog); advances++; }
                failures = (s.backfill?.failed || []).length;
                if (advances >= ${BATCHES_TO_RUN} || failures >= 3) {
                    bf.cancelBackfill(); cancelled = true; break;
                }
                if (s.backfill?.done) break;
                await new Promise(r => setTimeout(r, 1000));
            }
            await p.catch(e => out.backfillPromiseErr = String(e));
            // HARD FLUSH: the debounced save loses data if the browser closes —
            // this test kills it right after, so save synchronously.
            await script.saveChat();
            await new Promise(r => setTimeout(r, 1500));
            const s3 = st.getState();
            out.afterBackfill = { cancelled, advances, failures,
                progress: s3.backfill?.progress ?? null, done: !!s3.backfill?.done,
                running: !!s3.backfill?.running, virtualTurn: s3.backfill?.virtualTurn ?? null,
                ledger: (s3.ledger||[]).length,
                sysCount: script.chat.filter(m => m.is_system).length,
                ledgerSample: (s3.ledger||[]).slice(0, 5).map(e => ({ id: e.id, what: String(e.what).slice(0, 80), imp: e.importance, turn: e.turn, w: (e.witnesses||[]).length })) };
            // VERIFY ON DISK: re-fetch the saved file and read its metadata.
            const copyNoExt = (script.characters[script.this_chid].chat || '').replace(/\.jsonl$/, '');
            const rr = await fetch('/api/chats/get', { method: 'POST', headers: SillyTavern.getContext().getRequestHeaders(),
                body: JSON.stringify({ ch_name: script.characters[script.this_chid].name, file_name: copyNoExt, avatar_url: script.characters[script.this_chid].avatar }) });
            const dd = await rr.json();
            const diskCc = dd?.[0]?.chat_metadata?.character_cells;
            out.onDisk = { file: copyNoExt, cells: diskCc?.cells?.length, ledger: diskCc?.ledger?.length,
                           done: !!diskCc?.backfill?.done, progress: diskCc?.backfill?.progress ?? null };
        } catch (e) { out.fatal = String(e); }
        return out;
    })()`);

    if (R.__error) { check('page flow', false, R.__error); }
    else {
        check('chat opened', (R.chatLen ?? 0) > 100, `${R.chatLen} messages, ${R.origBlocks} with state blocks`);
        check('import parsed real cells', (R.afterImport?.cells ?? 0) > 1, `cells=${R.afterImport?.cells}, imported=${R.afterImport?.imported}`);
        check('clean copy created', (R.afterCopy?.len ?? 0) > 100, `chat=${R.afterCopy?.chat}, ${R.afterCopy?.len} messages`);
        check('state carried into copy', R.afterCopy?.imported === true, `cells=${R.afterCopy?.cells}, imported=${R.afterCopy?.imported}`);
        check('blocks stripped from copy', R.afterCopy?.leftoverBlocks === 0, `${R.afterCopy?.leftoverBlocks} remaining`);
        const b = R.afterBackfill;
        const backfillOk = !R.backfillPromiseErr && !R.fatal && (b?.ledger > 0 || b?.advances > 0);
        check('backfill model round-trip worked', backfillOk,
            b ? `advances=${b.advances}, ledger=${b.ledger}, progress=${b.progress}/${R.afterCopy?.len}, failures=${b.failures}, cancelled=${b.cancelled}` : 'no data');
        console.log('\nledger sample:', JSON.stringify(b?.ledgerSample, null, 2));
        check('ledger events persisted to disk', (R.onDisk?.ledger ?? 0) > 0,
            `file="${(R.onDisk?.file || '').slice(-40)}", ledger=${R.onDisk?.ledger}, done=${R.onDisk?.done}, progress=${R.onDisk?.progress}`);
        if (R.backfillPromiseErr) console.log('backfill promise err:', R.backfillPromiseErr);
        if (R.fatal) console.log('FATAL:', R.fatal);
    }
    console.log('\n---- page report ----');
    console.log(JSON.stringify(R, null, 2));
    const rel = consoleLines.filter(l => /character-cells|backfill|bookkeeper/i.test(l));
    if (rel.length) console.log('\n---- extension console ----\n' + rel.slice(0, 20).join('\n'));
} catch (err) {
    check('migration harness', false, String(err));
} finally {
    cleanup();
}
console.log(`\n${failures === 0 ? 'MIGRATION TESTS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
