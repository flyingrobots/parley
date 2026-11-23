# Releasing parley-read

How a version of `@flyingrobots/parley-read` reaches npm. This is a contributor operation; what
the package does is in [its reference](../../topics/parley-read/README.md). The workflow mirrors
[parley-emit's](../release-parley-emit/README.md); what differs is the dependency on parley-emit
and the first publish.

## The order

1. Record the changes under a new dated heading in `packages/parley-read/CHANGELOG.md`, and note
   the release in the root `CHANGELOG.md`. A package release publishes no schema version (spec
   §4.5); the shipped schemas are the top-level files in `schemas/` at the commit pinned in
   `src/schemas.ts`, so run `bun run sync-schemas` there first if they moved.
2. Set `version` in `packages/parley-read/package.json` to the same number. Its dependency on
   `@flyingrobots/parley-emit` is a caret range (`^0.2.0` for 0.1.0), never `workspace:*`: npm
   publishes a `workspace:` range verbatim, and no installer outside this repository can resolve
   it. The range must admit the version of `packages/parley-emit` in the repository, so the
   workspace still links the local copy; `scripts/release.test.ts` checks both.
3. Merge that through a pull request; the checks workflow must be green.
4. **Publish parley-emit first** when the range names a parley-emit version that is not on npm yet:
   tag `parley-emit-vX.Y.Z`, wait for its `publish` job to stage it and for the owner to approve
   it, until `npm view @flyingrobots/parley-emit version` names it.
5. Tag the merge commit on `main` as `parley-read-vX.Y.Z` and push the tag.

The tag starts `.github/workflows/release-parley-read.yml`, which:

| Job | Does |
| --- | --- |
| `sanity` | Refuses a tag whose version differs from `package.json` or has no changelog heading; checks the manifest fields; installs the Wesley pinned in `package.json` `config.wesley`, as the checks workflow does; runs `bun test`, `bun run check`, `bun run typecheck`; refuses a stale `src/schemas.ts`; refuses a parley-emit range nothing on npm satisfies; dry-runs the pack; fails if `npm publish --dry-run` reports that it would rewrite or remove anything in the manifest, if the packed `package.json` differs from the repository's, or if any dependency uses a `workspace:` range |
| `release` | Creates the GitHub release named after the tag, with the changelog section as notes and the tarball plus `SHA256SUMS` attached |
| `publish` | In the `npm` environment, stages the version with `npm stage publish` and OIDC provenance through npm's trusted publishing; no token lives in the repository. Nothing is installable yet |

**A release ends with the owner's approval.** The trusted publisher is allowed to stage and nothing
else, so a workflow cannot put code in front of users on its own. The owner lists what is waiting
and approves it with their one-time password, or does the same on the package's **Staged Packages**
tab on npmjs.com:

```bash
npm stage list @flyingrobots/parley-read
npm stage approve <stage-id>
```

These commands need an interactive login and cannot be run from CI.

## One-time setup: the first publish is manual

npm attaches a trusted publisher to a package that already exists, so **the first version of a new
package is published by hand by the owner, with a one-time password**, as parley-emit's 0.1.0 was.
Until then the `publish` job of the first tag fails with a 404 from the registry (the package does
not exist), and that failure is expected: the GitHub release exists and carries the tarball.

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
