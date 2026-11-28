# A language-agnostic conformance corpus (bash + bats) runs against every parley-vous package

```yaml
.dag: issue-dag/2
.id: flyingrobots/parley-vous#NEW
.kind: task
.type: feature
.blocked_by: [@L2, @M2, @N]
.size_hours: 1
```

## Outcome
One corpus of cases, run by bats, checks the npm, PyPI and crate packages the same way.

## Scope
- A `conformance/` corpus: inputs with the expected stdout, stderr and receipt, and no language-specific files.
- A thin adapter per package (TypeScript, Python, Rust) that runs a case; a bats suite compares each adapter's output with the expected; CI runs all three.

## Out of scope
- Performance tests.

## Prerequisites
- [ ] @L2: the npm package's generated types
- [ ] @M2: the PyPI package's generated types
- [ ] @N: the crate's generated types

## Safe intermediate state
A test suite only.

## Acceptance
- [ ] The corpus passes against all three packages in CI.
- [ ] A deliberately wrong expected output fails for all three.

## Definition of Done
Merged with a merge commit (never squashed), CI green, every Acceptance item true, CHANGELOG under Unreleased. Part of the one-time reinvention recorded in @A.
