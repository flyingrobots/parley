# parley-emit-py — test plan

Evidence lives in two places. `packages/parley-emit-py/tests/` holds the `unittest` suite, standard
library only, run with `python3 -m unittest discover -s tests` from the package directory.
`packages/parley-emit-py/test/parley-emit-py.test.ts` is the Bun side of the gate: it runs that
suite, and it holds the oracles that live in TypeScript — the repository doctor
(`scripts/doctor.ts`) over real captured runs of `examples/count.py`, `parley-read`'s
`loadReceipts` over the receipts those runs left, and ajv against the Python checker. `bun test`
at the repository root runs both, so the gate fails when the Python writer stops conforming.

Python test names below are `TestClass.test_method` in `tests/test_parley_emit.py`; Bun test names
are quoted.

| ID | Requirement | Spec |
| --- | --- | --- |
| PY-1 | The example's success run conforms: the doctor passes on its three captured streams, and `loadReceipts` loads its receipt with every `parley.*` line validated and no defect | §1, §3, §4.5, §5 |
| PY-2 | A usage error the command reports is a structured error, exit 2, and the run conforms | §3.4, §6 |
| PY-3 | A runtime failure (an exception escaping the handler) is a conforming error line with exit 2; its traceback reaches the receipt copy only, never stderr as plain text | §6, §3.3 |
| PY-4 | Discovery is a run: `--schema` and `<command> --help` bootstrap, write a receipt, close with `end`, and conform; `--help` names a schema for the success output and every error type the command can produce | §4.1, §4.2 |
| PY-5 | `--human` renders stdout through the tool's renderer and leaves the receipt a conforming record | §1.1 |
| PY-6 | A declared secret (flag, `--flag=value`, environment variable, credential source) never reaches stdout, stderr or the receipt; the head records every redaction; a later surfacing is replaced and recorded; `end.redacted` aggregates | §5.3, §3.3 |
| PY-7 | One run holds one counter: ten thousand result lines and the writer's own lines take every `seq` from 0 to the final one, with no gap and no repeat, across all three streams | §1.3 |
| PY-8 | A run that cannot bootstrap emits exactly one `startup.failed` line on stderr and exits 3, leaving no receipt | §3.2, §5 |
| PY-9 | Sink robustness: stdout closed early is an error line where a sink works and exit 4 with no traceback; a full non-blocking pipe is waited on rather than failed | §5.4, §3.3, §3.4 |
| PY-10 | Stray output: anything written through `sys.stdout`, `sys.stderr`, `print`, `logging` or `warnings` while the writer runs is captured into the receipt; the streams carry protocol lines only | §1.2 |
| PY-11 | The top-level handler converts every exception before `end` into a conforming line with the right exit status, wherever it is raised | §6, §3.2 |
| PY-12 | Repository hygiene: `.parley/.gitignore` created whole if absent, never overwritten; a user's file sends the receipt to the state directory with a warning | §5.2 |
| PY-13 | Retention is per tool: only completed bundles whose head names this tool are counted and deleted, oldest first, with their sidecars; never one in flight; never on a dry run; recorded as a step | §5.1, §4.3 |
| PY-14 | A receipt record over 65,536 bytes is stored as a sidecar described by its stored bytes; a sidecar that cannot be written keeps the record inline and exits 4 | §5 |
| PY-15 | `inv` is over input bytes: stable across reruns, changed by an edit, unchanged by a declared secret, carried by `receipt.inputs` when inputs are declared, omitted when an input is unreadable | §2.2 |
| PY-16 | The embedded schemas are the repository drafts, byte for byte, pinned by commit and digest; a stale copy fails the gate | §4.5 |
| PY-17 | The bounded checker agrees with ajv on the protocol's own schemas, and reports a keyword it does not implement rather than ignoring it | §4.4, §4.5 |
| PY-18 | `parley_emit.py` imports only the standard library and runs on Python 3.9 | — |
| PY-19 | Vendoring: `python3 parley_emit.py --vendor-info` prints the file's own SHA-256 as a schema'd JSON line, and a copy in a directory of its own runs a tool | — |
| PY-20 | The writer's own invariants: nothing follows `end`; `end(0)` after an error is refused; a record carrying an envelope key is refused | §3.3, §3.4, §1.3 |

| ID | Case | Oracle | Evidence | Status |
| --- | --- | --- | --- | --- |
| PY-1a | `count.py files` in a directory holding two regular files and a subdirectory | doctor passes on stdout, stderr and receipt; exit 0; the result says 2 | | planned |
| PY-1b | The receipts every example run in PY-1 to PY-5 left | `loadReceipts` reports no defect, no quarantined line, and every `parley.*` record `validated` | | planned |
| PY-2a | `count.py files --frobnicate` | one `error` with code `usage.unknown_flag` on stderr and in the receipt; `end.status` 2; exit 2; doctor passes | | planned |
| PY-3a | `count.py files --explode` (the example raises inside its handler) | one `error` with code `uncaught.exception`; stderr carries no traceback text; the receipt copy carries it under `detail.traceback`; exit 2; doctor passes | | planned |
| PY-4a | `count.py --schema` | one `command` line, a `schema` line for `count.result`, for every writer schema and for `parley.error`; exit 0; doctor passes | | planned |
| PY-4b | `count.py files --help` | one `command` line and exactly the schemas `count.result`, `parley.error` and `parley.startup.failed`; exit 0; doctor passes | | planned |
| PY-5a | `count.py files --human` | stdout is the renderer's prose and no JSON; the receipt alone passes the doctor | | planned |
| PY-6a | `--token S`, `--token=S`, `T_TOKEN=S` in the environment and a declared source present | head `argv` carries `[redacted]` and `--token=[redacted]`; `redacted.argv`, `redacted.env`, `redacted.sources` and `redacted.resolved`; `S` is absent from stdout, stderr and the receipt | | planned |
| PY-6b | The secret surfaces in a later step's detail and in a result | replaced in every copy; a `redaction` event names the record's `seq` and pointer; `end.redacted` true | | planned |
| PY-6c | The example run with a declared secret on its command line (the issue's edge case) | doctor passes; the value is absent from all three streams | | planned |
| PY-6d | A secret that is part of the working-directory path; one that every receipt path would carry | the first relocates the receipt with a `receipt.relocated` warning and never prints the value; the second is `startup.secret_in_path`, exit 3 | | planned |
| PY-6e | A secret parsed to a number, one used as a key, one containing another | each redacted, no tail left behind, `inv` unchanged by the value | | planned |
| PY-7a | Ten thousand results in one run | the multiset of `seq` over stdout, stderr and the receipt, copies deduplicated by `(run, seq)`, is exactly `0..end.seq`; doctor passes | | planned |
| PY-8a | No writable receipt location | one `startup.failed` with `startup.receipt_unwritable`, nothing on stdout, exit 3 | | planned |
| PY-8b | No command named, and a name that is not a command | `startup.unknown_command`, exit 3, no secret in the line | | planned |
| PY-8c | The tool's `resolved` callback raises | `startup.arguments_invalid`, exit 3, the reserved receipt removed, the message scrubbed | | planned |
| PY-9a | The example's stdout closed by its reader after the first line | exit 4; stderr carries a `sink.write_failed` error as JSON and nothing else; the receipt ends with `end` status 4 | | planned |
| PY-9b | A stdout sink that raises on the result | an `error` with a `sink.` code on stderr and in the receipt; `end.status` 4 in the receipt; exit 4 | | planned |
| PY-9c | A non-blocking stdout pipe whose reader stalls | every line is delivered; exit 0; stderr empty | | planned |
| PY-10a | `print`, `sys.stderr.write`, `sys.stdout.buffer.write`, `logging.warning` and `warnings.warn` inside the handler | each text is in a receipt step; stdout and stderr carry only JSON lines; doctor passes | | planned |
| PY-10b | Output written by a resolver before the receipt exists | held, then written into the receipt after the head | | planned |
| PY-10c | After `main` returns | `sys.stdout` and `sys.stderr` are the objects they were before | | planned |
| PY-11a | An exception from the handler, from the `human` renderer, from a source resolver and from discovery | each becomes a conforming line (error, warning, not-present, error) and the run ends; no plain text on stderr | | planned |
| PY-11b | `SystemExit` and `KeyboardInterrupt` raised in the handler | a conforming error line and `end`; exit 2 | | planned |
| PY-12a | Fresh directory | `.parley/.gitignore` is exactly `*\n`; `.parley` holds nothing else but `receipts` | | planned |
| PY-12b | An existing ignore file with `*` | bytes unchanged; receipt under `.parley` | | planned |
| PY-12c | An existing ignore file without `*` | bytes unchanged; receipt under the state directory; a `receipt.relocated` warning | | planned |
| PY-13a | Retention count 3, five runs | the two oldest gone, three kept, a retention step in the last receipt | | planned |
| PY-13b | Another tool's receipts and a reader's in the same directory | never counted and never deleted; this tool's own count still holds | | planned |
| PY-13c | A receipt with no `end` younger than a day | never deleted | | planned |
| PY-13d | A bundle with a sidecar directory | deleted together | | planned |
| PY-13e | `--dry-run` over the limit | nothing deleted; bootstrap and head carry `dry_run: true`; the step says what would have been deleted | | planned |
| PY-14a | A result whose receipt copy exceeds the threshold | a `sidecar` event in its place whose `bytes` and `sha256` describe the stored file; stdout copy unaffected | | planned |
| PY-14b | The sidecar path is blocked by a file | the record kept inline, a `sink.sidecar_failed` error, `end.status` 4 | | planned |
| PY-15a | Declared input, two runs, then an edit | equal `inv`, then a different one; `receipt.inputs` before `end` | | planned |
| PY-15b | No declared inputs | `inv` on the bootstrap line and the head | | planned |
| PY-15c | A missing declared input | `error: input.unreadable`, no `inv` anywhere | | planned |
| PY-15d | Two runs differing only in a declared secret | the same `inv` | | planned |
| PY-15e | The derivation against the TypeScript writer's | the same tool, version, command, `resolved` and inputs give the same `inv` in both writers | | planned |
| PY-16a | Every embedded schema | its text digests to its pin; the pins equal the repository drafts' digests; the set of files is the same; the commit is 40 hex | | planned |
| PY-17a | The checker over samples of five drafts and every single-field removal | the verdict equals ajv's | | planned |
| PY-17b | `$ref`, an unimplemented `format` and a nested unknown keyword | reported as unsupported; every shipped draft is inside the subset | | planned |
| PY-17c | Every line every test run emits | validates against its exact pair with the embedded checker | | planned |
| PY-18a | The file's imports | every module is in a written standard-library allowlist; CI runs the suite on Python 3.9 | | planned |
| PY-19a | `--vendor-info` | one JSON line valid against `vendor-info.schema.json`, whose `sha256` is the file's | | planned |
| PY-19b | A copy of the file alone in a temporary directory, imported by a three-line tool | the tool runs and the doctor passes on it | | planned |
| PY-20a | Emitting after `end`; `end(0)` after `error`; a record with `seq` | `ParleyClosed`; `ValueError`; `ValueError` | | planned |
