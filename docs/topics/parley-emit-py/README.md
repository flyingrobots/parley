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
4. Reserve the receipt (§3.1, §5, §5.2): `.parley/.gitignore` holding `*`, and no negation that
   can re-include `receipts/` (flyingrobots/parley#109; a negation the writer cannot evaluate
   exactly counts as one, by the rule `_negation_reaches_receipts` states and the TypeScript
   writer shares: an inner `/`, a backslash, a character outside printable ASCII, a bracket
   expression that is unterminated or holds `[:`, `[=` or `[.`, or a line holding a NUL byte),
   created whole if absent and never
   overwritten, then `.parley/receipts/<run>.jsonl` opened exclusively; otherwise the
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
    4 after any sink failure or a record withheld because redaction made it invalid, else 0 or
    what the tool passed to `run.end`.

## Declared file inputs

`run.read_input(path)` is the way a handler reads a declared file input. It reads the file at the
declared path, resolved against the run's `cwd` when relative, returns the bytes, and records them
for that input. `receipt.inputs` carries the digest of those bytes, and `inv` is derived from it,
whatever the file holds when the run ends. The package
[README](../../../packages/parley-emit-py/README.md#read-a-declared-file-with-runread_input) has a
captured run of a tool that edits its input in place.

A declared file that was not read through the writer, and whose bytes were not supplied with
`run.input(path, data)`, is read by the writer when the inputs are finalised: at
`run.finalise_inputs()`, or at `end` once the handler has finished. The digest recorded is of the
file as it is then. For a tool that read the file by its own means and then rewrote it, or a file
something else changed during the run, that digest and `inv` describe bytes the tool did not
read. The run still exits 0, and the writer gives no warning.

| The handler, for a declared file | What `receipt.inputs` records |
| --- | --- |
| calls `run.read_input(path)` | the digest of the bytes returned |
| calls `run.input(path, data)` | the digest of the bytes supplied |
| calls `run.input_unreadable(path, code=...)` | `error` with that code, no digest, no `inv` |
| does none of these | the digest of the file when the inputs are finalised, or `error: input.unreadable` if it cannot be read then |

The last call for a path is the record. `read_input` on a file that cannot be read records the
input as `input_unreadable` does and raises the `OSError`. It raises `ValueError` for a path that
is not a declared input, for a `stdin` or `tree` input, and after the inputs are settled.

## A record redaction made invalid

Spec §5.3 forbids publishing a record that redaction made invalid under its declared schema
(flyingrobots/parley#131), and does not exempt a program that holds the schema and cannot
evaluate it (flyingrobots/parley#144). The writer holds every schema document it can check against, by exact
pair: the ones it ships and the ones the tool declared on its emitted and error types.

| Step | Behaviour |
| --- | --- |
| Trigger | The scrub replaced something in a record the tool emitted. A writer-built record never triggers it: the head, `end`, `redaction`, `sidecar`, `receipt.inputs`, discovery lines and the writer's own diagnostics are emitted with the writer flag, which also keeps their scalars and identity fields from being scrubbed |
| Check | Before any copy is written and before a `seq` is taken, the stream copy and, with `receipt_extra`, the receipt copy are each validated as scrubbed and as the tool handed them over. A failure the scrubbed copy has and the original did not is a conflict |
| Schema not evaluable | The pair has a schema document the checker cannot evaluate: one that uses a keyword outside its subset, a keyword whose value has the wrong shape (`enum: 5`), or a `pattern` this writer will not answer for (one the translation for Python's `re` does not cover, such as `\\p{Lu}`, a named group, a back-reference or a lookbehind of any width, or one ECMAScript itself rejects). The two writers can differ on which schemas they can evaluate, and each refuses what it cannot; where both evaluate one, they agree. No such document makes the checker throw: `check_record` answers `unsupported`, in a redaction check, in `validate_line` and when called directly. The writer cannot show the redacted record is valid, so it withholds it exactly as it withholds a conflict: one writer-built `error`, code `redaction.schema_unchecked`, with `detail` `{schema: {id, version}, redacted}`, and the call raises `ParleyRedactionUnchecked`, a `ParleyRedactionConflict` with empty `pointers`, the `redacted` pointers and `construct` (what `schema_subset_gap` reports). The construct is part of the schema, so it is on the exception and never on the line; it is left off the exception too if it would carry a declared secret value. The code means not checked: it does not say the record was invalid, and no secret was exposed, since the value was replaced first. The trigger is any redaction in such a record, even when the secret sat in an unconstrained string and the redacted record would still have been valid: nothing is established about a schema the checker did not evaluate. The remedies are to keep the declared schema within the checker's keywords (the package README lists them) or to keep declared secrets out of emitted records. Removing the `schema` document removes the refusal and the check together, which is the spec's exemption and not a fix |
| Not checked | A pair with no schema document, which spec §5.3 exempts: the record is written as before. A record the scrub did not change is never checked, whatever its schema. A record already invalid in the same way is written as before |
| Report | One writer-built `error`, code `redaction.schema_conflict`, on stderr and in the receipt. `problem` and `detail` (`schema: {id, version}`, `at`, `redacted`) name the fields by JSON Pointer and the schema pair. The checker's text is deliberately not used: it can quote the schema, and the value is the secret or sits beside it. Being writer-built, the error is not checked again, so it cannot raise another |
| Refusal | The call raises `ParleyRedactionConflict`. `main` does not turn it into `uncaught.exception`; a handler may catch it and continue |
| Status | 4, forced at `end` exactly as a sink failure forces it, whatever status the handler passes, for a conflict and for a schema that could not be evaluated alike. `run.redaction_refused` is true |

## Exit status

| Status | When |
| --- | --- |
| 0 | The command completed and reported no error |
| 2 | The command reported an error, or an exception escaped the handler (`uncaught.exception`), or the handler called `sys.exit` with a non-zero code (`uncaught.exit`) |
| 3 | The run could not bootstrap: one `startup.failed` line on stderr, no receipt |
| 4 | stdout, stderr, the receipt or a sidecar could not be written, including a reader closing stdout early; or a record was withheld because redaction made it invalid under its declared schema (`redaction.schema_conflict`) or because the writer could not evaluate that schema (`redaction.schema_unchecked`), whatever the tool passed to `run.end` |
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
is deleted only after a day, judged from the receipt as it is at the decision, and a receipt whose
size or modification time moved between the decision and the unlink is spared
(flyingrobots/parley#112). That narrows the race with a run that appends but does not close it,
and by decision no lock does: spec §5.1 treats a run with no write for a day as crashed and accepts
that such a run, appending while retention deletes its receipt, loses it. A bundle with no `end`
still counts toward the limit, so a complete one is deleted in its place.
The sidecars go only once the receipt is gone, so a receipt that cannot be unlinked keeps its
bundle whole and is not reported deleted (flyingrobots/parley#113). A dry run deletes nothing and
records what it would have deleted.

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
