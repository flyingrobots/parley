# parley-emit — test plan

Evidence lives in `packages/parley-emit/test/`. Where a case says the run conforms, it runs the
doctor (`scripts/doctor.ts`) over the captured streams and asserts zero violations against the
repository's draft schemas; cases about a single field or a refusal assert that field. PE-12a
excludes the doctor's rule R3 because its 300 records are tool-owned and carry no schema the
doctor knows.

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
| PE-14 | A declared secret value reaches no stream, receipt or `inv` on any path: no command selected, discovery, a secret inside the working-directory path, a secret colliding with an envelope word, a secret in an input path | §5.3, §2.2, §3.2 |
| PE-15 | A throw from a tool callback before the bootstrap line is a startup failure; a throwing renderer falls back | §3.2, §6 |
| PE-16 | Retention never deletes a receipt still in flight and deletes a bundle's sidecars with it | §5.1 |
| PE-17 | The head is the receipt's first line whatever its size or the state of stdout; a sidecar failure and envelope keys from the tool are handled | §5, §5.4, §1.3 |
| PE-18 | Every `console` function is captured; overlapping runs restore the console | §1.2 |
| PE-19 | Tree inputs skip `.parley`, honour `exclude` and follow content; stdin and absolute inputs are digested; `receiptExtra` is scrubbed | §2.2, §5.3 |
| PE-20 | Smaller gaps: prototype names are not commands; `end(0)` after an error is refused; state-directory retention is declared; an empty secret is recorded; the ignore file is created whole | §4.3, §3.4, §5.2, §5.3 |

| ID | Case | Oracle | Evidence | Status |
| --- | --- | --- | --- | --- |
| PE-1a | Golden run: bootstrap, head, step, result, warning, inputs, end | doctor passes; first stdout line is `run` at `seq: 0`; `end` last on stdout and receipt with the final `seq` | `golden run conforms line by line` | implemented |
| PE-1b | A tool-owned result validates against the schema the tool declares | ajv over the declared schema accepts the stdout copy | `tool-owned result validates against its declared schema` | implemented |
| PE-2a | Same inputs, two runs | equal `inv` in both `receipt.inputs` lines | `inv is stable across reruns` | implemented |
| PE-2b | Edit one input byte | `inv` differs | `inv changes when an input changes` | implemented |
| PE-2c | No declared inputs | `inv` on the bootstrap line and the head | `inv is known at bootstrap when nothing is declared` | implemented |
| PE-2d | Declared file inputs | bootstrap and head carry no `inv`; `receipt.inputs` carries digests and `inv` before `end` | `inv arrives in receipt.inputs when inputs are declared` | implemented |
| PE-2e | A declared input is missing | its descriptor carries `error: input.unreadable`, no `sha256`; no `inv` anywhere; the run still ends | `a missing input is recorded and inv is omitted` | implemented |
| PE-2f | A declared secret differs between two runs | same `inv` | `inv excludes declared secrets` | implemented |
| PE-3a | Handler observes the streams when it starts | bootstrap already written; receipt file exists at the announced absolute path (no doctor run: the handler does nothing) | `bootstrap precedes work and the receipt exists` | implemented |
| PE-4a | Handler throws | stderr and receipt carry one `error` with code `uncaught.exception`; `end.status` 2; return 2; doctor passes | `an uncaught throw becomes an error line and a complete failed receipt` | implemented |
| PE-4b | Handler reports an error and returns | `end.status` 2 | `a reported error closes the run with status 2` | implemented |
| PE-5a | Retention count 3, five runs | two oldest bundles gone, three remain, the current run among them; a `receipt.step` records the deletion | `retention by count deletes the oldest bundles` | implemented |
| PE-5b | Dry run over the limit | nothing deleted; bootstrap and head carry `dry_run: true` | `a dry run deletes nothing and says so` | implemented |
| PE-6a | Fresh directory | `.parley/.gitignore` exists and contains a line `*` | `first write creates the ignore file` | implemented |
| PE-6b | Existing ignore file with `*` and other lines | bytes unchanged | `an existing ignore file is never overwritten` | implemented |
| PE-6c | Existing ignore file without `*` | receipt under the state directory; a `warning` on stderr names why | `a user's ignore file sends the receipt to the fallback` | implemented |
| PE-6d | Eight concurrent runs in one directory | eight distinct receipts, each conforms, ignore file intact | `concurrent runs do not collide` | implemented |
| PE-7a | `--token abc`, `--token=abc`, `TOKEN` in env, a declared source present | head: `[redacted]`, `--token=[redacted]`, `redacted.argv`, `redacted.env`, `redacted.resolved` pointers, `redacted.sources`; the value appears on no stream | `declared secrets are redacted in the head` | implemented |
| PE-7b | The value surfaces in a later step's detail | replaced; a `redaction` event follows naming the line and pointer; `end.redacted` true | `a secret in a later record is replaced and recorded` | implemented |
| PE-7c | No secret supplied | head has no `redacted`; `end.redacted` false | `no redaction field when nothing was redacted` | implemented |
| PE-8a | Working directory read-only, state directory writable | receipt under the state directory, run conforms | `a read-only working directory falls back to the state directory` | implemented |
| PE-8b | Both unwritable | one `startup.failed` line on stderr, nothing on stdout, return 3 | `no writable location is a startup failure` | implemented |
| PE-9a | stdout sink throws on the result | an `error` line on stderr and in the receipt; `end.status` 4; return 4 | `a sink failure before end is reported and exits 4` | implemented |
| PE-9b | Emit after `end` | refused; no line appears after `end` | `nothing follows end` | implemented |
| PE-10a | `--schema` | a run: bootstrap, one `command` per command, one `schema` per emitted type, `end`; doctor passes | `--schema is a run` | implemented |
| PE-10b | `<command> --help` | the `command` line, a `schema` for its result and one per error type | `--help describes one command` | implemented |
| PE-11a | Receipt copy of a result over 65,536 bytes | `sidecar` event in its place; file exists; `bytes` and `sha256` match the stored bytes; stdout copy intact | `a large record is stored as a sidecar` | implemented |
| PE-12a | 300 random records with control characters, newlines and unicode | every line on every stream parses; records round-trip | `every line on every stream is one JSON object` | implemented |
| PE-12b | A library calls `console.log` and `console.error` during the run | stdout and stderr carry only protocol lines; the receipt records the captured text | `library console output is captured` | implemented |
| PE-12c | `--human` | stdout is the tool's prose alone, no bootstrap or end line on success; the receipt's first line is the head | `--human renders prose and keeps the receipt` | implemented |
| PE-13a | `src/schemas.ts` against `schemas/` | every digest matches; the commit is recorded | `shipped schemas match the drafts` | implemented |
| PE-14a | Two commands, `--token` given, no command named | one `startup.failed` on stderr without the value; nothing on stdout; no receipt | `no command selected: the startup line and nothing else, with no secret in it` | implemented |
| PE-14b | `--schema --key <value>` | head `argv` redacted at the value's index | `discovery with a secret on the command line redacts it in the head` | implemented |
| PE-14c | Secret equal to a working-directory component | receipt under the state directory, `receipt.relocated` warning, value on no stream, payload redacted, envelope intact, doctor passes | `a secret that is a substring of the working directory relocates the receipt and never appears in clear` | implemented |
| PE-14d | Secret `receipts` | `startup.secret_in_path`, exit 3, nothing on stdout, no receipt | `a secret that every receipt path would carry is a startup failure` | implemented |
| PE-14e | Secret `run` | `event`, `run` and `_schema.id` intact on every line; payload strings redacted; doctor passes | `a secret that collides with an envelope word redacts payload values only` | implemented |
| PE-14f | Two runs, secret in the input path, same bytes | equal `inv`; path redacted in the receipt | `a secret in a declared input path does not enter inv` | implemented |
| PE-15a | `resolved` throws | one `startup.arguments_invalid` line, exit 3, no receipt left | `a throwing resolved callback is a startup failure, exit 3, and leaves no receipt` | implemented |
| PE-15b | `human` throws | default rendering on stdout; receipt ends with status 0 | `a throwing human renderer falls back to the default rendering and the run completes` | implemented |
| PE-16a | Retention 1, a run held open while another runs | the open run's receipt survives and ends 0 | `retention never deletes a receipt that has not ended` | implemented |
| PE-16b | A bundle with a sidecar, then retention | receipt and sidecar directory both gone | `retention deletes a bundle's sidecar directory with its receipt` | implemented |
| PE-17a | `resolved` of 70,000 bytes | head is the first receipt line, no sidecar, doctor passes | `a head over the sidecar threshold is still the receipt's first line` | implemented |
| PE-17b | stdout throws on the bootstrap write | head first, then the error, `end` status 4 | `a stdout failure on the bootstrap write still puts the head first` | implemented |
| PE-17c | A file where the sidecar directory should go | `sink.` error on stderr and in the receipt; `end` status 4 in the receipt | `a sidecar write failure is an error line and the receipt still ends` | implemented |
| PE-17d | `seq` in a record; `run` in `receiptExtra`; `page(null, true)` | `TypeError` each | `envelope keys supplied by the tool are refused` | implemented |
| PE-18a | `console.table`, `dir`, `group`, `count`, `assert`, `time`, `timeLog`, `timeEnd` in the handler | stderr empty, stdout all JSON, text in the receipt, doctor passes | `every console function is captured and nothing reaches a stream` | implemented |
| PE-18b | Two overlapping runs, the first ending first | console patched while one is open, original restored after the last | `overlapping runs restore the original console once the last one ends` | implemented |
| PE-19a | `.` as a tree with `exclude: ["src/secret.pem"]` | `inv` stable across reruns and across an edit to the excluded file; changed by an edit to another file | `a tree input skips .parley and honours exclude, and its digest follows content` | implemented |
| PE-19b | A stdin input supplied by the handler and an absolute path | both digests present; `inv` present | `a supplied stdin input is digested and an absolute path resolves` | implemented |
| PE-19c | Secret in `receiptExtra` | replaced; `redaction` event at `/note` | `a secret in receiptExtra is replaced and recorded` | implemented |
| PE-20a | `t toString` with two commands | `startup.unknown_command`, exit 3 | `an Object.prototype name is not a command` | implemented |
| PE-20b | `end(0)` after `error` | `TypeError`; the run ends 2 | `end(0) after a reported error is refused` | implemented |
| PE-20c | `--token ""`; `--schema` | bookkeeping carries a `delete` for the state directory; `redacted.argv` names the empty value | `bookkeeping declares the state directory's retention and an empty secret is still recorded` | implemented |
| PE-20d | Fresh directory | `.parley/.gitignore` is exactly `*` and a newline; no temporary file remains | `the ignore file is created whole` | implemented |

Also implemented, outside the numbered requirements: `run ids are ULIDs, unique and sortable`.
