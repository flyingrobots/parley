# Releasing parley

What to do once a pull request has merged to `main`. footprint reads this file and quotes the list
below back in the **After merge** section of its report, so each step stays a top-level list item
under the heading, and each says when it applies: a merge that moved no version is not a release,
and nothing below applies to it. How to prepare each release before the merge, what each workflow
checks and what it cannot verify is in
[`docs/workflows/release-parley-emit`](docs/workflows/release-parley-emit/README.md),
[`docs/workflows/release-parley-read`](docs/workflows/release-parley-read/README.md) and
[`docs/workflows/release-parley-emit-py`](docs/workflows/release-parley-emit-py/README.md); what a
release of the spec and its schemas is, in [`docs/topics/release`](docs/topics/release/README.md).

## The rule every release is held to

A stable Parley distribution MUST NOT embed, advertise, or emit a repository-owned protocol schema
identity unless that exact `(id, version)` has been released and resolves to its frozen
definition. Release checks MUST inspect the distributable artifact, and publication MUST be bound
to the checked candidate. The release gate decides it for one package at one commit:
`bun run release-gate -- <package>` builds the package's artifact once, runs the `publication`
phase of the release-eligibility check on that file against the package's previous release tag,
and names the schema identities that block it. **A tag is pushed only after the gate exits `0`**: a
pushed tag cannot be taken back, and each release workflow runs the same gate as its first job
after `sanity`, before it creates anything public. The gate, the checker's phases, and how schema
versions are released in two commits and a merge commit, are in
[`docs/workflows/release-spec`](docs/workflows/release-spec/README.md).

## After merge

- Before pushing any tag below, run the release gate for that package on `main` at the merge commit, with a clean tree: `bun run release-gate -- parley-emit`, `bun run release-gate -- parley-read` or `bun run release-gate -- parley-emit-py`. Push the tag only after it exits `0`; if it exits `1`, read its `gate.result` line for the blocking schema identities and push nothing.
- If the merged change moved `version` in `packages/parley-emit/package.json` and the gate passed, tag the merge commit on `main` as `parley-emit-vX.Y.Z` with that number (for example `parley-emit-v0.2.0`) and push the tag; `.github/workflows/release-parley-emit.yml` does the rest.
- After pushing a `parley-emit-v` tag, confirm the workflow's `sanity`, `gate`, `release` and `publish` jobs all succeeded. `publish` only stages the version: `npm stage list @flyingrobots/parley-emit` must name it. If a job failed, read its log and use "Re-run failed jobs", never "Re-run all jobs", so the tarball the gate packed is the one released; do not publish by hand.
- The owner approves a staged version, and only after comparing it with the release report attached to the GitHub release (`release-report.json`): `npm stage download <stage-id>` and `shasum -a 256` on the file must give the report's `artifact.sha256`. Then `npm stage approve <stage-id>`, or the package's Staged Packages tab on npmjs.com; nobody else can approve, and an agent must not try. Once approved, confirm that the GitHub release and `npm view <package> version` name the same version.
- If the merged change moved `version` in `packages/parley-read/package.json`, wait until the parley-emit version its dependency range needs is approved and on npm, run its gate, then tag the merge commit as `parley-read-vX.Y.Z` (for example `parley-read-v0.1.0`) and push the tag; `.github/workflows/release-parley-read.yml` does the rest.
- After pushing a `parley-read-v` tag, confirm its `sanity`, `gate` and `release` jobs succeeded and that `publish` staged the version (`npm stage list @flyingrobots/parley-read`), for the owner to compare with the report and approve. The report's `consumer.dependency` names the exact parley-emit version and integrity the packed reader was proved against.
- If the merged change cut a dated heading in `packages/parley-emit-py/CHANGELOG.md` and the gate passed, tag the merge commit as `parley-emit-py-vX.Y.Z` (for example `parley-emit-py-v0.1.0`) and push the tag; `.github/workflows/release-parley-emit-py.yml` runs the gate on the file and creates the GitHub release with that changelog section, the file, and the SHA-256 that `python3 packages/parley-emit-py/parley_emit.py --vendor-info` prints. This file is vendored, never published to a registry; confirm the `gate` and `release` jobs succeeded.
- If the merged change cut a dated heading in the root `CHANGELOG.md`, it released the schemas that entry names: confirm each one's snapshot is under `schemas/released/<id>/<version>.schema.json` on `main`, and tell the consumers that vendor the writers (flyingrobots/taskalisk, flyingrobots/footprint) which versions they can now pin.
