# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This file tracks the spec and its message schemas. A version heading names the **spec** version;
the entry under it names each schema version it releases, and those are separate numbers (spec
§4.4). Each package keeps its own changelog under `packages/`.

## [Unreleased]

## [0.2.1] — 2026-11-24

The second release of the schemas, with spec `0.2.1`. It releases two schema versions, and the
spec gains six normative sentences. Everything the `0.2.0` entry released stays released and
unchanged: no released snapshot's bytes move.

Released schema versions, snapshotted byte for byte at
`schemas/released/<id>/<version>.schema.json` and immutable from this entry on (spec §4.5, §4.6):

- `parley.query` 1.1.0
- `parley.lens` 1.1.0

`parley.query` 1.0.0 and `parley.lens` 1.0.0 stay released beside them. The other fifteen
messages are at the versions the `0.2.0` entry names.

**Compatibility.** Both are minor versions: each adds optional fields, removes no field and
narrows no constraint of 1.0.0. Spec §4.5 asks more of a minor than that: it "**MUST** preserve
the meaning and the constraints of every field the previous minor defined". `parley.query` 1.1.0
does. `parley.lens` 1.1.0 preserves the constraints and is a decided exception to "preserve the
meaning" in two places, both stated below: one sentence of 1.0.0, that `loss.folded` depends on
the window alone, does not hold of a 1.1.0 line, and what a fold is, is narrower. The owner
decided on 2026-11-24, with that sentence in view, that the version is 1.1.0 and not 2.0.0
(flyingrobots/parley#146). §4.5 does not say what "meaning" is for a description whose stated
invariant weakens while its constraints stand; whether it should is flyingrobots/parley#160.
Three things a consumer must know:

- **A line is validated against the schema for its own advertised pair, never a neighbouring
  one** (spec §4.5). A reader that holds 1.0.0 and not 1.1.0 can give a 1.1.0 line only the
  partial check §4.5 permits, and must report it as partial. The 1.0.0 schemas are open, so a
  1.0.0 `parley.query` may carry an unknown `fold` of any type and a 1.0.0 `parley.lens` an
  unknown `fold` or `stands_for`; 1.1.0 defines those names and would reject such a value. Old
  lines therefore keep validating only against 1.0.0, which a reader keeps shipping.
- **One statement of `parley.lens` 1.0.0 does not hold of a 1.1.0 line.** 1.0.0 says
  `loss.folded` depends on the window alone. In 1.1.0 it depends on the window, the view and
  `fold`. It still never depends on the budget. The version on a lens line says which rule
  produced it.
- **What a fold is, is narrower.** Under 1.1.0 two runs fold only when their result records are
  equal as well, compared one for one in `seq` order, and under a view whose surface holds
  decision records those too: `receipt.step` under `how-it-decided` and `everything`, `cache.hit`
  under those two and `what-ran`.

The sentence-by-sentence review that preceded this freeze, with its findings, is
[docs/topics/reader/freeze-review-1.1.0.md](docs/topics/reader/freeze-review-1.1.0.md)
(flyingrobots/parley#146).

Released alongside, each versioned on its own: `@flyingrobots/parley-emit` 0.4.0 and
`@flyingrobots/parley-read` 0.2.0, each on npm once the owner approves the version its release
workflow stages (parley-read depends on parley-emit `^0.4.0`, so parley-emit is approved first),
and `parley_emit.py` 0.3.0, a vendorable file pinned by its SHA-256. Each package's changelog says what changed in it. `@flyingrobots/parley-emit` 0.3.0,
`@flyingrobots/parley-read` 0.1.2 and the package versions before them that this entry mentions
below were steps on `main` between the two schema releases; npm holds the versions it holds, and
the package changelogs say which were published.

### Released: `parley.query` 1.1.0

- An optional boolean `fold`. `false` asks the reader to fold nothing; absent or `true`, the
  reader folds runs of one invocation with one result (flyingrobots/parley#133).
- `fold`'s description says where a fold's runs are named: in the section of the run that stands
  for them. A budget that leaves that run out leaves a count alone (flyingrobots/parley#146).

### Released: `parley.lens` 1.1.0

- An optional boolean `fold`, echoed from the query when the query states it
  (flyingrobots/parley#133).
- An optional `stands_for` in a run section's `folded`: the run ids of the other runs the section
  stands for, this run excluded, as many as `others`. 1.0.0 gave a count and no way to the folded
  runs. Each entry has `minLength: 1`, as every other run id in the schema has
  (flyingrobots/parley#133, flyingrobots/parley#146).
- `runs[].folded` states the fold's criterion: runs with an equal `inv` whose outcome, reason,
  `end` status, diagnostic codes and head's `resolved` are equal, and whose result records are
  equal one for one in `seq` order. A read's own `lens` and a record the protocol does not define
  are results; a sidecar is compared by `bytes` and `sha256`; a run the window does not show to be
  unredacted never folds. Records are compared without the envelope's `t`, `seq` and `run`, and a
  read's own `lens` also without its `session` and the `query` it names. A top-level `session` on
  a tool's own record or on a `page` is that record's own field and is compared. As first
  snapshotted for this release the sentence said every record was compared without `session`; a
  review of the release found that false of a tool's record, and the sentence, the snapshot and
  the reader were corrected before anything was merged or published (flyingrobots/parley#146). Decision records are compared under the views named above.
- `runs[].folded` says the comparison is of the records the window holds. A run only partly
  inside the window is compared by that part, so runs that stand for one another under one
  window can differ under a wider one. A section marks such a run with `head: "not_in_window"`
  or with `outcome: "undetermined"` and `reason: "no_end_in_window"`; a run the window shows to
  have failed carries neither when only its `end` is outside. As first snapshotted for this
  release the description said two runs whose results differ "never stand for one another" and
  that "a redacted run" never stands for another; a later review found both false at a window
  edge, and the sentences and the snapshot were corrected before anything was merged or
  published. The reader's behaviour did not change.
- `runs[].folded` and `stands_for` state the order: the latest `t` among a run's records in the
  window, then the greater run id, a run with no dated record last.
- `stands_for` names runs and not their records' `seq`. A schema cannot check its length against
  `others`. `budget.bytes` never shortens it: the section is whole or absent.
- `loss.folded` counts every record the fold left out, so the sections' `folded.records` sum to
  less than it when the budget cut a run that stands for others.

### Changed in the spec

These add or move a normative term, which is why the spec version moves to `0.2.1`.

- **§5.1.** A program **MUST NOT** delete an incomplete receipt, one whose final line is not a
  newline-terminated `end`, under its policy until the receipt has gone unmodified for at least 24
  hours. It still counts toward the policy, so a complete receipt may be deleted in its place. No
  lock is defined: a run that writes nothing for over a day and then appends while retention
  deletes its receipt loses it. That window is accepted rather than closed by a cross-writer lock
  protocol (flyingrobots/parley#112).
- **§5.2.** A `.parley/.gitignore` that has the line `*` but also a negation pattern that can match
  the directory `receipts` is a user's file. The program leaves it alone and uses the
  state-directory fallback, and it **MUST** treat a negation it cannot evaluate as one that
  matches. Before this, a file of `*`, `!receipts/` and `!receipts/**` met the letter of §5.2 while
  leaving receipts where `git add` stages them (flyingrobots/parley#109).
- **§5.3.** The schema document a `schema` line publishes is the program's static declaration and
  **MUST** be published as declared. It is no longer scrubbed of a declared secret value that
  occurs in it by coincidence, which rewrote `"type": "object"` when the secret was `object`
  (flyingrobots/parley#111).
- **§5.3, with one sentence added to the `4` row of §3.4.** A program **MUST NOT** publish a record
  that redaction made invalid under its declared schema. It checks the redacted record before any
  copy leaves the process, gives a failing record no `seq` and writes it nowhere, reports a
  structured error naming each field by JSON Pointer and the schema's `id` and `version`, and
  closes the run with status `4`. That error **MUST NOT** carry the value, a validator's message or
  any part of the schema. Before this, an integer field equal to a declared secret was published
  as the string `[redacted]` under the original schema by a run that ended with status 0
  (flyingrobots/parley#131). No error code is enumerated by the spec or by any schema, so the
  writers' new code `redaction.schema_conflict` changes neither.
- **§5.3, with the same sentence of the `4` row of §3.4 widened.** A program that holds no schema
  document for the record's pair is exempt from that rule. A program that holds one and cannot
  evaluate it is not: it cannot show that the redacted record is valid, so it **MUST** withhold
  the record in the same way, with no copy, no `seq`, a structured error under the same limits
  that names the schema, and status `4`. The owner chose, for flyingrobots/parley#131, that
  privacy and the contract both hold and the answer is lost; a program that published a redacted
  record it could not check would be publishing the silent invalid line that rule exists to
  prevent. Decided under the owner's delegation of 2026-11-24 and recorded on
  flyingrobots/parley#144. The writers' code for it is `redaction.schema_unchecked`.
- **§4.5**, with no normative term added, removed or moved: it now says what the first release
  did. A top-level schema file may hold a released version only with the snapshot's exact bytes,
  and the first change after a release moves it to a new version
  (flyingrobots/parley#107).

### Changed in the packages

Each package's own changelog is the record; this is the summary.

- **A fold no longer hides a run whose result differs** (`@flyingrobots/parley-read` 0.2.0,
  flyingrobots/parley#133). It emits `parley.query` and `parley.lens` at 1.1.0 and ships 1.0.0
  beside them, so it validates the lines of both versions.
- **A record that redaction made invalid is never published** (`@flyingrobots/parley-emit` 0.4.0,
  `parley_emit.py` 0.3.0, flyingrobots/parley#131): the writers implement the §5.3 sentences above
  for a tool's record the scrub changed, with a `redaction.schema_conflict` error and status 4.
  Still not checked: a record of a type with no schema document, which §5.3 exempts; a record
  that was already invalid in the same way before redaction; and the records the writers build
  themselves, whose scalars and identity fields are not scrubbed.
- **BREAKING for a tool whose declared schema uses a keyword outside a writer's checker**
  (`@flyingrobots/parley-emit` 0.4.0, `parley_emit.py` 0.3.0, flyingrobots/parley#144). Any
  redaction in a record whose declared schema document uses such a keyword (`format:
  "date-time"`, `multipleOf`, `uniqueItems`, a `$ref`, even an empty `$defs`) is now withheld
  with a `redaction.schema_unchecked` error and status 4, even when the redacted record would
  still have been valid, for example a token inside an unconstrained string. Before, such a
  record was published with status 0. The code means not checked: it does not say the record was
  invalid, and no secret was exposed. The remedies are to keep the declared schema within the
  keywords each writer's README lists, or to keep declared secrets out of emitted records.
  Deleting the `schema` document removes the refusal and the check together, so it is not a fix.
  A record the scrub did not change is written as before, whatever its schema.
- **A declared file input can be read through the run** (`run.readInput`, `run.read_input`;
  flyingrobots/parley#132), so the receipt records the digest of the bytes the tool read. A
  declared file not read that way is still digested when the handler finishes, and the writers'
  references say so.
- **A receipt-only field can no longer contradict the record** (flyingrobots/parley#130): both
  writers refuse a `receiptExtra` value that differs from the record's.
- Both npm release workflows stage a version (`npm stage publish`) for the owner to approve, in
  place of `npm publish` (flyingrobots/parley#85).

### Added: the SDL and the release gates

- `schemas/parley.graphql`: Wesley SDL for all 17 messages, with interim `parley_` directives
  where Wesley 0.3.0-alpha.4 has no construct yet, each tied to the Wesley issue that retires it
  (flyingrobots/wesley#850 to flyingrobots/wesley#857). **It is not the source.** The hand-written
  JSON Schemas stay the source of truth until flyingrobots/parley#119. A transitional test,
  `scripts/sdl-agreement.test.ts`, derives each message's JSON Schema value from the SDL and
  requires it to equal the hand-written schema as parsed JSON. All 17 agree. Wesley is pinned
  exactly in `package.json` `config.wesley`; CI installs that version and fails if it is missing,
  and without it `bun test` skips those cases and says why (flyingrobots/parley#118).
  `scripts/sdl-to-json-schema.ts` refuses SDL it cannot represent instead of passing it
  (flyingrobots/parley#125).
- **The release rule and the checker that enforces it** (`scripts/release-check.ts`,
  flyingrobots/parley#145, flyingrobots/parley#152, flyingrobots/parley#153): a stable Parley
  distribution must not embed, advertise or emit a repository-owned protocol schema identity
  unless that exact `(id, version)` has been released and resolves to its frozen definition. The
  checker reads what each package bundles and declares from a source tree, an npm tarball or
  `parley_emit.py`, in three phases: `development`, `candidate` and `publication`. Released
  snapshots are compared byte for byte with references the candidate did not choose (`--base` and
  `--frozen-since`), a package copy's source pin is verified by content at the commit it names,
  and a new version is released only by a heading that is itself new. Its output is JSON Lines
  stamped `parley.tooling.release_check` 1.1.0, a tooling schema beside the script.
  [docs/workflows/release-spec](docs/workflows/release-spec/README.md) holds the rule, the phases
  and the procedure this release followed: the schema release in one commit, the package copies
  re-synced from it in a second, joined by a merge commit.
- The release gate, `bun run release-gate -- <package>` (`scripts/release-gate.ts`): for one
  package at the current commit it builds the artifact once, runs the checker's `publication`
  phase on that file with `--frozen-since` set to the package's previous release tag, refuses a
  tag that is not the version's, a missing dated changelog heading, a commit off `main`, a dirty
  tree and a tarball whose manifest is not the repository's, and writes a release report
  (`release-report.json`): package, source commit and tree, spec release, the bundled schema
  inventory with snapshot digests, the artifact's digests and the gate's result. A release tag is
  pushed only after it exits 0. With `--consumer` it also runs `scripts/clean-consumer.ts`, which
  installs the packed reader and its writer from npm into a directory outside the workspace,
  refuses a writer that resolved from a link or a file, and runs a smoke read there. Three tooling
  schemas beside the scripts: `parley.tooling.release_gate`, `parley.tooling.release_report` and
  `parley.tooling.clean_consumer`, each 1.0.0 (flyingrobots/parley#147).
- `.github/workflows/release-parley-emit-py.yml`: a tag `parley-emit-py-vX.Y.Z` runs the gate on
  `parley_emit.py` and creates its GitHub release with the changelog section, the file, its
  SHA-256 as `--vendor-info` prints it, and the report. The release was made by hand before
  (flyingrobots/parley#147).
- The two npm release workflows run the gate as a job between `sanity` and `release`, and nothing
  public is created unless it passes. The tarball is packed once, by the gate; `release` and
  `publish` take that file, compare its SHA-256 with the gate job's output, and pack nothing.
  `publish` has no checkout and stages the file by path, `npm stage publish <tarball>`, where it
  used to pack a second tarball from a second checkout. The GitHub release carries the tarball,
  `SHA256SUMS` and the report. The job that stages authenticates by OIDC and cannot list, view or
  download what it staged, so comparing the staged tarball with the report's digest before
  approving is the owner's step, and the release pages say so, with the protections that depend
  on settings the workflow cannot verify. No spec text, schema byte, schema version or package
  version changes (flyingrobots/parley#147).
- Each release workflow can be started by hand as a dry run: it packs once, runs the release gate
  with no tag, hands the artifact to a second job that checks its digest, and for the npm
  packages offers the tarball to `npm stage publish --dry-run`. It makes nothing public and the
  tag-triggered jobs do not run. A pushed tag cannot be taken back, so this is how a workflow is
  seen to work on a runner first (flyingrobots/parley#156).

## [0.2.0] — 2026-11-22

The first release of the schemas, with spec `0.2.0`. **From this entry on, no schema listed here is
a draft:** each version below is released and immutable, snapshotted byte for byte at
`schemas/released/<id>/<version>.schema.json` (spec §4.5, §4.6), and any change to one of them,
a description included, needs a new version, recorded under `Unreleased` until the next release.
The top-level file `schemas/<id>.schema.json` holds the same bytes as the snapshot until such a
change moves it on; a test fails if a top-level file changes a released pair's bytes.

Released schema versions:

- `parley.run.bootstrap` 1.1.1
- `parley.receipt.head` 2.0.0
- `parley.error` 2.0.0
- `parley.warning` 1.0.0
- `parley.startup.failed` 1.0.0
- `parley.end` 1.0.0
- `parley.sidecar` 1.0.0
- `parley.redaction` 1.0.0
- `parley.receipt.step` 1.0.0
- `parley.receipt.inputs` 1.0.0
- `parley.cache.hit` 1.0.0
- `parley.page` 1.0.0
- `parley.command` 1.0.0
- `parley.schema` 1.0.0
- `parley.query` 1.0.0
- `parley.lens` 1.0.0
- `parley.history.transform` 1.0.0

Released alongside, each versioned on its own: `@flyingrobots/parley-emit` 0.2.0 and
`@flyingrobots/parley-read` 0.1.0 on npm (parley-read depends on parley-emit `^0.2.0`, so parley-emit
is published first), and `parley_emit.py` 0.1.0, a vendorable file pinned by its SHA-256 and not
published to a registry. Each package's changelog says what changed in it. The spec version does
not move with this release: the spec status line now says what implements it and §4.5 no longer
says nothing is released, and no normative sentence changed (flyingrobots/parley#85).

The sections below record what changed while these versions were drafts.

### Changed in a draft schema

Both reader schemas were drafts under this entry until it was cut (spec §4.5), so a change to one
was recorded here rather than moving its version.

- `parley.lens` 1.0.0 (draft), `loss.bound`: the **description** of the `none` value changed, and
  nothing else in the schema did. It said "the view is the identity on the window and nothing was
  left out", which would have read as a rule that only `everything` may ever claim a lossless
  result. It now says that `none` means nothing in the window was left out and `excluded` must be
  0, and that this is not restricted to the identity view, because a view orders a result and
  filters none of it (flyingrobots/parley#49) — so any view whose result reached the end of its
  order lost nothing. No constraint changed: the schema's `if`/`then` already refused `none`
  beside a non-zero count, and still does. The shipped copies in both packages were re-synced,
  which is a digest change and no version change.
- `parley.query` 1.0.0 (draft) gains an optional **`records`** field (flyingrobots/parley#51): an
  array of at least one `{run, seq}`, the identity a `parley.lens` names records by, present only
  on a **drill-down** — a read that opens those records in full rather than answering with a
  digest. The view and window are recorded and select nothing on a drill-down, and
  `budget.records` is the number of ids asked; the schema says so. Nothing required changed, so
  every `parley.query` line written before still validates. The decision behind it: opening
  records reads history, so by the reasoning of flyingrobots/parley#48 it is a recorded read with
  an asker and a view, and recording it as the same message rather than a new one keeps "which
  questions get asked" and "which records get opened" in one place. Rejected: a new message type
  for one optional field; recording the ids only in a `receipt.step`, where a reader of the query
  line could not tell a drill-down from a read. The shipped copies in both packages were
  re-synced, which moves no version.
- `parley.lens` 1.0.0 (draft): each entry in `records` may carry a **summary** of the record it
  names (flyingrobots/parley#77): `event` (a non-empty string), `t` (a non-negative integer) and
  `outcome` (`failed`, `undetermined` or `succeeded`, the window's verdict on the record's run).
  All three are optional, because a record with no usable event or `t` is named without one rather
  than with a placeholder. Nothing required changed, so every `parley.lens` line written before
  still validates. The decision behind it: in the cold resume
  (`docs/topics/reader/cold-resume.md`) most drill-downs were spent learning what an entry was.
  Rejected: summaries on a separate line, which a reader has to correlate with this one; inlining
  whole records, which is the drill-down and breaks the byte bound. The summary is part of the line
  `budget.bytes` bounds, so a byte budget names fewer records than before. The shipped copies in
  both packages were re-synced, which moves no version.
- `parley.lens` 1.0.0 (draft) gains an optional **`runs`** section, and each `records` entry
  loses `outcome` and gains `code` (flyingrobots/parley#83). `runs` is an array with one item per
  run the entries name: `run` (required), and, each optional, `tool`, `v` and `argv` off the run's
  head, `inv`, the run's `outcome` (moved here from the entries), a `reason` from
  `no_end_in_window` / `end_status_unusable` that the schema requires exactly when the outcome is
  `undetermined`, `head: "not_in_window"`, and `dropped`, the fields left out whole to bound the
  section. An entry's `code` is spec §6's pattern, carried on an `error` or `warning`. `outcome` is
  no longer declared on an entry; entries were never closed to extra keys, and `runs` is
  optional, so every `parley.lens` line written under the earlier draft still validates. The
  decision behind it: the re-run of the cold resume opened 26 heads out of 49 ids to learn a
  run's arguments, and could not tell from a digest why a run was `undetermined`. Stating the
  identity once per run rather than per entry, and moving the outcome with it, is what the byte
  budget can afford. Rejected: `argv` on every entry, which repeats one identity per record and
  spends the budget fastest; `resolved` instead of `argv`, which is larger and tool-shaped. The
  shipped copies in both packages were re-synced, which moves no version.

- `parley.query` 1.0.0 (draft), the **description** of `records` and nothing else: it now says
  `budget.bytes`, when stated on a drill-down, bounds the records opened — whole records in the
  order asked while their summed size stays within it, and an `over_budget` outcome with no
  contents for each id past it (flyingrobots/parley#78). `bytes` was already an optional positive
  integer in the schema, so no constraint moved. Both packages were re-synced; no version moved.
- `parley.lens` 1.0.0 (draft) gains **`loss.folded`** and **`runs[].folded`**
  (flyingrobots/parley#79). `loss.folded` is a non-negative integer: how many of `loss.excluded`
  were left out because their run was folded into another run of the same invocation and the same
  result, rather than by the budget. `runs[].folded` is `{runs, records}`, `runs` at least 2 and
  `records` at least 0: on a representative's section, how many runs it stands for, itself
  included, and how many of the others' records the fold left out. The schema's `if`/`then` now
  also requires `loss.folded` to be 0 beside `bound: "none"`. Both fields are optional, so every
  `parley.lens` line written under the earlier draft still validates; parley-read always writes
  `loss.folded`, 0 included. The decision is under *Decided*. The shipped copies in both packages
  were re-synced, which moves no version. `runs[].folded` was since renamed to
  `{others, records}` (flyingrobots/parley#100, below).
- `parley.lens` 1.0.0 (draft), **`runs[].folded` is `{others, records}`**, replacing `{runs,
  records}` (flyingrobots/parley#100). `others` is an integer of at least 1, `records` at least
  0, and both exclude the representative: the section reads as "this run, plus `others` like it,
  whose `records` records are not named", so it stands for `others + 1` runs where `runs` said the
  same number with the representative included. A run that stands alone has no `folded`, as
  before. The fourth cold reader could not tell whether `runs` included its own run
  (`docs/topics/reader/cold-resume.md`), and two numbers on different bases in one object was the
  cause, so both now count the others only. `others` is required, so a line in the old shape no
  longer validates; the draft has not been released, so the change is made in place. `loss.folded`
  is unchanged. The decision is on the issue: a renamed field that still counted the
  representative, and a top-level run count, were rejected. The shipped copies in all three
  packages were re-synced, which moves no version. On footprint's 50 receipts, a read naming every
  run states 17 sections whose `1 + others` sum to the window's 50 runs.
- `parley.lens` 1.0.0 (draft): a run section gains an optional **`resolved`**, an object, and
  `dropped` gains `resolved` in its enum, with `maxItems` raised from 4 to 5
  (flyingrobots/parley#90). `resolved` is the head's `resolved` (spec §5), copied whole and already
  redacted there (§5.3), and it is the first field dropped to fit the section's bound. Every line
  written under the earlier draft still validates. The decision is under *Decided*. The shipped
  copies in all three packages were re-synced, which moves no version.

### Decided

- **What a run section says about what a run compared** (flyingrobots/parley#90). The issue left
  the mechanism open; this is the decision, and an owner may overrule any part of it. A section
  carries the head's **`resolved` whole**, when it is a JSON object, and the reader picks none of
  its keys. It is the first field dropped to fit `RUN_SECTION_BYTES`, before `argv`, whole and
  named in `dropped`; the drop order is `resolved`, `argv`, `inv`, `v`, `tool`. Carrying it whole
  keeps every tool's field names out of the reader: `base_commit` and `head_commit` are footprint's,
  and parley-read does not know them. Nothing chosen from `resolved` can drift from the head,
  because nothing is chosen. A value §5.3 redacted stays `[redacted]`, since the copy is the
  head's. Rejected:
  - *a tool-declared subset of keys*, declared on the head or in a §2.2-style tool document. It
    needs a new head field or a new document, and the subset can drift from what the head holds;
  - *`resolved` on every entry*, which repeats one identity per record, as flyingrobots/parley#83
    already rejected for `argv`;
  - *dropping `argv` before `resolved`*, which would keep the richer field. `resolved` is the
    larger, tool-shaped one, and `argv` is the protocol's, so when only one fits the protocol's is
    kept.

  Because a section now states `resolved`, the fold of flyingrobots/parley#79 also requires the
  heads' `resolved` to be equal: §2.2 keeps the working directory out of `inv`, so one `inv` can
  carry two interpretations, and a fold must not state one run's for another (RD-100g).

  The cost is bytes: under RD-22b's `{records: 20, bytes: 2048}` a digest names 12 records where it
  named 13. On footprint's own receipts every section still fits, the largest at 495 of 512 bytes.

- **How a digest folds repeated runs, and how the lens says so** (flyingrobots/parley#79). The
  issue left the lens field open; this is the decision, and an owner may overrule any part of it.
  - *What folds.* Two runs fold when their `inv` is equal and every summary the lens states about
    their result is equal too: the outcome, the `reason`, the `end` status, and the error, warning
    and startup-failure codes in the order emitted. Equal `inv` alone is not enough, because §2.3
    makes "same `inv`, different result" a divergence, and the issue's risk is a flaky run folded
    into a passing one. A run with no `inv` never folds, and neither does a redacted run, which
    §2.3 says shares its `inv` with every run that differed only in a secret.
  - *Which run is named.* The most recent of the group: the run whose latest dated record in the
    window is latest, ties to the greater run id.
  - *How the lens says so.* On the representative's run section, `folded: {runs, records}`, where
    `runs` counts the group, the representative included, so a digest over N identical runs
    states N. (Superseded by flyingrobots/parley#100: the section now says `{others, records}`,
    both excluding the representative, so it states N − 1 others.) The folded runs' ids are
    **not** listed, to keep the line small. A narrower read, or a load of the window, finds them.
  - *How the loss tells fold from budget.* `loss.excluded` still counts every record of the window
    the digest does not name, the folded ones included, and a new `loss.folded` says how many of
    those the fold left out. `excluded − folded` is what the budget cut. `loss.folded` depends on
    the window alone, so the same window folds the same way under any budget. It is always
    written, 0 included, so "folded nothing" reads differently from a lens written before the
    field.
  - *Where it happens.* The fold is part of how the digest is built: the ranking still orders
    every record and drops none, the fold removes the folded-away runs' records from what the
    digest may name, and the bound cuts the tail of what is left. It applies under every view.
  - Rejected: a new view token, because grouping is orthogonal to purpose, as the issue says;
    folding by `argv`, because argv is not identity; folding on `inv` and outcome alone, which
    would merge two failures with different errors; listing the folded ids, which costs about 30
    bytes a run and would let a burst of a thousand runs crowd out the budget again; demoting the
    folded runs' records to the tail of the ranking instead of leaving them out, which keeps the
    ranking's "never filters" literally true but makes a wide budget name every repeat again and
    leaves fold loss and budget loss indistinguishable.

- **How a read states its observer and its purpose** (flyingrobots/parley#46). §9 asks a query for
  an observer and a purpose. The observer-geometry treatment §9 cites uses "observer" for the
  *view* — a map from a history to the shape of an answer — and holds that a view without a
  resource budget is not a view, because with no bound every view collapses into "return every
  record". A query therefore carries **three** fields under names that do not collide with the
  source:

  - `asker` — who the read is for, and the context the rest is inferred from. A record: `tool`
    required, `cwd` (absolute POSIX) and `task` optional. `tool` comes from the calling program's
    own identity and is never invented (§2.1), so a read that cannot name its caller is refused;
    `cwd` comes from the process, omitted when absent. `task` is always supplied by the caller and
    never inferred — there is no environment variable for it (flyingrobots/parley#61) — omitted
    when the caller does not state it.
  - `view` — the shape of the answer, one token from a closed set of five: `what-ran`,
    `what-failed`, `what-changed`, `how-it-decided`, `everything`. Four are projections the
    treatment's taxonomy recognises as distinct families; `everything` is the identity, and is in
    the set so a caller who suspects the view hid what they needed can widen without learning a
    second interface. Never inferred: there is no privileged view, and a guessed view is one the
    caller cannot see in the lens, so a missing view is refused. Changing the vocabulary moves the
    two schema versions below.
  - `budget` — the size of answer the asker will accept. A record of bounds: `records` required,
    `bytes` and `ms` optional. One documented default, `{"records": 20}`, applies when it is not
    supplied, and the applied budget is carried verbatim by the result's lens, so a default is
    never invisible. It is the only field with a default, because a defaulted budget can be shown
    in the lens and a defaulted view cannot be anything but a different answer to a different
    question.

  Optional free text is `note`: recorded, never parsed, nothing branches on it.

  **Cost.** Supplying all three explicitly costs one argument each and each argument is one token:
  `--asker <tool>`, `--view <token>`, `--budget <kind>=<n>[,<kind>=<n>]` (`--budget 20` means
  `records=20`), with `--note <text>` optional. Nothing is positional and no form of the interface
  requires writing JSON on a command line. In practice a read costs one argument, `--view`, since
  the asker comes from context and the budget has a default.

  **Schema ids and versions.** Two new draft schemas, each with a validated example:
  `parley.query` 1.0.0 (the read, recorded as an event: asker, view, budget, window, optional
  note) and `parley.lens` 1.0.0 (what a result carries: the query it answers by `(run, seq)`, the
  asker, the view, the budget actually applied, the window, a `loss` bound, and the records it was
  built from by `(run, seq)`). The budget is in the lens because results computed under different
  budgets are not comparable. `loss.bound` is `none` (the identity view on its window; `excluded`
  must then be `0`) or `count-only`; `loss.excluded` ships as the cheapest proxy and the schema
  says it is a weak one, because what a view loses is worst-case and one withheld record can
  matter more than fifty. A bound measured from a real translator is a later version of
  `parley.lens`, written when something exists to measure it.

  Rejected: free text for either field, because free text cannot be refused, compared or stated as
  a claim; an opaque observer id or registry, because it names a viewer and leaves the shape of the
  answer undeclared; two fields as §9 has them, because a lens without a budget does not identify
  the view that produced the result; keeping the word "observer" for the asker, because it is the
  treatment's term for the view; an open view vocabulary or a predicate language, which is the
  ceremony failure mode and a view no lens can state; defaulting the view from context; the
  excluded count as the only loss statement, which a cardinality cannot be; one combined
  query-and-result message, since the two are emitted at different times by different parties and
  each message type is versioned on its own; and a shared `$ref`'d lens definition, because every
  schema in this repository compiles standalone.

  The spec's normative text is unchanged and §9 is still informative: the proposed §9 wording lives
  on the research page. New living reference: `docs/topics/reader/README.md`. Research:
  `docs/topics/related-work/observer-geometry.md` (flyingrobots/parley#45). `parley-emit`'s shipped
  copy of the drafts is re-synced, so discovery serves sixteen schemas; that moves no version.

- **There is no environment variable for `asker.task`** (flyingrobots/parley#61). The #46 entry
  above said `task` came "from the environment" without naming a variable, and the query entry
  point (flyingrobots/parley#48) implemented the gap literally: the task comes from the request
  and is omitted when the caller does not state it, because reading an invented variable name
  would itself be inventing an identity field (§2.1). The decision corrects the record rather than
  the code: a task id is always supplied by the caller, never inferred. `parley.query` 1.0.0's
  description of `asker.task` is corrected in place, since the schema is still a draft under this
  `Unreleased` section (§4.5); that moves no version.

- **What `budget.ms` bounds, and how a read declines** (flyingrobots/parley#71). `ms` is a
  **deadline for the whole read**, measured from the call and checked between phases: after the
  load, after the ranking, before the digest is written. A read never answers from a partial load.
  A read that passes its deadline, or whose `budget.bytes` cannot hold even a digest naming no
  records, **declines**: it is still a recorded run, and it answers with a structured
  `parley.error`, code `query.over_budget`, whose `detail` states the budget given, what was
  measured, and a budget that would have sufficed where that is known — the elapsed time for `ms`
  when the read stopped at its last check (a lower bound, `at_least`, when phases were still to
  run), and the size of the smallest digest for `bytes`, which is exact. The run ends with status
  2, the §3.4 status for a reported structured error; this is the one part of the decision an
  owner may most reasonably overrule, since a decline is an answer rather than a failure and §3.4
  has no status for that. `ms` stays in `parley.query`. Rejected:
  - *`ms` bounds the load*, abandoning it part-way and naming what was not reached. A digest drawn
    from part of the history carries an excluded count of records the read *saw*, which reads as a
    loss bound over the window and is not one.
  - *Remove `ms`*, which moves `parley.query`. A caller with a deadline is the observer-geometry
    treatment's own case, and a bound that is recorded and ignored was the defect, not the bound.
  - *A field on a later `parley.lens`* saying what budget would suffice. A lens is a digest of
    records; a declined read has none, and the verdict is a §6 error with `measured` and `limit`.
  - *Another refusal code beside those `planQuery` returns*. A refusal is pure and pre-load; a verdict about whether
    real history fits a budget can only come from a read that ran. No schema moved.

- **Three places the spec left a second writer to guess, written into it** (flyingrobots/parley#91,
  flyingrobots/parley#92, flyingrobots/parley#93). The Python writer (flyingrobots/parley#84) found
  them; the decisions are recorded on those issues, and each is now a sentence of the spec:
  - **§3.2, §3.4: the bootstrap line is the boundary for a usage error.** One found before it is a
    startup failure, exit 3, one `startup.failed` line, no receipt; one found after it is a command
    error, exit 2, a complete failed receipt. A program **MUST** document where it checks its
    arguments and **SHOULD** check them before the bootstrap line, because a mistaken call did no
    work and a receipt of it is noise. Both writers' example tools now check in `resolved`, before
    it. Rejected: always 3, and always 2, as hard rules, because each forbids a conforming program
    for no gain to a caller, who already tells the two apart by the exit status.
  - **§4.2: "every error type it can produce" includes `parley.startup.failed`**, because every
    command can produce one and a caller parsing stderr needs the shape of every line that can
    appear there. `parley-emit`'s default error list changes to match the Python writer's.
    Rejected: describing it once under `--schema` only, which makes a caller read two discovery
    outputs to learn what one call can write.
  - **§5.3: scrub widely, resolve narrowly.** The values of every command's declared flags and
    variables are scrubbed, whichever command runs, and `redacted.env` names every command's
    declared variables that are present; only the running command's credential sources are
    resolved and listed in `redacted.sources`, and a source only another command declares **MUST
    NOT** be resolved. Both writers already did this. Rejected: the running command's declarations
    only, because a secret in the environment can leak through a command that did not declare it;
    every command's sources, because resolving another command's source runs side effects the call
    never asked for.

  **The spec version does not move.** These are normative sentences added to `0.2.0` while it is
  still the unreleased proposal under this entry, which is how AGENTS.md and the §5.1 precedent
  above (flyingrobots/parley#75, also after `parley-emit` 0.1.0 shipped) treat a change before
  release: recorded here, not versioned. No implementation that conformed stops conforming: both
  writers already scrubbed widely and resolved narrowly, and `parley-emit` 0.1.0's `--help`, which
  omitted `parley.startup.failed`, already fell short of §4.2's own words, so the fix is to the
  writer and not to the spec. A tool must now document where it checks its arguments; that is new
  work for a tool's README, not a change to any line it emits. No schema moved.

### Added

- **The first release, and what keeps it immutable** (flyingrobots/parley#85): every schema's
  snapshot under `schemas/released/`; the loader now accepts a top-level file carrying a released
  pair only with the snapshot's exact bytes, and refuses two files that claim one pair with
  different bytes; a test refuses a top-level version that is neither snapshotted nor named under
  `Unreleased`. `RELEASE.md` declares the after-merge steps in the form footprint reads.
  `.github/workflows/release-parley-read.yml` releases the reader by tag, as parley-emit's does,
  and both workflows now fail before releasing anything if `npm publish --dry-run` reports it
  would rewrite or remove part of the manifest, if the packed manifest differs from the
  repository's, or if a dependency uses a `workspace:` range. `docs/topics/release` says what a
  release is, with its test plan (REL-1 to REL-4).

- **The doctor checks that discovery names the startup failure** (flyingrobots/parley#92):
  `R10.help_startup_failed`, §4.2. A run whose stdout carries a `command` line and ends with status
  0 must carry a `schema` line for `parley.startup.failed`. A discovery run that failed part-way
  owes no complete list and is not checked. `parley.tooling.doctor` stays 1.1.0, because `rule` is
  an open string and no line shape changed.

- **A read that cannot meet its budget declines, and names the budget that would**
  (flyingrobots/parley#71): `queryReceipts` and `openRecords` in `packages/parley-read` apply
  `budget.ms` as a deadline checked between phases on an injectable `clock` (monotonic by default,
  so tests script it rather than sleep), and decline a read past it — or one whose `budget.bytes`
  cannot hold an empty digest — with a recorded run that ends in one `query.over_budget` error and
  status 2. See the decision above and
  [the reader page](docs/topics/parley-read/README.md#when-a-read-declines).

- **A second conforming writer, in Python** (flyingrobots/parley#84): `packages/parley-emit-py`,
  one standard-library file a tool vendors by copying and pins by the digest `--vendor-info`
  prints. It is checked the way the spec asks a writer to be: the repository doctor passes on real
  captured runs of its example (success, a usage error as a startup failure, a runtime failure,
  `--help`, `--schema`, `--human`), `parley-read` loads its receipts with every `parley.*` record validated and no
  defect, and its `inv` equals the TypeScript writer's for the same question. No schema and no
  spec section moves. Writing it found three places the spec left a second implementation to
  guess, now decided: flyingrobots/parley#91 (the bootstrap line is the boundary for a usage error;
  the example checks its arguments before it, exit 3), flyingrobots/parley#92 (`--help` lists
  `parley.startup.failed`, as this writer does) and flyingrobots/parley#93 (scrub every command's
  declared secrets, resolve only the running command's sources, as both writers do).
- **The doctor checks a receipt alone** (flyingrobots/parley#84): `bun run doctor --receipt FILE`
  with no `--stdout` or `--stderr` runs the rules that need no stream, for the record of a
  `--human` run, whose streams are prose by request. `parley.tooling.doctor` stays 1.1.0: no line
  shape changed.

- **A built-in history transform that refuses a suspected secret** (flyingrobots/parley#60), in
  `parley-emit`: `refuseSuspectedSecrets()` withholds a line whose body matches one of ten
  documented token shapes and warns under `history.suspected_secret`, naming the withheld `seq`.
  It refuses rather than rewrites, so a false positive costs one stream line and never a changed
  receipt. No schema moves and the spec does not move: §8 is informative, the warning is a
  `parley.warning` 1.0.0 like any other, and nothing a conforming program must do changes. A
  transform may now also return `refuse(code, problem, remedy?)` to withhold a line under a code
  of its own; the writer still refuses a code that is not spec §6's shape or that carries a
  declared secret value.

- **A user-defined transform on the history sink, enforced** (flyingrobots/parley#57). A copy of a
  run on the shared stream of §8 can now be a **projection** of the receipt copy rather than the
  whole of it, because a path, a hostname or a repository name that is fine in a local receipt can
  be wrong on a timeline other people and tools read. The transform is configured in code,
  `main(tool, argv, handler, { history: { transform } })`, is handed the parsed record the receipt
  already holds — redacted, as §5.3 left it — and returns a record to put on the stream or nothing
  to withhold the line.

  The writer enforces the contract around it, so nothing the transform does can put an invalid
  line or a changed envelope on the shared timeline: `event`, `t`, `seq`, `run` and `_schema` are
  taken off whatever it returns and the receipt line's are put back; the returned body is
  re-validated against the schema for its **exact** advertised pair (§4.5); and a throw, a body
  that no longer validates, a body carrying a declared secret value the writer had already
  replaced, or a pair this writer holds no schema document for each withholds the line and raises
  one warning naming the withheld `seq` (`history.transform_failed`,
  `history.transform_invalid`, `history.transform_unredacted`,
  `history.transform_uncheckable`). A warning is never an error and never changes the exit status
  (§6.1). An environment variable naming a module to execute is out of scope and a separate
  decision.

  **New draft schema: `parley.history.transform` 1.0.0.** The stream copy of a projected run opens
  with it, naming the transform and the SHA-256 of its source text as the runtime renders it, so a
  reader can tell a projected copy from a whole one and by what. It carries the standard envelope
  like every `parley.*` message and reaches the stream alone, which is why it takes a `seq` the
  receipt has no line at; the receipt accounts for that gap as a `receipt.step`. A run with no
  transform configured has no opening line, no step and no difference in any byte. The schema is a
  draft under this entry and may change in place (§4.5).

  **§8 (informative) gains the sentence** that a copy on the shared stream may be a projection of
  the receipt copy, that such a copy says so by naming the projection that wrote it, and that a
  reader finding the same record in more than one copy should prefer the least-projected one. The
  spec version does not move: §8 is informative, nothing in it is a conformance requirement in
  v0.2, and no normative section, message shape or exit status changed. The reader's copy
  preference is flyingrobots/parley#58, implemented below.

  **Tooling.** `scripts/doctor.ts` grows `--history SEGMENT.jsonl`, which reads a segment of the
  shared stream rather than one run's three streams and reports each run's projection by name and
  digest, every `seq` a copy does not carry, and the lines that could not be parsed. Its output
  schema `parley.tooling.doctor` moves to **1.1.0** for the three new line types
  (`doctor.projection`, `doctor.gap`, `doctor.segment`) and the widened `stream` enum.

- **A reader prefers the least-projected copy** (flyingrobots/parley#58). §8 says a reader that
  finds the same record in more than one copy should prefer the least-projected one, because the
  receipt copy is the record and a projection is a view of it. `parley-read`'s loader now does:
  the copies from the sources that carry no `parley.history.transform` line for a run are folded
  first and alone, so a projected copy never contributes a field to the record — a view of a
  record cannot add to the record — and one whose body differs is recorded as a `Projection` note
  naming the transform and the digest of its source text rather than reported as the writer's
  `copies.disagree`. A `seq` the receipt carries and a projected copy does not is listed as
  **withheld** by that transform rather than left as a gap of unknown cause, and a record whose
  only copy is a projection's is returned and marked `projected`, naming the transforms it came
  from.

  **What makes a copy a projection is the source's own content, per run.** One segment can hold a
  projected copy of one run beside a whole copy of another, and the preference therefore never
  depends on which file was read first — the failure mode the issue names, held by a case that
  puts the projected copy in the location read first and then the other way round.

  **A projection narrows the body, never the envelope.** A projected copy that disagrees with the
  record on `event`, `t` or `_schema` is still §1.3's `copies.disagree` defect, reported whichever
  copy the preference returned: §8 permits a narrower body, not a different event.

  **The edge §8 leaves open: two projected copies of one event, by different transforms.** Neither
  is the less projected one, so the reader does not guess. They are folded as §1.3 copies in an
  order stated by the transform's name, its digest and the file, and a disagreement between them
  is `copies.projected_disagree` — its own code, because two views of one record were never
  required to agree.

  **A projection is a note, not a defect.** Narrowing what reaches a shared timeline is what a
  transform is for, so `defects` stays what could not be read or could not be validated, and the
  projection is reported beside it on the bundle. A segment reaches the loader by name —
  `loadReceipts({ history: [path] })`, or `readHistorySegment(path)` for one file — because the
  stream is opt-in and a reader that went looking for it would make the format depend on it.

  No schema moved and **the spec version does not move**: §8's opening paragraph is corrected to
  say the reader side now has an implementation, which is a documentation correction and not a
  promotion to normative, and no normative sentence changed.

- **A built-in history transform, `declaredProjection(values)`** (flyingrobots/parley#59): the
  common case for the transform above is a declared list the caller already knows is wrong on a
  shared timeline — a username in a path, a hostname, a private repository name — so this ships
  the writer's own §5.3 scrubber for it rather than leaving every caller to get longest-first
  replacement or key renaming subtly wrong a second time. An empty declared set configures no
  transform at all (`declaredProjection([])` is `undefined`), and the transform's name and digest
  on the stream's opening line never disclose what was declared. Self-review found a latent
  defect of its own: the scrub ran over a writer-built record's identity scalars too, so a
  declared value that coincided with the tool's own name would have silently renamed `tool` on
  the stream's head, with no schema pattern to catch it; `DIGEST_KEYS` (now exported from
  `src/run.ts`) exempts the same keys here that the receipt's own redaction already exempts for a
  writer-built record. No schema moves. PE-24a to PE-24f, with the doctor as the oracle.

- **The purpose orders a read's answer** (flyingrobots/parley#49). Spec §9 asks the purpose to
  shape the result and says it is the ranking function, not a filter applied afterwards.
  `parley-read` now ranks the records of a read by its `view`, under one total order stated as a
  key: the **failure surface** first when the view is an answer about a change, then the **view's
  own surface**, then **`(t, run, seq)` ascending**, which is the order a read answered in before
  there was a ranking. Under a view that implies a change, a failed run's records rank above a run
  whose outcome the window does not establish, and those above a run known to have succeeded —
  within a tier, never across one. The ranking is a pure function (`rankRecords`) so that the
  digest's truncation and excluded count (flyingrobots/parley#50) have something to truncate.

  **Ranking reorders and never filters.** Over-filtering is the failure mode §9 names, so every
  record in the window is in the answer whatever the view, held by a case over all five views and
  by a golden case on receipts the writer's own example tool really wrote — three runs in one
  directory, one of which really failed.

  **Which purposes imply a change is derived from the decided vocabulary, not from a new field.**
  `parley.query` 1.0.0 carries nothing saying so, and of the five view tokens exactly one is an
  answer about a change: `what-changed`, "subject-matter writes, and the inputs they consumed",
  which is the view §9's own example asks for. `what-failed` is left out deliberately, because
  failure is already that view's whole surface. Each token's surface is read off the same
  vocabulary. **No schema moved** and the spec is untouched; adding a view token would move
  `parley.query` and `parley.lens` and would have to decide the new token's surface and whether it
  implies a change.

  Living docs: `docs/topics/parley-read/README.md` states the key, each view's surface, the
  outcome rules and what the ranking is not; `docs/topics/reader/README.md` carries the derivation
  beside the vocabulary.

- The query entry point in the reader library (flyingrobots/parley#48): `queryReceipts` in
  `packages/parley-read` takes the asker, view, budget and window decided in
  flyingrobots/parley#46, refuses a read that states no asker, no view or no window with a
  structured refusal per field rather than guessing one, and records every accepted read as a
  `parley.query` 1.0.0 event through the writer — so a read is a run with a receipt of its own and
  the loader reads the question back as validated against the exact pair. The answer is the
  window's records in time order, the window echoed verbatim, the read excluded from its own
  answer. Nothing projects a record to fewer fields (flyingrobots/parley#59): the view is
  recorded, the limit is stated on the reader's and the library's reference pages, and a test pins
  two views over one window answering with the same records so a filter cannot creep in
  unnoticed. The order the view now imposes is flyingrobots/parley#49's and the bound the budget
  now applies is flyingrobots/parley#50's, both below. No schema moved.
- The digest the first response of a read is (flyingrobots/parley#50): `queryReceipts` in
  `packages/parley-read` now **bounds** its answer to the budget it records and emits a
  `parley.lens` 1.0.0 record through the writer saying what the bound left out — the query it
  answers by `(run, seq)`, the asker, the view, the window, the budget actually applied, the
  records it holds by `(run, seq)`, and `loss` with its `bound` and its `excluded` count. §9 asks
  a result to carry its own lens so a later reader "cannot mistake a digest for the whole"; the
  digest is evidence rather than a return value, written into the read's own receipt and read back
  `validated` against the exact pair. `budget.records` bounds the count of records named,
  `budget.bytes` bounds the lens line in UTF-8 bytes with its newline, and `budget.ms` bounded
  nothing until flyingrobots/parley#71 made it a deadline (above). `loss.excluded` is always present, zero included, and `loss.bound` is `none` only
  beside a count of 0 — the schema refuses the other pairing, so a digest that left something out
  says so structurally. **This replaces the limit flyingrobots/parley#48 landed**, where the
  budget was recorded and bounded nothing. **No schema version moved**; see the in-place draft
  change below. Fetching what a digest excluded is flyingrobots/parley#51.
- The shared history stream of spec §8, inside the writer: `packages/parley-emit` appends every
  line of the receipt to a dated daily segment when one is configured, by `PARLEY_HISTORY` or by
  `$XDG_STATE_HOME/parley/history` existing, so one timeline spans tools, repositories, agents
  and people. The sink receives the receipt's bytes, which is why a credential cannot reach it
  that did not reach the receipt; scope is one stream per user per machine and expiry unlinks
  whole segments, keeping `PARLEY_HISTORY_DAYS` of them (default 14). A run with no stream
  configured is unchanged in every byte, and a stream that cannot be written is a warning rather
  than an error, a sink failure or a different exit status: the dependency runs one way. §8 and
  §9 stay informative in v0.2 — §8's rules now have an implementation and tests behind them, and
  promoting them to normative is a spec version's decision, taken on its own. No schema version
  moves and no message type is added: `parley.run.bootstrap`'s `paths` is already open and
  already says a program may add paths it documents, so `paths.history` needs no version, and
  segment retention is recorded with `parley.receipt.step`. Fifteen cases, PE-22a to PE-22o,
  with the doctor as the oracle. Review of the same change found a latent redaction defect in the
  writer: the `code` of a diagnostic the writer itself raises was being scrubbed, which could put
  a line on the stream that no longer validated against its own schema, so a writer-raised code
  now joins the public identity a writer-built record carries. A tool's own diagnostic code is
  scrubbed exactly as before. (flyingrobots/parley#3)

- `packages/parley-read`: the reader library `@flyingrobots/parley-read`, a Bun workspace package,
  unreleased and private in its manifest. Its loader lists both receipt locations for a working
  directory and returns every run's records: newline-buffered over bytes, stray lines and
  unterminated tails quarantined and reported, copies deduplicated by `(run, seq)`, every
  `parley.*` line validated against the schema for its exact pair and every tool-owned line passed
  through as unvalidated, sidecars resolved against their declared digest, and a bundle ruled out
  for replay when a sidecar is broken, no `end` closes it, its status is non-zero or it is
  redacted. A library with no command; the doctor's rebuild on it is separate. Its own changelog
  lives beside it, the living reference is `docs/topics/parley-read/` with its test plan, and the
  repository's `bun test` and `bun run typecheck` cover it. (flyingrobots/parley#47)

- `.github/workflows/release-parley-emit.yml`: a tag `parley-emit-vX.Y.Z` runs the checks,
  creates the GitHub release with the tarball and publishes to npm through OIDC trusted
  publishing. Documented in `docs/workflows/release-parley-emit/`.

- `packages/parley-emit`: the writer library `@flyingrobots/parley-emit` 0.1.0, a Bun workspace
  package, published to npm on 2026-11-22 (tag `parley-emit-v0.1.0`); the package version moves
  on its own and this release publishes no schema version. A tool conforms by constructing a writer and emitting through it. Its own changelog
  lives beside it; the repository's `bun test` runs its suite, every case using the doctor as the
  oracle, and `bun run typecheck` checks it strictly. (flyingrobots/parley#1)
- `scripts/doctor.ts` (`bun run doctor`): a conformance checker that takes a captured run's
  stdout, stderr and receipt and reports every violated rule with its spec section, stream and
  line, as JSON Lines. Nine rules cover line discipline, the envelope, exact-pair validation, the
  bootstrap and startup failure, the receipt head, the one-counter rule, the terminal event and
  exit status, the redaction aggregate and receipt retention. Fixtures and a mutation test per
  rule. (flyingrobots/parley#23)

- `scripts/check-examples.ts`: validates every fenced JSON example in `README.md`, `spec/` and
  `docs/` against the schema its `_schema` names, with `abridged` and `illustrative` fence labels
  for examples that are deliberately not complete messages. Runs under `bun test` and in CI.
  (flyingrobots/parley#4)

- `docs/topics/related-work/README.md`: the neighbouring specifications and formats, what parley
  borrows from each, and what is its own; routed from the README and the docs index.
  (flyingrobots/parley#19)

- Schema constraints, each stated in the spec text (flyingrobots/parley#9,
  flyingrobots/parley#26): `t` is never negative (§1.3); `tool`, `v`, `run`, `inv` and `session`
  are non-empty (§2.1); `code` is two or more dot-separated segments of lowercase letters, digits
  and underscores and `problem` is non-empty (§6); `_schema.version` is exact (§4.5), which
  rejects leading-zero components with everything else. These narrow `parley.run.bootstrap` `1.1.1`
in place under the draft rule;
  the earlier `1.1.1` entry below described its first, description-only change. A shared envelope
schema file was
  considered and not adopted: `scripts/schemas.test.ts` enforces the envelope uniformly across
  every schema, and a cross-file `$ref` would force every consumer to preload schemas.
- `parley.receipt.head` requires `tool` and `v` (§5 MUST list), so a receipt read on its own says
  what wrote it and `inv` can be recomputed. (flyingrobots/parley#14)
- `schemas/README.md` lists each schema and its current version. (flyingrobots/parley#9)
- §5.3 redaction rule: secrets are declared in the command description's `secrets` list (§4.3);
  their values are replaced with `[redacted]` before the head is written; the head's new
  `redacted` field records argv indexes, resolved JSON Pointers, input indexes and env names and is
  present whenever a declared secret was supplied. §2.2: `inv` never incorporates a declared
  secret,
so a receipt
  is not an oracle for it; §2.3 and §5.3: a redacted receipt is never replayed from or served
  from cache. (flyingrobots/parley#13)
- §4.5: a schema version still under `Unreleased` is a draft and may change in place. The
  constraint additions above therefore stay at `parley.error` `2.0.0`, `parley.receipt.head`
  `2.0.0` and `parley.run.bootstrap` `1.1.1`.
- §3: the bootstrap line is written to stdout only. §4.6: a reader with no schema for an id must
  not validate the line against another schema. Checker docs explain exact-version resolution and
  that the checker is not a parley program. (flyingrobots/parley#26)

### Changed

- Follow-ups from the review of the lifecycle stack (flyingrobots/parley#40): §5's head carries a
  descriptor per input with a digest where already read, matching §2.2; nothing follows `end` on
  any stream and a post-`end` sink failure is carried by exit status alone, with `4` taking
  precedence over `2`; `end.redacted` has one definition (head `redacted` or any `redaction`
  event) and every extra redaction, including one in the head, is recorded by a `redaction`
  event; redaction is decided as a record is written and never rewrites a written line; credential
  sources are declared by logical name and recorded in `redacted.sources`, and a `--token-file`
  path stays visible; `startup.` is the stated code namespace; a `.parley/.gitignore` without `*`
  sends the run to the fallback, with a warning as a SHOULD; sidecars cover any record; the spec's examples form
  one failed run with monotone timestamps and the startup example has its own run; §1.2's stdout
  row names `end`; §4.5 names the three original `1.0.0` drafts; the §4.3 bookkeeping example
  includes the fallback scope and the §5 head example carries `bookkeeping`. Schemas (drafts): absolute `paths.receipt` and
  `end.receipt`; `end.status` never 3; sidecar paths relative and non-escaping; `redacted`
  non-empty with a `sources` list; an input never carries both `sha256` and `error`. Tests: a
  negative case per new-schema constraint, `parley.receipt.inputs` included. Docs: the output-contract and related-work pages no
  longer contradict §2.3 and §3. Second round: §2.3 treats a credential source declared by logical
  name as a declared secret and the program resolves declared sources before the head; §6's
  top-level handler converts throws before `end` only; `.parley/.gitignore` must contain a line
  consisting of `*`; sidecar paths must not leave the receipt directory; paths are POSIX; the
  examples drop `inv` for the run that never had one, list every declared input on the head, and
  give the cache-hit, README and doctor runs their own run ids; the sidecar example holds the
  page at `seq: 7`, whose receipt copy is the fuller one; a cache-serving reader falls back to the
  declaration only when it names no credential source.

- §4.1, §4.2: discovery is a run. `--schema` and `--help` bootstrap, write a receipt, carry the
  envelope and close with `end`; they emit `command` lines (name, intent, effects, secrets, the
  message types the command can emit) and `schema` lines (one message schema each). §4.3's
  effects example is now a complete `command` line. (flyingrobots/parley#10)
- Six draft schemas complete the set: `parley.command`, `parley.schema`, `parley.page` (cursor
  required when `has_more`), `parley.cache.hit`, `parley.receipt.step` (a decision and its
  reason), `parley.receipt.inputs`. Every message type the spec mandates now has a schema and a
  validated example; the §2.2, §2.3, §5 and §7.2 examples are complete rather than illustrative.
  (flyingrobots/parley#10)

- §1.2 and §6.1: stderr carries errors and warnings, both structured; a warning is a recovered
  condition with the error's shape and the event `warning`, retained in the receipt and never
  changing the exit status; progress goes to the receipt only. New draft schema `parley.warning`
  1.0.0 with a validated example. (flyingrobots/parley#16)
- §1.4 reader rules: buffer to the newline (a read chunk or flush is not a boundary); quarantine
  and report a non-JSON complete line on stderr and any unterminated EOF fragment; a non-JSON
  line on stdout is the writer's contract failure; quarantined lines prove nothing beyond their
  own existence. (flyingrobots/parley#16)

- §8 and §9 are informative in v0.2: their conformance obligations are removed and each says it
  describes a layer that is designed (flyingrobots/parley#2, #3) and not built. §9a's lineage
  prose moves to an unnumbered preface. The README marks the history layer as planned. The
  normative core is §1 to §7. (flyingrobots/parley#17)
- Name: the specification and repository keep Parley; libraries get distinct names
  (`parley-emit`, `parley-read`, `@flyingrobots/*`); "the Parley output protocol" where ambiguity
  matters. Recorded on the related-work page. (flyingrobots/parley#20)

- §2.1, §2.2: `inv` is SHOULD and tool-defined in v0.2; a program that supplies it documents its
  derivation and scope, omits it when unavailable (never a placeholder), and keeps declared
  secrets out of it. A shared derivation is targeted for v0.3 from a real implementation. The
  bootstrap line never waits on a directory scan or stdin EOF; late input digests and `inv` are
  carried by a `receipt.inputs` finalisation record (schema in flyingrobots/parley#10); an
  unreadable input is recorded with an error code and no digest. `inv` and `inputs[].sha256` are
  optional in the draft bootstrap and receipt-head schemas; `inputs[]` gains `role` and `error`.
  (flyingrobots/parley#11)
- §2.2, §5.3: a credential file is a secret source, never a declared input; its contents never
  contribute to any input digest or to `inv`, directly or through a directory digest, archive,
  manifest or derived value; a program that cannot establish that omits `inv`.
  (flyingrobots/parley#31)
- §2.3: "same `inv`, different result" is divergence under the recorded boundary, not proof of a
  determinism defect; replay is a MAY subject to eligibility. (flyingrobots/parley#11)

- §4.3: `effects.writes` means subject-matter writes only; evidence writes (receipt, sidecars,
  ignore file, retention) are declared in `effects.bookkeeping` with an operation and scope;
  `secrets` also names credential files; `--dry-run` emits bootstrap and receipt, performs no
  subject-matter writes, remote mutations or retention deletion, and is marked `dry_run: true` on
  the bootstrap line and receipt head. (flyingrobots/parley#12)
- §5: the receipt location is resolved against the initial working directory and announced as an
  absolute path; fallback to `$XDG_STATE_HOME/parley/<repo-hash>/receipts/` per the XDG rules,
  with `<repo-hash>` keying storage and never entering `inv`; if nothing is writable the run fails
  at startup with exit 3. (flyingrobots/parley#12)
- §5.2: the `.gitignore` mandate is replaced by create-if-absent `.parley/.gitignore` containing
  `*`, never overwriting an existing file and never editing a tracked one, with the honest
  statement that the file ignores itself and does not travel through a clone.
  (flyingrobots/parley#12)
- `parley.run.bootstrap` and `parley.receipt.head` gain optional `dry_run` (drafts, in place).

- Spec §3 is now the run lifecycle: §3.1 bootstrap (the receipt file is created or reserved before
  it is announced); §3.2 startup failure (one `startup.failed` line on stderr, exit 3, no
  fabricated bootstrap); §3.3 the terminal `end` event, written to stdout and the receipt as one
  event, immutable once emission begins, carrying `status`, `receipt` and an aggregate `redacted`
  flag; §3.4 the exit-status contract (0, 2, 3, 4, signal-derived, tool-owned). Completion,
  success, validation and replay eligibility are named as separate facts.
  (flyingrobots/parley#15)
- §5: the receipt retains every result, error and warning line and closes with `end`. A result
  over 65,536 serialised bytes may be stored as a sidecar, referenced by a `sidecar` event with
  the stored bytes' length and SHA-256; receipt and sidecars are one bundle; a missing or
  mismatched sidecar makes the bundle unavailable for replay. §5.4 defines persistence as
  ordinary-path: written and closed, no fsync promise, write errors are exit 4, an unterminated
  final line is ignored. (flyingrobots/parley#21)
- §5.3: a redaction decided after the head is written is recorded by a `redaction` event naming
  the affected record and pointer, and `end.redacted` aggregates all redaction state, so replay
  decisions read the receipt rather than the writer's memory. (flyingrobots/parley#13)
- New draft schemas: `parley.end` 1.0.0, `parley.sidecar` 1.0.0, `parley.redaction` 1.0.0,
  `parley.startup.failed` 1.0.0, each with a validated example in the spec.

- §4.5 and §4.6 amended: the same-major promise did not hold for open schemas (a minor that adds
  an optional typed field rejects an older line carrying another type under that name). Full
  validation is now against the schema for the exact advertised `(id, version)`; `_schema.version`
  is pinned by `const`; a reader without the exact schema may check the version-independent core
  and must report partial, never validation; released versions are snapshotted immutably under
  `schemas/released/`; fixtures pin a commit or digest for drafts. (flyingrobots/parley#8)
- §2.3: cache eligibility is checked on both sides for declared secrets; a secret supplied to the
  current invocation or a cached receipt carrying `redacted` disqualifies replay; a program using
  undeclared credentials declares them or never short-circuits; matching `inv` alone never
  authorises skipping an effect or reusing an answer. This is amendment (1) on
  flyingrobots/parley#13; amendment (2), discoverable late redaction, lands with the lifecycle
  (flyingrobots/parley#15, #21).

- Spec `0.1.0` → `0.2.0`. `run` joins the envelope every line carries (§1.3), so a line read out
  of a shared stream or an interleaved terminal can be attributed without state.
  (flyingrobots/parley#6)
- `seq` is one counter per run across stdout, stderr and the receipt. A line mirrored to more
  than one stream is one event: copies MUST carry the same `seq`, `t` and `event`, MAY omit
  fields another copy carries, and MUST agree on every field they share, so `(run, seq)`
  identifies an event. The receipt head is no longer pinned to `0`. (flyingrobots/parley#7)
- §4.5 and §4.6 (as first merged in #25, since amended by the entry above): schema versions carry
  a compatibility promise; schemas are open everywhere except `_schema`; `_schema` and `$id` are
  identifiers, not URLs to fetch; the `1.0.0` schemas predate the rule. (flyingrobots/parley#8)
- §2.1: `session` is optional; a program MUST carry it when supplied and MUST NOT invent one.
- §3: the bootstrap line is the first line a run emits, on whichever stream, not only the first
  line of stdout. It is not itself mirrored into the receipt, whose first line is the head.
- `parley.error` `1.0.0` → `2.0.0`: `run` required, `seq` at least `1`, `_schema` pinned (now by
  `const` to the exact version; see the §4.5 entry above).
- `parley.receipt.head` `1.0.0` → `2.0.0`: `seq` at least `1`, `_schema` pinned (now by `const`
  to the exact version; see the §4.5 entry above).
- `parley.run.bootstrap` `1.0.0` → `1.1.0`: opened (top level and `paths`), `_schema` pinned
  (now by `const` to the exact version; see the §4.5 entry above).
- §5 gains a complete receipt-head example and §6's error example is now complete, so the
  example checker validates all three schemas.
- `parley.run.bootstrap` `1.1.0` → `1.1.1`: `paths.log` and `paths.error` are no longer
  described, since the protocol defines no such streams; `receipt` is the only defined path.
  Descriptions only; nothing previously valid is rejected. (flyingrobots/parley#18)
- §1.2a states what each kind of evidence establishes: a validated line has the declared shape, a
  digest identifies bytes, a receipt is what the producer reports, an independent check covers
  its stated procedure. The receipt is a record, not a proof; remedies are advice, effects are
  claims, observer and purpose are query context, and none grants or enforces permission. §9a and
  the README no longer call the shape "causal" or "replayable"; they say what §1.3 defines.
  (flyingrobots/parley#22)
- Normative keywords cite RFC 2119 and RFC 8174; §1.1's no-colour rule carries its keyword; §3
  says how `v` differs from `_schema.version`; example timestamps are in 2026.
  (flyingrobots/parley#18)

### Fixed

- **Retention is per tool** (flyingrobots/parley#75). `parley-emit` counted every `.jsonl` in a
  receipt directory, so a reader's receipts (one per read) took slots of a tool's count and the
  tool's next run deleted that many of its own, the history the reader came to read. `retain` now
  counts and expires only completed bundles whose head names this tool; another tool's receipts
  are never counted and never deleted, and a file whose first line is not a readable head is not
  this tool's and is left alone. The head is read first line only. The decision line now says "of
  this tool's receipts". The decision, the owner's on the issue: per tool, rather than a separate
  place for reads, so one loader call still finds everything. **Spec §5.1** gained a sentence
  saying so: a program's policy bounds the receipts it wrote and **MUST NOT** count or delete
  another program's. It reads as a clarification of what "a retention policy" meant, made inside
  the unreleased `0.2.0` entry, so **the spec version does not move** (AGENTS.md: a normative
  sentence changed before release is recorded in that entry, not versioned). Cost: one bounded
  read of each receipt's first line per run, up to a 1 MiB head, past which a file is read as
  unreadable and left alone.
- `parley-read`: under `what-changed`, a warning from a run that went on no longer outranks every
  result. The change-view promotion now holds the failure surface **of the runs that failed**, so a
  `warning` is promoted only with its run's failure and is otherwise placed by the view's own
  surface rule (§6.1). Before, a history of runs that warned filled a `what-changed` digest with
  warnings and named no result. `what-failed` keeps every warning on its surface.
  (flyingrobots/parley#76)
- The README bootstrap example emitted a top-level `receipt`; the schema requires
  `paths.receipt`. (flyingrobots/parley#5)
- The spec's introduction, §8's opening paragraph and §9's opening paragraph still said the
  history layer did not exist and the §9 reader was designed but not built. Both claims had gone
  stale: §8's writer side — the shared stream, its segments and retention, and the transform that
  projects a copy of it — has an implementation and tests in `packages/parley-emit`
  (flyingrobots/parley#3, flyingrobots/parley#57), and §9's query entry point and the ranking that
  orders a result by purpose have an implementation and tests in `packages/parley-read`
  (flyingrobots/parley#48, flyingrobots/parley#49). The three paragraphs are corrected to say so.
  Nothing else in either section changed: each still says it is informative and becomes normative
  only when an implementation and tests support its rules in full, which neither does yet —
  bounding an answer and its detail (flyingrobots/parley#50, flyingrobots/parley#51) remain
  design, and the reader optic as a whole (flyingrobots/parley#2) is still open. The root README's matching sentence is corrected the same
  way. **Decided: no, nothing moves to normative.** This is a documentation correction, not a
  promotion — the gap between "has an implementation and tests" and "normative" is deliberate
  (§4.5), and moving either section is a separate decision for a separate issue, should one ever
  be opened. **The spec version does not move**: no normative sentence changed, so `0.2.0` still
  names exactly the rules it always did. (flyingrobots/parley#65)

## [0.1.0] — 2026-11-22

### Added

- The parley v0.1 specification: JSON Lines by default, versioned per-message schemas,
  content-addressed invocation identity, the bootstrap line, durable receipts, structured errors,
  the optional shared history stream, and task-oriented reads.
- JSON Schemas for `parley.run.bootstrap`, `parley.error` and `parley.receipt.head`.
