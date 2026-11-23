# Releases — test plan

Evidence lives in `scripts/release.test.ts` and `scripts/schemas.test.ts`. The release workflows'
own `sanity` jobs (`.github/workflows/release-parley-emit.yml`, `release-parley-read.yml`) are the
golden check of a tag (flyingrobots/parley#85); the cases here are what `bun test` can hold on
every pull request.

| ID | Requirement | Spec |
| --- | --- | --- |
| REL-1 | A released schema version is immutable: each one has a snapshot at `schemas/released/<id>/<version>.schema.json`; a top-level file that claims a released pair has the snapshot's exact bytes, so changing a released schema without moving its version fails the gate; a top-level version with no snapshot is a draft and is named under `## [Unreleased]` in `CHANGELOG.md` | §4.5, §4.6 |
| REL-2 | A publishable package's manifest survives `npm publish` as written: the fields the release workflow requires are present, no dependency uses a `workspace:` range (npm publishes it verbatim), and a package that depends on another package here admits that package's own version, so the workspace links the local copy | — |
| REL-3 | Every package's version has a dated heading in its changelog, and the Python file's `__version__` is its manifest's version | — |
| REL-4 | `RELEASE.md` declares the after-merge steps in the form footprint reads (top-level list items under a landing heading, outside fenced code), and every tag it names matches a release workflow's trigger | — |

| ID | Case | Oracle | Evidence | Status |
| --- | --- | --- | --- | --- |
| REL-1a | A schemas directory whose top-level file and snapshot claim the same pair with the same bytes | the loader indexes the pair once and does not throw | `schemas.test.ts` `a top-level file may carry a released pair with the snapshot's exact bytes` | planned |
| REL-1b | The same, with one byte of the top-level file changed | the loader throws, naming the pair and saying a released version is immutable | `schemas.test.ts` `a top-level file that changes a released pair is refused` | planned |
| REL-1c | The repository's `schemas/` | every top-level file either equals the snapshot of its pair, or has no snapshot and its `id` and version are named under `## [Unreleased]` in `CHANGELOG.md` | `schemas.test.ts` `every top-level schema is released byte for byte or is a draft under Unreleased` | planned |
| REL-1d | Every snapshot under `schemas/released/` | its pair is named in a dated version entry of `CHANGELOG.md`, never under `Unreleased` | `schemas.test.ts` `every released snapshot is named by a dated release entry` | planned |
| REL-2a | Every package under `packages/` without `private` | `name`, `version`, `description`, `license`, `repository`, `files`, `engines` and `publishConfig.access: public` present; no `workspace:` range in any dependency map | `release.test.ts` `a publishable manifest has its fields and no workspace range` | planned |
| REL-2b | `@flyingrobots/parley-read`'s range for `@flyingrobots/parley-emit` | admits `packages/parley-emit`'s version | `release.test.ts` `a dependency on a package here admits its own version` | planned |
| REL-3a | Each package's `version`, and `__version__` in `parley_emit.py` | a `## [X.Y.Z] — YYYY-MM-DD` heading in its `CHANGELOG.md`; the Python version equals its manifest | `release.test.ts` `every package version has a dated changelog heading` | planned |
| REL-4a | `RELEASE.md` read by footprint's rule | at least one top-level list item under a heading containing `after merge`; each `parley-*-v` tag it names has a workflow whose trigger pattern matches it | `release.test.ts` `RELEASE.md declares steps footprint can read and names real tags` | planned |
