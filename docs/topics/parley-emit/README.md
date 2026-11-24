# parley-emit

The writer library: `@flyingrobots/parley-emit`, under `packages/parley-emit`. A tool conforms to
the [specification](../../../spec/parley-v0.2.md) by constructing a writer and emitting through
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
| `SCHEMAS`, `SCHEMA_SOURCE` | The seventeen schemas the package ships, the released versions of spec `0.2.0`'s release, with the commit and digest of each |
| `computeInv`, `canonical`, `digestTree`, `sha256` | The documented `inv` derivation and its parts |
| `chooseLocation`, `repoRoot`, `stateBase`, `bookkeepingFor` | Receipt placement and the bookkeeping a run declares |
| `resolveHistory`, `openHistory`, `isHistoryFailure`, `writeWholeLine`, `retainHistory`, `historyBookkeeping`, `segmentName`, `historyDays` | The shared history stream of spec §8: where it is, opening a segment, the whole-line append, segment retention, and the bookkeeping a run with a stream declares |
| `historyProjection`, `transformDigest`, `transformName`, `isHistorySink` | The projection a configured transform applies to the stream copy: its name, the digest of its source, and which form `MainOptions.history` was given |
| `declaredProjection(values)` | A built-in transform: the writer's own §5.3 scrubber applied to the stream copy's body with a second declared set; `undefined` for an empty set, so no transform is configured at all |
| `refuseSuspectedSecrets`, `findSuspectedSecret`, `SECRET_PATTERNS`, `refuse`, `isHistoryRefusal` | The built-in transform that withholds a line whose body matches one of ten documented token shapes, the shapes themselves as data, and the typed refusal a transform returns to withhold a line under a code of its own |
| `checkRecord` | The bounded JSON Schema check the writer re-validates a projected line and a redacted record with, in a package with no runtime dependencies. A failing result carries `errors` and, in the same order, the JSON Pointer of each in `pointers` |
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
   flyingrobots/parley#109), a working-directory path carrying a secret value, an unwritable directory or
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
   only (§6). `end` digests the
   declared inputs, with redacted descriptors in the preimage, and emits `receipt.inputs` with
   `inv` if not already done, then writes `end` to stdout and the receipt as one event and closes
   the file. Status: the one given (`0` refused after a reported error), else 2 if an error was
   reported, else 0; 4 if any sink or sidecar failed, or a record was withheld because redaction
   made it invalid (§3.3, §3.4, §5.4, §5.3). Every record's payload is
   scrubbed of declared secrets before any copy is written, within strings, in numbers and
   booleans whose decimal form is a secret, and in object keys; the envelope never is. The default
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
| Retention | `PARLEY_HISTORY_DAYS` daily segments, today's included, default 14; older segments are unlinked whole and the deletion is a `receipt.step`. Never on `--dry-run`, which records what it would delete |
| Appending | `O_APPEND`, one whole line per write, so concurrent writers cannot split each other's lines. A short write is abandoned rather than continued and the stream is dropped for the rest of the run |
| Failing | An unopenable path is one `history.unavailable` warning; a failed append is one `history.write_failed` warning. Neither is an error, a sink failure or a change of exit status |
| Injecting | `MainOptions.history` takes a sink, `null`, or `{ sink?, transform?, name? }`, beside `stdout`, `stderr`, `now` and `home` |
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
| Failure is a warning, never an error | A throw is `history.transform_failed`, a body that no longer validates is `history.transform_invalid`, a body that restored a value §5.3 had replaced is `history.transform_unredacted`. Each names the withheld `seq`, goes to stderr and the receipt, and leaves the exit status alone (§6.1) |

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
(flyingrobots/parley#131). The writer holds every schema document it can check against, by exact
pair: the ones it ships and the ones the tool declared on its emitted and error types.

| Step | Behaviour |
| --- | --- |
| Trigger | The scrub replaced something in a record the tool emitted. A writer-built record never triggers it: the head, `end`, `redaction`, `sidecar`, `receipt.inputs`, discovery lines and the writer's own diagnostics are emitted with the writer flag, which also keeps their scalars and identity fields from being scrubbed |
| Check | Before any copy is written and before a `seq` is taken, the stream copy and, with `receiptExtra`, the receipt copy are each validated as scrubbed and as the tool handed them over. A failure the scrubbed copy has and the original did not is a conflict |
| Not checked | A pair with no schema document, and a schema outside the checker's subset: nothing can be established, and the record is written as before. A record already invalid in the same way is written as before |
| Report | One writer-built `error`, code `redaction.schema_conflict`, on stderr and in the receipt. `problem` and `detail` (`schema: {id, version}`, `at`, `redacted`) name the fields by JSON Pointer and the schema pair. The checker's text is deliberately not used: it can quote the schema, and the value is the secret or sits beside it. Being writer-built, the error is not checked again, so it cannot raise another |
| Refusal | The call throws `ParleyRedactionConflict`. `main` does not turn it into `uncaught.exception`; a handler may catch it and continue |
| Status | 4, forced at `end` exactly as a sink failure forces it, whatever status the handler passes. `run.redactionRefused` is true |

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
