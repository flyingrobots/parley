# Releasing parley-read

How a version of `@flyingrobots/parley-read` reaches npm. This is a contributor operation; what
the package does is in [its reference](../../topics/parley-read/README.md). The workflow mirrors
[parley-emit's](../release-parley-emit/README.md); what differs is the dependency on parley-emit
and the first publish.

## The order

1. Record the changes under a new dated heading in `packages/parley-read/CHANGELOG.md`, and note
   the release in the root `CHANGELOG.md`. A package release publishes no schema version (spec
   §4.5); the shipped schemas are the top-level files in `schemas/`, and the released snapshots of
   any other version, at the commit pinned in `src/schemas.ts`, so run `bun run sync-schemas`
   there first if they moved. A version that ships a draft schema stamps lines with a pair whose
   bytes may still change (spec §4.5), so release the schema first.
2. Set `version` in `packages/parley-read/package.json` to the same number. Its dependency on
   `@flyingrobots/parley-emit` is a caret range (`^0.4.0` for 0.2.0), never `workspace:*`: npm
   publishes a `workspace:` range verbatim, and no installer outside this repository can resolve
   it. The range must admit the version of `packages/parley-emit` in the repository, so the
   workspace still links the local copy; `scripts/release.test.ts` checks both.
3. Merge that through a pull request; the checks workflow must be green.
4. **Publish parley-emit first** when the range names a parley-emit version that is not on npm yet:
   tag `parley-emit-vX.Y.Z`, wait for its `publish` job to stage it and for the owner to approve
   it, until `npm view @flyingrobots/parley-emit version` names it.
5. Run the gate on `main` at the merge commit: `bun run release-gate -- parley-read`
   ([below](#before-the-tag-the-gate)).
6. Only once it exits `0`, tag the merge commit on `main` as `parley-read-vX.Y.Z` and push the tag.

## Before the tag: the gate

A pushed tag cannot be taken back, and the workflow starts from one. So the same gate the workflow
runs is run first by the person tagging, on `main` at the merge commit, with a clean tree:

```bash
bun run release-gate -- parley-read
```

**Push the tag only after it exits `0`.** Exit `1` means refused: its last line, `gate.result`,
names the schema identities that block the release, and each `release.refusal` and `gate.refusal`
line says why. What it checks is in
[Releasing the spec and its schemas](../release-spec/README.md#the-release-gate). Run without
`--consumer` it installs nothing from npm; the workflow's gate does, and that part is
[the clean consumer](#the-clean-consumer) below.

To see the workflow itself work on a runner before the tag exists, start it by hand as a
[dry run](../release-spec/README.md#the-dry-run-of-a-release-workflow):
`gh workflow run release-parley-read.yml --ref main`. It makes nothing public.

## What the tag starts

The tag starts `.github/workflows/release-parley-read.yml`, which:

| Job | Does |
| --- | --- |
| `sanity` | Refuses a tag whose version differs from `package.json` or has no changelog heading; checks the manifest fields; installs the Wesley pinned in `package.json` `config.wesley`, as the checks workflow does; runs `bun test`, `bun run check`, `bun run typecheck`; refuses a stale `src/schemas.ts`; refuses a parley-emit range nothing on npm satisfies; dry-runs the pack; fails if `npm publish --dry-run` reports that it would rewrite or remove anything in the manifest |
| `gate` | Packs the tarball, **once**, and runs the [release gate](../release-spec/README.md#the-release-gate) on that file: `bun run release-gate -- parley-read --tag <the tag> --out <dir> --consumer`. That is the `publication` phase of the release-eligibility check on the tarball, with the frozen-since reference set to the previous `parley-read-v` tag; the tag, the dated changelog heading, the commit being on `main` and the tree being clean; the manifest inside the tarball being the repository's, with no `workspace:` range; and, for this package, the **clean consumer**: the packed reader and `@flyingrobots/parley-emit` are installed from npm into a new directory outside the workspace, the step fails unless the writer came from the registry (not a link, not a file, not a directory of this repository), and a smoke read runs there. It writes the release report, prints it in the job summary, and only then uploads the tarball, `SHA256SUMS` and the report as a workflow artifact |
| `release` | Downloads that artifact, compares the tarball's SHA-256 with the gate job's output, and creates the GitHub release named after the tag, with the changelog section as notes and the tarball, `SHA256SUMS` and `release-report.json` attached. It packs nothing |
| `publish` | In the `npm` environment, with no checkout: downloads the same artifact, compares the digest again, and stages **that file** with `npm stage publish <tarball> --access public --provenance` through npm's trusted publishing; no token lives in the repository. Nothing is installable yet |

Each job needs the one before it, so when the gate refuses, no GitHub release is created and
nothing is staged. `scripts/release.test.ts` holds that shape on every pull request, and
`scripts/release-gate.test.ts` runs the gate job's own steps on a fixture that bundles a draft
schema: the gate step fails, the report is printed, and the upload does not run.

## The clean consumer

Inside this repository Bun links the workspace copy of `@flyingrobots/parley-emit`, so no test
here says anything about the reader with the writer a consumer will install. The gate's
`--consumer` step does (`scripts/clean-consumer.ts`):

1. It makes a new directory under the system's temporary directory and refuses one that is inside
   the repository.
2. It runs `npm install <the packed tarball>` there, against `https://registry.npmjs.org/`, with no
   workspace link and no `bun link`.
3. It reads the lockfile and `node_modules`: the reader's recorded integrity must be the tarball's,
   and the writer must have a registry resolution and integrity, be a real directory and not a
   link, and not resolve into the repository. Otherwise the step fails
   (`consumer.dependency_linked`, `consumer.dependency_not_from_registry`,
   `consumer.dependency_missing`, `consumer.dependency_differs`, `consumer.reader_differs`).
4. It runs a smoke read there with Bun: it writes one receipt bundle of two records, loads it with
   `loadReceipts`, and requires two validated records and the reader's own import of the writer to
   resolve inside that directory (`consumer.smoke_failed`).

The result, with the writer's exact version and integrity, goes in the release report as
`consumer`. The refusals are tested on hand-built directories, one of them with the writer linked
into the workspace (`scripts/release-gate.test.ts`, CONS-1 to CONS-3). The install itself needs the
registry, so `bun test` does not run it; it was run by hand once, on the reader of tag
`parley-read-v0.1.1`, and resolved `@flyingrobots/parley-emit` 0.2.4 from npm.

## What the owner approves

**A release ends with the owner's approval.** The trusted publisher is allowed to stage and nothing
else, so a workflow cannot put code in front of users on its own. What is approved is an identified
file, not a version number:

1. Open the GitHub release for the tag and read `release-report.json` (the `gate` job's summary
   prints the same document). It names the package and version, the source commit and tree, the
   spec release, every bundled schema with the digest of its released snapshot, the gate's result,
   the exact `@flyingrobots/parley-emit` version and integrity the reader was proved against (`consumer.dependency`), and the tarball's digests: `artifact.sha256`, `artifact.sha1` (what npm prints as
   `shasum`) and `artifact.integrity`. The `publish` job's summary repeats those three and shows
   what npm printed when it staged.
2. Find the staged version and download what npm holds:

   ```bash
   npm stage list @flyingrobots/parley-read
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
- **Tag protection.** Anyone who can push a tag matching `parley-read-v*` starts this workflow. The gate
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

## One-time setup: the first publish is manual

npm attaches a trusted publisher to a package that already exists, so **the first version of a new
package is published by hand by the owner, with a one-time password**, as parley-emit's 0.1.0 was.
This was done for parley-read on 2026-11-24 with 0.1.0; what follows records how, for the next new
package. Until then the `publish` job of the first tag fails with a 404 from the registry (the
package does not exist), and that failure is expected: the GitHub release exists and carries the
tarball.

From a clean checkout of the tag, after parley-emit's required version is on npm:

```bash
git checkout parley-read-v0.1.0
cd packages/parley-read
npm publish --access public --otp <code from the authenticator>
```

Then, on npmjs.com, in the settings of `@flyingrobots/parley-read`, add a trusted publisher with:

| Field | Value |
| --- | --- |
| Publisher | GitHub Actions |
| Owner | `flyingrobots` |
| Repository | `parley` |
| Workflow | `release-parley-read.yml` |
| Environment | `npm` |
| Allow `npm publish` | unchecked |
| Allow `npm dist-tag` | unchecked |

The repository's `npm` environment already exists for parley-emit. Every later tag is staged by
the workflow with provenance and approved by the owner. A manual publish carries no provenance statement; that is the one
version without it.
