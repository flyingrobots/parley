# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The spec and each message schema are versioned separately from this package.

## [Unreleased]

### Added

- `packages/parley-emit`: the writer library `@flyingrobots/parley-emit` 0.1.0, a Bun workspace
  package. A tool conforms by constructing a writer and emitting through it. Its own changelog
  lives beside it; the repository's `bun test` runs its suite, every case using the doctor as the
  oracle, and `bun run typecheck` checks it strictly. (flyingrobots/parley#1)

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

### Added

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

### Fixed

- The README bootstrap example emitted a top-level `receipt`; the schema requires
  `paths.receipt`. (flyingrobots/parley#5)

## [0.1.0] — 2026-11-22

### Added

- The parley v0.1 specification: JSON Lines by default, versioned per-message schemas,
  content-addressed invocation identity, the bootstrap line, durable receipts, structured errors,
  the optional shared history stream, and task-oriented reads.
- JSON Schemas for `parley.run.bootstrap`, `parley.error` and `parley.receipt.head`.
