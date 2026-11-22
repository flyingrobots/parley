# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The spec and each message schema are versioned separately from this package.

## [Unreleased]

### Changed

- Spec `0.1.0` → `0.2.0`. `run` joins the envelope every line carries (§1.3), so a line read out
  of a shared stream or an interleaved terminal can be attributed without state.
  (flyingrobots/parley#6)
- `seq` is one counter per run across stdout, stderr and the receipt. A line mirrored to more
  than one stream is one event: copies MUST carry the same `seq`, `t` and `event`, MAY omit
  fields another copy carries, and MUST agree on every field they share, so `(run, seq)`
  identifies an event. The receipt head is no longer pinned to `0`. (flyingrobots/parley#7)
- §4.5 and §4.6: minor schema bumps are additive and readers ignore unknown fields; a reader
  validates any line of the major it was built against and rejects a different major; a minor
  bump is additive in both directions, so narrowing a constraint is major; schemas are open
  everywhere except `_schema`, which pins its `id` and constrains `version` to the major;
  `_schema` and `$id` are identifiers, not URLs to fetch. The promise binds from the versions
  below; all three `1.0.0` schemas predate it. (flyingrobots/parley#8)
- §2.1: `session` is optional; a program MUST carry it when supplied and MUST NOT invent one.
- §3: the bootstrap line is the first line a run emits, on whichever stream, not only the first
  line of stdout. It is not itself mirrored into the receipt, whose first line is the head.
- `parley.error` `1.0.0` → `2.0.0`: `run` required, `seq` at least `1`, `_schema` major-pinned.
- `parley.receipt.head` `1.0.0` → `2.0.0`: `seq` at least `1`, `_schema` major-pinned.
- `parley.run.bootstrap` `1.0.0` → `1.1.0`: opened (top level and `paths`), `_schema`
  major-pinned.
- §5 gains a complete receipt-head example and §6's error example is now complete, so the
  example checker validates all three schemas.

### Added

- `scripts/check-examples.ts`: validates every fenced JSON example in `README.md`, `spec/` and
  `docs/` against the schema its `_schema` names, with `abridged` and `illustrative` fence labels
  for examples that are deliberately not complete messages. Runs under `bun test` and in CI.
  (flyingrobots/parley#4)

### Fixed

- The README bootstrap example emitted a top-level `receipt`; the schema requires
  `paths.receipt`. (flyingrobots/parley#5)

## [0.1.0] — 2026-11-22

### Added

- The parley v0.1 specification: JSON Lines by default, versioned per-message schemas,
  content-addressed invocation identity, the bootstrap line, durable receipts, structured errors,
  the optional shared history stream, and task-oriented reads.
- JSON Schemas for `parley.run.bootstrap`, `parley.error` and `parley.receipt.head`.
