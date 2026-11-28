# wesley-parley-vous reads @parley_vous_* and emits parley-vous.* identities

```yaml
.dag: issue-dag/2
.id: flyingrobots/wesley-parley-vous#NEW
.kind: task
.type: task
.blocked_by: [@C]
.size_hours: 1
```

## Outcome
The generator interprets Parley-vous's vocabulary and renders `parley-vous.*` ids with `$id`s under `https://flyingrobots.dev/parley-vous/schemas/`.

## Scope
- Crate and Python package renamed `wesley-parley-vous`; binary `wesley-parley-vous`.
- Vocabulary `@parley_vous_*`; `ID_BASE` and the reserved prefix updated.
- Fixtures re-copied from the renamed SDL and schemas; every golden regenerated; the e2e harness follows.

## Out of scope
- The bundled schema file (@G).

## Prerequisites
- [ ] @C: the fixtures are Parley-vous's renamed SDL and schemas

## Safe intermediate state
The generator reproduces the renamed hand-written schemas as JSON values, so Parley-vous could switch to it.

## Acceptance
- [ ] All 17 renamed schemas are reproduced as JSON values.
- [ ] The e2e harness passes against Parley-vous `main`.
- [ ] CI is green.

## Definition of Done
Merged with a merge commit (never squashed), CI green, every Acceptance item true, CHANGELOG under Unreleased. Part of the one-time reinvention recorded in @A.
