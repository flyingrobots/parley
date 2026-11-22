# @flyingrobots/parley-emit

A writer for the [Parley output protocol](../../spec/parley-v0.2.md). A tool conforms by
constructing a writer and emitting through it; the writer owns everything the protocol asks of a
program that is not the program's own result: the bootstrap line, the receipt and where it goes,
the single sequence across streams, `inv`, redaction, sidecars, retention, discovery, the
`--human` renderer, the top-level handler and the exit status.

Spec version `0.2.0`. Package version moves with this code; each message schema moves on its own
(spec §4.4). The schemas this package ships are the repository drafts at the commit recorded in
`src/schemas.ts`, byte-identical by test (spec §4.5).

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
});
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
| §5, §5.2 | `.parley/receipts/<run>.jsonl` under the initial working directory, after `.parley/.gitignore` holds a line `*` (created if absent, linked into place whole, never overwritten). The receipt goes to `$XDG_STATE_HOME/parley/<repo-hash>/receipts/` instead, with a `receipt.relocated` warning, when the ignore file is a user's without `*` or when the working-directory path would carry a declared secret value; an unwritable working directory falls back the same way, silently (the bootstrap line says where). No writable location is `startup.receipt_unwritable`; a state path that would also carry the secret is `startup.secret_in_path`; both exit 3 |
| §1.3 | One counter for the run; copies of one event share `seq`, `t` and `event`; a receipt copy may carry more (`receiptExtra`) |
| §2.2 | `inv` over tool, version, command, the redacted resolved interpretation and the bytes of every declared input (see below); on the bootstrap line and head when no inputs are declared, else in `receipt.inputs` before `end`; omitted when any input is unreadable. With no declared inputs it identifies the question only, not the state of the world |
| §5.3 | Declared flags, variables and sources of every command, whichever command runs: values replaced with `[redacted]` in `argv`, `resolved`, `inputs` and the payload of every later record, `end` included, before any copy leaves the process. Replacement is within strings, longest secret first; a number, boolean or bigint whose decimal form is a secret becomes `[redacted]` (a PIN parsed to a number is still the PIN); an object key carrying a secret is renamed. The head's `redacted` records where; a later surfacing is recorded by a `redaction` event; `end.redacted` aggregates. The envelope, the writer's digests and the public identity a writer-built record carries (the tool's name and version, a command's name, a schema's id and version, discovery lines included, and the `code` of a diagnostic the writer itself raises, whose corruption would put an invalid line on the stream; a tool's own diagnostic is not writer-built and its `code` is scrubbed like anything else) are never scrubbed, and a writer-built scalar (`status`, `dry_run`, `network`) is never a secret: a run id or receipt path that would carry a secret is never chosen; a session that carries one is `startup.secret_in_identity`, exit 3; the tool's own name and version are public and printed as they are |
| §5 | A receipt record over 65,536 bytes becomes a sidecar `<run>/<seq>.json` with a `sidecar` event in its place; if the sidecar cannot be written the record is kept inline, so the bundle stays complete, and the failure is a `sink.sidecar_failed` error with status 4 |
| §5.1 | Retention by count per location, oldest completed bundles first (a receipt whose last line is `end`, or one without an `end` older than a day), recorded as a `receipt.step`; never a receipt still in flight; never on `--dry-run` |
| §4.1, §4.2 | `--schema` and `<command> --help` are runs that emit `command` and `schema` lines |
| §4.3 | `--dry-run` marks the bootstrap line and head and performs no retention deletion; the handler reads `run.dryRun` |
| §6, §3.2 | An uncaught throw in the handler, or while discovery is being emitted, becomes an `error` with code `uncaught.exception` whose stack goes to the receipt copy only; a reported error closes the run with status 2, and `end(0)` after one is refused. A throw from `resolved` or `inputs` before the bootstrap line is `startup.arguments_invalid`, exit 3, with the reserved receipt removed; a source resolver that throws means the source is not present; a throwing `human` renderer is reported once as a `human.renderer_failed` warning and the default rendering is used |
| §5.4, §3.3 | The default stdout and stderr sinks deliver whole lines: a partial write continues and a full pipe (EAGAIN on a descriptor the runtime left non-blocking) waits and retries, as a blocking write would. A sink failure before `end` is an `error` on the sinks still working and status 4; a failed bootstrap write is reported after the head, so the head stays the receipt's first line; after `end` nothing is written and the status alone carries a failure; emitting after `end` throws `ParleyClosed`. A record or `receiptExtra` carrying `t`, `seq`, `run` or `_schema` is a `TypeError` |
| §1.2 | Every function on `console`, called from the moment `main` starts until it returns, is captured into the run's receipt as a step; text captured before the receipt exists is held and written after the head. This contains libraries that log through `console`; it does not contain a library that writes to a file descriptor directly, or a timer that fires after `end` (see the exceptions below) |
| §1.1 | `--human` (alias `--humanize`) renders stdout and stderr through the tool's `human` function, falling back to one line per event; the bootstrap line and a successful `end` render as nothing, so `tool --human \| gh pr comment --body-file -` posts only the tool's prose, and a failed `end` names the receipt path; the receipt is unchanged |
| §8 (informative) | An opt-in second sink: with `PARLEY_HISTORY` set or `$XDG_STATE_HOME/parley/history` present, every line of the receipt is also appended to a dated daily segment shared by every tool, repository and agent on the machine, named in `paths.history` and declared in `effects.bookkeeping`. Same bytes, so the same redaction; one whole line per write under `O_APPEND`; retention by whole segment; a stream that cannot be written is a warning and never an error, a sink failure or a different exit status. With nothing configured, none of this happens (see below) |

## Arguments and flags

`main` takes `argv` as `[tool.name, ...process.argv.slice(2)]`: the first element names the tool
and is echoed in the head's `argv`. The command is the first positional argument that names one
of the tool's own commands; a tool with one command needs none. The writer's flags, `--human`,
`--humanize`, `--dry-run`, `--schema`, `--help` and `-h`, are recognised anywhere and removed
from the arguments the handler sees. `PARLEY_SESSION` in the environment, or the `session`
option, is carried as `session` on the bootstrap line and head; the writer never invents one.

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

## Declared inputs

`main`'s `inputs` option maps the command's arguments to declared inputs,
`{ path, role?, exclude? }`; it may be async. A relative path is resolved against the initial
working directory; an absolute path stands, and enters the `inv` preimage as given, so prefer
relative paths and never a temporary one. Roles: a file (default), `tree` for a directory,
`stdin` for bytes the handler supplies with `run.input("-", bytes)`. An input the writer cannot
read is recorded with `error: input.unreadable`; a stdin input never supplied is `input.unread`.
Either omits `inv`.

A `tree` must not contain a credential source (spec §2.2: its bytes must not reach `inv` through
a directory digest). Name such files in `exclude`, as relative paths under the tree; if you cannot
name them, do not declare the tree. The writer's own `.parley` directory is always skipped, so the
working directory can be a tree without the receipts moving `inv` on every run.

## Retention

A tool states its policy as `retention: { count }` and the writer enforces it: when a location
holds more than `count` receipts, the oldest bundles beyond it are deleted, receipt and sidecar
directory together, and the deletion is recorded.

## What a receipt can contain

Everything the handler passes to `result`, `step`, `warning` and `error`, the raw and resolved
arguments, input paths and digests, captured console text, and copies of every result. Declared
secrets are replaced before writing; an undeclared secret is not, so declare it.

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
the receipt, for longer and across repositories. Declaring it is the fix, as it always was.

### A broken stream never breaks a run

A path that cannot be opened is one `history.unavailable` warning; an append that fails is one
`history.write_failed` warning and the stream is dropped. Neither is an error, neither is a sink
failure, and neither changes the exit status: §8 is informative and opt-in, so the extra sink
cannot be the thing that fails the program. The receipt is the record; the stream is a
convenience.

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

The writer uses synchronous writes so that on every other path the receipt is complete.

## License

Apache-2.0.
