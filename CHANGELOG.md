# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The spec and each message schema are versioned separately from this package.

## [Unreleased]

### Changed

- Spec `0.1.0` → `0.2.0`. `run` joins the envelope every line carries (§1.3), so a line read out
  of a shared stream or an interleaved terminal can be attributed without state.
  (flyingrobots/parley#6)
- `seq` is one counter per run across stdout, stderr and the receipt; a line mirrored to more
  than one stream keeps its `seq`, so `(run, seq)` identifies an event. The receipt head is no
  longer pinned to `0`. (flyingrobots/parley#7)
- §4.5 and §4.6: minor schema bumps are additive and readers ignore unknown fields; major bumps
  are rejected by older readers; schemas are open at the top level and `_schema` is pinned by
  `const`; `_schema` and `$id` are identifiers, not URLs to fetch. (flyingrobots/parley#8)
- `parley.error` `1.0.0` → `2.0.0`: `run` required, `_schema` pinned.
- `parley.receipt.head` `1.0.0` → `2.0.0`: `seq` is at least `1`, `_schema` pinned.
- `parley.run.bootstrap` `1.0.0` → `1.1.0`: top level opened per §4.5, `_schema` pinned.

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
