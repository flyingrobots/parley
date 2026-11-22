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

Captured from `bun run examples/count.ts files` in a directory holding two files, on
2026-11-22. stdout, three lines:

```jsonl
{"event":"run","t":1795350228199,"seq":0,"run":"01M81KCV77MMVEA1ZTPWCJYAT6","tool":"count","v":"0.1.0","inv":"638c446f866624d00aed41b516d92549f87b0197871ae5db312b7edaa8051a16","paths":{"receipt":"/private/tmp/parley-emit-readme.oUdL/.parley/receipts/01M81KCV77MMVEA1ZTPWCJYAT6.jsonl"},"_schema":{"id":"parley.run.bootstrap","version":"1.1.1"}}
{"event":"result","t":1795350228200,"seq":3,"run":"01M81KCV77MMVEA1ZTPWCJYAT6","files":4,"_schema":{"id":"count.result","version":"1.0.0"}}
{"event":"end","t":1795350228200,"seq":4,"run":"01M81KCV77MMVEA1ZTPWCJYAT6","status":0,"receipt":"/private/tmp/parley-emit-readme.oUdL/.parley/receipts/01M81KCV77MMVEA1ZTPWCJYAT6.jsonl","redacted":false,"_schema":{"id":"parley.end","version":"1.0.0"}}
```

The receipt the bootstrap line names:

```jsonl
{"event":"receipt.head","t":1795350228200,"seq":1,"run":"01M81KCV77MMVEA1ZTPWCJYAT6","tool":"count","v":"0.1.0","inv":"638c446f866624d00aed41b516d92549f87b0197871ae5db312b7edaa8051a16","argv":["count","files"],"resolved":{"command":"files","args":[]},"inputs":[],"effects":{"reads":["<cwd>/*"],"writes":[],"network":false,"idempotent":true,"bookkeeping":[{"op":"create","scope":"/private/tmp/parley-emit-readme.oUdL/.parley/receipts/"},{"op":"create","scope":"/private/tmp/parley-emit-readme.oUdL/.parley/.gitignore"},{"op":"delete","scope":"/private/tmp/parley-emit-readme.oUdL/.parley/receipts/"},{"op":"create","scope":"/tmp/parley-emit-readme.oUdL/state/parley/"}]},"_schema":{"id":"parley.receipt.head","version":"2.0.0"}}
{"event":"receipt.step","t":1795350228200,"seq":2,"run":"01M81KCV77MMVEA1ZTPWCJYAT6","decision":"counted 4 regular file(s)","because":"directories and special files are not files; only regular files count","detail":{"names":["stderr.jsonl","b.txt","a.txt","stdout.jsonl"]},"_schema":{"id":"parley.receipt.step","version":"1.0.0"}}
{"event":"result","t":1795350228200,"seq":3,"run":"01M81KCV77MMVEA1ZTPWCJYAT6","files":4,"_schema":{"id":"count.result","version":"1.0.0"}}
{"event":"end","t":1795350228200,"seq":4,"run":"01M81KCV77MMVEA1ZTPWCJYAT6","status":0,"receipt":"/private/tmp/parley-emit-readme.oUdL/.parley/receipts/01M81KCV77MMVEA1ZTPWCJYAT6.jsonl","redacted":false,"_schema":{"id":"parley.end","version":"1.0.0"}}
```

stderr was empty. The exit status was 0. The repository doctor reports the three streams
conforming (`bun run doctor --stdout ... --stderr ... --receipt ...`).

## What the writer does for you

| Spec | Behaviour |
| --- | --- |
| §3.1 | Creates the receipt before announcing it; the bootstrap line is the first line on any stream, `seq: 0`, stdout only, before the handler runs |
| §5, §5.2 | `.parley/receipts/<run>.jsonl` under the initial working directory, after `.parley/.gitignore` holds a line `*` (created if absent, never overwritten); a user's ignore file without `*` sends the receipt to `$XDG_STATE_HOME/parley/<repo-hash>/receipts/` with a `receipt.relocated` warning; an unwritable working directory falls back the same way; no writable location is a `startup.failed` and exit 3 |
| §1.3 | One counter for the run; copies of one event share `seq`, `t` and `event`; a receipt copy may carry more (`receiptExtra`) |
| §2.2 | `inv` over tool, version, command, the redacted resolved interpretation and the bytes of every declared input (see below); on the bootstrap line and head when no inputs are declared, else in `receipt.inputs` before `end`; omitted when any input is unreadable |
| §5.3 | Declared flags, variables and sources: values replaced with `[redacted]` in `argv`, `resolved`, `inputs` and every later record before any copy leaves the process; the head's `redacted` records where; a later surfacing is recorded by a `redaction` event; `end.redacted` aggregates |
| §5 | A receipt record over 65,536 bytes becomes a sidecar `<run>/<seq>.json` with a `sidecar` event in its place |
| §5.1 | Retention by count per location, oldest bundles first, recorded as a `receipt.step`; never on `--dry-run` |
| §4.1, §4.2 | `--schema` and `<command> --help` are runs that emit `command` and `schema` lines |
| §4.3 | `--dry-run` marks the bootstrap line and head and performs no retention deletion; the handler reads `run.dryRun` |
| §6 | An uncaught throw becomes an `error` with code `uncaught.exception`; a reported error closes the run with status 2 |
| §5.4, §3.3 | A sink failure before `end` is an `error` on the sinks still working and status 4; after `end` nothing is written and the status alone carries a failure; emitting after `end` throws `ParleyClosed` |
| §1.2 | `console.*` calls during the handler are captured into the receipt as steps, so a library cannot write prose to a stream |
| §1.1 | `--human` (alias `--humanize`) renders stdout and stderr through the tool's `human` function, falling back to one line per event; the receipt is unchanged |

## How this package derives `inv`

`inv` is SHA-256, hex, over the canonical JSON (keys sorted, no whitespace, UTF-8) of:

```text
{ tool, v, command, resolved, inputs: [{ path, role?, sha256 }] }
```

`resolved` is the interpretation after defaults, already redacted, so the fact that a declared
secret was supplied enters by name and its value never does (spec §2.2). Each input's `sha256` is
over its bytes; a `tree` input digests every regular file under it in sorted path order as
`path NUL digest LF`. The working directory, run id, receipt path, session and clock are not in
the preimage. Two invocations differing only in a declared secret share an `inv`, which is why a
redacted receipt is never replayed (spec §2.3).

## Declared inputs

`main`'s `inputs` option maps the command's arguments to declared inputs, `{ path, role? }`.
Roles: a file (default), `tree` for a directory, `stdin` for bytes the handler supplies with
`run.input("-", bytes)`. An input the writer cannot read is recorded with `error:
input.unreadable`; a stdin input never supplied is `input.unread`. Either omits `inv`.

## Retention

A tool states its policy as `retention: { count }` and the writer enforces it: when a location
holds more than `count` receipts, the oldest bundles beyond it are deleted, receipt and sidecar
directory together, and the deletion is recorded.

## What a receipt can contain

Everything the handler passes to `result`, `step`, `warning` and `error`, the raw and resolved
arguments, input paths and digests, captured console text, and copies of every result. Declared
secrets are replaced before writing; an undeclared secret is not, so declare it.

## Exceptions the protocol names

A hard crash inside a native dependency or a signal kill ends the process without `end`; a reader
sees incomplete lifecycle evidence, which is what spec §3.3 says it is. The writer uses synchronous
writes so that on every other path the receipt is complete.

## License

Apache-2.0.
