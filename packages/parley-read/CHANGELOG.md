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
- The answer is the window's records, ascending by `t` with `(run, seq)` breaking a tie, with the
  window echoed verbatim and the read's own records excluded — a read does not answer itself, and
  `counts` says how many were scanned, in the window, undated and the read's own. A record whose
  `t` is not a number cannot be placed in a window and is counted rather than dropped silently.
- Deliberately **not** done, each the safe intermediate state its issue names: the view is
  recorded and projects nothing (flyingrobots/parley#49), the budget is recorded and bounds
  nothing, with no excluded count claimed (flyingrobots/parley#50), and no `parley.lens` is
  emitted, because a read that returns the records has no loss to state. A test pins two views
  over one window answering the same, so the limit cannot drift unnoticed.
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
