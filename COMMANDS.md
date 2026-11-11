# Character Cells — Command Reference

Every slash command the extension registers, what it does, and how to use it.
Type these in the chat input box (the same place you type messages) and press
Send. Nothing here is destructive: worst case the command answers with a usage
hint or a status line.

Tiers, from lowest to highest: **offstage → minor → secondary → main**.
The **user cell** (your persona) can never be promoted, demoted or deleted.

---

## Panel & state

### `/cc-state` (alias: `/cells`)
Opens the Character Cells panel — the editable drawer that looks like the old
FF5 internal-states block. Same as clicking the wand-menu button or the little
icon under a message's "…" menu.

```
/cc-state
```

### `/cc-add`
Adds a character to the state (or updates one that already exists — matching is
by name). The tier decides how much of that character reaches the prompt:
`main` gets a full cell, `secondary` a full line + knowledge list, `minor` one
compact line, `offstage` nothing.

```
/cc-add name=Kael tier=main
/cc-add name=Miyu            (tier defaults to minor)
```

### `/cc-stats`
One-line size report for the current chat: how many cells, memories, ledger
events, notes, and how big the state JSON is.

```
/cc-stats
→ cells=5 memories=23 events=41 notes=2 size=18.3KB
```

---

## Tiers

### `/cc-promote` / `/cc-demote`
Moves a character one step up / down the tier ladder **and pins them**: auto-tiering
stops touching that character until you release the pin (see `/cc-autotier`).
The panel's tier dropdown does the same thing.

```
/cc-promote Kael     → Kael promoted to main (pinned — /cc-autotier kael to release)
/cc-demote Miyu
```

### `/cc-autotier`
The tier auto-detection switch. Four uses:

```
/cc-autotier          status: ON/OFF + list of pinned characters
/cc-autotier on       enable auto-tiering
/cc-autotier off      disable auto-tiering
/cc-autotier now      recompute tiers immediately from the participation log
/cc-autotier Kael     release Kael's pin — auto-tiering manages them again
```

Auto-tiering reads the bookkeeper's `appear()` records (a rolling 30-scene log:
spoke=3 / acted=2 / present=1) and moves unpinned characters between tiers when
the last **two** scenes agree — one busy or quiet scene never flips a tier.

---

## The injected prompt block

### `/cc-inject`
Preview or toggle the exact block the narrator model receives every turn.

```
/cc-inject            prints the block as the model currently sees it
/cc-inject off        stop injecting (state is kept, nothing is sent)
/cc-inject on         start injecting again
```

---

## The bookkeeper (automatic state updates)

### `/cc-bookkeeper`
Toggles the bookkeeper pass: after each AI reply, a cheap second model call
reads the new scene and emits state-change commands. Off by default.

```
/cc-bookkeeper        status
/cc-bookkeeper on     enable
/cc-bookkeeper off    disable
```

**Which model runs the bookkeeper:** pick a **Connection Manager profile** in
the Extensions panel → "Character Cells" drawer → *Bookkeeper connection
profile*. All cheap calls (bookkeeper, backfill, digests) ride that profile
without changing your active connection. If the dropdown is empty, they use
whatever connection is currently active.

---

## The event ledger (shared memories)

### `/cc-event`
Adds one event to the shared ledger by hand — the same ledger the bookkeeper
writes to. `who` = every character who **saw it happen** (names or cell ids,
comma-separated; your persona name or `user` also works). `imp` 1 = minor
color, 2 = notable, 3 = plot-critical (**landmark** — injected verbatim no
matter how old).

```
/cc-event what="Kael found the hidden letter" who=Kael,Sylpha imp=2
/cc-event what="The bridge collapsed" who=user,Kael,Miyu imp=3
```

### `/cc-ledger`
Lists the whole shared ledger: event id, text, witnesses, importance, turn.

```
/cc-ledger
→ [eK3x1] Kael found the hidden letter — w: kael, sylpha (imp 2, turn 41)
  Total: 41 events, current turn 87
```

Ledger events can also be browsed, edited and deleted by hand in the
Extensions panel → "Character Cells" drawer (filters, inline edits, ✖ to
delete, and an add-row at the bottom). The ledger is never auto-pruned — only
you can remove events there.

---

## Perspective (Main Character mode)

### `/cc-mode`
Switches how the injected block is built.

```
/cc-mode main         ON — the whole block is rebuilt from ONE main-tier
                      character's knowledge. Facts they never witnessed are
                      absent from the prompt entirely. Needs exactly one
                      main-tier NPC; until then the omniscient block is used.
/cc-mode group        OFF — back to the omniscient block (normal group
                      narration).
/cc-mode              status, including whose perspective is active
```

---

## Memory aging (digests)

### `/cc-digest`
The three memory tiers are: **landmarks** (imp 3, verbatim forever), the
**recent ring** (newest 12 events verbatim), and **digests** — one cached
paragraph per character summarizing everything older. This command manages the
digest cache.

```
/cc-digest            stats: fresh / stale / needed, hot window, landmark cap
/cc-digest rebuild    throw away all cached digests and rebuild them now
```

Digests also rebuild automatically when they go stale. A bad digest loses
nothing — the ledger underneath is complete.

---

## Converting an old FF5 chat

### `/cc-backfill`
Rebuilds the event ledger (and cells/bonds/tiers) from the chat's full history,
walking from turn 0 in batches of 4 messages — one cheap call per batch. The
same thing as the **Backfill** button in the panel's CC TOOLS drawer.

Run the **Clean copy** button first (it makes a NEW chat with all old
internal-states HTML stripped and switches to it — the original chat is
untouched), then backfill the clean copy.

```
/cc-backfill          start (or resume a cancelled run)
/cc-backfill cancel   stop after the current batch — run again later to resume
```

A chat that finished a backfill is marked done and won't repeat it. Progress
shows in the panel while it runs, and tiers are seeded from the full
participation history at the end.

---

## Quick reference

| Command | What it does |
|---|---|
| `/cc-state` · `/cells` | open the panel |
| `/cc-add name=X tier=…` | add/update a character |
| `/cc-promote X` / `/cc-demote X` | tier up/down + pin |
| `/cc-autotier` | on / off / now / release-pin / status |
| `/cc-inject` | preview / on / off the injected block |
| `/cc-bookkeeper` | on / off / status of auto state updates |
| `/cc-event what=… who=… imp=…` | add a ledger event by hand |
| `/cc-ledger` | list the shared event ledger |
| `/cc-mode` | main / group perspective |
| `/cc-digest` | digest stats / rebuild |
| `/cc-backfill` | start/resume / cancel the history rebuild |
| `/cc-stats` | state size report |

*(The bookkeeper's own command grammar — `memory_add`, `witness`, `bond`,
`appear`, … — is what the cheap model outputs; you never type it. It lives in
`commands.js` and is shared by the live bookkeeper and the backfill.)*
