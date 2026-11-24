# Releasing parley-emit

How a version of `@flyingrobots/parley-emit` reaches npm. This is a contributor operation; what
the package does is in [its reference](../../topics/parley-emit/README.md).

## The order

1. Record the changes under a new heading in `packages/parley-emit/CHANGELOG.md`, dated, and
   note the release in the root `CHANGELOG.md`. A package release publishes no schema version
   (spec §4.5); the shipped schemas are the top-level files in `schemas/` at the commit pinned in
   `src/schemas.ts`, so run `bun run sync-schemas` there first if they moved.
2. Set `version` in `packages/parley-emit/package.json` to the same number.
3. Merge that through a pull request; the checks workflow must be green.
4. Run the gate on `main` at the merge commit: `bun run release-gate -- parley-emit`
   ([below](#before-the-tag-the-gate)).
5. Only once it exits `0`, tag the merge commit on `main` as `parley-emit-vX.Y.Z` and push the tag.

## Before the tag: the gate

A pushed tag cannot be taken back, and the workflow starts from one. So the same gate the workflow
runs is run first by the person tagging, on `main` at the merge commit, with a clean tree:

```bash
bun run release-gate -- parley-emit
```

**Push the tag only after it exits `0`.** Exit `1` means refused: its last line, `gate.result`,
names the schema identities that block the release, and each `release.refusal` and `gate.refusal`
line says why. What it checks is in
[Releasing the spec and its schemas](../release-spec/README.md#the-release-gate).

To see the workflow itself work on a runner before the tag exists, start it by hand as a
[dry run](../release-spec/README.md#the-dry-run-of-a-release-workflow):
`gh workflow run release-parley-emit.yml --ref main`. It makes nothing public.

## What the tag starts

The tag starts `.github/workflows/release-parley-emit.yml`, which:

| Job | Does |
| --- | --- |
| `sanity` | Refuses a tag whose version differs from `package.json` or has no changelog heading; checks the manifest fields; installs the Wesley pinned in `package.json` `config.wesley`, as the checks workflow does; runs `bun test`, `bun run check`, `bun run typecheck`; refuses a stale `src/schemas.ts`; dry-runs the pack; fails if `npm publish --dry-run` reports that it would rewrite or remove anything in the manifest |
| `gate` | Packs the tarball, **once**, and runs the [release gate](../release-spec/README.md#the-release-gate) on that file: `bun run release-gate -- parley-emit --tag <the tag> --out <dir>`. That is the `publication` phase of the release-eligibility check on the tarball, with the frozen-since reference set to the previous `parley-emit-v` tag; the tag, the dated changelog heading, the commit being on `main` and the tree being clean; the manifest inside the tarball being the repository's, with no `workspace:` range. It writes the release report, prints it in the job summary, and only then uploads the tarball, `SHA256SUMS` and the report as a workflow artifact |
| `release` | Downloads that artifact, compares the tarball's SHA-256 with the gate job's output, and creates the GitHub release named after the tag, with the changelog section as notes and the tarball, `SHA256SUMS` and `release-report.json` attached. It packs nothing |
| `publish` | In the `npm` environment, with no checkout: downloads the same artifact, compares the digest again, and stages **that file** with `npm stage publish <tarball> --access public --provenance` through npm's trusted publishing; no token lives in the repository. Nothing is installable yet |

Each job needs the one before it, so when the gate refuses, no GitHub release is created and
nothing is staged. `scripts/release.test.ts` holds that shape on every pull request, and
`scripts/release-gate.test.ts` runs the gate job's own steps on a fixture that bundles a draft
schema: the gate step fails, the report is printed, and the upload does not run.

## What the owner approves

**A release ends with the owner's approval.** The trusted publisher is allowed to stage and nothing
else, so a workflow cannot put code in front of users on its own. What is approved is an identified
file, not a version number:

1. Open the GitHub release for the tag and read `release-report.json` (the `gate` job's summary
   prints the same document). It names the package and version, the source commit and tree, the
   spec release, every bundled schema with the digest of its released snapshot, the gate's result,
   and the tarball's digests: `artifact.sha256`, `artifact.sha1` (what npm prints as
   `shasum`) and `artifact.integrity`. The `publish` job's summary repeats those three and shows
   what npm printed when it staged.
2. Find the staged version and download what npm holds:

   ```bash
   npm stage list @flyingrobots/parley-emit
   npm stage download <stage-id>
   shasum -a 256 <the downloaded tarball>
   ```

   The digest must be the report's `artifact.sha256`, which is also the digest in `SHA256SUMS` and
   of the tarball on the GitHub release. If it is not, reject the stage (`npm stage reject
   <stage-id>`) and do not approve.
3. Approve with a one-time password, or on the package's **Staged Packages** tab on npmjs.com:

   ```bash
   npm stage approve <stage-id>
   ```

These commands need an interactive login and cannot be run from CI.

**Step 2 is the owner's because the workflow cannot do it.** `npm stage publish` accepts a tarball
path and sends that file's bytes: with npm 12.2.3, `npm stage publish <tarball> --dry-run` from an
empty directory reported the `shasum` and `integrity` of the file it was given, so the job stages
the checked tarball and repacks nothing. But the token the job gets by OIDC can run
`npm stage publish` and no other `stage` subcommand (`npm help stage`: "Shortlived tokens cannot
run npm stage subcommands"), so the job cannot list, view or download what it staged, and cannot
record the stage id in the report. The comparison after staging is made by a person with a login.
What `npm stage download` and `npm stage view` print was not exercised when this was written:
they need a staged package and a login. If `npm stage view <stage-id>` shows a `shasum` or an
`integrity`, those are the report's `artifact.sha1` and `artifact.integrity`.

## What the workflow cannot verify

These protections are real only if the settings behind them are what this page says. The workflow
has no way to read them, so they are limits, not guarantees:

- **The `npm` environment's required reviewers.** The `publish` job runs in the GitHub environment
  `npm`. Whether that environment requires a reviewer, and who, is a repository setting. If it
  requires none, `publish` runs as soon as `release` succeeds.
- **Tag protection.** Anyone who can push a tag matching `parley-emit-v*` starts this workflow. The gate
  refuses a commit that is not on `main` and a tag that is not the version's, but whether tags can
  be created, moved or deleted, and by whom, is a repository ruleset the workflow cannot verify.
  A tag moved after a release would not change the released artifact; it would make the tag lie.
- **What the trusted publisher allows.** This page says the publisher on npmjs.com allows
  `npm stage publish` only. If **Allow `npm publish`** were checked there, a workflow change could
  publish without approval. The setting is on npmjs.com and the workflow cannot verify it; the
  workflow's own text never runs `npm publish`, and `scripts/release.test.ts` holds that.
- **The checks on `main`.** The gate compares released snapshots with the previous release tag and
  with the baseline. It does not know whether the `checks` workflow was required and green for
  every pull request merged since.
- **The approval itself.** Nothing verifies that the owner made the comparison in step 2 before
  approving.

## Re-running

A job that failed is re-run with **Re-run failed jobs**, which keeps the `gate` job's artifact, so
`release` and `publish` use the tarball that was judged. **Re-run all jobs** packs again; if the
GitHub release already exists, `release` then compares the new tarball with the one the release
carries, byte for byte, and fails on a difference rather than replacing it.

## One-time setup

The repository has a GitHub environment named `npm`. On npmjs.com, the package's settings carry a
trusted publisher pointing at this repository and workflow (owner `flyingrobots`, repository
`parley`, workflow `release-parley-emit.yml`, environment `npm`), with **Allow `npm publish`** and
**Allow `npm dist-tag`** both unchecked, so it may run `npm stage publish` and nothing else. A
workflow that runs `npm publish` against it is refused with `OIDC permission denied for this
action`. Without the entry the publish job fails and nothing is staged; the GitHub release still
exists. Neither setting can be read by the workflow
([what the workflow cannot verify](#what-the-workflow-cannot-verify)).

## Packages that depend on it

`@flyingrobots/parley-read` depends on parley-emit by a caret range, so a parley-read release whose
range names a new parley-emit version waits for that version to be on npm; its workflow refuses
otherwise ([releasing parley-read](../release-parley-read/README.md)).

## The first release

`0.1.0` (tag `parley-emit-v0.1.0`, 2026-11-22) was published by hand before this workflow
existed, with the GitHub release created the same way. `0.2.0`, `0.2.1` and `0.2.2` were tagged and
released on GitHub but never reached npm: their workflow ran `npm publish`, which the trusted
publisher refuses. `0.2.3` was tagged and stopped at `sanity`, which lacked the pinned Wesley. `0.2.4` is the first
version staged. `0.3.0` was tagged (`parley-emit-v0.3.0`) and released on GitHub, and its npm
version was staged by the workflow; npm does not list it, and `0.4.0` supersedes it.
