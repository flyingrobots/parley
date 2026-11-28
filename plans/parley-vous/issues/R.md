# The parley-vous CLI (Rust, on the crate) queries history, opens records and checks a captured run

```yaml
.dag: issue-dag/2
.id: flyingrobots/parley-vous#138
.kind: task
.type: feature
.blocked_by: [@N4]
.size_hours: 1
```

## Outcome
An installed `parley-vous` command answers `query`, `open` and `doctor` from a shell, with no code written by the user.

## Scope
- A binary built on the crate with `query` (a view, a window, a budget), `open` (record ids from a digest) and `doctor` (check captured stdout, stderr and a receipt); JSON Lines by default, `--human` for prose.
- Its own output is Parley-vous: every line validates against a published schema, and `--help` and `--schema` describe them.
- This rewrites parley#138, which planned the command on the npm writer, for the Rust crate; #138's prerequisite, parley#133, is closed.

## Out of scope
- New reader behaviour.
- Instrumenting other people's tools.

## Prerequisites
- [ ] @N4: the command reads through the crate's reader

## Safe intermediate state
Not published until @P; `scripts/doctor.ts` stays the gate's doctor until the command's verdicts match it.

## Acceptance
- [ ] `query`, `open` and `doctor` run from an installed binary.
- [ ] Every line each prints validates against a published schema, and `--help` and `--schema` describe them.
- [ ] The doctor's verdicts on the repository's fixtures equal `scripts/doctor.ts`'s.

## Definition of Done
Merged with a merge commit (never squashed), CI green, every Acceptance item true, CHANGELOG under Unreleased. Part of the one-time reinvention recorded in @A.
