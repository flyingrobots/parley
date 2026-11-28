# Spec v0.3 names the protocol Parley-vous

```yaml
.dag: issue-dag/2
.id: flyingrobots/parley-vous#NEW
.kind: task
.type: task
.blocked_by: [@A]
.size_hours: 1
```

## Outcome
`spec/parley-vous-v0.3.md` replaces `spec/parley-v0.2.md` and names every protocol identity Parley-vous.

## Scope
- Rename the spec file and title; "Parley-vous" in prose, `parley-vous` in identifiers.
- The reserved message-id prefix becomes `parley-vous.`; every example id follows.
- Runtime paths: `.parley-vous/receipts/`, `$XDG_STATE_HOME/parley-vous/`; tooling ids `parley-vous.tooling.*`.
- Schema `$id` base `https://flyingrobots.dev/parley-vous/schemas/<id>/<version>`.
- Every message version in the spec's examples is `1.0.0`.
- CHANGELOG: spec 0.3.0 under Unreleased.

## Out of scope
- The SDL-as-source text (@S117).
- Renaming code, schemas or paths in the implementation (@C, @E).

## Prerequisites
- [ ] @A: the rename is the recorded exception

## Safe intermediate state
The spec describes Parley-vous while the code still says parley; the agreement and example checks that read the spec still pass because they read schemas, not the spec's prose.

## Acceptance
- [ ] `spec/parley-vous-v0.3.md` exists and `spec/parley-v0.2.md` does not.
- [ ] `git grep -n 'parley\.' spec/` finds no protocol identity outside a history note.
- [ ] `bun test`, `bun run check`, `bun run typecheck` pass.

## Definition of Done
Merged with a merge commit (never squashed), CI green, every Acceptance item true, CHANGELOG under Unreleased. Part of the one-time reinvention recorded in @A.
