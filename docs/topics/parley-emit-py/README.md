# parley-emit-py

The Python writer: `packages/parley-emit-py/parley_emit.py`, one file, standard library only,
Python 3.9 or later. A tool conforms to the [specification](../../../spec/parley-v0.2.md) by
vendoring the file, defining itself with `define_tool` and running its handler under `main`. This
page is the reference for what the file does on `main`; the package
[README](../../../packages/parley-emit-py/README.md) is the front door, with a captured run and the
vendoring command, and the [test plan](test-plan.md) beside this page is the contract ledger.

It is the repository's second conforming writer. The first is the TypeScript
[parley-emit](../parley-emit/README.md); this one mirrors its shape, its lifecycle and its `inv`
derivation, and the README's last section names every place it differs.

## Lifecycle, as the writer performs it

1. Split `argv` at the first `--`, which is removed: everything after it is the tool's, untouched
   (flyingrobots/parley#103). Before it, set aside the writer's flags (`--human`, `--humanize`,
   `--dry-run`, `--schema`, `--help`, `-h`); the command is the first argument that remains, and
   only that one argument is removed (flyingrobots/parley#101); a tool with one command may omit it.
2. Classify the declared secrets of every command into flags, variables and logical sources, and
   collect the values the flags and variables carry. Choose a run id carrying none of them. A
   session carrying one is `startup.secret_in_identity`; no command named is
   `startup.unknown_command`; both are one `startup.failed` line on stderr and exit 3 (§3.2).
3. Replace `sys.stdout` and `sys.stderr` with capturing objects (§1.2). Resolve the running
   command's declared credential sources; a resolver that raises means not present.
4. Reserve the receipt (§3.1, §5, §5.2): `.parley/.gitignore` holding `*`, created whole if absent
   and never overwritten, then `.parley/receipts/<run>.jsonl` opened exclusively; otherwise the
   state directory `$XDG_STATE_HOME/parley/<repo-hash>/receipts/`, keyed as `parley-read` looks for
   it. With neither, `startup.receipt_unwritable` or `startup.secret_in_path`, exit 3.
5. Call the tool's `resolved` and `inputs` callbacks. A raise is `startup.arguments_invalid`,
   exit 3, and the reserved receipt is removed.
6. Redact `argv`, `resolved` and the input descriptors (§5.3); compute `inv` when no inputs are
   declared (§2.2).
7. Emit the bootstrap line (stdout, `seq: 0`), then the head (receipt, `seq: 1`), then any sink
   failure the bootstrap write met, then the text captured so far, then a `receipt.relocated`
   warning if the receipt went to the state directory for a reason worth saying.
8. Enforce retention for this tool (§5.1), recorded as a step.
9. For `--schema` or `--help`, emit the `command` and `schema` lines and close (§4.1, §4.2).
   Otherwise run the handler. An exception from it is an `error` line, with the traceback in the
   receipt copy only (§6).
10. Put the original `sys.stdout` and `sys.stderr` back, then close with `end` (§3.3):
    `receipt.inputs` first when inputs are declared, then the status — 2 after a reported error,
    4 after any sink failure, else 0 or what the tool passed to `run.end`.

## Exit status

| Status | When |
| --- | --- |
| 0 | The command completed and reported no error |
| 2 | The command reported an error, or an exception escaped the handler (`uncaught.exception`), or the handler called `sys.exit` with a non-zero code (`uncaught.exit`) |
| 3 | The run could not bootstrap: one `startup.failed` line on stderr, no receipt |
| 4 | stdout, stderr, the receipt or a sidecar could not be written, including a reader closing stdout early |
| other | What the tool passed to `run.end(status)`: an integer 0 to 255 other than 3, never 0 after an error |

## Discovery

`--schema` emits one `command` line per command and one `schema` line for each type the commands
emit, each error type they can produce and every message type this writer emits, then `end` with
status 0. `<command> --help` emits that command's `command` line and the schemas of its success
types and its error types. A command's error types default to `parley.error` and
`parley.startup.failed`, the reading of §4.2 decided on flyingrobots/parley#92, and the TypeScript
writer agrees. A type with no schema document is a
`schema.unavailable` warning, not a missing line.

## Retention

Per tool: only bundles whose receipt head names this tool are counted and deleted, oldest first by
modification time, with their sidecar directories (flyingrobots/parley#75). A bundle with no `end`
is deleted only after a day. A dry run deletes nothing and records what it would have deleted.

## Stray output, and what it cannot hold

Writes through `sys.stdout` and `sys.stderr` while `main` runs become `captured stray output`
steps in the receipt. Writes to descriptors 1 and 2 themselves (C extensions, `os.write`, child
processes), handlers holding the original streams, text after `end`, hard crashes and signals are
outside it; the package README lists them as the documented exceptions of spec §6.

## The schemas it ships

`scripts/sync_schemas.py` (`bun run sync-schemas` in the package) embeds `schemas/*.schema.json`
in the file between `# BEGIN SCHEMAS` and `# END SCHEMAS`, with the commit and each file's SHA-256
in `SCHEMA_SOURCE`. The suite fails when an embedded schema's text does not digest to its pin, or
when a pin differs from the file in `schemas/`. `validate_line` and `check_record` check a line
against the embedded schema for its exact pair with a bounded checker that reports a keyword it
does not implement rather than ignoring it.

## Vendoring

`python3 parley_emit.py --vendor-info` prints one `parley.tooling.vendor_info` 1.0.0 line
(`packages/parley-emit-py/vendor-info.schema.json`) carrying the SHA-256 of the file's bytes. It is
the file's own tooling, like the doctor: parseable JSON Lines, no run identity, no protocol claim.

## Not implemented

The shared history stream of spec §8 and its transforms; asynchronous callbacks; publication to a
package registry.
