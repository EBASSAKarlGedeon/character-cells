# character-cells

Loreweaver / SillyTavern extension. Moves the FF5 "Internal States" preset from
prompt-gymnastics into real app state: per-character cells (tiers, bonds, agendas,
witnessed memories) stored in chat metadata, rendered as an editable
internal-states-style drawer panel.

Spec & design decisions: `docs/CHARACTER-CELLS-SPEC.md` in the main Loreweaver repo.

## Install (third-party extension)

1. In SillyTavern / Loreweaver: Extensions → Install extension
2. Git URL: `https://github.com/EBASSAKarlGedeon/character-cells.git`

## Slash commands

- `/cells` — open the panel
- `/cc-add name=X tier=main|secondary|minor|offstage`
- `/cc-promote X` / `/cc-demote X`
- `/cc-stats` — state size/stats

## Status

Slice 1 skeleton: manual state + panel. Tier auto-detection, prompt injection and
the bookkeeper pass come later (see spec).
