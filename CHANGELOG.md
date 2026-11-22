# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The spec and each message schema are versioned separately from this package.

## [Unreleased]

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
