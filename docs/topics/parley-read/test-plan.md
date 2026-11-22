# parley-read — test plan

Evidence lives in `packages/parley-read/test/parley-read.test.ts`. Cases about the reader rules
build a receipt bundle by hand, byte by byte, because the point of those rules is the bytes a
conforming writer cannot promise; cases about what the loader returns for real output run the
writer (`@flyingrobots/parley-emit`) and load what it left behind.

| ID | Requirement | Spec |
| --- | --- | --- |
| RD-1 | Both receipt locations for a working directory are located, reported present or absent, and nothing is created or modified to do it | §5, §5.2 |
| RD-2 | Every run under both locations is returned, with its records in `seq` order, and one unreadable receipt file does not lose the others | §1.3, §5 |
| RD-3 | A line is parsed only at a newline boundary; a line, or a character, split across reads is not garbage | §1.4 |
| RD-4 | A complete line that is not a JSON object, or carries no usable `(run, seq)`, is quarantined and reported, never a record | §1.4, §1.3 |
| RD-5 | An unterminated final line is ignored and reported; a newline-terminated `end` establishes that the run reported termination | §5.4 |
| RD-6 | `(run, seq)` identifies an event: copies are one record, a copy may carry a field another omits, a disagreement is reported, and two runs on one stream are told apart | §1.3 |
| RD-7 | A `parley.*` line is validated against the schema for its exact pair; an unshipped `parley.*` pair is partial; a tool-owned line is passed through as unvalidated | §4.5, §4.6 |
| RD-8 | A sidecar is resolved relative to its receipt, its stored bytes checked against `bytes` and `sha256`, and the record it holds returned in its place; with resolution off, nothing about it is claimed either way | §5, §1.2a |
| RD-9 | A bundle is unavailable for replay when a sidecar is missing, mismatched or escaping, when no newline-terminated `end` closes it, when its status is non-zero, or when it is redacted | §5, §5.3, §5.4 |
| RD-10 | The shipped schemas are byte-identical to the repository drafts and pinned by commit | §4.5 |
| RD-11 | A quarantined line is never evidence: not a record, not termination, not a validation result | §1.4 |
| RD-12 | The receipts the writer leaves behind load with zero quarantines and every `parley.*` record validates | §1, §4.4 |
| RD-13 | A thousand small receipts load in one bounded pass | — |

| ID | Case | Oracle | Evidence | Status |
| --- | --- | --- | --- | --- |
| RD-1a | A working directory with no `.parley` | two locations, repo first, both reported absent; no `.parley` and no state directory exist afterwards | `both receipt locations are listed and nothing is created` | implemented |
| RD-1b | The writer falls back to the state directory (read-only working directory) | the loader finds that run under the `state` location at the path the bootstrap line declared | `a receipt the writer put in the state directory is found there` | implemented |
| RD-1c | A location directory that does not exist | reported `present: false`; no throw; no bundles from it | `a missing location is reported as absent` | implemented |
| RD-2a | Two receipts under `.parley/receipts`, one under the state directory | three bundles, each record list ascending in `seq`, each bundle naming the location it came from | `every run under both locations is returned with its records in seq order` | implemented |
| RD-2b | A receipt whose lines are written out of `seq` order | records come back ascending in `seq` | `records out of order in the file come back in seq order` | implemented |
| RD-2c | A `notes.txt` beside the receipts | ignored; the bundle count is unchanged | `a non-jsonl file in a receipt directory is ignored` | implemented |
| RD-2e | A receipt file at mode `000` beside a readable one | the readable run loads; the unreadable file is a `receipt.unreadable` defect attributed to its named run, and the load does not throw | `an unreadable receipt is reported, not thrown, and the rest of the directory loads` | implemented |
| RD-2d | An empty `.parley/receipts` | no bundles, no defects, the location present | `an empty directory yields no bundles` | implemented |
| RD-3a | One JSON object pushed as two chunks split mid-object | nothing until the newline arrives, then exactly one line | `a line split across two reads is one line` | implemented |
| RD-3b | A multi-byte character split across the chunk boundary | the line decodes to the whole character | `a multi-byte character split across two reads is decoded whole` | implemented |
| RD-3c | A carriage return and a form feed inside the buffer | neither ends a line | `only a newline ends a line` | implemented |
| RD-4a | `not json` between the head and `end` | two records, one quarantine at line 2 keeping the bytes; the stray is in no record | `a stray line is quarantined and never a record` | implemented |
| RD-4b | `[1,2]` and `3` as lines | both quarantined; neither is a record | `a JSON array or scalar on a line is quarantined` | implemented |
| RD-4c | An empty line and a line of spaces | quarantined as blank | `a blank line is quarantined` | implemented |
| RD-4d | `{"event":"x"}` with no `run` or `seq` | quarantined; it cannot be placed in a run | `an object with no usable run and seq is quarantined` | implemented |
| RD-5a | A parseable `end` as the final fragment with no newline | not a record; reported; the bundle is not terminated | `an unterminated final line is ignored and reported` | implemented |
| RD-5b | The same file with the newline | `end` is the last record and the bundle is terminated | `a newline-terminated end establishes termination` | implemented |
| RD-6a | One file holding the lines of two runs | two bundles, one per run, each with its own records | `two runs interleaved on one stream are separated by run` | implemented |
| RD-6b | The same line twice | one record, `copies: 2` | `copies of one event are deduplicated by run and seq` | implemented |
| RD-6c | Two copies of one event, one carrying `detail` the other omits, and a pair disagreeing on `t` | the fuller record is returned; the disagreement is a reported defect | `a copy may carry a field another omits, and a disagreement is reported` | implemented |
| RD-6d | The same bundle under both locations | one bundle naming two sources, records not doubled | `the same run found in both locations is one bundle` | implemented |
| RD-7a | A head, a step and an `end` from the shipped drafts | every record validated against its exact pair | `a parley line is validated against the schema for its exact pair` | implemented |
| RD-7b | `parley.end` stamped `9.9.9` | state `partial`, never `validated`; reported | `a parley line of a version the reader does not ship is partial, never validated` | implemented |
| RD-7c | A `t.count` result | state `unvalidated`, reason `tool_owned`; the record is still returned | `a tool-owned line is passed through as unvalidated` | implemented |
| RD-7d | An `end` whose `status` is a string | state `invalid` with the validator's message | `a parley line that breaks its schema is reported invalid` | implemented |
| RD-7e | A line with no `_schema` | state `unvalidated`, reason `no_schema_ref` | `a line with no _schema is unvalidated` | implemented |
| RD-8a | A `sidecar` event whose stored file matches `bytes` and `sha256` | the stored record is returned at `source`, marked as from a sidecar; the sidecar event is also a record; state `intact` | `a sidecar is resolved and the record it holds is returned in its place` | implemented |
| RD-8b | `sidecars: false` over a bundle with a sidecar | state `unchecked`, no record restored, no defect, and replay ruled out because nothing was established | `with sidecar resolution off a sidecar is unchecked, never intact` | implemented |
| RD-9a | The stored sidecar bytes edited after the event was written | state `digest_mismatch`; the bundle unavailable for replay | `a sidecar with a wrong digest marks its bundle unavailable for replay` | implemented |
| RD-9b | The sidecar file deleted | state `missing`; the bundle unavailable for replay | `a missing sidecar marks its bundle unavailable for replay` | implemented |
| RD-9c | `path: "../escape.json"` with a readable file there | state `escapes_bundle`; the file's contents are in no record | `a sidecar path that would leave the bundle is never read` | implemented |
| RD-9d | A receipt with no `end` line | unavailable for replay, reason `receipt.no_end` | `a receipt with no end is unavailable for replay` | implemented |
| RD-9e | `end.redacted` true | unavailable for replay, reason `receipt.redacted` | `a redacted receipt is unavailable for replay` | implemented |
| RD-9f | `end.status` 2 | unavailable for replay, reason `end.status_nonzero` | `a non-zero status is unavailable for replay` | implemented |
| RD-9g | A complete, successful, unredacted bundle with an intact sidecar | nothing rules out replay; the reader still says so as "not ruled out" | `an intact bundle is not ruled out for replay` | implemented |
| RD-10a | `src/schemas.ts` against `schemas/` | every digest matches; the commit is recorded | `shipped schemas match the repository drafts` | implemented |
| RD-11a | A receipt whose only `end` is a quarantined fragment | no `end` record, not terminated, unavailable for replay, and the quarantine counted as a defect rather than a validation result | `a quarantined end is not termination, not a record and not validation evidence` | implemented |
| RD-12a | Five writer runs in one directory: a golden run, a sidecar run, a run that threw, `--schema`, and a run with a declared secret | five bundles, zero quarantines, no invalid and no partial record, every `parley.*` record validated, the tool-owned result unvalidated | `the receipts the writer leaves behind load with zero quarantines and every parley record validates` | implemented |
| RD-12b | The writer's own sidecar bundle | the result the receipt does not carry inline is restored from the sidecar with its rows | `a writer run whose result went to a sidecar loads with the record restored` | implemented |
| RD-12c | A writer run given a declared secret | the bundle is unavailable for replay and the value is nowhere in the loaded records | `a writer run that redacted a secret is unavailable for replay` | implemented |
| RD-13a | A thousand six-line receipts in one directory | 1000 bundles, 6000 records, zero quarantines, one pass under 30 s | `a thousand small receipts load in bounded time` | implemented |
