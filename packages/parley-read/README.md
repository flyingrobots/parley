# @flyingrobots/parley-read

A reader for the [Parley output protocol](../../spec/parley-v0.2.md). It opens the receipt bundles
a repository has accumulated and hands back every run's records, each labelled by how well it is
established: validated against the schema for its exact pair, partially checked, or passed through
unvalidated because its type is not ours to validate.

The rules it keeps are the ones the specification binds a *reader* to — §1.4 buffering and
quarantine, §5.4's unterminated tail, §1.3's `(run, seq)`, §4.5 and §4.6 on exact-pair resolution,
and §5 on sidecars — because the cases §6 calls unconstrainable will happen, and a reader that
aborts on the first stray byte is broken by exactly the case the spec admits.

Spec version `0.2.0`. The package version moves with this code; each message schema moves on its
own (spec §4.4). The schemas it ships are the repository drafts at the commit recorded in
`src/schemas.ts`, byte-identical by test (spec §4.5).

This is a library with no command. It is not published yet; inside this repository it is the
workspace package `@flyingrobots/parley-read`.

## Loading a directory's receipts

```ts
import { loadReceipts } from "@flyingrobots/parley-read";

const load = loadReceipts({ cwd: "/work/site" });

for (const bundle of load.bundles) {
  console.log(bundle.run, bundle.status, bundle.records.length);
  for (const defect of bundle.defects) console.log(defect.code, defect.section, defect.problem);
}
```

`loadReceipts` looks in both places the writer could have put a receipt for that working
directory (§5): `.parley/receipts/` under it, and `$XDG_STATE_HOME/parley/<repo-hash>/receipts/`.
It creates nothing and reports each location present or absent. A single file is read with
`readReceiptFile(path)`.

A receipt file the loader cannot open at all is reported as a `receipt.unreadable` defect in
`load.defects` rather than losing the rest of the directory; `readReceiptFile`, given one path by
name, throws instead. Passing `sidecars: false` skips sidecar resolution and reports each sidecar
`unchecked` — never `intact`, since nothing about its stored bytes was established.

## A captured load

Two runs of the writer's own `count` example in one directory, then one `loadReceipts` over it, on
2026-11-22. The first run's receipt, five lines:

```jsonl
{"event":"receipt.head","t":1795387199029,"seq":1,"run":"01M82PN3HG54ZAZJSXV18T9Y8G","tool":"count","v":"0.1.0","argv":["count","files"],"resolved":{"command":"files","args":[]},"inputs":[{"path":"a.txt"}],"effects":{"reads":["<cwd>/*"],"writes":[],"network":false,"idempotent":true,"bookkeeping":[{"op":"create","scope":"/private/tmp/parley-read-readme.nJpgGP/work/.parley/receipts/"},{"op":"create","scope":"/private/tmp/parley-read-readme.nJpgGP/work/.parley/.gitignore"},{"op":"delete","scope":"/private/tmp/parley-read-readme.nJpgGP/work/.parley/receipts/"},{"op":"create","scope":"/private/tmp/parley-read-readme.nJpgGP/state/parley/07576214773c1613/receipts/"},{"op":"delete","scope":"/private/tmp/parley-read-readme.nJpgGP/state/parley/07576214773c1613/receipts/"}]},"_schema":{"id":"parley.receipt.head","version":"2.0.0"}}
{"event":"receipt.step","t":1795387199030,"seq":2,"run":"01M82PN3HG54ZAZJSXV18T9Y8G","decision":"counted 2 regular file(s)","because":"only regular files count","detail":{"n":1},"_schema":{"id":"parley.receipt.step","version":"1.0.0"}}
{"event":"result","t":1795387199030,"seq":3,"run":"01M82PN3HG54ZAZJSXV18T9Y8G","files":2,"_schema":{"id":"count.result","version":"1.0.0"}}
{"event":"receipt.inputs","t":1795387199030,"seq":4,"run":"01M82PN3HG54ZAZJSXV18T9Y8G","inputs":[{"path":"a.txt","sha256":"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"}],"inv":"e6b8b0500dd5cf505567fdb26762bfad915e9dd5ac097d5c994814a6ebff4301","_schema":{"id":"parley.receipt.inputs","version":"1.0.0"}}
{"event":"end","t":1795387199030,"seq":5,"run":"01M82PN3HG54ZAZJSXV18T9Y8G","status":0,"receipt":"/private/tmp/parley-read-readme.nJpgGP/work/.parley/receipts/01M82PN3HG54ZAZJSXV18T9Y8G.jsonl","redacted":false,"_schema":{"id":"parley.end","version":"1.0.0"}}
```

What the load returned. These blocks are fragments of a JavaScript value, not protocol messages,
so they carry no `_schema`; `load.locations` first — the state directory was never needed, so it
does not exist, and that is reported rather than treated as an error:

```json illustrative
[
  { "where": "repo", "dir": "/private/tmp/parley-read-readme.nJpgGP/work/.parley/receipts", "present": true },
  { "where": "state", "dir": "/private/tmp/parley-read-readme.nJpgGP/state/parley/07576214773c1613/receipts", "present": false }
]
```

Then `load.bundles[0]`, with each record projected to its `seq`, `event` and validation state; a
real record also carries the file and line it was read from, how many copies carried it, whether
it came from a sidecar, and the record itself:

```json illustrative
{
  "run": "01M82PN3HG54ZAZJSXV18T9Y8G",
  "sources": [{ "where": "repo", "receipt": "/private/tmp/parley-read-readme.nJpgGP/work/.parley/receipts/01M82PN3HG54ZAZJSXV18T9Y8G.jsonl" }],
  "records": [
    { "seq": 1, "event": "receipt.head", "validation": "validated" },
    { "seq": 2, "event": "receipt.step", "validation": "validated" },
    { "seq": 3, "event": "result", "validation": "unvalidated" },
    { "seq": 4, "event": "receipt.inputs", "validation": "validated" },
    { "seq": 5, "event": "end", "validation": "validated" }
  ],
  "terminated": true,
  "status": 0,
  "redacted": false,
  "replay": { "unavailable": false, "reasons": [] }
}
```

And `load.counts` over both runs:

```json illustrative
{ "bundles": 2, "records": 10, "validated": 8, "invalid": 0, "partial": 0, "unvalidated": 2, "quarantined": 0, "duplicates": 0 }
```

The `result` at `seq: 3` is `count.result`, a type this reader ships no schema for and must not
validate against another (§4.6), so it is returned and reported as unvalidated — two of them
across the two runs, which is where `counts.unvalidated` comes from. The four `parley.*` lines in
each receipt were validated against the schema for their exact advertised pair.

## Surface

| Export | Job |
| --- | --- |
| `loadReceipts(opts)` | Every run in both receipt locations for a working directory, as bundles |
| `readReceiptFile(path, opts)` | One receipt file; a file holding more than one run yields one bundle per run |
| `receiptLocations(opts)`, `repoReceiptDir`, `stateReceiptDir` | Where receipts are, present or absent; creates nothing |
| `LineBuffer`, `splitLines`, `readFileLines` | Newline buffering: bytes in, complete lines out, the unterminated tail kept apart (§1.4, §5.4) |
| `validator(schemas?)`, `schemaRef`, `envelopeGaps` | Exact-pair validation and the version-independent core (§4.5, §4.6) |
| `SCHEMAS`, `SCHEMA_SOURCE` | The fourteen draft schemas this reader ships, with the commit and digest of each |
| `QUARANTINE_CODES` | Which defect codes are a kept line rather than a judgement about a record |

## What a load says, rule by rule

| It reports | Because |
| --- | --- |
| Both locations, present or absent | §5: the writer falls back to the state directory, so a reader that looks in one place sees half the history |
| Records in `seq` order, one per `(run, seq)` | §1.3: a run holds one counter, and copies of one event are one event |
| A copy's extra fields folded in, a disagreement as a defect | §1.3: a copy may carry fields another omits, but copies must agree on every field they share |
| A stray line quarantined, kept, attributed to the run | §1.4: kept and reported, and evidence of nothing but the fact that something wrote it |
| An unterminated final line ignored, including a parseable `end` | §5.4: it is not a line, so it cannot establish termination |
| `validated`, `invalid`, `partial`, `unvalidated` per record | §4.5: full validation is against the exact pair, and "the part I recognise passed" is never "the contract passed" |
| A sidecar's bytes checked against `bytes` and `sha256`, and the record restored | §5: a sidecar stands in a record's place, and its path must not leave the bundle |
| `replay.unavailable` with its reasons | §5, §5.3, §5.4: a broken sidecar, no terminated `end`, a non-zero status or a redacted receipt each rule replay out |

`replay.unavailable: false` means only that nothing in the bundle rules replay out. Eligibility
under §2.3 and §5.3 for the invocation at hand — whether that invocation supplied a declared
secret, whether its `inv` matches — is the caller's to decide, and this reader does not know it.

## What it does not do

- Query or rank. It returns what the receipts say; choosing among runs is the caller's.
- Recompute `inv` or any semantic digest (§7.1). It checks a sidecar's stored bytes against the
  digest the receipt declared, and nothing else.
- Judge conformance. The doctor under `scripts/` names violated rules; this is a loader, and a
  defect it reports is what it could not read or could not validate.
- Write, create or repair anything. Locating a location does not create it.
- Windows paths. v0.2 of the spec is POSIX-only.

## Checks

```bash
bun test                 # root: this package's suite runs with the repository's
bun run typecheck        # strict TypeScript over src, scripts and test
bun run check            # every JSON example, this README included
```

The contract ledger is [docs/topics/parley-read/test-plan.md](../../docs/topics/parley-read/test-plan.md);
the living reference is [docs/topics/parley-read](../../docs/topics/parley-read/README.md).
