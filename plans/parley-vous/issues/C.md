# Every message is parley-vous.* at 1.0.0 in the SDL and the schemas

```yaml
.dag: issue-dag/2
.id: flyingrobots/parley-vous#NEW
.kind: task
.type: task
.blocked_by: [@B]
.size_hours: 1
.holds: [schemas/, spec/]
```

## Outcome
Each of the 17 messages carries the id `parley-vous.<name>` at version `1.0.0` in `spec/parley-vous.graphql` and its hand-written schema.

## Scope
- Move `schemas/parley.graphql` to `spec/parley-vous.graphql`; directives `@parley_*` become `@parley_vous_*`; ids and versions as above.
- Rename the 17 top-level schemas to `schemas/parley-vous.<name>.schema.json` with the new `$id`s, titles and `_schema` consts.
- `scripts/sdl-to-json-schema.ts` and `scripts/sdl-agreement.test.ts` read the new names, so the SDL and the schemas still agree.
- The packages' bundled schema copies are re-synced.

## Out of scope
- Deleting the old released snapshots (@D).
- Runtime paths (@E).

## Prerequisites
- [ ] @B: the spec defines the new identities

## Safe intermediate state
Every message is a draft `1.0.0` under its new id; the release check reports the drafts and blocks a stable release until they are released, which is the intended state.

## Acceptance
- [ ] The SDL agreement test passes for all 17 renamed messages.
- [ ] No file outside `schemas/released/` and history notes mentions a `parley.` message id.
- [ ] `bun test`, `bun run check`, `bun run typecheck` pass.

## Definition of Done
Merged with a merge commit (never squashed), CI green, every Acceptance item true, CHANGELOG under Unreleased. Part of the one-time reinvention recorded in @A.
