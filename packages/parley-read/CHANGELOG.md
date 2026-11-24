# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This package is versioned
on its own; the spec and each message schema move separately (spec §4.4).

## [Unreleased]

## [0.1.2] — 2026-11-24

No change to behaviour or to the schemas it ships. A read's own receipt records `v` `0.1.2`.

### Changed

- The dependency on `@flyingrobots/parley-emit` is `^0.3.0`, up from `^0.2.4`, so the range admits
  the version in the repository (flyingrobots/parley#132).

## [0.1.1] — 2026-11-24

No change to behaviour or to the schemas it ships. A read's own receipt records `v` `0.1.1`.

### Changed

- The dependency on `@flyingrobots/parley-emit` is `^0.2.4`, up from `^0.2.0`. 0.2.4 is the first
  0.2 version on npm; 0.2.0 to 0.2.3 exist as tags only, so the old range named versions no
  installer could resolve. An install of 0.1.0 already resolved to 0.2.4.
- First version released through the workflow: staged on npm by `release-parley-read.yml` and
  approved by the owner (flyingrobots/parley#85). 0.1.0 was published by hand.

## [0.1.0] — 2026-11-22

The first public version. It depends on `@flyingrobots/parley-emit` `^0.2.0`, so parley-emit 0.2.0
is published first. The schemas it ships are the released versions of the repository's first
schema release, spec `0.2.0` in the root `CHANGELOG.md`, byte for byte (`src/schemas.ts` records the
commit and each digest); no schema version is released by this package release (spec §4.5).

### Added

- **A run section carries the head's `resolved`** (flyingrobots/parley#90): the run's
  interpretation after defaults and environment, copied whole when it is an object, so a reader
  can tell which commits `HEAD~1..HEAD` was without opening the head. It is the first field
  dropped to fit `RUN_SECTION_BYTES` and is named in `dropped`. `RunSection` gains `resolved`.
  Runs whose heads' `resolved` differ no longer fold, even with one `inv` (RD-100g).

- **Runs of one invocation with one result are named once** (flyingrobots/parley#79). Before the
  bound is applied, `digestFor` folds the window's runs whose `inv`, outcome, `reason`, `end`
  status and error, warning and startup-failure codes are all equal into the most recent of
  them. That run's section carries `folded: {others, records}`, both counting the other runs only, so
  the section reads as "this run, plus `others` like it" (flyingrobots/parley#100; `RunFold.others`
  replaced `RunFold.runs`, which included the representative), and the lens's `loss` carries
  `folded`, how many of `excluded` the fold left out. A run with no `inv`, or a redacted run,
  never folds, and nothing folds when `digestFor` is given no outcomes. New exports: `foldRuns`
  and the types `Folding` and `RunFold`. `Digested` and `QueryAnswer.counts` gain `folded`,
  `runSection` takes the run's fold as a fourth argument, and `sufficientBytes` takes the fold's
  count as a fifth, default 0. On footprint's own 50 receipts a digest of 20 under `what-ran` now
  names 11 distinct invocations where it named 6 (`docs/topics/reader/cold-resume.md`).

- **A decline on budget grounds** (flyingrobots/parley#71). `budget.ms` is a deadline for the
  whole read, read on `opts.clock` (default `MONOTONIC`, `performance.now`) once at the call and
  once at each check: after the load, after the ranking and before the digest is written, and for
  `openRecords` after the load and after the ids are opened. The deadline is inclusive. A read past
  it, or whose `budget.bytes` cannot hold a digest naming no records, writes no lens, reports a
  `receipt.step` and one `parley.error` `query.over_budget` (`measured`, `limit`, `remedy`,
  `retryable: true`, and `detail` with `bound`, `phase`, `given`, `measured`, `sufficient` and
  `at_least`), ends with status 2, and returns a new `QueryDeclined` / `OpenDeclined` outcome.
  New exports: `Deadline`, `MONOTONIC`, `OVER_BUDGET`, `declineOnRun`, `sufficientBytes` and the
  types `BudgetDecline`, `BudgetPhase`, `QueryDeclined`, `OpenDeclined`; `digestFor` reports
  `fits`. `openRecords` accepts `budget.ms` and records it in its `parley.query`.

- **Each run a digest names, stated once** (flyingrobots/parley#83). A `parley.lens` now carries
  `runs`, one section per run its entries name, in the order they first name it: the head's
  `tool`, `v`, `argv` and `inv` (or `receipt.inputs`'s `inv`), the run's `outcome` over the whole
  window, and a `reason` (`no_end_in_window`, `end_status_unusable`) when that outcome is
  `undetermined`. A run whose head is outside the window says `head: "not_in_window"`. A section is
  bounded by `RUN_SECTION_BYTES` (512): whole fields are dropped, `argv`, then `inv`, then `v`,
  then `tool`, and named in `dropped`; no string is cut. An `error` or `warning` entry also carries
  its `code`. `runSection`, `RUN_SECTION_BYTES`, `DROPPABLE` and `UNDETERMINED_REASONS` are
  exported. Under `{records: 20, bytes: 2048}` over three-record runs a digest now names 13 records
  (RD-22b).

- **A summary beside each record a digest names** (flyingrobots/parley#77). Each `parley.lens`
  entry now carries the record's `event` and `t` as the loader read them, each absent when the
  record does not carry it. `lensEntry(record)` builds one; `digestFor` takes the ranking's
  `outcomes` as a fifth argument and `queryReceipts` passes them. The run's outcome, which this
  entry first put on every entry, is stated once per run in `runs` since flyingrobots/parley#83,
  and `lensEntry` no longer takes `outcomes`. The summary counts against `budget.bytes` (RD-22b).
- **A byte budget for the drill-down** (flyingrobots/parley#78): `openRecords` accepts
  `budget: { bytes }`. Records open whole, in the order asked, while their summed size (UTF-8 bytes
  of each record's JSON as returned, sidecar contents included) stays within the bound; every id
  past it is a new `over_budget` outcome carrying `bytes` and no contents, never a truncated
  record. Each id is judged against what remains, so a small record after an over-budget one may
  still open; not-found and `sidecar_unavailable` outcomes cost nothing. The recorded
  `parley.query` and the answer's `budget` carry the bound applied; `counts.overBudget` is new.
  `recordBytes`, `openedBytes` and `applyBudget` are exported. A malformed bound is refused
  `query.budget_invalid`.
- **The drill-down**, `openRecords(request, opts)` (flyingrobots/parley#51): records by the
  `(run, seq)` pairs a `parley.lens` names, each in full, in the order asked, with exactly one
  outcome per id — `opened`, `sidecar_unavailable`, `run_not_found` or `seq_not_found` — and never
  a throw for one bad id. A record stored in a sidecar opens with its contents, checked by the
  loader against the declared `bytes` and `sha256`; opening the `sidecar` event itself brings the
  stored record as `held`; a sidecar missing, mismatched or unchecked is that id's outcome and
  claims no contents. Every id whose run resolved carries its bundle's replay ruling, so a failed
  run's `error` opens and says its bundle is unavailable for replay.
- A drill-down is **a recorded read**: refused without an asker, a view, a window and at least one
  well-formed id (`open.records_missing`, `open.records_invalid` beside the query's own codes),
  writing nothing; accepted, it is a run of its own whose `parley.query` record carries the new
  optional `records` field, followed by a `receipt.step` stating the outcome counts. It emits no
  `parley.lens`. `planOpen` and `openOne` are its refusal rules and its per-id resolution as pure
  functions. `src/schemas.ts` is re-synced for the `parley.query` draft change; no version moved.
- **The least-projected copy of a record** (flyingrobots/parley#58, spec §8). The loader folds the
  copies from the sources that carry no `parley.history.transform` line for a run first and alone,
  so the receipt copy is the record and a projected copy never contributes a field to it. A
  projected copy whose body differs is recorded as a `Projection` on the bundle — the source, the
  transform's `name` and `sha256`, the `seq` its opening line took, the `seq` values it
  `superseded` and the ones it `withheld`, and whether it is the `sole` copy read — rather than
  reported as a `copies.disagree` defect, which it never was. A record whose only copy is a
  projection's is returned with `projected: true` and `projectedBy` naming the transforms.
  Identical copies dedupe exactly as before.
- §8 lets a projection narrow the body and never the envelope, so a projected copy that disagrees
  with the record on `event`, `t` or `_schema` is still §1.3's `copies.disagree` defect, reported
  whichever copy the preference returned.
- Two projected copies of one event, by different transforms, are the edge the rule cannot settle:
  neither is the less projected one, so they are folded as §1.3 copies in an order stated by the
  transform's name, its digest and the file — never the order the files were read in — and a
  disagreement between them is the new `copies.projected_disagree` defect.
- `loadReceipts({ history: [path] })` and `readHistorySegment(path)`: a segment of the shared
  stream, by name. The stream is opt-in and this reader never looks for it; a segment named but
  unopenable is a `history.unreadable` defect rather than a throw. `Where` gains `history`.
  `queryReceipts` passes the same option to its load, so a read and its digest see the copies a
  load would. Its options type already accepted `history`, and until now it dropped it.

- `src/schemas.ts` re-synced from the repository drafts: the reader now ships seventeen, adding
  `parley.history.transform` 1.0.0 (flyingrobots/parley#57), so a projected copy's opening line on
  the shared stream validates against its exact pair rather than being reported as partial. No
  reader behaviour changed and no schema moved; preferring the least-projected copy of a record is
  flyingrobots/parley#58.

- A read over the loaded records, `queryReceipts`, taking the representation decided in
  flyingrobots/parley#46: a read states an `asker`, a `view` and a `window`, and is **refused**
  without them. `asker.tool` is never invented (§2.1) and there is no privileged view to fall back
  on, so each is refused rather than guessed; a window is refused missing, half-stated, malformed
  or inverted; `budget` is the one field with a default, `{"records": 20}`, and the answer says
  when it defaulted. Every refusal that applies is returned, each carrying §6's `code`, `problem`
  and `remedy` with the field it is about, so a caller that is itself a parley tool can hand one
  to `run.error`.
- The inference the decision asks for, and no more: `asker.cwd` is the directory the read was made
  against when the caller states none, recorded so it is visible. `asker.task` is "from the
  environment" in flyingrobots/parley#46 without a variable named, so it comes from the request and
  is omitted when absent rather than read out of a variable this library would be inventing (§2.1).
  A value `parley.query` could not carry — a relative `asker.cwd`, an empty `task`, an empty
  `note` — is refused rather than emitted as a line that fails its own schema.
- A refused read is **not a run**: no receipt, no `.parley` directory, nothing written anywhere.
  §9 records a question that was asked, and a question nobody could state has no asker to
  attribute it to. `planQuery` is the same rules as a pure function, for a caller that wants the
  verdict without making the read.
- An accepted read is **recorded**: the `parley.query` 1.0.0 event is emitted through
  `@flyingrobots/parley-emit`, so a read is a run with a receipt beside the ones it read, its two
  decisions are in that receipt, and the loader reads the query back as `validated` against the
  exact pair. The answer names the record by `(run, seq)`. The read's own run identity is
  `parley-read` at the package version, or whatever a host program embedding the reader names
  itself; that is not the asker.
- **The view orders the answer, and filters none of it** (flyingrobots/parley#49). Spec §9 says the
  purpose shapes the result and is the ranking function rather than a filter applied afterwards, so
  `rankRecords(query, records)` is that order on its own: a pure function from an accepted query
  and records to the same records, reordered, reading nothing and writing nothing. One total order
  on a key per record, compared left to right — the **failure surface** when the view is an answer
  about a change, then the **view's own surface**, then **`(t, run, seq)` ascending** — so a view
  whose surface no record touches leaves the answer exactly as it was, and `everything` ranks
  nothing. Under a view that implies a change, a failed run's records also rank above an
  `undetermined` run's and those above a succeeded run's, within a tier and never across one.
  `queryReceipts` answers through it and carries the whole key back in `answer.ranking`: each
  record's `rank`, `tier`, `outcome` and the `why` behind them, the per-run outcomes and the tier
  counts.
- Each view's surface is read off the vocabulary's own definition of its token
  (flyingrobots/parley#46), and **which token implies a change is derived the same way rather than
  from a new field**: `parley.query` 1.0.0 carries none, and of the five tokens exactly one is an
  answer about a change, `what-changed`. `what-failed` is deliberately not in that set, because
  failure is already its whole surface. No schema moved and `spec/` is untouched.
- A run's outcome is established from **the records being ranked**, not from the whole history: an
  `error`, a `startup.failed` or a non-zero `end` is `failed`, an `end` of zero is `succeeded`, and
  anything else — including a run whose `end` the window does not hold — is `undetermined` rather
  than counted as a success (§1.2a). A `warning` is on the failure surface and does not make its
  run a failed one (§6.1).
- **Ranking never drops a record.** Over-filtering is the failure mode §9 warns about, so every
  record in the window is in the answer whatever the view, pinned by a case over all five views and
  by a golden case on receipts a real tool wrote. Six thousand records rank in about 5 ms here,
  against a stated bound in the suite.
- The answer is the window's records, ordered by the view and cut at the budget, with the
  window echoed verbatim and the read's own records excluded — a read does not answer itself, and
  `counts` says how many were scanned, in the window, answered, excluded, undated and the read's
  own. A record whose `t` is not a number cannot be placed in a window and is counted rather than
  dropped silently.
- **The first response is a bounded digest that states its lens and what it excluded**
  (flyingrobots/parley#50). Spec §9 asks a result to carry its own lens so a later reader "cannot
  mistake a digest for the whole", and to report what it excluded at least as a count. The digest
  is a **`parley.lens` 1.0.0 record** — the message decided in flyingrobots/parley#46, not a new
  one — emitted through the writer onto the read's stream and into its receipt, so the loader reads
  it back `validated` against the exact pair. It names the query it answers by `(run, seq)`, the
  asker, the view, the window, the budget actually applied, the records it holds by `(run, seq)`
  and the loss. `digestFor`, `digestLine` and `digestBytes` are the bound as pure functions, and
  `answer.digest` and `answer.digestBytes` are what the read wrote.
- **The bound, exactly.** `budget.records` bounds the count of records a digest names.
  `budget.bytes`, when stated, bounds the lens line as written — serialised JSON plus its newline,
  in UTF-8 — and records are dropped from the tail of the ranking until it fits, by binary search
  over the prefix length; a bytes budget too small even for a digest naming no records left it
  naming none, because the envelope and the lens's own fields are not negotiable (it now declines:
  flyingrobots/parley#71, under Changed). `budget.ms` bounded nothing until the same issue made it
  a deadline. The bound is
  applied **before** the line is written, by reconstructing the line the writer will write, which a
  case pins against the line the writer really wrote.
- **A digest cannot read as complete.** `loss.excluded` is always present, zero included, because
  an absent count and a count of zero are different claims; `loss.bound` is `none` only beside a
  count of 0 and the schema refuses the other pairing, so the claim is structural rather than
  prose. The answer's `records` and the ranking it carries stop at the bound, while
  `counts.inWindow` and the ranking's per-run outcomes and tier census still describe the whole
  window the digest was drawn from — a caller can see the digest is not the whole without being
  handed what it cut, and a run's outcome stays established from the window rather than from a
  prefix of it (§1.2a). Measured over a history grown from 3 to 300 receipts under one budget, the
  digest's line went 823 → 1325 → 1326 bytes: a hundredfold more history costs one byte.
- Deliberately **not** done, the safe intermediate state flyingrobots/parley#51 names: what a
  digest excluded is not fetchable. The count is all a caller gets, and the digest stores the way
  back by `(run, seq)` for the call that will.
- A read states a retention policy that deletes nothing (`NO_RETENTION`): §5.1 asks every tool for
  one, and expiring the receipts a read was asked to read would destroy the history in order to
  answer a question about it. (Since flyingrobots/parley#75 retention is per tool, so a read's
  receipts no longer cost another tool its history; a read still deletes nothing, because it
  would expire only its own receipts, and nothing asked it to.)
- The loader: `loadReceipts` returns every run in both receipt locations for a working directory
  as bundles, and `readReceiptFile` reads one receipt file, yielding one bundle per run it holds.
  A bundle carries its records in `seq` order, its resolved sidecars, its quarantined lines, every
  defect found, whether it terminated, its status, whether it is redacted, and whether anything
  rules replay out.
- `receiptLocations`, `repoReceiptDir` and `stateReceiptDir`: both places spec §5 lets a writer put
  a receipt, each reported present or absent, creating nothing. The repository-root digest and the
  state base come from `@flyingrobots/parley-emit` so the key cannot drift from the writer's.
- `LineBuffer`, `splitLines` and `readFileLines`: newline buffering over bytes, so a line — or a
  multi-byte character — split across two reads is one line (§1.4), and the unterminated fragment
  at EOF is kept apart and is never a record (§5.4).
- Quarantine under §1.4 and §1.3: a complete line that is not a JSON object, a blank line, an
  object with no usable `(run, seq)`, and the unterminated tail are each kept verbatim, reported as
  a defect attributed to the run where the file name allows it, and never returned as a record.
- `(run, seq)` folding under §1.3: copies are one record, a copy contributes the fields it alone
  carries, a disagreement on a shared field is a `copies.disagree` defect, two runs interleaved on
  one stream come back as two bundles, and a bundle copied into both locations comes back as one.
- `validator`: validation against the schema for a line's exact advertised `(id, version)` pair
  (§4.5, §4.6). A `parley.*` pair the package does not ship is reported `partial` with the §1.3
  gaps, never as validated; a tool-owned id is passed through `unvalidated`; a line with no
  `_schema` is `unvalidated` too. Compilation is lazy and cached.
- Sidecar resolution under §5: the stored bytes are checked against the declared `sha256` and
  `bytes`, the record is restored at the `seq` the event names, and a path that is absolute or
  would leave the receipt's directory is refused before anything is read.
- `replay`: a missing, mismatched, escaping, unparseable or unreadable sidecar, no
  newline-terminated `end`, a non-zero status, or a redacted receipt each rule a bundle out, with a
  reason per rule (§5, §5.3, §5.4). Nothing ruling it out is reported as exactly that, since
  §2.3 and §5.3 eligibility for a given invocation is the caller's to decide.
- Robustness, from the review of the first candidate: a receipt file that cannot be opened is a
  `receipt.unreadable` defect in `load.defects`, not a throw that loses the rest of the directory;
  and with `sidecars: false` a sidecar is reported `unchecked` rather than `intact`, since nothing
  about its stored bytes was established (§1.2a), which also rules replay out.
- The sixteen draft schemas at the pinned commit, with a test that they match the repository.

### Changed

- **`DROPPABLE` is `resolved`, `argv`, `inv`, `v`, `tool`** (flyingrobots/parley#90), one longer and
  with `resolved` first. Under `{records: 20, bytes: 2048}` over three-record runs a digest names
  12 records where it named 13 (RD-22b: 1526, 1916 and 1917 bytes).

- **A digest no longer names every repeat of a run** (flyingrobots/parley#79). Where two runs are
  one invocation with one result, the answer's `records` and the ranking it carries now hold only
  the most recent one's records, and `loss.excluded` counts the other's. Three runs of the
  writer's `count` example, two of which succeed, now come back as 7 named records of 11. Every
  lens line carries `"folded":0` or more in its `loss`, 11 bytes more than before when nothing
  folds (RD-22b: 1433, 1981 and 1982 bytes).

- **A `budget.bytes` too small for an empty digest declines** (flyingrobots/parley#71). It used to
  answer with a digest naming no records whose line was still over the stated bound; it now
  declines with `query.over_budget` and names the smallest sufficient `bytes`. `QueryAnswer` and
  `OpenAnswer` carry `declined: false`, and `QueryOutcome` and `OpenOutcome` gain the declined
  variant, so a caller that narrowed on `refused` alone narrows on `declined` too.

### Fixed

- **Under `what-changed`, a warning no longer outranks every result** (flyingrobots/parley#76).
  The change-view promotion put the whole failure surface in the `failure` tier, warnings included,
  so a history of runs that warned and went on filled a digest with warnings and named none of the
  view's own surface: on 50 real footprint receipts, every one of the 20 records a default
  `what-changed` read named was an error, a non-zero `end` or a warning, and no result was among
  them. The tier now holds **the failure surface of the runs that failed**. A `warning` from a run
  the ranked records do not establish as failed, whether it succeeded or its outcome is
  `undetermined`, is placed by the view's own surface rule (§6.1, §1.2a), and its `why` says so.
  Errors, startup failures and non-zero ends still rank first, a failed run's warning ranks with
  them, and `what-failed` keeps every warning on its surface. `onFailureSurface` is unchanged. No
  schema moved and `spec/` is untouched. RD-18e's oracle changed with the rule; RD-40a to RD-40d
  are new.
