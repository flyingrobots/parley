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
| `main(spec, argv, handler, options)` | Parses the writer-owned flags (`--human`, `--humanize`, `--dry-run`, `--schema`, `--help`), chooses the receipt location, opens the shared history stream when one is configured, resolves declared sources, redacts, bootstraps, writes the head, enforces retention, runs the handler under the top-level handler, closes with `end`, returns the exit status |
| `Run` | `result`, `page`, `step`, `warning`, `error`, `input`, `finaliseInputs`, `end`; `receiptPath`, `cwd`, `dryRun`, `ended`, `status` |
| `SCHEMAS`, `SCHEMA_SOURCE` | The sixteen draft schemas the package ships, with the commit and digest of each |
| `computeInv`, `canonical`, `digestTree`, `sha256` | The documented `inv` derivation and its parts |
| `chooseLocation`, `repoRoot`, `stateBase`, `bookkeepingFor` | Receipt placement and the bookkeeping a run declares |
| `resolveHistory`, `openHistory`, `isHistoryFailure`, `writeWholeLine`, `retainHistory`, `historyBookkeeping`, `segmentName`, `historyDays` | The shared history stream of spec §8: where it is, opening a segment, the whole-line append, segment retention, and the bookkeeping a run with a stream declares |
| `classifySecrets`, `collectSecretValues`, `redactArgv`, `scrub` | Redaction |
| `ulid` | Run ids |

## Lifecycle, as the writer performs it

1. Classify the declared secrets of every command into flags, variables and logical sources;
   collect the values flags and variables carry from `argv` and the environment; call the selected
   command's source resolvers (spec §5.3); a resolver that throws means not present. Choose a run
   id that carries none of those values; a session that carries one is
   `startup.secret_in_identity`, exit 3; the tool's name and version are public and printed as
   they are.
2. Reserve the receipt: `.parley/.gitignore` with a line `*`, created whole and linked into
   place if absent; then `.parley/receipts/<run>.jsonl` opened exclusively. On a user's ignore
   file without `*`, a working-directory path carrying a secret value, an unwritable directory or
   a failed reservation, the state directory keyed by a digest of the repository root. With
   neither, one `startup.failed` line on stderr (`startup.receipt_unwritable`, or
   `startup.secret_in_path` when the state path would carry the secret too) and exit 3 (§3.2, §5,
   §5.2, §5.3). A throw from the tool's `resolved` or `inputs` callback here is
   `startup.arguments_invalid`, exit 3, and the reservation is removed.
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
   deleting only bundles whose receipt ends with `end` or that are incomplete and older than a
   day, and expire the stream's segments by age; record each decision as a step
   (§5, §5.1, §4.3, §8).
6. Discovery: emit `command` lines and `schema` lines, then `end` (§4.1, §4.2); a throw while
   emitting them is an `error` line and the run still ends. Otherwise run the handler. Every
   `console` function is captured into the receipt from the start of `main`, buffered until the
   head exists; direct descriptor writes and timers after `end` are the named exceptions.
7. An uncaught throw becomes `error` with code `uncaught.exception`, its stack in the receipt copy
   only (§6). `end` digests the
   declared inputs, with redacted descriptors in the preimage, and emits `receipt.inputs` with
   `inv` if not already done, then writes `end` to stdout and the receipt as one event and closes
   the file. Status: the one given (`0` refused after a reported error), else 2 if an error was
   reported, else 0; 4 if any sink or sidecar failed (§3.3, §3.4, §5.4). Every record's payload is
   scrubbed of declared secrets before any copy is written, within strings, in numbers and
   booleans whose decimal form is a secret, and in object keys; the envelope never is. The default
   descriptor sinks retry a full pipe and continue a partial write; a sidecar that cannot be
   written is kept inline.

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
| Injecting | `MainOptions.history` takes a sink or `null`, beside `stdout`, `stderr`, `now` and `home` |

Two decisions the issue (flyingrobots/parley#3) left to the owner are implemented behind a
recommendation, stated in the package
[README](../../../packages/parley-emit/README.md#two-decisions-the-owner-may-overrule): scope and
expiry (one stream per user per machine, dated daily segments, retention by whole segment), and
redaction (none of the stream's own, because the stream is the receipt's bytes and a credential
cannot reach it that did not reach the receipt; owner-only permissions, no sidecar bodies and no
network instead).

The dependency runs one way. The stream consumes the format; the format never requires the
stream. Querying it is flyingrobots/parley#2 and syncing it between machines is nobody's yet.

## What it does not do

- Replay. `cache.hit` is not emitted; the writer never short-circuits on `inv` (spec §2.3 leaves
  that to the tool, and nothing here decides it).
- Windows paths. v0.2 of the spec is POSIX-only.
- Replay across tools. The package is on npm as `@flyingrobots/parley-emit` (name per
  flyingrobots/parley#20); it is one writer, not a registry of receipts.
- Reading. The doctor under `scripts/` is the repository's reader; the reader library is
  flyingrobots/parley#2.

## Checks

```bash
bun test                 # root: the package suite runs with the repository's
bun run typecheck        # strict TypeScript over the package
bun run check            # every JSON example, the package README included
```
