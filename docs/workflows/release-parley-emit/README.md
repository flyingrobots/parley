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
4. Tag the merge commit on `main` as `parley-emit-vX.Y.Z` and push the tag.

The tag starts `.github/workflows/release-parley-emit.yml`, which:

| Job | Does |
| --- | --- |
| `sanity` | Refuses a tag whose version differs from `package.json` or has no changelog heading; checks the manifest fields; runs `bun test`, `bun run check`, `bun run typecheck`; refuses a stale `src/schemas.ts`; dry-runs the pack; fails if `npm publish --dry-run` reports that it would rewrite or remove anything in the manifest, if the packed `package.json` differs from the repository's, or if any dependency uses a `workspace:` range |
| `release` | Creates the GitHub release named after the tag, with the changelog section as notes and the tarball plus `SHA256SUMS` attached |
| `publish` | In the `npm` environment, stages the version with `npm stage publish` and OIDC provenance through npm's trusted publishing; no token lives in the repository. Nothing is installable yet |

**A release ends with the owner's approval.** The trusted publisher is allowed to stage and nothing
else, so a workflow cannot put code in front of users on its own. The owner lists what is waiting
and approves it with their one-time password, or does the same on the package's **Staged Packages**
tab on npmjs.com:

```bash
npm stage list @flyingrobots/parley-emit
npm stage approve <stage-id>
```

These commands need an interactive login and cannot be run from CI.

The tarball on the GitHub release and the one on npm are the same bytes; compare the digest when
in doubt.

## One-time setup

The repository has a GitHub environment named `npm`. On npmjs.com, the package's settings carry a
trusted publisher pointing at this repository and workflow (owner `flyingrobots`, repository
`parley`, workflow `release-parley-emit.yml`, environment `npm`), with **Allow `npm publish`** and
**Allow `npm dist-tag`** both unchecked, so it may run `npm stage publish` and nothing else. A
workflow that runs `npm publish` against it is refused with `OIDC permission denied for this
action`. Without the entry the publish job fails and nothing is staged; the GitHub release still
exists.

## Packages that depend on it

`@flyingrobots/parley-read` depends on parley-emit by a caret range, so a parley-read release whose
range names a new parley-emit version waits for that version to be on npm; its workflow refuses
otherwise ([releasing parley-read](../release-parley-read/README.md)).

## The first release

`0.1.0` (tag `parley-emit-v0.1.0`, 2026-11-22) was published by hand before this workflow
existed, with the GitHub release created the same way. `0.2.0`, `0.2.1` and `0.2.2` were tagged and
released on GitHub but never reached npm: their workflow ran `npm publish`, which the trusted
publisher refuses. `0.2.3` is the first version staged.
