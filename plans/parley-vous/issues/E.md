# Runtime paths and tooling ids follow the Parley-vous spec

```yaml
.dag: issue-dag/2
.id: flyingrobots/parley-vous#NEW
.kind: task
.type: task
.blocked_by: [@B]
.size_hours: 1
.holds: [packages/, scripts/]
```

## Outcome
Every writer, reader and script uses `.parley-vous/`, `$XDG_STATE_HOME/parley-vous/` and `parley-vous.tooling.*`.

## Scope
- `parley-emit`, `parley-read`, `parley_emit.py`: receipt and state paths, the ignore file, environment variable names that say `PARLEY` become `PARLEY_VOUS`.
- `scripts/`: tooling schema ids and their schema files.
- Tests and fixtures follow.

## Out of scope
- Package names (@L1, @M1).

## Prerequisites
- [ ] @B: the spec defines the names

## Safe intermediate state
The packages keep their old names but write and read only the new paths.

## Acceptance
- [ ] `git grep -nE '\.parley/|parley\.tooling' -- packages scripts` finds nothing.
- [ ] `bun test`, `bun run check`, `bun run typecheck` and the Python suite pass.

## Definition of Done
Merged with a merge commit (never squashed), CI green, every Acceptance item true, CHANGELOG under Unreleased. Part of the one-time reinvention recorded in @A.
