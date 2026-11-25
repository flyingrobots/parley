# Releasing the spec and its schemas

How a schema version becomes released, and how to check that a package may be released as stable.
This is a contributor operation. What a release is, and why a released schema is immutable, is in
[Releases](../../topics/release/README.md); the cases that hold this page to the code are in its
[test plan](test-plan.md).

## The rule

> **A stable Parley distribution MUST NOT embed, advertise, or emit a repository-owned protocol
> schema identity unless that exact `(id, version)` has been released and resolves to its frozen
> definition. Release checks MUST inspect the distributable artifact, and publication MUST be
> bound to the checked candidate.**

It governs Parley's own protocol schemas, the `parley.*` messages under `schemas/`. It does not
govern a tool-owned schema that a writer can emit for a tool, nor the `parley.tooling.*` output of
this repository's scripts. The three version spaces stay separate (spec §4.4): a package version
cannot confer release status on a schema.

The checks that existed before this rule establish that the package copies agree with the working
tree, and `scripts/schemas.test.ts` deliberately admits a top-level schema that is a draft named
under `## [Unreleased]`. That is right for development and is not a release permit.

## The checker

`scripts/release-check.ts` decides it. It takes a phase, and inspects either the source tree of
every package under `packages/` or the artifacts it is given:

```text
bun run release-check --phase development
bun run release-check --phase candidate
bun run release-check --phase publication
bun run release-check --phase publication --artifact flyingrobots-parley-read-0.2.0.tgz
bun run release-check --phase publication --artifact packages/parley-emit-py/parley_emit.py
bun run release-check --phase development --base <an earlier ref you trust>
bun run release-check --phase publication --frozen-since <the previous release tag>
```

| Phase | Allows | Passing means |
| --- | --- | --- |
| `development` | declared drafts | the source is internally consistent; each package's release eligibility is **reported**, with the exact blocking schema identities, and does not fail the run |
| `candidate` | a release pull request that proposes new snapshots and a release declaration | the proposed candidate is structurally reviewable |
| `publication` | nothing proposed | every required schema release is already accepted on the default branch; the identified artifact is eligible |

`bun test` runs `development` on this repository every time (`scripts/release-check.test.ts`,
case RLC-18), so an inconsistent source fails the ordinary gate and the eligibility report is
always computed. The release workflows call it through [the release gate](#the-release-gate),
on the artifact they are about to release.

| Flag | Meaning |
| --- | --- |
| `--phase` | Required: `development`, `candidate` or `publication` |
| `--base REF` | The trusted baseline. Default: the merge base of `HEAD` and `origin/main` |
| `--frozen-since REF` | A second reference, independent of `--base`: every snapshot at it must be byte-identical in the candidate. It must name an ancestor of `HEAD`. No default |
| `--repo DIR` | The repository holding the snapshots, the changelog and the history. Default: the working directory |
| `--artifact FILE` | Inspect this file in place of the source tree: an npm tarball (`.tgz`) or a vendorable `.py` file. Repeatable |
| `--human` | Prose in place of JSON Lines |
| `--help` | One `release.help` line describing the command |

Exit status is `0` when the phase passes, `1` when anything is refused, and `2` when the check
could not run (a usage error, or a `--repo` that is not a git repository).

### What it reads

A package's **inventory** is what it bundles and what it declares.

- **Bundled**: the schemas in the copy `bun run sync-schemas` writes, which is `src/schemas.ts` in
  the TypeScript packages and the block between `# BEGIN SCHEMAS` and `# END SCHEMAS` in
  `parley_emit.py`. The copy carries its **source pin**: a commit and the SHA-256 of each schema
  file at that commit.
- **Declared**: every literal `{ id: "parley.…", version: "X.Y.Z" }` in the code the package ships,
  which is how the writers and the reader state the pair they stamp on a line. In a source tree
  that is the code under the manifest's `files`; in a tarball it is every code file.

Both are read as text. Nothing from the tree or the artifact under test is executed. Given a
tarball, the checker unpacks it to a temporary directory and reads `package/` there; given a `.py`
file, it reads that file. It does not look at the neighbouring workspace for either.

### What `candidate` and `publication` require

For every identity a package bundles or declares:

| Requirement | Refusal when it fails |
| --- | --- |
| A frozen snapshot at `schemas/released/<id>/<version>.schema.json` | `schema.unreleased` |
| A dated release heading in the root `CHANGELOG.md` that names it | `release.heading_missing` |
| In `candidate`, for a version with no snapshot at the baseline, a naming heading that is new too: one whose version the baseline's changelog does not have | `release.heading_backdated` |
| In `publication`, both of those at the baseline, not only in the candidate | `release.not_accepted` |
| The bundled definition equal to the snapshot's, as a parsed JSON value | `definition.differs` |
| Every declared identity present in the bundle | `inventory.declared_not_bundled` |

For the source pin, verified by content, since a commit-shaped string proves nothing:

| Requirement | Refusal when it fails |
| --- | --- |
| The commit is a full commit id, and the pinned files are the bundled schemas | `pin.malformed` |
| The commit exists in the repository | `pin.commit_missing` |
| The commit is an ancestor of `HEAD` (`candidate`) or of the baseline (`publication`) | `pin.unreachable` |
| Each pinned file at that commit has the recorded digest | `pin.content_differs` |
| The bundled definition is that file's | `pin.bundle_differs` |

And for the inventory and the repository:

| Condition | Refusal |
| --- | --- |
| The artifact is missing, is not a tarball or a `.py` file, or does not unpack to a package | `artifact.unreadable` |
| The bundle is missing or is not in the form the sync script writes | `inventory.unreadable` |
| The bundle holds no schema | `inventory.empty` |
| A source package's bundled definition is not the tree's schema of that pair | `copy.stale` |
| A released snapshot at the baseline has other bytes in the candidate | `snapshot.modified` |
| A released snapshot at the baseline is gone | `snapshot.deleted` |
| A snapshot's content names another `(id, version)` than its path | `snapshot.mismatched` |
| A top-level schema file claims a released pair and is not its snapshot's definition | `toplevel.differs` |
| A snapshot at the frozen-since reference has other bytes in the candidate, or is gone | `snapshot.modified`, `snapshot.deleted` |
| The baseline names no commit | `baseline.unresolved` |
| `--frozen-since` names no commit | `frozen_since.unresolved` |
| `--frozen-since` names a commit that is not an ancestor of `HEAD` | `frozen_since.not_ancestor` |

An empty or unreadable inventory is a failure, never a pass, and so is a run that found no package.

`development` refuses only what makes the source inconsistent: `artifact.unreadable`, the three
`inventory.*` codes, `copy.stale`, `toplevel.differs`, the three `snapshot.*` codes,
`pin.malformed` and the two `frozen_since.*` codes, since a reference the caller named and the
check cannot use is never passed over. Everything else it reports, per package, as what blocks a
stable release.

A release pull request releases a version by adding a heading. `candidate` therefore asks of each
newly snapshotted version whether a heading that names it is new: adding `` `parley.query` 1.1.0 ``
to an entry the baseline already has would put the version in a release that was cut before it
existed, and is `release.heading_backdated`. A heading is identified by its version, `[X.Y.Z]`.
Its date and its text are not compared, so a typo fixed in an old entry is not a refusal, and an
old heading given today's date is still the old heading. A version named under a new heading and
repeated under an old one is released by the new one.

Two identities are compared two ways, as decided on flyingrobots/parley#116. A **snapshot is
byte-frozen**: any byte that differs from the baseline is `snapshot.modified`. A **top-level file
or a bundled copy** holds a released version when it equals the snapshot as a parsed JSON value,
so key order and whitespace are free. `scripts/schemas.test.ts` still asks the top-level files of
this repository for the snapshot's exact bytes, which is stricter and stays until spec §4.5
changes.

### The baseline

Agreement between copies cannot detect a coordinated edit: change a released snapshot, its
top-level file and every bundled copy in one commit, and the candidate agrees with itself
perfectly. So released snapshots are compared with a **baseline the candidate did not choose**,
a git ref given as `--base`. The default is the merge base of `HEAD` and `origin/main`, which on a
pull request branch is the commit it forked from.

The baseline has a second job in `publication`: it is the default branch, and a release counts
only when its snapshot and its dated heading are there. So `publication` passes for a release
pull request only once it has merged.

On the default branch itself the merge base is `HEAD`, so there the default compares the tree with
its own commit: a coordinated edit that has already merged is not seen. Naming an older `--base`
does not help in `publication`, which asks whether the releases existed at that ref and refuses
the ones made since. So there is a second reference.

### The frozen-since reference

`--frozen-since REF` names an earlier commit of the same history, chosen independently of
`--base`. Every snapshot that exists at it must have the same bytes in the candidate; one that
differs is `snapshot.modified` and one that is gone is `snapshot.deleted`, and the problem says
which reference it was compared with. Snapshots added since the reference are not its business,
so releases made since it still pass. It applies in every phase and has one job: it never decides
whether a release is accepted, which stays with the baseline.

The reference must resolve (`frozen_since.unresolved`) and must be an ancestor of `HEAD`
(`frozen_since.not_ancestor`): agreement with a commit that is not an earlier state of the history
being released would establish nothing. There is no default, because nothing in this repository
names the previous spec release by a tag. Whoever runs `publication` on the default branch names
it. [The release gate](#the-release-gate) does, with the previous release tag of the package being
released. Without the
flag, `publication` on the default branch establishes that the releases are accepted and that the
artifact matches them, and the comparison that catches an edited snapshot is the one `bun test`
made on each pull request against the commit it forked from, which holds only if that check was
required and green when the edit merged.

`candidate` and `publication` refuse to run without a baseline; `development` says the baseline is
unresolved and reports no package eligible. A shallow clone has no merge base, which is why the
checks workflow fetches full history.

### Output

JSON Lines, each stamped `_schema: {id: "parley.tooling.release_check", version: "1.1.0"}`. The
schema is `scripts/release-check.schema.json`, and a test asserts that every line the checker
emitted across its cases validates against it. Like the other scripts here it is repository
tooling, not a parley program: its lines carry no `t`, `seq` or `run`.

| Line | Says |
| --- | --- |
| `release.baseline` | Both references: the baseline asked for, the commit it names and how many released snapshots that commit holds; and the same three for `--frozen-since` (`frozen_since`, `frozen_since_commit`, `frozen_since_snapshots`), null when it was not given |
| `release.refusal` | One reason this phase fails: the package (null for the repository), a code, and the identity or path it concerns |
| `release.package` | One per package: its version, pin, inventory counts, `passed` for this phase, `eligible` for a stable release, the `blocking` identities and any other `blockers` |
| `release.summary` | The phase's verdict, and the packages eligible and not eligible |
| `release.help` | The usage, for `--help` |
| `error` | On stderr, with exit `2`: the check could not run |

`eligible` always answers the `publication` question, whichever phase ran, so `development` on a
feature branch says what a release would be refused for today.

Captured from `bun run release-check --phase development` on this repository at commit `b4ac760`,
when `parley.query` 1.1.0 and `parley.lens` 1.1.0 were drafts; the baseline line, the first
package line and the summary, of five lines:

```jsonl illustrative
{"event":"release.baseline","phase":"development","base":"merge-base(HEAD, origin/main)","commit":"29e95b91b5e02c7654ea4422f127a33310485777","resolved":true,"snapshots":17,"frozen_since":null,"frozen_since_commit":null,"frozen_since_snapshots":null,"_schema":{"id":"parley.tooling.release_check","version":"1.1.0"}}
{"event":"release.package","phase":"development","package":"@flyingrobots/parley-emit","version":"0.4.0","source":"tree","path":"packages/parley-emit","sha256":null,"pin":"f8a5a26727aeec5d75d37e108304dc7c989ce1ff","bundled":17,"declared":14,"passed":true,"eligible":false,"blocking":[{"id":"parley.lens","version":"1.1.0","code":"schema.unreleased"},{"id":"parley.query","version":"1.1.0","code":"schema.unreleased"}],"blockers":[],"_schema":{"id":"parley.tooling.release_check","version":"1.1.0"}}
{"event":"release.summary","phase":"development","passed":true,"packages":3,"eligible":[],"not_eligible":["@flyingrobots/parley-emit","@flyingrobots/parley-emit-py","@flyingrobots/parley-read"],"refusals":0,"_schema":{"id":"parley.tooling.release_check","version":"1.1.0"}}
```

The first refusal of `--phase publication` on the same tree, which exits `1`:

```jsonl illustrative
{"event":"release.refusal","phase":"publication","package":"@flyingrobots/parley-emit","code":"schema.unreleased","problem":"parley.lens@1.1.0 has no snapshot at schemas/released/parley.lens/1.1.0.schema.json: it is a draft, and a stable release may not carry it","id":"parley.lens","version":"1.1.0","_schema":{"id":"parley.tooling.release_check","version":"1.1.0"}}
```

And the first line of `--phase publication --frozen-since parley-read-v0.1.1` there, naming both
references:

```jsonl illustrative
{"event":"release.baseline","phase":"publication","base":"merge-base(HEAD, origin/main)","commit":"29e95b91b5e02c7654ea4422f127a33310485777","resolved":true,"snapshots":17,"frozen_since":"parley-read-v0.1.1","frozen_since_commit":"1a7b74c29182bc3eb65c15dc74996d79777de88f","frozen_since_snapshots":17,"_schema":{"id":"parley.tooling.release_check","version":"1.1.0"}}
```

## The release gate

`scripts/release-gate.ts` asks the checker's `publication` question of one package at the current
commit, on the artifact that would be released, before anything public exists:

```text
bun run release-gate -- parley-emit
bun run release-gate -- parley-read
bun run release-gate -- parley-emit-py
bun run release-gate -- parley-read --tag parley-read-v0.2.0 --out <dir> --consumer
```

It has two callers. The person tagging runs it on `main` at the merge commit and **pushes the tag
only after it exits `0`**, because a pushed tag cannot be taken back. Each release workflow runs it
as its `gate` job, and every job that creates a GitHub release or stages on npm needs that job
([parley-emit](../release-parley-emit/README.md), [parley-read](../release-parley-read/README.md),
[parley-emit-py](../release-parley-emit-py/README.md)).

| Flag | Meaning |
| --- | --- |
| `<package>` | Required: a directory under `packages/`, or the package's published name |
| `--tag TAG` | The tag being released; it must be `<directory>-v<version>` |
| `--out DIR` | Leave the artifact, `SHA256SUMS` and `release-report.json` in this directory |
| `--artifact FILE` | Judge this file in place of building one |
| `--frozen-since REF` | Use this reference in place of the derived one |
| `--consumer` | After everything else passes, prove the packed package against the packages here it depends on, as npm serves them ([the clean consumer](../release-parley-read/README.md#the-clean-consumer)) |
| `--repo DIR` | The repository. Default: the working directory |
| `--human` | Prose in place of JSON Lines |
| `--help` | One `gate.help` line |

Exit status is `0` when the artifact may be released, `1` when anything is refused, and `2` when
the gate could not run (a usage error, a `--repo` that is not a git repository, a pack that
failed).

### What it does

1. **Builds the artifact once.** For an npm package, `npm pack` into `--out` (or a temporary
   directory); for `parley_emit.py`, the file itself. Every later statement is about that file.
2. **Derives the frozen-since reference**: the highest tag `<directory>-vX.Y.Z` below the version
   being released that is an ancestor of `HEAD`. Versions are compared as numbers, and a tag off
   this history, a pre-release tag, the tag of the version being released and another package's
   tags are not candidates. That is the package's previous release, read from the tags the release
   workflows are triggered by. A package with no earlier release has none, and the gate says so
   (`how: "none"`) rather than inventing one; released snapshots are then compared with the
   baseline alone.
3. **Runs `release-check --phase publication --artifact <the file> --frozen-since <that tag>`**
   and passes its lines through, under the checker's own stamp.
4. **Checks what the checker does not**:

   | Condition | Refusal |
   | --- | --- |
   | `--tag` is not this package's tag for this version | `gate.tag_mismatch` |
   | The package's `CHANGELOG.md` has no dated heading for the version | `gate.changelog_heading_missing` |
   | `HEAD` is not on `origin/main` | `gate.not_on_default_branch` |
   | The working tree differs from `HEAD` | `gate.dirty_tree` |
   | The artifact is another package's, or another version's | `gate.artifact_mismatch` |
   | The `package.json` inside the tarball is not the repository's, as a JSON value | `gate.manifest_differs` |
   | The tarball's manifest has a `workspace:` dependency range | `gate.workspace_range` |
   | With `--consumer`, the clean consumer refused | its `consumer.*` code |

5. **Writes the release report**, with `--out`, whatever the verdict.

Its own lines are stamped `parley.tooling.release_gate` 1.0.0 (`scripts/release-gate.schema.json`):
`gate.artifact`, `gate.frozen_since`, `gate.refusal`, `gate.consumer`, `gate.result`, `gate.help`,
and `error` on stderr. `gate.result` is the last line: `passed`, the artifact's SHA-256, and the
`blocking` schema identities.

Captured from `bun run scripts/release-gate.ts parley-emit-py` on `main` at commit `29e95b9`, when
`parley.query` 1.1.0 and `parley.lens` 1.1.0 were drafts; it exited `1`. The first two lines and
the last, of eight:

```jsonl illustrative
{"event":"gate.artifact","package":"@flyingrobots/parley-emit-py","version":"0.3.0","file":"parley_emit.py","path":"/Users/james/git/parley/packages/parley-emit-py/parley_emit.py","sha256":"955f0551cb30213236750960c749df2e2da4f756e8d8069219e44c3fa461ffcb","packed":false,"_schema":{"id":"parley.tooling.release_gate","version":"1.0.0"}}
{"event":"gate.frozen_since","ref":"parley-emit-py-v0.2.0","commit":"b64b48276e98230a5a3affe384de66ea870e57be","how":"derived","note":"the highest parley-emit-py-vX.Y.Z tag below 0.3.0 that is an ancestor of HEAD","_schema":{"id":"parley.tooling.release_gate","version":"1.0.0"}}
{"event":"gate.result","package":"@flyingrobots/parley-emit-py","version":"0.3.0","passed":false,"file":"parley_emit.py","sha256":"955f0551cb30213236750960c749df2e2da4f756e8d8069219e44c3fa461ffcb","blocking":[{"id":"parley.lens","version":"1.1.0","code":"schema.unreleased"},{"id":"parley.query","version":"1.1.0","code":"schema.unreleased"}],"refusals":2,"report":null,"_schema":{"id":"parley.tooling.release_gate","version":"1.0.0"}}
```

The same run for `parley-emit` and `parley-read` exited `1` with the same two blocking identities.

### The release report

One JSON document, `release-report.json`, stamped `parley.tooling.release_report` 1.0.0
(`scripts/release-report.schema.json`). It is written beside the artifact and attached to the
GitHub release; it is never inside the artifact it describes.

| Field | Says |
| --- | --- |
| `package` | Name, version and directory |
| `tag` | The tag the release was started by; null when the gate ran before a tag existed |
| `source` | The commit and its tree, whether the commit is on the default branch, and whether the working tree was clean |
| `spec_release` | The latest dated heading of the root `CHANGELOG.md` at the commit: version and date |
| `schema_source` | The commit the artifact's bundled schemas were copied from, as the artifact states it |
| `schemas` | Every schema the artifact bundles: the pair, whether the artifact's code stamps it, its snapshot path, the SHA-256 of that snapshot file (null for a draft) and the release that names it |
| `artifact` | File name, size, SHA-256, SHA-1 (what npm prints as `shasum`), `integrity` (what a lockfile records), and every file inside by digest |
| `gate` | The phase, the verdict, the checker's schema version, both references with their commits, how the frozen-since reference was chosen, and every refusal |
| `consumer` | With `--consumer`: the directory, the reader as installed, the dependency's exact version, resolution and integrity, and the smoke read's counts; otherwise null |

It does not carry a stage id. The job that stages on npm authenticates by OIDC, and that token
cannot list or view what it staged, so the id is read by the owner with `npm stage list`
([what the owner approves](../release-parley-emit/README.md#what-the-owner-approves)).

## The dry run of a release workflow

Each release workflow can be started by hand, on any branch, from the Actions page or with
`gh workflow run <file> --ref <branch>`. Started that way it is a dry run
(flyingrobots/parley#156): a `dry-run` job packs the artifact once and runs the release gate with
no tag, as a person does before tagging, and a `dry-run-receive` job downloads the workflow
artifact and compares its digest with the gate's. For the two npm packages that second job also
offers the tarball to `npm stage publish` by path with `--dry-run`. Nothing is made public: no
GitHub release, nothing staged, no protected environment, and the tag-triggered jobs do not run.

Run it for a package after the schema release has merged and before pushing that package's tag.
A dry run of the reader needs its writer dependency on npm, as its real release does.

A dry run does not exercise `gh release create`, a real stage with an OIDC token and provenance,
or the `npm` environment's approval. Those are first seen on the release itself.

## Releasing schema versions: two commits and a merge commit

A package may be released as stable only after every schema it carries is released. Releasing
schema versions is one pull request with two commits, in this order.

1. **Commit S, the schema release.** For each draft being released, copy the top-level file to its
   snapshot, byte for byte:

   ```text
   mkdir -p schemas/released/<id>
   cp schemas/<id>.schema.json schemas/released/<id>/<version>.schema.json
   ```

   In the root `CHANGELOG.md`, put a dated heading `## [X.Y.Z] — YYYY-MM-DD` above the entries
   that were under `## [Unreleased]`, so that the heading names every schema version it releases
   in the form `` `<id>` <version> ``. Update the table in `schemas/README.md`. Change no package
   file. Commit.
2. **Commit P, the package copies.** Run `bun run sync-schemas` in `packages/parley-emit`,
   `packages/parley-read` and `packages/parley-emit-py`, and commit the result. Each copy's pin now
   names S, and every digest it records is the digest of a file as S holds it.

   The order is what makes the pin true. The sync scripts record `HEAD` as the pin's commit, so a
   sync run before S is committed pins the commit before it, where the files it copied do not
   exist in that form, and `pin.content_differs` says so.
3. **Review the candidate.** A confirmed finding against evidence fidelity, privacy, identity or
   a published contract blocks the release unless the owner accepts a recorded exception, whenever
   the defect was introduced ([Review findings and release exceptions](../release-review/README.md)).
4. **Check the candidate**: `bun run release-check --phase candidate`, with the whole gate
   (`bun test`, `bun run check`, `bun run typecheck`). `candidate` passes. `publication` does not
   yet, with `release.not_accepted`, because the default branch has not accepted the release.
5. **Merge with a merge commit.** S must stay reachable from the default branch under its own
   commit id, because that id is what every package copy is pinned to. **Squash-merging is not
   used for a release**: it replaces S and P with one new commit, S exists on no branch, and
   `publication` refuses every package with `pin.unreachable`. Rebase-merging gives S a new commit
   id, so the pins name a commit that is not on the branch either.
6. **After the merge**, `bun run release-check --phase publication` passes on the default branch,
   and the steps in [`RELEASE.md`](../../../RELEASE.md) apply. A package version that carries the
   newly released schemas is then released by its own workflow, once its
   [release gate](#the-release-gate) exits `0`
   ([parley-emit](../release-parley-emit/README.md), [parley-read](../release-parley-read/README.md),
   [parley-emit-py](../release-parley-emit-py/README.md)).

A change to a message that is not a release follows [Changing a message](../change-a-message/README.md).
