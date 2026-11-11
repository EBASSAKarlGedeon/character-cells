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
  It can also auto-create tracked state as the story needs it: characters
  (`char_add`), factions and quests (capped, named-only, scene-derived).
  Rides a Connection Manager profile of your choice (Extensions panel →
  Character Cells drawer) without switching your active connection.
- **Tick engine** — before each generation, mechanics resolve: a referee reads
  your new message and queues task checks (real d20 rolls with bond/inventory
  modifiers), off-screen agendas advance, bond/grudge ticks run, Chekhov plants
  age and fire through d20 gates, and a World Sim table rolls the off-screen
  world. The narrator writes inside already-decided mechanics.
- **Event ledger** — one shared, immutable list of events with witness lists;
  per-character knowledge is derived by filtering, never copied. Landmarks
  (imp 3) stay verbatim forever; old events age into cached per-character
  digests.
- **Conversion** — for old FF5 chats: Import (parse the most recent
  internal-states block into exact state, no model call) → Clean copy (strip
  the old HTML into a new chat, carrying the imported state over) → Backfill
  (rebuild the event ledger from history in batches; runs in seeded mode after
  an import so imported values are never double-counted).

## Status

Slices 1–8 built: state store + panel, witness-filtered injection, bookkeeper +
shared ledger, tier auto-detection, Main Character mode, digests + landmarks +
strip-copy/backfill, NPC inventory drawer, the FF5 mechanics tick engine
(dice/agendas/bonds/Chekhov/World Sim), old-chat import + seeded backfill, and
bookkeeper auto-creation (characters, factions, quests). Still ahead: tuning
(Chekhov thresholds, World Sim tables), RPG/Dungeon mode.
