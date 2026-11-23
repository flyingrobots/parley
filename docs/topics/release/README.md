# Releases

What a release of this repository is. The product is the spec, so its releases are the spec's and
its schemas'; the libraries release on their own. How to cut one is in the workflow pages linked
below, and what to do once it has merged is in [`RELEASE.md`](../../../RELEASE.md). Its
[test plan](test-plan.md) is the contract ledger.

## Three versions, three tracks

| What | Version lives in | Released by | Published to |
| --- | --- | --- | --- |
| The spec and its message schemas | the spec's status line; each schema's `$id` and `_schema` | a dated heading in the root `CHANGELOG.md`, naming every schema version it releases | this repository: `schemas/released/<id>/<version>.schema.json` |
| `@flyingrobots/parley-emit` | `packages/parley-emit/package.json` | the tag `parley-emit-vX.Y.Z` ([how](../../workflows/release-parley-emit/README.md)) | npm, with provenance |
| `@flyingrobots/parley-read` | `packages/parley-read/package.json` | the tag `parley-read-vX.Y.Z` ([how](../../workflows/release-parley-read/README.md)) | npm, with provenance after the first, manual publish |
| `parley_emit.py` | `__version__` in the file and its `package.json` | the tag `parley-emit-py-vX.Y.Z` and a GitHub release carrying its SHA-256 | nowhere: a tool vendors the file and pins its digest |

None of these numbers is another's. A package release publishes no schema version, and a schema
release moves no package version (spec §4.4, §4.5).

## A released schema is immutable

A schema version named by a dated root changelog entry is released (spec §4.5). Its bytes are
snapshotted at `schemas/released/<id>/<version>.schema.json` (§4.6), and the top-level file
`schemas/<id>.schema.json` may hold a released version only with the snapshot's exact bytes. The
first change after a release, a description included, moves the top-level file to a new version; that version is a draft, recorded
under `## [Unreleased]`, and may change in place until the next release snapshots it.

The loader every check uses (`scripts/check-examples.ts`, `loadSchemas`) refuses two files that
claim one pair with different bytes, and `scripts/schemas.test.ts` refuses a top-level version that
is neither snapshotted nor named under `Unreleased`. So editing a released schema without moving
its version fails `bun test`.

The first release, `0.2.0` in the root changelog, released all seventeen schemas at once.

## A package depends on a package here by range

`@flyingrobots/parley-read` depends on `@flyingrobots/parley-emit` by a caret range that admits the
version in the repository (`^0.2.0`), so Bun links the workspace copy inside the repository and an
installer outside it resolves the published one. A `workspace:` range would be published verbatim
by npm and resolve nowhere. The dependency is published first.
