# @flyingrobots/parley-read

A reader for the [Parley output protocol](../../spec/parley-v0.2.md). It opens the receipt bundles
a repository has accumulated and hands back every run's records, each labelled by how well it is
established: validated against the schema for its exact pair, partially checked, or passed through
unvalidated because its type is not ours to validate.

A read over those records states who it is for, what shape of answer it wants and how big an
answer it will accept, is refused when it cannot, and is itself recorded as a run with a receipt
(§9) — so the next read can see what was asked. The shape it asks for **orders** the answer: §9's
purpose is the ranking function, and it never removes a record. The size it will accept **bounds**
the answer, and the read answers with a digest that says what the bound left out, so a later
reader cannot mistake a digest for the whole. A drill-down opens the records a digest names, by
`(run, seq)`, in full — a sidecar's contents included — with one outcome per id, and it is recorded
as a read too.

The rules it keeps are the ones the specification binds a *reader* to — §1.4 buffering and
quarantine, §5.4's unterminated tail, §1.3's `(run, seq)`, §4.5 and §4.6 on exact-pair resolution,
and §5 on sidecars — because the cases §6 calls unconstrainable will happen, and a reader that
aborts on the first stray byte is broken by exactly the case the spec admits.

Spec version `0.2.0`. The package version moves with this code; each message schema moves on its
own (spec §4.4). The schemas it ships are the versions released with spec `0.2.0`, copied from
`schemas/` at the commit recorded in `src/schemas.ts`, byte-identical by test (spec §4.5).

This is a library with no command, for Bun 1.2 or later. Version 0.1.1 is released (tag
`parley-read-v0.1.1`) and on npm once the owner approves it
([docs/workflows/release-parley-read](../../docs/workflows/release-parley-read/README.md));
`bun add @flyingrobots/parley-read` installs it with `@flyingrobots/parley-emit` `^0.2.4`.
Inside this repository it is the workspace package `@flyingrobots/parley-read`.

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

A segment of the shared history stream (§8) is read beside the receipts when a caller names one,
and never looked for otherwise, because the stream is opt-in and the format never requires it:

```ts
const load = loadReceipts({ cwd: "/work/site", history: ["/var/lib/parley/history/2026-11-22.jsonl"] });
```

A copy of a run on that stream may be a **projection** of the receipt copy, so where two copies of
one `(run, seq)` differ the loader returns the one from the source that carries no
`parley.history.transform` line for that run and records the other as a projection — by name, by
the digest of the transform's source text, and by which `seq` values it superseded or withheld.
`readHistorySegment(path)` reads one segment on its own. The rule, and the two edges it has, are
[the living reference](../../docs/topics/parley-read/README.md#the-least-projected-copy).

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

## A captured projection

The same `count` example once more, on 2026-11-22, with a transform on its history sink that
drops a step's `detail` and withholds the `result` altogether: the stream copy carries what ran,
not what the run looked at. The segment it appended to is named for the UTC day, so the file is
`2026-11-23.jsonl`. The receipt is untouched, and the stream copy opens by saying what it is:

```jsonl
{"event":"history.transform","t":1795392112424,"seq":1,"run":"01M82VB1S1W9PX56H9N0XZ4RTC","name":"what-ran","sha256":"1e40e80ba99445be0f933b8628c34eeef8883a28037a9998161af8b91dfcc00a","_schema":{"id":"parley.history.transform","version":"1.0.0"}}
```

That line's `seq: 1` is the stream's alone, which is why this run's receipt starts at `seq: 2`. The
step at `seq: 4` is where the two copies part — the receipt's first, then the stream's:

```jsonl
{"event":"receipt.step","t":1795392112425,"seq":4,"run":"01M82VB1S1W9PX56H9N0XZ4RTC","decision":"counted 2 regular file(s)","because":"only regular files count","detail":{"names":["a.txt","b.txt"]},"_schema":{"id":"parley.receipt.step","version":"1.0.0"}}
{"event":"receipt.step","t":1795392112425,"seq":4,"run":"01M82VB1S1W9PX56H9N0XZ4RTC","decision":"counted 2 regular file(s)","because":"only regular files count","_schema":{"id":"parley.receipt.step","version":"1.0.0"}}
```

One `loadReceipts` over the working directory, handed that segment, returns the receipt's bodies
and one note. A `Projection` is a fragment of a JavaScript value and not a protocol message, so it
carries no `_schema`:

```json illustrative
{
  "file": "/var/folders/wt/s8clst9955x1l0qblsl4925w0000gn/T/parley-projection-3mcGOu/history/2026-11-23.jsonl",
  "where": "history",
  "name": "what-ran",
  "sha256": "1e40e80ba99445be0f933b8628c34eeef8883a28037a9998161af8b91dfcc00a",
  "seq": 1,
  "superseded": [4],
  "withheld": [5],
  "sole": false
}
```

The six records it came back with, projected to what this page is about:

| `seq` | `event` | `copies` | `projected` | |
| --- | --- | --- | --- | --- |
| 1 | `history.transform` | 1 | yes | the stream's opening line, a record of its own, validated against `parley.history.transform` 1.0.0 |
| 2 | `receipt.head` | 2 | no | identical in both copies |
| 3 | `receipt.step` | 2 | no | the writer's own note that the stream copy is a projection, and which `seq` its opening line took |
| 4 | `receipt.step` | 2 | no | **the receipt's body, with its `detail`.** The stream's narrowed copy is superseded |
| 5 | `result` | 1 | no | withheld from the stream, so the receipt's copy is the only one there was |
| 6 | `end` | 2 | no | identical in both copies |

No defects. `superseded: [4]` and `withheld: [5]` say exactly what the projection did, and nothing
in the answer is a narrowed body.

## Making a read

A read states an `asker`, a `view` and a `window`. The first two are never inferred — §2.1 forbids
inventing an identity and there is no privileged view — so a read that cannot state them is
refused rather than answered under a guess. The shapes and the vocabulary are
[the reader representation](../../docs/topics/reader/README.md).

```ts
import { queryReceipts } from "@flyingrobots/parley-read";

const now = Date.now();
const outcome = await queryReceipts({
  asker: { tool: "claude-code", cwd: "/work/site", task: "flyingrobots/parley#48" },
  view: "what-ran",
  window: { from: now - 86_400_000, to: now },
  note: "what has run in this directory today",
}, { cwd: "/work/site" });

if (outcome.refused) for (const r of outcome.refusals) console.error(r.code, r.problem, r.remedy);
else console.log(outcome.records.length, "of", outcome.counts.inWindow, "—", outcome.digest.loss);
```

`asker.cwd` is inferred from the directory the read was made against when the caller states none,
and `asker.task` comes from the request; everything else is refused rather than guessed. A `cwd`
that is not absolute, an empty `task` and an empty `note` are refused too, rather than emitted as
a line that fails its own schema.

An accepted read is a run: it emits `parley.query` through
[`@flyingrobots/parley-emit`](../parley-emit/README.md) into a receipt beside the ones it read, so
the loader finds the question on the next read and a result can name the query it answers by
`(run, seq)`. A **refused** read is not a run and records nothing — no receipt, no `.parley`
directory, nothing written — because §9 records a question that was asked, and a question nobody
could state has no asker to attribute it to. Its refusals carry §6's fields, so a caller that is
itself a parley tool can hand one straight to `run.error`:

```json illustrative
{
  "code": "query.view_missing",
  "field": "view",
  "problem": "the read states no view, and there is no privileged view to fall back on",
  "remedy": "state one of: what-ran, what-failed, what-changed, how-it-decided, everything; a guessed view is a different answer to a different question, and the caller cannot see it",
  "section": "§9"
}
```

### What a read records, and what it applies

| Field | Recorded | Applied |
| --- | --- | --- |
| `asker` | Verbatim, `tool` required | Nothing branches on it: two askers asking the same thing get the same answer |
| `view` | Verbatim, one of five tokens | **The order.** It ranks the answer and filters none of it (below) |
| `budget` | Verbatim, defaulted to `{"records": 20}` and the answer says it defaulted | **The bound.** `records` bounds how many records the answer names; `bytes` bounds the digest's line; `ms` is a deadline for the whole read (below) |
| `window` | Verbatim, two timestamps inclusive at both ends | Yes: the answer is the records inside it, ordered by the view, with `(t, run, seq)` ascending as the last part of the key |
| `note` | Verbatim | Never parsed |

### The digest, and what it left out

The first response is a **`parley.lens` 1.0.0 record** — the message decided in
[flyingrobots/parley#46](https://github.com/flyingrobots/parley/issues/46), not a new one. It goes
through the writer onto the read's stream and into the read's receipt, so the digest is evidence
and the loader reads it back `validated` against that exact pair. It names the query it answers by
`(run, seq)`, the asker, the view, the window, the budget **actually applied**, the records it
holds by `(run, seq)` — the way back a drill-down needs — and the loss:

| Budget field | What it bounds |
| --- | --- |
| `records` (required) | **The count.** At most this many records are named, and `answer.records` holds exactly those |
| `bytes` (optional) | **The line.** The lens line as written, serialised JSON plus its newline in UTF-8, is at most this many bytes; records are dropped from the tail of the ranking until it fits |
| `ms` (optional) | **The whole read, as a deadline**, measured on `opts.clock` from the call and checked after the load, after the ranking and before the digest is written (flyingrobots/parley#71) |

`loss.excluded` is always there, zero included — an absent count and a count of zero are different
claims — and `loss.bound` is `none` only beside a count of 0, which the schema refuses to pair any
other way. So a digest that left something out says so structurally rather than in prose. What it
excluded is not returned by another route and is named by no id, so it is reached by reading again
under a wider budget, not by a drill-down. `counts.inWindow` and
the ranking's tier census still describe the whole window the digest was drawn from, so the caller
can see it is not the whole without being handed what it cut.

### A budget the read cannot meet

A read whose deadline passes at a check, or whose `budget.bytes` cannot hold even a digest naming
no records, **declines** (flyingrobots/parley#71). It is still a recorded run — its `parley.query`
is in its receipt — but it writes no lens: it never answers from a partial load, and never writes
a line over a stated bound. It reports one `parley.error`, code `query.over_budget`, whose
`detail` states the `bound` that declined, the `phase` it stopped at, the budget `given`, what was
`measured`, a budget that would have been `sufficient` where that is known (exactly, for bytes:
the size of the smallest digest) and the elapsed time as `at_least` when phases were still to run.
The run ends with status 2, and `queryReceipts` returns `{refused: false, declined: true, decline,
…}` rather than throwing:

```ts
const out = await queryReceipts(
  { asker: { tool: "my-agent" }, view: "what-failed", window: { from: 0, to: Date.now() }, budget: { records: 20, ms: 50 } },
  { cwd: process.cwd() },
);
if (!out.refused && out.declined) console.error(out.decline.problem, out.decline.sufficient, out.decline.atLeast);
```

The deadline is measured on `opts.clock`, monotonic by default and replaceable so a test can script
it. The full rules, and a captured decline, are in
[the reader page](../../docs/topics/parley-read/README.md#when-a-read-declines).

### The view orders the answer, and filters none of it

Spec §9: the purpose shapes the result, and it is the **ranking function** rather than a filter
applied afterwards. One total order on a key per record, compared left to right:

1. **the failure surface of the runs that failed**, when the view is an answer about a change — a
   read made in order to change something is a read made in order not to repeat a failure. A
   `warning` from a run that went on is not a failure (§6.1) and is placed by the view's own
   surface instead;
2. **the view's own surface** — the records the view is about, above the records it is not;
3. **`(t, run, seq)` ascending** — so a view whose surface no record touches leaves the answer
   exactly as it was.

Under a view that implies a change, a failed run's records also rank above an `undetermined` run's,
and those above a run known to have succeeded — within a tier, never across one.

`rankRecords(query, records)` is that order on its own: a pure function from an accepted query and
records to the same records, reordered. It reads nothing, writes nothing and records nothing, and
it **returns every record it was given** — over-filtering is the failure mode §9 warns about, so
nothing is dropped at any tier. The digest's bound is applied one step later, above the full
order, which is the only place a cut can state its own loss honestly. `answer.ranking` carries
each named record's `rank`, `tier`, `outcome` and the `why` behind them, and its per-run outcomes
and tier counts are over the whole window the digest was drawn from.

Which token implies a change is derived from the vocabulary rather than read from a field —
`parley.query` has none — and the surface each token names, the outcome rules and the whole
statement of the order are in
[the living reference](../../docs/topics/parley-read/README.md#how-the-purpose-orders-the-answer).

## A captured read

Two runs of the writer's own `count` example in one directory, then one `queryReceipts` over it
asking what ran in the last day, on 2026-11-22. The read's own receipt holds five lines; this is
the `query` event it recorded at `seq: 2`, as the receipt holds it:

```jsonl
{"event":"query","t":1795388936981,"seq":2,"run":"01M82RA4RCSBF4F4P9NHM8650K","asker":{"tool":"claude-code","cwd":"/tmp/parley-query-readme.4xkfaK/work","task":"flyingrobots/parley#48"},"view":"what-ran","budget":{"records":20},"window":{"from":1795302536970,"to":1795388936970},"note":"what has run in this directory today","_schema":{"id":"parley.query","version":"1.0.0"}}
```

What the read returned, whole. It is a fragment of a JavaScript value and not a protocol message,
so it carries no `_schema`, and each record is projected to the five fields a timeline reads; a
real record also carries the file and line it came from, how many copies carried it, whether it
came from a sidecar, and the record itself:

```json illustrative
{
  "run": "01M82RA4RCSBF4F4P9NHM8650K",
  "query": { "run": "01M82RA4RCSBF4F4P9NHM8650K", "seq": 2 },
  "view": "what-ran",
  "budget": { "records": 20 },
  "budgetDefaulted": true,
  "window": { "from": 1795302536970, "to": 1795388936970 },
  "counts": { "scanned": 11, "inWindow": 8, "undated": 0, "own": 3 },
  "records": [
    { "run": "01M82RA4PNDJDYZ51K4GFGK06D", "seq": 1, "event": "receipt.head", "t": 1795388936929, "validation": "validated" },
    { "run": "01M82RA4PNDJDYZ51K4GFGK06D", "seq": 2, "event": "receipt.step", "t": 1795388936929, "validation": "validated" },
    { "run": "01M82RA4PNDJDYZ51K4GFGK06D", "seq": 3, "event": "result", "t": 1795388936929, "validation": "unvalidated" },
    { "run": "01M82RA4PNDJDYZ51K4GFGK06D", "seq": 4, "event": "end", "t": 1795388936929, "validation": "validated" },
    { "run": "01M82RA4QYCB94DVW87TMBDBQE", "seq": 1, "event": "receipt.head", "t": 1795388936967, "validation": "validated" },
    { "run": "01M82RA4QYCB94DVW87TMBDBQE", "seq": 2, "event": "receipt.step", "t": 1795388936968, "validation": "validated" },
    { "run": "01M82RA4QYCB94DVW87TMBDBQE", "seq": 3, "event": "result", "t": 1795388936968, "validation": "unvalidated" },
    { "run": "01M82RA4QYCB94DVW87TMBDBQE", "seq": 4, "event": "end", "t": 1795388936968, "validation": "validated" }
  ]
}
```

Eight records in the window, from the two `count` runs, ascending by `t`. The two `result` lines
are `count.result`, a type this reader ships no schema for and must not validate against another
(§4.6), so they come back unvalidated — the same rule the loader follows.

`counts.own` is 3: the read's own head, its query and its first step, as they stood when it
loaded. They are not in the answer, because **a read does not answer itself**. The record of it is
there for the next read, which loads it as validated against the exact pair:

```json illustrative
{ "run": "01M82RA4RCSBF4F4P9NHM8650K", "seq": 2, "event": "query", "validation": { "state": "validated", "schema": { "id": "parley.query", "version": "1.0.0" } } }
```

## A captured ranking

Three runs of the same `count` example in one directory, on 2026-11-22: one that counted a file,
one that fell over a dangling symlink, and one that counted again after it was removed. Then one
read with `view: "what-changed"` — a purpose that implies a change — over the day's window. The
`query` event the read recorded, as its receipt holds it:

```jsonl
{"event":"query","t":1795390386268,"seq":2,"run":"01M82SPC2NKT5APEFXTY9TM1TN","asker":{"tool":"claude-code","cwd":"/tmp/parley-rank-readme.mHfg3V/work","task":"flyingrobots/parley#49"},"view":"what-changed","budget":{"records":20},"window":{"from":1795303986259,"to":1795390386259},"note":"about to change the counter; what has it done here","_schema":{"id":"parley.query","version":"1.0.0"}}
```

What came back, projected to the key each record was placed by. The ranks, runs, events,
timestamps, tiers and outcomes are that read's real values; the `why` of each record is abridged to
its first reason, and a real `ranked` entry carries the whole record beside them:

```json illustrative
{
  "view": "what-changed",
  "impliesChange": true,
  "counts": { "scanned": 14, "inWindow": 11, "undated": 0, "own": 3 },
  "tiers": { "failure": 2, "surface": 2, "other": 7, "failedRuns": 1, "undeterminedRuns": 0, "succeededRuns": 2 },
  "ranked": [
    { "rank":  1, "run": "01M82SPC1B061PYZ3XQ32S7EGB", "seq": 2, "event": "error",        "t": 1795390386227, "tier": "failure", "outcome": "failed",    "why": "on the failure surface, and what-changed is an answer about a change" },
    { "rank":  2, "run": "01M82SPC1B061PYZ3XQ32S7EGB", "seq": 3, "event": "end",          "t": 1795390386228, "tier": "failure", "outcome": "failed",    "why": "on the failure surface, and what-changed is an answer about a change" },
    { "rank":  3, "run": "01M82SPC0C4E17JV4WMAPKR38Y", "seq": 3, "event": "result",       "t": 1795390386196, "tier": "surface", "outcome": "succeeded", "why": "touches the what-changed surface" },
    { "rank":  4, "run": "01M82SPC2AP8XYAV1ZD8Y3GPSS", "seq": 3, "event": "result",       "t": 1795390386258, "tier": "surface", "outcome": "succeeded", "why": "touches the what-changed surface" },
    { "rank":  5, "run": "01M82SPC1B061PYZ3XQ32S7EGB", "seq": 1, "event": "receipt.head", "t": 1795390386227, "tier": "other",   "outcome": "failed",    "why": "off the what-changed surface" },
    { "rank":  6, "run": "01M82SPC0C4E17JV4WMAPKR38Y", "seq": 1, "event": "receipt.head", "t": 1795390386196, "tier": "other",   "outcome": "succeeded", "why": "off the what-changed surface" },
    { "rank":  7, "run": "01M82SPC0C4E17JV4WMAPKR38Y", "seq": 2, "event": "receipt.step", "t": 1795390386196, "tier": "other",   "outcome": "succeeded", "why": "off the what-changed surface" },
    { "rank":  8, "run": "01M82SPC0C4E17JV4WMAPKR38Y", "seq": 4, "event": "end",          "t": 1795390386197, "tier": "other",   "outcome": "succeeded", "why": "off the what-changed surface" },
    { "rank":  9, "run": "01M82SPC2AP8XYAV1ZD8Y3GPSS", "seq": 1, "event": "receipt.head", "t": 1795390386257, "tier": "other",   "outcome": "succeeded", "why": "off the what-changed surface" },
    { "rank": 10, "run": "01M82SPC2AP8XYAV1ZD8Y3GPSS", "seq": 2, "event": "receipt.step", "t": 1795390386258, "tier": "other",   "outcome": "succeeded", "why": "off the what-changed surface" },
    { "rank": 11, "run": "01M82SPC2AP8XYAV1ZD8Y3GPSS", "seq": 4, "event": "end",          "t": 1795390386258, "tier": "other",   "outcome": "succeeded", "why": "off the what-changed surface" }
  ]
}
```

Four things in that order are the whole feature:

- **What failed is first.** The failing run's `error` and its status-2 `end` are ranks 1 and 2,
  although two later runs succeeded after it. In time order they would have been buried.
- **What the view is about is next.** The two `count.result` records are the subject matter this
  tool exists to produce (§7), so they rank above every head, step and `end` — including the heads
  of their own runs.
- **Within a tier, a failed run still comes first.** Rank 5 is the failing run's head, at
  `t: …386227`, above rank 6 at `t: …386196`, which is 31 ms earlier. Inside a tier the outcome key
  outranks the clock — and only under a view that implies a change.
- **Nothing is hidden by the order.** Eleven records in the window, eleven ranked. Under
  `view: "everything"` the same eleven come back in `(t, run, seq)` order: the view changed the
  order and nothing else. What a *budget* cuts from that order is the digest's, below, and it says
  so.

## A captured digest

Three runs of the same kind, made afresh, then one read with `budget: {"records": 4}` over the day's
window on 2026-11-22. The first and third runs are the same invocation with the same result, so the
digest names the third for both. Eleven records are in the window and the digest names four of
them, so it says `excluded: 7`, and `folded: 4` of those are the first run's.
These are the two lines that read's own receipt holds, byte for byte — `bun run check` validates
both against the shipped schemas:

```jsonl
{"event":"query","t":1795401942789,"seq":2,"run":"01M834Q1QWPS7W7F2HA0DAG6DA","asker":{"tool":"claude-code","cwd":"/var/folders/wt/s8clst9955x1l0qblsl4925w0000gn/T/parley-digest-readme.vtwlJT/work","task":"flyingrobots/parley#100"},"view":"what-changed","budget":{"records":4},"window":{"from":1795315542778,"to":1795401942778},"note":"about to change the counter; what has it done here","_schema":{"id":"parley.query","version":"1.0.0"}}
{"event":"lens","t":1795401942844,"seq":6,"run":"01M834Q1QWPS7W7F2HA0DAG6DA","query":{"run":"01M834Q1QWPS7W7F2HA0DAG6DA","seq":2},"asker":{"tool":"claude-code","cwd":"/var/folders/wt/s8clst9955x1l0qblsl4925w0000gn/T/parley-digest-readme.vtwlJT/work","task":"flyingrobots/parley#100"},"view":"what-changed","budget":{"records":4},"window":{"from":1795315542778,"to":1795401942778},"loss":{"bound":"count-only","excluded":7,"folded":4},"runs":[{"run":"01M834Q1KEMCBN373NYE1BV2BG","tool":"count","v":"0.1.0","argv":["count","files"],"resolved":{"command":"files","args":[]},"inv":"638c446f866624d00aed41b516d92549f87b0197871ae5db312b7edaa8051a16","outcome":"failed"},{"run":"01M834Q1QFYZZ3CMXZ0SKE600Z","tool":"count","v":"0.1.0","argv":["count","files"],"resolved":{"command":"files","args":[]},"inv":"638c446f866624d00aed41b516d92549f87b0197871ae5db312b7edaa8051a16","outcome":"succeeded","folded":{"others":1,"records":4}}],"records":[{"run":"01M834Q1KEMCBN373NYE1BV2BG","seq":2,"event":"error","t":1795401942649,"code":"uncaught.exception"},{"run":"01M834Q1KEMCBN373NYE1BV2BG","seq":3,"event":"end","t":1795401942649},{"run":"01M834Q1QFYZZ3CMXZ0SKE600Z","seq":3,"event":"result","t":1795401942776},{"run":"01M834Q1KEMCBN373NYE1BV2BG","seq":1,"event":"receipt.head","t":1795401942647}],"_schema":{"id":"parley.lens","version":"1.0.0"}}
```

That line is 1,336 bytes. Seven things in it are the whole feature:

- **It names the four best-ranked records of what it may name**, and nothing else: the failing
  run's `error` and status-2 `end` first, then the successful run's `count.result`, then the
  failing run's head. The bound cut the tail of the order flyingrobots/parley#49 produced, not a
  selection made some other way.
- **It says what that cost**, as a count: `excluded: 7`. The count is present at zero too, because
  an absent count and a count of zero are different claims.
- **It cannot read as complete.** `loss.bound` is `count-only`; `none` is only valid beside a
  count of 0, and the schema refuses the other pairing.
- **It is the way back.** Each named record is a `(run, seq)` pair, so a drill-down fetches records
  rather than re-deriving them from a result — see [opening what a digest names](#opening-what-a-digest-names).
- **Each name says what it is.** Beside its `(run, seq)`, every entry carries the record's
  `event` and its `t`, and an `error` its `code`, so a reader sees an `uncaught.exception`
  error, an `end`, a `result` and a head without opening any of them (flyingrobots/parley#77). The
  summary is read off the loaded record.
- **Each run is said once.** `runs` holds one section per run the entries name: the head's
  `tool`, `v`, `argv`, `resolved` and `inv`, and the run's `outcome` over the whole window, so the first
  section reads as `count files` that `failed` and the second as the same invocation that
  `succeeded` (flyingrobots/parley#83). `resolved` is the head's interpretation, whole:
  `{"command":"files","args":[]}` here, and for a tool that resolves `HEAD~1..HEAD` the two
  commits it compared (flyingrobots/parley#90). Like the summary, it counts against `budget.bytes`.
- **A repeat is said once too.** The two runs that `succeeded` share an `inv` and a result, so the
  second section stands for both: `folded: {"others": 1, "records": 4}`, this run and one other
  like it whose 4 records are not named (flyingrobots/parley#100), and `loss.folded` says 4 of
  the 7 excluded were left out by that fold rather than by the budget (flyingrobots/parley#79). The
  failed run shares the `inv` and not the result, so it is never folded into them. See
  [runs of one invocation](../../docs/topics/parley-read/README.md#runs-of-one-invocation-are-named-once).

## Opening what a digest names

`openRecords` takes the `(run, seq)` pairs a lens carries and answers with one outcome per id, in
the order asked:

```ts
const read = await queryReceipts({ asker: { tool: "claude-code" }, view: "what-failed", window }, { cwd });
if (read.refused) throw new Error(read.refusals.map((r) => r.code).join(", "));
const opened = await openRecords(
  { asker: { tool: "claude-code" }, view: read.view, window: read.window, records: read.digest.records },
  { cwd },
);
if (opened.refused) throw new Error(opened.refusals.map((r) => r.code).join(", "));
for (const o of opened.opened) console.log(o.outcome, o.record?.record, o.bundle?.replay);
```

| Outcome | Means |
| --- | --- |
| `opened` | The record, in full. A record stored in a sidecar comes back with its contents, checked against the declared `sha256`; opening the `sidecar` event itself brings the record it holds as `held` |
| `over_budget` | Only under `budget.bytes`: the record would pass the bound, so its size is named in `bytes` and no part of it is returned |
| `sidecar_unavailable` | The sidecar's stored bytes are missing, mismatched, unreadable or unchecked: the pointer is returned and the contents are not claimed |
| `run_not_found`, `seq_not_found` | Which half of the id did not resolve, with a remedy |

Every id whose run resolved carries the loader's replay ruling, so the `error` of a failed run
opens and says its bundle is unavailable for replay. A drill-down is recorded as a `parley.query`
carrying `records`, so the next reader can see what was opened; it is refused without an asker, a
view, a window and at least one id, and then writes nothing.

A drill-down may state `budget: { bytes }`. Records open whole, in the order asked, while their
summed size (UTF-8 bytes of each record's JSON as returned, sidecar contents included) stays within
the bound; each later id is judged against what remains, so a small record after an over-budget one
may still open. Every id past the bound is `over_budget` with its size and no contents, never a
truncated record. Not-found and `sidecar_unavailable` outcomes cost nothing. The recorded
`parley.query` carries the bound applied. The full rules are in
[the reader page](../../docs/topics/parley-read/README.md#a-byte-bound).

It may also state `budget: { ms }`, the same deadline a read has, checked after the load and after
the ids are opened; a drill-down past it declines as a read does and opens nothing
([the reader page](../../docs/topics/parley-read/README.md#a-deadline)).

## Surface

| Export | Job |
| --- | --- |
| `loadReceipts(opts)` | Every run in both receipt locations for a working directory, as bundles |
| `queryReceipts(request, opts)` | A read: refused without an asker, a view and a window, else recorded as a `parley.query` event and answered with a `parley.lens` digest — the window's records ordered by the view, cut at the budget, and the count the cut left out — or declined with `query.over_budget` when the budget cannot be met |
| `openRecords(request, opts)`, `planOpen(request)`, `openOne(id, bundles)` | The drill-down: records by `(run, seq)`, one outcome per id, recorded as a `parley.query` carrying `records`; its refusal rules as a pure function; one id resolved against loaded bundles |
| `planQuery(request)`, `queryRecord(query)` | The refusal rules and the recorded payload, without any reading or writing |
| `rankRecords(query, records)` | The view's order over records, pure: the same records reordered, never a subset |
| `digestFor(query, answers, ranked, envelope, outcomes?)` | The bound over that order, pure: the digest's payload, the records it names, the count it excluded and how many of those it `folded`, the bytes its line takes and whether it `fits` a stated byte bound at all |
| `foldRuns(ranked, outcomes?)` | The fold `digestFor` applies first, pure: runs of one invocation with one result named by the most recent of them |
| `sufficientBytes(query, answers, total, envelope, folded?)` | The smallest `budget.bytes` that holds a digest naming no records, which a byte decline names |
| `Deadline`, `MONOTONIC`, `OVER_BUDGET`, `declineOnRun(run, budget, phase, last, over)` | The deadline `budget.ms` is checked against, the default clock, the decline code, and the step and error a decline reports on its run |
| `digestLine`, `digestBytes` | The line the writer will write for a digest, and its length in UTF-8 bytes |
| `runOutcomes`, `onViewSurface`, `onFailureSurface`, `impliesChange`, `TIERS`, `OUTCOMES`, `CHANGE_VIEWS` | The parts of that order, each answerable on its own |
| `VIEWS`, `DEFAULT_BUDGET`, `QUERY_SCHEMA`, `LENS_SCHEMA`, `NO_RETENTION` | The five view tokens, the one documented budget default, the two pairs a read emits, and the retention policy a read states |
| `readReceiptFile(path, opts)` | One receipt file; a file holding more than one run yields one bundle per run |
| `readHistorySegment(path, opts)` | One segment of the shared stream (§8), the same way; a copy in it may be a projection of the receipt copy |
| `receiptLocations(opts)`, `repoReceiptDir`, `stateReceiptDir` | Where receipts are, present or absent; creates nothing |
| `LineBuffer`, `splitLines`, `readFileLines` | Newline buffering: bytes in, complete lines out, the unterminated tail kept apart (§1.4, §5.4) |
| `validator(schemas?)`, `schemaRef`, `envelopeGaps` | Exact-pair validation and the version-independent core (§4.5, §4.6) |
| `SCHEMAS`, `SCHEMA_SOURCE` | The seventeen schemas this reader ships, the released versions of spec `0.2.0`'s release, with the commit and digest of each |
| `QUARANTINE_CODES` | Which defect codes are a kept line rather than a judgement about a record |

## What a load says, rule by rule

| It reports | Because |
| --- | --- |
| Both locations, present or absent | §5: the writer falls back to the state directory, so a reader that looks in one place sees half the history |
| Records in `seq` order, one per `(run, seq)` | §1.3: a run holds one counter, and copies of one event are one event |
| A copy's extra fields folded in, a disagreement as a defect | §1.3: a copy may carry fields another omits, but copies must agree on every field they share |
| The copy from the source with no transform line for the run, and the other as a `Projection` | §8: the receipt copy is the record and a projection is a view of it, so a reader prefers the least-projected copy it can see — and says what the other one was, and which `seq` it withheld |
| A stray line quarantined, kept, attributed to the run | §1.4: kept and reported, and evidence of nothing but the fact that something wrote it |
| An unterminated final line ignored, including a parseable `end` | §5.4: it is not a line, so it cannot establish termination |
| `validated`, `invalid`, `partial`, `unvalidated` per record | §4.5: full validation is against the exact pair, and "the part I recognise passed" is never "the contract passed" |
| A sidecar's bytes checked against `bytes` and `sha256`, and the record restored | §5: a sidecar stands in a record's place, and its path must not leave the bundle |
| `replay.unavailable` with its reasons | §5, §5.3, §5.4: a broken sidecar, no terminated `end`, a non-zero status or a redacted receipt each rule replay out |

`replay.unavailable: false` means only that nothing in the bundle rules replay out. Eligibility
under §2.3 and §5.3 for the invocation at hand — whether that invocation supplied a declared
secret, whether its `inv` matches — is the caller's to decide, and this reader does not know it.

## What it does not do

- Project. The records a digest names come back whole; no view reduces one to fewer fields
  (flyingrobots/parley#59).
- Hand back what the bound excluded. The digest states the count and names only what it kept, so
  the drill-down opens those; the excluded tail is a wider read.
- Interrupt a phase. `budget.ms` is checked between the load, the ranking and the digest, so a
  slow load is discovered when it finishes and the read then declines; it never answers from part
  of the history (flyingrobots/parley#71).
- Apply a transform at read time. It prefers the least-projected copy it can see and names the
  projection it passed over; re-projecting a record for an asker is
  flyingrobots/parley#59's.
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
