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
| `state.js` | The state store: schema factories, lazy creation, mutations (add/remove/tier/memory), the fixed-user-cell invariant. |
| `render.js` | Builds the panel HTML from state — FF5 internal-states look: colored `<details>` sections, dense "Label: value" lines, bond progress bars. No state logic. |
| `inject.js` | Builds the injected prompt block from state and registers it with SillyTavern. No UI. |

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
  `/cc-demote` (both refuse the fixed user cell by flag), `/cc-stats`,
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

For each main/secondary NPC the CAST line carries `Knows ONLY:` — that NPC's own
memories plus memories in other cells where it appears in `witnesses`. Facts the
character never saw are never in its context, so the model *cannot* leak them —
enforced by retrieval filtering, not by instruction. Minor cells get one compact
line (no knowledge list); offstage cells are omitted entirely.

Known trade-off: this filter is only as good as the memories recorded. Until the
bookkeeper pass (below) writes memories automatically, the filter reflects whatever
was hand-entered.

---

## Data flow

```
                 hand edits (panel / slash commands)
                              │
                              ▼
state.js ──► chat_metadata ──► saveChatDebounced (SillyTavern native)
   │
   └──► inject.js: updateInjection()
              │  on: CHAT_CHANGED, MESSAGE_SENT/RECEIVED/DELETED/SWIPED,
              │      and GENERATION_STARTED (makeLast, so it always runs)
              ▼
        setExtensionPrompt ──► every generation's prompt (depth 4, in-chat)
```

Panel redraws happen only on CHAT_CHANGED and after local edits — not on incoming
messages, to protect in-progress editing.

## What is NOT built yet (next slices)

- **Bookkeeper pass** — after each AI reply, a cheap second model call reads the new
  scene text + a state summary and emits change commands (`witness(...)`,
  `bond(+1, ...)`, `agenda_step(...)`, `memory_add(...)`), which the app applies to
  the JSON. Until then the state only changes by hand.
- **Tier auto-detection** — tiers are manual; the engine does not yet track who is
  on-screen/spoke/acted.
- **Prose-only companion preset** — the FF 5.4 preset still carries its own
  internal-states prompts; running both would double-bookkeep. Until the companion
  preset exists, test with a preset that has the FF internal-states prompts removed.
- NPC inventories have no panel view yet (the data is stored per cell; the USER
  drawer shows only the user's).
