# The gate checks every message version against the released snapshots

```yaml
.dag: issue-dag/2
.id: flyingrobots/parley-vous#122
.kind: task
.type: feature
.blocked_by: [@J]
.size_hours: 1
```

## Outcome
`bun test` fails when a message changes without the version bump spec §4.5 requires.

## Scope
- Run `wesley-parley-vous versions --released schemas/released` in the generate pipeline and the gate.
- Tests: a changed released version, a too-small bump, a version below the latest.

## Out of scope
- none

## Prerequisites
- [ ] @J: the check runs inside the pipeline

## Safe intermediate state
Every message is a new draft at 1.0.0, so the gate passes until something is released and then changes.

## Acceptance
- [ ] The three failure cases each fail `bun test` with the message id named.
- [ ] A clean tree passes.

## Definition of Done
Merged with a merge commit (never squashed), CI green, every Acceptance item true, CHANGELOG under Unreleased. Part of the one-time reinvention recorded in @A.
