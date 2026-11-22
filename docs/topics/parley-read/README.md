# parley-read

The reader library: `@flyingrobots/parley-read`, under `packages/parley-read`. It opens the
receipt bundles a repository has accumulated and returns every run's records, under the rules the
[specification](../../../spec/parley-v0.2.md) binds a reader to, and it answers a read over those
records — refused unless it states who it is for and what it wants, and recorded as a run of its
own. This page is the reference for what the package does on `main`; the package
[README](../../../packages/parley-read/README.md) is the front door with a captured load and a
captured read, and the [test plan](test-plan.md) beside this page is the contract ledger.

It is a library with no command, and it is not published. The repository's `bun test` runs its
suite and `bun run typecheck` checks it strictly, over `src`, `scripts` and `test`.

## Surface

| Export | Job |
| --- | --- |
| `loadReceipts(opts)` | Every run in both receipt locations for a working directory, as bundles; `opts` takes `cwd`, `env`, `home`, `sidecars` and a `validate` validator |
| `queryReceipts(request, opts)` | A read: refused without an asker, a view and a window, else recorded as a `parley.query` event through the writer and answered with the window's records in time order; `opts` takes the loader's options plus `tool`, `stdout`, `stderr`, `session` and `now` |
| `planQuery(request)` | The refusal rules and the budget default, as a pure function: it reads nothing, writes nothing and records nothing |
| `queryRecord(query)` | The `parley.query` payload for an accepted read, without the envelope the writer owns |
| `VIEWS`, `DEFAULT_BUDGET`, `QUERY_SCHEMA`, `NO_RETENTION` | The five view tokens, the one documented budget default (`{"records": 20}`), the pair a read emits, and the retention policy a read states |
| `readReceiptFile(path, opts)` | One receipt file, as a `FileRead`: its line count, the runs it holds, its quarantined lines and one bundle per run |
| `receiptLocations(opts)`, `repoReceiptDir(cwd)`, `stateReceiptDir(opts)` | Where receipts are for a working directory, each location reported present or absent |
| `LineBuffer`, `splitLines`, `readFileLines`, `CHUNK_BYTES` | Newline buffering: bytes in, complete lines out, the unterminated tail kept apart |
| `validator(schemas?)`, `schemaRef`, `envelopeGaps`, `ENVELOPE`, `PROTOCOL_PREFIX` | Exact-pair validation, and the version-independent core a partial check uses |
| `SCHEMAS`, `SCHEMA_SOURCE` | The sixteen draft schemas the package ships, with the commit and digest of each |
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
ascending), its resolved `sidecars`, its `quarantined` lines, every `defect` found, how many extra
copies were folded in, whether it `terminated`, its `status`, whether it is `redacted`, and
`replay`.

A `LoadedRecord` carries the `run` and `seq` that identify the event, its `event` and `t`, the
`file` and `line` the first copy was read from, how many `copies` carried it, whether it came
`fromSidecar`, the `record` itself, and a `validation`.

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
carried the event, and `duplicates` counts the extras folded in.

Two consequences fall out of this. A file holding the lines of two runs — two runs interleaved on
one stream — comes back as two bundles, each with its own records. And a bundle copied into both
locations comes back as one bundle naming two sources, with its records not doubled.

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

The sixteen schemas are drafts: no release has snapshotted a version yet (§4.5), which is why the
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
| `budget` — `records` required, `bytes` and `ms` optional | Defaulted to `{"records": 20}`, visibly: the answer carries `budgetDefaulted`. A bound that is not a positive integer is refused `query.budget_invalid` |
| `note` — free text, optional | Refused `query.note_empty` for an empty string, which `parley.query` does not carry |

A refusal carries `code`, `problem` and `remedy` — §6's fields, so a caller that is itself a
parley tool can hand one to `run.error` — with the `field` it is about and the `section` it is
measured against. Every refusal that applies is returned, not just the first, so one round trip
tells a caller everything that is missing.

Two fields are inferred rather than refused, as the decision has it: `asker.cwd` is the directory
the read was made against when the caller does not state it, and the recorded query says so.
`asker.task` is "from the environment" in that decision without a variable named, so it comes from
the request and is omitted when absent — this library does not read a variable it would be
inventing (§2.1).

### A refused read is not a run

It writes nothing: no receipt, no `.parley` directory, nothing anywhere. §9 records a question
that *was asked*, and a question nobody could state has no asker to attribute it to. `planQuery`
is the same rules as a pure function, for a caller that wants to know whether a read would be
accepted before making it.

### An accepted read is recorded

The `parley.query` event goes through the writer
([`@flyingrobots/parley-emit`](../parley-emit/README.md)), so a read is a run like any other
parley program: a bootstrap line, a receipt under the working directory it read, two decisions
recorded as `receipt.step`, and an `end`. The receipt lands beside the ones being read, which is
what makes the loader find the question on the next read, and the answer names the record by
`(run, seq)` so a result can say which query it answers.

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

The answer is every record in the window, ascending by `t` with `(run, seq)` breaking a tie so two
records stamped the same millisecond come back in one stable order. A record whose `t` is not a
number cannot be placed in a window at all; it is not in the answer and `counts.undated` says how
many there were, rather than dropping it silently.

| Recorded | Applied |
| --- | --- |
| `asker` | Nothing branches on it: two askers asking the same thing get the same answer |
| `view` | **Nothing yet.** The answer is the window, unprojected. Shaping it to the view is [flyingrobots/parley#49](https://github.com/flyingrobots/parley/issues/49), and a test pins the two being the same today so it cannot drift silently |
| `budget` | **Nothing yet.** Nothing is truncated and no excluded count is claimed, because a count of what was left out belongs to the digest that left it out ([flyingrobots/parley#50](https://github.com/flyingrobots/parley/issues/50)) |
| `window` | Yes, and echoed verbatim in the answer |
| `note` | Never parsed |

No `parley.lens` line is emitted. A lens states a loss bound and the records a result was built
from; a read that returns the records has no loss to state, and the lens is the digest's (#50).

## What it does not do

- Rank, project or truncate. A read returns its window in time order; the view and the budget are
  recorded and applied to nothing (flyingrobots/parley#49, flyingrobots/parley#50).
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
