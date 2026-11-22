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
receipt or close with `end`; once the writer library
([flyingrobots/parley#1](https://github.com/flyingrobots/parley/issues/1)) exists the doctor
will be built on it and conform.
