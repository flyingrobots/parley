# parley-read

The reader library: `@flyingrobots/parley-read`, under `packages/parley-read`. It opens the
receipt bundles a repository has accumulated and returns every run's records, under the rules the
[specification](../../../spec/parley-v0.2.md) binds a reader to. This page is the reference for
what the package does on `main`; the package
[README](../../../packages/parley-read/README.md) is the front door with a captured load, and the
[test plan](test-plan.md) beside this page is the contract ledger.

It is a library with no command, and it is not published. The repository's `bun test` runs its
suite and `bun run typecheck` checks it strictly, over `src`, `scripts` and `test`.

## Surface

| Export | Job |
| --- | --- |
| `loadReceipts(opts)` | Every run in both receipt locations for a working directory, as bundles; `opts` takes `cwd`, `env`, `home`, `sidecars` and a `validate` validator |
| `readReceiptFile(path, opts)` | One receipt file, as a `FileRead`: its line count, the runs it holds, its quarantined lines and one bundle per run |
| `receiptLocations(opts)`, `repoReceiptDir(cwd)`, `stateReceiptDir(opts)` | Where receipts are for a working directory, each location reported present or absent |
| `LineBuffer`, `splitLines`, `readFileLines`, `CHUNK_BYTES` | Newline buffering: bytes in, complete lines out, the unterminated tail kept apart |
| `validator(schemas?)`, `schemaRef`, `envelopeGaps`, `ENVELOPE`, `PROTOCOL_PREFIX` | Exact-pair validation, and the version-independent core a partial check uses |
| `SCHEMAS`, `SCHEMA_SOURCE` | The fourteen draft schemas the package ships, with the commit and digest of each |
| `QUARANTINE_CODES` | Which defect codes are a kept line rather than a judgement about a record |
| `isDirectory`, `isFile` | The two existence questions the loader asks, exported because callers ask them too |

## What a load returns

A `Load` carries the locations it looked in, a `FileSummary` per receipt file it read, a `Bundle`
per run, every quarantined line, and counts.

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

A sidecar whose path would leave the bundle is refused before anything is read, because §5 says
the bundle moves as one and a path out of it is not part of the bundle at all.

## Replay availability

`replay.unavailable` is `true` when something about the bundle rules replay out, with a reason per
rule:

| Reason | Rule |
| --- | --- |
| `sidecar.missing`, `sidecar.digest_mismatch`, `sidecar.bytes_mismatch`, `sidecar.escapes_bundle`, `sidecar.unparseable`, `sidecar.unreadable` | §5: a reader that finds a sidecar missing or its digest mismatched must treat the bundle as unavailable for replay |
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

The fourteen schemas are drafts: no release has snapshotted a version yet (§4.5), which is why the
package records the commit it copied them at.

## What it does not do

- Query or rank. It returns what the receipts say; choosing among runs is the caller's.
- Recompute `inv` or any semantic digest (§7.1). It checks a sidecar's stored bytes against the
  digest the receipt declared, and nothing else.
- Judge conformance. The [doctor](../conformance/README.md) names violated rules; a defect here is
  what the loader could not read or could not validate.
- Read stdout or stderr. Those streams are not on disk; the loader reads receipt bundles.
- Write, create or repair anything.
- Windows paths. v0.2 of the spec is POSIX-only.

## Checks

```bash
bun test                 # root: the package suite runs with the repository's
bun run typecheck        # strict TypeScript over src, scripts and test
bun run check            # every JSON example, the package README included
```
