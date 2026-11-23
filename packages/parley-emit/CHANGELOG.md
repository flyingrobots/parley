# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This package is versioned
on its own; the spec and each message schema move separately (spec §4.4).

## [Unreleased]

### Added

- **A built-in that refuses a suspected secret** (flyingrobots/parley#60). `refuseSuspectedSecrets(patterns?)`
  is a history transform that withholds any line whose body matches one of ten documented token
  shapes, and raises one `history.suspected_secret` warning naming the withheld `seq`, the shape
  and a JSON Pointer — never the matched text.

  ```ts
  await main(tool, argv, handler, { history: { transform: refuseSuspectedSecrets() } });
  ```

  It refuses; it never rewrites. A false positive costs one withheld stream line and never a
  changed value in the receipt. The shapes ship as data in `src/transforms/secret-patterns.ts`,
  each with a name, a regex source and one line of rationale: AWS access key ids, GitHub tokens of
  six prefixes, GitHub fine-grained PATs, Slack tokens, Google API keys, PEM private-key headers,
  JWTs, `Bearer` values, npm tokens and Stripe live keys. Every one is anchored and length-bounded,
  every one has a positive and a negative sample, and the test walks the shipped list, so a new
  entry without samples fails. String values are scanned recursively; the five envelope fields are
  not, and neither are object keys. The limits are stated in the README: an unlisted shape passes,
  a token split across two values passes, a token used as a key passes, and a legitimate value that
  matches is withheld. The head is not exempt and is the likeliest line to match, because it echoes
  `argv` and `resolved` (§5): an undeclared token on the command line withholds the whole head, so
  that stream copy has no head and the gap is reported like any other. The warning names a JSON
  Pointer only when the pointer does not itself match a shape, since a pointer is built from the
  record's keys and a key can be a token too. The exit status never moves (§6.1).

  New exports: `refuseSuspectedSecrets`, `findSuspectedSecret`, `SUSPECTED_SECRET_CODE`,
  `SECRET_PATTERNS`, the types `SecretPattern` and `SuspectedSecret`.

- **A transform may refuse, not only withhold** (flyingrobots/parley#60). `refuse(code, problem, remedy?)`
  returns a typed refusal: the writer withholds the line and raises one warning carrying that
  `code`, `problem` and `remedy`, on stderr and in the receipt, leaving the exit status alone. The
  four enforcement rules of flyingrobots/parley#57 are unchanged, and the writer still owns the
  namespace: a `code` that is not spec §6's shape, or an empty `problem`, is
  `history.transform_failed`, and a `code` carrying a declared secret value is
  `history.transform_unredacted`, because a diagnostic's `code` is the one string §5.3 does not
  scrub. `HistoryTransform` widens to allow a `HistoryRefusal` return; returning a record or
  nothing behaves exactly as before. New exports: `refuse`, `isHistoryRefusal` and the type
  `HistoryRefusal`.

- **A user-defined transform on the history sink** (flyingrobots/parley#57). The stream copy of a
  run can be a projection of the receipt copy rather than the whole of it. Configure it in code:

  ```ts
  await main(tool, argv, handler, { history: { transform, name: "drop-step-detail" } });
  ```

  `MainOptions.history` now takes a sink, `null`, or `{ sink?, transform?, name? }`; the two older
  forms behave exactly as before. The transform is handed the parsed record the receipt already
  holds — redacted, as §5.3 left it — and returns a record to put on the stream or nothing to
  withhold the line. There is no environment variable naming a module to execute, deliberately.

  The writer enforces the contract around it, so nothing the transform does can put an invalid
  line or a changed envelope on the shared timeline: `event`, `t`, `seq`, `run` and `_schema` are
  taken off whatever it returns and the receipt line's are put back (§1.3); the returned body is
  re-validated against the schema for its exact advertised pair (§4.5), this package's drafts plus
  the schema the tool declared on the emitted or error type (§4.2); and four conditions withhold
  the line and raise one warning naming the withheld `seq`, on stderr and in the receipt, without
  touching the exit status (§6.1): `history.transform_failed` (it threw),
  `history.transform_invalid` (the body no longer validates), `history.transform_unredacted` (the
  body carries a declared secret value the writer had already replaced) and
  `history.transform_uncheckable` (no schema document for the exact pair, or one outside the
  subset the checker implements).

  The stream copy of a projected run opens with a **`parley.history.transform` 1.0.0** line naming
  the transform and the SHA-256 of its source text as the runtime renders it. It reaches the
  stream alone, so it takes a `seq` the receipt has no line at, and the receipt accounts for that
  gap as a `receipt.step`. A run with no transform configured has no opening line, no step and no
  difference in any byte; a transform with no stream configured is equally inert.

  New: `src/check.ts` with `checkRecord` and `schemaSubsetGap`, a bounded JSON Schema checker — this package has no
  runtime dependencies, so re-validation is implemented here for the constructs the protocol's own
  schemas use, and it reports a keyword it does not implement instead of ignoring it. The subset
  check walks the whole schema document before any record is checked, so a construct nested under
  a property that record happens not to carry cannot slip past; a test asserts every shipped draft
  is inside the subset. New exports from `src/history.ts`:
  `historyProjection`, `transformDigest`, `transformName`, `isHistorySink`, and the types
  `HistoryTransform`, `HistoryConfig`, `HistoryProjection`. `Run` grows `declareProjection`,
  `noteProjection` and `withheldFromHistory`.

  Three decisions the README states under its own heading so the owner can overrule each: a line
  the writer cannot re-validate is withheld rather than passed through; the receipt records the
  `seq` the opening line took; and a transform may withhold `end`, so a copy on the stream can
  end without one.

- `src/schemas.ts` re-synced from the repository drafts: the package now ships seventeen, adding
  `parley.history.transform` 1.0.0, so `--schema` serves it like any other writer-owned type.

- **`declaredProjection(values)`, a built-in history transform** (flyingrobots/parley#59): the
  same §5.3 scrubber the receipt's own redaction uses, applied to the stream copy's body with a
  second declared set — longest value first, keys renamed, the envelope never touched, nor the
  writer's own identity scalars (`DIGEST_KEYS`, now exported from `src/run.ts`) on a writer-built
  record it might also be handed — found in self-review: without it, a declared value that
  coincided with the tool's own name would silently rename `tool` on the stream's head, since that
  field carries no pattern a validator would reject a corrupted value by. An empty declared set
  returns `undefined` rather than an identity function, so no `parley.history.transform` line is
  ever written for it; the transform's name on the stream is always the literal
  `declaredProjection` and its digest never discloses what was declared, since the digest is of
  the function's source text and the values only ever reach it as a closed-over variable. New
  export from `src/transforms/declared.ts`, re-exported from `src/index.ts`.

- The shared history stream (spec §8, informative): an opt-in second sink that receives the bytes
  of the local receipt, so one timeline spans tools, repositories, agents and people. Opt in with
  `PARLEY_HISTORY` naming a directory, or by creating `$XDG_STATE_HOME/parley/history` once;
  `PARLEY_HISTORY=off` switches it off even then. A run with no stream configured is unchanged in
  every byte: no `paths.history` on the bootstrap line, no history bookkeeping on the head, no
  file, no warning, no difference in exit status. New exports in `src/history.ts`:
  `resolveHistory`, `openHistory`, `isHistoryFailure`, `writeWholeLine`, `retainHistory`,
  `historyBookkeeping`, `segmentName`, `historyDays`, `HISTORY_ENV`, `HISTORY_DAYS_ENV`,
  `HISTORY_DEFAULT_DAYS`; `MainOptions.history` takes a sink or `null` beside `stdout` and
  `stderr`. No message schema moves and no message type is added: `paths` is already open and
  documents that a program may add paths of its own, and segment retention is recorded with
  `parley.receipt.step`. (flyingrobots/parley#3)

  The two decisions flyingrobots/parley#3 left open, implemented behind a recommendation the
  package README states under its own heading so the owner can overrule either:

  - **Scope and expiry.** One stream per user per machine, written as dated daily segments
    (`2026-11-22.jsonl`, UTC), keeping `PARLEY_HISTORY_DAYS` of them, today's included, default
    14. Expiry unlinks whole segments and never rewrites, because an append-only file with
    concurrent writers cannot be rewritten safely; with `days` at least 1 today's segment is
    never a candidate. Recorded as a `receipt.step`, skipped on `--dry-run`.
  - **Redaction.** None of the stream's own. The sink is handed the same string the receipt was
    handed, after §5.3 has replaced every declared secret, so a credential cannot reach the
    stream unless it reached the receipt first. Reach is protected instead of content: the
    directory is `0700`, segments are `0600`, a record stored as a sidecar reaches the stream as
    its `sidecar` event and never as its stored bytes, and nothing is sent anywhere. An
    undeclared secret is as exposed in the stream as in the receipt, for longer, which the README
    says plainly.

  Appending is `O_APPEND` with one whole line per write, so concurrent writers cannot split each
  other's lines; a write that reports fewer bytes is abandoned rather than continued, since
  continuing would interleave. A stream that cannot be opened is one `history.unavailable`
  warning and a failed append is one `history.write_failed` warning: never an error, never a sink
  failure, never a different exit status, because the dependency runs one way.

  The stream's own path gets the rule the receipt's path already had: one carrying a declared
  secret value is never chosen, since the bootstrap line prints it. The receipt has nowhere else
  to go and fails startup; the stream yields with one `history.unavailable` warning and the run
  carries on without it. The literal field name `history` is checked the same way, because a
  secret that is a substring of it would rename the key the line prints.

  `PARLEY_HISTORY_DAYS` is an integer from 1 to `HISTORY_MAX_DAYS` (36,500); anything else falls
  back to 14. A window wide enough that its own start date is not a date would have thrown out of
  `main` after the head was written, where nothing could catch it, and a retention window is not
  worth failing a run over.

### Changed

- The `code` of a diagnostic **the writer itself raises** is no longer scrubbed. It is the
  writer's own stable identifier, like a schema id or a command's name, and replacing part of it
  put a line on the stream that no longer validated against `parley.warning` or `parley.error` —
  which is the one thing redaction must not do. `receipt.relocated`, `human.renderer_failed`,
  `sink.write_failed`, `sink.sidecar_failed` and the two `history.*` warnings are affected; a
  tool's own `run.warning` and `run.error` are not writer-built and their `code` is scrubbed
  exactly as before. `startup.failed` already behaved this way, scrubbing only its `problem`.
  Found by review of flyingrobots/parley#3, where a secret that is a substring of `history`
  reached it. (flyingrobots/parley#3)

- `src/schemas.ts` re-synced from the repository drafts: the package now ships sixteen, adding
  `parley.query` 1.0.0 and `parley.lens` 1.0.0 for the reader's query record and result lens
  (flyingrobots/parley#46). `--schema` serves the drafts at the newly pinned commit; this moves no
  schema version and no package version of its own (spec §4.5).

## [0.1.0] — 2026-11-22

The schemas this version ships are the repository drafts at the commit recorded in
`src/schemas.ts`; no schema version is released by this package release (spec §4.5).

### Added

- `defineTool` and `main`: a tool declares its commands, effects, secrets, emitted types and
  retention; `main` turns argv and a handler into a conforming run and returns the exit status.
- `Run`: `result`, `page`, `step`, `warning`, `error`, `input`, `finaliseInputs`, `end`; one
  sequence across stdout, stderr and the receipt; sidecars over 65,536 bytes; redaction of declared
  secrets with `redaction` events; `ParleyClosed` after `end`.
- Receipt location with repository hygiene and the state-directory fallback; retention by count;
  `--dry-run`; `--schema` and `--help` as runs; `--human`; console capture; the top-level handler.
- `inv` as documented in the README; `ulid` run ids.
- The fourteen draft schemas at the pinned commit, with a test that they match the repository.

### Changed

- After the review of the first candidate: declared secrets of every command count on every path,
  the `end` record is scrubbed, the envelope and digests never are, and a run id or receipt path
  that would carry a secret is never chosen; the `inv` preimage takes redacted input descriptors;
  a throw before the bootstrap line is `startup.arguments_invalid`; the head is never a sidecar
  and a bootstrap sink failure is reported after it; a sidecar failure keeps the receipt usable;
  envelope keys from the tool are refused; `end(0)` after an error is refused; retention deletes
  only completed bundles; every `console` function is captured; tree inputs skip `.parley` and
  honour `exclude`; absolute input paths resolve; the ignore file is linked into place whole; the
  state directory's retention is declared; console capture starts before the tool's resolvers run;
  a failing renderer is one warning; a throw during discovery is an error line; an uncaught
  throw's stack stays in the receipt; a failed `end` in `--human` mode names the receipt. From the
  blind pass over the repaired head: the default descriptor sinks retry a full pipe and continue a
  partial write; numbers, booleans and object keys are redacted; the longest secret is replaced
  first, and the writer's own scalars and the public identity in writer-built records (tool, command and schema names and versions, discovery lines included) are never scrubbed; a secret in the
  session is `startup.secret_in_identity`; a sidecar that cannot be written is kept inline.
