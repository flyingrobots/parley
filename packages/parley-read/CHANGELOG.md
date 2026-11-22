# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This package is versioned
on its own; the spec and each message schema move separately (spec §4.4).

Nothing is released yet: no version heading below names a release, and the package is private in
its manifest so it cannot be published by accident.

## [Unreleased]

### Added

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
- The fourteen draft schemas at the pinned commit, with a test that they match the repository.
