// Character Cells — origin call (slice 9 follow-up, spec "Starting values for
// pre-existing relationships")
//
// A fresh cell defaults to BOND 0 → Stranger — wrong for a maid who raised the
// user or a sworn arch-enemy. When a NEW NPC cell is born, ONE cheap one-off
// call reads that character's CARD (the only place the card is ever read) plus
// the scene that introduced them, and seeds the starting block: bonds.user,
// trust, route, condition, and (when the card establishes them) known
// likes/dislikes and an open threshold. No soft caps (DECIDED 2026-11-11): a
// 5-year girlfriend enters Intimate; the ladder discipline protects per-scene
// movement, not starting position.
//
// Never fatal, never blocking: runs after the reply, a failed/empty call leaves
// the cell at Stranger, and the panel remains the hand-fix authority.

import { chat, characters } from '../../../../script.js';
import { getState } from './state.js';
import { ensureRel, parseRoute, parseCondition, markRelStamps } from './rel.js';
import { cheapCall } from './llm.js';
import { LOG_PREFIX } from './config.js';

const ORIGIN_SYSTEM = 'You seed the starting relationship state for a newly introduced character in an ongoing roleplay. You read the character card (when one exists) and the scene that introduced them, then output simple key=value lines. You never write prose, never narrate, never comment. Output ONLY the given keys, one per line. Omit any key you cannot ground in the card or the scene — silence is correct.';

function normName(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Find the character card matching a cell name (exact, then prefix both ways ≥4 chars). */
export function findCard(name) {
    const n = normName(name);
    if (!n) return null;
    const list = Array.isArray(characters) ? characters : [];
    const av = (c) => normName(String(c.avatar || '').replace(/\.(png|jpe?g|webp|gif)$/i, ''));
    let hit = list.find(c => normName(c.name) === n || av(c) === n);
    if (!hit) {
        hit = list.find(c => {
            const cn = normName(c.name);
            return cn.length >= 4 && n.length >= 4 && (cn.startsWith(n) || n.startsWith(cn));
        });
    }
    return hit || null;
}

/** The card's lore-bearing fields, concatenated and size-capped. */
function cardText(card) {
    if (!card) return '';
    const parts = [card.description, card.personality, card.scenario, card.first_mes, card.creator_notes]
        .map(v => String(v || '').trim()).filter(Boolean);
    return parts.join('\n').slice(0, 4000);
}

/** The exchange that just happened (same shape as the bookkeeper's scene text). */
function buildSceneText() {
    const state = getState();
    const userName = state.cells.find(c => c.fixed)?.name || 'User';
    const msgs = [];
    for (let i = chat.length - 1; i >= 0 && msgs.length < 2; i--) {
        const m = chat[i];
        if (m.is_system) continue;
        msgs.unshift(`${m.is_user ? userName : 'AI'}: ${String(m.mes || '').trim()}`);
    }
    return msgs.join('\n\n');
}

/**
 * Seed a newly created NPC cell's relationship state. One cheap call; once per
 * cell, ever (a second attempt would fight live-play drift).
 * @param {object} cell the freshly created NPC cell
 * @param {string} [sceneOverride] caller-provided introducing-scene text
 * @returns {Promise<boolean>} true when values were seeded
 */
export async function seedOrigin(cell, sceneOverride = '') {
    if (!cell || cell.fixed) return false;
    const state = getState();
    if (!state.cells.includes(cell)) return false;
    const r = ensureRel(cell);
    if (r.originTried) return false; // single attempt per cell
    r.originTried = true;

    const card = findCard(cell.name);
    const cardBlock = cardText(card);
    const scene = String(sceneOverride || buildSceneText()).slice(0, 4000);
    const userName = state.cells.find(c => c.fixed)?.name || 'User';

    const prompt = `CHARACTER (name: ${cell.name}):
${cardBlock || '(no character card found — judge only from the scene)'}

INTRODUCING SCENE (the exchange that just happened):
${scene || '(none)'}

CURRENT STATE EXCERPT:
turn ${state.world.turn || 0}; the user is "${userName}".

OUTPUT — key=value lines, one per line, ONLY these keys, only when grounded:
bond=<-10..20>            # how this character ALREADY feels about the user before this story began (0 = stranger). Depth from card+scene: a 5-year partner ≈ 15-18, a new colleague ≈ 2-3, a sworn arch-enemy ≈ -6..-9
trust=<-5..20>           # trust already established (negative ONLY for betrayal in the shared history)
route=<emoji + 1-4 word name>   # this pair's story genre; emoji from: 🌱🌸💐🌹🕊️🪶🧸🏠🔮🧵🧲🌙✨⏳🌅🕰️⚔️🔥🗡️🩸⛓️🏹⚡🕸️🕯️🥀🌑🕳️💀🪞🧨🚪❄️🧊🌊🌫️🐦🌉🎭🎲🤝🫂🛡️🎓🐉🩹💍👑🎶🧪🍂🍯🗝️🐍🌘⚓
condition=<emoji WORD>   # emotional weather: 💚 STABLE 💛 SHIFTING 💔 HEARTBROKEN 🖤 BETRAYED 💢 RESENTFUL 🔥 PASSIONATE ❄️ COLD 🫧 INFATUATED 🩹 MENDING ⛓️ OBSESSED 😶 NUMB 🌧️ GRIEVING 🤝 RECONCILING ⚡ VOLATILE
likes=a|b|c              # 1-3 things the user would ALREADY know delight them (pre-existing relationships only; omit for strangers)
dislikes=a|b|c           # 1-3 already-known turn-offs (same rule)
threshold=<text>         # the concrete open moment the relationship is moving toward, if the story shows one

RULES:
- Ground every value in the card or the scene. "Served the family for twenty years" justifies a deep bond; a first meeting does not — leave bond omitted (defaults to 0).
- NEVER ground values in wishes. A hostile card stays hostile even if the scene was polite.
- Omit lines you cannot ground. Silence is correct.`;

    try {
        const reply = await cheapCall(ORIGIN_SYSTEM, prompt, 300);
        const applied = applyOrigin(cell, String(reply || ''));
        markRelStamps();
        console.log(`${LOG_PREFIX} origin call for ${cell.name}: ${applied || 'nothing grounded'}`);
        return true;
    } catch (err) {
        console.warn(`${LOG_PREFIX} origin call failed for ${cell.name} (stays at default):`, err);
        return false;
    }
}

/**
 * Apply an origin reply (key=value lines) to a cell. Exported for testing.
 * Only the engine's own clamps apply (−10..+20) — no soft caps.
 */
export function applyOrigin(cell, reply) {
    const r = ensureRel(cell);
    if (!r) return '';
    const applied = [];
    const clampBond = (v) => Math.max(-10, Math.min(20, Number(v) || 0));
    const clampTrust = (v) => Math.max(-5, Math.min(20, Number(v) || 0)); // trust keeps its own floor
    const list3 = (raw) => String(raw || '').split(/[|,]/).map(s => s.trim()).filter(Boolean).slice(0, 3);
    for (const line of String(reply || '').split('\n')) {
        const m = line.match(/^\s*(bond|trust|route|condition|likes|dislikes|threshold)\s*=\s*(.+?)\s*$/i);
        if (!m) continue;
        const key = m[1].toLowerCase();
        const raw = m[2].replace(/^["']|["']$/g, '').trim();
        switch (key) {
            case 'bond': {
                const v = clampBond(raw);
                if (v !== 0 || String(raw).trim() === '0') { cell.bonds.user = v; applied.push(`bond ${v}`); }
                break;
            }
            case 'trust': {
                const v = clampTrust(raw);
                r.trust = v;
                applied.push(`trust ${v}`);
                break;
            }
            case 'route': {
                const p = parseRoute(raw);
                if (p) { r.route = `${p.emoji} ${p.name}`; applied.push(`route ${r.route}`); }
                break;
            }
            case 'condition': {
                const c = parseCondition(raw);
                if (c) { r.condition = c; applied.push(`condition ${c}`); }
                break;
            }
            case 'likes':
            case 'dislikes': {
                for (const item of list3(raw)) {
                    if (!r[key].some(x => x.toLowerCase() === item.toLowerCase())) r[key].push(item);
                }
                applied.push(`${key} ${r[key].join('|')}`);
                break;
            }
            case 'threshold': {
                if (raw) { r.threshold = raw; applied.push(`threshold "${raw.slice(0, 40)}"`); }
                break;
            }
        }
    }
    return applied.join(', ');
}
