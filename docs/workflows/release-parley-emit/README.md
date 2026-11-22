# Releasing parley-emit

How a version of `@flyingrobots/parley-emit` reaches npm. This is a contributor operation; what
the package does is in [its reference](../../topics/parley-emit/README.md).

## The order

1. Record the changes under a new heading in `packages/parley-emit/CHANGELOG.md`, dated, and
   note the release in the root `CHANGELOG.md`. A package release publishes no schema version
   (spec §4.5); the shipped schemas are the drafts at the commit pinned in `src/schemas.ts`, so
   run `bun run sync-schemas` there first if the drafts moved.
2. Set `version` in `packages/parley-emit/package.json` to the same number.
3. Merge that through a pull request; the checks workflow must be green.
4. Tag the merge commit on `main` as `parley-emit-vX.Y.Z` and push the tag.

The tag starts `.github/workflows/release-parley-emit.yml`, which:

| Job | Does |
| --- | --- |
| `sanity` | Refuses a tag whose version differs from `package.json` or has no changelog heading; checks the manifest fields; runs `bun test`, `bun run check`, `bun run typecheck`; refuses a stale `src/schemas.ts`; dry-runs the pack |
| `release` | Creates the GitHub release named after the tag, with the changelog section as notes and the tarball plus `SHA256SUMS` attached |
| `publish` | In the `npm` environment, publishes with OIDC provenance through npm's trusted publishing; no token lives in the repository |

The tarball on the GitHub release and the one on npm are the same bytes; compare the digest when
in doubt.

## One-time setup

The repository has a GitHub environment named `npm`. On npmjs.com, the package's settings carry a
trusted publisher pointing at this repository and workflow (owner `flyingrobots`, repository
`parley`, workflow `release-parley-emit.yml`, environment `npm`). Without that entry the publish
job fails with an authentication error and nothing is published; the GitHub release still exists
and can be published by hand with `npm publish --access public` from `packages/parley-emit` at
the tagged commit.

## The first release

`0.1.0` (tag `parley-emit-v0.1.0`, 2026-11-22) was published by hand before this workflow
existed, with the GitHub release created the same way.
