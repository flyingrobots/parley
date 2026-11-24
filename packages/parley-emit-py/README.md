# parley_emit.py

A writer for the [Parley output protocol](../../spec/parley-v0.2.md) in one Python file. A tool
conforms by defining itself and running its handler under `main`; the writer owns everything the
protocol asks of a program that is not the program's own result: the bootstrap line, the receipt
and where it goes, the single sequence across streams, `inv`, redaction, sidecars, hygiene,
retention, discovery, the `--human` renderer, the top-level handler and the exit status.

It is the second conforming writer, after the TypeScript
[`@flyingrobots/parley-emit`](../parley-emit/README.md), and it is shaped like it on purpose:
`define_tool`, `main` and `Run` mirror `defineTool`, `main` and `Run`. Where the two differ, the
[last section](#how-it-differs-from-the-typescript-writer) says so.

Spec version `0.2.1`. The file's own version is `__version__` and moves with this code; each
message schema moves on its own (spec §4.4). Standard library only. Python 3.9 or later; the gate
runs the suite on 3.9. The living reference is
[docs/topics/parley-emit-py](../../docs/topics/parley-emit-py/README.md); its
[test plan](../../docs/topics/parley-emit-py/test-plan.md) is the contract ledger.

## Vendor it

There is no install. Copy the one file next to your tool and pin the copy by its digest:

```bash
cp packages/parley-emit-py/parley_emit.py path/to/your-tool/
python3 path/to/your-tool/parley_emit.py --vendor-info
```

`--vendor-info` prints one JSON line (schema: [`vendor-info.schema.json`](vendor-info.schema.json),
`parley.tooling.vendor_info` 1.0.0) whose `sha256` is the SHA-256 of the file's bytes, whose
`schemas.commit` is the commit the embedded schemas were copied from, and whose `verify` is a
`shasum -c` command that checks a copy against the digest. Record the digest beside the copy;
re-run it after an upgrade, and in your own tests if you want a changed copy to fail them. Add
`--human` for one line of prose. The file carries no other command-line surface.

The seventeen schemas at their current released versions (fifteen as released with spec `0.2.0`,
`parley.query` and `parley.lens` at the 1.1.0 released with spec `0.2.1`) are embedded in the
file, byte for byte, pinned by commit and digest (spec §4.5). `SCHEMA_SOURCE` holds the
pins; `schema_text_digests()` recomputes them from the embedded text, so a copy can check itself.

## The smallest tool

`examples/count.py`, abridged:

```python
import parley_emit as pe

tool = pe.define_tool(
    name="count", version="0.1.0",
    commands={"files": {
        "intent": "Count the regular files directly under the working directory",
        "effects": {"reads": ["<cwd>/*"], "writes": [], "network": False, "idempotent": True},
        "secrets": [],
        "emits": [{"id": "count.result", "version": "1.0.0", "schema": COUNT}],
    }},
    retention={"count": 50},
    human=lambda line: f"{line['files']} file(s)" if line.get("event") == "result" else None,
)

def interpret(args, command):  # runs before the bootstrap line
    if args:
        raise ValueError(f"{command} takes no arguments, and was given {len(args)}")
    return {"command": command, "args": []}

def files(run, args):
    names = sorted(n for n in os.listdir(run.cwd) if os.path.isfile(os.path.join(run.cwd, n)))
    run.step(f"counted {len(names)} regular file(s)", "only regular files count", {"names": names})
    run.result({"event": "result", "files": len(names)}, ("count.result", "1.0.0"))

sys.exit(pe.main(tool, ["count", *sys.argv[1:]], files, resolved=interpret))
```

Captured from `python3 examples/count.py files` on Python 3.9.6, in a directory holding exactly
two regular files, with the streams redirected to files outside it and `XDG_STATE_HOME` set, on
2026-11-23. stdout, three lines:

```jsonl
{"event":"run","t":1795397578129,"seq":0,"run":"01M830HVCGFWQPW9PME4HKH6HA","tool":"count","v":"0.1.0","inv":"638c446f866624d00aed41b516d92549f87b0197871ae5db312b7edaa8051a16","paths":{"receipt":"/private/tmp/parley-emit-py-readme.eSFw/work/.parley/receipts/01M830HVCGFWQPW9PME4HKH6HA.jsonl"},"_schema":{"id":"parley.run.bootstrap","version":"1.1.1"}}
{"event":"result","t":1795397578130,"seq":3,"run":"01M830HVCGFWQPW9PME4HKH6HA","files":2,"_schema":{"id":"count.result","version":"1.0.0"}}
{"event":"end","t":1795397578130,"seq":4,"run":"01M830HVCGFWQPW9PME4HKH6HA","status":0,"receipt":"/private/tmp/parley-emit-py-readme.eSFw/work/.parley/receipts/01M830HVCGFWQPW9PME4HKH6HA.jsonl","redacted":false,"_schema":{"id":"parley.end","version":"1.0.0"}}
```

The receipt the bootstrap line names:

```jsonl
{"event":"receipt.head","t":1795397578129,"seq":1,"run":"01M830HVCGFWQPW9PME4HKH6HA","tool":"count","v":"0.1.0","inv":"638c446f866624d00aed41b516d92549f87b0197871ae5db312b7edaa8051a16","argv":["count","files"],"resolved":{"command":"files","args":[]},"inputs":[],"effects":{"reads":["<cwd>/*"],"writes":[],"network":false,"idempotent":true,"bookkeeping":[{"op":"create","scope":"/private/tmp/parley-emit-py-readme.eSFw/work/.parley/receipts/"},{"op":"create","scope":"/private/tmp/parley-emit-py-readme.eSFw/work/.parley/.gitignore"},{"op":"delete","scope":"/private/tmp/parley-emit-py-readme.eSFw/work/.parley/receipts/"},{"op":"create","scope":"/tmp/parley-emit-py-readme.eSFw/state/parley/d1219762df8e6057/receipts/"},{"op":"delete","scope":"/tmp/parley-emit-py-readme.eSFw/state/parley/d1219762df8e6057/receipts/"}]},"_schema":{"id":"parley.receipt.head","version":"2.0.0"}}
{"event":"receipt.step","t":1795397578130,"seq":2,"run":"01M830HVCGFWQPW9PME4HKH6HA","decision":"counted 2 regular file(s)","because":"directories and special files are not files; only regular files count","detail":{"names":["a.txt","b.txt"]},"_schema":{"id":"parley.receipt.step","version":"1.0.0"}}
{"event":"result","t":1795397578130,"seq":3,"run":"01M830HVCGFWQPW9PME4HKH6HA","files":2,"_schema":{"id":"count.result","version":"1.0.0"}}
{"event":"end","t":1795397578130,"seq":4,"run":"01M830HVCGFWQPW9PME4HKH6HA","status":0,"receipt":"/private/tmp/parley-emit-py-readme.eSFw/work/.parley/receipts/01M830HVCGFWQPW9PME4HKH6HA.jsonl","redacted":false,"_schema":{"id":"parley.end","version":"1.0.0"}}
```

stderr was empty and the exit status was 0. The repository doctor reported the run conforming
(`bun run doctor --stdout ... --stderr ... --receipt ...`: `CONFORMS 0 violation(s)`). The `inv`
is the one the TypeScript writer's own README shows for its `count files`: the same question,
asked of two writers, has one identity.

Captured the same way on 2026-11-23, `count files --frobnicate` exited 3 with nothing on stdout,
no receipt, and exactly one line on stderr, which the doctor reported conforming:

```jsonl
{"event":"startup.failed","t":1795398208647,"seq":0,"run":"01M83153440W0A6PPFVMGRAK56","tool":"count","v":"0.1.0","code":"startup.arguments_invalid","problem":"the arguments could not be interpreted: files takes no arguments, and was given 1","remedy":"fix the arguments; see the command's --help","_schema":{"id":"parley.startup.failed","version":"1.0.0"}}
```

and `count files --human` printed `2 file(s)` and nothing else, exit 0.

## The surface

| Name | Job |
| --- | --- |
| `define_tool(name=, version=, commands=, retention=, sources=None, human=None)` | Checks the declaration: a non-empty name and version, at least one command, an intent and the four effects per command, a SemVer version on every emitted and error type, a positive retention count. `commands` maps a name to `{intent, effects, secrets?, emits: [{id, version, schema?}], errors?}` |
| `main(tool, argv, handler, *, cwd, env, home, stdout, stderr, session, now, inputs, resolved)` | Runs one invocation and returns the exit status. `argv` is `[tool.name, *sys.argv[1:]]`; `handler(run, args)` is called with the arguments that remain once the writer's flags and the command, the first argument, are set aside (see [Arguments and flags](#arguments-and-flags)). Nothing raised inside escapes as a traceback |
| `Run` | `result(record, schema, receipt_extra=None)`, `page(cursor, has_more, record=None, receipt_extra=None)`, `step(decision, because, detail=...)`, `warning(code, problem, **fields)`, `error(code, problem, receipt_extra=None, **fields)`, `read_input(path)`, `input(path, data)`, `input_unreadable(path, code="input.unreadable")`, `finalise_inputs()`, `end(status=None)`; `id`, `cwd`, `receipt_path`, `receipt_dir`, `dry_run`, `ended`, `status`, `sink_failed`, `redaction_refused`. A schema is `("id", "version")` or `{"id": ..., "version": ...}`; diagnostic fields are `remedy`, `remedy_target`, `measured`, `limit`, `retryable` and `detail` |
| `check_record(value, schema)`, `validate_line(line, extra=None)`, `schema_subset_gap(schema)` | The bounded JSON Schema checker (below) |
| `SCHEMAS`, `SCHEMA_SOURCE`, `schema_for(pair)`, `schema_text_digests()` | The embedded schemas and their pins |
| `compute_inv`, `canonical`, `digest_tree`, `digest_input`, `sha256` | The `inv` derivation and its parts |
| `classify_secrets`, `collect_secret_values`, `redact_argv`, `scrub`, `REDACTED` | Redaction |
| `repo_root`, `state_base`, `state_receipt_dir`, `bookkeeping_for` | Receipt placement, keyed exactly as `parley-read` looks for it |
| `ulid`, `FdSink`, `ParleyClosed`, `SCHEMA_IDS`, `SIDECAR_THRESHOLD` | Run ids, the default sink, the error raised after `end`, the writer's schema pairs, the sidecar threshold |
| `ParleyRedactionConflict`, `REDACTION_CONFLICT_CODE` | The error raised when redaction made a record invalid under its declared schema, and the code of the `error` line the writer emits for it ([below](#a-record-redaction-made-invalid)) |
| `ParleyRedactionUnchecked`, `REDACTION_UNCHECKED_CODE` | The error raised when redaction changed a record whose schema document the writer holds and cannot evaluate, and the code of its `error` line. It is a `ParleyRedactionConflict` |

## What the writer does for you

| Spec | Behaviour |
| --- | --- |
| §3.1 | Creates the receipt before announcing it; the bootstrap line is the first line on any stream, `seq: 0`, stdout only, before the handler runs |
| §5, §5.2 | `.parley/receipts/<run>.jsonl` under the initial working directory, after `.parley/.gitignore` holds a line `*` (created whole under a temporary name and linked into place if absent, never overwritten). The receipt goes to `$XDG_STATE_HOME/parley/<repo-hash>/receipts/` instead, with a `receipt.relocated` warning, when the ignore file is a user's (without `*`, or with a negation that can re-include `receipts/`, such as `!receipts/` or `!*/`; a negation the writer cannot evaluate counts as one) or when the working-directory path would carry a declared secret value; an unwritable working directory falls back silently (the bootstrap line says where). No writable location is `startup.receipt_unwritable`; a state path that would carry the secret too is `startup.secret_in_path`; both exit 3 |
| §1.3 | One counter per run, under a lock, so threads emitting at once cannot share or skip a `seq`. A record is serialised before it takes a `seq`, so one that is not JSON is raised to the tool and leaves no gap |
| §2.2 | `inv` exactly as the TypeScript writer derives it (below) |
| §5.3 | Declared flags, variables and sources replaced with `[redacted]` in `argv`, `resolved`, `inputs` and every later record before any copy leaves the process; longest secret first; a number or boolean whose JSON form is a secret becomes `[redacted]`; a key carrying one is renamed. The head's `redacted` says where; a later surfacing gets a `redaction` event; `end.redacted` aggregates. The envelope, the writer's own identity fields and the schema document a `schema` line publishes (the tool's static declaration, flyingrobots/parley#111) are never scrubbed, a run id or receipt path carrying a secret is never chosen, and a session carrying one is `startup.secret_in_identity`, exit 3. A record of the tool's that redaction made invalid under its declared schema is not published: one `redaction.schema_conflict` error replaces it and the run ends with status 4. A record redaction changed whose schema document the writer cannot evaluate is withheld the same way as `redaction.schema_unchecked` ([below](#a-record-redaction-made-invalid), flyingrobots/parley#131, flyingrobots/parley#144) |
| §5 | A receipt record over 65,536 bytes is stored as `<run>/<seq>.json` beside the receipt with a `sidecar` event in its place; if the sidecar cannot be written the record stays inline and the run closes with a `sink.sidecar_failed` error and status 4 |
| §5.1 | Retention by count, **per tool** (below) |
| §4.1, §4.2 | `--schema` and `<command> --help` are runs that emit `command` and `schema` lines and close with `end` |
| §4.3 | `--dry-run` marks the bootstrap line and head and performs no retention deletion; the handler reads `run.dry_run` |
| §6, §3.2 | An exception from the handler becomes `uncaught.exception` with the traceback in the receipt copy only (`detail.traceback`), status 2. `SystemExit` with a non-zero code is `uncaught.exit`; `KeyboardInterrupt` is `uncaught.exception`; both close a complete failed receipt with status 2. A raise from `resolved` or `inputs` before the bootstrap line is `startup.arguments_invalid`, exit 3, with the reserved receipt removed. A source resolver that raises means not present. A raising renderer is one `human.renderer_failed` warning and the default rendering from then on. A failure inside the writer itself is `uncaught.writer_failure` after the bootstrap line and `startup.writer_failed` before it. A `ParleyRedactionConflict`, a `ParleyRedactionUnchecked` included, is the exception: the writer already reported it, so it adds no `uncaught.exception` and the run closes with status 4 |
| §5.4, §3.3 | stdout and stderr are written with `os.write` on descriptors 1 and 2, the whole line: a partial write continues, and `EAGAIN` on a descriptor someone left non-blocking waits a millisecond and retries. A closed reader (`EPIPE`, `BrokenPipeError`) is a sink failure: an `error` line on the sinks still working and status 4, never a traceback. After `end` nothing is written; emitting raises `ParleyClosed` |
| §1.2 | Stray output is captured into the receipt (below) |
| §1.1 | `--human` (alias `--humanize`) renders stdout and stderr through the tool's `human` function, falling back to one line per event; the bootstrap line and a successful `end` render as nothing; the receipt is unchanged |

## Arguments and flags

The writer's own flags, `--human`, `--humanize`, `--dry-run`, `--schema`, `--help` and `-h`, are
recognised anywhere before the first `--` and set aside. **`--` ends the writer's flags**
(flyingrobots/parley#103): that first `--` is removed, and every argument after it reaches
`resolved`, `inputs` and the handler untouched, one with a writer flag's text or a second `--`
included. So a tool flag whose value is a writer flag's text goes after the `--`: `edit --note -h`
is `--help` for `edit`, while `edit -- --note -h` runs `edit` with `["--note", "-h"]`, `edit --`
gives the tool `[]`, and `edit -- a -- b` gives it `["a", "--", "b"]`. The writer cannot know which
of the tool's flags take a value, so it states this rule rather than guess. The TypeScript writer
follows the same rule.

**The first argument that remains before any `--` is the command**, and only that one argument is
removed; nothing after `--` is ever the command, so `-- edit` in a tool with more than one command
is `startup.unknown_command`, exit 3. Every other argument reaches `resolved`, `inputs` and the handler in
order, a later one with a command's text included, so `edit --reason edit` gives the tool
`["--reason", "edit"]`. In a tool with more than one command, a first argument that names none is
`startup.unknown_command`, exit 3, even when a later argument names one: the writer cannot know
which of the tool's flags take a value, so it never looks past the first position. A tool with
one command may omit its name, and then nothing is removed. The TypeScript writer follows the
same rule (flyingrobots/parley#101); the spec does not say how a command is selected.
`PARLEY_SESSION`, or the `session` argument, is carried as `session`; the writer never invents one.

The bootstrap line is the boundary for a usage error, as decided on flyingrobots/parley#91: where
a tool checks its arguments decides which side of it a mistake falls on, and the tool documents
which. Checking before it is preferred, because a mistaken call did no work and a receipt of it is
noise. With this writer that means the `resolved` callback: one that raises makes a bad argument a
startup failure, `startup.arguments_invalid`, exit 3, with no receipt, and that is what
`count.py` does, as `examples/count.ts` does. A handler that reports a bad argument with
`run.error` makes it a command error instead, exit 2, with a complete failed receipt.

## How `inv` is derived

The TypeScript writer's derivation, byte for byte, which the suite checks by computing both over
the same preimages: SHA-256, hex, over the canonical JSON (keys sorted, no whitespace, UTF-8) of

```text
{ tool, v, command, resolved, inputs: [{ path, role?, sha256 }] }
```

`resolved` and the input descriptors are the redacted ones, so a declared secret enters by name and
never by value (spec §2.2). Each input's `sha256` is over its bytes; a `tree` input digests every
regular file under it in sorted path order as `path NUL digest LF`, skipping `.parley` and the
paths in its `exclude` list. The run id, receipt path, session and clock are not in the preimage.
With no declared inputs, `inv` covers the tool, version, command and `resolved` only and is on the
bootstrap line; with inputs it arrives in `receipt.inputs` before `end`, and an unreadable input
(`input.unreadable`, or `input.unread` for a stdin input the handler never supplied with
`run.input("-", data)`) omits it. `resolved` is in the preimage, so keep it order-normalised and
free of volatile values such as the working directory.

## Declared inputs

`main`'s `inputs` callback maps the command's arguments to declared inputs,
`{"path": ..., "role": ..., "exclude": [...]}`. A relative path is resolved against the run's
working directory; an absolute path stands. Roles: a file (default), `tree` for a directory,
`stdin` for bytes the handler supplies with `run.input("-", data)`.

### Read a declared file with `run.read_input`

`run.read_input(path)` reads a declared file, returns its `bytes`, and records the digest of
exactly those bytes. Reading and recording are one step, so the receipt's digest for that input is
of what the tool consumed, whatever happens to the file afterwards. **This is the way to read a
declared file input.** `path` is the declared path, resolved as the declaration is: against the
run's `cwd` when relative.

A tool that edits a file in place, declared as its input:

```python
import os
import sys

import parley_emit as pe

tool = pe.define_tool(
    name="upcase", version="0.1.0",
    commands={
        "file": {
            "intent": "Rewrite a file in upper case, in place",
            "effects": {"reads": ["<file>"], "writes": ["<file>"], "network": False, "idempotent": True},
            "secrets": [],
            "emits": [],
        },
    },
    retention={"count": 50},
)


def handler(run, args):
    path = args[0]
    before = run.read_input(path).decode("utf-8")  # read and recorded in one step
    with open(os.path.join(run.cwd, path), "w", encoding="utf-8") as f:
        f.write(before.upper())  # the file no longer holds what was read
    run.step(f"rewrote {path} in upper case", "the receipt records the bytes read, not the bytes written", {"bytes": len(before)})


sys.exit(pe.main(tool, ["upcase", *sys.argv[1:]], handler,
                 resolved=lambda args, command: {"command": command, "file": args[0]},
                 inputs=lambda args, command: [{"path": args[0]}]))
```

Captured from that program run as `upcase file input.txt` on Python 3.9.6 on 2026-11-24, in a
directory whose `input.txt` held the six bytes `before`. Afterwards the file held `BEFORE`, the
exit status was 0, and the receipt's `receipt.inputs` line was:

```jsonl
{"event":"receipt.inputs","t":1795528119808,"seq":3,"run":"01M86X1NFY1HEVS7BT4XE8PKJP","inputs":[{"path":"input.txt","sha256":"6db7d803e74f1ffa7d8f5adc0bf95b3e15bf4c8373fffadf546227cc6c6742cb"}],"inv":"14084fa18df646f47e9511399468cb1d043d792a4f943c46b2a37f233d8fed4e","_schema":{"id":"parley.receipt.inputs","version":"1.0.0"}}
```

`6db7d803…` is the SHA-256 of `before`, the bytes read. The SHA-256 of `BEFORE`, the bytes left on
disk, is `c341c7fe…`, and it appears nowhere in the receipt. The `inv` is the one the TypeScript
writer's README shows for the same program.

**An input not read through the writer is digested when the handler finishes.** A declared file
the tool opens itself, with `open` or anything else, is read again by the writer at finalisation
(`run.finalise_inputs()`, or `end`), and the digest recorded is of the file as it is at that
moment. If the tool rewrote the file, or anything else changed it during the run, the receipt and
`inv` describe bytes the tool did not read, and the run still exits 0. The writer does not warn
about this. A tool that already holds the bytes of a declared file can record them with
`run.input(path, data)` instead; `read_input` is that, with the read included.

When the file cannot be read, `read_input` records the input with `error: input.unreadable`, as
`run.input_unreadable` does, and raises the `OSError` to the caller. It raises `ValueError` for a
path that is not a declared input, for a `stdin` input (supply it with `run.input`) or a `tree`
input (the writer digests a tree itself, at finalisation), and after the inputs are settled. The
last of `read_input`, `input` and `input_unreadable` for a path is the record.

### Unreadable inputs

When the handler itself fails to read a declared input by its own means, it calls
`run.input_unreadable(path)`, so the writer records the input as unread instead of opening the
path at finalisation and digesting bytes the program never saw (spec §2.2,
flyingrobots/parley#110); it raises `ValueError` for an undeclared path and after the inputs are
settled.

## Retention, per tool

A tool states `retention={"count": N}`. When a receipt location holds more than N bundles **whose
head names this tool**, the oldest beyond N are deleted with their sidecar directories, and the
deletion is recorded as a `receipt.step`. Another tool's receipts, a reader's included, are never
counted and never deleted; that is the decision recorded on flyingrobots/parley#75, implemented
here from the start. A receipt with no `end` is deleted only once it is more than a day old, so a
run still in flight is never a candidate. The age is judged from the receipt at the decision rather
than at the scan, and a receipt whose size or modification time moved before the unlink is spared
(flyingrobots/parley#112). That narrows the race with a run that appends. No lock closes it, by
decision: a run that writes nothing for over a day is treated as crashed, and if it then appends
while retention deletes its receipt, that receipt is lost (spec section 5.1). A bundle goes
together or not at all: the sidecars are removed only once the receipt is gone
(flyingrobots/parley#113). A dry run deletes nothing and says what it would have
deleted. Telling whose a receipt is means reading the first line of each one in the directory on
every run.

## Stray output

From the moment `main` starts until it returns, `sys.stdout` and `sys.stderr` are replaced with
objects that put whatever is written to them into the run's receipt, a line at a time, as a step
`captured stray output` with `detail: {stream, text}`. Text written before the receipt exists, by a
source resolver for instance, is held and written after the head. The originals are put back when
`main` returns. This contains `print`, `sys.stdout.buffer.write`, `logging` (whose default handler
looks `sys.stderr` up when it writes), `warnings`, `traceback.print_exc` and anything else that
writes through those two names.

What it cannot contain, stated rather than papered over (spec §6):

- **A write to descriptor 1 or 2 itself**: a C extension, `os.write(1, ...)`, a subprocess that
  inherits the descriptors. Those bytes reach the stream as they are, and a reader quarantines them
  (§1.4). Pass `stdout=subprocess.PIPE` or `DEVNULL` to a child.
- **A handler that kept the original stream**: a `logging.StreamHandler` created before `main`
  started writes where it was pointed.
- **A library that asks for the descriptor**: the capture's `fileno()` raises
  `io.UnsupportedOperation`, as `io.StringIO` does, so `faulthandler.enable()` inside a handler
  raises rather than writing around the capture.
- **Text written after `end`**, or by a handler that outlives `main`, such as a `logging` handler
  configured inside it: dropped, since nothing may follow `end`.
- **A hard crash or a signal**: a segfault in a native module, `SIGKILL`, or `SIGPIPE` if the tool
  restored its default action (Python ignores it unless told otherwise). Terminal output may be
  absent; the receipt holds whatever was written.

## The bounded checker

A Python tool has no ajv, and spec §4.4 asks every program to validate its schemas against real
output in its own tests. `validate_line(line, extra)` checks one emitted line against the schema
for its exact advertised pair: an embedded schema, or a tool-owned schema passed in `extra` keyed by
`(id, version)`. A pair it has no schema for is reported, never validated. Under it,
`check_record(value, schema)`, whose result carries the JSON Pointer of each error in `pointers`
beside the text in `errors`, implements the constructs the protocol's own schemas use (`type`,
`const`, `enum`, `required`, `properties`, `additionalProperties`, `items`, the length, size and
range bounds, `pattern`, the `json-pointer` format, `not`, `anyOf`, `allOf`, `oneOf`,
`if`/`then`/`else`) and **reports** a keyword it does not implement, walking the whole schema
before any value, rather than ignoring it. Patterns are ECMAScript patterns read by Python's `re`:
`$` is the end of input and `.` excludes the four ECMAScript line terminators, as in JSON Schema.
The suite checks it agrees with ajv on more than seven hundred samples of eleven of the
schemas and their single-field mutations, and that every embedded schema is inside the subset.

## A record redaction made invalid

Redaction can break a record's own schema: an integer field that equals a declared secret becomes
the string `[redacted]`, and a string with a `pattern`, an `enum`, a `format` or a length bound
may no longer meet it. The writer does not publish such a record (spec §5.3,
flyingrobots/parley#131), by the same rule as the TypeScript writer.

| Rule | What the writer does |
| --- | --- |
| What is checked | A record the tool emits (`result`, `page`, `step`, `warning`, `error`) in which the scrub replaced something. It is validated with the bounded checker against the schema document for its declared pair: an embedded one, or the `schema` the tool declared on the emitted or error type |
| When | Before stdout, stderr or the receipt gets any byte of it, and before a `seq` is taken. With `receipt_extra`, the stream copy and the receipt copy are both checked first |
| On a conflict | Nothing of the record is written anywhere. One `error` with the code `redaction.schema_conflict` goes to stderr and the receipt, and the call raises `ParleyRedactionConflict` |
| What the error says | Each field by JSON Pointer and the schema's `id` and `version`, in `problem` and in `detail` (`schema`, `at`, `redacted`). Never the value, the checker's message or any part of the schema |
| Exit status | 4, whatever the handler passes to `end`: a record the writer would not write is output it could not write (spec §3.4). `run.redaction_refused` is then true |
| A schema the writer cannot evaluate | A record the scrub changed, whose pair has a schema document that uses a construct outside the bounded checker's subset (above), is withheld in the same way (flyingrobots/parley#144): the writer cannot show the redacted record is valid. The code is `redaction.schema_unchecked`, `detail` is `{schema, redacted}`, and the call raises `ParleyRedactionUnchecked` |
| What is not checked | A record the scrub did not change, whatever its schema; a record redaction left valid; one that was already invalid in the same way before redaction; a type with no schema document, which spec §5.3 exempts; every writer-built record |

`main` does not report the raised `ParleyRedactionConflict` again as `uncaught.exception`. A
handler may catch it and carry on: later records are written, and the status stays 4. Its
`schema`, `pointers` and message are safe to log. `ParleyRedactionUnchecked` is a
`ParleyRedactionConflict` with no `pointers`, the replaced `redacted` pointers, and `construct`:
the first thing in the schema the checker does not implement, as `schema_subset_gap` reports it.
The construct is in the exception and its message only. It is part of the schema, so it is never
on the error line.

Captured from a tool that declares `"secrets": ["--token"]` and an integer `value`, run with
`--token 42` and emitting `{"event": "result", "value": 42}`. stdout carried the bootstrap line
and `end` with status 4, stderr this one line, and the process exited 4:

```json
{"event":"error","t":1795548595145,"seq":2,"run":"01M87GJGY87QGJ02SQAM5Z52B4","code":"redaction.schema_conflict","problem":"the result record was not published: replacing a declared secret at /value left it invalid under t.count@1.0.0 at /value","remedy":"keep a declared secret out of any field whose schema the literal [redacted] cannot satisfy: leave the field out, or declare it as an unconstrained string; the run will close with status 4","detail":{"schema":{"id":"t.count","version":"1.0.0"},"at":["/value"],"redacted":["/value"]},"_schema":{"id":"parley.error","version":"2.0.0"}}
```

To avoid it, keep a declared secret out of typed fields: leave the field out, or declare it as a
string with no `pattern`, `enum`, `format` or length bound.

The same tool with a second property declared as `{"type": "string", "format": "date-time"}`,
which the checker does not evaluate. Captured from a run with `--token 42`; stdout carried the
bootstrap line and `end` with status 4, stderr this one line, and the process exited 4:

```json
{"event":"error","t":1795557038971,"seq":2,"run":"01M87RM6VT7GQRQJ8Z4S1X0ZK5","code":"redaction.schema_unchecked","problem":"the result record was not published: a declared secret was replaced at /value, and this writer cannot evaluate the schema document it holds for t.count@1.0.0, so it cannot show the redacted record is valid under it","remedy":"keep declared secrets out of records of this type, or state the type's schema within the constructs this writer's checker evaluates (its README lists them); the run will close with status 4","detail":{"schema":{"id":"t.count","version":"1.0.0"},"redacted":["/value"]},"_schema":{"id":"parley.error","version":"2.0.0"}}
```

A tool that sees this either keeps declared secrets out of records of that type, or states the
type's schema within the checker's subset. Before this rule a schema outside the subset was
written unchecked, which published `"value":"[redacted]"` under a schema requiring an integer.

## What a receipt can contain

Everything the handler passes to `result`, `page`, `step`, `warning` and `error`, `receipt_extra`
included; the raw and resolved arguments; input paths and digests; captured stray output; the
traceback of an exception that escaped the handler; and copies of every result, error and warning.
Declared secrets are replaced before writing; an undeclared secret is not, so declare it.

A `receipt_extra` field the record also carries must hold an equal JSON value: the copies of one
event agree on every field they share (spec §1.3). A different value raises `ValueError` before
either copy is written.

## Testing

```bash
cd packages/parley-emit-py
python3 -m unittest discover -s tests     # the unittest suite, standard library only
bun run sync-schemas                       # re-embed the schemas after a schema change
```

`bun test` at the repository root runs that suite and the oracles that live in TypeScript
(`test/parley-emit-py.test.ts`): the doctor over captured runs of `examples/count.py`, `parley-read`
over the receipts they left, ajv against the checker, and `inv` against the TypeScript writer's. A
stale embedded schema fails the suite.

## How it differs from the TypeScript writer

What it omits:

- **The shared history stream of spec §8** and everything built on it: `PARLEY_HISTORY`, the daily
  segments and their retention, history transforms, `declaredProjection`, `refuseSuspectedSecrets`
  and `refuse`. §8 is informative and opt-in; a run of this writer is the run the TypeScript writer
  makes with no stream configured. `--schema` does not list `parley.history.transform`, because this
  writer never emits it.
- **Asynchronous callbacks.** The handler, `resolved`, `inputs`, source resolvers and the renderer
  are plain functions; `main` is synchronous.
- **A package registry.** It is not on PyPI; it is vendored by copying, and pinned by digest.

Where it does something different:

- **Capture is of `sys.stdout` and `sys.stderr`**, not of `console`; the limits above are this
  language's. The TypeScript writer captures `console` and cannot contain a direct descriptor write
  either.
- **Records are strict JSON.** A value `json` cannot serialise (a `datetime`, a set, an object) or a
  `NaN` is raised to the tool (and, from the handler, becomes `uncaught.exception`), where
  `JSON.stringify` silently drops `undefined` and functions. A diagnostic given a field other than
  `remedy`, `remedy_target`, `measured`, `limit`, `retryable` and `detail` raises `ValueError`;
  tool-specific fields go under `detail`.
- **Exit and interrupt.** `SystemExit` and `KeyboardInterrupt` in the handler have no TypeScript
  counterpart; they become `uncaught.exit` and `uncaught.exception`, status 2. A tool ends with a
  status of its own through `run.end(status)`.
- **A renderer that raised is not called again** for the rest of the run; the TypeScript writer
  keeps calling it and reports the first failure once.

What it does the same way: the declared secrets of every command are scrubbed and every
command's declared variables that are present are listed in `redacted.env`, while only the running
command's credential sources are resolved and listed in `redacted.sources` — scrub widely,
resolve narrowly, as decided in flyingrobots/parley#93. Retention is per tool in both, as
flyingrobots/parley#75 decided. And `--help` lists `parley.startup.failed`
among a command's error types by default, beside `parley.error`, because every command can produce
one and §4.2 asks for "every error type it can produce", as decided on flyingrobots/parley#92; the
suite checks that `count.py` and `count.ts` list the same types.
