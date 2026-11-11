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
| `bookkeeper.js` | The post-reply state updater: a cheap second model call that reads the new scene and emits change commands, which are applied to the state. No UI. |
| `tiers.js` | Tier auto-detection: rolling participation log from the bookkeeper's `appear()` commands, score bands → tier, hysteresis, manual pin/unpin. No UI. |
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

### Witness filtering (the memory-mixing fix)

For each main/secondary NPC the CAST line carries `Knows ONLY:` — the `what` of
every ledger event that NPC witnessed (`eventsKnownTo`). Facts the character never
saw are never in its context, so the model *cannot* leak them — enforced by
retrieval filtering, not by instruction. Minor cells get one compact line (no
knowledge list); offstage cells are omitted entirely.

Known trade-offs:
- In a multi-NPC scene the model still sees every on-stage character's line (it
  writes all of them, like a novelist); the filter guarantees each *line* contains
  only what that character knows. A true per-perspective rebuild (whole block from
  one character's knowledge) is planned for single-voice generation.
- Memories stay intact forever; only the injected view is filtered and capped
  (12 events per line). Pruning is a future, explicit, user-approved action.

### bookkeeper.js — the state updater (slice 3)

After each AI reply (MESSAGE_RECEIVED + a configurable delay, default 1.5s), one
cheap model call runs through `generateRaw()` — a raw, preset-free call with its own
system prompt, mirroring Summaryception's clean-call isolation. The prompt carries:

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
chekhov(x123, fired) / turn()
```

Parsing is defensive: commands are matched against a strict grammar, cell ids are
resolved leniently (id → slug → exact name → substring), invalid commands are
skipped with a console note — a malformed reply can never crash the turn. Applied
commands are logged (`console.info`), trigger `updateInjection()` and a chat save.
Failures show a toast at most once per 5 minutes and never block the chat.

The pass is OFF by default; `/cc-bookkeeper on|off` toggles it (persisted in
`extension_settings.character_cells`).

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

## Data flow

```
                 hand edits (panel / slash commands)
                              │
                              ▼
state.js ──► chat_metadata ──► saveChatDebounced (SillyTavern native)
   │                              ▲
   │                              │ saveChatDebounced after applied commands
   │           bookkeeper.js ─────┘
   │             │ generateRaw (preset-free second call, after each AI reply)
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

- **Perspective rebuild** — injecting the whole block from ONE character's
  knowledge for single-voice generation (full hard-wall filtering).
- **Pruning** — memories are kept forever; explicit, user-approved compression of
  old low-importance events is a future slice.
- **Prose-only companion preset** — the FF 5.4 preset still carries its own
  internal-states prompts; running both would double-bookkeep. Until the companion
  preset exists, test with a preset that has the FF internal-states prompts removed.
- NPC inventories have no panel view yet (the data is stored per cell; the USER
  drawer shows only the user's).
