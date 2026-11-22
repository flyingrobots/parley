# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The spec and each message schema are versioned separately from this package.

## [Unreleased]

### Changed

- §4.5 and §4.6 amended: the same-major promise did not hold for open schemas (a minor that adds
  an optional typed field rejects an older line carrying another type under that name). Full
  validation is now against the schema for the exact advertised `(id, version)`; `_schema.version`
  is pinned by `const`; a reader without the exact schema may check the version-independent core
  and must report partial, never validation; released versions are snapshotted immutably under
  `schemas/released/`; fixtures pin a commit or digest for drafts. (flyingrobots/parley#8)
- §2.3: cache eligibility is checked on both sides; a secret supplied to the current invocation
  or a cached receipt carrying `redacted` disqualifies replay; matching `inv` alone never
  authorises skipping an effect or reusing an answer. (flyingrobots/parley#13)

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

### Added

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
  and underscores and `problem` is non-empty (§6); `_schema.version` rejects leading-zero
  components (§4.5). These narrow `parley.run.bootstrap` `1.1.1` in place under the draft rule;
  the earlier `1.1.1` entry below described its first, description-only change. A shared envelope schema file was
  considered and not adopted: `scripts/schemas.test.ts` enforces the envelope uniformly across
  every schema, and a cross-file `$ref` would force every consumer to preload schemas.
- `parley.receipt.head` requires `tool` and `v` (§5 MUST list), so a receipt read on its own says
  what wrote it and `inv` can be recomputed. (flyingrobots/parley#14)
- `schemas/README.md` lists each schema and its current version. (flyingrobots/parley#9)
- §5.3 redaction rule: secrets are declared in the command description's `secrets` list (§4.3);
  their values are replaced with `[redacted]` before the head is written; the head's new
  `redacted` field records argv indexes, resolved JSON Pointers, input indexes and env names and is
  present whenever a declared secret was supplied. §2.2: `inv` never incorporates a declared secret, so a receipt
  is not an oracle for it; §2.3 and §5.3: a redacted receipt is never replayed from or served
  from cache. (flyingrobots/parley#13)
- §4.5: a schema version still under `Unreleased` is a draft and may change in place. The
  constraint additions above therefore stay at `parley.error` `2.0.0`, `parley.receipt.head`
  `2.0.0` and `parley.run.bootstrap` `1.1.1`.
- §3: the bootstrap line is written to stdout only. §4.6: a reader with no schema for an id must
  not validate the line against another schema. Checker docs explain exact-version resolution and
  that the checker is not a parley program. (flyingrobots/parley#26)

### Fixed

- The README bootstrap example emitted a top-level `receipt`; the schema requires
  `paths.receipt`. (flyingrobots/parley#5)

## [0.1.0] — 2026-11-22

### Added

- The parley v0.1 specification: JSON Lines by default, versioned per-message schemas,
  content-addressed invocation identity, the bootstrap line, durable receipts, structured errors,
  the optional shared history stream, and task-oriented reads.
- JSON Schemas for `parley.run.bootstrap`, `parley.error` and `parley.receipt.head`.
