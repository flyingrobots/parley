# @flyingrobots/parley-emit

A writer for the [Parley output protocol](../../spec/parley-v0.2.md). A tool conforms by
constructing a writer and emitting through it; the writer owns everything the protocol asks of a
program that is not the program's own result: the bootstrap line, the receipt and where it goes,
the single sequence across streams, `inv`, redaction, sidecars, retention, discovery, the
`--human` renderer, the top-level handler and the exit status.

Spec version `0.2.1`. Package version moves with this code; each message schema moves on its own
(spec §4.4). The schemas this package ships are the current released versions (fifteen as released
with spec `0.2.0`, `parley.query` and `parley.lens` at the 1.1.0 released with spec `0.2.1`), copied from
`schemas/` at the commit recorded in `src/schemas.ts`, byte-identical by test (spec §4.5).

## Install

Bun 1.2 or later. No runtime dependencies.

```bash
bun add @flyingrobots/parley-emit
```

## The smallest tool

`examples/count.ts`, abridged:

```ts
import { defineTool, main } from "@flyingrobots/parley-emit";

const tool = defineTool({
  name: "count", version: "0.1.0",
  commands: {
    files: {
      intent: "Count the regular files directly under the working directory",
      effects: { reads: ["<cwd>/*"], writes: [], network: false, idempotent: true },
      secrets: [],
      emits: [{ id: "count.result", version: "1.0.0", schema: COUNT }],
    },
  },
  retention: { count: 50 },
  human: (line) => (line.event === "result" ? `${String(line.files)} file(s)` : null),
});

const status = await main(tool, ["count", ...process.argv.slice(2)], (run) => {
  const names = regularFilesUnder(run.cwd);
  run.step(`counted ${names.length} regular file(s)`, "only regular files count", { names });
  run.result({ event: "result", files: names.length }, { id: "count.result", version: "1.0.0" });
}, { resolved: interpret }); // interpret throws on an argument, before the bootstrap line
process.exit(status);
```

Captured from `bun run examples/count.ts files` in a directory holding exactly two regular
files, with the streams redirected to files outside it, on 2026-11-22. stdout, three lines:

```jsonl
{"event":"run","t":1795352899887,"seq":0,"run":"01M81NYC9E28S33150VJB8ZP7E","tool":"count","v":"0.1.0","inv":"638c446f866624d00aed41b516d92549f87b0197871ae5db312b7edaa8051a16","paths":{"receipt":"/private/tmp/parley-emit-readme.Ra5U/work/.parley/receipts/01M81NYC9E28S33150VJB8ZP7E.jsonl"},"_schema":{"id":"parley.run.bootstrap","version":"1.1.1"}}
{"event":"result","t":1795352899890,"seq":3,"run":"01M81NYC9E28S33150VJB8ZP7E","files":2,"_schema":{"id":"count.result","version":"1.0.0"}}
{"event":"end","t":1795352899890,"seq":4,"run":"01M81NYC9E28S33150VJB8ZP7E","status":0,"receipt":"/private/tmp/parley-emit-readme.Ra5U/work/.parley/receipts/01M81NYC9E28S33150VJB8ZP7E.jsonl","redacted":false,"_schema":{"id":"parley.end","version":"1.0.0"}}
```

The receipt the bootstrap line names:

```jsonl
{"event":"receipt.head","t":1795352899887,"seq":1,"run":"01M81NYC9E28S33150VJB8ZP7E","tool":"count","v":"0.1.0","inv":"638c446f866624d00aed41b516d92549f87b0197871ae5db312b7edaa8051a16","argv":["count","files"],"resolved":{"command":"files","args":[]},"inputs":[],"effects":{"reads":["<cwd>/*"],"writes":[],"network":false,"idempotent":true,"bookkeeping":[{"op":"create","scope":"/private/tmp/parley-emit-readme.Ra5U/work/.parley/receipts/"},{"op":"create","scope":"/private/tmp/parley-emit-readme.Ra5U/work/.parley/.gitignore"},{"op":"delete","scope":"/private/tmp/parley-emit-readme.Ra5U/work/.parley/receipts/"},{"op":"create","scope":"/tmp/parley-emit-readme.Ra5U/state/parley/4b10e884505764fd/receipts/"},{"op":"delete","scope":"/tmp/parley-emit-readme.Ra5U/state/parley/4b10e884505764fd/receipts/"}]},"_schema":{"id":"parley.receipt.head","version":"2.0.0"}}
{"event":"receipt.step","t":1795352899890,"seq":2,"run":"01M81NYC9E28S33150VJB8ZP7E","decision":"counted 2 regular file(s)","because":"directories and special files are not files; only regular files count","detail":{"names":["b.txt","a.txt"]},"_schema":{"id":"parley.receipt.step","version":"1.0.0"}}
{"event":"result","t":1795352899890,"seq":3,"run":"01M81NYC9E28S33150VJB8ZP7E","files":2,"_schema":{"id":"count.result","version":"1.0.0"}}
{"event":"end","t":1795352899890,"seq":4,"run":"01M81NYC9E28S33150VJB8ZP7E","status":0,"receipt":"/private/tmp/parley-emit-readme.Ra5U/work/.parley/receipts/01M81NYC9E28S33150VJB8ZP7E.jsonl","redacted":false,"_schema":{"id":"parley.end","version":"1.0.0"}}
```

stderr was empty. The exit status was 0. The repository doctor reports the three streams
conforming (`bun run doctor --stdout ... --stderr ... --receipt ...`).

## What the writer does for you

| Spec | Behaviour |
| --- | --- |
| §3.1 | Creates the receipt before announcing it; the bootstrap line is the first line on any stream, `seq: 0`, stdout only, before the handler runs |
| §5, §5.2 | `.parley/receipts/<run>.jsonl` under the initial working directory, after `.parley/.gitignore` holds a line `*` (created if absent, linked into place whole, never overwritten). The receipt goes to `$XDG_STATE_HOME/parley/<repo-hash>/receipts/` instead, with a `receipt.relocated` warning, when the ignore file is a user's (without `*`, or with a negation that can re-include `receipts/`, such as `!receipts/` or `!*/`; a negation the writer cannot evaluate exactly counts as one: an inner `/`, a backslash, any character outside printable ASCII, a bracket expression that is unterminated or holds `[:`, `[=` or `[.` (so `![[:alpha:]]eceipts`), and any line holding a NUL byte; both writers apply the same rule) or when the working-directory path would carry a declared secret value; an unwritable working directory falls back the same way, silently (the bootstrap line says where). No writable location is `startup.receipt_unwritable`; a state path that would also carry the secret is `startup.secret_in_path`; both exit 3 |
| §1.3 | One counter for the run; copies of one event share `seq`, `t` and `event`; a receipt copy may carry more (`receiptExtra`). A `receiptExtra` field the record also carries must hold an equal JSON value, or the call throws `TypeError` before either copy is written and before a `seq` is taken; an equal shared field is written from the record (flyingrobots/parley#130) |
| §2.2 | `inv` over tool, version, command, the redacted resolved interpretation and the bytes of every declared input (see below); on the bootstrap line and head when no inputs are declared, else in `receipt.inputs` before `end`; omitted when any input is unreadable. With no declared inputs it identifies the question only, not the state of the world |
| §5.3 | Scrub widely, resolve narrowly (flyingrobots/parley#93): only the running command's credential sources are resolved and listed in `redacted.sources`, and another command's never are, while the declared flags and variables of every command, whichever command runs, are scrubbed and those present are named in `redacted.env`. Their values are replaced with `[redacted]` in `argv`, `resolved`, `inputs` and the payload of every later record, `end` included, before any copy leaves the process. Replacement is within strings, longest secret first; a number, boolean or bigint whose decimal form is a secret becomes `[redacted]` (a PIN parsed to a number is still the PIN), and a bigint beside it is written exactly ([below](#integers-beyond-the-safe-range)); an object key carrying a secret is renamed. The head's `redacted` records where; a later surfacing is recorded by a `redaction` event; `end.redacted` aggregates. The envelope, the writer's digests and the public identity a writer-built record carries (the tool's name and version, a command's name, a schema's id and version, discovery lines included, and the `code` of a diagnostic the writer itself raises, whose corruption would put an invalid line on the stream; a tool's own diagnostic is not writer-built and its `code` is scrubbed like anything else) are never scrubbed, and a writer-built scalar (`status`, `dry_run`, `network`) is never a secret. Nor are the protocol's own words in a writer-built record: its field names (`paths`, `status`, `op`), a bookkeeping entry's `op` (`create`, `append`, `delete`) and an input's `error` token (`input.unreadable`, `input.unread`). A declared secret that happens to equal one, such as `--token create`, coincides with a public word; replacing the word would publish a line its released schema rejects. Every other string in a writer-built record is scrubbed, an input's `path` and `role`, a command's `intent` and a bookkeeping `scope` included. The records the writer raises on its own account are writer-built as well (flyingrobots/parley#161): `uncaught.exception` and `uncaught.writer_failure`, the retention and history-retention steps, the projection step and the captured-console step. A declared secret equal to `code`, `problem`, `decision`, `because` or `detail` therefore neither renames a field of theirs nor has one withheld, and the text they carry from the tool (an exception's name, message and stack, a captured line, a file name) is scrubbed. A step, warning or error the tool emits is the tool's record: scrubbed in full, keys included, and checked. The schema document a `schema` line publishes is the tool's static declaration and is published as declared (flyingrobots/parley#111); every other discovery field is scrubbed: a run id or receipt path that would carry a secret is never chosen; a session that carries one is `startup.secret_in_identity`, exit 3; the tool's own name and version are public and printed as they are. A record of the tool's that redaction made invalid under its declared schema is not published: one `redaction.schema_conflict` error replaces it and the run ends with status 4 ([below](#a-record-redaction-made-invalid), flyingrobots/parley#131) |
| §5 | A receipt record over 65,536 bytes becomes a sidecar `<run>/<seq>.json` with a `sidecar` event in its place; if the sidecar cannot be written the record is kept inline, so the bundle stays complete, and the failure is a `sink.sidecar_failed` error with status 4 |
| §5.1 | Retention by count of this tool's own receipts per location (another tool's are never counted), oldest completed bundles first (a receipt whose last line is `end`, or one without an `end` older than a day, judged at the decision; a receipt that moved before the unlink is spared; no lock, so a run silent for over a day that then appends while retention deletes its receipt loses it, flyingrobots/parley#112), recorded as a `receipt.step`; never a receipt still in flight; never on `--dry-run` |
| §4.1, §4.2 | `--schema` and `<command> --help` are runs that emit `command` and `schema` lines. A command's error types default to `parley.error` and `parley.startup.failed`, since every command can produce a startup failure (flyingrobots/parley#92); a command that declares `errors` replaces the default and names both itself |
| §4.3 | `--dry-run` marks the bootstrap line and head and performs no retention deletion; the handler reads `run.dryRun` |
| §6, §3.2 | An uncaught throw in the handler, or while discovery is being emitted, becomes an `error` with code `uncaught.exception` whose stack goes to the receipt copy only; a reported error closes the run with status 2, and `end(0)` after one is refused. A record redaction made invalid, or one the writer could not show valid, is the exception: the writer has already reported it, so the `ParleyRedactionConflict` or `ParleyRedactionUnchecked` it throws adds no `uncaught.exception`, and the run closes with status 4 ([below](#a-record-redaction-made-invalid)). `main` never rejects once the receipt is reserved, and a run that reached the bootstrap line always ends with `end` (§3.3, flyingrobots/parley#161): a failure of the writer's own after that point is an `error` with code `uncaught.writer_failure` and status 2, and when the report of a failure cannot itself be built or written (a thrown value that throws when it is described), the run ends with status 4, since an error that could not be written is protocol output that could not be written (§3.4). A throw from `resolved` or `inputs` before the bootstrap line is `startup.arguments_invalid`, exit 3, with the reserved receipt removed; a source resolver that throws means the source is not present; a throwing `human` renderer is reported once as a `human.renderer_failed` warning and the default rendering is used |
| §5.4, §3.3 | The default stdout and stderr sinks deliver whole lines: a partial write continues and a full pipe (EAGAIN on a descriptor the runtime left non-blocking) waits and retries, as a blocking write would. A sink failure before `end` is an `error` on the sinks still working and status 4; a failed bootstrap write is reported after the head, so the head stays the receipt's first line; after `end` nothing is written and the status alone carries a failure; emitting after `end` throws `ParleyClosed`. A record or `receiptExtra` carrying `t`, `seq`, `run` or `_schema` is a `TypeError` |
| §1.2 | Every function on `console`, called from the moment `main` starts until it returns, is captured into the run's receipt as a step; text captured before the receipt exists is held and written after the head. This contains libraries that log through `console`; it does not contain a library that writes to a file descriptor directly, or a timer that fires after `end` (see the exceptions below) |
| §1.1 | `--human` (alias `--humanize`) renders stdout and stderr through the tool's `human` function, falling back to one line per event; the bootstrap line and a successful `end` render as nothing, so `tool --human \| gh pr comment --body-file -` posts only the tool's prose, and a failed `end` names the receipt path; the receipt is unchanged |
| §8 (informative) | An opt-in second sink: with `PARLEY_HISTORY` set or `$XDG_STATE_HOME/parley/history` present, every line of the receipt is also appended to a dated daily segment shared by every tool, repository and agent on the machine, named in `paths.history` and declared in `effects.bookkeeping`. Same bytes, so the same redaction; one whole line per write under `O_APPEND`; retention by whole segment; a stream that cannot be written is a warning and never an error, a sink failure or a different exit status. With a `history.transform` configured the stream copy is a projection of those bytes instead, opening with a `parley.history.transform` line that names it, with the envelope reattached and the body re-validated around the transform. With nothing configured, none of this happens (see below) |

## Arguments and flags

`main` takes `argv` as `[tool.name, ...process.argv.slice(2)]`: the first element names the tool
and is echoed in the head's `argv`.

The writer's own flags, `--human`, `--humanize`, `--dry-run`, `--schema`, `--help` and `-h`, are
recognised anywhere before the first `--` and set aside. **`--` ends the writer's flags**
(flyingrobots/parley#103): that first `--` is removed, and every argument after it reaches
`resolved`, `inputs` and the handler untouched, one with a writer flag's text or a second `--`
included. So a tool flag whose value is a writer flag's text goes after the `--`: `edit --note -h`
is `--help` for `edit`, while `edit -- --note -h` runs `edit` with `["--note", "-h"]`, `edit --`
gives the tool `[]`, and `edit -- a -- b` gives it `["a", "--", "b"]`. The writer cannot know which
of the tool's flags take a value, so it states this rule rather than guess. The Python writer
follows the same rule.

**The first argument that remains before any `--` is the command**, and only that one argument is
removed; nothing after `--` is ever the command, so `-- edit` in a tool with more than one command
is `startup.unknown_command`, exit 3. Every other argument reaches `resolved`, `inputs` and the handler in
order, a later one with a command's text included, so `edit --reason edit` gives the tool
`["--reason", "edit"]`. In a tool with more than one command, a first argument that names none is
`startup.unknown_command`, exit 3, even when a later argument names one: the writer cannot know
which of the tool's flags take a value, so it never looks past the first position. A tool with
one command may omit its name, and then nothing is removed. The Python writer follows the
same rule (flyingrobots/parley#101); the spec does not say how a command is selected.

`PARLEY_SESSION` in the environment, or the `session` option, is carried as `session` on the bootstrap line and head; the writer never invents one.

The bootstrap line is the boundary for a usage error (spec §3.2, flyingrobots/parley#91), and a
tool documents which side of it it checks on. A `resolved` or `inputs` callback runs before it:
one that throws makes a bad argument `startup.arguments_invalid`, exit 3, with no receipt, which
is the side the spec prefers and the one `examples/count.ts` takes. A handler that reports a bad
argument with `run.error` makes it a command error, exit 2, with a complete failed receipt.

## How this package derives `inv`

`inv` is SHA-256, hex, over the canonical JSON (keys sorted, no whitespace, UTF-8) of:

```text
{ tool, v, command, resolved, inputs: [{ path, role?, sha256 }] }
```

`resolved` is the interpretation after defaults, already redacted, so the fact that a declared
secret was supplied enters by name and its value never does (spec §2.2); the input descriptors in
the preimage are the redacted ones for the same reason, so a secret in an input path never enters
either. Each input's `sha256` is over its bytes; a `tree` input digests every regular file under
it in sorted path order as `path NUL digest LF`, skipping `.parley` directories and the paths in
its `exclude` list, so the relative names inside a tree are part of its identity and must not
carry a secret. The run id, receipt path, session and clock are not in the preimage.

What the tool supplies as `resolved` is in the preimage, so it must be order-normalised (sort
flags, resolve defaults) and free of volatile values: the working directory, the time, a process
id. The spec's own head example carries `cwd` in `resolved`; a tool that copies that will have an
`inv` that moves with the directory. With no declared inputs, `inv` covers the tool, version,
command and `resolved` only: it identifies the question, not the state of the world, and two runs
over different files will share it. A tool whose answer depends on content it does not declare as
an input should carry that content's address in `resolved`, as footprint carries the commit ids
of the range it compares. Two invocations differing only in a declared secret share an `inv`,
which is why a redacted receipt is never replayed (spec §2.3).

A `bigint` in `resolved` is canonical as its exact digits, so two questions that differ in an
integer beyond the safe range have two identities, and `5n` has the canonical form `5` has. A
`resolved` of plain JSON data has the canonical form and the `inv` it had before 0.5.0: a test
reproduces 24 identities pinned from the 0.4.0 source (`test/fixtures/inv-pinned.jsonl`). One
that holds a `Date` or another hooked value, a boxed primitive or a function moves, and a number
that is not finite has no identity; the changelog lists what breaks.

## Declared inputs

`main`'s `inputs` option maps the command's arguments to declared inputs,
`{ path, role?, exclude? }`; it may be async. A relative path is resolved against the initial
working directory; an absolute path stands, and enters the `inv` preimage as given, so prefer
relative paths and never a temporary one. Roles: a file (default), `tree` for a directory,
`stdin` for bytes the handler supplies with `run.input("-", bytes)`.

### Read a declared file with `run.readInput`

`run.readInput(path)` reads a declared file, returns its bytes as a `Buffer`, and records the
digest of exactly those bytes. Reading and recording are one step, so the receipt's digest for
that input is of what the tool consumed, whatever happens to the file afterwards. **This is the
way to read a declared file input.** `path` is the declared path, resolved as the declaration is:
against the run's `cwd` when relative.

A tool that edits a file in place, declared as its input:

```ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool, main } from "@flyingrobots/parley-emit";

const tool = defineTool({
  name: "upcase", version: "0.1.0",
  commands: {
    file: {
      intent: "Rewrite a file in upper case, in place",
      effects: { reads: ["<file>"], writes: ["<file>"], network: false, idempotent: true },
      secrets: [],
      emits: [],
    },
  },
  retention: { count: 50 },
});

const status = await main(tool, ["upcase", ...process.argv.slice(2)], (run, args) => {
  const path = args[0]!;
  const before = run.readInput(path).toString("utf8"); // read and recorded in one step
  writeFileSync(join(run.cwd, path), before.toUpperCase()); // the file no longer holds what was read
  run.step(`rewrote ${path} in upper case`, "the receipt records the bytes read, not the bytes written", { bytes: before.length });
}, {
  resolved: (args, command) => ({ command, file: args[0] }),
  inputs: (args) => [{ path: args[0]! }],
});
process.exit(status);
```

Captured from that program run as `upcase file input.txt` on 2026-11-24, in a directory whose
`input.txt` held the six bytes `before`. Afterwards the file held `BEFORE`, the exit status was 0,
and the receipt's `receipt.inputs` line was:

```jsonl
{"event":"receipt.inputs","t":1795528119743,"seq":3,"run":"01M86X1NDVF3YERXCQC6RS4TZZ","inputs":[{"path":"input.txt","sha256":"6db7d803e74f1ffa7d8f5adc0bf95b3e15bf4c8373fffadf546227cc6c6742cb"}],"inv":"14084fa18df646f47e9511399468cb1d043d792a4f943c46b2a37f233d8fed4e","_schema":{"id":"parley.receipt.inputs","version":"1.0.0"}}
```

`6db7d803…` is the SHA-256 of `before`, the bytes read. The SHA-256 of `BEFORE`, the bytes left on
disk, is `c341c7fe…`, and it appears nowhere in the receipt.

**An input not read through the writer is digested when the handler finishes.** A declared file
the tool opens itself, with `readFileSync` or anything else, is read again by the writer at
finalisation (`run.finaliseInputs()`, or `end`), and the digest recorded is of the file as it is
at that moment. If the tool rewrote the file, or anything else changed it during the run, the
receipt and `inv` describe bytes the tool did not read, and the run still exits 0. The writer does
not warn about this. A tool that already holds the bytes of a declared file can record them with
`run.input(path, bytes)` instead; `readInput` is that, with the read included.

When the file cannot be read, `readInput` records the input with `error: input.unreadable`, as
`run.inputUnreadable` does, and throws the file system's error to the caller. It throws
`TypeError` for a path that is not a declared input, for a `stdin` input (supply it with
`run.input`) or a `tree` input (the writer digests a tree itself, at finalisation), and after the
inputs are settled. The last of `readInput`, `input` and `inputUnreadable` for a path is the
record.

### Unreadable inputs

An input the writer cannot read is recorded with `error: input.unreadable`; a stdin input never
supplied is `input.unread`. Either omits `inv`. When the handler itself fails to read a declared
input by its own means, it calls `run.inputUnreadable(path)` (optionally with its own code; a
code is never scrubbed, so one that carries a declared secret value is recorded as
`input.unreadable`), so
the writer records the input as unread instead of reading the path at finalisation and digesting
bytes the program never saw (spec §2.2, flyingrobots/parley#110). It throws for a path that is
not a declared input, and after the inputs are settled.

### Trees

A `tree` must not contain a credential source (spec §2.2: its bytes must not reach `inv` through
a directory digest). Name such files in `exclude`, as relative paths under the tree; if you cannot
name them, do not declare the tree. The writer's own `.parley` directory is always skipped, so the
working directory can be a tree without the receipts moving `inv` on every run.

## Retention

A tool states its policy as `retention: { count }` and the writer enforces it: when a location
holds more than `count` of **this tool's** receipts, the oldest bundles beyond it are deleted,
receipt and sidecar directory together, and the deletion is recorded. A receipt is this tool's
when its first line is a `receipt.head` naming it. Another tool's receipts, a reader's among
them, are never counted and never deleted, and a file with no readable head is left alone.

## A record redaction made invalid

Redaction can break a record's own schema: an integer field that equals a declared secret becomes
the string `[redacted]`, and a string with a `pattern`, an `enum`, a `format` or a length bound
may no longer meet it. The writer does not publish such a record (spec §5.3,
flyingrobots/parley#131).

| Rule | What the writer does |
| --- | --- |
| What is checked | A record the tool emits (`result`, `page`, `step`, `warning`, `error`) in which the scrub replaced something. It is validated against the schema document for its declared pair: one the package ships, or the `schema` the tool declared on the emitted or error type |
| When | Before stdout, stderr or the receipt gets any byte of it, and before a `seq` is taken. With `receiptExtra`, the stream copy and the receipt copy are both checked first |
| On a conflict | Nothing of the record is written anywhere. One `error` with the code `redaction.schema_conflict` goes to stderr and the receipt, and the call throws `ParleyRedactionConflict` |
| What the error says | Each field by JSON Pointer and the schema's `id` and `version`, in `problem` and in `detail` (`schema`, `at`, `redacted`). Never the value, the checker's message or any part of the schema |
| Exit status | 4, whatever the handler passes to `end`: a record the writer would not write is output it could not write (spec §3.4). `run.redactionRefused` is then true |
| A schema the writer cannot evaluate | A record the scrub changed, whose pair has a schema document that uses a construct outside [the checker's subset](#re-validating-without-a-dependency), is withheld in the same way (flyingrobots/parley#144): the writer cannot show the redacted record is valid. The code is `redaction.schema_unchecked`, `detail` is `{schema, redacted}`, and the call throws `ParleyRedactionUnchecked` |
| What is not checked | A record the scrub did not change, whatever its schema; a record redaction left valid; one that was already invalid in the same way before redaction; a type with no schema document, which spec §5.3 exempts; every writer-built record, which stays valid because its scrub leaves the protocol's own words alone (the §5.3 row [above](#what-the-writer-does-for-you)) |

`main` does not report the thrown `ParleyRedactionConflict` again as `uncaught.exception`. A
handler may catch it and carry on: later records are written, and the status stays 4. Its
`schema` and `pointers` are safe to log, as is its message: they are the published line's
`detail.at` and `problem`, scrubbed as the line is, so a pointer that names a property the scrub
renamed reads `/[redacted]` in both. `ParleyRedactionUnchecked` is a
`ParleyRedactionConflict` with no `pointers`, the replaced `redacted` pointers, and `construct`:
the first thing in the schema the checker does not implement, as `schemaSubsetGap` reports it.
The construct is in the exception and its message only. It is part of the schema, so it is never
on the error line.

Captured from a tool that declares `secrets: ["--token"]` and an integer `value`, run with
`--token 42` and emitting `{ event: "result", value: 42 }`. stdout carried the bootstrap line and
`end` with status 4, stderr this one line, and the process exited 4:

```json
{"event":"error","t":1795548544442,"seq":2,"run":"01M87GGZDKRYAZM8SN8SR2BXB1","code":"redaction.schema_conflict","problem":"the result record was not published: replacing a declared secret at /value left it invalid under t.count@1.0.0 at /value","remedy":"keep a declared secret out of any field whose schema the literal [redacted] cannot satisfy: leave the field out, or declare it as an unconstrained string; the run will close with status 4","detail":{"schema":{"id":"t.count","version":"1.0.0"},"at":["/value"],"redacted":["/value"]},"_schema":{"id":"parley.error","version":"2.0.0"}}
```

To avoid it, keep a declared secret out of typed fields: leave the field out, or declare it as a
string with no `pattern`, `enum`, `format` or length bound.

The same tool with a second property declared as `{ type: "string", format: "date-time" }`,
which the checker does not evaluate. Captured from a run with `--token 42`; stdout carried the
bootstrap line and `end` with status 4, stderr this one line, and the process exited 4:

```json
{"event":"error","t":1795557571231,"seq":2,"run":"01M87S4EMT1EWW5E0TFAQ39MB2","code":"redaction.schema_unchecked","problem":"the result record was not published because it could not be checked: a declared secret was replaced at /value, and this writer cannot evaluate the schema document it holds for t.count@1.0.0, so the redacted record was not validated against it","remedy":"keep the type's declared schema within the keywords this writer's checker evaluates (its README lists them), or keep declared secrets out of records of this type; the record was not shown to be invalid, and the value was replaced, not exposed; the run will close with status 4","detail":{"schema":{"id":"t.count","version":"1.0.0"},"redacted":["/value"]},"_schema":{"id":"parley.error","version":"2.0.0"}}
```

`redaction.schema_unchecked` means **not checked**. It does not mean the record was invalid, and
it does not mean a secret was exposed: the value was replaced before the refusal, and the line
carries neither it nor any part of the schema.

**The trigger, exactly:** any redaction in a record whose declared schema document uses a keyword
outside the list below is withheld, even when the redacted record would still have been valid, for
example a token inside an unconstrained string. Before this rule such a record was published with
status 0, unchecked, which is how `"value":"[redacted]"` went out under a schema requiring an
integer.

The keywords the checker evaluates: `type`, `const`, `enum`, `required`, `properties`, `additionalProperties`, `items` (one schema, not a tuple), `minItems`, `maxItems`, `minLength`, `maxLength`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `minProperties`, `maxProperties`, `pattern`, `format` with the value `json-pointer`, `not`, `anyOf`, `allOf`, `oneOf`, `if`, `then`, `else`, and the annotations `$schema`, `$id`, `$anchor`, `$comment`, `title`, `description`, `examples`, `default`, `deprecated`, `readOnly`, `writeOnly`. Anything else, an empty `$defs` included, makes the
whole document one the writer cannot evaluate. So does a keyword whose value has the wrong shape
(`enum` that is not a list, `required` that is not a list of strings, `properties` that is not an
object, a `type` that is not a type name or a list of them, a length or size bound that is not a
non-negative integer, a range bound that is not a number, `anyOf`, `allOf` or `oneOf` that is not
a list, a subschema that is neither an object nor a boolean), and so does a `pattern` this writer
will not answer for. A `pattern` is read as JSON Schema says, as an ECMAScript regular expression
with the `u` flag, by the runtime's own engine. One the engine rejects with that flag (a stray `(`,
or `\-` outside a class, which only the looser non-Unicode reading accepts) and one with an
inline-flag group (`(?i)`, `(?i:…)`), which engines differ on, are not evaluated. In each case the
answer is `redaction.schema_unchecked` and status 4; no engine message and no part of the schema
is on the line.

**The two writers can differ on which schemas they can evaluate.** The Python writer translates
a pattern for Python's `re` and refuses what it cannot translate faithfully: `\p{…}`, a named
group, a back-reference and a lookbehind that is not of fixed width are evaluated here and are
`redaction.schema_unchecked` there. Where both evaluate a schema they give the same verdict, and
an unevaluable schema is refused by the writer that cannot evaluate it, never guessed at.

There are two remedies:

- keep the declared schema within those keywords; or
- keep declared secrets out of the records the tool emits.

Deleting the `schema` document from the declaration is not a fix. It removes the refusal and the
check together, because spec §5.3 exempts a program that holds no schema document for the pair:
the record is then published with `[redacted]` in it and nothing has established that it is valid.

## Integers beyond the safe range

A JSON number is a decimal of any size, and JavaScript's number is a double: it holds every
integer from -9007199254740991 to 9007199254740991 and not every integer beyond. A 64-bit id does
not fit. Pass such an integer as a `bigint`, and the writer writes it as the JSON number it is:
exact unquoted digits, never a string and never with an `n`.

```ts
run.result({ event: "row", id: 9007199254740993n, amount: 0.1 }, { id: "ledger.row", version: "1.0.0" });
```

Captured from that call, the stdout line; the receipt's line is the same bytes:

```jsonl
{"event":"row","t":1795576112342,"seq":2,"run":"01M88AT96EYT1522W75SDBMSPX","id":9007199254740993,"amount":0.1,"_schema":{"id":"ledger.row","version":"1.0.0"}}
```

Before 0.5.0 the call threw `TypeError: JSON.stringify cannot serialize BigInt.` and the run ended
with `uncaught.exception` and status 2, unless the process had installed a `toJSON` on
`BigInt.prototype`, in which case the `bigint` was written as what that hook returned (a quoted
string, with the common polyfill). From 0.5.0 that hook is never asked: a `bigint` is written as
its digits whatever the process has installed.

| Where | What happens to a `bigint` |
| --- | --- |
| stdout, stderr, the receipt | The same exact digits on each: one serialiser writes every copy |
| A sidecar | The stored bytes hold the digits, and the `sidecar` event's `bytes` and `sha256` describe those bytes |
| The shared history stream | The receipt's bytes. With a transform, the receipt line is parsed exactly first, so the transform is handed a `bigint` and what it returns is written exactly |
| `resolved`, `inv`, `canonical` | Exact digits in the head and in the canonical form |
| Redaction | A `bigint` whose digits are a declared secret becomes `[redacted]`; one beside another redacted field is untouched |
| The post-redaction check | A JSON number and an integer, decided by exact comparison ([below](#a-bigint-under-a-schema)) |
| `--human` | The default rendering holds the digits; a tool's renderer is handed the `bigint` |
| `seq`, `t`, `status` | Always numbers. `run.end(1n)` throws `TypeError` |

A `bigint` inside the safe range is the same JSON number a number is: `5n` is written `5`.

### Reading the text back: `parseExact` and `exactJson`

`JSON.parse` rounds on the way in, so a consumer that parses a line with it has
`9007199254740992` where the line says `9007199254740993`. The writer exports the pair that does
not, and uses it wherever it reads its own text:

```ts
import { exactJson, parseExact } from "@flyingrobots/parley-emit";

const parsed = parseExact(line);
if (parsed.ok) exactJson(parsed.value);   // the same JSON value, every integer exact; a spelling may change (1e21 is written as 22 digits, 5.0 as 5)
else parsed.tokens;                       // the numbers that could not be held, as written
```

`parseExact` decides each number from its text:

| The number | Held as | Examples |
| --- | --- | --- |
| An integer from -9007199254740991 to 9007199254740991, however spelt | `number` | `5`, `5.0`, `5e0`, `1e3`, `120e-1` |
| An integer outside that range, however spelt | `bigint`, always, even where a double could hold it | `9007199254740992`, `9007199254740993.0`, `9.007199254740993e15`, `1e21`, `1e400` |
| Not an integer, and its decimal value equals that of the number's standard JSON serialisation (what `JSON.stringify` writes) | `number` | `0.1`, `0.10`, `1e-1`, `0.30000000000000004` |
| Anything else | not held: `ok: false`, and the number is in `tokens` | `0.10000000000000001`, `0.1000000000000000055`, `1e-400`, an integer of more than 4,096 digits |

The third row is the owner's ruling on flyingrobots/parley#173: `0.1` and `0.10000000000000001`
round to one double and are two decimals, so the second is not accepted as the first. Accepting
`0.1` does not claim it has an exact binary form; it means reading it and writing it back
preserves the decimal the text states. This makes integers exact. It does nothing for a decimal
with more digits than a double returns: carry such a value as a string.

`MAX_EXACT_DIGITS` is 4,096, an implementation limit and not a property of JSON. A longer token,
or one with an enormous exponent (`1e1000000000`), is classified from its length without being
built. `parseExact` throws exactly when `JSON.parse` throws; for a text with no such number it
returns `JSON.parse`'s own value. When it returns `ok: false`, `partial` is the value with the
symbol `UNREPRESENTABLE` where each such number was, for reading the fields beside it.
`holdsExact(value)` says whether a value holds a `bigint` at any depth.

The same rules are pinned as data in the repository's
[numeric corpus](../../conformance/numbers/README.md), which this package's suite runs through a
real run, case by case.

### A bigint under a schema

`checkRecord`, which the writer uses after a redaction and after a history transform, treats a
`bigint` as a JSON number and an integer and never converts it to check it. `type`, `const`,
`enum`, `minimum`, `maximum`, `exclusiveMinimum` and `exclusiveMaximum` are decided by exact
comparison: `9007199254740993n` is above a `maximum` of 9007199254740991, and `5n` satisfies
`const: 5`.

One case it cannot decide. A schema document in memory holds its numbers as doubles, and one
beyond the safe range may be a rounded reading of the schema's text: `maximum:
18446744073709551615` loads as 18446744073709551616. An integer beyond the safe range beside
such a number would be judged against a bound the schema never stated, so the checker answers
`unsupported`. For a record redaction changed that is `redaction.schema_unchecked`: not checked,
which is not the same as invalid. A `bigint` inside the safe range is decided against any bound.

### What the writer refuses

- **A `bigint` of more than 4,096 digits.** The emitting call throws `TypeError` before a `seq`
  is taken and nothing is written; `resolved` holding one is `startup.arguments_invalid`, exit 3;
  a transform's body holding one is withheld as `history.transform_invalid`. The writer does not
  write a number its own parser could not read back.
- **A `bigint` exit status.** `run.end(1n)` throws `TypeError`; through `main` that is an
  `uncaught.exception` line and status 2.
- **Receipt text it cannot hold exactly, in front of a transform.** No emission writes such text.
  If it ever met some, the writer would neither hand the transform a rounded record nor append
  the line past the transform: it withholds the line from the stream and warns with
  `history.number_unrepresentable`. The receipt is unaffected.

### Five decisions the owner may overrule

- **The oversized `bigint` is refused, not written.** Writing it would be exact too, and the
  reader would then hold the line back. Refusing keeps the writer inside what its parser reads.
- **A number the tool passed beyond the safe range reaches a transform as a `bigint`.** `2 ** 53`
  is written `9007199254740992`, and the transform is handed `9007199254740992n`, because the
  rule is decided from the text. A transform written for numbers sees a type change for such
  values, and the stream copy of `1e21` is spelt as 22 digits.
- **The undecidable bound is "unchecked" only for an integer beyond the safe range.** A stricter
  rule would refuse to compare any `bigint` with a schema number beyond the safe range.
- **`inv` is the identity of `resolved` as the head writes it**, from 0.5.0: a `Date` is its
  string. Before, a value with a `toJSON` hook was identified by its own keys, so two dates
  shared an `inv`. The `inv` of a `resolved` holding such a value moves; plain JSON data keeps
  its `inv`.
- **`NaN`, `Infinity` and `-Infinity` are refused**, from 0.5.0 (flyingrobots/parley#177).
  Before, they were written as `null`. An emitting call that holds one, at any depth, throws
  `TypeError` before a `seq` is taken; `resolved` holding one is `startup.arguments_invalid`; a
  transform's body holding one is withheld. Leave the field out, write `null` yourself, or carry
  the value as a string.

## What a receipt can contain

Everything the handler passes to `result`, `step`, `warning` and `error`, the raw and resolved
arguments, input paths and digests, captured console text, and copies of every result. Declared
secrets are replaced before writing; an undeclared secret is not, so declare it.

What is replaced is a declared value where it occurs inside one string, where it equals the
decimal form of a number, a boolean or a `bigint`, or where it occurs inside an object key. No
other form of the value is recognised: the value split across two fields, parsed into parts (a
JSON credential emitted as an object), re-encoded (base64, URL-encoded, escaped inside another
string), hashed or truncated. Keeping those out of a record is the tool's. One re-encoding is recognised:
the spelling a secret takes inside JSON text (a quote as `\"`, a newline as `\n`), because the
writer itself encodes captured console output of an object that way.

The event name is envelope and is never redacted. A result whose event name carries a declared
value is refused with a `TypeError`, and so is a page record that carries an `event` of its own.

## The shared history stream

Spec §8, which is **informative**: a layer that consumes the format. The dependency runs one way.
Nobody needs this to use a conforming tool, and with no stream configured the writer behaves
exactly as it did before the stream existed — no extra path on the bootstrap line, no extra
bookkeeping, no file, no warning, no change to the exit status.

Turn it on in one of two ways:

| | |
| --- | --- |
| `PARLEY_HISTORY=/abs/dir` | That directory, created if absent, owner-only |
| `$XDG_STATE_HOME/parley/history` exists | Used when `PARLEY_HISTORY` is unset, so you opt in once with `mkdir -p` and never by surprise |
| `PARLEY_HISTORY=off` | Off, even when the state directory exists (`0`, `false`, `no`, `none` and empty do the same) |
| `PARLEY_HISTORY_DAYS=N` | How many daily segments to keep, today's included; the default is 14 |

What reaches it is configured in code, not by the environment: `MainOptions.history` takes a sink,
`null`, or `{ sink?, transform?, name? }`, and the transform is the subject of
[its own section below](#a-transform-on-the-stream-copy).

What the stream receives is **the bytes of the local receipt**, each line appended as the receipt
takes it: the head, every reasoning step, every `redaction` and `sidecar` event, every copy of a
result, error and warning, and `end`. The bootstrap line names the segment it is writing to
alongside the receipt, under the `paths.history` this package documents (§3.1 defines `receipt`
and lets a program add paths of its own), and the head declares the stream in
`effects.bookkeeping` as `create`, `append` and `delete` scopes.

Two tools, two repositories, two agents, one segment. Captured from `count` 0.1.0 in one
repository under `PARLEY_SESSION=ses_agent_one` and `greet` 0.3.1 in another under
`ses_agent_two`, sharing one `PARLEY_HISTORY`, on 2026-11-22. The repository doctor reports both
runs conforming. Their two `receipt.head` lines, as the segment holds them:

```jsonl
{"event":"receipt.head","t":1795386946090,"seq":1,"run":"01M82PDCH4QHRWVEWYJK07T512","tool":"count","v":"0.1.0","inv":"638c446f866624d00aed41b516d92549f87b0197871ae5db312b7edaa8051a16","session":"ses_agent_one","argv":["count","files"],"resolved":{"command":"files","args":[]},"inputs":[],"effects":{"reads":["<cwd>/*"],"writes":[],"network":false,"idempotent":true,"bookkeeping":[{"op":"create","scope":"/private/tmp/parley-history.SLUQ/repo-a/.parley/receipts/"},{"op":"create","scope":"/private/tmp/parley-history.SLUQ/repo-a/.parley/.gitignore"},{"op":"delete","scope":"/private/tmp/parley-history.SLUQ/repo-a/.parley/receipts/"},{"op":"create","scope":"/tmp/parley-history.SLUQ/state/parley/8a2e93acd522d682/receipts/"},{"op":"delete","scope":"/tmp/parley-history.SLUQ/state/parley/8a2e93acd522d682/receipts/"},{"op":"create","scope":"/tmp/parley-history.SLUQ/history/"},{"op":"append","scope":"/tmp/parley-history.SLUQ/history/2026-11-22.jsonl"},{"op":"delete","scope":"/tmp/parley-history.SLUQ/history/"}]},"_schema":{"id":"parley.receipt.head","version":"2.0.0"}}
{"event":"receipt.head","t":1795386946127,"seq":1,"run":"01M82PDCJ8A47H44PWS0XHGA6Q","tool":"greet","v":"0.3.1","inv":"af313858639aa04f3d587b63ac15db6066c7377a70e4539650a45ae4b8e12337","session":"ses_agent_two","argv":["greet","hello"],"resolved":{"command":"hello","args":[]},"inputs":[],"effects":{"reads":[],"writes":[],"network":false,"idempotent":true,"bookkeeping":[{"op":"create","scope":"/private/tmp/parley-history.SLUQ/repo-b/.parley/receipts/"},{"op":"create","scope":"/private/tmp/parley-history.SLUQ/repo-b/.parley/.gitignore"},{"op":"delete","scope":"/private/tmp/parley-history.SLUQ/repo-b/.parley/receipts/"},{"op":"create","scope":"/tmp/parley-history.SLUQ/state/parley/71a5d393d36afaa2/receipts/"},{"op":"delete","scope":"/tmp/parley-history.SLUQ/state/parley/71a5d393d36afaa2/receipts/"},{"op":"create","scope":"/tmp/parley-history.SLUQ/history/"},{"op":"append","scope":"/tmp/parley-history.SLUQ/history/2026-11-22.jsonl"},{"op":"delete","scope":"/tmp/parley-history.SLUQ/history/"}]},"_schema":{"id":"parley.receipt.head","version":"2.0.0"}}
```

The whole segment, eight lines, sorted by `t` and `seq` and abridged to the fields a timeline
reads:

```text
2026-11-22T22:35:46.090Z  01M82PDCH4…  receipt.head  count  ses_agent_one
2026-11-22T22:35:46.090Z  01M82PDCH4…  receipt.step         counted 2 regular file(s)
2026-11-22T22:35:46.090Z  01M82PDCH4…  result
2026-11-22T22:35:46.090Z  01M82PDCH4…  end
2026-11-22T22:35:46.127Z  01M82PDCJ8…  receipt.head  greet  ses_agent_two
2026-11-22T22:35:46.127Z  01M82PDCJ8…  receipt.step         greeted the caller
2026-11-22T22:35:46.127Z  01M82PDCJ8…  result
2026-11-22T22:35:46.128Z  01M82PDCJ8…  end
```

Every line carries its own `run` (§1.3), so a line read out of the shared segment is attributable
without state, and `(run, seq)` finds the rest of its run.

### Appending under concurrent writers

The segment is opened `O_APPEND` and **one whole line goes out in one write**, which is what
orders this writer's line against every other writer's and keeps either from splitting the other.
A write that reports fewer bytes than the line is **abandoned rather than continued**: continuing
would let another process's append land inside this line, which is the failure mode worth
designing out. The stream is then dropped for the rest of the run and the failure is reported
once.

Two honest limits. The single-write guarantee is a property of local filesystems, not of POSIX:
put the stream on a local disk, not on NFS. And if a line is ever torn anyway, by a signal or a
full disk mid-write, it is one unparseable line in an otherwise fine file — a reader quarantines
it and reports it (§1.4) rather than losing the segment.

### Retention, by whole segments

The stream is one file per UTC day, `2026-11-22.jsonl`, and retention **deletes whole segments**:
it keeps `PARLEY_HISTORY_DAYS` of them, today's included, and unlinks the rest, recording the
deletion as a `receipt.step`. An append-only file with concurrent writers cannot be expired by
rewriting it, which is the whole reason the segments are dated; with `days` at least 1, today's
segment is never a candidate and the newest deletable one is already `days` days old, so no run
is holding it open. A dry run deletes nothing and says what it would have deleted.

`PARLEY_HISTORY_DAYS` is an integer from 1 to 36,500; anything else, including a window so wide
that its own start date stops being a date, falls back to 14, because a retention window is not
worth failing a run over. A run that crosses midnight keeps writing to the segment it opened.

### What the stream can contain, and why credentials cannot

**The stream is the receipt's bytes, so a credential cannot reach it unless it reached the receipt
first.** Every declared secret is replaced with `[redacted]` before any copy of a record leaves
the process (§5.3), and the sink is handed the same string the receipt was handed — not a
re-serialisation, not a second pass with its own idea of what a secret looks like. That is the
guarantee by construction, and the only one worth making: a stream whose bytes differed from the
receipt's would no longer be evidence of the same run.

What is left to protect is reach rather than content, because the same bytes now live longer and
in one place:

- The directory is created `0700` and segments `0600`, so another user on the machine cannot read
  the timeline.
- A record stored as a sidecar reaches the stream as its `sidecar` event, never as its stored
  bytes: the large payloads stay in the repository they came from.
- Nothing is sent anywhere. The stream is a local file; cross-machine sync is not part of it.

The stream's own path gets the rule the receipt's path gets: one that carries a declared secret
value is never chosen, because the bootstrap line prints it. The receipt has nowhere else to go
and fails startup; the stream is optional, so it yields — one `history.unavailable` warning and
the run carries on with no stream. The field name `history` is checked the same way, since a
secret that is a substring of it would rename the key the line prints.

The limit to be clear about: an **undeclared** secret is exactly as exposed in the stream as in
the receipt, for longer and across repositories. Declaring it is the fix, as it always was —
[`refuseSuspectedSecrets`](#refusing-a-line-that-looks-like-it-carries-a-credential) is the net
under it, and refuses a line that looks like it carries one rather than claiming to clean it.

### A broken stream never breaks a run

A path that cannot be opened is one `history.unavailable` warning; an append that fails is one
`history.write_failed` warning and the stream is dropped. Neither is an error, neither is a sink
failure, and neither changes the exit status: §8 is informative and opt-in, so the extra sink
cannot be the thing that fails the program. The receipt is the record; the stream is a
convenience.

### A transform on the stream copy

A sink is an observer with its own aperture. The receipt sink has the identity projection; the
shared timeline may need a narrower one, because a path, a hostname or a repository name that is
fine in a local receipt can be wrong on a stream other people and tools read. The transform is
that aperture, and it is configured **in code**:

```ts
const dropNames: HistoryTransform = (rec) => {
  if (rec.event !== "receipt.step") return rec;
  const { detail: _detail, ...rest } = rec;
  return rest;
};

const status = await main(tool, ["count", ...process.argv.slice(2)], handler, {
  history: { transform: dropNames, name: "drop-step-detail" },
});
```

It is handed the parsed record the receipt already holds — redacted, as §5.3 left it — and returns
a record to put on the stream or **nothing** to withhold the line. There is no environment
variable naming a module to execute, deliberately: a program that reads its own output policy out
of the environment can be made to run code by whoever sets it.

**The writer enforces the contract around it.** Nothing the transform does can put an invalid line
or a changed envelope on the shared timeline:

| Rule | Behaviour |
| --- | --- |
| The envelope is not the transform's | `event`, `t`, `seq`, `run` and `_schema` are taken off whatever it returns and the receipt line's are put back, so the two copies of one event agree on all five (§1.3). It may read them; it cannot change them |
| The body is re-validated | Against the schema for its **exact** advertised pair (§4.5): the schemas this package ships, plus the schema the tool declared on the emitted or error type (§4.2) |
| An unverifiable line is withheld | A pair this writer holds no schema document for, or one whose schema uses a construct the checker does not implement, is `history.transform_uncheckable`. An unchecked projection is never passed off as a checked one |
| Everything that goes wrong is a warning | A throw is `history.transform_failed`; a body that no longer validates is `history.transform_invalid`; a body that carries a declared secret value the writer had already replaced is `history.transform_unredacted`. Each names the withheld `seq`, goes to stderr and the receipt, and leaves the exit status exactly where it was (§6.1) |

**The stream copy says it is a projection.** Its first line for the run is a
`parley.history.transform` naming the transform and the SHA-256 of its source text as the runtime
renders it. Captured from the `count` example above with `dropNames` configured, on 2026-11-22:

```jsonl
{"event":"history.transform","t":1795390370293,"seq":1,"run":"01M82SNWFCYTA4NZ7K43TESPAT","name":"drop-step-detail","sha256":"3d6f8595191136c54884fe832e0fb0242116bf967441074e7c0cf577108319f3","_schema":{"id":"parley.history.transform","version":"1.0.0"}}
```

The digest is honestly what it says: a digest of **source text as the runtime renders it**, not of
a build. Two transforms with different source differ; one function closing over different values
has the same source and the same digest, so name the configuration when that distinction matters.

That line reaches the stream and no other sink, so it takes a `seq` the receipt has no line at. The
receipt accounts for the gap rather than leaving it unexplained — the same run's receipt, whose
step at `seq 4` still carries the names the stream copy dropped:

```jsonl
{"event":"receipt.step","t":1795390370294,"seq":3,"run":"01M82SNWFCYTA4NZ7K43TESPAT","decision":"the shared stream's copy of this run is a projection by drop-step-detail","because":"a history transform is configured, so the stream copy is narrowed and says so: seq 1 is its parley.history.transform line, which reaches the stream alone and is why this receipt has no line at that seq. The transform's source digests to 3d6f8595191136c54884fe832e0fb0242116bf967441074e7c0cf577108319f3. The receipt is never projected (§8, informative)","_schema":{"id":"parley.receipt.step","version":"1.0.0"}}
{"event":"receipt.step","t":1795390370294,"seq":4,"run":"01M82SNWFCYTA4NZ7K43TESPAT","decision":"counted 2 regular file(s)","because":"directories and special files are not files; only regular files count","detail":{"names":["b.txt","a.txt"]},"_schema":{"id":"parley.receipt.step","version":"1.0.0"}}
```

Withholding leaves a `seq` gap on the stream and nowhere else. `bun run doctor --history
SEGMENT.jsonl` reads a segment and reports both, here for a `what-ran` transform that withholds
every `receipt.step`:

```text
PROJECTION  01M82SPNTW39HDZABES1HFYRAC  what-ran  5dde666fc322…  (history:1)
GAP         01M82SPNTW39HDZABES1HFYRAC  seq 3 is not in this copy
GAP         01M82SPNTW39HDZABES1HFYRAC  seq 4 is not in this copy
SEGMENT     4 line(s); 1 run(s), 1 projected, 2 gap(s), 0 without end, 0 unparseable
```

**With no transform configured none of this happens**: no opening line, no step, no projection and
no difference in any byte. A transform configured with no stream is equally inert.

#### Re-validating without a dependency

This package has no runtime dependencies, and re-validation needs a JSON Schema validator, so
`src/check.ts` is one — for a bounded subset. It implements the constructs the protocol's own
schemas use (`type`, `const`, `enum`, `required`, `properties`, `additionalProperties`, `items`,
the length, size and range bounds, `pattern`, the `json-pointer` format, `not`, `anyOf`, `allOf`,
`oneOf` and `if`/`then`/`else`) and **reports** a keyword it does not implement rather than
ignoring it, which is the difference between a bounded checker and a quiet one. The subset check
walks the whole schema document before any record is checked, because a keyword nested under a
property that record happens not to carry would otherwise go unnoticed and "we checked the parts
we understood" is the one claim this must not make. A test asserts
every schema this package ships is inside the subset, so a future draft reaching for `$ref` fails
there rather than silently going unchecked. A tool whose own type needs a construct outside the
subset will see its projected lines withheld as `history.transform_uncheckable`, and a record of
that type in which a declared secret was replaced withheld as `redaction.schema_unchecked`
([above](#a-record-redaction-made-invalid)), which is the fail-closed direction: better a gap you
can see than a line nobody checked.

### A built-in: declaredProjection

The common reason to project the stream is a list the caller already knows: a username in a
path, a hostname, a private repository name — fine in a local receipt, wrong on a shared
timeline. Writing that scrub by hand risks getting longest-first replacement or key renaming
subtly wrong, so this package ships it (flyingrobots/parley#59):

```ts
import { declaredProjection } from "parley-emit";

await main(tool, argv, handler, {
  history: { transform: declaredProjection(["db-prod-7"]) },
});
```

It applies the **same scrubber** the receipt's own redaction uses (§5.3) to the stream copy's
body alone: longest value first, so a value that contains another is replaced whole and leaves no
tail, and a key that carries a declared value is renamed. The envelope — `event`, `t`, `seq`,
`run`, `_schema` — is read off the record and put back untouched; it is never the scrub's to touch,
even when a declared value happens to equal one of those fields' own value (the literal event name
`"result"`, say).

**The writer's own identity scalars are exempt too, at any depth.** A record the receipt holds may
itself be writer-built (`receipt.head`, `end`), and fields like `tool`, `v`, `inv`, `sha256`,
`name`, `id`, `version` and `code` carry no pattern a validator would reject a corrupted value by
— they are plain strings. Without this, a declared value that happened to coincide with, say, the
tool's own name would silently rename `tool` on the stream's head, with nothing to catch it. This
is the same `DIGEST_KEYS` the receipt's own redaction of a writer-built record already exempts
(`src/run.ts`); `argv` is not one of them, so the same declared value legitimately still scrubs
there, since it is the tool's own caller-chosen data.

**An empty declared set configures no transform at all.** `declaredProjection([])` returns
`undefined` rather than an inert identity function, so `MainOptions.history.transform` is itself
`undefined`: the writer's own check never builds a projection for it, and the stream copy carries
no `parley.history.transform` opening line — the run that existed before the built-in did.

**The opening line never discloses what was declared.** The returned function is declared with a
literal name rather than built by string assembly, so its name on the stream is always the literal
`declaredProjection`, whatever was declared; and the SHA-256 digest the line also carries is of the
function's *source text*, which only ever closes over the declared values and never embeds them —
two different declared sets digest identically.

Captured from `count` 0.1.0 with `declaredProjection(["db-prod-7"])` configured, against a working
directory holding `readme.txt` and `db-prod-7-backup.txt`, on 2026-11-22. The receipt's step names
both files; the stream copy's does not, and the value is absent from the stream end to end:

```jsonl
{"event":"receipt.step","t":1795391463645,"seq":4,"run":"01M82TQ85WMZ7X3AA0R2DW3M7G","decision":"counted 2 regular file(s)","because":"a declared hostname in one of the names is fine in the receipt and wrong on the shared timeline","detail":{"names":["db-prod-7-backup.txt","readme.txt"]},"_schema":{"id":"parley.receipt.step","version":"1.0.0"}}
```

```jsonl
{"event":"receipt.step","t":1795391463645,"seq":4,"run":"01M82TQ85WMZ7X3AA0R2DW3M7G","decision":"counted 2 regular file(s)","because":"a declared hostname in one of the names is fine in the receipt and wrong on the shared timeline","detail":{"names":["[redacted]-backup.txt","readme.txt"]},"_schema":{"id":"parley.receipt.step","version":"1.0.0"}}
```

### Refusing a line that looks like it carries a credential

Declared redaction (§5.3) replaces what the program declared. It cannot catch a secret nobody
declared, and the stream is where that gap costs most: a receipt lives one run's lifetime, while a
segment lives for the retention window and is read by more observers than the run that wrote it.

`refuseSuspectedSecrets()` is a built-in transform that **withholds** any line whose body matches
one of a documented list of token shapes, and says so under its own code:

```ts
import { refuseSuspectedSecrets } from "@flyingrobots/parley-emit";

await main(tool, argv, handler, { history: { transform: refuseSuspectedSecrets() } });
```

**It refuses; it never rewrites.** A heuristic must not claim the certainty that rewriting implies,
and replacing the matched span would put a record on the stream that looks checked and differs from
the receipt's copy of the same event in a way nothing records. So a false positive costs **one
withheld stream line** and never a changed value in the receipt.

The shapes ship as data in `src/transforms/secret-patterns.ts` — a name, a regex source and one
line of rationale each — so reviewing what is refused is reading a table rather than reading code:

| Pattern | Regex source |
| --- | --- |
| `aws.access_key_id` | `\bAKIA[0-9A-Z]{16}\b` |
| `github.token` | `\bgh[opsur]_[A-Za-z0-9]{36}\b` |
| `github.fine_grained_pat` | `\bgithub_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}\b` |
| `slack.token` | `\bxox[abpr]-[0-9A-Za-z]{8,}(?:-[0-9A-Za-z]{8,}){0,3}\b` |
| `google.api_key` | `\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])` |
| `pem.private_key` | `-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----` |
| `jwt` | `\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9_-])` |
| `http.bearer_token` | `\bBearer\s+[A-Za-z0-9._~+/=-]{20,}` |
| `npm.token` | `\bnpm_[A-Za-z0-9]{36}\b` |
| `stripe.live_key` | `\b(?:sk\|rk)_live_[0-9A-Za-z]{10,}\b` |

Every one is anchored and length-bounded, and every one is a prefix a vendor assigns and documents,
so a match is evidence about the string's provenance rather than about its entropy. There is
deliberately no "forty hex characters" entry: it would refuse every SHA-1. Each has a positive and
a negative sample in the suite, and the walk is over the shipped list, so a new entry without
samples fails a test. `SECRET_PATTERNS` is exported: pass
`refuseSuspectedSecrets([...SECRET_PATTERNS, ...mine])` to add to the list, a list of your own to
replace it, and `[]` for the identity.

**Captured from a real run** on 2026-11-22: a `release notes` tool that reads a token and forgot to
declare it, with the built-in configured and a planted GitHub-shaped token (`ghp_` and
`0123456789abcdefghij0123456789abcdef`, which is the right length and clearly nobody's). The
receipt carries the line, value and all, because the receipt is the record and nothing was
declared:

```jsonl
{"event":"receipt.step","t":1795392220912,"seq":4,"run":"01M82VEBQ5BGHTP5KTFMPKN8MQ","decision":"read the release token from the environment","because":"the token is not in the command's secrets list, which is the hole this refuses to widen","detail":{"token":"ghp_0123456789abcdefghij0123456789abcdef","repo":"flyingrobots/parley"},"_schema":{"id":"parley.receipt.step","version":"1.0.0"}}
```

The stream does not. stderr and the receipt carry one warning instead, naming the withheld `seq`,
the shape and the JSON Pointer — and never the matched text, which would put the suspect on stderr
and back on the stream through the warning's own copy:

```jsonl
{"event":"warning","t":1795392220912,"seq":5,"run":"01M82VEBQ5BGHTP5KTFMPKN8MQ","code":"history.suspected_secret","problem":"the body of seq 4 matches the github.token shape at /detail/token, so that line is not on the shared stream; the receipt is unaffected and still carries the value","remedy":"declare the value as a secret in the command's secrets list (spec §5.3) so it is replaced in the receipt too, or keep it out of the record; an unlisted shape passes, and a legitimate value that matches costs this one stream line","_schema":{"id":"parley.warning","version":"1.0.0"}}
```

The run's exit status is 0: a withheld line is a warning and warnings never change it (§6.1). The
doctor reads the gap off the segment, from the same run:

```text
PROJECTION  01M82VEBQ5BGHTP5KTFMPKN8MQ  refuseSuspectedSecrets  262e75ca7d76…  (history:1)
GAP         01M82VEBQ5BGHTP5KTFMPKN8MQ  seq 4 is not in this copy
SEGMENT     6 line(s); 1 run(s), 1 projected, 1 gap(s), 0 without end, 0 unparseable
```

**The limits, stated rather than implied.** This refuses what it recognises, and recognition is a
floor:

- **An unlisted shape passes.** A vendor's new prefix, an internal token format, a password: none
  of them are here, and none of them are refused.
- **A token split across two string values passes.** The scan is per value and claims nothing about
  what concatenating two of them would spell.
- **A token used as an object key passes.** Keys name fields; a value is what a program carries.
- **A legitimate value that matches is withheld.** A commit message quoting a key id, a fixture, a
  test key with a live prefix: each costs one stream line. The receipt still has it.
- **The envelope is never scanned**, because `event`, `t`, `seq`, `run` and `_schema` are the
  writer's and one unlucky run id would otherwise withhold every line of a run.
- **The head is not exempt, and it is the likeliest line to match.** It echoes `argv` and
  `resolved` (§5), so an undeclared token on the command line withholds the whole head and the
  stream copy of that run then has no head at all: no `tool`, no `v`, no `effects` for a reader of
  the segment. The gap is reported like any other, the receipt is complete, and the status does not
  move — but the honest reading of that copy is "a run happened and the stream cannot say what it
  was".

The warning names a JSON Pointer, which is built from the record's own keys, and a key can be a
token too. When the pointer itself matches a shape the warning names the shape and not the
pointer: a line withheld for one suspected secret must not put a different one on the stream
through the warning that explains it.

Declaring the value as a secret (§5.3) is the real protection, and the warning's `remedy` says so.
This is the net under it.

**With `declaredProjection`.** The package ships no composition helper; composing two transforms
is the caller's function, and it is four lines — pass a refusal on untouched, hand a record to the
next:

```ts
const declared = declaredProjection(["db-prod-7"])!;
const suspect = refuseSuspectedSecrets();
const both: HistoryTransform = (rec) => {
  const out = declared(rec);
  return out && !isHistoryRefusal(out) ? suspect(out) : out;
};
```

**The writer's identity keys are scanned too.** `declaredProjection` skips `tool`, `v`, `inv`,
`sha256`, `name`, `id`, `version` and `code` (`DIGEST_KEYS`) because it *rewrites*, and rewriting
one of those would corrupt an identity nothing re-checks. This built-in never rewrites, so the
reason does not apply, and skipping them would only be a hole: a token in a tool's `name` would
pass. A hex digest matches no shape here, because every shape is a vendor prefix. The cost is a
withheld line if a tool names itself like a token, which is the right outcome.

#### A transform may refuse, not only withhold

flyingrobots/parley#57 gave a transform two answers: a record to project, or nothing to withhold
the line. Nothing is a gap with no reason attached, which is right for "the shared timeline does not
carry step detail" and wrong when the reason is the point. So there is a third:

```ts
import { refuse } from "@flyingrobots/parley-emit";

const offTimeline: HistoryTransform = (rec) =>
  rec.event === "receipt.step" ? refuse("policy.off_timeline", `seq ${rec.seq} is not for the shared timeline`) : rec;
```

The writer withholds the line and raises one `warning` carrying that `code`, `problem` and
`remedy`, on stderr and in the receipt, leaving the exit status alone — the same treatment the four
`history.transform_*` codes get, under a code the transform chose. A refusal is a value rather than
a throw because a throw already means something in #57's contract (`history.transform_failed`: the
transform is broken), and because a value composes: a wrapping transform can read a refusal and
pass it on without an exception handler.

The code is the transform's; the namespace is still the writer's. A refusal whose `code` is not
spec §6's shape, or whose `problem` is empty, is `history.transform_failed` — the transform being
broken, like any other way of being broken. A refusal whose `code` carries a declared secret value
is `history.transform_unredacted`, because a diagnostic's `code` is the one string §5.3 does not
scrub, so a refusal cannot become the way a secret leaves. `refuse()` checks the first two at the
point the refusal is written.

#### Five decisions the owner may overrule

flyingrobots/parley#60 asked for a built-in and a pattern list; these are judgement calls rather
than consequences of the issue:

1. **A refusal is a return value, not a throw.** The issue allowed either. A value keeps "it threw"
   meaning "it is broken" and composes without exception handlers. Overrule by mapping a typed
   error in `Run`'s `projectOne` instead of `isHistoryRefusal`.
2. **The refusal's `problem` names the `seq`, and the writer does not append it.** The transform is
   handed the record, so it has the `seq`; the writer never edits a sentence it did not write. The
   cost is that a hand-written refusal can omit it. Overrule in `Run`'s `refused` in `src/run.ts`.
3. **Object keys are not scanned, only values.** A key names a field. The writer's own §5.3
   scrubber does rename keys, because there the value was declared and the certainty is earned.
   Overrule in `findSuspectedSecret`'s walk in `src/transforms/secrets.ts`.
4. **A caller's pattern list replaces the default rather than extending it**, so whoever passes one
   is reviewing exactly what they refuse on. `[...SECRET_PATTERNS, ...mine]` is the extension, and
   it is one line.
5. **The first match wins and the scan stops.** A refusal needs one reason, not an inventory, and
   the line is withheld either way. Overrule by collecting every hit before refusing.

The list itself is the sixth: ten shapes, chosen for published prefixes and bounded lengths. Adding
one is a row and two samples; removing one is a row and two samples.

### Three more decisions the owner may overrule

flyingrobots/parley#57 left the shape of the enforcement to the implementation. These three are
judgement calls rather than consequences of the issue:

1. **A line the writer cannot re-validate is withheld, not passed through.** A tool-owned type
   with no declared schema (§4.2 asks for one, and discovery already warns `schema.unavailable`
   when it is missing) therefore does not reach a projected stream. The alternative is to pass it
   through unchecked, which would make "nothing a projection does puts an invalid line on the
   shared timeline" false. Overrule in `Run`'s `project` in `src/run.ts`: return `text` where it
   now withholds.
2. **The receipt records the `seq` the opening line took, as a `receipt.step`.** The transform line
   is stream-only, so without this the receipt has an unexplained gap at that `seq`. The cost is
   one extra line and one extra `seq` in every projected run's receipt. Overrule by deleting
   `noteProjection`'s `step` call.
3. **A transform may withhold `end`.** Nothing exempts the terminal event, so a copy on the stream
   can end without one, and a reader sees incomplete lifecycle evidence for a run that in fact
   completed — which is what §3.3 says that evidence means. The doctor's segment mode counts such
   copies (`0 without end` above). Overrule by exempting `end` in `project`.

A fourth thing worth stating rather than deciding: the number of warnings is not the number of
withheld lines. A warning is itself a record, so it goes through the transform too, and a
transform that fails on a warning line withholds it **without warning again** — otherwise one
failure would generate another for ever. The stream's gaps, not the warning count, are the ground
truth for what a copy is missing.

### Two decisions the owner may overrule

flyingrobots/parley#3 left scope, expiry and redaction open and asked for a recommendation.
These are the recommendations, implemented:

1. **Scope and expiry: one stream per user per machine, as dated daily segments, keeping
   `PARLEY_HISTORY_DAYS` of them (default 14).** Scope is the machine and the user because that is
   what makes the timeline worth reading — every tool, repository, agent and session on the
   machine in one place. Expiry is by age in whole files because an append-only file with
   concurrent writers can be expired by unlinking and not by rewriting. Overrule by changing
   `HISTORY_DEFAULT_DAYS` in `src/history.ts`, or `resolveHistory`'s state path for a different
   scope; nothing else depends on either.
2. **Redaction: none of the stream's own, with owner-only permissions, no sidecar bodies and no
   network instead.** The reasoning is the section above. Overrule by filtering in `Run`'s mirror
   in `src/run.ts`, the single place the receipt's bytes are handed to the sink.

## Exceptions the protocol names

These are the places the writer's promises do not reach, named as spec §6 asks:

- A hard crash inside a native dependency or a signal kill ends the process without `end`; a
  reader sees incomplete lifecycle evidence, which is what spec §3.3 says it is.
- A library that writes to file descriptor 1 or 2 directly, rather than through `console`, puts
  its bytes on the stream. Spec §1.4 tells readers to quarantine such lines; the writer cannot
  intercept them.
- A timer or callback that logs after `end` has nothing to be captured into; its text reaches the
  stream, and the process should exit promptly after `main` returns.
- A source resolver runs before the bootstrap line and may have side effects of its own.
- A configured history transform is the tool's own code in the tool's own process. The writer
  refuses what it returns when it is invalid, uncheckable or carries a declared secret, but it
  cannot stop that code from writing elsewhere itself; the enforcement is over what reaches the
  stream through the writer.

The writer uses synchronous writes so that on every other path the receipt is complete.

## License

Apache-2.0.
