# Working agreement

General rules live in `~/.agents/AGENTS.md`. This records what is specific to `parley`.

## What this repository is

A **specification first**, libraries second. The spec in `spec/` is the product; any reader or
writer we ship is a conforming implementation of it, not the definition of it.

## The three versions, kept apart

- **The spec version** (`spec/parley-vous-vX.Y.md`) moves when the protocol changes.
- **Each message schema version** (`schemas/*.schema.json`) moves when that message changes.
- **The package version** moves when the code changes.

None of them are the same number. Coupling any two forces false breaking changes and hides real
ones. This is the rule the spec asks of conforming programs, so this repository must hold to it
first.

## What conforms and what does not

The writer and reader libraries are conforming implementations of the spec. The
repository's own tooling under `scripts/` is not: the example checker, the doctor and the
release-eligibility checker emit JSON
Lines with a `parley.tooling.*` schema so they are parseable, but they carry no run identity and
make no claim to the protocol. The doctor will be rebuilt on the writer library when it exists.

## Checks

`bun test` runs everything, including the example checker (`bun run check`). See
[docs/workflows/check-examples](docs/workflows/check-examples/README.md) for how to label an
example that is deliberately incomplete.

## The libraries

`packages/` holds the conforming implementations as Bun workspace packages: `parley-emit` writes
and `parley-read` reads. They are consumers of the spec and the schemas: `bun run sync-schemas` in a package copies
the top-level schemas in, pinned by commit and digest, and a test fails when the copy is stale. The gate for
the whole repository is `bun test`, `bun run check` and `bun run typecheck`. `bun run typecheck` also type-checks `scripts/` and every package's `test/`
through the root `tsconfig.json`, under the same strict options as the packages.

## Release eligibility

A stable Parley distribution MUST NOT embed, advertise, or emit a repository-owned protocol schema
identity unless that exact `(id, version)` has been released and resolves to its frozen
definition. Release checks MUST inspect the distributable artifact, and publication MUST be bound
to the checked candidate. `scripts/release-check.ts` decides it, in three phases, against a
baseline the candidate did not choose; `bun test` runs its `development` phase, which reports
which packages a draft schema blocks without failing on the draft. The rule, the phases and the
two-commit procedure for releasing schema versions are in
[docs/workflows/release-spec](docs/workflows/release-spec/README.md). A release is merged with a
merge commit, never squashed: the package copies are pinned to the schema release's commit id.
`bun run release-gate -- <package>` asks the `publication` question of one package's artifact at
the current commit; a release tag is pushed only after it exits 0, and each release workflow runs
it as its `gate` job before anything public is created.

## Hard don'ts

- Do not let the libraries define the protocol. If an implementation cannot do what the spec says,
  change the spec deliberately and version it, or fix the implementation.
- Do not add a field to a message without versioning its schema, unless that schema version is
  still a draft under `Unreleased` in the changelog (spec §4.5), in which case record the change
  in that entry.
- Do not claim a section is settled that has not been tested against a real program.
- Do not release over a confirmed finding that violates evidence fidelity, privacy, identity or a
  published contract, whether or not the change under review introduced it. Fix it, or stop and
  ask the owner for an exception and record it
  ([docs/workflows/release-review](docs/workflows/release-review/README.md)). An agent acting
  under a delegation does not accept such an exception itself.
- Do not leave a privacy defect in a published version unannounced once its fix is released:
  draft the security advisory when the defect is confirmed, keep it current, and prepare the
  deprecation notice. Publishing either is the owner's
  ([docs/workflows/release-review](docs/workflows/release-review/README.md#telling-users-of-a-published-version)).
- Do not tag or publish a package as stable while `bun run release-gate -- <package>` refuses
  it, and do not edit, delete or re-point a file under `schemas/released/`. The one exception ever made
  is the reinvention as Parley-vous, recorded in
  [docs/workflows/release-review](docs/workflows/release-review/README.md#the-one-time-reinvention-as-parley-vous).
