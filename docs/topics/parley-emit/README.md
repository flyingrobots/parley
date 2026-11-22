# parley-emit

The writer library: `@flyingrobots/parley-emit`, under `packages/parley-emit`. A tool conforms to
the [specification](../../../spec/parley-v0.2.md) by constructing a writer and emitting through
it. This page is the reference for what the package does on `main`; the package
[README](../../../packages/parley-emit/README.md) is the front door with a captured run, and the
[test plan](test-plan.md) beside this page is the contract ledger.

## Surface

| Export | Job |
| --- | --- |
| `defineTool(spec)` | Validates a tool's declaration: name, version, commands with intent, effects, secrets, emitted types and error types, a stated retention count, optional source resolvers and a `--human` renderer |
| `main(spec, argv, handler, options)` | Parses the writer-owned flags (`--human`, `--humanize`, `--dry-run`, `--schema`, `--help`), chooses the receipt location, resolves declared sources, redacts, bootstraps, writes the head, enforces retention, runs the handler under the top-level handler, closes with `end`, returns the exit status |
| `Run` | `result`, `page`, `step`, `warning`, `error`, `input`, `finaliseInputs`, `end`; `receiptPath`, `cwd`, `dryRun`, `ended`, `status` |
| `SCHEMAS`, `SCHEMA_SOURCE` | The fourteen draft schemas the package ships, with the commit and digest of each |
| `computeInv`, `canonical`, `digestTree`, `sha256` | The documented `inv` derivation and its parts |
| `chooseLocation`, `repoRoot`, `stateBase`, `bookkeepingFor` | Receipt placement and the bookkeeping a run declares |
| `classifySecrets`, `collectSecretValues`, `redactArgv`, `scrub` | Redaction |
| `ulid` | Run ids |

## Lifecycle, as the writer performs it

1. Classify the command's declared secrets into flags, variables and logical sources; collect
   the values flags and variables carry; call each source resolver (spec §5.3).
2. Reserve the receipt: `.parley/.gitignore` with a line `*`, create-if-absent; then
   `.parley/receipts/<run>.jsonl` opened exclusively. On a user's ignore file without `*`, an
   unwritable directory or a failed reservation, the state directory keyed by a digest of the
   repository root. With neither, one `startup.failed` line on stderr and exit 3 (§3.2, §5, §5.2).
3. Emit the bootstrap line to stdout at `seq: 0`, carrying `inv` only when no inputs are
   declared, then the head to the receipt at `seq: 1` with the redacted `argv`, the redacted
   `resolved`, a descriptor per declared input, `effects` with bookkeeping, and `redacted` when any
   declared secret was supplied (§3.1, §5).
4. Warn if the receipt was relocated; enforce retention by count unless `--dry-run`; record the
   deletion as a step (§5.1, §4.3).
5. Discovery: emit `command` lines and `schema` lines, then `end` (§4.1, §4.2). Otherwise run the
   handler with `console.*` captured into the receipt.
6. An uncaught throw becomes `error` with code `uncaught.exception` (§6). `end` digests the
   declared inputs and emits `receipt.inputs` with `inv` if not already done, then writes `end` to
   stdout and the receipt as one event and closes the file. Status: the one given, else 2 if an
   error was reported, else 0; 4 if any sink failed (§3.3, §3.4, §5.4).

## What it does not do

- Replay. `cache.hit` is not emitted; the writer never short-circuits on `inv` (spec §2.3 leaves
  that to the tool, and nothing here decides it).
- Windows paths. v0.2 of the spec is POSIX-only.
- Publication. The package is not on npm yet; the name is reserved by decision
  (flyingrobots/parley#20) and free as of 2026-11-22.
- Reading. The doctor under `scripts/` is the repository's reader; the reader library is
  flyingrobots/parley#2.

## Checks

```bash
bun test                 # root: the package suite runs with the repository's
bun run typecheck        # strict TypeScript over the package
bun run check            # every JSON example, the package README included
```
