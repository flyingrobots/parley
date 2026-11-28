# Decision: Parley becomes Parley-vous, once, top to bottom

```yaml
.dag: issue-dag/2
.id: flyingrobots/parley-vous#NEW
.kind: task
.type: decision
.blocked_by: []
.size_hours: 1
```

## Outcome
The owner's one-time decision to reinvent Parley as Parley-vous is recorded where release reviews look for exceptions.

## Scope
- `docs/workflows/release-review`: a dated exception, in the owner's words (2026-11-26): rename the project, protocol, message ids, schema `$id`s, runtime paths and packages to Parley-vous / `parley-vous`; delete the 19 released snapshots under `schemas/released/parley.*`; reset every message to `1.0.0`. "The one and only time we will do so."
- `AGENTS.md`: the hard don't about `schemas/released/` names this exception as its only one.

## Out of scope
- Making any of the changes: tasks @B, @C, @D, @E do them.

## Prerequisites
- none

## Safe intermediate state
Nothing changes behaviour; the record exists before any rename lands.

## Acceptance
- [ ] The exception is in `docs/workflows/release-review` with the date and the owner's words.
- [ ] `AGENTS.md` points to it from the `schemas/released/` rule.

## Definition of Done
Merged with a merge commit (never squashed), CI green, every Acceptance item true, CHANGELOG under Unreleased. Part of the one-time reinvention recorded in this decision.
