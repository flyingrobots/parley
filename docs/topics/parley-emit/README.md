# parley-emit

The writer library: `@flyingrobots/parley-emit`, under `packages/parley-emit`. A tool conforms to
the [specification](../../../spec/parley-vous-v0.3.md) by constructing a writer and emitting through
it. This page is the reference for what the package does on `main`; the package
[README](../../../packages/parley-emit/README.md) is the front door with a captured run, and the
[test plan](test-plan.md) beside this page is the contract ledger.

## Surface

| Export | Job |
| --- | --- |
| `defineTool(spec)` | Checks a tool's declaration for the things the writer needs: a non-empty name and version, at least one command, an intent per command, a SemVer version on every emitted type, and a positive retention count. Effects, secrets, error types, source resolvers and the `--human` renderer are carried as declared |
| `main(spec, argv, handler, options)` | Parses the writer-owned flags (`--human`, `--humanize`, `--dry-run`, `--schema`, `--help`, `-h`) before the first `--`, which ends them (flyingrobots/parley#103), chooses the receipt location, opens the shared history stream when one is configured, resolves declared sources, redacts, bootstraps, writes the head, enforces retention, runs the handler under the top-level handler, closes with `end`, returns the exit status |
| `Run` | `result`, `page`, `step`, `warning`, `error`, `readInput`, `input`, `inputUnreadable`, `finaliseInputs`, `end`; `receiptPath`, `cwd`, `dryRun`, `ended`, `status`, `sinkFailed`, `redactionRefused` |
| `ParleyRedactionConflict`, `REDACTION_CONFLICT_CODE` | The error an emission throws when redaction made its record invalid under its declared schema, and the code of the `error` line the writer emits for it |
| `ParleyRedactionUnchecked`, `REDACTION_UNCHECKED_CODE` | The error an emission throws when redaction changed its record and the writer holds a schema document for the pair that it cannot evaluate, and the code of that `error` line. It is a `ParleyRedactionConflict` |
| `SCHEMAS`, `SCHEMA_SOURCE` | The seventeen schemas the package ships, each at its current released version (the root `CHANGELOG.md`'s release headings), with the commit and digest of each |
| `computeInv`, `canonical`, `digestTree`, `sha256` | The documented `inv` derivation and its parts |
| `chooseLocation`, `repoRoot`, `stateBase`, `bookkeepingFor` | Receipt placement and the bookkeeping a run declares |
| `resolveHistory`, `openHistory`, `isHistoryFailure`, `writeWholeLine`, `retainHistory`, `historyBookkeeping`, `segmentName`, `historyDays` | The shared history stream of spec §8: where it is, opening a segment, the whole-line append, segment retention, and the bookkeeping a run with a stream declares |
| `historyProjection`, `transformDigest`, `transformName`, `isHistorySink` | The projection a configured transform applies to the stream copy: its name, the digest of its source, and which form `MainOptions.history` was given |
| `declaredProjection(values)` | A built-in transform: the writer's own §5.3 scrubber applied to the stream copy's body with a second declared set; `undefined` for an empty set, so no transform is configured at all |
| `refuseSuspectedSecrets`, `findSuspectedSecret`, `SECRET_PATTERNS`, `refuse`, `isHistoryRefusal` | The built-in transform that withholds a line whose body matches one of ten documented token shapes, the shapes themselves as data, and the typed refusal a transform returns to withhold a line under a code of its own |
| `checkRecord` | The bounded JSON Schema check the writer re-validates a projected line and a redacted record with, in a package with no runtime dependencies. A failing result carries `errors` and, in the same order, the JSON Pointer of each in `pointers` |
| `parseExact`, `exactJson`, `holdsExact`, `MAX_EXACT_DIGITS`, `UNREPRESENTABLE` | The exact parser and serialiser ([below](#numbers)): JSON text read with every number's value kept or named as one that could not be, and a value written with a `bigint` as exact digits. The writer owns them; the reader imports them |
| `classifySecrets`, `collectSecretValues`, `redactArgv`, `scrub` | Redaction |
| `ulid` | Run ids |

## Lifecycle, as the writer performs it

1. Classify the declared secrets of every command into flags, variables and logical sources;
   collect the values flags and variables carry from `argv` and the environment; call the selected
   command's source resolvers, and never another command's (spec §5.3, flyingrobots/parley#93); a resolver that throws means not present. Choose a run
   id that carries none of those values; a session that carries one is
   `startup.secret_in_identity`, exit 3; the tool's name and version are public and printed as
   they are.
2. Reserve the receipt: `.parley/.gitignore` with a line `*`, created whole and linked into
   place if absent; then `.parley/receipts/<run>.jsonl` opened exclusively. On a user's ignore
   file (one without `*`, or with a negation that can re-include `receipts/`,
   flyingrobots/parley#109; a negation the writer cannot evaluate exactly counts as one, as
   `negationReachesReceipts` in `src/location.ts` states: an inner `/`, a backslash, a character
   outside printable ASCII, a bracket expression that is unterminated or holds `[:`, `[=` or
   `[.`, or a line holding a NUL byte), a working-directory path carrying a secret value, an unwritable directory or
   a failed reservation, the state directory keyed by a digest of the repository root. With
   neither, one `startup.failed` line on stderr (`startup.receipt_unwritable`, or
   `startup.secret_in_path` when the state path would carry the secret too) and exit 3 (§3.2, §5,
   §5.2, §5.3). A throw from the tool's `resolved` or `inputs` callback here is
   `startup.arguments_invalid`, exit 3, and the reservation is removed. This is the side of the
   §3.2 boundary a tool checks its arguments on when it checks them in `resolved`; one that
   reports a bad argument from the handler with `run.error` makes it a command error, exit 2,
   with a complete failed receipt (flyingrobots/parley#91). `examples/count.ts` checks in
   `resolved`.
3. Resolve the shared history stream (§8): the directory `PARLEY_HISTORY` names, or the known
   state path `$XDG_STATE_HOME/parley/history` when it already exists, and open the day's
   segment for appending. With neither, or with `PARLEY_HISTORY` switched off, there is no
   stream and nothing below mentions one.
4. Emit the bootstrap line to stdout at `seq: 0`, carrying `inv` only when no inputs are
   declared and `paths.history` only when a stream was opened, then the head to the receipt at
   `seq: 1` with the redacted `argv`, the redacted `resolved`, a descriptor per declared input,
   `effects` with bookkeeping (the stream's `create`, `append` and `delete` scopes included when
   there is one), and `redacted` when any declared secret was supplied (§3.1, §5).
5. Report a bootstrap write failure now that the head is in place; warn if the receipt was
   relocated or the stream could not be opened; enforce retention by count unless `--dry-run`,
   deleting only bundles whose receipt ends with `end` or that are incomplete and unmodified for
   more than a day (no lock: a run silent that long is treated as crashed, flyingrobots/parley#112),
   and expire the stream's segments by age; record each decision as a step
   (§5, §5.1, §4.3, §8).
6. Discovery: emit `command` lines and `schema` lines, then `end` (§4.1, §4.2); a command that
   declares no `errors` lists `parley.error` and `parley.startup.failed` (flyingrobots/parley#92);
   a throw while emitting them is an `error` line and the run still ends. Otherwise run the handler. Every
   `console` function is captured into the receipt from the start of `main`, buffered until the
   head exists; direct descriptor writes and timers after `end` are the named exceptions.
7. An uncaught throw becomes `error` with code `uncaught.exception`, its stack in the receipt copy
   only (§6). The line is writer-built, so no declared secret can have it withheld. `main` never
   rejects once the receipt is reserved: a failure of the writer's own after that is
   `uncaught.writer_failure` and status 2, and if the report of a failure cannot itself be built
   or written, the run still ends, with status 4, because an error that could not be written is
   protocol output that could not be written (§3.3, §3.4, flyingrobots/parley#161). `end` digests the
   declared inputs, with redacted descriptors in the preimage, and emits `receipt.inputs` with
   `inv` if not already done, then writes `end` to stdout and the receipt as one event and closes
   the file. Status: the one given (`0` refused after a reported error), else 2 if an error was
   reported, else 0; 4 if any sink or sidecar failed, or a record was withheld because redaction
   made it invalid (§3.3, §3.4, §5.4, §5.3). Every record's payload is
   scrubbed of declared secrets before any copy is written, within strings, in numbers and
   booleans whose decimal form is a secret, and in object keys; the envelope never is. What is
   scrubbed is what is written: a value with a `toJSON` hook (a `Date`, a `URL`) is scrubbed as
   what the hook returns, applied once, and a boxed primitive as its primitive
   (flyingrobots/parley#178). The payload is read once for this, the refusal and every sink:
   one snapshot, taken before a `seq`. A `toJSON` on `BigInt.prototype` is never asked, so a
   `bigint` is its digits whatever the process has installed. What is recognised is the value
   inside one string, as a scalar's decimal form, or inside a key: not the value split, parsed
   into parts, re-encoded, hashed or truncated, which is the tool's to keep out. The default
   descriptor sinks retry a full pipe and continue a partial write; a sidecar that cannot be
   written is kept inline.

## Declared file inputs

`run.readInput(path)` is the way a handler reads a declared file input. It reads the file at the
declared path, resolved against the run's `cwd` when relative, returns the bytes, and records
their SHA-256 at that moment. `receipt.inputs` carries that digest for the input, and `inv` is
derived from it, whatever the file holds when the run ends. The package
[README](../../../packages/parley-emit/README.md#read-a-declared-file-with-runreadinput) has a
captured run of a tool that edits its input in place.

A declared file that was not read through the writer, and whose bytes were not supplied with
`run.input(path, bytes)`, is read by the writer when the inputs are finalised: at
`run.finaliseInputs()`, or at `end` once the handler has finished. The digest recorded is of the
file as it is then. For a tool that read the file by its own means and then rewrote it, or a file
something else changed during the run, that digest and `inv` describe bytes the tool did not
read. The run still exits 0, and the writer gives no warning.

| The handler, for a declared file | What `receipt.inputs` records |
| --- | --- |
| calls `run.readInput(path)` | the digest of the bytes returned |
| calls `run.input(path, bytes)` | the digest of the bytes supplied |
| calls `run.inputUnreadable(path, code?)` | `error` with that code, no digest, no `inv` |
| does none of these | the digest of the file when the inputs are finalised, or `error: input.unreadable` if it cannot be read then |

The last call for a path is the record. `readInput` on a file that cannot be read records the
input as `inputUnreadable` does and throws the file system's error. It throws `TypeError` for a
path that is not a declared input, for a `stdin` or `tree` input, and after the inputs are
settled.

## The shared history stream

Spec §8, which is informative: a layer that consumes the format. On `main` the writer implements
it as a second sink, opt-in, that receives the bytes of the local receipt. A program with no
stream configured is the program that existed before the sink did.

| | |
| --- | --- |
| Opt in | `PARLEY_HISTORY=/abs/dir`, created if absent; or `$XDG_STATE_HOME/parley/history` already existing, which is checked only when `PARLEY_HISTORY` is unset |
| Opt out | `PARLEY_HISTORY` set to `off`, `0`, `false`, `no`, `none` or empty, even when the state directory exists |
| Where | One file per UTC day in that directory, `YYYY-MM-DD.jsonl`, mode `0600`; a directory the writer creates is `0700` |
| What | Every line the receipt took, in the order it took them: the head, each `receipt.step`, each `redaction` and `sidecar` event, every copy of a result, error and warning, and `end`. Not a sidecar's stored bytes |
| Announced | `paths.history` on the bootstrap line beside `paths.receipt`, and `create`, `append` and `delete` scopes in the head's `effects.bookkeeping` |
| Retention | `PARLEY_HISTORY_DAYS` daily segments, today's included, default 14; older segments are unlinked whole and the deletion is a `receipt.step`. The segment the run itself holds open is never deleted, whatever the clock read when retention ran. Never on `--dry-run`, which records what it would delete |
| Appending | `O_APPEND`, one whole line per write, so concurrent writers cannot split each other's lines. A short write is abandoned rather than continued and the stream is dropped for the rest of the run |
| Failing | An unopenable path is one `history.unavailable` warning; a failed append is one `history.write_failed` warning. Neither is an error, a sink failure or a change of exit status |
| Injecting | `MainOptions.history` takes a sink, `null`, or `{ sink?, transform?, name? }`, beside `stdout`, `stderr`, `now` and `home`. A reading of `now` that is not an integer from 0 to 2^48-1 milliseconds, or a throw, is replaced by the system clock's reading for that reading alone, without notice; the readings choose the day file and decide retention |
| Projecting | `{ history: { transform } }` narrows the stream copy and nothing else; see below. `refuseSuspectedSecrets()` is the built-in |

Two decisions the issue (flyingrobots/parley#3) left to the owner are implemented behind a
recommendation, stated in the package
[README](../../../packages/parley-emit/README.md#two-decisions-the-owner-may-overrule): scope and
expiry (one stream per user per machine, dated daily segments, retention by whole segment), and
redaction (none of the stream's own, because the stream is the receipt's bytes and a credential
cannot reach it that did not reach the receipt; owner-only permissions, no sidecar bodies and no
network instead).

### A user-defined transform on the stream copy

A sink is an observer with its own aperture. The receipt sink has the identity projection; the
shared timeline may need a narrower one, because a path, a hostname or a repository name that is
fine in a local receipt can be wrong on a stream other people and tools read. The transform is
that aperture, configured in code and never by an environment variable naming a module to
execute:

```ts
const status = await main(tool, argv, handler, {
  history: { transform: (rec) => (rec.event === "receipt.step" ? { ...rec, detail: undefined } : rec) },
});
```

It is handed the parsed record the receipt already holds and returns a record to put on the
stream, or nothing to withhold the line. The writer enforces the contract around it, so nothing
it does can put an invalid line or a changed envelope on the shared timeline:

| Rule | Behaviour |
| --- | --- |
| The envelope is the writer's | `event`, `t`, `seq`, `run` and `_schema` are taken off whatever the transform returns and the receipt line's are put back, so the two copies of one event agree on all five (§1.3) |
| The body is re-validated | Against the schema for its **exact** advertised pair (§4.5): the schemas this package ships, plus the schema the tool declared on the emitted or error type (§4.2) |
| An unverifiable line is withheld | A pair no schema document is held for, or one whose schema uses a construct `checkRecord` does not implement, is `history.transform_uncheckable`: an unchecked projection is never passed off as a checked one |
| No declared secret comes back | Each member of the returned body is compared with the receipt line's member at the same place: object members by name, array elements by index. A leaf with the same JSON text as the line's leaf there, and a member name the line's object there also has, is the line's own. The whole JSON text of the line as it would be written, envelope included, is searched for every declared value, in every spelling the writer recognises (JSON-escaped included), structure included, and an occurrence is excused only when it lies wholly inside one such leaf or name. So a field name or writer scalar equal to a secret, or a `[redacted]`, left where it was never withholds the line, and a place that held a declared value may hold only that value afterwards. Anything else withholds it: a declared value in a changed or added leaf, member or element, across several of them, across a changed piece and the text beside it, or at a joint that a dropped member or a new order made. An array element shifted to another index by an earlier one dropped counts as changed (flyingrobots/parley#205) |
| Failure is a warning, never an error | A throw is `history.transform_failed`, a body that no longer validates is `history.transform_invalid`, a body that carries a declared secret value outside the leaves and member names the transform left as the receipt line had them is `history.transform_unredacted`. Each names the withheld `seq`, goes to stderr and the receipt, and leaves the exit status alone (§6.1) |

The stream copy of a projected run **opens with a `parley.history.transform` line** naming the
projection and the SHA-256 of the transform's source text as the runtime renders it, so a reader
can tell a projected copy from a whole one and by what:

```jsonl
{"event":"history.transform","t":1795390370293,"seq":1,"run":"01M82SNWFCYTA4NZ7K43TESPAT","name":"drop-step-detail","sha256":"3d6f8595191136c54884fe832e0fb0242116bf967441074e7c0cf577108319f3","_schema":{"id":"parley.history.transform","version":"1.0.0"}}
```

That line reaches the stream and no other sink, so it takes a `seq` the receipt has no line at,
and the receipt records the gap as a `receipt.step` naming the projection and its digest. The
receipt copy is never projected and never carries the line. Withholding likewise leaves a `seq`
gap on the stream alone. With no transform configured there is no opening line, no step, no
projection and no difference in any byte.

`bun run doctor --history SEGMENT.jsonl` reads a segment rather than a run and reports each run's
projection by name and digest and every `seq` its copy does not carry. Captured from the `count`
example under a `what-ran` transform, which withholds every `receipt.step`, on 2026-11-22:

```text
PROJECTION  01M82SPNTW39HDZABES1HFYRAC  what-ran  5dde666fc322…  (history:1)
GAP         01M82SPNTW39HDZABES1HFYRAC  seq 3 is not in this copy
GAP         01M82SPNTW39HDZABES1HFYRAC  seq 4 is not in this copy
SEGMENT     4 line(s); 1 run(s), 1 projected, 2 gap(s), 0 without end, 0 unparseable
```

See [conformance](../conformance/README.md#reading-a-segment-of-the-shared-stream) for what the
segment mode establishes and what it does not.

The dependency runs one way. The stream consumes the format; the format never requires the
stream. Querying it is flyingrobots/parley#2, the reader's preference for the least-projected
copy is flyingrobots/parley#58, and syncing it between machines is nobody's yet.

### A built-in: declaredProjection

The transform above is user code; `declaredProjection(values)` (flyingrobots/parley#59) is the
one built in, for the common case of a declared list the caller already knows is wrong on a
shared timeline — a username in a path, a hostname, a private repository name:

```ts
import { declaredProjection } from "parley-emit";

await main(tool, argv, handler, { history: { transform: declaredProjection(["db-prod-7"]) } });
```

It is the **same** scrubber `src/redact.ts` uses for a declared secret (§5.3), applied to the
stream copy's body with `values` as a second declared set: longest value first, so one value that
contains another is replaced whole, and a key that carries a declared value is renamed. It never
touches the envelope the writer reattaches regardless, nor the writer's own identity scalars
(`tool`, `v`, `inv`, `sha256`, `name`, `id`, `version`, `code` — `DIGEST_KEYS` in `src/run.ts`) on
a writer-built record it might also be handed, since those carry no pattern a validator would
reject a corrupted value by. `argv` is not one of them, and scrubs normally.

An empty `values` returns `undefined`, not an identity function, so `MainOptions.history.transform`
is itself `undefined`: the writer never builds a projection for it and the stream copy carries no
`parley.history.transform` opening line at all. The function returned is declared with a literal
name, so that line's `name` is always `declaredProjection` and its `sha256` — a digest of the
function's *source text* — never discloses `values`, which only ever reaches it as a variable the
function closes over.

### Refusing a suspected secret

`refuseSuspectedSecrets(patterns?)` is a built-in transform (flyingrobots/parley#60). Declared
redaction cannot catch a secret nobody declared, and an undeclared token on the shared timeline
lives for the retention window rather than one run's lifetime. The built-in **withholds** any line
whose body matches one of ten token shapes and raises one `history.suspected_secret` warning naming
the withheld `seq`, the shape and a JSON Pointer — never the matched text.

| | |
| --- | --- |
| Configure | `{ history: { transform: refuseSuspectedSecrets() } }`; a caller's list replaces the default, `[...SECRET_PATTERNS, ...mine]` extends it, `[]` is the identity |
| The shapes | `src/transforms/secret-patterns.ts`, as data: a name, a regex source and one line of rationale each, covering AWS access key ids, GitHub tokens of six prefixes and fine-grained PATs, Slack tokens, Google API keys, PEM private-key headers, JWTs, `Bearer` values, npm tokens and Stripe live keys. Each is anchored and length-bounded, and each has a positive and a negative sample in the suite |
| It refuses | It never rewrites: a heuristic must not claim the certainty rewriting implies, so a false positive costs one withheld stream line and never a changed value in the receipt |
| Scanned | String values, recursively, through objects and arrays. Not the five envelope fields, which are the writer's (§1.3), and not object keys |
| Limits | An unlisted shape passes; a token split across two values passes; a token used as a key passes; a legitimate value that matches is withheld. Declaring the value as a secret (§5.3) remains the real protection, which the warning's `remedy` says |
| The head | Not exempt, and the likeliest line to match, because it echoes `argv` and `resolved` (§5). An undeclared token on the command line withholds the whole head, so that stream copy has no head; the gap is reported and the receipt is complete |
| The pointer | Built from the record's own keys, so when it matches a shape itself the warning names the shape instead of the pointer |
| Identity keys | Scanned, unlike `declaredProjection`, which skips `DIGEST_KEYS` because it rewrites; a refusal changes nothing, so there is nothing to corrupt and skipping would only let a token through |
| Composing | No helper ships; a caller composes `declaredProjection` and this in its own function, passing a refusal on untouched |
| Status | Unchanged. A withheld line is a warning, and warnings never change the exit status (§6.1) |

A transform of your own can withhold a line under its own code the same way, by returning
`refuse(code, problem, remedy?)` instead of nothing. The writer raises one warning carrying that
code and still owns the namespace: a code that is not spec §6's shape, or an empty problem, is
`history.transform_failed`, and a code carrying a declared secret value is
`history.transform_unredacted`, because a diagnostic's `code` is the one string §5.3 does not
scrub. The package
[README](../../../packages/parley-emit/README.md#five-decisions-the-owner-may-overrule) states the
five decisions behind the built-in that the owner can overrule.

## A record redaction made invalid

Spec §5.3 forbids publishing a record that redaction made invalid under its declared schema
(flyingrobots/parley#131), and does not exempt a program that holds the schema and cannot
evaluate it (flyingrobots/parley#144). The writer holds every schema document it can check against, by exact
pair: the ones it ships and the ones the tool declared on its emitted and error types.

| Step | Behaviour |
| --- | --- |
| Trigger | The scrub replaced something in a record the tool emitted. A writer-built record never triggers it: the head, `end`, `redaction`, `sidecar`, `receipt.inputs`, discovery lines, the writer's own warnings and its redaction errors are emitted with the writer flag. That flag narrows the scrub so the record stays valid under its released schema. Left alone: the envelope; field names; numbers and booleans; the strings under `sha256`, `inv`, `tool`, `v`, `name`, `id`, `version`, `code`, `op` and `error`; the head's `redacted` object, written as built (its lists of names are scrubbed when it is built; its indexes and JSON Pointers are locations); and a `schema` line's document. Scrubbed: every other string. So a declared secret equal to one of the protocol's words (`create`, `paths`, `input.unreadable`) changes nothing in such a record, while the same value in `intent`, a `scope`, an input's `path` or `role`, a `problem` or `argv` is replaced. The records the writer raises on its own account are writer-built too (flyingrobots/parley#161): `uncaught.exception` and `uncaught.writer_failure` from `main`, the retention and history-retention steps, the projection step and the captured-console step. Their field names (`code`, `problem`, `remedy`, `decision`, `because`, `detail`, and `stack`, `method`, `text`, `receipts`, `segments` inside `detail`) and the writer's own `code` stay whatever a declared secret's value is; every string in them is scrubbed, the tool's text included: an exception's name, message and stack, a captured line, a file name. A step or an error the tool itself emits is the tool's record: scrubbed in full, keys included, and checked |
| Check | Before any copy is written and before a `seq` is taken, the stream copy and, with `receiptExtra`, the receipt copy are each validated as scrubbed and as the tool handed them over. A failure the scrubbed copy has and the original did not is a conflict |
| Schema not evaluable | The pair has a schema document the checker cannot evaluate: one that uses a keyword outside its subset, a keyword whose value has the wrong shape (`enum: 5`), or a `pattern` this writer will not answer for (one the engine rejects as ECMAScript with the `u` flag, or an inline-flag group). The two writers can differ on which schemas they can evaluate, and each refuses what it cannot; where both evaluate one, they agree. No such document makes the checker throw: `checkRecord` answers `unsupported`, in a redaction check, in a history projection (`history.transform_uncheckable`) and when called directly. The writer cannot show the redacted record is valid, so it withholds it exactly as it withholds a conflict: one writer-built `error`, code `redaction.schema_unchecked`, with `detail` `{schema: {id, version}, redacted}`, and the call throws `ParleyRedactionUnchecked`, a `ParleyRedactionConflict` with empty `pointers`, the `redacted` pointers and `construct` (what `schemaSubsetGap` reports). The construct is part of the schema, so it is on the exception and never on the line; it is left off the exception too if it would carry a declared secret value. The code means not checked: it does not say the record was invalid, and no secret was exposed, since the value was replaced first. The trigger is any redaction in such a record, even when the secret sat in an unconstrained string and the redacted record would still have been valid: nothing is established about a schema the checker did not evaluate. The remedies are to keep the declared schema within the checker's keywords (the package README lists them) or to keep declared secrets out of emitted records. Removing the `schema` document removes the refusal and the check together, which is the spec's exemption and not a fix |
| Not checked | A pair with no schema document, which spec §5.3 exempts: the record is written as before. A record the scrub did not change is never checked, whatever its schema. A record already invalid in the same way is written as before |
| Report | One writer-built `error`, code `redaction.schema_conflict`, on stderr and in the receipt. `problem` and `detail` (`schema: {id, version}`, `at`, `redacted`) name the fields by JSON Pointer and the schema pair. The checker's text is deliberately not used: it can quote the schema, and the value is the secret or sits beside it. Being writer-built, the error is not checked again, so it cannot raise another |
| Refusal | The call throws `ParleyRedactionConflict`. `main` does not turn it into `uncaught.exception`; a handler may catch it and continue |
| Status | 4, forced at `end` exactly as a sink failure forces it, whatever status the handler passes, for a conflict and for a schema that could not be evaluated alike. `run.redactionRefused` is true |

## Numbers

A record's payload may hold a `bigint` (flyingrobots/parley#171). It is written as a JSON number
of exact unquoted digits and stays exact through every place a record travels. `seq`, `t` and
`status` are the writer's and are always numbers.

| Boundary | Behaviour |
| --- | --- |
| Serialisation | Every line on every sink is written by `exactJson`: `JSON.stringify`'s own text for a value holding no `bigint`, and the same rules with a `bigint` as its digits otherwise. stdout, stderr and the receipt are serialised from one value, so their copies hold the same digits. A `bigint` inside the safe range is written as the number it equals (`5n` is `5`) |
| Sidecar | The stored bytes are that text; `bytes` and `sha256` on the `sidecar` event are of the stored bytes |
| History stream | Without a transform, the receipt's bytes. With one, the receipt line is parsed by `parseExact`, the transform is handed the result, and what it returns is checked and written by `exactJson`. A number the tool passed beyond the safe range therefore reaches a transform as the `bigint` its text states (`2 ** 53` as `9007199254740992n`), and the stream copy states the same value, spelt as digits |
| Reparsed text the writer cannot hold | The line is not handed to the transform and not appended past it: it is withheld from the stream with a `history.number_unrepresentable` warning naming the `seq` and the numbers as written. No emission writes such text, because the writer refuses a `bigint` its parser could not read back; this is the second guard |
| Redaction | A `bigint` whose decimal digits are a declared secret is replaced with `[redacted]`, as a number is. Any other `bigint` passes through the scrub unchanged |
| Post-redaction check, projection re-validation | `checkRecord` treats a `bigint` as a JSON number and an integer. `type`, `const`, `enum` and the four bounds are decided by exact comparison. An integer beyond the safe range beside a schema number that is itself beyond the safe range is not decided, since that number may be a rounded reading of the schema's text: the answer is `unsupported`, which a redaction reports as `redaction.schema_unchecked` and a projection as `history.transform_uncheckable`. A `bigint` inside the safe range is decided against any bound. Nothing is ever checked as a converted double |
| `inv`, `canonical` | A `bigint` is canonical as its digits; `5n` and `5` share a form. The canonical form is of the value as the serialiser writes it: a `toJSON` hook's result, a boxed primitive's primitive, no member for a function. `resolved` is taken in that form once, at startup, for the head and for `inv`. Plain JSON data accepted before 0.5.0 keeps its canonical form and its `inv`; a `resolved` holding a `Date` or another hooked value moves, since before 0.5.0 it was identified by its own keys (a `Date` as `{}`) |
| `--human`, errors, the top-level handler | The default rendering uses `exactJson`; a tool's renderer is handed the `bigint`; a diagnostic's `detail` may hold one; captured console output of an object holding one keeps its JSON form |
| Refusals | A `bigint` of more than `MAX_EXACT_DIGITS` (4,096) digits: the emitting call throws `TypeError` before a `seq` is taken, `resolved` holding one is `startup.arguments_invalid`, and a transform's body holding one is `history.transform_invalid`. A number that is not finite (`NaN`, `Infinity`, `-Infinity`) is refused in the same three places, and `canonical` and `computeInv` throw `TypeError` for one (flyingrobots/parley#177). A `bigint` passed to `end` as the status: `TypeError` |

`parseExact` decides each number from its text:

| The number | Held as |
| --- | --- |
| An integer from -9007199254740991 to 9007199254740991, however spelt (`5`, `5.0`, `5e0`, `1e3`) | `number` |
| An integer outside that range, however spelt (`9007199254740992`, `9007199254740993.0`, `9.007199254740993e15`, `1e400`) | `bigint` |
| Not an integer, with the decimal value of the number's standard JSON serialisation (`0.1`, `0.10`, `1e-1`), per flyingrobots/parley#173 | `number` |
| Any other decimal (`0.10000000000000001`, `1e-400`), or an integer of more than 4,096 digits | not held: `ok: false`, with the numbers as written in `tokens` and `UNREPRESENTABLE` in their places in `partial` |

The cap is an implementation limit. A token past it, or one with an enormous exponent, is
classified from its length and never built. `parseExact` throws exactly when `JSON.parse` does.

A number that is not finite is never written: before 0.5.0 it was written as `null`, as
`JSON.stringify` writes it (flyingrobots/parley#177). A value whose own `toJSON` returns `null`,
such as an invalid `Date`, is still `null`. The writer's two reads of another receipt during retention use
`JSON.parse`; they read `event` and `tool`, which are strings.

The rules are pinned as data in the [numeric corpus](../../../conformance/numbers/README.md).

## What it does not do

- Replay. `cache.hit` is not emitted; the writer never short-circuits on `inv` (spec §2.3 leaves
  that to the tool, and nothing here decides it).
- Windows paths. v0.2 of the spec is POSIX-only.
- Replay across tools. The package is on npm as `@flyingrobots/parley-emit` (name per
  flyingrobots/parley#20); it is one writer, not a registry of receipts.
- Reading. The doctor under `scripts/` checks a captured run; [parley-read](../parley-read/README.md)
  loads a repository's receipt bundles. Neither is this package.

## Checks

```bash
bun test                 # root: the package suite runs with the repository's
bun run typecheck        # strict TypeScript over the package
bun run check            # every JSON example, the package README included
```
