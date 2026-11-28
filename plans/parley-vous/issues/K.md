# flyingrobots.dev/parley-vous/ serves the spec and every schema at its $id

```yaml
.dag: issue-dag/2
.id: flyingrobots/parley-vous#NEW
.kind: task
.type: feature
.blocked_by: [@P]
.size_hours: 1
```

## Outcome
`https://flyingrobots.dev/parley-vous/` serves the spec, and every message's `$id` URL returns its schema.

## Scope
- A Pages build from the generated outputs; the `/parley-vous/schemas/<id>/<version>` paths; a CI check that fetches each `$id` after deploy.

## Out of scope
- DNS or hosting changes outside this repository: listed in the PR for the owner.

## Prerequisites
- [ ] @P: the site serves the released schemas, so they must be released first

## Safe intermediate state
The site may lag a release; the `$id`s are names, and resolving them is a convenience the check reports.

## Acceptance
- [ ] Every `$id` in `parley-vous.schema.json` returns that schema.
- [ ] The spec renders at the site root.

## Definition of Done
Merged with a merge commit (never squashed), CI green, every Acceptance item true, CHANGELOG under Unreleased. Part of the one-time reinvention recorded in @A.
