# Releasing the spec and its schemas — test plan

The contract ledger for the release-eligibility checker, `scripts/release-check.ts`
(flyingrobots/parley#145). The page beside it, [Releasing the spec and its schemas](README.md),
holds the rule and the procedure. Evidence is in `scripts/release-check.test.ts`: every case runs
the checker on a throwaway repository with real git history, whose package copies are written by
the repository's own sync scripts.

| ID | Requirement |
| --- | --- |
| RLC-A | `candidate` and `publication` refuse a package that bundles or declares a protocol schema identity with no released snapshot, no dated release heading naming it, or a packaged definition other than the snapshot's |
| RLC-B | Released snapshots are compared with a baseline the candidate did not choose: a snapshot path that exists at the baseline may not be modified, deleted or re-pointed |
| RLC-C | A source pin is verified by content: the commit exists, is on the history being released, each pinned file has the recorded digest at that commit, and the bundled definition is that file's |
| RLC-D | The checker inspects what it is given: a source tree, an npm tarball or `parley_emit.py`. An empty or unreadable inventory, or an unreadable artifact, is a refusal with its own code |
| RLC-E | `development` never refuses a draft: it reports, per package, whether it is eligible for a stable release and the exact `(id, version)` pairs that block it |
| RLC-F | `candidate` admits the snapshots and the dated heading a release pull request adds; `publication` requires them at the baseline |
| RLC-G | Output is JSON Lines stamped `parley.tooling.release_check`, every line validates against `scripts/release-check.schema.json`, and the exit status is 0 for a pass, 1 for a refusal and 2 when the check could not run |

| ID | Case | Oracle | Evidence | Status |
| --- | --- | --- | --- | --- |
| RLC-1 | Every copy agrees on draft `parley.query` 1.1.0 and `parley.lens` 1.1.0 | `candidate` and `publication` fail; each package has a `schema.unreleased` refusal naming both pairs | `RLC-1: all copies agree on a draft schema: candidate and publication reject, naming the identity` | implemented |
| RLC-2 | Snapshots of the two drafts exist and no dated heading names them | `release.heading_missing` for each pair, in `candidate`, and in `publication` once that state is the baseline | `RLC-2: a snapshot exists but no release heading names it: rejected` | implemented |
| RLC-3 | A released schema is edited in its top-level file and its snapshot in one commit, and every package is re-synced from it | against itself (`--base HEAD`) nothing is refused; against the merge base every phase refuses with `snapshot.modified` naming the path, and no package is eligible | `RLC-3: a released snapshot, its top-level file and every bundled copy changed together: rejected against the baseline` | implemented |
| RLC-4 | A released snapshot is deleted | every phase refuses with `snapshot.deleted` naming the path | `RLC-4: a previously released snapshot is deleted: rejected` | implemented |
| RLC-5a | A pin's recorded digest is a well-formed digest of something else | `pin.content_differs` naming the file, for that package only | `RLC-5a: a source pin with valid syntax whose commit holds different content: rejected` | implemented |
| RLC-5b | A pin's commit is 40 hex digits naming no commit | `pin.commit_missing`, once, for that package only | `RLC-5b: a source pin that is a commit-shaped string naming no commit: rejected` | implemented |
| RLC-5c | The pin is right and the bundled definition is not the pinned file's | `pin.bundle_differs`, with `copy.stale` and `definition.differs` | `RLC-5c: a source pin naming a real commit whose schema is not the bundled one: rejected` | implemented |
| RLC-5d | A pin whose commit is a branch name; a pin that omits a bundled schema's file | `pin.malformed`, in every phase | `RLC-5d: a source pin that is not a commit id, or that covers other files than the bundle holds: rejected` | implemented |
| RLC-6 | The tree passes `publication`; a tarball of one package and a copy of the Python file carry an older definition | given the artifact, `publication` fails with `definition.differs` naming the pair; the tree still passes | `RLC-6: the checkout is correct but the packed artifact is stale: rejected when given the artifact` | implemented |
| RLC-7 | A package's source stamps a pair its bundle does not hold | `inventory.declared_not_bundled` naming the pair, in every phase | `RLC-7: a built-in identity a package advertises is absent from its bundled inventory: rejected` | implemented |
| RLC-8a | A package's bundle holds no schema | `inventory.empty` in every phase; the package is neither passed nor eligible | `RLC-8a: an empty inventory is a failure with a code that says so, never a pass` | implemented |
| RLC-8b | A bundle file is missing, or is not in the generator's format, in each of the three packages | `inventory.unreadable` for each, in every phase | `RLC-8b: an inventory that cannot be read is a failure with a code that says so` | implemented |
| RLC-8c | An artifact path that does not exist, is not a gzip stream, holds no `package/` directory, or is of an unknown kind | `artifact.unreadable` in every phase; nothing is eligible | `RLC-8c: an artifact that cannot be read is a failure with a code that says so` | implemented |
| RLC-9 | No `origin/main` and no `--base`; a `--base` that names nothing | `candidate` and `publication` refuse with `baseline.unresolved`; `development` passes, says the baseline is unresolved and reports nothing eligible | `RLC-9: with no baseline to compare with, candidate and publication refuse and development says so` | implemented |
| RLC-10 | The release branch is squash-merged, so commit S is not an ancestor of the default branch | `publication` refuses with `pin.unreachable` | `RLC-10: a release whose schema commit was squashed away is rejected: the pin's commit is not on the default branch` | implemented |
| RLC-11 | The draft tree, `development` | passes with no refusal; all three packages not eligible, each blocked by exactly `parley.query@1.1.0` and `parley.lens@1.1.0` | `RLC-11: a tree with honestly declared drafts passes development and reports which packages are not eligible and why` | implemented |
| RLC-12 | The released tree; then two tarballs and the Python file from it | `publication` passes for the tree and for the three artifacts, each eligible, with its digest and its pin | `RLC-12: a tree and an artifact bundling only released schemas pass publication` | implemented |
| RLC-13 | The release pull request: commit S adds snapshots and the dated heading, commit P re-syncs | `candidate` passes and reports the packages not yet eligible; `publication` fails with `release.not_accepted` until a merge commit puts S on the default branch, then passes | `RLC-13: a release PR that adds snapshots and their heading passes candidate and fails publication until merged` | implemented |
| RLC-14 | A package whose source stamps no built-in pair | judged by its bundle: `declared` is 0 and it passes | `RLC-14: a package that declares no built-in identity is judged by what it bundles` | implemented |
| RLC-15 | A top-level file re-serialised with another key order; then the snapshot re-serialised the same way; then a top-level file whose value differs | the first passes (equal as parsed JSON, flyingrobots/parley#116); the second is `snapshot.modified`; the third is `toplevel.differs` | `RLC-15: a top-level file that differs from its snapshot only in key order passes; the snapshot is byte-frozen` | implemented |
| RLC-16 | A new snapshot path holding another version's definition | `snapshot.mismatched` naming the path | `RLC-16: a snapshot whose content names another identity than its path is rejected` | implemented |
| RLC-17 | No `--base`; then an explicit one | the baseline line names the merge base with `origin/main` and its commit; an explicit ref is used as given | `RLC-17: the default baseline is the merge base with origin/main, and --base names another` | implemented |
| RLC-18 | This repository, `development`, on every `bun test` | passes; one line per package under `packages/`; a package is eligible exactly when nothing blocks it; every blocking draft has no snapshot | `RLC-18: development on this repository passes, and its report is well-formed` | implemented |
| RLC-19 | The command line | JSON Lines on stdout, each valid against the schema; exit 0 for a pass and 1 for a refusal; `--artifact` inspects the file named; `--human` prints prose | `RLC-19: the command prints JSON Lines, exits 0 for a pass and 1 for a refusal, and --human switches to prose` | implemented |
| RLC-20 | No phase, an unknown phase, an unknown flag, a flag with no value; a `--repo` that is no repository; `--help` | one `error` line on stderr and exit 2; `--help` prints one `release.help` line and exits 0 | `RLC-20: a usage error is one schema'd line on stderr and exit 2; --help describes the command` | implemented |
| RLC-21 | A tarball packed from `packages/parley-read` here, and the real `parley_emit.py`, as artifacts | the same version, pin, counts and blocking pairs as the source tree reports | `RLC-21: a tarball packed from a real package here is read as that package's source tree is` | implemented |
| RLC-22 | Every line the cases above produced | each validates against `scripts/release-check.schema.json`, and the refusal codes produced are exactly the codes the schema declares | `RLC-22: every line the checker emitted in these cases validates against its own schema` | implemented |

Not covered: fuzzing and load, which the issue rules out because the inputs are a small fixed set
of files; and the release workflows calling the checker, which is flyingrobots/parley#147.
