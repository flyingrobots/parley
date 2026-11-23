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
| `digestFor(query, answers, ranked, envelope, outcomes?)` | The bound, as a pure function from an accepted query and a ranking to the digest's `parley.lens` payload, the records it names, the count it excluded and the bytes its line will take and whether it `fits` a stated byte bound at all; `outcomes` is the ranking's per-run verdict, which each entry carries |
| `sufficientBytes(query, answers, total, envelope)` | The smallest `budget.bytes` that holds a digest naming no records over a ranking of `total`, which is what a byte decline names |
| `Deadline`, `MONOTONIC`, `OVER_BUDGET`, `declineOnRun` | The deadline `budget.ms` is checked against, the default clock it is measured on, the one code a read declines with, and the step and error a decline reports on its run |
| `lensEntry(record, outcomes?)` | The entry a digest names one record by: its `(run, seq)` and its summary |
| `digestLine(digest, envelope)`, `digestBytes(digest, envelope)` | The line the writer will write for a digest, and its length in UTF-8 bytes: how a byte budget is applied before the line exists rather than discovered after it |
| `runOutcomes(records)`, `onViewSurface(view, record)`, `onFailureSurface(record)`, `impliesChange(view)` | The four questions the ranking asks, each answerable on its own |
| `TIERS`, `OUTCOMES`, `CHANGE_VIEWS` | The three tiers best first, the three outcomes best-known-worst first, and the views that imply a change |
| `VIEWS`, `DEFAULT_BUDGET`, `QUERY_SCHEMA`, `LENS_SCHEMA`, `NO_RETENTION` | The five view tokens, the one documented budget default (`{"records": 20}`), the two pairs a read emits, and the retention policy a read states |
| `readReceiptFile(path, opts)` | One receipt file, as a `FileRead`: its line count, the runs it holds, its quarantined lines and one bundle per run |
| `readHistorySegment(path, opts)` | One segment of the shared history stream (§8), the same way: a file of whole runs from every tool that wrote to it, one bundle per run |
| `receiptLocations(opts)`, `repoReceiptDir(cwd)`, `stateReceiptDir(opts)` | Where receipts are for a working directory, each location reported present or absent |
| `LineBuffer`, `splitLines`, `readFileLines`, `CHUNK_BYTES` | Newline buffering: bytes in, complete lines out, the unterminated tail kept apart |
| `validator(schemas?)`, `schemaRef`, `envelopeGaps`, `ENVELOPE`, `PROTOCOL_PREFIX` | Exact-pair validation, and the version-independent core a partial check uses |
| `SCHEMAS`, `SCHEMA_SOURCE` | The seventeen draft schemas the package ships, with the commit and digest of each |
| `QUARANTINE_CODES` | Which defect codes are a kept line rather than a judgement about a record |
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
| `partial` | The `_schema.id` is `parley.*` but this reader ships no schema for that version. The §1.3 envelope was checked and the contract was not, and the §1.3 gaps are listed |
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

## Quarantine

Four codes are a kept line rather than a judgement about a record, and `QUARANTINE_CODES` names
them. Each carries the bytes verbatim in `raw`, the file and 1-based line, and the run it is
attributed to:

| Code | Line | Section |
| --- | --- | --- |
| `line.quarantined` | Not JSON, or JSON that is not an object | §1.4 |
| `line.blank` | Empty or whitespace, which is not a JSON object either | §1.4 |
| `line.no_envelope` | A JSON object with no usable `run` and `seq`, so it cannot be placed in a run or deduplicated | §1.3 |
| `line.unterminated` | The final fragment, with no newline | §5.4 |

§1.4 asks that a quarantined line be attributed to the run. A receipt file is one run's by name
(§5: `<run>.jsonl`), so that is the attribution; a file holding more than one run, with a name
that names neither, leaves its quarantined lines unattributed rather than guessed at.

A quarantined line is never evidence of anything beyond the fact that the writer, or something
sharing its descriptors, wrote it. It is not a record, it does not count toward validation, and it
cannot close a run.

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
`bun run sync-schemas` from the repository drafts and pinned by commit and per-file digest. A test
fails when that copy goes stale. Nothing is fetched, and no other version's schema is ever run
over a line and called validation.

The seventeen schemas are drafts: no release has snapshotted a version yet (§4.5), which is why the
package records the commit it copied them at.

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
  the history in order to answer a question about it.
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

It is a **`parley.lens` 1.0.0 record**, the message decided in
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
| `loss` | `bound` and `excluded`: what kind of statement the loss is, and how many records the bound left out |
| `records` | The records the digest names, in rank order, by `(run, seq)` — the way back a [drill-down](#opening-records-by-identity) takes — each with a [summary](#what-each-entry-says) of the record it names |

### What each entry says

A name alone makes a reader open a record to learn what it is, so each entry also carries a fixed
summary of the record it names
([flyingrobots/parley#77](https://github.com/flyingrobots/parley/issues/77)):

```json illustrative
{"run":"01JD3KQ8Z6V9X2M4N7P1R3T5W8","seq":4,"event":"error","t":1795326412352,"outcome":"failed"}
```

That entry is a fragment of a lens, not a message of its own; the [package README](../../../packages/parley-read/README.md#a-captured-digest)
holds a captured one.

| Field | Is | Absent when |
| --- | --- | --- |
| `run`, `seq` | The record's identity: the way back to it | Never |
| `event` | The record's event token as the loader read it, a tool's own token such as `result` included verbatim | The record carries no event token |
| `t` | The record's POSIX milliseconds as the loader read them | The record has no non-negative integer `t`. A made-up one would sort and read as real |
| `outcome` | `failed`, `undetermined` or `succeeded`: what the window establishes about the record's run, exactly as [the ranking](#what-a-runs-outcome-is-established-from) established it | No ranking outcomes were given to `digestFor` |

The summary is read off the loaded record and the ranking when the digest is built, and from
nowhere else, so it cannot drift from the record it names: RD-50b checks every entry of every view
against the loader read again afterwards. The `outcome` is the **window's** verdict, not the
digest's prefix's: a run whose `end` the bound cut still says `succeeded`, and a run whose `end`
is outside the window says `undetermined` rather than a guess.

The summary costs bytes, about 65 an entry, and it is part of the line `budget.bytes` bounds. A
byte budget therefore names fewer records than it did when an entry was only `(run, seq)`: under
`{records: 20, bytes: 2048}` the digest names 16 records where it named 20 (RD-22b).

### The bound, exactly

| Budget field | What it bounds |
| --- | --- |
| `records` (required) | **The count.** The digest names at most this many records, and `records` in the answer holds exactly those |
| `bytes` (optional) | **The line.** The `parley.lens` line as written — serialised JSON plus its newline, measured in UTF-8 — is at most this many bytes. Records are dropped from the tail of the ranking until it fits |
| `ms` (optional) | **The whole read, as a deadline.** Measured from the call and checked between phases — after the load, after the ranking, and before the digest is written. A read past it at a check [declines](#when-a-read-declines) there ([flyingrobots/parley#71](https://github.com/flyingrobots/parley/issues/71)) |

A `bytes` budget too small even for a digest naming no records cannot be met at all: the envelope
and the lens's own fields are not negotiable, because a lens that dropped them would no longer say
what it is. Such a read declines and names the smallest `bytes` that would hold one. The bound is applied **before** the line is written — `digestLine` reconstructs the
line the writer will write, every entry's summary included, which a case pins against the line the writer really wrote — and it is
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
name" is exactly "the records the ranking placed beyond the bound", which is a number a count can
state honestly.

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
| `sufficient` | A budget known to be enough for this read over this history. For `bytes` it is exact: the smallest digest, naming no records, fits it and fits nothing one byte smaller. For `ms` it is the elapsed time only when the read stopped at its last check, with nothing left but writing |
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

Two `query.over_budget` lines, captured from real reads against an empty history: the first under
`{"records": 20, "bytes": 256}`, the second under `{"records": 20, "ms": 1}` with a scripted clock
that put the end of the load 3 ms after the call.

```json
{"event":"error","t":1795397251191,"seq":6,"run":"01M8307W1D7XB0AJR851ZGP0JW","code":"query.over_budget","problem":"budget.bytes of 256 cannot hold even a digest naming no records, whose line is 510 bytes","remedy":"state budget.bytes of 510 or more for a digest naming no records; each record it names adds its entry on top","measured":510,"limit":256,"retryable":true,"detail":{"bound":"bytes","phase":"digest","given":{"records":20,"bytes":256},"measured":{"bytes":510},"sufficient":{"bytes":510},"at_least":{}},"_schema":{"id":"parley.error","version":"2.0.0"}}
```

```json
{"event":"error","t":1795397251229,"seq":5,"run":"01M8307W3R1D7YXFGDPJK3C73P","code":"query.over_budget","problem":"the read passed its 1 ms deadline: 3 ms had elapsed by the end of the load","remedy":"state budget.ms above 3: the read stopped with work still to do, so it needs more than that; the load reads every receipt in both locations whatever the window, so a narrower window does not shorten it","measured":3,"limit":1,"retryable":true,"detail":{"bound":"ms","phase":"load","given":{"records":20,"ms":1},"measured":{"ms":3},"sufficient":{},"at_least":{"ms":3}},"_schema":{"id":"parley.error","version":"2.0.0"}}
```

### A digest never reads as complete

- `loss.excluded` is **always present**, zero included. An absent count and a count of zero are
  different claims, and §9 asks for the count precisely so a caller can widen deliberately.
- `loss.bound` is `none` only beside an excluded count of 0, and the schema refuses the other
  pairing, so a digest that left something out says so **structurally** rather than in prose.
  `count-only` is the other value, and it says the count is all that is known: one withheld record
  can matter more than fifty, so a cardinality cannot bound what a view loses even in principle.
- The answer's `records`, and the ranking it carries, **stop at the bound**. What was excluded is
  not returned by another route and is named nowhere, so a drill-down cannot open it either: a
  caller reaches it by reading again under a wider budget, which the count tells them to do.
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
recorded through the writer as a run of its own. What it records is a **`parley.query` 1.0.0 event
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
| `sidecar_unavailable` | The id is a `sidecar` event or the record one holds, and the stored bytes could not be established: `missing`, `digest_mismatch`, `bytes_mismatch`, `escapes_bundle`, `unparseable`, `unreadable`, or `unchecked` when resolution was off | `record` is the pointer and only the pointer, `sidecar` with the declared and actual digests, `problem` and `remedy`. The contents are never claimed |
| `run_not_found` | No receipt in either location holds that run | `problem` and `remedy` |
| `seq_not_found` | The run is there and holds no record at that `seq` | `problem`, `remedy` and the bundle's ruling |

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

`parley.query` 1.0.0 carries **no field** saying "this purpose implies a change", and this library
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
- Write, create or repair anything.
- Windows paths. v0.2 of the spec is POSIX-only.

## Checks

```bash
bun test                 # root: the package suite runs with the repository's
bun run typecheck        # strict TypeScript over src, scripts and test
bun run check            # every JSON example, the package README included
```
