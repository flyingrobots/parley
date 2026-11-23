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
reader cannot mistake a digest for the whole.

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
| `budget` | Verbatim, defaulted to `{"records": 20}` and the answer says it defaulted | **The bound.** `records` bounds how many records the answer names; `bytes` bounds the digest's line; `ms` bounds nothing (below) |
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
| `ms` (optional) | **Nothing.** A read that has loaded the history has already spent its time |

`loss.excluded` is always there, zero included — an absent count and a count of zero are different
claims — and `loss.bound` is `none` only beside a count of 0, which the schema refuses to pair any
other way. So a digest that left something out says so structurally rather than in prose. What it
excluded is not returned by another route; fetching it is
[flyingrobots/parley#51](https://github.com/flyingrobots/parley/issues/51). `counts.inWindow` and
the ranking's tier census still describe the whole window the digest was drawn from, so the caller
can see it is not the whole without being handed what it cut.

### The view orders the answer, and filters none of it

Spec §9: the purpose shapes the result, and it is the **ranking function** rather than a filter
applied afterwards. One total order on a key per record, compared left to right:

1. **the failure surface**, when the view is an answer about a change — a read made in order to
   change something is a read made in order not to repeat a failure;
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

The same three runs, read again with `budget: {"records": 4}` over the day's window on 2026-11-22.
Eleven records are in the window and the digest names four of them, so it says `excluded: 7`.
These are the two lines that read's own receipt holds, byte for byte — `bun run check` validates
both against the shipped schemas:

```jsonl
{"event":"query","t":1795391920147,"seq":2,"run":"01M82V560AR9BD2BEZSAKRR7MJ","asker":{"tool":"claude-code","cwd":"/var/folders/wt/s8clst9955x1l0qblsl4925w0000gn/T/parley-digest-readme.QpEuMA/work","task":"flyingrobots/parley#50"},"view":"what-changed","budget":{"records":4},"window":{"from":1795305520135,"to":1795391920135},"note":"about to change the counter; what has it done here","_schema":{"id":"parley.query","version":"1.0.0"}}
{"event":"lens","t":1795391920234,"seq":6,"run":"01M82V560AR9BD2BEZSAKRR7MJ","query":{"run":"01M82V560AR9BD2BEZSAKRR7MJ","seq":2},"asker":{"tool":"claude-code","cwd":"/var/folders/wt/s8clst9955x1l0qblsl4925w0000gn/T/parley-digest-readme.QpEuMA/work","task":"flyingrobots/parley#50"},"view":"what-changed","budget":{"records":4},"window":{"from":1795305520135,"to":1795391920135},"loss":{"bound":"count-only","excluded":7},"records":[{"run":"01M82V55XKZSRC6ERNSAG0QJMH","seq":2},{"run":"01M82V55XKZSRC6ERNSAG0QJMH","seq":3},{"run":"01M82V55V1679ZY07B6X3HEVND","seq":3},{"run":"01M82V55ZV6JPSEQ6Q947C9QW0","seq":3}],"_schema":{"id":"parley.lens","version":"1.0.0"}}
```

That line is 664 bytes. Four things in it are the whole feature:

- **It names the four best-ranked records of eleven**, and nothing else: the failing run's `error`
  and status-2 `end` first, then the two successful runs' `count.result` records. The bound cut the
  tail of the order flyingrobots/parley#49 produced, not a selection made some other way.
- **It says what that cost**, as a count: `excluded: 7`. The count is present at zero too, because
  an absent count and a count of zero are different claims.
- **It cannot read as complete.** `loss.bound` is `count-only`; `none` is only valid beside a
  count of 0, and the schema refuses the other pairing.
- **It is the way back.** Each named record is a `(run, seq)` pair, so a drill-down fetches records
  rather than re-deriving them from a result (flyingrobots/parley#51).

## Surface

| Export | Job |
| --- | --- |
| `loadReceipts(opts)` | Every run in both receipt locations for a working directory, as bundles |
| `queryReceipts(request, opts)` | A read: refused without an asker, a view and a window, else recorded as a `parley.query` event and answered with a `parley.lens` digest — the window's records ordered by the view, cut at the budget, and the count the cut left out |
| `planQuery(request)`, `queryRecord(query)` | The refusal rules and the recorded payload, without any reading or writing |
| `rankRecords(query, records)` | The view's order over records, pure: the same records reordered, never a subset |
| `digestFor(query, answers, ranked, envelope)` | The bound over that order, pure: the digest's payload, the records it names, the count it excluded and the bytes its line takes |
| `digestLine`, `digestBytes` | The line the writer will write for a digest, and its length in UTF-8 bytes |
| `runOutcomes`, `onViewSurface`, `onFailureSurface`, `impliesChange`, `TIERS`, `OUTCOMES`, `CHANGE_VIEWS` | The parts of that order, each answerable on its own |
| `VIEWS`, `DEFAULT_BUDGET`, `QUERY_SCHEMA`, `LENS_SCHEMA`, `NO_RETENTION` | The five view tokens, the one documented budget default, the two pairs a read emits, and the retention policy a read states |
| `readReceiptFile(path, opts)` | One receipt file; a file holding more than one run yields one bundle per run |
| `receiptLocations(opts)`, `repoReceiptDir`, `stateReceiptDir` | Where receipts are, present or absent; creates nothing |
| `LineBuffer`, `splitLines`, `readFileLines` | Newline buffering: bytes in, complete lines out, the unterminated tail kept apart (§1.4, §5.4) |
| `validator(schemas?)`, `schemaRef`, `envelopeGaps` | Exact-pair validation and the version-independent core (§4.5, §4.6) |
| `SCHEMAS`, `SCHEMA_SOURCE` | The seventeen draft schemas this reader ships, with the commit and digest of each |
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

- Project. The records a digest names come back whole; no view reduces one to fewer fields
  (flyingrobots/parley#59).
- Hand back what the bound excluded, or decline on budget grounds. The digest states the count and
  stores the way back; fetching those records is flyingrobots/parley#51, and "not within your
  budget, and here is the budget that would do it" is something `parley.lens` 1.0.0 cannot say.
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
