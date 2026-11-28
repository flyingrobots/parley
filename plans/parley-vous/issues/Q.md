# @flyingrobots/parley-emit and @flyingrobots/parley-read are deprecated in favour of parley-vous

```yaml
.dag: issue-dag/2
.id: flyingrobots/parley-vous#NEW
.kind: task
.type: task
.blocked_by: [@P]
.size_hours: 1
```

## Outcome
Installing either old npm package shows a deprecation that points to `parley-vous`.

## Scope
- `npm deprecate` both packages with a message naming `parley-vous`; README notes.

## Out of scope
- Unpublishing: never.

## Prerequisites
- [ ] @P: the replacement must exist first

## Safe intermediate state
The old versions stay installable.

## Acceptance
- [ ] `npm view @flyingrobots/parley-emit deprecated` and `... parley-read deprecated` name `parley-vous`.

## Definition of Done
Merged with a merge commit (never squashed), CI green, every Acceptance item true, CHANGELOG under Unreleased. Part of the one-time reinvention recorded in @A.
