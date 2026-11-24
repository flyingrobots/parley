# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This package is versioned
on its own; the spec and each message schema move separately (spec §4.4).

## [Unreleased]

## [0.4.0] — 2026-11-24

The writer no longer publishes a record that redaction made invalid under its declared schema
(flyingrobots/parley#131, spec §5.3). **A run that used to end with status 0 and an invalid line
now ends with status 4 and a structured error**, which is the point of the change.

The schemas it ships are released: `parley.query` and `parley.lens` are the 1.1.0 that spec
`0.2.1` released (the root `CHANGELOG.md`), in place of 1.0.0, pinned to the commit of that release.
The writer stamps neither message, so no emitted line changes.

### Fixed

- **A record redaction made invalid is never published.** When a result's integer field equalled
  a declared secret, the writer replaced it with the string `[redacted]`, published the record
  under its original schema and ended with status 0; a string field with a `pattern`, an `enum`,
  a `format` or a length bound broke the same way, and so did a tool's own `error` whose `code` or
  typed field the secret landed in. A tool's record in which the scrub replaced something is now
  validated, as stdout or stderr and the receipt would each receive it (`receiptExtra` included),
  against the schema document for its declared pair, before any copy is written and before a
  `seq` is taken. When the redaction made it invalid, nothing of the record is written anywhere
  and the counter has no gap. The writer emits one `error` with the code
  `redaction.schema_conflict`, whose `problem` and `detail` (`{schema: {id, version}, at,
  redacted}`) name each field by JSON Pointer and the schema pair. It carries no value, no text
  from the checker and no part of the schema. The call throws `ParleyRedactionConflict`, which
  `main` does not report a second time, and the run ends with status 4 whatever the handler
  passes to `end`, by the mechanism a sink failure uses.
- **A record redaction changed, under a schema the writer holds and cannot evaluate, is withheld
  too** (spec §5.3, decided on flyingrobots/parley#144). A declared schema document that uses any
  keyword outside the bounded checker (`format: "date-time"`, `multipleOf`, `uniqueItems`, a
  `$ref`, even an empty `$defs`) made the writer skip the check and publish the redacted record
  with status 0. The writer cannot show such a record is valid, so it now withholds it exactly as
  it withholds a conflict: nothing is written, no `seq` is taken, one `error` with the code
  `redaction.schema_unchecked` and `detail` `{schema: {id, version}, redacted}` is reported, the
  call throws `ParleyRedactionUnchecked` and the run ends with status 4. The construct the
  checker could not evaluate is part of the schema, so it is on the exception (`construct`) and
  never on the line. A tool that meets this keeps declared secrets out of records of that type,
  or states the type's schema within the checker's subset.
- Scope, stated: only a record the scrub changed is checked. A record that was already
  invalid in the same way and a record of a type declared with no `schema` document, which spec
  §5.3 exempts, are written as before. Writer-built records (the head, `end`,
  `redaction`, `sidecar`, `receipt.inputs`, discovery lines and the writer's own diagnostics) are
  never checked: their scalars are not scrubbed and their identity fields are skipped.
- `run.error` marks the run as having reported an error once the line is out, not before, so an
  error the writer refused does not count as reported.

### Added

- `ParleyRedactionConflict` (with `schema` and `pointers`), `REDACTION_CONFLICT_CODE` and
  `run.redactionRefused`.
- `ParleyRedactionUnchecked`, a `ParleyRedactionConflict` with empty `pointers`, `redacted` and
  `construct`, and `REDACTION_UNCHECKED_CODE`.
- `checkRecord` returns `pointers` beside `errors` when a record fails: the JSON Pointer of each
  error, in the same order, and for a missing or disallowed property, that property. A key
  containing `/` or `~` is now escaped in the path an error names (RFC 6901).

### Changed

- `src/schemas.ts` holds `parley.query` 1.1.0 and `parley.lens` 1.1.0 (flyingrobots/parley#133),
  as released with spec `0.2.1`, in place of 1.0.0. The writer stamps neither message, so no
  emitted line changes.

## [0.3.0] — 2026-11-24

A declared file input can be read through the run, so the receipt records the bytes the tool read
(flyingrobots/parley#132), and a `receiptExtra` field can no longer contradict the record
(flyingrobots/parley#130). No change to the spec or to the schemas the package ships.

### Added

- **`run.readInput(path)`**. It reads a declared file input, returns the bytes as a `Buffer`, and
  records the SHA-256 of exactly those bytes, taken at the read. `receipt.inputs` and `inv` then
  describe what the tool consumed, whatever the file holds when the run ends. The path is resolved
  as the declaration is, against the run's `cwd` when relative. A file that cannot be read is
  recorded as `run.inputUnreadable` records it, and the file system's error is thrown. It throws
  `TypeError` for a path that is not a declared input, for a `stdin` or `tree` input, and after
  the inputs are settled.

### Changed

- The README and the living reference present `run.readInput` as the way to read a declared file
  input, with a captured run of a tool that edits its input in place.

### Fixed

- A tool that reads a declared file and then rewrites it had no single step that recorded the
  bytes it read: the writer digested the file when the handler finished, so the receipt and `inv`
  described the rewritten file. `run.readInput` is that step. **The default path is unchanged**: a
  declared file the tool does not read through the writer, and does not supply with `run.input`,
  is still digested when the inputs are finalised, and can describe bytes the tool did not read.
  The documentation now says so. A tool gets the fix by calling `run.readInput`.
- **A `receiptExtra` field can no longer contradict the record** (flyingrobots/parley#130).
  `run.result({ value: 1 }, schema, { value: 2 })` used to put `1` on stdout and `2` in the
  receipt under one `seq`, against spec §1.3 (copies agree on every field they share). The call now
  throws `TypeError` before either copy is written. Equal shared values are accepted and written
  from the record; receipt-only fields are unchanged. **BREAKING for a tool that relied on the
  overwrite**, which was already non-conforming.

## [0.2.4] — 2026-11-23

No change to the library or the schemas it ships.

### Fixed

- The release workflow's `sanity` job installs the pinned Wesley, as the checks workflow does. The
  suite fails under CI without it (flyingrobots/parley#118), so the `parley-emit-v0.2.3` tag
  stopped at `sanity` and nothing was released or staged. This is the first version staged on npm.

## [0.2.3] — 2026-11-23

No change to the library or the schemas it ships. This version exists so that a tag carries the
new release workflow.

### Changed

- **Releases are staged, then approved by the owner** (flyingrobots/parley#85). The release
  workflow runs `npm stage publish` in place of `npm publish`: the npm trusted publisher is allowed
  to stage and nothing else, and a version becomes installable only when the owner approves it with
  two-factor authentication. 0.2.0, 0.2.1 and 0.2.2 never reached npm for that reason.

## [0.2.2] — 2026-11-22

Retention's rule for a receipt that may still be being written is now the spec's (§5.1,
flyingrobots/parley#112). The behaviour and the schemas it ships are unchanged.

### Changed

- **No lock protocol: an incomplete receipt is exempt from retention until it has gone unmodified
  for 24 hours.** This is the decision on flyingrobots/parley#112. A receipt whose last line is not
  `end` is kept, and a complete receipt is deleted in its place. Past 24 hours with no write, its
  run is treated as crashed. A complete receipt cannot be appended to (§3.3), so deleting it races
  no writer. The window that remains is accepted: a run silent for over a day that appends while
  retention deletes its receipt loses it. New injected-clock tests pin each case (PE-16d to PE-16f).

## [0.2.1] — 2026-11-22

Fixes for findings raised on the vendored Python writer in flyingrobots/taskalisk#71 that hold for
this writer too. The schemas it ships are unchanged.

### Added

- **`run.inputUnreadable(path, code?)`** (flyingrobots/parley#110). It records that the program
  could not read a declared input, as `{"path", "error": "input.unreadable"}` with no digest, so
  `inv` is omitted as spec §2.2 requires. Before this, the writer read the path itself at
  finalisation, so a file that appeared after the program failed to read it got a digest and an
  `inv` for bytes the program never saw. It throws for a path that is not a declared input and
  after the inputs are settled; `run.input` after it supplies bytes again.

### Fixed

- **A `.parley/.gitignore` negation that can re-include `receipts/` sends the receipt to the state
  directory** (flyingrobots/parley#109, spec §5.2). A file of `*`, `!receipts/` and `!receipts/**`
  used to be accepted, and its receipts were left where `git add` stages them. The
  `receipt.relocated` warning names the negation. A pattern the check cannot evaluate (an inner
  `/`, a backslash) is taken to match, and a negation that cannot match, such as `!keep`, still
  stores in the repository.
- **`--schema` and `--help` publish schema documents as declared** (flyingrobots/parley#111, spec
  §5.3). A declared secret whose value occurred in a document, such as `object`, used to rewrite it
  (`"type": "[redacted]"`) under the original `id` and `version`. Every other discovery field is
  still scrubbed.
- **Retention re-reads a receipt's age at the decision** (flyingrobots/parley#112). It used the
  mtime from the directory scan, so a receipt silent for over a day whose run appended after the
  scan could be deleted. The writer now skips the unlink when the receipt's size or mtime moved
  since the decision. This narrows the window without closing it; the issue stays open for a lock.

## [0.2.0] — 2026-11-22

The schemas this version ships are the released versions of the repository's first schema release,
spec `0.2.0` in the root `CHANGELOG.md`, byte for byte (`src/schemas.ts` records the commit and
each digest); no schema version is released by this package release (spec §4.5).

**Upgrading from 0.1.0**, the three changes marked BREAKING below, in brief: the command is now
the first argument once the writer's flags are set aside, so a flag before the command is
`startup.unknown_command`; `--` now ends the writer's flags and is removed; and `<command> --help`
now lists `parley.startup.failed@1.0.0` beside `parley.error@2.0.0`.

### Changed

- **BREAKING for a caller that puts a writer flag after `--`: `--` now ends the writer's flags**
  (flyingrobots/parley#103). The writer used to remove every argument equal to one of its own
  flags (`--human`, `--humanize`, `--dry-run`, `--schema`, `--help`, `-h`) wherever it stood, so a
  tool flag whose value had one of those texts lost it and switched the writer's behaviour
  (`edit --note -h` became `--help` discovery and the tool never saw `-h`). Now the writer's flags
  are recognised only before the first `--`; that `--` is removed and every argument after it
  reaches `resolved`, `inputs` and the handler untouched, so `edit -- --note -h` gives the tool
  `["--note", "-h"]`. Before a `--` nothing changes: `edit --note -h` is still discovery, by a
  stated rule. A `--` used to reach the tool; the first one no longer does, and `edit -- --dry-run`
  is no longer a dry run. Nothing after `--` is ever the command. The Python writer follows the
  same rule.
- **BREAKING for a caller that names a flag before the command: the command is now the first
  argument once the writer's flags are set aside, and only that one argument is removed**
  (flyingrobots/parley#101). The writer used to take the first argument anywhere that named a
  command and remove every argument with the command's text, so a flag value equal to a command
  name was lost (`edit --reason edit` gave the tool `["--reason"]`) or chosen as the command
  (`--reason plan edit` ran `plan`). Now `edit --reason edit` gives `["--reason", "edit"]`, and in
  a tool with more than one command a first argument that names none is
  `startup.unknown_command`, exit 3, so `--verbose edit` must be written `edit --verbose`. The
  writer's own flags are still recognised anywhere before the first `--` (flyingrobots/parley#103).
  A tool with one command may still omit its name. The Python writer follows the same rule.
- **BREAKING for a consumer that pins its discovery output: `<command> --help` now lists
  `parley.startup.failed@1.0.0` beside `parley.error@2.0.0`** (flyingrobots/parley#92, spec §4.2).
  A command that declares no `errors` now has the default `[parley.error, parley.startup.failed]`,
  so its `command` line's `emits` and its `schema` lines gain one entry each, after
  `parley.error`. Every command can produce a startup failure, and §4.2 asks `--help` for every
  error type a call can produce. The Python writer already did this. `--schema` already listed the
  type and is unchanged. A command that declares `errors` still replaces the default, so name both
  types in that list. No line shape and no schema version moved, but a test that pins the exact
  list of `--help` schemas, as `flyingrobots/footprint`'s OUT-10b does, fails on upgrade until its
  expectation gains the new entry.
- `examples/count.ts` checks its arguments in `resolved`, before the bootstrap line, so an argument
  it does not take is `startup.arguments_invalid`, exit 3, with no receipt. This is the spec's
  preferred side of the boundary decided on flyingrobots/parley#91 (§3.2), and it is what
  `count.py` does. A call with no arguments resolves exactly as before, so its `inv` is unchanged.
- `src/schemas.ts` re-synced for a change to the draft `parley.lens` 1.0.0: an optional `runs`
  section, and `code` in place of `outcome` on each named record (flyingrobots/parley#83). The
  writer's behaviour is unchanged and no version moved; discovery serves the updated draft.
- `src/schemas.ts` re-synced for a change to the draft `parley.lens` 1.0.0: optional `event`, `t`
  and `outcome` on each named record (flyingrobots/parley#77). The writer's behaviour is unchanged
  and no version moved; discovery serves the updated draft.
- `src/schemas.ts` re-synced for a change to the draft `parley.query` 1.0.0: an optional `records`
  field for a drill-down (flyingrobots/parley#51). The writer's behaviour is unchanged and no
  version moved; discovery serves the updated draft.

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

### Fixed

- Retention counts and expires only this tool's receipts (flyingrobots/parley#75): a bundle is
  this tool's when its first line is a `receipt.head` naming it. Other tools' receipts, a
  reader's included, are never counted or deleted, and an unreadable or headless file is left
  alone. Behaviour change for a directory shared with a reader: the tool now keeps `count` of its
  own receipts rather than `count` in all. The decision's text says "of this tool's receipts".

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
