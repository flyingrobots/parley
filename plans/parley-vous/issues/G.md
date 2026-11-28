# wesley-parley-vous emits one bundled parley-vous.schema.json

```yaml
.dag: issue-dag/2
.id: flyingrobots/wesley-parley-vous#NEW
.kind: task
.type: feature
.blocked_by: [@F]
.size_hours: 1
```

## Outcome
`wesley-parley-vous json-schema` writes `parley-vous.schema.json`, one JSON Schema 2020-12 document that embeds every message as a resource with its own `$id`.

## Scope
- The bundle and a test that each embedded resource equals the per-message schema as a JSON value.
- The 2020-12 meta-schema validates the bundle; a validator resolves each message by `$id` from it.

## Out of scope
- Hosting (@K).

## Prerequisites
- [ ] @F: the bundle holds the renamed identities

## Safe intermediate state
Per-message output still exists beside the bundle.

## Acceptance
- [ ] `parley-vous.schema.json` validates against the meta-schema.
- [ ] Every message validates real lines when resolved by `$id` from the bundle.
- [ ] CI is green.

## Definition of Done
Merged with a merge commit (never squashed), CI green, every Acceptance item true, CHANGELOG under Unreleased. Part of the one-time reinvention recorded in @A.
