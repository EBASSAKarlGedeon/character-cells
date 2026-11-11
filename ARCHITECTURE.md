# Character Cells — Architecture

A Loreweaver extension that moves the FF5 "Internal States" preset into app-owned
state. Instead of the AI regurgitating a state block every turn (expensive, drifts,
and leaks knowledge between characters), the app stores the state as structured JSON
and injects exactly what each character may know into every prompt.

**Core principle:** *the app owns the state; the model only proposes changes to it.*

Spec (design decisions and rationale): `docs/CHARACTER-CELLS-SPEC.md` in the
Loreweaver repo. This document describes what is actually built.

---

## Where the data lives

One JSON object per chat, stored under `chat_metadata.character_cells`:

```json
{
  "version": 1,
  "world": {
    "notes": [], "factions": [], "quests": [], "chekhov": [],
    "roll": {}, "combat": {}, "env": "", "physics": "",
    "time": "", "turn": 0
  },
  "cells": [ /* one per character, user included */ ]
}
```

Why chat metadata: SillyTavern already saves it with the chat, syncs it to other
devices, and snapshots it on branch switches — zero new plumbing, no extra files.

A **cell** is one character:

```json
{
  "fixed": false,
  "id": "sylpha",
  "name": "Sylpha",
  "tier": "main",                     // main / secondary / minor / offstage
  "identity": "Gentle, maternal maid",
  "archetype": "",                    // reserved for the personality model (later)
  "bonds": { "user": 8, "sparks": 0, "grudge": 0 },
  "agenda": { "goal": "...", "step": 0, "max": 0, "location": "" },
  "status": "healthy",
  "aware": [], "fibs": "", "circle": [],
  "inventory": [], "titles": [], "mods": "",
  "thoughts": "",
  "memories": [ { "id": "m...", "what": "...", "witnesses": ["sylpha"], "importance": 2, "turn": 41 } ]
}
```

### The user cell

Exactly one cell always has `fixed: true` — the user. It is created lazily on first
state access and can never be promoted, demoted or deleted. **It is identified by the
`fixed` flag, never by the literal id `"user"`** — its id is the slug of the persona
name (e.g. `gedeon`). Identifying by id was the original approach and caused a bug
where every state read re-added a duplicate user cell; `getState()` now collapses any
old duplicates on load. The user cell is excluded from NPC sections in the panel and
from the NPC cast lines in the injected block — the user is not an NPC.

---

## Files

| File | Role |
|---|---|
| `manifest.json` | Extension manifest (name, version, entry point). |
| `index.js` | Entry point. Panel plumbing, edit routing, buttons, events, slash commands. |
| `state.js` | The state store: schema factories, lazy creation, mutations (add/remove/tier/memory), the fixed-user-cell invariant, and the shared event ledger. |
| `render.js` | Builds the panel HTML from state — FF5 internal-states look: colored `<details>` sections, dense "Label: value" lines, bond progress bars. No state logic. |
| `inject.js` | Builds the injected prompt block from state and registers it with SillyTavern. No UI. |
| `bookkeeper.js` | The post-reply state updater: a cheap second model call that reads the new scene and emits change commands — including creating characters, factions and quests — which are applied to the state. No UI. |
| `llm.js` | The shared cheap-call doorway: routes every background model call (bookkeeper, backfill, digests) through the selected Connection Manager profile when one is set, falling back to `generateRaw()` on the active connection. |
| `tiers.js` | Tier auto-detection: rolling participation log from the bookkeeper's `appear()` commands, score bands → tier, hysteresis, manual pin/unpin. No UI. |
| `rel.js` | Relationship layer (slice 9): the code-owned vocabularies (route emoji palette, conditions, warm/cold ladders, tangled stages), the BOND-derived stage with tangled-pin support, trust as the bookkeeper's judgment-only number, drift labels, and the route/condition parsers. The panel's route cards render from this. |
| `commands.js` | The bookkeeper command grammar — ONE parser + applier shared by the live bookkeeper and the backfill, so the two can never drift. Includes the auto-creation ops (`char_add`, `faction_add`, `quest_add`) and the `AUTO_CREATE_CAP`. |
| `ledger-browser.js` | The Extensions-panel drawer ("Character Cells"): the bookkeeper profile dropdown + bookkeeper/auto-create toggles on top, then the event ledger browser — filters (text/witness/importance), inline edits (what/imp/turn/witnesses), manual delete/add — the only place an event can be removed, and only by hand. |
| `backfill.js` | Strip-copy (chat copy with old internal-states blocks removed; carries over existing cell state) + ledger backfill from chat history in batches — seeded mode after an import, cast-creating otherwise. |
| `import-states.js` | Deterministic import of the most recent FF5 `<internal_states>` block in the open chat: pure parser (testable without ST) + seeding into cells/world. No model call. |
| `tick.js` | The pre-generation engine: referee, task resolution, agendas, bonds, Chekhov fire gates, World Sim — mechanics resolve BEFORE the narrator writes. Hooked on GENERATION_AFTER_COMMANDS; runs once per generation (quiet prompts/dry runs guarded). No UI. |
| `digest.js` | Option C memory: LANDMARKS (imp-3, always injected verbatim) + per-cell digests of everything older than the hot window. The ledger stays immutable. |
| `settings.js` | The single extension settings object (`extension_settings.character_cells`) shared by all modules, so they don't clobber each other's keys. |

### The event ledger (slice 3)

Memories live in ONE shared list on the state: `state.ledger`, an array of events
`{ id, what, witnesses: [cellId], importance: 1-3, turn }`. Every event is stored
exactly once, tagged with the cells that witnessed it. Per-character knowledge is
**derived, never copied**: injection filters the ledger by witness
(`eventsKnownTo(cellId)`), so "store shared, show filtered". Witness lists are
additive only — a later `witness(...)` command can add a character, but no command
ever widens an existing list implicitly (Summaryception's rule, adopted).
`/cc-event` adds events by hand; `/cc-ledger` lists the ledger.

### state.js — the store

- `getState()` — the single doorway to the state. Lazily creates it (and the user
  cell) on first access; repairs missing world arrays on old chats; collapses
  duplicate user cells. Everything else mutates the object it returns; persistence
  rides on SillyTavern's existing `saveChatDebounced()`.
- `hasState()` — reads without creating. Used by the injector so that chats which
  never touch the extension inject nothing.
- `makeCell()` / `makeWorldState()` — schema factories, single source of truth for
  what a fresh cell/world looks like.
- Mutations: `addCell` (dedups by slug), `setTier`, `removeCell` (both refuse the
  fixed user cell), `addMemory` (dedups by text within a cell).

### render.js — the panel

`renderStateHtml(state)` → one HTML string. Pure function of the state: sections are
built from data, the user cell is found by the `fixed` flag, NPC sections
(agendas/locations/bonds/cast/thoughts) iterate only non-fixed cells. All drawers
(`<details>`) render closed by default. Editable values are `contenteditable` spans
tagged `data-field="..."`; the containing item is tagged `data-cell-id` /
`data-user-cell` so edits can be routed back.

### index.js — the glue

- **Panel** opens as a jQuery dialog (`openPanel`) from two doors: the wand-menu
  button and the per-message icon. `refreshPanelIfOpen()` redraws after edits; it is
  deliberately *not* called on message events (redrawing mid-generation would wipe
  in-progress hand edits).
- **Edit routing** (`bindPanelEvents` → `applyField`): one `change` handler maps
  `data-field` values back into the state object, with scope resolution —
  `[data-user-cell]` → the fixed cell, `[data-cell-id]` → that cell, plus faction /
  quest / chekhov / note scopes. After every edit: `saveChatDebounced()`.
- **Events** (see "Data flow" below).
- **Slash commands**: `/cc-state` (open panel), `/cc-add`, `/cc-promote`,
  `/cc-demote` (both pin the tier — auto-tiering stops touching the cell),
  `/cc-autotier` (on/off/now/release-pin), `/cc-stats`,
  `/cc-inject` (preview / toggle the injected block).

### inject.js — the prompt injection

- `buildStateBlock()` → the exact text the model receives, or `''` when there is
  nothing to inject. Sections, in order: header instruction, CAST (tier-sorted,
  knowledge-filtered), USER, FACTIONS, QUESTS, GM NOTES, active CHEKHOV plants, DND
  TASK SIM (when a task exists), COMBAT (when not N/A), WORLD, TURN. Empty sections
  are skipped so a fresh chat injects nothing.
- `updateInjection()` — registers the block via SillyTavern's
  `setExtensionPrompt(key, value, IN_CHAT, depth 4, SYSTEM)`, or unregisters it
  (position NONE) when empty or disabled. Depth 4 places the block just above the
  last few chat messages: volatile content sits at the end of the prompt, so the
  stable prefix (preset, card, lorebook) keeps its provider cache.

### Perspective rebuild (Main Character mode)

`buildPerspectiveBlock()` rebuilds the ENTIRE block from one main-tier
character's knowledge for single-voice generation — the hard wall. Facts the
character doesn't hold are not in the prompt at all:

- **YOU (<name>)** — the POV character's full own cell (their inner life is
  theirs to use).
- **OTHERS, AS YOU KNOW THEM** — observable sketch only: identity + body
  condition. No bonds, agendas, thoughts or inventories of others.
- **WHAT YOU KNOW** — the ledger filtered to this character's witness list.
- **USER** — titles and condition only (observable from outside), not
  inventory/mods.
- World sections via `pushWorldSections(L, world, { perspective: true })`:
  faction **intel/fibs dropped**, **secret Chekhov plants dropped**,
  **GM NOTES dropped entirely** (author tools — there is no way to know which
  notes the character has seen).

It applies only in **Main Character mode** (`/cc-mode main`), and only when
exactly one non-fixed cell is main-tier — otherwise `updateInjection()` falls
back to the omniscient block (logged in the console). In group narration the
model voices several characters from one prompt, so the omniscient block
remains the default there; a per-character perspective for group scenes is a
possible future addition.

### Witness filtering (the memory-mixing fix)

For each main/secondary NPC the CAST line carries `Knows ONLY:` — the `what` of
every ledger event that NPC witnessed (`eventsKnownTo`). Facts the character never
saw are never in its context, so the model *cannot* leak them — enforced by
retrieval filtering, not by instruction. Minor cells get one compact line (no
knowledge list); offstage cells are omitted entirely.

Known trade-offs:
- In a multi-NPC scene the model still sees every on-stage character's line (it
  writes all of them, like a novelist); the filter guarantees each *line* contains
  only what that character knows. The perspective rebuild (Main Character mode)
  closes this fully for single-voice generation.
- Memories stay intact forever; only the injected view is filtered, tiered
  (landmarks / recent / digest) and capped.

### bookkeeper.js — the state updater (slice 3)

After each AI reply (MESSAGE_RECEIVED + a configurable delay, default 1.5s), one
cheap model call runs through `cheapCall()` (llm.js — Connection Manager profile
or preset-free `generateRaw` fallback) with its own system prompt, mirroring
Summaryception's clean-call isolation. The bookkeeper sees NO character card, no
lorebook, no chat history — only:

1. **Current state summary** — compact JSON: cells (id/name/tier/bonds/agenda/
   status), the last 20 ledger events *with ids*, chekhov plants, quests.
2. **The new scene text** — the last user message + the last AI reply only.
3. **Command grammar + rules.**

The bookkeeper outputs one command per line:

```
memory_add(what="...", who=sylpha,daichi, imp=2)   # new event + witnesses
witness(eK3x1, daichi)                             # existing event, new witness
bond(sylpha, user, +1)
agenda_step(sylpha) / agenda_set(sylpha, goal="...", location="...", max=3)
status(sylpha, "bruised") / presence(daichi, on|off)
char_add(name="Mira", desc="quiet archivist", present=offstage, location="the archive")
chekhov(x123, fired) / turn()
```

Parsing is defensive: commands are matched against a strict grammar, cell ids are
resolved leniently (id → slug → exact name → substring), invalid commands are
skipped with a console note — a malformed reply can never crash the turn. Applied
commands are logged (`console.info`), trigger `updateInjection()` and a chat save.
Failures show a toast at most once per 5 minutes and never block the chat.

The pass is OFF by default; `/cc-bookkeeper on|off` toggles it (persisted in
`extension_settings.character_cells`, plus a checkbox in the Extensions drawer).

### Auto-creation (char_add / faction_add / quest_add)

With `settings.bookkeeperAutoCells` (default on, checkbox in the drawer) the
bookkeeper grammar gains three upsert commands, so a fresh chat builds its own
cast and the bookkeeper can grow factions/quests as the story establishes them:

- **`char_add(name, desc, present, location)`** — resolves the name through the
  SAME fuzzy matcher as every other command first (name variants like "Asahi" ↔
  "Asahi Ishikawa" merge into the existing cell; the fixed user cell is
  refused). Only a genuine new character creates a cell: tier `minor`,
  unpinned — auto-tier promotes it from real participation. `desc` fills the
  identity slot (one line, scene-derived — the bookkeeper cannot see the card,
  so it cannot invent lore). `present=offstage` marks a named off-screen mover:
  their agenda location is set and they stay OUT of `state.present`, so the
  tick engine correctly treats them as off-screen.
- **`faction_add(name, goal, intel, state, conflict, relations)`** and
  **`quest_add(type, name, progress, reward)`** — upsert by (fuzzy) name:
  reusing an existing name updates the provided fields only, never duplicates.

Two belts against model junk:

1. **Two-pass application** — the runner applies `char_add` lines FIRST, then
   everything else, so a `memory_add`/`appear` in the same reply about a just-
   created character resolves instead of skipping. The backfill does the same.
2. **`AUTO_CREATE_CAP` (4)** — at most four new cells per call; the prompt
   states the cap and the runner enforces it. The prompt also forbids the
   user, groups/crowds, name-only mentions, and restating unchanged
   factions/quests.

### The cheap-call doorway (llm.js)

Every background model call — bookkeeper, backfill, digests — goes through
`cheapCall()` in `llm.js`. When `settings.bookkeeperProfileId` names a
Connection Manager profile, the call rides that profile via
`ConnectionManagerRequestService.sendRequest()` (the profile's API, key, model
and generation preset) **without switching the narrator's live connection** —
it is a one-off request, not a profile activation. A profile call that fails or
returns empty falls back to the active connection for that one call. With no
profile selected (the default), everything behaves as before: a preset-free
`generateRaw()` call on the active connection. The dropdown lives at the top of
the "Character Cells" drawer in the Extensions panel (Connection Manager's
`handleDropdown` — self-updating on profile create/update/delete); the
selection is persisted in extension settings and survives chat switches, since
it is a device-level choice, not per-chat state.

### Memory over a long chat: landmarks + digests (the ledger stays immutable)

The event ledger is never pruned, merged or rewritten — every event lives
forever. What ages is the *injected view*, in three tiers:

1. **LANDMARKS** — importance-3 events are injected verbatim, witness-filtered,
   no matter how old (most recent 10). A turn-300 boss fight still shows at
   turn 1000.
2. **Recent ring** — the newest 12 witnessed events (last ~40 turns),
   exactly as before.
3. **Digest** — everything older that isn't a landmark, summarized into ONE
   paragraph per cell by a cheap isolated `generateRaw` call, cached in
   `state.digests[cellId]` and rebuilt only when the cold event set changes
   (count + newest id). A failed rebuild keeps the last good digest; a bad
   digest loses nothing (`/cc-digest` forces a rebuild) because the ledger is
   complete underneath.

`/cc-digest` (stats / force rebuild) manages the cache; digests rebuild
automatically during injection when stale.

### tick.js — the pre-generation engine (FF5 mechanics port)

Hooked on GENERATION_AFTER_COMMANDS (before prompt assembly, which script.js
awaits), so mechanics resolve BEFORE the narrator writes — one tick per
generation; quiet prompts and dry runs are guarded. The tick owns `world.turn`
(+1 per generation). What it runs:

- **Referee** — a cheap call reads the user's NEW message: a skilled action
  with a real failure condition queues `world.task` (actor, action, difficulty),
  an intimate NSFW exchange sets `world.worldsimSkip='next'` (World Sim pauses
  one turn).
- **Task resolution** — when a task was queued: DC locked within the difficulty
  band, a real d20 roll modified by bonds (≥+4 → −1 … ≥+15 → −4; ≤−3 → +2 …),
  inventory/title modifiers summed, crit bands on nat20/≥+8 and nat1/≤−8. The
  outcome lands in `world.roll` and the narrator writes to a decided result.
- **Off-screen agendas** — every cell NOT in `state.present` advances its
  agenda (+1/turn); completion applies effects (rest → heal + grudge cleared,
  reconcile → BOND+1, research → plants a W1 Chekhov seed), then refreshes to
  a mundane 1–3 step agenda.
- **Bond ticks** — every 5th turn a Sparks check (≥7 → BOND+1, else decay when
  no spark was gained since the last check); every 3rd turn a Grudge check
  (≥5 → BOND−1).
- **Chekhov gates** — bullets age +1/turn, prune at ≥12 (cap 20); the fire
  gate opens at age ≥4 with threshold = base (W1 18 / W2 13 / W3 8) − age −
  proximity from the last tier-log scene roles (spoke −2 / present −1); ≤5 d20
  checks per turn, highest-weight first; nat1 = jam (status fired + a fired
  note); nat20 grants −4 to the rest. `settings.autoChekhov` toggles this.
- **World Sim** — both tables roll per turn into `world.worldsim` (duo mode
  when ≤2 named NPCs are on stage or none are off-screen);
  `settings.worldSimEnabled` toggles it.
- **Fired bullets** surface for one turn as a "CHEKHOV FIRES — weave in now"
  injection (secrets hidden in perspective mode; standard-table results hidden
  there too). `/cc-worldsim on|off|now` is the user control.

### Converting an old FF5 chat (import → clean copy → backfill)

Old chats carry their omniscient internal-states HTML in every message — that
both wastes tokens and leaks what witness filtering is designed to hide. They
also contain their **final internal-states block** with exact values — re-
inferring those with a model would be strictly worse than parsing them. The
**CC TOOLS** drawer section in the panel runs three steps, IN THIS ORDER:

1. **Import state from internal states** (`import-states.js`) — scans the chat
   newest-message-first for the most recent `<internal_states>` block, splits
   it by `<summary>` section markers (no tag balancing — immune to formatting
   drift), and parses each section with lenient per-section regexes: parse
   what matches, skip what doesn't, never fail. Creates the NPC cells (names
   fuzzy-merged across sections — "Asahi" in LOCATIONS joins "Asahi Ishikawa"
   from AGENDAS; a name appearing only in BONDS still creates a cell), seeds
   exact bonds/agendas/locations/thoughts, the user cell's
   inventory/titles/status/mods, active+locked Chekhov bullets (fired/pruned
   are prose → skipped), notes, quests, factions, the last roll, combat,
   env/physics, and the TURN header value. No model call. Marks the state
   `imported = { turn, at }`.
2. **Clean copy** — creates a NEW chat file (original untouched) with every
   block stripped (GFX-wrapped form included; prose, dialogue, the
   time/location header and non-state GFX are kept) and switches to it.
   Since the import happens BEFORE cleaning and the HTML is gone from the
   copy's text, the copy **carries the existing cell state over** (deep-cloned;
   only the backfill progress resets) instead of resetting to fresh.
3. **Backfill** — walks the cleaned chat from turn 0 in batches of 4 messages,
   one cheap call per batch (Summaryception's backlog processing). Progress is
   checkpointed: cancelable, resumable, `backfill.done` prevents double runs.
   Tier detection is seeded from the full participation history at the end.
   - **Seeded mode** (automatic after an import): the grammar is LEDGER-ONLY
     (`memory_add` / `witness` / `appear` / `turn`) and a belt-and-braces
     filter (`SEEDED_OPS`) drops every accumulating command the model emits
   anyway — the imported final values are never double-counted. Relationship
   *moments* still land in the ledger as memories; only numeric re-counting is
   prevented.
   - **Normal mode** (fresh chats): the full grammar, now including
     `char_add` — the backfill creates the cast from history as it goes.
   - **Turn accounting** (all backfills): events stamp with a LOCAL virtual
     turn counter advanced by the `turn()` markers in the old text — real
     historical turns instead of everything stamped with the current
     `world.turn`, which stays untouched (e.g. at the imported 188).

`/cc-backfill` and `/cc-backfill cancel` do the same from the terminal.

### tiers.js — tier auto-detection

The bookkeeper also emits `appear(<cellId>, spoke|acted|present)` for every
participant in the scene (the user included). These are recorded on
`state.tierLog` — a rolling 30-scene participation log. Scoring:
spoke=3, acted=2, present=1; the rolling score maps to tier bands
(≥18 main, ≥9 secondary, ≥3 minor, below → offstage), and ≥6 consecutive
absent scenes force offstage. Hysteresis: a tier only changes after 2
consecutive turns agree (no flapping on one busy/quiet scene).

A cell that has never appeared in the log gets no suggestion (no data, no
demotion). Manual override **pins**: `/cc-promote`, `/cc-demote`, or the panel
tier dropdown set `tierPinned = true` — auto-tiering skips pinned cells until
`/cc-autotier <name>` (or the ♻ button in CAST & TIERS) releases the pin.
`/cc-autotier on|off|now` is the master switch / immediate recompute.

---

## The prose-only companion preset

The companion preset **"Freaky Frankenstein 5.4 Prose-Only (Character Cells)"**
(in `OpenAI Settings/`) is the Character Cells build of the FF 5.4 preset: the
internal-states prompts (the `<internal_states>` master block, bond tracker,
agenda tracker, GM's Notebook, inventory, thoughts, CoTs) are removed there, so
the app-owned injection block is the only state tracking. Use this preset for
testing and normal play — the original FF 5.4 Internal States preset would
double-bookkeep against the extension.

---

## Data flow

```
                 hand edits (panel / slash commands)
                              │
                              ▼
state.js ──► chat_metadata ──► saveChatDebounced (SillyTavern native)
   │                              ▲
   │                              │ saveChatDebounced after applied commands
   │           bookkeeper.js ─────┘
   │             │ cheapCall (Connection Manager profile / generateRaw fallback, after each AI reply)
   │             ▼
   └──► inject.js: updateInjection()
              │  on: CHAT_CHANGED, MESSAGE_SENT/RECEIVED/DELETED/SWIPED,
              │      bookkeeper results, and GENERATION_STARTED (makeLast)
              ▼
        setExtensionPrompt ──► every generation's prompt (depth 4, in-chat)
```

Panel redraws happen only on CHAT_CHANGED and after local edits — not on incoming
messages, to protect in-progress editing.

## What is NOT built yet (next slices)

- **Perspective rebuild for group scenes** — the per-character hard wall exists
  in Main Character mode only; a "reply as X" action inside group narration is
  a possible later addition.
- **RPG/Dungeon mode** — deeper game-loop structures beyond the FF5 mechanics
  the tick engine already ports.
- **Tuning** — Chekhov thresholds and whether the World Sim standard table
  stays, both pending hand-testing feel.
