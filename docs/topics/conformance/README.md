# Conformance checking

How to check that a program's output conforms to the [specification](../../../spec/parley-v0.2.md),
and what the checker can and cannot establish. This is a reference for tool authors and for
anyone reviewing a parley-emitting tool.

## The doctor

```text
bun run doctor --stdout run.stdout.jsonl --stderr run.stderr.jsonl --receipt run.receipt.jsonl
bun run doctor --stdout ... --human
```

`scripts/doctor.ts` takes a captured run and reports every violated rule with the spec section,
the stream and the line, as JSON Lines stamped `parley.tooling.doctor` (schema beside the script).
Exit status is `0` when the run conforms, `1` when it does not, `2` when the check could not run.
Capture stdout and stderr separately and pass the receipt the bootstrap line announced; a
`--receipt` path that does not exist is itself a violation.

| Rule | Section | What it checks |
| --- | --- | --- |
| R1 | §1, §1.4, §5.4 | Every line is a JSON object. A stray line on stdout is the writer's contract failure; on stderr it is quarantined and reported; an unterminated final line is ignored and reported. |
| R2 | §1.3 | Every protocol line carries `event`, `t`, `seq`, `run`, `_schema` with the right types. |
| R3 | §4.5 | Every `parley.*` line validates against the schema for its exact `(id, version)`. A pair the doctor has no schema for is reported as unvalidated, never as validated; tool-owned ids are counted as partial. |
| R4 | §3.1, §3.2 | The first stdout line is the bootstrap at `seq: 0`, or the run's only line is a `startup.failed` on stderr. The bootstrap is not mirrored into the receipt. |
| R5 | §5 | The receipt's first line is the head, for the same run, tool and version. |
| R6 | §1.3 | One run, one counter: every line names the run; copies of one event agree on `event`, `t` and every shared field; no stream carries a `seq` twice. |
| R7 | §3.3, §3.4 | The last line on stdout and in the receipt is `end`, with the run's final `seq`; nothing follows it; status 2 has a structured error and status 0 has none. |
| R8 | §3.3 | `end.redacted` matches the receipt: the head's `redacted` or any `redaction` event. |
| R9 | §5 | Every result, error and warning has a copy or a sidecar in the receipt. |
| R10 | §4.2 | A discovery run (stdout carries a `command` line) that ends with status 0 carries a `schema` line for `parley.startup.failed`, an error type every command can produce. A discovery run that failed part-way is not checked. |

## Checking a receipt alone

```text
bun run doctor --receipt .parley/receipts/01M8....jsonl
```

A run under `--human` writes prose to stdout and stderr, because the caller asked for prose
(spec §1.1); the doctor would rightly call that prose a contract failure on stdout. The receipt of
such a run is still the record, so `--receipt` without `--stdout` or `--stderr` checks the receipt
on its own: R1 to R3 on its lines, R5 (the head is first), R6 within the receipt (one run, no
`seq` twice), R7 (it ends with `end`, which carries the final `seq` and a status that agrees with
the errors it records) and R8 (`end.redacted` agrees with the head and the `redaction` events). R4
and R9 need the streams and are not run, so a pass here says less than a pass over all three: it
says the record is complete and well formed, not that stdout carried what the receipt says it did.
A `--receipt` path that does not exist is `R5.receipt_missing`.

## Reading a segment of the shared stream

```text
bun run doctor --history ~/.local/state/parley/history/2026-11-22.jsonl
bun run doctor --history SEGMENT.jsonl --human
```

A segment of the shared history stream (spec §8, informative) is not one run's three streams: it
interleaves whole runs from every tool on the machine, and a copy in it may be a **projection** of
the receipt copy written through a history transform. So the questions are different, and the
doctor answers those instead of the rules above:

| Line | What it says |
| --- | --- |
| `doctor.projection` | This run's copy is a projection, by the named transform, whose source digests to `sha256`. Read off the run's `parley.history.transform` line |
| `doctor.gap` | This run's copy does not carry this `seq`. A line withheld by a transform, or a record the writer stored beside the receipt — a `sidecar` event's `source` is accounted for and is not reported |
| `doctor.segment` | The totals: lines, runs, projected runs, gaps, copies with no `end`, and lines that could not be parsed |

A gap is not a violation: withholding a line is what a transform is for, and `passed` is false
only when a line could not be parsed or could not be attributed to a run (§1.4, §1.3). Exit
status is `0` when it passed and `1` when it did not. The receipt copy is the record; a projection
is a view of it, which is why §8 tells a reader with both to prefer the least-projected one.

## What a pass establishes

A conforming verdict means the captured run has the declared shapes and the lifecycle rules hold
across the three streams. It does not establish that the program did what the receipt says, that
`inv` was derived as documented, or that redaction was complete; spec §1.2a says what each kind
of evidence establishes. The doctor is a reader; it reads records.

## Fixtures

`scripts/fixtures/doctor/conforming/` is a complete run modelled on the spec's examples (a successful, warning-only run, distinct from
the failed run the spec shows),
and `startup-failed/` is a run that could not bootstrap. `scripts/doctor.test.ts` mutates the
conforming run one rule at a time and asserts the doctor names that rule.

## Status

The doctor is repository tooling. It reads parley output but does not itself bootstrap, write a
receipt or close with `end`. The writer library now exists
([parley-emit](../parley-emit/README.md)); rebuilding the doctor on it so that it conforms is
tracked as follow-up work, not done.
