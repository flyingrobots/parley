# One release workflow publishes parley-vous to npm, PyPI and crates.io in lockstep

```yaml
.dag: issue-dag/2
.id: flyingrobots/parley-vous#NEW
.kind: task
.type: feature
.blocked_by: [@L3, @M3, @N2, @O, @K]
.size_hours: 1
```

## Outcome
One approved tag publishes the npm, PyPI and crates.io `parley-vous` packages at the same version, with the schema snapshots released alongside.

## Scope
- Gate: generate check, every suite, the hello-world apps, the version gate, the release-eligibility check on each artifact.
- One environment approval; publish to all three registries; verify each; GitHub release; site deploy.
- The per-package release workflows are removed.

## Out of scope
- Name reservation happens with the first run.

## Prerequisites
- [ ] @L3: npm artifact proven
- [ ] @M3: PyPI artifact proven
- [ ] @N2: crate artifact proven
- [ ] @O: version gate in place
- [ ] @K: the site deploys with the release

## Safe intermediate state
Nothing publishes until the tag is approved.

## Acceptance
- [ ] A dry run builds all three artifacts at one version.
- [ ] The first release publishes all three and the verify jobs pass.

## Definition of Done
Merged with a merge commit (never squashed), CI green, every Acceptance item true, CHANGELOG under Unreleased. Part of the one-time reinvention recorded in @A.
