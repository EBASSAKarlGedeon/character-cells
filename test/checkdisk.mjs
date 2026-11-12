// Read-only check: for every (cells-clean) copy, report ONLY counts from the
// header line (chat_metadata.character_cells) — no message content printed.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const DIR = 'C:\\Users\\Gedeon\\Documents\\Coding\\Loreweaver\\data\\default-user\\chats\\ReVardanis — Starting Life Under the Voice';
for (const f of readdirSync(DIR).filter(f => f.endsWith('.jsonl'))) {
    try {
        const first = JSON.parse(readFileSync(path.join(DIR, f), 'utf8').split('\n')[0]);
        const cc = first?.chat_metadata?.character_cells;
        if (!cc) { console.log(`${f.slice(-42)} — no character_cells in header`); continue; }
        console.log(`${f.slice(-42)} — cells=${cc.cells?.length ?? 0} ledger=${cc.ledger?.length ?? 0} imported=${!!cc.imported} done=${!!cc.backfill?.done} progress=${cc.backfill?.progress ?? '-'}`);
    } catch (e) { console.log(`${f.slice(-42)} — parse error: ${e.message}`); }
}
