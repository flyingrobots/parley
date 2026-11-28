# wesley-parley-vous 0.1.0-alpha.1 is published to crates.io and PyPI

```yaml
.dag: issue-dag/2
.id: flyingrobots/wesley-parley-vous#NEW
.kind: task
.type: task
.blocked_by: [@G, @H1, @H2, @H3, @H4]
.size_hours: 1
```

## Outcome
`wesley-parley-vous` 0.1.0-alpha.1 (crate and Python renderer) is published from one approved tag.

## Scope
- Git pins become exact versions of the four published generators.
- Release workflow on the shared pattern: gate (including the e2e harness), `crates-io` and `pypi` approvals, verify, GitHub release.

## Out of scope
- Parley-vous's use of it (@J).

## Prerequisites
- [ ] @G: the bundle is part of the release
- [ ] @H1: exact dependency
- [ ] @H2: exact dependency
- [ ] @H3: exact dependency
- [ ] @H4: exact dependency of the Python renderer

## Safe intermediate state
Published; Parley-vous does not use it until @J.

## Acceptance
- [ ] `cargo install wesley-parley-vous --version =0.1.0-alpha.1 --locked` works.
- [ ] `pip install wesley-parley-vous==0.1.0a1` works.
- [ ] The e2e harness passed in the release gate.

## Definition of Done
Merged with a merge commit (never squashed), CI green, every Acceptance item true, CHANGELOG under Unreleased. Part of the one-time reinvention recorded in @A.
