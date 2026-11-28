# A hermetic Docker pipeline generates Parley-vous's schema from the SDL

```yaml
.dag: issue-dag/2
.id: flyingrobots/parley-vous#119
.kind: task
.type: feature
.blocked_by: [@I, @S117, @D]
.size_hours: 1
```

## Outcome
`bun run generate` writes `parley-vous.schema.json` from `spec/parley-vous.graphql` inside a hermetic Docker image, and a freshness check fails when a committed generated file differs.

## Scope
- `spec/generate/Dockerfile`: digest-pinned images; fetch exactly `config.wesley` and `config.wesleyParleyVous`; every later step `--network=none`, non-root.
- `bun run generate` and `bun run generate:check`; the check runs in `bun test` and CI.
- The hand-written schemas are replaced by the generated bundle; the transitional `sdl-to-json-schema.ts` and its agreement test are deleted.

## Out of scope
- Language bindings (@L2, @M2, @N).
- Hosting (@K).

## Prerequisites
- [ ] @I: the pinned generator must be published
- [ ] @S117: the spec must say the SDL is the source
- [ ] @D: no old snapshot may contradict the new identities

## Safe intermediate state
The schema is generated and checked fresh; the packages still carry their hand-written types.

## Acceptance
- [ ] `bun run generate` changes nothing on a clean tree.
- [ ] Editing the SDL without regenerating fails `bun test`.
- [ ] Generation runs with no network (proved by the pipeline's `--network=none`).

## Definition of Done
Merged with a merge commit (never squashed), CI green, every Acceptance item true, CHANGELOG under Unreleased. Part of the one-time reinvention recorded in @A.
