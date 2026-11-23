# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This package is versioned
on its own; the spec and each message schema move separately (spec §4.4).

Nothing is released yet: no version heading below names a release, and the package is private in
its manifest so it cannot be published by accident.

## [Unreleased]

### Added

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
  over the prefix length; a bytes budget too small even for a digest naming no records leaves it
  naming none, because the envelope and the lens's own fields are not negotiable. `budget.ms`
  bounds nothing: a read that has loaded the history has already spent its time. The bound is
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
  answer a question about it.
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
