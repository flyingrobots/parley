# Releasing parley-emit-py

How a version of `parley_emit.py`, the vendorable Python writer, is released. This is a
contributor operation; what the file does is in [its reference](../../topics/parley-emit-py/README.md).
It goes to no registry: a tool copies the file into its own tree and pins the SHA-256 that
`--vendor-info` prints, so a release is a GitHub release carrying the file and that digest.

## The order

1. Record the changes under a new dated heading in `packages/parley-emit-py/CHANGELOG.md`, and
   note the release in the root `CHANGELOG.md`. A release of the file publishes no schema version
   (spec §4.5); the schemas embedded in it are copied from `schemas/` at the commit the block
   records, so run `bun run sync-schemas` in `packages/parley-emit-py` first if they moved.
2. Set `__version__` in `parley_emit.py` and `version` in `packages/parley-emit-py/package.json`
   to the same number; `scripts/release.test.ts` requires them equal.
3. Merge that through a pull request; the checks workflow must be green.
4. Run the gate on `main` at the merge commit, with a clean tree:

   ```bash
   bun run release-gate -- parley-emit-py
   ```

5. Tag the merge commit on `main` as `parley-emit-py-vX.Y.Z` and push the tag, but
   only after it exits `0`. A pushed tag cannot be taken back, which is why the gate comes first.
   Exit `1` means refused: its last line, `gate.result`, names the schema identities that block
   the release.

The tag starts `.github/workflows/release-parley-emit-py.yml`, which:

| Job | Does |
| --- | --- |
| `gate` | Runs the file's own tests (`python3 -m unittest discover -s tests`), then the [release gate](../release-spec/README.md#the-release-gate) on the file: `bun run release-gate -- parley-emit-py --tag <the tag> --out <dir>`. That refuses a tag that is not `parley-emit-py-v` plus `__version__`, a version with no dated changelog heading, a commit that is not on `main` and a tree that is not clean, and runs the `publication` phase of the release-eligibility check on the file, with the frozen-since reference set to the previous `parley-emit-py-v` tag. It writes the release report, prints it in the job summary, and only then uploads the file, `SHA256SUMS` and the report as a workflow artifact |
| `release` | Downloads that artifact; requires three statements of one digest to agree: the gate job's output, the bytes it downloaded, and what `python3 parley_emit.py --vendor-info` prints; and creates the GitHub release named after the tag, with the changelog section and the digest as notes, and `parley_emit.py`, `SHA256SUMS` and `release-report.json` attached |

`release` needs `gate`, so when the gate refuses, no GitHub release is created.
`scripts/release-gate.test.ts` runs the gate job's own steps on a fixture that bundles a draft
schema and on one that does not (GATE-9, GATE-10).

Before this workflow, a release was a tag and a GitHub release made by hand, with nothing run
before either. Tags `parley-emit-py-v0.1.0` to `parley-emit-py-v0.2.0` were released that way.

## What a consumer pins

The release notes carry the SHA-256 of the file, and `SHA256SUMS` beside it is in the form
`shasum -a 256 -c` reads. `release-report.json` names the source commit and tree, the spec release,
every embedded schema with the digest of its released snapshot, and the gate's result.

## What the workflow cannot verify

These are limits, not guarantees:

- **Tag protection.** Anyone who can push a tag matching `parley-emit-py-v*` starts this workflow.
  The gate refuses a commit that is not on `main` and a tag that is not the version's, but whether
  tags can be created, moved or deleted, and by whom, is a repository ruleset the workflow cannot
  verify.
- **No second person.** Unlike the npm packages, nothing here waits for an approval: when the gate
  passes, the release is public. There is no staging step for a file that goes to no registry.
- **The checks on `main`.** The gate does not know whether the `checks` workflow was required and
  green for every pull request merged since the previous release. The workflow runs the file's
  own tests, not the whole of `bun test`.
- **The Python version.** The workflow runs the tests on the runner's `python3`. The file promises
  Python 3.9 or later, which the checks workflow tests on 3.9 for every pull request.

## Re-running

**Re-run failed jobs** keeps the `gate` job's artifact. If the GitHub release already exists,
`release` compares the file with the one the release carries, byte for byte, and fails on a
difference rather than replacing it.
