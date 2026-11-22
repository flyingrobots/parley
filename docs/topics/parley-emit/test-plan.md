# parley-emit — test plan

Evidence lives in `packages/parley-emit/test/`. Every case runs the doctor
(`scripts/doctor.ts`) over the captured streams, so "conforms" below means zero doctor
violations against the repository's draft schemas.

| ID | Requirement | Spec |
| --- | --- | --- |
| PE-1 | A tool conforms by constructing a writer and emitting through it; every line validates against the schema for its exact pair | §1, §4.4, §4.5 |
| PE-2 | `inv` is computed over input bytes; stable across reruns, changed by editing an input; omitted when it cannot be made safe | §2.2 |
| PE-3 | The bootstrap line is emitted before work begins and names a receipt that already exists | §3.1 |
| PE-4 | An uncaught throw produces a conforming error line and a readable, complete failed receipt; exit 2 | §6, §3.3 |
| PE-5 | Retention is stated, enforced by count, configurable, recorded, and skipped on a dry run | §5.1, §4.3 |
| PE-6 | Repository hygiene: `.parley/.gitignore` with `*` on first write, never overwritten; a user's file sends the run to the fallback with a warning | §5.2 |
| PE-7 | Declared secrets never reach any stream; the head records every redaction; later surfacings are replaced and recorded by `redaction` events; `end.redacted` aggregates | §5.3, §3.3 |
| PE-8 | Startup failure is one stderr line and exit 3; the fallback location is used before failing | §3.2, §5 |
| PE-9 | Sink failure before `end` is an error line on a working sink and exit 4; nothing follows `end` | §5.4, §3.3 |
| PE-10 | Discovery is a run: `--schema` and `<command> --help` bootstrap, write a receipt, and close with `end` | §4.1, §4.2 |
| PE-11 | A record over 65,536 bytes is stored as a sidecar whose event describes the stored bytes | §5 |
| PE-12 | No run emits a non-JSON line on any stream, whatever a record contains; a library's console output is captured into the receipt | §1.1, §1.2 |
| PE-13 | The shipped schemas are byte-identical to the repository drafts and pinned by commit | §4.5 |

| ID | Case | Oracle | Evidence | Status |
| --- | --- | --- | --- | --- |
| PE-1a | Golden run: bootstrap, head, step, result, warning, inputs, end | doctor passes; first stdout line is `run` at `seq: 0`; `end` last on stdout and receipt with the final `seq` | `golden run conforms line by line` | planned |
| PE-1b | A tool-owned result validates against the schema the tool declares | ajv over the declared schema accepts the stdout copy | `tool-owned result validates against its declared schema` | planned |
| PE-2a | Same inputs, two runs | equal `inv` in both `receipt.inputs` lines | `inv is stable across reruns` | planned |
| PE-2b | Edit one input byte | `inv` differs | `inv changes when an input changes` | planned |
| PE-2c | No declared inputs | `inv` on the bootstrap line and the head | `inv is known at bootstrap when nothing is declared` | planned |
| PE-2d | Declared file inputs | bootstrap and head carry no `inv`; `receipt.inputs` carries digests and `inv` before `end` | `inv arrives in receipt.inputs when inputs are declared` | planned |
| PE-2e | A declared input is missing | its descriptor carries `error: input.unreadable`, no `sha256`; no `inv` anywhere; the run still ends | `a missing input is recorded and inv is omitted` | planned |
| PE-2f | A declared secret differs between two runs | same `inv` | `inv excludes declared secrets` | planned |
| PE-3a | Handler observes the streams when it starts | bootstrap already written; receipt file exists at the announced absolute path | `bootstrap precedes work and the receipt exists` | planned |
| PE-4a | Handler throws | stderr and receipt carry one `error` with code `uncaught.exception`; `end.status` 2; return 2; doctor passes | `an uncaught throw becomes an error line and a complete failed receipt` | planned |
| PE-4b | Handler reports an error and returns | `end.status` 2 | `a reported error closes the run with status 2` | planned |
| PE-5a | Retention count 3, five runs | two oldest bundles gone, three remain, the current run among them; a `receipt.step` records the deletion | `retention by count deletes the oldest bundles` | planned |
| PE-5b | Dry run over the limit | nothing deleted; bootstrap and head carry `dry_run: true` | `a dry run deletes nothing and says so` | planned |
| PE-6a | Fresh directory | `.parley/.gitignore` exists and contains a line `*` | `first write creates the ignore file` | planned |
| PE-6b | Existing ignore file with `*` and other lines | bytes unchanged | `an existing ignore file is never overwritten` | planned |
| PE-6c | Existing ignore file without `*` | receipt under the state directory; a `warning` on stderr names why | `a user's ignore file sends the receipt to the fallback` | planned |
| PE-6d | Eight concurrent runs in one directory | eight distinct receipts, each conforms, ignore file intact | `concurrent runs do not collide` | planned |
| PE-7a | `--token abc`, `--token=abc`, `TOKEN` in env, a declared source present | head: `[redacted]`, `--token=[redacted]`, `redacted.argv`, `redacted.env`, `redacted.resolved` pointers, `redacted.sources`; the value appears on no stream | `declared secrets are redacted in the head` | planned |
| PE-7b | The value surfaces in a later step's detail | replaced; a `redaction` event follows naming the line and pointer; `end.redacted` true | `a secret in a later record is replaced and recorded` | planned |
| PE-7c | No secret supplied | head has no `redacted`; `end.redacted` false | `no redaction field when nothing was redacted` | planned |
| PE-8a | Working directory read-only, state directory writable | receipt under the state directory, run conforms | `a read-only working directory falls back to the state directory` | planned |
| PE-8b | Both unwritable | one `startup.failed` line on stderr, nothing on stdout, return 3 | `no writable location is a startup failure` | planned |
| PE-9a | stdout sink throws on the result | an `error` line on stderr and in the receipt; `end.status` 4; return 4 | `a sink failure before end is reported and exits 4` | planned |
| PE-9b | Emit after `end` | refused; no line appears after `end` | `nothing follows end` | planned |
| PE-10a | `--schema` | a run: bootstrap, one `command` per command, one `schema` per emitted type, `end`; doctor passes | `--schema is a run` | planned |
| PE-10b | `<command> --help` | the `command` line, a `schema` for its result and one per error type | `--help describes one command` | planned |
| PE-11a | Receipt copy of a result over 65,536 bytes | `sidecar` event in its place; file exists; `bytes` and `sha256` match the stored bytes; stdout copy intact | `a large record is stored as a sidecar` | planned |
| PE-12a | 300 random records with control characters, newlines and unicode | every line on every stream parses; records round-trip | `every line on every stream is one JSON object` | planned |
| PE-12b | A library calls `console.log` and `console.error` during the run | stdout and stderr carry only protocol lines; the receipt records the captured text | `library console output is captured` | planned |
| PE-12c | `--human` | stdout is prose; the receipt still conforms | `--human renders prose and keeps the receipt` | planned |
| PE-13a | `src/schemas.ts` against `schemas/` | every digest matches; the commit is an ancestor of HEAD | `shipped schemas match the drafts` | planned |
