# character-cells

Loreweaver / SillyTavern extension. Moves the FF5 "Internal States" preset from
prompt-gymnastics into real app state: per-character cells (tiers, bonds, agendas,
witnessed memories) stored in chat metadata, rendered as an editable
internal-states-style drawer panel. A cheap "bookkeeper" model call updates the
state automatically after each AI reply; the narrator model never touches state.

Spec & design decisions: `docs/CHARACTER-CELLS-SPEC.md` in the main Loreweaver repo.
Full architecture: `ARCHITECTURE.md` in this repo.
**Every slash command with usage examples: `COMMANDS.md`.**

## Install (third-party extension)

1. In SillyTavern / Loreweaver: Extensions → Install extension
2. Git URL: `https://github.com/EBASSAKarlGedeon/character-cells.git`

## The pieces

- **Cells & tiers** — one cell per character (user included); tiers
  main/secondary/minor/offstage, auto-detected from a rolling participation log,
  manual changes pin.
- **Injection** — the state is rebuilt into a prompt block each turn, filtered
  by what each character actually witnessed (the memory-mixing fix). Main
  Character mode rebuilds the whole block from one character's knowledge.
- **Bookkeeper** — after each AI reply, a cheap model call reads the scene and
  emits state-change commands; malformed lines are skipped, never crash a turn.
  Rides a Connection Manager profile of your choice (Extensions panel →
  Character Cells drawer) without switching your active connection.
- **Event ledger** — one shared, immutable list of events with witness lists;
  per-character knowledge is derived by filtering, never copied. Landmarks
  (imp 3) stay verbatim forever; old events age into cached per-character
  digests.
- **Conversion** — Clean copy (strip old internal-states HTML into a new chat)
  + Backfill (rebuild ledger from history in batches).

## Status

Slices 1–6 built: state store + panel, witness-filtered injection, bookkeeper +
shared ledger, tier auto-detection, Main Character mode, digests + landmarks +
strip-copy/backfill. Still ahead: NPC inventory panel view, RPG/Dungeon mode.
