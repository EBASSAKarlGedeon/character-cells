// Standalone replica of the NEW findCard logic in origin.js, driven by the REAL
// card PNG — verifies the fallback finds "Mako" inside the title-named card
// "ex's lil sister wants you", and that exact matching / false-positive guards
// still behave.
import fs from 'node:fs';

const CARD = "C:/Users/Gedeon/AppData/Local/SillyTavern/Data/data/default-user/characters/ex's lil sister wants you.png";

function readCardPng(path) {
    const buf = fs.readFileSync(path);
    let off = 8, json;
    while (off < buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('ascii', off + 4, off + 8);
        if (type === 'tEXt') {
            const data = buf.slice(off + 8, off + 8 + len);
            const nul = data.indexOf(0);
            if (data.toString('ascii', 0, nul) === 'chara') {
                json = JSON.parse(Buffer.from(data.slice(nul + 1).toString('ascii'), 'base64').toString('utf8'));
            }
        }
        off += 12 + len;
    }
    return json;
}

// --- replicate origin.js helpers exactly ---
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (w) => new RegExp(`(?:^|\\s)${escapeRe(w)}(?:\\s|$)`);
const cardBody = (card) =>
    [card.description, card.personality, card.scenario, card.first_mes, card.creator_notes]
        .map(v => String(v || '')).join('\n');

function findCard(name, characters, this_chid, chat = []) {
    const n = normName(name);
    if (!n) return null;
    const list = Array.isArray(characters) ? characters : [];
    const av = (c) => normName(String(c.avatar || '').replace(/\.(png|jpe?g|webp|gif)$/i, ''));
    // Pass 1: the chat's own card, exact first, then whole-word mention.
    const cur = characters[this_chid];
    if (cur) {
        if (normName(cur.name) === n || av(cur) === n) return { card: cur, how: 'chat-card-exact' };
        const body = normName(cardBody(cur));
        if (wordRe(n).test(body)) return { card: cur, how: 'chat-card-contains' };
    }
    // Pass 2: library-wide exact name/avatar match; participants win on ties.
    const hits = list.filter(c => normName(c.name) === n || av(c) === n);
    if (!hits.length) return null;
    let hit = hits[0];
    if (hits.length > 1) {
        const here = new Set();
        if (cur?.avatar) here.add(cur.avatar);
        for (const m of chat) if (m?.original_avatar) here.add(m.original_avatar);
        hit = hits.find(c => here.has(c.avatar)) || hits[0];
    }
    return { card: hit, how: 'exact' };
}

// --- real data ---
const card = readCardPng(CARD);
card.avatar = "ex's lil sister wants you.png"; // ST sets this from the filename
const characters = [card];
const this_chid = 0;

let pass = 0, fail = 0;
const check = (label, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(got)}${ok ? '' : `  (want ${JSON.stringify(want)})`}`);
    ok ? pass++ : fail++;
};

// --- collectLore chat-scoped book logic (replica) ---
// Replica of the new source selection: which books get added, filtered or not.
// loadWorldInfo is faked; card embed/linked book logic is out of scope here.
const BOOKS = {
    'Chat Book': { entries: { 0: { key: ['Mako'], content: 'Mako lives with her brother.' }, 1: { key: ['weather'], content: 'It always rains.' } } },
    'Global Book': { entries: { 0: { key: ['Mako'], content: 'Mako is 18 and unemployed.' }, 1: { key: ['town'], content: 'The town by the sea.' } } },
    'Card Linked': { entries: { 0: { key: [], content: 'Linked-book Mako lore.' } } },
};
const loadWorldInfo = async (name) => BOOKS[name] ?? null;
const world_info = { globalSelect: ['Global Book'] };
const convertCharacterBook = (b) => b;

function sourcesToAdd(card, chatMeta) {
    const list = [];
    const chatBook = String(chatMeta?.world_info || '');
    if (chatBook && chatBook !== card?.data?.extensions?.world && !(world_info?.globalSelect || []).includes(chatBook)) {
        list.push({ name: chatBook, filtered: true });
    }
    for (const g of world_info.globalSelect) list.push({ name: g, filtered: true });
    return list;
}

check('chat-scoped book included when set and not duplicate',
    sourcesToAdd(card, { world_info: 'Chat Book' }), [{ name: 'Chat Book', filtered: true }, { name: 'Global Book', filtered: true }]);
check('chat-scoped book skipped when also in globals',
    sourcesToAdd(card, { world_info: 'Global Book' }), [{ name: 'Global Book', filtered: true }]);
check('chat-scoped book skipped when it is the card\'s linked book',
    sourcesToAdd({ data: { extensions: { world: 'Chat Book' } } }, { world_info: 'Chat Book' }), [{ name: 'Global Book', filtered: true }]);
check('no chat-scoped book → unchanged behavior',
    sourcesToAdd(card, {}), [{ name: 'Global Book', filtered: true }]);
check('null chat metadata (test seam default path) → unchanged behavior',
    sourcesToAdd(card, null), [{ name: 'Global Book', filtered: true }]);

check('NPC name inside title-named card → chat card wins (pass 1)',
    (findCard('Mako', characters, this_chid) || {}).how, 'chat-card-contains');
check('pass 1 returns the chat card itself',
    (findCard('Mako', characters, this_chid) || {}).card?.name, "ex's lil sister wants you");
check('chat card exact name match (pass 1, exact)',
    findCard("ex's lil sister wants you", characters, this_chid)?.how, 'chat-card-exact');
// chat-card avatar match: chat card whose AVATAR stem differs from its NAME
const byAvatar = { name: 'Bot Title', avatar: 'mako.png', description: 'No Mako in this text at all.' };
check('chat card avatar match (pass 1, exact)',
    findCard('Mako', [byAvatar], 0)?.how, 'chat-card-exact');
check('non-existent name → null', findCard('Zorp', characters, this_chid), null);
check('empty name → null', findCard('', characters, this_chid), null);
check('no partial-word match (mid-word "ako" must not hit)',
    findCard('ako', characters, this_chid), null);
check('chat card match wins over the whole library (single card)',
    (findCard('Mako', characters, this_chid) || {}).card?.avatar, "ex's lil sister wants you.png");

// multi-card library: an UNRELATED card is the chat card — Mako is not in it,
// and pass 2 (exact only) can't find Mako either → null
const unrelated = { name: 'Space Ranger', avatar: 'space.png', description: 'A hero in space. Nothing relevant here.' };
check('chat card without Mako + no exact match elsewhere → null',
    findCard('Mako', [card, unrelated], 1), null);

// multi-card library: chat card mentions Mako → found even among many cards
const chatty = { name: 'Other Chat', avatar: 'other.png', description: 'Mako shows up here.' };
check('chat card mention wins over library (multi-card)',
    findCard('Mako', [unrelated, chatty], 1)?.how, 'chat-card-contains');

// multi-card library: Mako has her OWN card in the library but the chat card
// doesn't mention her and its name/avatar don't match → pass 2 exact finds hers
const makoOwn = { name: 'Mako', avatar: 'mako-ichimura.png', description: 'A student.' };
check('library exact match still reachable (pass 2)',
    findCard('Mako', [unrelated, makoOwn], 0)?.how, 'exact');
// participants-win tie-break still prefers the card taking part in the chat
const makoTwin1 = { name: 'Mako', avatar: 'mako-a.png' };
const makoTwin2 = { name: 'Mako', avatar: 'mako-b.png' };
const chatWithMakoB = [{ original_avatar: 'mako-b.png' }];
check('tie among exact matches: chat participant wins',
    findCard('Mako', [makoTwin1, makoTwin2], 99, chatWithMakoB)?.card?.avatar, 'mako-b.png');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
