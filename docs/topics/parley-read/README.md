# parley-read

The reader library: `@flyingrobots/parley-read`, under `packages/parley-read`. It opens the
receipt bundles a repository has accumulated and returns every run's records, under the rules the
[specification](../../../spec/parley-v0.2.md) binds a reader to, and it answers a read over those
records — refused unless it states who it is for and what it wants, recorded as a run of its own,
ordered by the purpose it states, and bounded by the budget it states, with a digest that says
what the bound left out — and it opens the records a digest names, by `(run, seq)`, in full. This page is the reference for what the package does on `main`; the
package [README](../../../packages/parley-read/README.md) is the front door with a captured load,
a captured read, a captured ranking and a captured digest, and the [test plan](test-plan.md)
beside this page is the contract ledger.

It is a library with no command, and it is not published. The repository's `bun test` runs its
suite and `bun run typecheck` checks it strictly, over `src`, `scripts` and `test`.

## Surface

| Export | Job |
| --- | --- |
| `loadReceipts(opts)` | Every run in both receipt locations for a working directory, as bundles; `opts` takes `cwd`, `env`, `home`, `sidecars`, a `validate` validator and `history`, the stream segments to read beside the receipts |
| `queryReceipts(request, opts)` | A read: refused without an asker, a view and a window, else recorded as a `parley.query` event through the writer and answered with a **digest** — the window's records ordered by the view, cut at the budget, and a `parley.lens` record saying what the cut left out — or, when the budget cannot be met, a **decline**; `opts` takes the loader's options plus `tool`, `stdout`, `stderr`, `session`, `now` and `clock` |
| `openRecords(request, opts)` | A drill-down: refused without an asker, a view, a window and at least one `(run, seq)`, else recorded as a `parley.query` event naming the ids and answered with **one outcome per id** — the record in full, a sidecar's contents included, and the bundle's replay ruling; `opts` as for `queryReceipts` |
| `planOpen(request)`, `openOne(id, bundles)` | The drill-down's refusal rules as a pure function, and one id resolved against loaded bundles, reading nothing further |
| `planQuery(request)` | The refusal rules and the budget default, as a pure function: it reads nothing, writes nothing and records nothing |
| `queryRecord(query)` | The `parley.query` payload for an accepted read, without the envelope the writer owns |
| `rankRecords(query, records)` | The ranking, as a pure function from an accepted query and records to the same records in one stated order |
| `digestFor(query, answers, ranked, envelope, outcomes?, heldBack?)` | The bound, as a pure function from an accepted query and a ranking to the digest's `parley.lens` payload, the records it names, the count it excluded and how many of those it `folded`, the bytes its line will take and whether it `fits` a stated byte bound at all; `outcomes` is the ranking's per-run verdict, which each run section carries and without which nothing [folds](#runs-of-one-invocation-are-named-once); nothing folds either when the query states `fold: false`, and a run named in `heldBack` never folds |
| `sufficientBytes(query, answers, total, envelope, folded?)` | The smallest `budget.bytes` that holds a digest naming no records (and so no run sections) over a ranking of `total` of which the fold left `folded` out, which is what a byte decline names |
| `foldRuns(ranked, outcomes?, view?, heldBack?)` | The fold, as a pure function: the ranked records with every folded-away run's removed, each representative's `{others, records, stands_for}`, and the count left out. `view` decides whether decision records are compared; without it only results are; `heldBack` names runs that never fold — see [runs of one invocation](#runs-of-one-invocation-are-named-once) |
| `Deadline`, `MONOTONIC`, `OVER_BUDGET`, `declineOnRun` | The deadline `budget.ms` is checked against, the default clock it is measured on, the one code a read declines with, and the step and error a decline reports on its run |
| `lensEntry(record)` | The entry a digest names one record by: its `(run, seq)` and its summary |
| `runSection(run, window, outcomes?, fold?)` | What a digest says once about one run it names, read off the window's records: see [what each run section says](#what-each-run-section-says) |
| `RUN_SECTION_BYTES`, `DROPPABLE`, `UNDETERMINED_REASONS` | The bound on one run section (512 bytes), the fields it drops to fit in the order it drops them (`resolved`, `argv`, `inv`, `v`, `tool`), and the closed set of reasons an outcome is `undetermined` |
| `digestLine(digest, envelope)`, `digestBytes(digest, envelope)` | The line the writer will write for a digest, and its length in UTF-8 bytes: how a byte budget is applied before the line exists rather than discovered after it |
| `runOutcomes(records)`, `onViewSurface(view, record)`, `onFailureSurface(record)`, `impliesChange(view)` | The four questions the ranking asks, each answerable on its own |
| `TIERS`, `OUTCOMES`, `CHANGE_VIEWS` | The three tiers best first, the three outcomes best-known-worst first, and the views that imply a change |
| `VIEWS`, `DEFAULT_BUDGET`, `QUERY_SCHEMA`, `LENS_SCHEMA`, `NO_RETENTION` | The five view tokens, the one documented budget default (`{"records": 20}`), the two pairs a read emits, and the retention policy a read states |
| `readReceiptFile(path, opts)` | One receipt file, as a `FileRead`: its line count, the runs it holds, its quarantined lines and one bundle per run |
| `readHistorySegment(path, opts)` | One segment of the shared history stream (§8), the same way: a file of whole runs from every tool that wrote to it, one bundle per run |
| `receiptLocations(opts)`, `repoReceiptDir(cwd)`, `stateReceiptDir(opts)` | Where receipts are for a working directory, each location reported present or absent |
| `LineBuffer`, `splitLines`, `readFileLines`, `CHUNK_BYTES` | Newline buffering: bytes in, complete lines out, the unterminated tail kept apart |
| `validator(schemas?)`, `schemaRef`, `envelopeGaps`, `ENVELOPE`, `PROTOCOL_PREFIX` | Exact-pair validation, and the version-independent core a partial check uses |
| `SCHEMAS`, `SCHEMA_SOURCE` | The nineteen schemas the package ships: each message at its current released version, and the released 1.0.0 of `parley.query` and `parley.lens` beside their 1.1.0, with the commit and digest of each |
| `QUARANTINE_CODES` | Which defect codes are a kept line rather than a judgement about a record |
| `exactJson(value)`, `MAX_EXACT_DIGITS`, `ExactValue` | Re-exported from `@flyingrobots/parley-emit`. `JSON.stringify` for a value that may hold a `bigint`, written as the JSON number it is; the most digits an integer may have and still be held (4096); and the type of a value a returned record can hold: see [numbers](#numbers) |
| `heldBackRuns(load)`, `NUMBER_UNREPRESENTABLE`, `UNREPRESENTABLE_WARNING` | The runs a load held a line back from, which a read hands to the fold; the defect code of such a line (`line.number_unrepresentable`); and the code of the warning a read reports for them (`read.number_unrepresentable`) |
| `isDirectory`, `isFile` | The two existence questions the loader asks, exported because callers ask them too |

## What a load returns

A `Load` carries the locations it looked in, a `FileSummary` per receipt file it read, a `Bundle`
per run, every quarantined line, the defects that belong to no bundle, and counts. A receipt file
that cannot be opened at all is one of those loose defects — `receipt.unreadable`, attributed to
the run its name names — because a load over a repository's history should not lose the other
bundles to one unreadable file. `readReceiptFile`, which is given one path by name, throws
instead.

A `Bundle` is one run: the `sources` it was read from, its `records` (one per `(run, seq)`,
ascending), its resolved `sidecars`, the `projections` among its copies, its `quarantined` lines,
every `defect` found, how many extra copies were folded in, whether it `terminated`, its `status`,
whether it is `redacted`, and `replay`.

A `LoadedRecord` carries the `run` and `seq` that identify the event, its `event` and `t`, the
`file` and `line` the preferred copy was read from, how many `copies` carried it, whether it came
`fromSidecar`, whether the body is `projected` and `projectedBy` which transforms, the `record`
itself, and a `validation`.

A `validation` is one of four states, and the distinction is the point (§1.2a: a reader must not
take one kind of evidence for another):

| State | Means |
| --- | --- |
| `validated` | The line validated against the schema for its exact advertised `(id, version)` pair |
| `invalid` | That schema rejected it; the validator's messages come with it |
| `partial` | The `_schema.id` is `parley.*` but this reader ships no schema for that version. The §1.3 envelope was checked and the contract was not, and the §1.3 gaps are listed. With `why: "number_undecided"` the schema is shipped, the record holds an integer beyond the safe range, nothing was found to fail, and a constraint that applies to that integer [could not be decided](#validating-a-record-that-holds-one) |
| `unvalidated` | Not validated at all: `tool_owned` when the id belongs to a tool, `no_schema_ref` when the line advertises no pair |

## Locating receipts

Spec §5 gives a writer two places to put a receipt, and the loader looks in both:

| Location | Path |
| --- | --- |
| `repo` | `<cwd>/.parley/receipts/` |
| `state` | `$XDG_STATE_HOME/parley/<repo-hash>/receipts/`, honouring `XDG_STATE_HOME` only when it is set, non-empty and absolute, and otherwise `~/.local/state` |

`<repo-hash>` is the first 16 hex characters of a SHA-256 over the canonical path of the git
worktree root, or of the canonical working directory outside git. That derivation and the state
base come from the writer package rather than being written out a second time: a reader that
derives the key differently by one byte looks in an empty directory and reports, honestly and
uselessly, that there are no receipts.

The working directory is the one the caller names, because that is what the writer used — §5
resolves the location against the invocation's **initial** working directory. A run invoked in a
subdirectory wrote its receipt under that subdirectory, so a caller that wants a whole
repository's history passes the repository root.

Locating creates nothing. A location that does not exist is `present: false`, not an error: the
writer never needed it.

## Reading the bytes

Lines come out of a `LineBuffer`, which holds **bytes** and splits on `\n` alone:

- A read chunk is not a line boundary (§1.4), so JSON that arrived across two reads is one line.
- A multi-byte character split across a chunk boundary is not two broken characters either, which
  is why the buffer holds bytes and decodes a line once it is whole.
- The remainder at EOF is not a line (§5.4). It is reported, and it is not a record even when it
  parses — including an otherwise parseable `end`, which therefore establishes no termination.

`readFileLines` reads a receipt in 64 KiB chunks through that buffer, so the buffering in the
tests is the buffering in use and not a pretence.

## Numbers

A JSON number is a decimal of any size, and JavaScript's parser holds every number as a double. A
record is loaded with **the integer its text states**, in a receipt line and in a sidecar's
contents alike ([flyingrobots/parley#159](https://github.com/flyingrobots/parley/issues/159)).
This is a fix to **integer** precision. A `bigint` does nothing for a non-integral decimal: those
are doubles, or they are not held.

### The representation

The rule is decided from the number as written, and there is one boundary: JavaScript's
safe-integer range, −9007199254740991 to 9007199254740991, which is −(2^53)+1 to (2^53)−1 and the
range in which every JSON implementation agrees on an integer.

| The number, as written | Is loaded as | Examples |
| --- | --- | --- |
| Integer-valued, inside the range | A `number` | `9007199254740991`; `5.0` and `1e3` are 5 and 1000 |
| Integer-valued, outside the range | A `bigint` holding exactly that integer, **always**, even where a double could hold it | `9007199254740992` is `9007199254740992n`; `9007199254740993`, `9007199254740993.0` and `9.007199254740993e15` are all `9007199254740993n`; `1e21` is `10n ** 21n`; `1e400` is `10n ** 400n` |
| Not an integer, and writing the number back states the same decimal: its decimal value is the decimal value of the number's own JSON serialisation | A `number`, the double it parses to | `1.5`; `0.30000000000000004`; `0.1`, `0.10` and `1e-1`, which are one decimal |
| Not an integer, and a double does not give that decimal back; or an integer of more than `MAX_EXACT_DIGITS` (4096) digits | Nothing. The reader cannot hold it and does not return it rounded: the line is [held back](#quarantine) | `0.10000000000000001`; `0.1000000000000000055`; `1e-400`; `1e1000000000` |
| A string of digits | The string it is | `"9007199254740993"` |

Because the boundary is fixed, neighbouring large identifiers never alternate between two types,
and which type a value has depends on the value alone, never on how it was spelt. A line whose
numbers all load as JavaScript numbers, which is nearly every line an ordinary writer produces, is
parsed by `JSON.parse` and nothing else.

**Two decimals that round to one double are not the same evidence.** `0.1` and
`0.10000000000000001` state different values, and the reader does not infer from the digits that
the longer one was a formatter's rendering of the shorter
([flyingrobots/parley#173](https://github.com/flyingrobots/parley/issues/173)). Accepting `0.1` is
not a claim that it has an exact binary form: it is that loading it and serialising it preserves
the decimal the JSON states. The cost falls on a writer that prints doubles with seventeen
significant digits, as C's `%.17g` does. Not on every line it writes: on the spellings that fail
the rule. `0.5`, `0.25` and `0.30000000000000004` print the same either way and load; `0.1` printed
as `0.10000000000000001` is held back. Keeping a decimal's exact identity beside the number, so
those spellings load too, is that issue's open follow-up.

**The cap is an implementation limit, not a rule about numbers.** An integer of more than 4096
digits is a legitimate JSON number; this reader does not build it. Nothing is built in proportion
to a number's magnitude: `1e1000000000` is classified from its digits and its exponent, found to
be past the cap, and held back without being materialised, and a token of two million digits is
counted, not converted. The value stays visible through the refusal: the line's bytes are kept
verbatim in the defect, with its file and line number.

### Writing a record back out

The exact parser and serialiser are the writer's, `@flyingrobots/parley-emit`'s `parseExact`
and `exactJson`; this package has no copy of its own and re-exports `exactJson`, `ExactValue` and
`MAX_EXACT_DIGITS`. The reader, both writers and the corpus under
[conformance/numbers](../../../conformance/numbers/README.md) are held to one rule: every case of
that corpus is run through the loader (RD-124).

**`JSON.stringify` throws on a record that holds a `bigint`.** `exactJson(value)` is
`JSON.stringify` for such a value: the integer is written as the JSON number it is, exact unquoted
digits (`{"value":9007199254740993}`), never a string and never with a suffix; a value holding
none comes out byte for byte as `JSON.stringify` writes it. A record loaded and written with
`exactJson` carries the digits its receipt carries (RD-120h).

A consumer that parses that text with an ordinary `JSON.parse` **loses the precision again**. The
digits survive only through a parser that keeps them, as this one does.

### What the reader does with a `bigint`

| Where | What happens |
| --- | --- |
| Copies of one `(run, seq)`, the [least-projected copy](#the-least-projected-copy) and the [fold](#runs-of-one-invocation-are-named-once) | Compared through `exactJson`, by value: two different integers never compare equal, an integer equals the same integer written another way, and a number never equals a string of its digits |
| The drill-down's [byte bound](#a-byte-bound) | `recordBytes` is the UTF-8 length of the record's `exactJson` text, so the integer counts by its digits |
| Validation against a shipped schema | **Decided exactly, as far as it can be**: see [validating a record that holds one](#validating-a-record-that-holds-one). `invalid` on one conclusive failure, `validated` when every constraint that applies was decided, `partial` with `why: "number_undecided"` otherwise. Never a verdict from a rounded stand-in. A read's own `parley.lens` line whose section carries such a `resolved` loads `validated`: the schema says of `resolved` only that it is an object, and that is decided |
| `seq` | **Rejected when out of range.** Every identity the reader hands out is a `number`, so the largest `seq` it places is 9007199254740991. A line whose `seq` is beyond it is [held back](#quarantine) whole and never placed at another `seq` |
| `t` | Kept exact in the record. `LoadedRecord.t` is null, so the record is undated: it is in no window, `counts.undated` counts it, and it sorts last in its tier |
| `end.status` | A status other than zero: the run `failed` and replay is unavailable for `end.status_nonzero`. `Bundle.status` is a `number` or null, and is null. Separately, the record is `invalid` against `parley.end`, whose `maximum` is 255: schema validity and the run's outcome are two findings |
| A `sidecar` event's `source` or `bytes` | The sidecar is `unreadable`: it does not name a usable `source` and `bytes` |
| A run section's `resolved` | Carried whole and exact, like any other: the lens line that is written holds the integer's digits. The section's size, `digestLine` and the byte budget are measured on that text. It is left out only when the section is too large, and `dropped` means that and nothing else (RD-123) |
| The lines a read writes | Written by the writer library (`@flyingrobots/parley-emit` 0.5.0 or later), which writes a `bigint` as exact digits. A lens names records by `(run, seq)`, `event`, `t` and `code`; the one field copied from a record is `resolved`, the row above. `answer.lines` are those lines parsed exactly, so a `bigint` the read wrote comes back as one |

### Validating a record that holds one

The schema validator checks `integer` and `number` by JavaScript type and holds every number as a
double, so it is never handed a `bigint` and never a rounded stand-in for one. A record that
holds a `bigint` is decided in two parts (`src/decide.ts`):

- **Every part of the record that holds no `bigint` goes to the schema validator**, with the
  subschema that applies to it, unchanged. An ordinary `status: 256`, a wrong type or a missing
  required member beside an unrelated `bigint` is found exactly as it always was.
- **Along the path to a `bigint`, the reader evaluates the keywords itself**, with the integer's
  exact value.

| Decided exactly | How |
| --- | --- |
| `type` | A `bigint` is an `integer` and a `number` |
| `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum` | The integer against the schema's number, compared exactly |
| `multipleOf` a positive integer | Integer arithmetic |
| `const`, `enum` | By value, at any depth |
| `required`, `properties`, `patternProperties`, `additionalProperties`, `propertyNames`, `minProperties`, `maxProperties`, `dependentRequired`, `dependentSchemas` | On the object that holds the integer |
| `items`, `prefixItems`, `minItems`, `maxItems`, `uniqueItems`, `contains` without `minContains` or `maxContains` | On the array that holds it; `uniqueItems` compares by exact value |
| `allOf`, `anyOf`, `oneOf`, `not`, `if` / `then` / `else` | Three-valued, below |
| String keywords and non-numeric `format`s | Do not apply to a number, an array or an object |

| Stays undecided | Because |
| --- | --- |
| `$ref`, `$dynamicRef`, in the path to the integer or in a subschema handed to the validator | A reference is written against the whole document; a part is not decided alone |
| A numeric `format` (`int32`, `int64`, `float`, `double`) on the integer | Not implemented |
| `multipleOf` a non-integer; `contains` with `minContains` or `maxContains`; `unevaluatedProperties`, `unevaluatedItems`; the older tuple form of `items`; any keyword not named above | Not implemented |
| A bound, `const` or `enum` member in the schema that is itself an integer beyond the safe range | The schema document was parsed into doubles, so that constant may not be the one written |

The verdicts combine as the keywords do, and soundly:

- A schema is a conjunction. **One conclusive failure makes the record `invalid`**, whatever else
  is undecided, and the rest need not be evaluated to say so. It is `validated` only when every
  keyword that applies was decided and none failed. Otherwise it is `partial` with
  `why: "number_undecided"` and a `record.number_undecided` defect.
- `anyOf` fails only when every branch fails. A failing branch beside an undecided one proves
  nothing. `oneOf` fails on two passing branches, or on none with none undecided.
- A failure under `not` is the keyword passing; an undecided schema under `not` stays undecided.
- `if` takes the branch its condition's verdict selects. With an undecided condition, only what
  `then` and `else` agree on is concluded.

Every schema the package ships uses only keywords in the first table, with no `$ref` and no
numeric `format`, so a shipped-schema record holding a `bigint` is decided: an `end` whose `status`
is `9007199254740993` is `invalid` (`/status must be <= 255`); a `receipt.head` whose `t` is that
integer is `validated`, because the schema says of `t` only that it is an integer of at least 0.
That verdict is about the schema. It does not say the reader can date the record: it cannot, and
`LoadedRecord.t` is null. `partial` arises with a caller's own schemas (RD-121).

### What the scan costs

Establishing that a line's numbers are ordinary is one pass over its text, skipping strings. A
number of at most fifteen digits with no exponent is settled without parsing it; a longer one, or
one with an exponent, is parsed and compared; a line that holds a `bigint` is parsed a second time
by the writer's exact parser, which the reader imports.

Two workloads were measured, and they are two workloads: nothing here is a claim about receipts
in general. Each is one receipt of 200,002 lines, a head, an `end`, and 200,000 lines alternating
a `receipt.step` record with a tool's own result holding a path, two integers, a six-digit
fraction, a 64-character hex digest and an array of four numbers.

| Workload | The array's third number | Size |
| --- | --- | --- |
| mixed | `1e3`, an exponent form, which the scan parses | 58.8 MB |
| ordinary | `1000`: integers and short decimals only | 58.9 MB |

Method: the receipt is written once to a fresh temporary directory; `loadReceipts` is called seven
times in one process and each call timed with `performance.now()`; the median of the seven is one
figure. Three rounds, alternating the reader before the change (origin/main's sources, which are
0.2.0's) and after it, on Bun 1.4.5 on one machine that was running other work at the time.
Measured on 2026-11-26 at commit `b7c6f82`, after the parser became the writer's.

| Workload | Median before (ms), three rounds | Median after (ms), three rounds |
| --- | --- | --- |
| mixed | 164, 174, 165 | 225, 230, 232 |
| ordinary | 174, 170, 173 | 211, 233, 224 |

The after figure was higher in every pair: by 56 to 67 ms on the mixed receipt and by 37 to 63 ms
on the ordinary one, which is 0.2 to 0.35 µs a line and about a third more time for a load of this
shape. An earlier measurement, on a busier machine and with the reader's former copy of the
parser, put the difference between 7 and 93 ms with a spread as large as the difference; these
rounds agree with one another to within 20 ms. They measure loading only. A read also serialises
records to compare and to size them, and that cost was not measured.

## Quarantine

Five codes are a kept line rather than a judgement about a record, and `QUARANTINE_CODES` names
them. Each carries the bytes verbatim in `raw`, the file and 1-based line, and the run it is
attributed to:

| Code | Line | Section |
| --- | --- | --- |
| `line.quarantined` | Not JSON, or JSON that is not an object | §1.4 |
| `line.blank` | Empty or whitespace, which is not a JSON object either | §1.4 |
| `line.no_envelope` | A JSON object with no usable `run` and `seq`, so it cannot be placed in a run or deduplicated | §1.3 |
| `line.unterminated` | The final fragment, with no newline | §5.4 |
| `line.number_unrepresentable` | A JSON object holding a [number the reader cannot represent](#numbers), or whose `seq` is beyond the safe-integer range | §1.1, §1.3 |

§1.4 asks that a quarantined line be attributed to the run. A receipt file is one run's by name
(§5: `<run>.jsonl`), so that is the attribution; a file holding more than one run, with a name
that names neither, leaves its quarantined lines unattributed rather than guessed at. A
`line.number_unrepresentable` line is a JSON object, so when it states a `run` it is attributed to
that run whatever the file is called, and it carries its `seq` when it states a usable one.

A quarantined line is never evidence of anything beyond the fact that the writer, or something
sharing its descriptors, wrote it. It is not a record, it does not count toward validation, and it
cannot close a run.

`line.number_unrepresentable` is the one code that is the reader's limit rather than the line's
fault, and it is evidence of one thing more: its run has a record the reader could not return. So
a read never folds that run into another, or another into it; it counts such lines in
`counts.unrepresentable`; and it reports one `warning` on its own run, code
`read.number_unrepresentable`, naming how many lines and which runs (the first twenty), because
`parley.lens` has no field that could say so. The drill-down answers that line's id
`seq_not_found`, saying that the line is there and where its bytes are.

## One event per `(run, seq)`

§1.3 makes `(run, seq)` an event's identity, so the loader folds every line carrying a pair into
one record: the first copy is the record, a later copy contributes the fields it alone carries
(§1.3 lets the receipt copy be the fuller one), and a disagreement on a shared field is reported
as a `copies.disagree` defect rather than becoming a second event. `copies` says how many lines
carried the event, and `duplicates` counts the extras folded in. Copies that differ because one of
them is a **projection** of the other are not that case; they are the next section.

Two consequences fall out of this. A file holding the lines of two runs — two runs interleaved on
one stream — comes back as two bundles, each with its own records. And a bundle copied into both
locations comes back as one bundle naming two sources, with its records not doubled.

## The least-projected copy

Spec §8 lets a copy of a run on the shared history stream be a **projection** of the receipt copy
rather than the whole of it — a path, a hostname or a repository name that is fine in a local
receipt can be wrong on a timeline other people and tools read — and asks a reader that finds the
same record in more than one copy to prefer the least-projected one, "because the receipt copy is
the record and a projection is a view of it".

A copy says it is a projection by opening with a `parley.history.transform` line naming the
transform that wrote it and the SHA-256 of that transform's source text. That line names **one
run**, and the loader reads it out of the source's own content: one segment can hold a projected
copy of one run beside a whole copy of another, and which copy is preferred never depends on which
file was read first.

The rule, per `(run, seq)`:

| The copies read | What comes back |
| --- | --- |
| Only copies from sources carrying no transform line for the run | §1.3 as before: one record, a field one copy alone carries folded in, a disagreement a `copies.disagree` defect |
| Such a copy and a projected copy identical to it | one record, `copies: 2`, like any pair of identical copies — and a note, because that one copy was a view of it is worth knowing either way |
| Such a copy and a projected copy that differs | the unprojected copy's body, whole. The projected one is **superseded** and listed on its note; it contributes no field, because a view of a record cannot add to the record |
| Only projected copies, all by one transform | that body, `projected: true`, with `projectedBy` naming the transform |
| Only projected copies, by different transforms | §1.3's fold over them in a stated order — the transform's name, then its digest, then the file — with every transform named on the record and a disagreement reported as `copies.projected_disagree` |

§8 lets a projection narrow the **body**; it never changes the envelope. A projected copy that
disagrees with the record on `event`, `t` or `_schema` is therefore §1.3's defect in whatever wrote
it — a `copies.disagree`, reported whichever copy the preference returned — and only a disagreement
on a body field between two projections is `copies.projected_disagree`.

A `seq` an unprojected copy carries and a projected copy does not is **withheld** by that
transform. It is on the note by number, so it is not a gap of unknown cause, and a `seq` the
projected copy accounted for with a `sidecar` event is carried rather than withheld (§5).

A projection is **not a defect**: narrowing what reaches a shared timeline is what a transform is
for, so `defects` stays what could not be read or could not be validated, and each projected copy
is a note beside it, one per source.

| `Projection` | Is |
| --- | --- |
| `file`, `where` | The source whose copy of this run is a projection |
| `name`, `sha256` | The transform, as its opening line names it and digests its source text |
| `seq` | The `seq` that opening line took. It reaches no other sink, so no other copy has a line there |
| `superseded` | The `seq` values where this copy's body differed and the record was returned instead |
| `withheld` | The `seq` values a copy of this run read elsewhere carries and this one does not |
| `sole` | No unprojected copy of this run was read, so the records returned are this projection's |

The opening line is a record in its own right, at the one `seq` only the stream carries. It is
validated against `parley.history.transform` 1.0.0 like any other `parley.*` line, and it is
marked `projected`, because no unprojected copy of it exists or could.

### Handing the loader a segment

§8's dependency runs one way and the stream is opt-in, so this reader never goes looking for a
segment. A caller that has one names it:

```ts
const load = loadReceipts({ cwd: "/work/site", history: ["/var/lib/parley/history/2026-11-22.jsonl"] });
for (const bundle of load.bundles) {
  for (const p of bundle.projections) console.log(bundle.run, p.name, p.superseded, p.withheld);
}
```

A read takes the same option — `queryReceipts(request, { cwd, history })` — and passes it to
the loader, so a read sees exactly the copies a load would. Segments are read after both receipt
locations, which changes nothing about the preference and makes the order stated rather than
incidental. `readHistorySegment(path)` reads one on its own,
under the same reader rules as a receipt: a segment holds whole runs from every tool that wrote to
it, so it yields one bundle per run, and its file name names a date rather than a run, so a
quarantined line in it is attributed only when the segment holds exactly one run. A segment named
but unopenable is a `history.unreadable` defect in `load.defects` rather than a throw, for the
same reason an unreadable receipt is.

`BundleSource.receipt` names the file a copy was read from, so for a segment it is the segment;
the field is older than the stream.

## Sidecars

A `sidecar` event stands in the place of the record it holds (§5). It is a record in its own right,
with its own `seq` and schema, and the loader also restores the record it holds at the `seq` named
by `source`, marked `fromSidecar`. A `SidecarResolution` says what happened:

| State | Means |
| --- | --- |
| `intact` | The stored bytes matched the declared `sha256` and `bytes` and parsed to an object; the record was restored |
| `missing` | There is no file at that path |
| `digest_mismatch` | The stored bytes are not what the receipt declared |
| `bytes_mismatch` | The digest matched but the length did not |
| `escapes_bundle` | The path is absolute or would leave the receipt's directory. It was **not read** |
| `unparseable` | The bytes are intact but are not a JSON object, so they hold no record |
| `number_unrepresentable` | The bytes are intact and hold a [number the reader cannot represent](#numbers), so the record is not restored with the number rounded. `actual` carries the measured `bytes` and `sha256` |
| `unreadable` | The `sidecar` event does not name a `source`, `path`, `bytes` and `sha256`, or its file could not be opened |
| `unchecked` | `sidecars: false` was passed, so the stored bytes were never looked at and nothing about them is established either way (§1.2a) |

A sidecar whose path would leave the bundle is refused before anything is read, because §5 says
the bundle moves as one and a path out of it is not part of the bundle at all.

## Replay availability

`replay.unavailable` is `true` when something about the bundle rules replay out, with a reason per
rule:

| Reason | Rule |
| --- | --- |
| `sidecar.missing`, `sidecar.digest_mismatch`, `sidecar.bytes_mismatch`, `sidecar.escapes_bundle`, `sidecar.unparseable`, `sidecar.unreadable` | §5: a reader that finds a sidecar missing or its digest mismatched must treat the bundle as unavailable for replay |
| `sidecar.number_unrepresentable` | §5.4: replay requires the records it needs, and this reader could not restore one without changing a number in it |
| `line.number_unrepresentable` | §5.4: the same, for a line of the receipt itself: the reader held it back, so a record of the run is not among the bundle's |
| `sidecar.unchecked` | §5.4: replay requires intact sidecars, and with resolution off this reader has not established that they are |
| `receipt.no_end` | §5.4: replay requires the records it needs, and nothing establishes termination |
| `end.status_nonzero` | §5.4: replay requires a successful outcome |
| `receipt.redacted` | §5.3: a reader must not replay from a receipt that carries `redacted` |

`redacted` is true when the head carries `redacted`, when any `redaction` event was emitted, or
when `end.redacted` is true — the three the spec makes equivalent (§3.3).

`replay.unavailable: false` means only that nothing in the bundle rules replay out. Eligibility
under §2.3 and §5.3 for the invocation at hand — whether it supplied a declared secret, whether
its `inv` matches — is the caller's to decide, and this reader does not know it.

## Schema resolution

`_schema.id` and `_schema.version` are identifiers, not fetch instructions (§4.6). The pair
resolves against the schemas the package ships in `src/schemas.ts`, generated by
`bun run sync-schemas` from the repository's schemas and pinned by commit and per-file digest: the
top-level file of each message, and every released snapshot under `schemas/released/` of a version
the top-level file does not hold. A test fails when that copy goes stale. Nothing is fetched, and
no other version's schema is ever run over a line and called validation.

That is nineteen schemas. Fifteen messages are at the version released with spec `0.2.0` (the root
`CHANGELOG.md`), each byte-identical to its snapshot (§4.6). `parley.query` and `parley.lens` are
at 1.1.0, released with spec `0.2.1` (flyingrobots/parley#133), and their released 1.0.0 snapshots are shipped beside
them: a history holds the reads an earlier reader recorded, and those lines advertise 1.0.0, so
without its schema they would load `partial`. The package records the commit and digests it
copied (§4.5).

## Making a read

A read states three things, and two of them are never inferred. The shapes, the vocabulary and the
reasoning are [the reader representation](../reader/README.md); what this library adds is the
entry point, the refusal and the record.

| It states | Or else |
| --- | --- |
| `asker` — who the read is for, `tool` required | Refused `query.asker_unnamed`: §2.1 forbids inventing an identity, so a read whose caller cannot be named is not recorded under a guess. A `cwd` that is not an absolute POSIX path, or an empty `task`, is refused `query.asker_invalid` rather than emitted as a line that fails its own schema |
| `view` — one of `what-ran`, `what-failed`, `what-changed`, `how-it-decided`, `everything` | Refused `query.view_missing`, or `query.view_unknown` for a token outside the five: there is no privileged view, and a guessed view is a different answer to a different question |
| `window` — `from` and `to`, POSIX milliseconds, inclusive at both ends | Refused `query.window_missing`, `query.window_invalid` for a bound that is not a non-negative integer, or `query.window_inverted` when `to` is below `from` |
| `budget` — `records` required, `bytes` and `ms` optional | Defaulted to `{"records": 20}`, visibly: the answer carries `budgetDefaulted`, and the digest carries the budget that was actually applied. A bound that is not a positive integer is refused `query.budget_invalid`. A well-formed budget the read cannot meet is not refused: it is [declined](#when-a-read-declines), after the read has run |
| `note` — free text, optional | Refused `query.note_empty` for an empty string, which `parley.query` does not carry |
| `fold` — a boolean, optional | Recorded and echoed by the lens only when stated. `false` turns [the fold](#runs-of-one-invocation-are-named-once) off. A value that is not a boolean is refused `query.fold_invalid` |

A refusal carries `code`, `problem` and `remedy` — §6's fields, so a caller that is itself a
parley tool can hand one to `run.error` — with the `field` it is about and the `section` it is
measured against. Every refusal that applies is returned, not just the first, so one round trip
tells a caller everything that is missing.

One field is inferred rather than refused, as the decision has it: `asker.cwd` is the directory
the read was made against when the caller does not state it, and the recorded query says so.
`asker.task` is never inferred — there is no environment variable for it, and none is read for
it — it is always supplied by the caller and omitted from the record when they do not state it
([flyingrobots/parley#61](https://github.com/flyingrobots/parley/issues/61)).

### A refused read is not a run

It writes nothing: no receipt, no `.parley` directory, nothing anywhere. §9 records a question
that *was asked*, and a question nobody could state has no asker to attribute it to. `planQuery`
is the same rules as a pure function, for a caller that wants to know whether a read would be
accepted before making it.

### An accepted read is recorded

The `parley.query` event goes through the writer
([`@flyingrobots/parley-emit`](../parley-emit/README.md)), so a read is a run like any other
parley program: a bootstrap line, a receipt under the working directory it read, three decisions
recorded as `receipt.step`, the digest it answered with, and an `end` — or, for a read that
[declines](#when-a-read-declines), the decline's step and error in place of the digest. The receipt lands beside
the ones being read, which is what makes the loader find the question on the next read, and the
digest names the query record by `(run, seq)` so a result says which question it answers.

Three consequences worth stating:

- **A read does not answer itself.** Its own records are in the store a moment after they are
  written, and they are excluded from its own answer; `counts.own` says how many there were. The
  next read sees them.
- **A read never expires the history it reads.** §5.1 asks every tool for a retention policy, and
  the one a read states deletes nothing: expiring the receipts it was asked to read would destroy
  the history in order to answer a question about it. Retention is per tool (spec §5.1), so
  the read's own receipts never cost another tool a slot of its count; the read states no
  deletion because the only receipts it could expire are its own, and its policy is
  unchanged.
- **The read's own identity is the reading program's**, `parley-read` at the package version by
  default, or whatever a host program embedding the reader names itself in `opts.tool`. That is
  not the asker: the asker is who the read is *for*, and `run` on a `parley.query` line is the
  read's own run, never a run being read.

### What the answer is, and what it is not

The answer is the window's records ordered by the view (below) and cut at the budget, with
`(t, run, seq)` ascending as the last part of the key so two records stamped the same millisecond
come back in one stable order. A record whose `t` is not a number cannot be placed in a window at
all; it is not in the answer and `counts.undated` says how many there were, rather than dropping
it silently.

| Recorded | Applied |
| --- | --- |
| `asker` | Nothing branches on it: two askers asking the same thing get the same answer |
| `view` | **The order.** It ranks the answer and filters none of it — see [how the purpose orders the answer](#how-the-purpose-orders-the-answer). It does not project a record to fewer fields, and it never removes one |
| `budget` | **The bound.** `records` bounds how many records the answer names, `bytes` bounds the digest's line and `ms` is the read's deadline; what the bound left out is a count on the digest — see [the digest](#the-digest-and-what-it-left-out) — and a bound the read cannot meet is a [decline](#when-a-read-declines) |
| `window` | Yes, and echoed verbatim in the answer and in the digest |
| `note` | Never parsed |

## The digest, and what it left out

Spec §9 asks a result to carry "its own lens — the observer, the purpose and the window that
produced it — so a later reader knows what it is looking at and **cannot mistake a digest for the
whole**", and to report "what it excluded, at least as a count, so a caller can widen deliberately
rather than never learning what it missed". The first response to a read is that digest.

It is a **`parley.lens` 1.1.0 record**, the message decided in
[flyingrobots/parley#46](https://github.com/flyingrobots/parley/issues/46) — not a new one. It
goes through the writer onto the read's own stream and into the read's own receipt, so the digest
is evidence rather than a return value, and the loader reads it back `validated` against that
exact pair. It carries:

| Field | What it is |
| --- | --- |
| `query` | The recorded `parley.query` this digest answers, by `(run, seq)` |
| `asker` | §9's observer: who the read was for |
| `view` | §9's purpose: the shape of the answer, one of the five tokens |
| `window` | The stretch of history the digest was drawn from, echoed verbatim |
| `budget` | The budget **actually applied**, a default included: two digests under different budgets are not comparable |
| `fold` | Echoed from the query, present exactly when the query states it. `false`: nothing was folded |
| `loss` | `bound`, `excluded` and `folded`: what kind of statement the loss is, how many records of the window the digest does not name, and how many of those a [fold](#runs-of-one-invocation-are-named-once) rather than the budget left out |
| `runs` | One [section](#what-each-run-section-says) per run `records` names, in the order the entries first name it: which invocation the run was and what became of it, said once |
| `records` | The records the digest names, in rank order, by `(run, seq)` — the way back a [drill-down](#opening-records-by-identity) takes — each with a [summary](#what-each-entry-says) of the record it names |

### What each entry says

A name alone makes a reader open a record to learn what it is, so each entry also carries a fixed
summary of the record it names
([flyingrobots/parley#77](https://github.com/flyingrobots/parley/issues/77)):

```json illustrative
{"run":"01JD3KQ8Z6V9X2M4N7P1R3T5W8","seq":4,"event":"error","t":1795326412380,"code":"contrast.unsatisfiable"}
```

That entry is a fragment of a lens, not a message of its own; the [package README](../../../packages/parley-read/README.md#a-captured-digest)
holds a captured one.

| Field | Is | Absent when |
| --- | --- | --- |
| `run`, `seq` | The record's identity: the way back to it | Never |
| `event` | The record's event token as the loader read it, a tool's own token such as `result` included verbatim | The record carries no event token |
| `t` | The record's POSIX milliseconds as the loader read them | The record has no non-negative integer `t`. A made-up one would sort and read as real |
| `code` | An `error` or `warning` record's code (spec §6), so three failures of one case read as one case without opening them | The record is neither, or its `code` is not §6's shape: nothing not shaped like a code is echoed |

The summary is read off the loaded record when the digest is built, and from nowhere else, so it
cannot drift from the record it names: RD-50b checks every entry of every view against the loader
read again afterwards. What is true of the whole run, its identity and its outcome, is not on the
entry: it is said once, in the run's section.

### What each run section says

Which invocation a run was is the same for every record of it, so a digest says it once per run,
in `runs`, rather than on each entry
([flyingrobots/parley#83](https://github.com/flyingrobots/parley/issues/83)):

```json illustrative
{"run":"01JD3KQ8Z6V9X2M4N7P1R3T5W8","tool":"theme-book","v":"0.2.1","argv":["theme-book","count","--format","css","--token","[redacted]"],"resolved":{"command":"count","format":"css","cwd":"/work/site","token":"[redacted]"},"outcome":"undetermined","reason":"no_end_in_window"}
```

That section is a fragment of a lens, not a message of its own; the [package README](../../../packages/parley-read/README.md#a-captured-digest)
holds a captured one.

| Field | Is | Absent when |
| --- | --- | --- |
| `run` | The run the section is about, one that `records` names | Never |
| `tool`, `v`, `argv` | The run's `receipt.head` as the loader read it. `argv` is already redacted there (§5.3), so a declared secret is not repeated here | The window does not hold the head, or the head does not carry the field usably |
| `resolved` | The head's `resolved` (§5), whole: the run's interpretation after defaults and environment, so `HEAD~1..HEAD` reads as the two commits it was ([flyingrobots/parley#90](https://github.com/flyingrobots/parley/issues/90)). It is the tool's own shape and the reader picks none of its keys, so no tool's field names live here and nothing chosen from it can drift from the head. A value §5.3 redacted is `[redacted]` here too | The window does not hold the head, or its `resolved` is not a JSON object |
| `inv` | The head's `inv`, or else that of the window's `receipt.inputs` for the run (§2.2): what [a fold](#runs-of-one-invocation-are-named-once) groups repeated runs by | Neither carries one. Never a placeholder (§2.2) |
| `outcome` | `failed`, `undetermined` or `succeeded`: what the window establishes about the run, exactly as [the ranking](#what-a-runs-outcome-is-established-from) established it | No ranking outcomes were given to `digestFor` |
| `reason` | Why the outcome is `undetermined`: `no_end_in_window`, the window holds no `end` for the run, or `end_status_unusable`, it holds one whose `status` is not a number. Those are the only two ways the ranking reaches `undetermined`, and the schema refuses any other value | The outcome is not `undetermined`. The schema refuses a `reason` beside `failed` or `succeeded` and an `undetermined` without one |
| `head` | `not_in_window`: the window does not hold the run's head, so `tool`, `v` and `argv` are unknown here rather than missing | The window holds the head |
| `folded` | `{others, records, stands_for}`: this run stands for itself and `others` more runs of one invocation with one result, and the fold left `records` records of those others out. Both numbers exclude this run, so the run count a reader states from the sections is one per section plus its `others` (flyingrobots/parley#100); `stands_for` lists those other runs' ids, most recent first (flyingrobots/parley#133); a run that stands alone has no `folded`. See [runs of one invocation](#runs-of-one-invocation-are-named-once). Never dropped | The run stands only for itself |
| `dropped` | The fields left out to fit the section's bound, in the order they were dropped | Nothing was dropped |

A section is read off **the window's records**, the same ones the ranking was given, and from
nowhere else, so it cannot drift from the head it summarises (RD-80b), and a head the byte bound cut
from the entries still identifies its run. The `outcome` is the **window's** verdict, not the
digest's prefix's: a run whose `end` the bound cut still says `succeeded`. `no_end_in_window` says
only what the window holds: it cannot tell a run that ended after the window from one that never
ended, and it does not try.

**Each section is bounded.** When a section's serialised JSON is more than `RUN_SECTION_BYTES`,
512 UTF-8 bytes, whole fields are dropped — `resolved` first, then `argv`, `inv`, `v` and `tool` —
until it fits, and `dropped` names them. `resolved` goes first because it is the largest field and
the tool's own shape, while `argv` is the protocol's. A string or an object is never cut part-way,
because a cut argument reads as a different argument. `run`, `outcome`, `reason`, `head` and `folded` are never dropped, because without them
the section does not say which run it is or what became of it; a run id long enough to break the
bound on its own is left whole, and the line's `budget.bytes` still holds. A `resolved` that holds
an integer beyond the safe range is measured by the digits that are written and is dropped only
on those terms: for size ([numbers](#numbers)). The ids in
`folded.stands_for` are not counted against the section's bound: a section that stands for forty
runs carries over a kilobyte of them, and counting them would drop `resolved` and `argv` from
exactly the sections that stand for the most. They are part of the line, so `budget.bytes` does
bound them, at 29 bytes a run.

The entries and the sections cost bytes, and both are part of the line `budget.bytes` bounds.
Under `{records: 20, bytes: 2048}`, over runs of three records each, the digest names 12 records
where a bare `(run, seq)` lens named 20, an entry carrying its run's outcome named 16, and a section
without `resolved` named 13 (RD-22b). On footprint's own receipts every section still fits with its
`resolved`, the largest at 495 of the 512 bytes.
A run of more records costs its section once and so pays less per entry.

### Runs of one invocation are named once

A test suite runs its program many times in a burst with the same few argument vectors. In the
[cold resume](../reader/cold-resume.md) those bursts filled every digest of 20 with the same
runs, and a digest could not reach past the first burst. So before the bound is applied, a digest
**folds** the runs that are one invocation with one result into the most recent of them
([flyingrobots/parley#79](https://github.com/flyingrobots/parley/issues/79)):

```json illustrative
{"run":"01M86XC5NDPD38JFMHZNVEA30A","tool":"count","v":"0.1.0","argv":["count","files"],"resolved":{"command":"files","args":[]},"inv":"638c446f866624d00aed41b516d92549f87b0197871ae5db312b7edaa8051a16","outcome":"succeeded","folded":{"others":1,"records":4,"stands_for":["01M86XC5FZQZY4F1EW9HNJKD7M"]}}
```

That section is a fragment of the lens captured at 0.2.0 in the
[package README](../../../packages/parley-read/README.md#a-captured-digest): two runs of one
invocation with one result, named by the later, which reads as this run plus one other like it and
says which. A larger one, from footprint's own receipts and captured before a fold named its runs:

```json illustrative
{"run":"01M82S0D86ZC0QZWGHDV2A5HZJ","tool":"footprint","v":"0.2.0","argv":["footprint","HEAD~1..HEAD","--human"],"resolved":{"command":"footprint","base":"HEAD~1..HEAD","default_base":null,"range":"HEAD~1..HEAD","base_commit":"fb0950821fc982ba11e54906ed09eaf7613b165e","head_commit":"7e9959dcf34ba49292e797fdf4cf548e504f5478","graft":null},"inv":"70377768731b22e10242fac4cfac373e8edf08cfd2fc4ba3adc9a25ce2a5dca5","outcome":"succeeded","folded":{"others":9,"records":117}}
```

That section is a fragment of a `what-ran` lens over footprint's own receipts, captured in the
[cold resume](../reader/cold-resume.md#a-fold-counts-only-the-others): ten runs of one invocation,
named by the last of them, which reads as this run plus nine others like it.

| Rule | Because |
| --- | --- |
| Two runs fold when their `inv` is equal **and** their outcome, `reason`, `end` status, error, warning and startup-failure codes in the order emitted, and the head's `resolved` are all equal | `inv` is the run's identity (§2.2), not its result. "Same `inv`, different result" is a divergence (§2.3), exactly what a reader must see, so a flaky run that failed once and passed once is two sections, not one, under any window that holds the failure |
| **and** every result record is equal: the tool's own records, each `page`, each `sidecar`'s `bytes` and `sha256` and a read's own `lens`, in `seq` order, compared as canonical JSON (keys sorted) without the envelope's `t`, `seq` and `run`, and a read's own `lens` also without its `session` and the `query` it names, which are that read's identity. On any other compared record a top-level `session` is the record's own field and is compared: no protocol schema defines one on a tool's record, a `page` or a decision record, and a `sidecar` is compared by `bytes` and `sha256` alone (flyingrobots/parley#146). A record whose event token the protocol does not define counts as a result | Two runs that both succeeded and answered 1 and 2 are the divergence too. Until 0.2.0 no result entered the comparison, so `everything` returned one of the two answers and called it both (flyingrobots/parley#133) |
| **and**, when the view's surface holds them, every decision record is equal, compared the same way: `receipt.step` under `how-it-decided` and `everything`, `cache.hit` under those two and `what-ran` | A view states the records on its surface, so under it two runs that decided differently are not one run. Under the other views the decisions are not what was asked, and the runs still fold. This makes the fold depend on the view |
| Nothing folds when the read states `fold: false` | The caller asked for every run. The query records `fold`, the lens echoes it, and `loss.folded` is 0 |
| A run with no `inv` never folds | §2.2 omits `inv` when a program cannot make it safe, and a discovery run has none. Argument vectors are not identity |
| A run the window shows to be redacted does not fold: its head carries `redacted`, an `end` in the window says `redacted: true`, or the window holds a `redaction` of it. Nor does a run whose window holds neither its head nor an `end`, since nothing then shows it is unredacted | A redacted receipt shares its `inv` with every run that differed only in a secret (§2.3), and a missing statement is not a negative one (§1.2a) |
| **Every comparison above is of the records the window holds.** A run only partly inside the window is compared by that part, so two runs can fold under one window and not under a wider one that shows where they differ | The reader answers for a window and reads nothing outside it. A section marks a run the window did not hold whole in two cases: `head: "not_in_window"` when the window does not hold its head, and `outcome: "undetermined"` with `reason: "no_end_in_window"` when it holds no `end` for it and no failure either. A run the window shows to have failed is `failed` with or without its `end`, so its section does not say whether the window holds the `end`. Runs that fold agree on outcome, reason and the head's `resolved`, so a run whose head the window holds does not fold with one whose head it does not. To see such runs apart, read with `fold: false` or under a window that holds them whole (RD-112) |
| A run the loader held a line back from never folds (`line.number_unrepresentable`, [numbers](#numbers)) | The run has a record the reader could not return, so nothing establishes that it is the same as another. The loader marks every record of such a run (`LoadedRecord.runHeldBack`), and `foldRuns` and `digestFor` fold no run whose records carry the mark, whatever arguments they are called with. `heldBack` names such runs as well, for a run none of whose records were handed over; a `LoadedRecord` built by hand has no mark |
| Nothing folds when `digestFor` is given no outcomes | "The same result" cannot be established without them |
| The representative is the run whose latest dated record in the window is latest, ties to the greater run id | The most recent run is the one a resuming reader is likeliest to act on |

The representative's [section](#what-each-run-section-says) says `folded: {others, records,
stands_for}`, the two counts covering the other runs only (flyingrobots/parley#100) and
`stands_for` naming them. The other runs' records are not named, and every one of them is still counted in `loss.excluded`;
`loss.folded` says how many of those the fold left out, so `excluded − folded` is what the budget
cut. The fold depends on the window, its outcomes and the view, never on the budget, so the same
window under the same view folds the same way under any budget, and a digest that folded anything is `count-only`,
never `none`. `loss.folded` also counts a group whose representative the budget then cut, so the
sections' `folded.records` sum to at most `loss.folded`.

The fold is part of how the digest is built, not a view and not a ranking: the ranking still
orders every record of the window and drops none, the fold removes the folded-away runs' records
from what the digest may name, keeping the ranking's order, and the bound cuts the tail of what
is left. The answer's `records` and the ranking it carries hold what the digest names, and
`counts.folded` is the fold's share of `counts.excluded`.

**What the key does not hold.** An error's or a warning's text, only its code, so two runs that
failed with one code and different messages fold. The head's `argv`, which can differ between two
runs of one `inv`; the section states the representative's. A run's `command`, `schema` and
`receipt.inputs` records.

**Reaching what a fold left out.** `stands_for` lists the folded runs' ids, most recent first, as
many as `others`. [`openRecords`](#opening-records-by-identity) opens their records by
`(run, seq)`. The lens does not list their `seq`s; they are the representative's when the runs
emitted the same sequence of records, and an id a run does not hold comes back `seq_not_found`
rather than as a guess. The same read with `fold: false` names them under the budget like any
other run, and `loadReceipts` over the window holds them all.

On footprint's own 50 receipts, under the default budget of 20 records, the fold raised the
distinct invocations a digest names from 6 to 11 under `what-ran`, and from 2 to 4 under
`everything`; the measurement is in the [cold resume](../reader/cold-resume.md#folding-repeated-runs).

### The bound, exactly

| Budget field | What it bounds |
| --- | --- |
| `records` (required) | **The count.** The digest names at most this many records, and `records` in the answer holds exactly those |
| `bytes` (optional) | **The line.** The `parley.lens` line as written — serialised JSON plus its newline, measured in UTF-8 — is at most this many bytes. Records are dropped from the tail of the ranking until it fits |
| `ms` (optional) | **The whole read, as a deadline.** Measured from the call and checked between phases — after the load, after the ranking, and before the digest is written. A read past it at a check [declines](#when-a-read-declines) there ([flyingrobots/parley#71](https://github.com/flyingrobots/parley/issues/71)) |

A `bytes` budget too small even for a digest naming no records cannot be met at all: the envelope
and the lens's own fields are not negotiable, because a lens that dropped them would no longer say
what it is. Such a read declines and names the smallest `bytes` that would hold one. The bound is applied **before** the line is written — `digestLine` reconstructs the
line the writer will write, every entry's summary and every run section included, which a case pins against the line the writer really wrote — and it is
measured against a seq one digit longer than the one the digest will carry, one byte of headroom,
so that a `warning` the writer raises in between cannot push the line over a stated bound.

Two things the bound is **not**:

- It is not in the schema. `parley.lens` says a digest names "never more than `budget.records`"
  records, and JSON Schema cannot compare an array's length to a sibling value, so that is the
  library's invariant rather than a validator's — RD-21a and RD-22b are the gate on it.
- It is not a refusal. A read whose budget holds a digest still answers, bounded, and says what it
  left out, however little that digest names. Only a budget that cannot be met at all — a deadline
  passed, or a byte bound under an empty digest — ends in a [decline](#when-a-read-declines).

What the bound cuts is the **tail of the ranking**, never a record chosen some other way. The
order ranks every record in the window and removes none of it, so "the records the digest does not
name" is exactly "the records the fold left out and the records the ranking placed beyond the
bound", two numbers a count can state honestly, and `loss` states both.

### When a read declines

"Not within your budget" is an answer, not a failure to answer
([observer geometry](../related-work/observer-geometry.md)). A read declines when its deadline
passes at a check, or when its `budget.bytes` cannot hold even a digest naming no records
([flyingrobots/parley#71](https://github.com/flyingrobots/parley/issues/71)). A declined read:

- **is a recorded run.** Its `parley.query` was written before the load and stays in its receipt,
  so the next read sees what was asked. That is what separates a decline from a
  [refusal](#a-refused-read-is-not-a-run): a refusal is pure and happens before anything is read,
  about a question nobody could state; a decline is a verdict about real history, and only a read
  that ran can give one.
- **writes no `parley.lens`.** It never answers from a partial load: a digest drawn from part of
  the history would carry an excluded count of records the read saw, and say nothing of the ones
  it never reached. It never writes a line over a stated byte bound either.
- **reports one `parley.error`**, code `query.over_budget`, after a `receipt.step` saying why. The
  error's `measured` and `limit` are the bound that declined; its `detail` states the rest:

| `detail` field | Holds |
| --- | --- |
| `bound` | `ms` when the deadline passed, else `bytes`. When both fail at the last check, both are measured and `bound` is `ms` |
| `phase` | The check the read stopped at: `load`, `rank` or `digest` (`open` for a drill-down) |
| `given` | The budget the read was given, exactly as its `parley.query` recorded it |
| `measured` | The elapsed milliseconds, rounded up, and the size in bytes of the smallest digest, for each bound that could not be met |
| `sufficient` | A budget that would have been enough for this read over this history. For `bytes` it is exact: the smallest digest, naming no records, fits it and fits nothing one byte smaller. For `ms` it is the elapsed time, and only when the read stopped at its last check with nothing left but writing: this read would have passed every check under it. It is a measurement of one read, not a promise about the next, which takes its own time |
| `at_least` | A budget known to be needed and not known to be enough: the elapsed time when the read stopped with phases still to run, which would have cost more |

- **ends with status 2**, the status §3.4 gives a command that reported a structured error, and the
  library returns `{refused: false, declined: true, decline, …}` with the run, the receipt, the
  recorded query by `(run, seq)` and the load. It does not throw. The status is a choice the issue
  left open — a decline is not a failure of the read, but §3.4 has no status for a run that
  completed by declining, and a tool-owned status would be one more thing for every reader to
  learn — and the owner may overrule it.

The deadline is **inclusive**: elapsed time equal to `ms` is within it. It is measured on the read's
own clock, `opts.clock`, which defaults to `performance.now` so that an adjustment of the wall
clock mid-read moves no deadline, and which a caller can replace to test a deadline without
sleeping. It is read once when the read is called and once at each check, and nowhere else. A
read that states no `ms` has no deadline.

What a deadline cannot do is make the load cheaper. The load reads every receipt in both
locations whatever the window, so a decline at the `load` phase is answered by a larger `ms`, not
a narrower window; an index that would make a time bound cheap to honour is
[flyingrobots/parley#2](https://github.com/flyingrobots/parley/issues/2). And a check between
phases cannot interrupt one: a load that takes a second under a 50 ms deadline still takes the
second, and the read then declines rather than answers.

Two `query.over_budget` lines, captured from real reads against an empty history (re-captured after flyingrobots/parley#83 added `runs` to the lens line, which an empty digest carries as `[]`): the first under
`{"records": 20, "bytes": 256}`, the second under `{"records": 20, "ms": 1}` with a scripted clock
that put the end of the load 3 ms after the call.

```json
{"event":"error","t":1795397872014,"seq":6,"run":"01M830TTA8KG15SEFX58PEJ69S","code":"query.over_budget","problem":"budget.bytes of 256 cannot hold even a digest naming no records, whose line is 521 bytes","remedy":"state budget.bytes of 521 or more for a digest naming no records; each record it names adds its entry, and its run's section the first time that run is named","measured":521,"limit":256,"retryable":true,"detail":{"bound":"bytes","phase":"digest","given":{"records":20,"bytes":256},"measured":{"bytes":521},"sufficient":{"bytes":521},"at_least":{}},"_schema":{"id":"parley.error","version":"2.0.0"}}
```

```json
{"event":"error","t":1795397872047,"seq":5,"run":"01M830TTCFS93Y0479RRGEPEF7","code":"query.over_budget","problem":"the read passed its 1 ms deadline: 3 ms had elapsed by the end of the load","remedy":"state budget.ms above 3: the read stopped with work still to do, so it needs more than that; the load reads every receipt in both locations whatever the window, so a narrower window does not shorten it","measured":3,"limit":1,"retryable":true,"detail":{"bound":"ms","phase":"load","given":{"records":20,"ms":1},"measured":{"ms":3},"sufficient":{},"at_least":{"ms":3}},"_schema":{"id":"parley.error","version":"2.0.0"}}
```

### A digest never reads as complete

- `loss.excluded` is **always present**, zero included. An absent count and a count of zero are
  different claims, and §9 asks for the count precisely so a caller can widen deliberately.
  `loss.folded` is always present too, and a lens written before it existed has none, which is
  how a reader tells "folded nothing" from "did not fold". A read that stated `fold: false` says
  so in the lens, which is how a reader tells "nothing repeated" from "was told not to fold".
- `loss.bound` is `none` only beside an excluded count of 0, and the schema refuses the other
  pairing, so a digest that left something out says so **structurally** rather than in prose.
  `count-only` is the other value, and it says the count is all that is known: one withheld record
  can matter more than fifty, so a cardinality cannot bound what a view loses even in principle.
- The answer's `records`, and the ranking it carries, **stop at the bound**. What the budget cut
  is not returned by another route and is named nowhere, so a drill-down cannot open it: a caller
  reaches it by reading again under a wider budget, which the count tells them to do. What a fold
  left out is named by run in `folded.stands_for`, so a drill-down can open it, and a read with
  `fold: false` returns it under the budget.
- `counts.inWindow`, and the ranking's per-run outcomes and tier census, still describe the
  **whole window** the digest was drawn from. That is the asymmetry on purpose: a caller can see
  the digest is not the whole without being handed what it excluded, and a run's outcome stays
  established from the window rather than from a prefix of it (§1.2a).

## Opening records by identity

A digest names records and holds none of them: projecting down into a result is cheap, and
expanding a result back up may be impossible within a budget, so the way back is stored as
`(run, seq)` pairs rather than recomputed. `openRecords` is that way back
([flyingrobots/parley#51](https://github.com/flyingrobots/parley/issues/51)). It takes the pairs a
`parley.lens` names, in any order and any number, and answers with each record in full.

### It is a recorded read

Opening records reads history, so it is held to the same rules as a query
([flyingrobots/parley#48](https://github.com/flyingrobots/parley/issues/48)): it states an
`asker`, a `view` and a `window`, is refused without them under the query's own codes, and is
recorded through the writer as a run of its own. What it records is a **`parley.query` 1.1.0 event
with `records`** naming the ids asked, in the order asked — the same message a read records, so a
later reader sees which records were opened as well as which questions were asked — followed by a
`receipt.step` stating how many ids opened and how many did not.

| It states | Or else |
| --- | --- |
| `asker`, `view`, `window`, `note` | Refused exactly as a query is: `query.asker_unnamed`, `query.view_missing`, `query.window_missing` and the rest |
| `records` — at least one `{run, seq}`, `run` non-empty, `seq` a non-negative integer | Refused `open.records_missing` for none, `open.records_invalid` for one that is malformed |

A refused drill-down writes nothing, like a refused read. The **view and window select nothing**:
an id is opened by identity whatever its `t`, and the view is recorded as the purpose the records
were opened for. The recorded budget is `{"records": n}` for `n` ids asked, which is the bound the ids already
are, plus `bytes` when the caller states [a byte bound](#a-byte-bound) and `ms` when it states [a deadline](#a-deadline). A drill-down emits no `parley.lens`: it
answers with records, not a digest, and has no loss to state.

### One outcome per id

Every id asked gets exactly one outcome, in the order asked, and an id asked twice is answered
twice. Nothing about one id can lose the others, and nothing throws:

| Outcome | Means | Carries |
| --- | --- | --- |
| `opened` | The record is there | `record` in full; `sidecar` when the record was restored from one; `held`, the stored record in full, when the id names the `sidecar` event itself |
| `over_budget` | The record is there but opening it would pass the caller's `budget.bytes` | `bytes`, the size it would have occupied, `problem`, `remedy` and the bundle's ruling. **No record and no part of one** |
| `sidecar_unavailable` | The id is a `sidecar` event or the record one holds, and the stored bytes could not be established: `missing`, `digest_mismatch`, `bytes_mismatch`, `escapes_bundle`, `unparseable`, `number_unrepresentable`, `unreadable`, or `unchecked` when resolution was off | `record` is the pointer and only the pointer, `sidecar` with the declared and actual digests, `problem` and `remedy`. The contents are never claimed |
| `run_not_found` | No receipt in either location holds that run | `problem` and `remedy` |
| `seq_not_found` | The run is there and holds no record at that `seq`. When the run has a line at that `seq` the loader held back for a [number it cannot represent](#numbers), `problem` says so and `remedy` names the file and line | `problem`, `remedy` and the bundle's ruling |

### A byte bound

A drill-down may state `budget.bytes` (a positive integer; anything else is refused
`query.budget_invalid` and writes nothing). A record is **whole or absent**: there is no truncated
record, because a partial record read as whole is the §1.2a mistake. The rules:

- **Size** is the UTF-8 bytes of the record's JSON exactly as the drill-down returns it
  (`recordBytes`: `JSON.stringify` of the loaded record, envelope fields included). A record stored
  in a sidecar is sized by its contents, since the loader has restored them into it; opening the
  `sidecar` event itself returns the pointer and `held`, and both count, so the pointer is no way
  past the bound.
- **Order and remainder.** Each id is judged in the order asked against what remains: it opens if
  the running total plus its size is within the bound (the bound is inclusive), else it is
  `over_budget`. An over-budget id spends nothing, so a small record asked after it may still
  open. The answer keeps one outcome per id, in order, and nothing is skipped silently.
- **What costs nothing.** Only `opened` outcomes spend budget. `run_not_found`, `seq_not_found` and
  `sidecar_unavailable` return no contents (a broken sidecar returns the pointer, which is
  diagnosis, not contents) and keep their own outcome under any bound.
- **Recorded.** The `parley.query` carries `{"records": n, "bytes": b}`, the budget actually
  applied, the answer states it as `budget`, `counts.overBudget` counts the refused ids and the
  `receipt.step` carries `over_budget`. A caller who gets `over_budget` asks for that id again
  alone or under a larger bound.

The sidecar's stored bytes are checked by the loader against the `bytes` and `sha256` the receipt
declared before the record is restored (§5); the drill-down reports that resolution rather than
reading the file a second time.

**Every id whose run resolved carries its bundle's ruling** — `terminated`, `status`, `redacted`
and `replay` — exactly as [the loader](#replay-availability) established it. A record whose bundle
is unavailable for replay still opens: the `error` of a failed run is often the record a reader
most needs, and refusing to show it because the run cannot be replayed would confuse two different
questions. The ruling travels with it instead, so the reader cannot mistake a record from a run
that never terminated for one from a run that ended well.

### A deadline

A drill-down may state `budget.ms`, and it means what it means on a read: a deadline for the whole
drill-down, measured on `opts.clock` from the call and checked after the load and after the ids are
opened ([flyingrobots/parley#71](https://github.com/flyingrobots/parley/issues/71)). A drill-down
past it [declines](#when-a-read-declines) exactly as a read does — the recorded `parley.query`
carrying `ms`, one `query.over_budget` error, status 2, `{declined: true, decline, …}` — and
returns **no records**. It does not open the ids it reached in time and mark the rest late: which
ids opened would then depend on how busy the machine was, and that is not an outcome a caller can
act on. `budget.bytes` never makes a drill-down decline, because its answer is not a line with an
envelope that must fit: an id past the byte bound is that id's `over_budget` outcome instead.

A drill-down does not answer itself — its own bundle is not among those an id resolves to — and
the record of it is history like any other, which the next drill-down can open by its
`(run, seq)`.

## How the purpose orders the answer

Spec §9 says the purpose shapes the result: "I am about to change this program's audit path"
should return records touching that surface, not the last fifty things in chronological order. It
is the **ranking function**, not a filter applied afterwards, and that is exactly what this is —
`rankRecords` returns every record it was given, reordered. Over-filtering is the failure mode §9
names, and nothing here can drop a record even in principle. Bounding an answer and saying what it
left out happens one step later, above the full order: [the digest](#the-digest-and-what-it-left-out).

### The order, stated as a key

One total order on a key per record, compared left to right. Every part is decided by the records
in hand, so the same records under the same view come back in the same order every time:

| | Key | Smaller ranks first | Why |
| --- | --- | --- | --- |
| 1 | **tier** | `failure`, `surface`, `other` | A record on the failure surface is in the `failure` tier **only when the view implies a change and its run failed**; otherwise it is placed by the view's own surface like any other record. An `error`, a `startup.failed` and a non-zero `end` always make their run a failed one, so the condition on the run binds only a `warning` |
| 2 | **outcome** | `failed`, `undetermined`, `succeeded` | What the ranked records establish about the record's run, and **only when the view implies a change**. Otherwise every record carries the same outcome key and the tier falls straight through to time |
| 3 | **`t`**, then **`run`**, then **`seq`** | ascending | The order a read answered in before there was a ranking, so a view whose surface no record touches leaves the answer exactly as it was. A record with no usable `t` sorts last within its tier |

The order is total and deterministic: `(run, seq)` identifies an event (§1.3), so no two records
can tie on the whole key. `answer.ranking.ranked` carries each record's `rank`, `tier`, `outcome`
and a `why` — the parts of the key, in the order they were compared — so a caller is never left
inferring why a record is where it is.

### Each view's surface

The surface of a view is read off the vocabulary's own definition of its token
([the reader representation](../reader/README.md#the-view-vocabulary)). Nothing here consults a
field `parley.query` does not have:

| `view` | On its surface |
| --- | --- |
| `what-ran` | The records that identify a run and its outcome: the bootstrap `run` line, `receipt.head`, `cache.hit`, `end` and `startup.failed` |
| `what-failed` | The failure surface: `error`, `startup.failed`, `warning`, and an `end` whose `status` is a number other than zero (§3.3, §6, §6.1) |
| `what-changed` | A record of the tool's own rather than of the protocol — §7's results, the subject matter a command exists to produce — the `sidecar` standing in one's place (§5), `receipt.inputs`, and a `receipt.head` or `command` declaring a non-empty `effects.writes` (§4.3) |
| `how-it-decided` | `receipt.step`, the decision and its reason, and `cache.hit`, the decision not to run at all |
| `everything` | Every record. It is the identity view, so the tier orders nothing and the answer is the `(t, run, seq)` order |

A record of the tool's own is one whose `_schema.id` is outside `parley.` — or one that advertises
no pair at all and carries no protocol event token, since a reader that cannot attribute a line to
the protocol must not reinterpret it (§4.6).

### Which purposes imply a change, and how that is derived

`parley.query` carries **no field** saying "this purpose implies a change", and this library
adds none: inventing one would be an implementation extending a decided message. It does not need
one. Of the five tokens exactly one is an answer about a change — `what-changed`, "subject-matter
writes, and the inputs they consumed" — and it is the view §9's own example asks for. `what-ran`,
`how-it-decided` and `everything` describe history without proposing to change it. `what-failed` is
left out deliberately: failure is already that view's whole surface, so promoting it would restate
the surface rather than order the answer.

`CHANGE_VIEWS` is that derivation, written down. Adding a token to the vocabulary moves
`parley.query` and `parley.lens` (flyingrobots/parley#46) and has to decide the new token's surface
and whether it implies a change.

### What a run's outcome is established from

The outcome is a property of the run, read off **the records being ranked** rather than off the
whole history:

| Outcome | Established by |
| --- | --- |
| `failed` | An `error` or `startup.failed` record, or an `end` whose `status` is a number other than zero |
| `succeeded` | An `end` whose `status` is `0`, with nothing above against it |
| `undetermined` | Anything else, including a run whose `end` the window does not hold |

A window that cuts a run's `end` out leaves that run `undetermined`, not successful: §1.2a asks a
reader not to take one kind of evidence for another, and "no `end` in this window" is not "it
ended well". A `warning` is on the failure surface, because that is what `what-failed` is an answer
about, and it does not make its run a failed one — §6.1 makes it a warning precisely because the
run went on.

### Where a warning ranks under a change view

A view that implies a change promotes **the failure surface of the runs that failed**, not the
failure surface as a whole. A `warning` goes into the `failure` tier only when the records being
ranked establish that its run failed; a warning from a run that succeeded, or whose outcome is
`undetermined`, is placed by the view's own surface rule like any other record. `what-changed`'s
surface does not hold a `warning`, so there it falls to the `other` tier, below the view's own
results, and its `why` says it is a warning whose run is not established as failed.

That is what keeps a history of runs that warned and went on from crowding the view's surface out
of a digest ([flyingrobots/parley#76](https://github.com/flyingrobots/parley/issues/76)): 25 runs
that each warn and emit one result, read under `what-changed` with a budget of 20, name 20 results
and count the 25 warnings among the excluded. An `undetermined` run's warning is not promoted
either, because a missing `end` is not evidence that the run failed (§1.2a); within its tier it
still ranks above a succeeded run's. `what-failed` is unaffected: every warning is on its surface.

### What the ranking is not

- It is not a filter, a projection or a truncation. `rankRecords` returns every record it is
  given, whatever the view, and a case over all five views holds it to that. The truncation is the
  digest's, one step later and above the full order, which is the only place a cut can state its
  own loss honestly.
- It is not a relevance score. There is no weighting to tune and no number to compare between two
  reads; a record's position is a key made of a tier, an outcome and a timestamp.
- It does not read the `note`, the `asker` or the `budget`. Two askers reading the same window
  under the same view get the same order, which is what makes the view the thing a result can be
  compared on.
- It does not rank a digest. A result is built from records, never from another result, because
  each further summarising step adds its own loss
  ([observer geometry](../related-work/observer-geometry.md)).

## What it does not do

- Project. A read cuts its answer at the budget and says what it cut, but the records it does name
  it returns whole: no view reduces a record to fewer fields
  ([flyingrobots/parley#59](https://github.com/flyingrobots/parley/issues/59)).
- Hand back what the bound excluded. The digest states the count and names only the records it
  kept, so the [drill-down](#opening-records-by-identity) opens those and nothing else; the excluded
  tail is reached by a wider read.
- Interrupt a phase. `budget.ms` is checked between the load, the ranking and the digest, so a
  read past its deadline declines at the next check rather than abandoning a load part-way; it
  never answers from part of the history
  ([flyingrobots/parley#71](https://github.com/flyingrobots/parley/issues/71)).
- Recompute `inv` or any semantic digest (§7.1). It checks a sidecar's stored bytes against the
  digest the receipt declared, and nothing else.
- Judge conformance. The [doctor](../conformance/README.md) names violated rules; a defect here is
  what the loader could not read or could not validate.
- Read stdout or stderr. Those streams are not on disk; the loader reads receipt bundles.
- Serve a reader over the network, or hold an index. A read is a function call that loads the
  directory it was pointed at, once, per read; the store's indexing is
  [flyingrobots/parley#2](https://github.com/flyingrobots/parley/issues/2).
- Make a non-integral decimal exact. A non-integral number is a double; one a double does not
  give back, and an integer of more than 4096 digits, it cannot hold at all, and it says so and keeps
  the line's bytes rather than return the number rounded ([numbers](#numbers);
  [flyingrobots/parley#173](https://github.com/flyingrobots/parley/issues/173)).
- Decide every schema keyword for an integer beyond the safe range. What it decides and what
  stays `partial` is [listed](#validating-a-record-that-holds-one); complete positive validation
  is [flyingrobots/parley#172](https://github.com/flyingrobots/parley/issues/172).
- Versions up to 0.2.0 parsed every number into a double, so there an integer outside
  −(2^53)+1 to (2^53)−1 might not be returned exactly, and two results that differed only in such
  integers could compare equal and fold, which they did when both parsed to one double
  ([flyingrobots/parley#159](https://github.com/flyingrobots/parley/issues/159)).
- Write, create or repair anything.
- Windows paths. v0.2 of the spec is POSIX-only.

## Checks

```bash
bun test                 # root: the package suite runs with the repository's
bun run typecheck        # strict TypeScript over src, scripts and test
bun run check            # every JSON example, the package README included
```
