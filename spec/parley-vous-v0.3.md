# Parley-vous v0.3 — specification

**Status:** implemented under the protocol's former name (see [History](#history)). Two
conforming writers ([`@flyingrobots/parley-emit`](../packages/parley-emit/README.md) in TypeScript
and [`parley_emit.py`](../packages/parley-emit-py/README.md) in Python) and one reader
([`@flyingrobots/parley-read`](../packages/parley-read/README.md)) implement spec `0.2.1` and are
tested against it. They are being renamed to the npm package `parley-vous` and the PyPI package
`parley-vous`, which will implement this version. §8 and §9 remain informative. Each release of the
schemas is a dated heading in `CHANGELOG.md` that names the schema versions it publishes.
**Spec version:** `0.3.0`, versioned independently of any implementation.
**Normative terms:** **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT** and **MAY** are to be
interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and
[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) when, and only when, they appear in bold.

A protocol for programs whose primary caller is an agent. It defines how a program speaks on its
output streams, how it describes itself, and what it leaves behind. Sections 1 to 7 are the
normative core; §8 and §9 describe a history layer that consumes this format, parts of which are
now built, and remain informative.

## History

v0.3 renames the protocol from Parley (spec v0.2, last at `0.2.1`) to Parley-vous, the one-time
reinvention recorded in
[release review](../docs/workflows/release-review/README.md#the-one-time-reinvention-as-parley-vous).
Nothing else changes in meaning. The reserved message-id prefix `parley.` becomes `parley-vous.`,
the schema `$id` base `https://flyingrobots.dev/parley/schemas/<id>/<version>` becomes
`https://flyingrobots.dev/parley-vous/schemas/<id>/<version>`, the runtime paths `.parley/` and
`$XDG_STATE_HOME/parley/` become `.parley-vous/` and `$XDG_STATE_HOME/parley-vous/`, and every
message type restarts at version `1.0.0`. A schema released under a `parley.*` id is not a version
of any `parley-vous.*` message, and a reader built against one is outside this version's promise.

## Lineage

Parley-vous is not a new idea. It is the same idea as `echo`, `graft`, `jedit` and the witness work:
that a system should record what happened as it happens, carry its provenance, and let that
record be read as history rather than reconstructed from guesswork. Those apply it to code,
structure, editing and proof. Parley-vous applies it to the narrowest surface there is — what a
program prints.

That narrowness is the point. A tool conforms to Parley-vous by changing what it writes: JSON Lines
on stdout and stderr, a receipt on disk, and the hygiene and retention around it. It needs no
substrate, no daemon, no causal graph. If the same tool later writes into a richer history,
nothing it emits has to change, because every line is already identified, ordered within its
run, provenanced, and attributable to the run that produced it.

It is a doorway, deliberately sized so someone can walk through it without agreeing to anything
larger.


---

## 1. The contract

**Output is a contract, not a rendering.** A line that does not validate against a declared
schema, or any plain text on any stream, is a **bug** — not a cosmetic one.

### 1.1 JSON Lines by default

- A conforming program **MUST** emit JSON Lines by default: one JSON object per line.
- Prose is opt-in via `--human` (alias `--humanize`). Nothing else changes the format.
- A program **MUST NOT** detect a TTY and change its output contract. Output that depends on how
  it was invoked is the one thing an agent cannot plan around, because an agent's call is never a
  TTY and it will silently receive a contract nobody tested.
- The default format **MUST NOT** contain colour, spinners, progress bars, emoji or box drawing.

### 1.2 Stream roles

| Stream | Carries |
| --- | --- |
| **stdout** | The result. The smallest payload that answers the question, plus the bootstrap line that opens the run and the `end` event that closes it (§3). |
| **stderr** | Errors and warnings (§6), both structured. Nothing else. |
| **receipt file** | The record: argv, resolved interpretation, input digests, per-step reasoning, progress, and copies of every result, error and warning (§5). |

**stdout carries what you need to act; the receipt carries what you need to check.** A reader
should not have to pay context to re-read the program's own reasoning in order to use its answer,
and should always be able to go find that reasoning later.

### 1.2a What a record establishes

A receipt is written by the program it describes. It is a record, not a proof. Each kind of
evidence in this protocol establishes a different thing, and a reader **MUST NOT** take one for
another:

| Evidence | Establishes |
| --- | --- |
| A line validates against its schema | The line has the declared shape |
| A content digest (§2.2, §5) | The identity of the bytes that were digested, under the stated hash |
| A receipt | What the producer reports it did |
| An independent check of a receipt against its inputs | Whatever that check's stated procedure covers, and no more |

The same boundary holds for the agent-facing fields. A `remedy` (§6) is advice. An `effects`
declaration (§4.3) is a claim the program makes about itself. `observer` and `purpose` (§9) are
query context. None of them grants permission, and none of them is enforced by this protocol.

A program **MUST NOT** allow a third-party library to write unstructured text to either stream.
Capture or silence it.

### 1.3 Every line

Every emitted line **MUST** carry:

| Field | Meaning |
| --- | --- |
| `event` | Discriminator naming the line's kind |
| `t` | POSIX time in **integer milliseconds**, never negative. No timezone, sortable as an integer |
| `seq` | Position in the run's single sequence, from `0`. See below |
| `run` | The execution this line belongs to (§2.1) |
| `_schema` | `{ "id": …, "version": … }` identifying the schema this line validates against |

Every line **MUST** stand alone. A consumer should not need to keep state from earlier lines to
interpret a later one. That is why `run` is on every line and not only on the first: a pipe can
supply the context for a moment, but a line read out of a shared stream tomorrow cannot recover
which run it belonged to, and two runs interleaved on one terminal cannot be told apart.

**One sequence per run, across every stream.** A run holds a single counter. Every line it
emits, on stdout, stderr or into the receipt, takes the next value. `seq` exists because wall
clocks move backwards under clock adjustment. Ordering within a run **MUST** use `seq`; ordering
across runs **MAY** use `t`.

A line written to more than one stream, for example an error that goes to stderr and is also
recorded in the receipt, is one event and **MUST** carry the same `seq`, the same `t` and the same
`event` in every copy. A copy **MAY** carry fields another copy omits, for example a fuller
`detail` in the receipt, but copies **MUST** agree on every field they share. The pair
`(run, seq)` therefore identifies an event uniquely, and a consumer merging streams **MUST** treat
two lines with the same pair as one event. Remembering which pairs it has seen is deduplication,
not interpretation, and does not conflict with the stand-alone rule above. Because the bootstrap
line (§3.1) is the first line a run emits on any stream, it is always `seq: 0`; every other line
is `seq >= 1`, and nothing else is pinned. The one exception is a run that fails before it can
bootstrap (§3.2), whose single diagnostic line is `seq: 0` instead.

### 1.4 Reading the streams

The rules above bind the writer. These bind a reader, because the cases §6 names as
unconstrainable, a native crash or a library writing to a file descriptor behind the program's
back, will happen, and a reader that aborts on the first stray byte is broken by exactly the case
the spec admits.

- A reader **MUST** buffer until a newline before parsing. A read chunk or a flush is not a line
  boundary; valid JSON that arrived across two reads is not garbage.
- A complete line on **stderr** that is not a JSON object **MUST** be quarantined: kept, reported
  as a defect attributed to the run, and never treated as a result or an error of the protocol.
- A complete line on **stdout** that is not a JSON object is a contract failure of the writer
  (§1), and the reader **MUST** report it as such.
- An unterminated fragment at EOF on any stream is quarantined and reported; it is not a line
  (§5.4).
- A reader **MUST NOT** treat a quarantined line as evidence of anything beyond the fact that the
  writer, or something sharing its descriptors, wrote it.

---

## 2. Identity

### 2.1 Three identifiers, and why

| Id | Scope | Derivation |
| --- | --- | --- |
| `run` | One execution | Unique per execution, lexicographically sortable (ULID or equivalent) |
| `inv` | One *question* | **Content-addressed**: a digest over the tool, its version, the normalised arguments, and the **bytes of every declared input**. Tool-defined in v0.3 (§2.2) |
| `session` | A working period spanning runs | Supplied by the caller or inherited from the environment |

Two runs of the same question are still two events whose receipts must not collide, so `run` is
required. Knowing they *were* the same question is what buys replay and change detection, so a
program **SHOULD** supply `inv`. v0.3 does not fix its derivation; a program that supplies it
**MUST** document how (§2.2). Collapsing the two identifiers loses one or the other.

`session` is optional. A program **MUST** carry it when the caller supplies one and **MUST NOT**
invent one. `run`, `inv`, `session`, `tool` and `v` are never empty strings; an identity with no
content identifies nothing.

### 2.2 Computing `inv`

In v0.3 `inv` is **SHOULD** and its derivation is tool-defined. A shared derivation is the goal
for a later version, written from a real implementation and conformance vectors rather than
ahead of them; SHA-256 over canonical JSON, full-length encoding and role-preserving inputs are
the candidates to test, not rules. Until then, a program that supplies `inv` **MUST** document its derivation
and its scope, and **MUST** obey the constraints below, which are what make any derivation
worth having.

`inv` **MUST** be derived from:

- tool name and version;
- the normalised argument vector, with flag order and defaults resolved;
- a digest of the **content** of every declared input, not its path.

`inv` **MUST NOT** incorporate wall-clock time, process id, working directory, temporary paths,
session id, the storage key of §5, or any value that varies between otherwise identical
invocations.

`inv` **MUST NOT** incorporate the value of any declared secret (§5.3). It **MAY** incorporate the
fact that the secret was supplied, by name. A receipt carries `inv` beside every other component of
its preimage, so a secret inside the preimage would be recoverable from the receipt by anyone who
can guess it; a four-digit PIN falls in milliseconds. Excluding it means two invocations that
differ only in a secret share one `inv`, which is why §2.3 and §5.3 forbid replaying from a
redacted receipt.

The exclusion is transitive. A file whose content is a credential is a **secret source, not an
input**: it **MUST** be declared in `secrets` (§4.3) and **MUST NOT** be a declared input, and its
contents **MUST NOT** contribute to any input digest or to `inv`, directly or through a directory
digest, an archive, a manifest or a derived value. Removing `--token-file` from the inputs while
digesting its parent directory leaves the same hole. The receipt records the fact of supply by
logical name only. If a program cannot establish that exclusion, it **MUST** omit `inv` rather
than claim an identity it cannot make safe.

When `inv` is unavailable, a program omits the field. It **MUST NOT** emit a placeholder.

**Timing.** The bootstrap line (§3.1) **MUST NOT** wait on a directory scan or on stdin reaching
EOF; it carries `inv` only when the identity is already known. The receipt head (§5) is written
promptly with the declared inputs as descriptors (path, and a digest for each input already read)
and whatever else is known. Digests that arrive later, and `inv` once it can be computed, are
carried by one receipt metadata-finalisation record, `receipt.inputs`, emitted when the inputs
are settled and before `end`:

```json
{"event":"receipt.inputs","t":1795326412385,"seq":5,"run":"01JD3KQ8Z6V9X2M4N7P1R3T5W8",
 "inputs":[{"path":"src/tokens.css","sha256":"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"},
           {"path":"-","role":"stdin","sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},
           {"path":"vendor/","role":"tree","error":"input.unreadable"}],
 "_schema":{"id":"parley-vous.receipt.inputs","version":"1.0.0"}}
```

An input the program could not read is recorded with an `error` code and no digest; a run that
then fails still closes a complete failed receipt (§3.3) without that digest and without `inv`.
That is the run shown across this specification's examples: stdin was an input, so `inv` was not
known at the bootstrap line or the head, and `vendor/` was unreadable, so the run never had one.

> **The trap.** Hashing input *paths* rather than input *bytes* makes `inv` stable across an edit
> to the file. "Idempotent" then silently means "stale", and any cache built on it serves wrong
> answers. The identity is over the question *and its subject matter*.

### 2.3 What `inv` buys

Each of these holds only where no declared secret is involved on either side: the receipt's
`end.redacted` is `false` (§3.3, §5.3) and the invocation comparing against it supplied none. A
redacted receipt shares its `inv` with every run that differed only in a secret, so none of them
applies to it.

- **Change detection.** Same `inv`, same result ⇒ nothing moved within the declared input
  boundary.
- **Divergence detection.** Same `inv`, *different* result ⇒ the result diverged under the
  recorded input boundary. Hidden context, intentionally live data and a defect in the program
  are all consistent with that; the digest alone does not pick the cause, it only makes the
  divergence visible.
- **Replay.** A prior receipt for the same `inv` **MAY** answer without recomputing, subject to
  the eligibility rules below.

A program **MAY** short-circuit on a known `inv`. If it does, it **MUST** emit the hit as an
event rather than silently serving a cached answer, and **MUST** offer a way to force recompute.
The event names the receipt it answered from and that receipt's run, which must itself have been
eligible: a successful, unredacted run, not the failed one the rest of this specification's
examples show:

```json
{"event":"cache.hit","t":1795326412350,"seq":2,"run":"01JD3KS9T4U8V1W5X2Y7Z3A6B9",
 "inv":"inv_7f3a9c1e","served_run":"01JD3KP5W2X8Y4Z1A7B3C9D6E2",
 "receipt":"/work/site/.parley-vous/receipts/01JD3KP5W2X8Y4Z1A7B3C9D6E2.jsonl",
 "_schema":{"id":"parley-vous.cache.hit","version":"1.0.0"}}
```
Short-circuiting **SHOULD NOT** be the default, because inputs can be identical while the world is
not — a declared input set never captures everything. A matching `inv` on its own never
authorises skipping an effect or reusing an answer; it is one input to that decision.

Eligibility is checked on **both** sides. A program **MUST NOT** short-circuit when a declared
secret was supplied to the current invocation, or when the cached receipt carries `redacted` (§5.3).
Either run may have depended on which secret was used, and `inv` cannot tell, because §2.2 keeps
secrets out of it. Whether a declared secret was supplied is known from `argv` and the environment,
and from resolving every declared credential source, before the head is written (§5.3), so both
sides are decidable at the moment of choice. The rule reaches declared secrets, which include a
credential source declared by logical name (§4.3): a `.netrc` entry, a keychain item or a helper's
token counts as supplied when the program has a credential from it, and the head records that in
`redacted.sources`. A credential the program obtains from a source it did not declare is outside the
rule and invisible to a reader; a program that uses such credentials **MUST** declare the source or
**MUST NOT** short-circuit at all. The same two-sided rule binds a reader that serves cached answers
(§5.3): it decides the current side from that invocation's own receipt head, whose `redacted` is
mandatory when a declared secret was supplied, or, when the declaration names no credential source,
from its declaration together with its `argv` and environment, and **MUST NOT** serve when it
holds neither.

---

## 3. The run: bootstrap, startup failure, end

A run opens with one line and closes with one line. Between them, every stream carries the
events of §1.3. Four facts about a run are separate and each has its own evidence: that it
**completed** (an `end` event exists, §3.3), that it **succeeded** (`end.status` is `0`), that its
output **validates** (§4.5), and that it is **eligible for replay** (§2.3, §5.3). None implies
another.

### 3.1 The bootstrap line

The **first** line the run emits on any stream, and so the first line of stdout, emitted
**before work begins**. It is written to stdout only; it is not mirrored into the receipt, whose
first line is the receipt head (§5).

Before announcing the receipt path, a program **MUST** create the receipt file, or reserve it
exclusively, so the path it prints exists. Then it emits the bootstrap line, the receipt head,
and the command's output, in that order.

```json
{"event":"run","t":1795326412345,"seq":0,
 "tool":"theme-book","v":"0.2.1",
 "run":"01JD3KQ8Z6V9X2M4N7P1R3T5W8","session":"ses_9c4f",
 "paths":{"receipt":"/work/site/.parley-vous/receipts/01JD3KQ8Z6V9X2M4N7P1R3T5W8.jsonl"},
 "_schema":{"id":"parley-vous.run.bootstrap","version":"1.0.0"}}
```

It **MUST** be emitted before the work starts, not after it finishes. **If the run crashes, the
caller still needs to know where the partial receipt is** — and a path printed at the end is a
path you never get on the failure path.

The bootstrap line **MUST** stay small. The argv echo, the resolved interpretation and the input
digests belong in the receipt's own first line (§5).

`v` is the program's own version. `_schema.version` on the same line is the version of the
bootstrap schema. They move for unrelated reasons (§4.4) and agree only by coincidence. `paths`
names the files this run writes; `receipt` is the only one the protocol defines, and a program
**MAY** add others it documents.

### 3.2 Startup failure

A run that cannot reach the bootstrap line, because no receipt location is usable, the
arguments cannot be parsed, or the program cannot read its own declaration, **MUST NOT** fabricate
a bootstrap line naming a receipt that does not exist. It emits exactly one line, on stderr, and
exits `3` (§3.4):

```json
{"event":"startup.failed","t":1795326412345,"seq":0,"run":"01JD3KT1F6G2H8J4K9L3M7N5P1",
 "tool":"theme-book","v":"0.2.1","code":"startup.receipt_unwritable",
 "problem":"No writable receipt location: .parley-vous is read-only and ~/.local/state is not writable",
 "remedy":"make .parley-vous writable or set XDG_STATE_HOME to a writable absolute path",
 "_schema":{"id":"parley-vous.startup.failed","version":"1.0.0"}}
```

It carries `run` because the execution still has an identity, `seq: 0` because it is the only line
the run emits, and the §6 error fields because it is an error. Its `code` is in the `startup.`
namespace, so a reader can tell a startup failure from a command's own error codes without
reading the event name. A receipt file that cannot be created although its directory is usable
is a startup failure too (§3.1 makes creation a precondition of the bootstrap line), so it exits
`3`, not `4`. There is no receipt and no `end`.
This is the one line a run may emit without a bootstrap line before it.

The bootstrap line is the boundary for a usage error (an unknown flag, a bad value, a missing
argument). One found before it is a startup failure: this one line and exit `3`. One found after it
is a command error: a complete failed receipt and exit `2` (§3.4, §6). Where a program checks its
arguments decides which, so a program **MUST** document where it checks them, and **SHOULD** check
them before the bootstrap line, because a mistaken call did no work and a receipt of it is noise.

### 3.3 The terminal event

A run that bootstrapped **MUST** close with an `end` event, the final logical event of the run,
written to stdout and to the receipt as one event (§1.3: same `seq`, `t` and `event`). Its `seq`
is the run's final sequence number; there is no separate field for it.

```json
{"event":"end","t":1795326412401,"seq":9,"run":"01JD3KQ8Z6V9X2M4N7P1R3T5W8",
 "status":2,"receipt":"/work/site/.parley-vous/receipts/01JD3KQ8Z6V9X2M4N7P1R3T5W8.jsonl","redacted":true,
 "_schema":{"id":"parley-vous.end","version":"1.0.0"}}
```

- `status` is the exit status the process is about to exit with (§3.4). The run shown across this
  specification's examples reported an error (§6) and closes with `2`.
- `receipt` repeats the receipt path, so the last line a reader sees names it as well as the
  first.
- `redacted` is `true` exactly when the receipt head carries `redacted` or any `redaction` event
  was emitted (§5.3). Every redaction in the run is recorded by one of those two, so this one flag
  is the aggregate a replay decision (§2.3) reads, not the writer's memory.

Once emission of `end` begins its contents are fixed. A program **MUST NOT** emit a replacement
`end` and **MUST NOT** emit any line after it, on any stream, an error line included. A write or
close failure during or after the emission of `end` is carried by the exit status alone: the
process exits `4` (§3.4), the `end` already written keeps the status it carried, and a reader
holding both **MUST** report the disagreement rather than pick one. A sink failure **before**
`end` is reported as an error line where a sink still works (§5.4), and `end` then carries `4`.

A failed command still finishes: an `end` with a non-zero `status` closes a **complete failed
receipt**. A receipt or stdout capture with no `end` is **incomplete lifecycle evidence**: the
reader knows the run did not finalise, and nothing more. EOF is not success.

`end` records the producer's terminal outcome. It cannot make independent file and pipe writes
atomic; a startup failure (§3.2) and a failure of the output or receipt sinks (status `4`) are the
named exceptions to the two-copy guarantee.

### 3.4 Exit status

| Status | Meaning |
| --- | --- |
| `0` | The command completed and succeeded. |
| `2` | The command failed and reported a structured error (§6), a usage error found after the bootstrap line included (§3.2). |
| `3` | Setup failed before the bootstrap line, a usage error found there included; the only output is the §3.2 diagnostic. |
| `4` | Protocol output, receipt writing or finalisation failed, including a failure while writing the bootstrap line. Whatever remained possible through working sinks was preserved, subject to the immutable `end`: a run whose bootstrap write failed still closes its receipt with `end` carrying `4`, since the receipt was created first (§3.1). A record withheld because redaction left it invalid under its declared schema, or because the program could not evaluate the schema document it holds for it (§5.3), is protocol output that could not be written, and gives this status too. |
| signal-derived | Termination by signal: the documented exception. Terminal output may be absent. |
| other | Tool-owned and documented by the tool. A tool **MUST NOT** redefine `0`, `2`, `3` or `4`. |

A condition the program recovered from, so that the command still succeeded, is a warning (§6),
not a terminal error, and does not change the status. When a run both reported a structured
error and suffered a sink failure, `4` takes precedence: the protocol failed, and the reader can
still see the error line where it was written.

---

## 4. Self-description

### 4.1 Discovery is a run

`--schema` and `--help` are how a caller learns the contract before it runs anything, so their
output is held to the contract too. A discovery invocation **is a run**: it bootstraps (§3.1),
writes its receipt (§5), carries the §1.3 envelope on every line, and closes with `end` (§3.3).
Its effects are bookkeeping only. Two message types carry discovery:

- A **`command`** line describes one command: its name, a one-line intent, the effects it
  declares (§4.3), the secrets it declares (§5.3), and the message types it can emit.
- A **`schema`** line carries one message schema, with the `id` and `version` the schema pins and
  the JSON Schema document itself.

### 4.2 `--schema` and `--help`

`app --schema` **MUST** emit one `command` line per command and one `schema` line per message
schema the program can emit, then exit `0`. This is the machine counterpart of `--help` and makes
a program self-describing without a registry. Output discovery is not the same as **capability**
discovery, and a caller that cannot find out what questions a tool answers will go read its
source and guess; the `command` lines are the answer.

`app <command> --help` **MUST** emit the `command` line for that command, then a `schema` line for
its success output and one for **every error type it can produce**. Every command can produce a
startup failure (§3.2), so that list includes `parley-vous.startup.failed` beside the command's own error
types.

```json
{"event":"schema","t":1795326412402,"seq":2,"run":"01JD3KR2A7B4C9D1E6F3G8H5J2",
 "id":"theme-book.count","version":"1.0.0",
 "schema":{"$schema":"https://json-schema.org/draft/2020-12/schema",
           "$id":"https://flyingrobots.dev/theme-book/schemas/theme-book.count/1.0.0",
           "type":"object","required":["event","t","seq","run","value","_schema"],
           "properties":{"event":{"const":"result"},"value":{"type":"integer","minimum":0}}},
 "_schema":{"id":"parley-vous.schema","version":"1.0.0"}}
```

### 4.3 Declared effects

A command's description, its `command` line (§4.1), **MUST** declare its effects:

```json
{"event":"command","t":1795326412401,"seq":1,"run":"01JD3KR2A7B4C9D1E6F3G8H5J2",
 "name":"count","intent":"Count the colour tokens declared under the working directory",
 "effects":{"reads":["<cwd>/**/*.css"],"writes":[],"network":false,"idempotent":true,
            "bookkeeping":[{"op":"create","scope":".parley-vous/receipts/"},
                           {"op":"create","scope":".parley-vous/.gitignore"},
                           {"op":"delete","scope":".parley-vous/receipts/"},
                           {"op":"create","scope":"$XDG_STATE_HOME/parley-vous/"}]},
 "secrets":["--token","THEME_BOOK_TOKEN","netrc"],
 "emits":[{"id":"theme-book.count","version":"1.0.0"},{"id":"parley-vous.error","version":"1.0.0"}],
 "_schema":{"id":"parley-vous.command","version":"1.0.0"}}
```

`writes` lists **subject-matter** writes: what the command exists to change. `writes: []` means
the command changes nothing it was asked about; it does not mean the filesystem is untouched,
because every conforming program writes evidence. Those writes are declared separately, in
`effects.bookkeeping`: the receipt and its sidecars (§5), the local ignore file (§5.2) and
retention operations (§5.1), each with an operation (`create`, `append`, `delete`) and a scope,
so creation and deletion are distinguishable and nothing a program does to the filesystem is
undeclared. Bookkeeping is observable behaviour, not an exemption; it cannot cover a mutation the
command was asked to make.

`secrets` names the arguments, environment variables and credential sources whose values are secrets
(§5.3): an argument by its flag, a variable by its name, and a file or other implicit source by a
logical name such as `netrc` or `keychain:github`. It is part of the same declaration, so a caller
learns before running what the receipt will not contain. A command with no secrets declares an empty
list.

A caller needs to know whether something mutates **before** running it. Every command **SHOULD**
accept `--dry-run`. A dry run emits the bootstrap line, writes its receipt and any evidence
sidecars, and performs no subject-matter writes, no mutating remote action and no retention
deletion. Its receipt describes what would have happened, not effects that occurred, and the
bootstrap line and receipt head both carry `dry_run: true` so no reader mistakes one for the
other.

### 4.4 Schema versioning

- Every message type has a JSON Schema published in the repository under `schemas/`.
- **Each message type is versioned separately from the program's own version.** They change for
  unrelated reasons; coupling them forces false breaking changes on every release and hides real
  ones inside a patch bump.
- Schemas **MUST** be validated against real output in the program's own tests, line by line. A
  schema nothing checks drifts from what it describes, and is then worse than no schema because it
  is believed.

### 4.5 Compatibility

Schema versions are SemVer in the core `MAJOR.MINOR.PATCH` form only, with no prerelease or
build metadata, and the number is a promise to readers:

- A **minor** bump **MAY** add optional fields that are safe to ignore. It **MUST** preserve the
  meaning and the constraints of every field the previous minor defined. It is not a promise
  that the newer schema accepts every older line: a schema that is open to unknown fields
  cannot be, because an older line may already carry a value under a name the new minor
  defines. A reader that lacks the exact schema for a newer minor can still rely on the fields
  it knows.
- A **major** bump may remove, rename or retype a field, add a required one, or narrow a
  constraint. A reader **MUST NOT** report a line of a major it does not support as validated.
- A **patch** bump changes descriptions only.

Parley-vous schemas are **open**: they do not set `additionalProperties: false` anywhere, nested
objects included, except on `_schema` itself. Each message schema pins both `_schema.id` and
`_schema.version` by `const` to its own exact id and version.

**Full validation is against the schema for the exact advertised `(id, version)` pair.** A reader
**MUST NOT** run another version's schema over a line and call the result validation, not even
the latest schema of the same major. When a reader has no schema for the exact pair it **MAY**
check the version-independent core, which is the §1.3 envelope and the shape of `_schema`, and
it **MUST** report that result as partial, never as validation of the advertised contract; a
reader that runs no such check reports the line as unvalidated. A conformance checker **MUST
NOT** turn "the part I recognise passed" into "the contract passed".

A schema version whose changelog entry is still under `Unreleased` is a draft and **MAY** change
in place; a draft change is recorded in that entry rather than as a bump. A release is a version
heading in `CHANGELOG.md` that names the schema versions it publishes. A released schema version
is immutable: the release snapshots it, and the snapshot is what the pair resolves to from then
on (§4.6). A top-level schema file may hold a released version only with the snapshot's exact bytes, and
the first change after a release moves it to a new draft version. A draft's version string does not identify exact bytes, so a fixture
or test outside
the repository that holds the draft **MUST** pin a source commit or the schema's digest, and a
reader built from a draft holds whichever bytes it shipped and **SHOULD** state their commit or
digest until a release exists.

Every message type starts at `1.0.0` under the `parley-vous.` prefix, under this section's rules.
Its first release is the first dated heading in `CHANGELOG.md` that names its version. A schema
released under the protocol's former name is not one of these versions ([History](#history)).

### 4.6 Resolution

`_schema.id` and `_schema.version` are identifiers, not fetch instructions. A reader resolves the
pair to the schema it ships with for exactly that id and version, and applies §4.5 when it has
none. The `$id` inside each published schema is
`https://flyingrobots.dev/parley-vous/schemas/<id>/<version>` and is likewise an identifier; it is
not required to be served. The current version of each schema lives at `schemas/<id>.schema.json`
in this repository, and is a draft while its changelog entry is under `Unreleased`. Each released version is snapshotted, immutable, at
`schemas/released/<id>/<version>.schema.json`; the `CHANGELOG.md` entry for the release that
published it is the pointer. A reader ships the snapshots it supports.

A reader that ships no schema for a line's `_schema.id`, for example a tool-owned result such as
`theme-book.count`, **MUST NOT** validate that line against any other schema. It **MAY** parse the
line and pass it through, and **SHOULD** report that it did not validate it. Checking that the line
carries the §1.3 envelope fields is not validation against a schema and is permitted.

---

## 5. Receipts

A receipt is a JSON Lines file written for every run, at the path the bootstrap line declared.
It is written **whether or not anyone asked for it**.

**Where it goes.** The default location is `.parley-vous/receipts/<run>.jsonl` under the invocation's
**initial** working directory, resolved once at startup and unaffected by any later `chdir`. The
bootstrap line's `paths.receipt` **MUST** be absolute, so the path means the same thing to every
reader. Paths in this specification are POSIX paths; v0.3 does not define the Windows form. When
that location is unavailable, because the directory is read-only or cannot be created, or because
§5.2's hygiene cannot be established there, the program falls back to
`$XDG_STATE_HOME/parley-vous/<repo-hash>/receipts/<run>.jsonl`, honouring `XDG_STATE_HOME` only when it
is set, non-empty and absolute, and otherwise using `~/.local/state`. `<repo-hash>` is a digest of
the canonical path of the git worktree root, or of the canonical initial working directory outside
git; it keys storage and **MUST NOT** enter `inv` (§2.2). If no permitted location is writable, the
run fails at startup (§3.2, exit `3`): a fallback improves availability, it does not promise that
somewhere writable exists.

Its first line **MUST** carry `tool` and `v`, and what the bootstrap line omitted: the raw `argv`
as received, after §5.3 redaction; the `resolved` interpretation after defaults and environment are
applied; and a descriptor per declared input, with a digest for each input already read (§2.2:
digests that arrive later ride `receipt.inputs`).

> Echo both raw and resolved. The gap between them is where the bugs live: a relative path
> resolved somewhere surprising, a default silently filled in, an environment variable overriding
> a flag.

```json
{"event":"receipt.head","t":1795326412346,"seq":1,"run":"01JD3KQ8Z6V9X2M4N7P1R3T5W8",
 "tool":"theme-book","v":"0.2.1","session":"ses_9c4f",
 "argv":["theme-book","count","--format","css","--token","[redacted]"],
 "resolved":{"command":"count","format":"css","cwd":"/work/site","token":"[redacted]"},
 "redacted":{"argv":[5],"resolved":["/token"]},
 "inputs":[{"path":"src/tokens.css","sha256":"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"},
           {"path":"-","role":"stdin"},{"path":"vendor/","role":"tree"}],
 "effects":{"reads":["src/**/*.css"],"writes":[],"network":false,"idempotent":true,
            "bookkeeping":[{"op":"create","scope":"/work/site/.parley-vous/receipts/"}]},
 "_schema":{"id":"parley-vous.receipt.head","version":"1.0.0"}}
```

The head takes `seq: 1` because the bootstrap line took `0` and the run holds one counter (§1.3).
It names `tool` and `v` again, although the bootstrap line already did, because a receipt is read
on its own, tomorrow, by a reader that never saw stdout; without them it cannot say what wrote it,
and a reader that knows the tool's documented derivation (§2.2) cannot recompute `inv` when the
receipt carries one.
Recomputation works on a redacted receipt too, because a declared secret is never part of the
preimage.

Subsequent lines carry the program's reasoning as it works — one line per decision, emitted as it
happens rather than buffered, so a person watching sees the thing working. A reasoning line says
what was chosen **and why**; that is what makes a receipt worth keeping:

```json
{"event":"receipt.step","t":1795326412352,"seq":2,"run":"01JD3KQ8Z6V9X2M4N7P1R3T5W8",
 "decision":"read src/tokens.css as UTF-8",
 "because":"no BOM and no @charset; the declared default for this project is UTF-8",
 "detail":{"bytes":18422},
 "_schema":{"id":"parley-vous.receipt.step","version":"1.0.0"}}
```

The receipt also carries every result, error and warning the run emitted, as copies of the
stdout and stderr lines (§1.3: same `seq`, `t` and `event`), and closes with the `end` event
(§3.3). A reader tomorrow then has the answer, not only the reasoning that led to it. These copies
are subject to §5.3 like everything else in the receipt.

**Sidecars.** A record whose UTF-8 serialisation, excluding its terminating newline, exceeds
**65,536 bytes** **MAY** be stored beside the receipt instead of inside it; a result is the usual
case, a large error or reasoning record is the same. The stdout or stderr copy is unaffected. The
receipt then carries a `sidecar` event in the record's place:

```json
{"event":"sidecar","t":1795326412400,"seq":8,"run":"01JD3KQ8Z6V9X2M4N7P1R3T5W8",
 "source":7,"path":"01JD3KQ8Z6V9X2M4N7P1R3T5W8/7.json","bytes":2097152,
 "sha256":"3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855b",
 "_schema":{"id":"parley-vous.sidecar","version":"1.0.0"}}
```

- `source` is the `seq` of the record the sidecar holds. Here it is the run's `page` at `seq: 7`:
  its stdout copy carries the cursor and nothing else, and its receipt copy, which §1.3 lets be
  the fuller one, carries the page's rows, which is why it is large. The sidecar event has its own
  `seq` and schema and does not pretend to be the record. A `redaction` event (§5.3) that names a value
  inside a sidecar's stored record uses that record's `seq`, the `source`, as its `in`.
- `path` **MUST** be relative to the receipt's directory and **MUST NOT** leave it; the bundle
  moves as one.
- `bytes` and `sha256` describe the **stored bytes**, which is not the semantic `digest` of §7.1.
- The receipt and its sidecars are one bundle: copied together, retained together (§5.1), and
  deleted together.
- Every sidecar **MUST** be finalised before `end` reports success.
- A reader that finds a sidecar missing or its digest mismatched **MUST** treat the bundle as
  unavailable for replay (§2.3).
- §5.3 applies to a sidecar's contents exactly as to the receipt. A sidecar is not a place to put
  what the receipt may not hold.

### 5.1 Retention

Receipts accumulate. A conforming program **MUST** state a retention policy and **SHOULD**
enforce it by count, age or total size. Unbounded growth that nobody notices until it hurts is a
failure mode worth designing out rather than discovering.

A program's retention policy bounds the receipts that program wrote, which a receipt's head
names (`tool`). Receipts of other programs may share the directory, a reader's record of a read
included, and a program **MUST NOT** count them toward its policy or delete them under it.

A receipt whose final line is not a newline-terminated `end` (§3.3, §5.4) is incomplete, and its
run may still be writing it. A program **MUST NOT** delete an incomplete receipt under its policy
until the receipt has gone unmodified, by its modification time, for at least 24 hours. After
that, its run is treated as crashed. An incomplete receipt still counts toward the policy, so a
complete one may be deleted in its place. A complete receipt has no
writer left, since nothing may follow `end` (§3.3), so a program may delete it at any age, together
with its sidecars (§5). No lock between a running program and retention is defined, and the window
this leaves is accepted. A run that writes nothing for more than 24 hours, and then appends while
retention deletes its receipt, loses that receipt.

### 5.2 Repository hygiene

A program writing into `.parley-vous/` **MUST** first ensure that `.parley-vous/.gitignore` exists and
contains a line consisting of `*`, creating it if absent and never overwriting a file that is
already there, whether a user wrote it or git tracks it. Two programs starting at once **MUST** both
end with the file in place; create-if-absent is the rule, not create-or-replace. A program **MUST
NOT** edit the user's tracked `.gitignore` or any other tracked file to achieve this.

If the file exists and has no such line, it is a user's file: the program **MUST NOT** edit it,
**MUST** use the state-directory fallback (§5) for this run, and **SHOULD** emit a warning (§6.1)
saying why the receipt went elsewhere. The bootstrap line's absolute `paths.receipt` says where.
A file that has the line but also a negation pattern (a line beginning `!`) that can match the
directory `receipts` is a user's file too, under the same rule. Git cannot re-include a file whose
parent directory is excluded, so with `*` in force nothing under `receipts/` can be staged unless a
negation re-includes that directory; `!keep` cannot, `!receipts/` and `!*/` can. A program that
cannot tell whether a negation matches **MUST** treat it as one that does.

Be clear about what that buys. The file ignores itself, so it does not travel through a clone;
each conforming writer establishes hygiene locally on first use, and a collaborator's first run
does the same for them. Git's ignore rules also do nothing for a file that is already tracked. If
local hygiene cannot be established, because `.parley-vous/` cannot be created or the file cannot be
written, the program uses the state-directory fallback (§5) rather than touching tracked files.

### 5.3 Privacy

Receipts are durable and may contain file contents, resolved paths and prompts. A program
**MUST NOT** write credentials into a receipt, and **SHOULD** document what a receipt can contain.

Raw `argv` and the resolved environment are where credentials arrive, so §5's echo and this rule
collide unless the program redacts. Privacy wins:

- A program **MUST** declare which of its arguments, environment variables and credential sources
  carry secrets, by name, in the `secrets` list of its command description (§4.3), so the
  declaration is visible through `--help` before the command runs. A command with no secrets
  declares an empty list. A credential file is a secret source, never a declared input (§2.2); it
  is declared by a logical name, and the path by which it was supplied is not itself the secret
  and stays in `argv` and `resolved`.
- It **MUST** replace the value of each declared secret with the literal string `[redacted]`
  **before** the receipt head is written, wherever the receipt would carry it. An argument given as
  its own `argv` element becomes `[redacted]`; one given as `--name=value` becomes
  `--name=[redacted]`, so the flag stays visible; a secret embedded in a longer value, such as a
  path, is replaced within it. A secret is declared when any of the program's commands declares it,
  whichever command runs, since a value passed to the wrong command is still a secret.
- The head's `redacted` field **MUST** be present, and non-empty, whenever any declared secret was
  supplied to the run, and absent otherwise. Whether a declared argument or variable was supplied
  is known from `argv` and the environment; a declared credential source is supplied when the
  program has a credential from it, and the program **MUST** resolve every source the running
  command declares before the head is written, so that presence is known in time rather than
  discovered after the head can no longer say so. It records every redaction in the head: in `argv`
  (as indexes), in `resolved` (as JSON Pointers, RFC 6901), in `inputs` (as indexes), in the
  environment (as the names of variables any command declares that were present, whether or not the
  receipt carried their values) and in `sources` (the logical names of the running command's
  credential sources that were present, such as `netrc`). It **MUST NOT** resolve a source only
  another command declares: scrubbing reaches every command's declarations, because a secret in the
  environment can leak through a command that did not declare it, while resolving another command's
  source runs side effects the call never asked for. A declared secret that reaches a later receipt
  line is replaced there too; that line needs no entry on the head, because the head already says
  the receipt is partial. The schema document a `schema` line publishes (§4.2) is the exception:
  it is the program's own static declaration, fixed before any invocation, so no secret can reach
  it, and it **MUST** be published as declared. A secret value that occurs in it by coincidence,
  such as `object` or `2020`, was not written there by the run, and replacing it would advertise a
  pair whose document the line no longer carries. Every other field of discovery stays subject to
  this rule.
- It **MAY** redact more than it declared, in the head or in any later line, by replacing the value
  before the record is written and recording it with a `redaction` event (below), which for the
  head names `in: 1`. Name-based redaction misses odd names and pattern-based redaction misses odd
  values; the declaration is the floor, not the ceiling. An undeclared value redacted this way is
  still in the `inv` preimage (§2.2 excludes declared secrets only), so declaring it is the real
  protection.
- A reader **MUST NOT** replay from, or serve a cached answer for, a receipt that carries
  `redacted`, nor serve one to an invocation that supplied a declared secret (§2.3). Two
  invocations
that differ only in a secret, for example two tokens
  selecting two accounts, have the same `inv` (§2.2 excludes the secret) and identical receipts,
  and their answers may differ.

**Redaction events.** A redaction not recorded in the head's `redacted` field, under the MAY above
or because a declared secret surfaced in a later record or a sidecar, **MUST** be discoverable
from the completed receipt and not only from the writer's memory. Redaction is decided as the
record is written: the value is replaced in every copy of that record before any copy leaves the
process, and a record already written is never rewritten, since the receipt is append-only and
the stdout or stderr copy has already gone. The program then emits a `redaction` event into the
receipt naming where, after the record it names:

```json
{"event":"redaction","t":1795326412398,"seq":6,"run":"01JD3KQ8Z6V9X2M4N7P1R3T5W8",
 "in":4,"at":"/detail/url",
 "_schema":{"id":"parley-vous.redaction","version":"1.0.0"}}
```

`in` is the `seq` of the affected record (the head, a result, an error, a reasoning line, or the
stored record a sidecar holds, by its `source`) and `at` is a JSON Pointer within it. The `end`
event's `redacted` flag (§3.3) is `true` whenever the head carries `redacted` or any `redaction`
event was emitted, so a replay decision has one place to look.

**Redaction and the declared schema.** Replacing a value can leave a record invalid under the
schema it declares (§4.5): an integer field that held the secret now holds the string
`[redacted]`, or a string with a `pattern`, an `enum`, a `format` or a length bound no longer
meets it. A program **MUST NOT** publish a record that redaction made invalid under its declared
schema, on any stream or in the receipt, in its redacted form or its original one. It checks the
redacted record, as each stream and the receipt would receive it, before any copy leaves the
process; a record that fails gets no `seq` and is written nowhere. In its place the program
reports a structured error (§6) that names each affected field by JSON Pointer and the schema by
its `id` and `version`. That error **MUST NOT** carry the value, the text of a validator's message
or any part of the schema: a validator's message can quote the value it rejected, and here that
value is the secret or sits beside it. The withheld record is output the program could not write,
so the run closes with status `4` (§3.4). Privacy and the contract both hold and the answer is
lost: a program neither admits `[redacted]` where its schema does not, nor leaves a typed value
unredacted. A program that holds no schema document for the record's pair cannot make this check,
and the rule asks nothing of it for that record. A program that holds a schema document for the
pair and cannot evaluate it is not exempt: it cannot show that the redacted record is valid, so
it **MUST** withhold the record in the same way, with no copy on any stream or in the receipt, no
`seq`, a structured error under the same limits that names the schema by its `id` and `version`,
and status `4`.

A schema checks the shape of `redacted`, not its truth. Whether an indexed element contains
`[redacted]`, whether a pointer resolves, and whether a `[redacted]` marker in the head has a
matching entry in `redacted` or a `redaction` event naming `in: 1` are a reader's checks, and a
reader that performs them **SHOULD** report a mismatch as a defect in the writer.

### 5.4 Persistence

"Durable" here means ordinary-path persistence, not crash-safe durability. On every path that is
not a hard crash the program **MUST** write and close the receipt and its sidecars; it makes no
`fsync` or power-loss promise. A write or close error is an outcome, not something to swallow: it
**MUST** produce exit status `4` (§3.4) and, when it happens before `end`, an error line where a
sink still works. After `end` has begun, nothing follows it (§3.3); the exit status carries the
failure alone.

A reader **MUST** ignore a final line that is not newline-terminated, including an otherwise
parseable `end`. A newline-terminated `end` establishes that the run reported termination.
Replay (§2.3) additionally requires the records it needs, intact sidecars, a successful outcome,
and eligibility under §2.3 and §5.3; termination alone is none of those.

---

## 6. Errors

Errors go to stderr, as JSON Lines, and are retained in the receipt (§5). They **MUST** carry
structure rather than prose. `code` is a
stable identifier of at least two dot-separated segments of lowercase letters, digits and
underscores, such as `contrast.unsatisfiable` or `http.404`, never a sentence; `problem` is one
sentence and never empty:

```json
{"event":"error","t":1795326412380,"seq":4,"run":"01JD3KQ8Z6V9X2M4N7P1R3T5W8","code":"contrast.unsatisfiable",
 "problem":"No opaque sRGB foreground reaches the required contrast on this background",
 "measured":5.3783,"limit":7,"remedy":"adjust the background",
 "remedy_target":"--destructive",
 "_schema":{"id":"parley-vous.error","version":"1.0.0"}}
```

The fields that matter are **`measured`, `limit` and `remedy`**. An error naming the constraint,
the distance from it, and the lever is actionable in one step. An error reading `make failed with
exit code: 2` costs its reader several calls to trace.

A top-level handler **MUST** convert every uncaught throw before `end` into a conforming error
line; after `end` has begun, nothing is written and the process exits `4` (§3.3). The cases
that genuinely cannot be constrained — a hard crash inside a native dependency, a signal kill —
**MUST** be documented as exceptions rather than papered over. "No surprises" is only credible if
the places it cannot hold are named.

### 6.1 Warnings

A condition the program recovered from, so that the command still succeeded, is a **warning**: the
same shape as an error, the event `warning`, on stderr and retained in the receipt. Warnings alone
never change the exit status (§3.4). A condition that was not recovered from is an error.

```json
{"event":"warning","t":1795326412370,"seq":3,"run":"01JD3KQ8Z6V9X2M4N7P1R3T5W8",
 "code":"input.encoding_guessed","problem":"src/tokens.css has no BOM or charset; read as UTF-8",
 "remedy":"declare the file's encoding","remedy_target":"src/tokens.css",
 "_schema":{"id":"parley-vous.warning","version":"1.0.0"}}
```

Progress, the "still working, 40 of 120" kind of line, is neither a result nor a warning. It goes
to the receipt only (§5), where a person watching can see it and a caller paying for stdout
context does not.

---

## 7. Results

### 7.1 Digest

A result **SHOULD** carry a stable `digest` over its semantic content, **excluding** timestamps,
identifiers and durations, so a caller can answer "did anything change?" with one comparison
rather than diffing two payloads.

### 7.2 Pagination

Unbounded output **MUST** paginate explicitly with a cursor:

```json
{"event":"page","t":1795326412399,"seq":7,"run":"01JD3KQ8Z6V9X2M4N7P1R3T5W8",
 "cursor":"eyJhZnRlciI6NTB9","has_more":true,
 "_schema":{"id":"parley-vous.page","version":"1.0.0"}}
```

`cursor` is opaque to the caller and required whenever `has_more` is true; the last page carries
`has_more: false` and no cursor.

A caller that fears a large payload will truncate it with a pipe, and silent truncation of JSON is
unparseable at best and quietly wrong at worst.

---

## 8. The history stream (informative)

This section is informative. It describes a layer that consumes the format above. The writer
side — the shared stream, its segments and retention, and the transform that projects a copy of
it — has an implementation and tests in `packages/parley-emit`
([flyingrobots/parley-vous#3](https://github.com/flyingrobots/parley-vous/issues/3),
[flyingrobots/parley-vous#57](https://github.com/flyingrobots/parley-vous/issues/57)), and preferring the
least-projected copy, below, has one in `packages/parley-read`
([flyingrobots/parley-vous#58](https://github.com/flyingrobots/parley-vous/issues/58)). Nothing in it is a
conformance requirement in v0.3, and it becomes normative only when an implementation and tests
support its rules.

Everything above works with no infrastructure. This layer is opt-in.

The intent is that a program additionally appends its receipt lines to a shared stream when one
is configured, via an environment variable or a known state path. Present, the caller gets a
cross-repository, cross-agent timeline; absent, the program writes locally and nothing breaks.

**The dependency runs one way.** The stream consumes the format. The format never requires the
stream.

A copy of a run on the shared stream may also be a **projection** of the receipt copy rather than
the whole of it: a path, a hostname or a repository name that is fine in a local receipt can be
wrong on a timeline other people and tools read, so the intent is that a program may narrow what
reaches the stream, that such a copy says so by naming the projection that wrote it, and that
nothing a projection does changes the envelope or puts a line on the stream that no longer
validates against its own schema. A reader that finds the same record in more than one copy
should then prefer the least-projected one, because the receipt copy is the record and a
projection is a view of it.

Unlike a repository-scoped activity log, the shared stream spans tools, repositories, agents and
people, so a session can see that one agent was working here while another worked there, on one
timeline.

---

## 9. Reading history is an act (informative)

This section is informative, for the same reason as §8: the reader it describes is designed
([flyingrobots/parley-vous#2](https://github.com/flyingrobots/parley-vous/issues/2)). Its query entry point,
the ranking that orders a result by purpose, and the bounded digest that carries a result's lens
and states what it excluded have an implementation and tests
([flyingrobots/parley-vous#48](https://github.com/flyingrobots/parley-vous/issues/48),
[flyingrobots/parley-vous#49](https://github.com/flyingrobots/parley-vous/issues/49),
[flyingrobots/parley-vous#50](https://github.com/flyingrobots/parley-vous/issues/50)), and so does opening
the records a digest names by `(run, seq)`
([flyingrobots/parley-vous#51](https://github.com/flyingrobots/parley-vous/issues/51)). The direction is
kept here so the format above stays shaped for it.

A read against the stream is not a passive lookup. It is itself an event, and it is
task-oriented. The intended rules:

- A query declares its **observer** (who is asking) and its **purpose** (why).
- The purpose **shapes the result**. "I am about to change this program's audit path" should
  return records touching that surface, not the last fifty things in chronological order.
  Without a declared purpose, relevance is a guess.
- A query is recorded as an event. The store then learns which questions are actually asked,
  which is the signal for what to index and roll up.
- A result carries its own lens — the observer, the purpose and the window that produced it — so
  a later reader knows what it is looking at and cannot mistake a digest for the whole.
- A result reports what it excluded, at least as a count, so a caller can widen deliberately
  rather than never learning what it missed.

Two failure modes to design against:

- **Ceremony.** If declaring purpose is expensive, callers will skip it or write noise. It
  should be mostly inferable from context — tool, working directory, current task id — with
  free text optional.
- **Over-filtering.** A purpose-shaped result can hide the very thing the caller needed because
  they did not know to ask for it. This is why the excluded count is required.

> This section is deliberately thin. It rests on the observer-geometry treatment in the AIΩN
> Foundations Series, which has not yet been read against this spec. Expect it to change.

---

## 10. Open questions

1. Whether short-circuiting on a known `inv` should ever be the default, and what declares the
   boundary of "the world" that a declared input set does not capture.
2. Where the shared stream lives, and how a record is scoped and expired.
3. How `observer` and `purpose` are represented so they are cheap to supply and useful to filter on.
4. Whether `--human` output should be derivable from the JSON Lines by a separate renderer rather
   than implemented twice.
