// Character Cells — bookkeeper pass (slice 3)
// After each AI reply, a second cheap model call reads the new scene text plus a
// compact summary of the current state, and emits change commands (one per line).
// The app parses them and applies the valid ones to the state JSON. The narrator
// model never touches state; the bookkeeper never writes prose.
//
// The call goes through generateRaw() with its own system prompt — no chat history,
// no preset formatting — mirroring Summaryception's "clean call" isolation.
// The command grammar lives in commands.js (shared with the backfill).

import { chat, saveChatDebounced, eventSource, event_types } from '../../../../script.js';
import { getState, getLedger, chatToken, sameChat } from './state.js';
import { updateInjection } from './inject.js';
import { parseCommand, applyCommand, AUTO_CREATE_CAP } from './commands.js';
import { stageOf, markRelStamps } from './rel.js';
import { logScene, applyAutoTier } from './tiers.js';
import { seedOrigin } from './origin.js';
import { initSettings, getSettings, persistSettings } from './settings.js';
import { cheapCall } from './llm.js';
import { LOG_PREFIX } from './config.js';

// ---------------------------------------------------------------- settings

const settings = { bookkeeperEnabled: false, bookkeeperDelayMs: 1500, bookkeeperAutoCells: true };

/** Called by index.js at init (settings themselves live in settings.js). */
export function initBookkeeper(extension_settings) {
    initSettings(extension_settings);
    Object.assign(settings, {
        bookkeeperEnabled: getSettings().bookkeeperEnabled,
        bookkeeperDelayMs: getSettings().bookkeeperDelayMs,
        bookkeeperAutoCells: getSettings().bookkeeperAutoCells !== false,
    });
}

let busy = false;
let lastErrorShown = 0;

export function isBookkeeperEnabled() {
    return settings.bookkeeperEnabled;
}

export function setBookkeeperEnabled(v) {
    settings.bookkeeperEnabled = !!v;
    getSettings().bookkeeperEnabled = settings.bookkeeperEnabled;
    persistSettings();
}

// ---------------------------------------------------------------- prompts

/** Compact JSON-ish dump of the state the bookkeeper needs to see. Shared with the backfill. */
export function buildStateSummary() {
    const s = getState();
    const world = s.world || {};
    const out = { turn: world.turn || 0 };
    out.cells = (s.cells || []).map(c => {
        const base = {
            id: c.id, name: c.name, tier: c.tier,
            bonds: c.bonds, agenda: c.agenda, status: c.status,
        };
        // Relationship layer (slice 9): show the card fields the bookkeeper maintains.
        if (c.rel) {
            base.rel = {
                stage: stageOf(c), trust: c.rel.trust ?? 0,
                condition: c.rel.condition || '', route: c.rel.route || '',
                likes: c.rel.likes || [], dislikes: c.rel.dislikes || [],
                keepsake: c.rel.keepsake || '', threshold: c.rel.threshold || '',
                severed: !!c.rel.severed,
            };
        }
        return base;
    });
    const ledger = getLedger();
    if (ledger.length) {
        // Recent events WITH ids, so the bookkeeper can attach witnesses to them.
        out.recent_events = ledger.slice(-20).map(e => ({ id: e.id, what: e.what, w: e.witnesses }));
    }
    if ((world.chekhov || []).length) {
        out.chekhov = world.chekhov.map(c => ({ id: c.id, text: c.text, status: c.status || 'active' }));
    }
    if ((world.quests || []).length) out.quests = world.quests;
    if ((world.notes || []).length) {
        out.notes = world.notes.map(n => ({ id: n.id, type: n.type, text: n.text }));
    }
    return JSON.stringify(out);
}

const SYSTEM_PROMPT = `You are a state tracker for a roleplay session. You read a short scene and the current tracked state, then output state-change commands. You never write prose, never narrate, never comment. Output ONLY command lines, one per line, in the exact grammar given. If nothing in the scene changes the state, output nothing.`;

function buildBookkeeperPrompt(sceneText) {
    const createGrammar = settings.bookkeeperAutoCells ? `
char_add(name="...", desc="...", present=onstage|offstage, location="...")  # a NEW named character — create their cell BEFORE any other command about them
faction_add(name="...", goal="...", intel="...", state="...", conflict="...", relations="...")  # create or update a faction (reuse the exact existing name to update)
quest_add(type=Main|Side, name="...", progress="...", reward="...")          # create or update a quest (reuse the exact existing name to update)
` : '';
    const createRules = settings.bookkeeperAutoCells ? `
- char_add: when a NEW NAMED character takes part — onstage (spoke, acted, clearly present), or present=offstage ONLY when the scene establishes a named character acting from off-screen (a report arrives, a remote force moves — include their location). Emit char_add lines FIRST, then any other commands about that character.
- NEVER char_add: the user; groups/crowds/guards ("the villagers" is not a character); someone only mentioned by name who takes no part; anyone already in CURRENT STATE (use their existing id instead).
- desc: ONE line, strictly from what the scene shows (appearance, role, behavior). Never invent backstory.
- At most ${AUTO_CREATE_CAP} new characters per scene; prefer those with dialogue.
- faction_add / quest_add: only when the scene establishes one or materially changes it; update by reusing the exact existing name; omit fields you don't know. Do not restate unchanged factions/quests.` : '';
    return `CURRENT STATE (JSON):
${buildStateSummary()}

NEW SCENE (the latest exchange that just happened):
${sceneText}

OUTPUT GRAMMAR — one command per line, nothing else:
memory_add(what="...", who=<cellId>,<cellId>,... , imp=<1-3>)   # an event worth remembering; who = every character present who saw it (use cell ids from CURRENT STATE)
witness(<eventId>, <cellId>)                                    # an existing event (from recent_events) that this character also witnessed now
bond(<cellId>, sparks|grudge, <+1|-1|+2|-2>)                    # relationship shift the scene shows
bond(<cellId>, user, <-1|-2>)                                   # direct BOND DROPS ONLY (insult −1, betrayal/cruelty −2)
agenda_step(<cellId>)                                           # this NPC advanced one step toward their agenda goal
agenda_set(<cellId>, goal="...", location="...", max=<n>)       # set/change an NPC's agenda (1-3 mundane steps by default)
status(<cellId>, "...")                                         # body/condition change (injured, drunk, wet, ...)
presence(<cellId>, on|off)                                      # character entered or left the scene
appear(<cellId>, spoke|acted|present)                           # this character took part in THIS scene: spoke = had dialogue, acted = did something on stage, present = visible but passive. One line per participating character.
inv(<cellId>, +item|-item)                                      # item gained or lost (weapons, tools, keys, consumables)
title(<cellId>, +name|-name)                                    # story title/skill earned or lost (e.g. "Charmer", "Slayer")
thought(<cellId>, "...")                                        # 1-2 lines of raw, impulsive inner thought matching this NPC's persona (max 3 NPCs per turn)
plant(text="...", weight=<1-3>, secret=<true|false>)            # the story planted a promise/setup/secret/foreshadow worth paying off later
chekhov(<chekhovId>, active|locked|fired)                       # plant state change — fired ONLY when the scene actually resolved the planted element
trust(<cellId>, <+1|-1|+2|-2>)                                  # the NPC's TRUST in the user rose/fell — earned evidence only (see REL RULES)
rel(<cellId>, condition|route|likes|dislikes|keepsake|threshold|severed|stage, "...")   # relationship-card field (see REL RULES)${createGrammar}

RULES:
- Only what the scene text actually shows. No speculation.
- Cell ids MUST come from CURRENT STATE. Never invent ids.${createRules}
- who lists for memory_add: every character who witnessed the event, comma-separated. Never widen who on an event that already exists — use witness() instead.
- appear: emit for EVERY character who took part, exactly once each. The user counts too — use their cell id.
- imp: 3 = plot-critical, 2 = notable, 1 = minor color.
- BOND never rises directly: positive relationship shifts are Sparks (affection); only real insults/betrayals lower BOND directly. Sparks/Grudge are judged from the acting character's own knowledge and perspective — misreadings are allowed.
- Do NOT emit task commands — the dice are rolled before the scene is written; outcomes you read are already decided.
- thought: never mind-read the user, never interpret the user's meaning as fact — interpretations belong to the NPC and may be wrong.
- plant: only genuine unresolved narrative debt (promises, scheduled events, secrets, setups). 1-2 per turn max; most turns none.
- REL RULES — relationships move SLOWLY. Most turns emit NO trust/rel lines at all; emit one only when the scene shows the concrete on-screen moment that earned it, never for ordinary pleasant conversation. trust is SEPARATE from heart: rises only for kept promises, protection, honesty; falls on betrayal or broken trust; it rebuilds across scenes, never in one conversation. Never try to raise BOND yourself (sparks do that). likes/dislikes: append-only DISCOVERIES — only what the user saw happen on screen this scene, one new entry each, max. threshold: the CONCRETE next moment that would move this bond (a confession, a rescue, a shared meal in silence), never a vague feeling; rewrite it when the stage moves. route: "<palette emoji> <1-4 word name>" — palette: 🌱🌸💐🌹🕊️🪶🧸🏠🔮🧵🧲🌙✨⏳🌅🕰️⚔️🔥🗡️🩸⛓️🏹⚡🕸️🕯️🥀🌑🕳️💀🪞🧨🚪❄️🧊🌊🌫️🐦🌉🎭🎲🤝🫂🛡️🎓🐉🩹💍👑🎶🧪🍂🍯🗝️🐍🌘⚓ — change the route only when the story truly turns. condition: emotional weather — 💚 STABLE 💛 SHIFTING 💔 HEARTBROKEN 🖤 BETRAYED 💢 RESENTFUL 🔥 PASSIONATE ❄️ COLD 🫧 INFATUATED 🩹 MENDING ⛓️ OBSESSED 😶 NUMB 🌧️ GRIEVING 🤝 RECONCILING ⚡ VOLATILE — may shift while the stage stays put. stage: pin a TANGLED stage only (Complicated|Codependent|Estranged|Rivals|Frenemies|Unrequited|Forbidden). severed=true ONLY for a real ending of the relationship.
- REL AUDIT before finishing: re-read every trust/rel line you emitted; each must be backed by an on-screen moment you can point to. If you cannot point to one, remove that line.
- No explanations, no blank commentary. Commands only.`;
}

// ---------------------------------------------------------------- execution

/** The scene text = the last user message + the last AI reply (the exchange just finished). */
function buildSceneText() {
    const msgs = [];
    for (let i = chat.length - 1; i >= 0 && msgs.length < 2; i--) {
        const m = chat[i];
        if (m.is_system) continue;
        msgs.unshift(`${m.is_user ? getState().cells.find(c => c.fixed)?.name || 'User' : 'AI'}: ${String(m.mes || '').trim()}`);
    }
    return msgs.join('\n\n');
}

async function runBookkeeper(token) {
    if (busy || !settings.bookkeeperEnabled) return;
    if (!sameChat(token)) { console.warn(`${LOG_PREFIX} bookkeeper skipped: chat changed before the pass started`); return; }
    const sceneText = buildSceneText();
    if (!sceneText) return;
    busy = true;
    try {
        // 2048, not 400: thinking models spend reasoning tokens out of the SAME
        // max_tokens budget — at 400 the completion truncated mid-command and
        // memory_add lines were silently dropped (llm.js note; cf. lorebook-forge).
        const reply = await cheapCall(SYSTEM_PROMPT, buildBookkeeperPrompt(sceneText), 2048);
        // B1: the chat may have been switched (or state rewound) during the call —
        // everything below reads LIVE globals, so abort rather than write elsewhere.
        if (!sameChat(token)) { console.warn(`${LOG_PREFIX} bookkeeper aborted: chat changed during the call — nothing applied`); return; }
        const lines = String(reply || '').split('\n').map(l => l.trim()).filter(Boolean);
        const turn0 = Number(getState().world.turn) || 0;
        const sceneRoles = {};
        const applied = [];
        // Two passes: char_add FIRST (new cells must exist before memory_add/
        // appear reference them), everything else second. Cap creations.
        const cmds = lines.map(parseCommand).filter(Boolean);
        const creates = [], rest = [];
        for (const cmd of cmds) (cmd.op === 'char_add' ? creates : rest).push(cmd);
        const opts = { relCounts: {}, createdCellIds: [] }; // per-run caps + birth reports (slice 9)
        let created = 0;
        for (const cmd of creates) {
            if (!settings.bookkeeperAutoCells) { applied.push('skip: auto-create off'); continue; }
            if (created >= AUTO_CREATE_CAP) { applied.push(`skip: char_add cap (${AUTO_CREATE_CAP}/call)`); continue; }
            try {
                const r = applyCommand(cmd, turn0, sceneRoles, opts);
                if (r && r.startsWith('char_add:') && !r.includes('already tracked')) created++;
                applied.push(r);
            } catch (e) {
                console.warn(`${LOG_PREFIX} bookkeeper command failed:`, cmd.op, e);
            }
        }
        for (const cmd of rest) {
            try {
                applied.push(applyCommand(cmd, turn0, sceneRoles, opts));
            } catch (e) {
                console.warn(`${LOG_PREFIX} bookkeeper command failed:`, cmd.op, e);
            }
        }
        // Tier auto-detection: the appear() roles are this scene's participation record.
        if (Object.keys(sceneRoles).length) {
            // The scene's participants ARE the present set — keep it fresh so the
            // tick engine's off-screen detection is always grounded in the scene.
            const s = getState();
            s.present = Object.keys(sceneRoles);
            logScene(sceneRoles);
            applied.push(...applyAutoTier());
        }
        // Relationship layer: stamp the current stage as "seen" so the next
        // pass's drift label measures exactly what THIS pass changed.
        markRelStamps();
        // Origin calls (slice 9 follow-up): cells BORN this pass get their
        // pre-existing relationship seeded from the card + this scene. One cheap
        // call each, once per cell ever; failures just leave the default.
        for (const id of opts.createdCellIds) {
            if (!sameChat(token)) { console.warn(`${LOG_PREFIX} origin seeding aborted: chat changed`); return; }
            const cell = getState().cells.find(c => c.id === id);
            if (cell) await seedOrigin(cell, sceneText, token);
        }
        if (!sameChat(token)) return;
        if (applied.length) {
            console.log(`${LOG_PREFIX} bookkeeper applied (${applied.length} change(s)):\n  ` + applied.join('\n  '));
            updateInjection();
            saveChatDebounced();
        } else {
            console.log(`${LOG_PREFIX} bookkeeper ran: 0 changes this turn`);
        }
    } catch (err) {
        console.warn(`${LOG_PREFIX} bookkeeper call failed:`, err);
        // Surface repeated failures once per 5 minutes, never block the turn.
        if (Date.now() - lastErrorShown > 5 * 60 * 1000) {
            lastErrorShown = Date.now();
            toastr.warning('Bookkeeper call failed — state not auto-updated this turn.', 'Character Cells');
        }
    } finally {
        busy = false;
    }
}

export function initBookkeeperEvents() {
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        if (!settings.bookkeeperEnabled) return;
        const token = chatToken(); // B1: bound to the chat that produced this reply
        setTimeout(() => {
            runBookkeeper(token).finally(() => { if (sameChat(token)) saveChatDebounced(); });
        }, settings.bookkeeperDelayMs);
    });
}
