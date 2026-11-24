# Releasing parley

What to do once a pull request has merged to `main`. footprint reads this file and quotes the list
below back in the **After merge** section of its report, so each step stays a top-level list item
under the heading, and each says when it applies: a merge that moved no version is not a release,
and nothing below applies to it. How to prepare each release before the merge, and what each
workflow checks, is in [`docs/workflows/release-parley-emit`](docs/workflows/release-parley-emit/README.md)
and [`docs/workflows/release-parley-read`](docs/workflows/release-parley-read/README.md); what a
release of the spec and its schemas is, in [`docs/topics/release`](docs/topics/release/README.md).

## After merge

- If the merged change moved `version` in `packages/parley-emit/package.json`, tag the merge commit on `main` as `parley-emit-vX.Y.Z` with that number (for example `parley-emit-v0.2.0`) and push the tag; `.github/workflows/release-parley-emit.yml` does the rest.
- After pushing a `parley-emit-v` tag, confirm the workflow's `sanity`, `release` and `publish` jobs all succeeded. `publish` only stages the version: `npm stage list @flyingrobots/parley-emit` must name it. If `publish` failed, read its log; do not re-run it blindly and do not publish by hand.
- The owner approves a staged version, with `npm stage approve <stage-id>` or on the package's Staged Packages tab on npmjs.com; nobody else can, and an agent must not try. Once approved, confirm that the GitHub release and `npm view <package> version` name the same version.
- If the merged change moved `version` in `packages/parley-read/package.json`, wait until the parley-emit version its dependency range needs is approved and on npm, then tag the merge commit as `parley-read-vX.Y.Z` (for example `parley-read-v0.1.0`) and push the tag; `.github/workflows/release-parley-read.yml` does the rest.
- After pushing a `parley-read-v` tag, confirm its `sanity` and `release` jobs succeeded and that `publish` staged the version (`npm stage list @flyingrobots/parley-read`), for the owner to approve.
- If the merged change cut a dated heading in `packages/parley-emit-py/CHANGELOG.md`, tag the merge commit as `parley-emit-py-vX.Y.Z` (for example `parley-emit-py-v0.1.0`), push the tag, and create its GitHub release by hand with that changelog section as notes and the SHA-256 that `python3 packages/parley-emit-py/parley_emit.py --vendor-info` prints at the tag; this file is vendored, never published to a registry.
- If the merged change cut a dated heading in the root `CHANGELOG.md`, it released the schemas that entry names: confirm each one's snapshot is under `schemas/released/<id>/<version>.schema.json` on `main`, and tell the consumers that vendor the writers (flyingrobots/taskalisk, flyingrobots/footprint) which versions they can now pin.
