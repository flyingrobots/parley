# The old parley.* released snapshots are deleted

```yaml
.dag: issue-dag/2
.id: flyingrobots/parley-vous#NEW
.kind: task
.type: task
.blocked_by: [@C]
.size_hours: 1
.holds: [schemas/]
```

## Outcome
`schemas/released/` holds no `parley.*` snapshot, under the exception the owner recorded.

## Scope
- Delete the 19 files under `schemas/released/parley.*`.
- The release check and its tests stop expecting them; the frozen-file guard keeps guarding every other released path.

## Out of scope
- Releasing the new `parley-vous.*` snapshots: that is the first release (@P).

## Prerequisites
- [ ] @C: nothing may still name the old identities when their snapshots go

## Safe intermediate state
No released snapshot exists until the first Parley-vous release; the release check treats every message as a draft.

## Acceptance
- [ ] `schemas/released/` has no `parley.*` path.
- [ ] `bun test` passes, including the release-check suites.

## Definition of Done
Merged with a merge commit (never squashed), CI green, every Acceptance item true, CHANGELOG under Unreleased. Part of the one-time reinvention recorded in @A.
