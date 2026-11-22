# parley v0.2 — specification

**Status:** proposal. **Spec version:** `0.2.0`, versioned independently of any implementation.
**Normative terms:** **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT** and **MAY** are to be
interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and
[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) when, and only when, they appear in bold.

A protocol for programs whose primary caller is an agent. It defines how a program speaks on its
output streams, how it describes itself, and what it leaves behind. Sections 1 to 7 are the
normative core; §8 and §9 describe a history layer that consumes this format and is not yet
built, and are informative.

## Lineage

parley is not a new idea. It is the same idea as `echo`, `graft`, `jedit` and the witness work:
that a system should record what happened as it happens, carry its provenance, and let that
record be read as history rather than reconstructed from guesswork. Those apply it to code,
structure, editing and proof. parley applies it to the narrowest surface there is — what a
program prints.

That narrowness is the point. A tool conforms to parley by changing what it writes: JSON Lines
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
| **stdout** | The result. The smallest payload that answers the question, plus the bootstrap line. |
| **stderr** | Errors, and only errors. |
| **receipt file** | The record: argv, resolved interpretation, input digests, per-step reasoning. |

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

---

## 2. Identity

### 2.1 Three identifiers, and why

| Id | Scope | Derivation |
| --- | --- | --- |
| `run` | One execution | Unique per execution, lexicographically sortable (ULID or equivalent) |
| `inv` | One *question* | **Content-addressed**: a digest over the tool, its version, the normalised arguments, and the **bytes of every declared input**. Tool-defined in v0.2 (§2.2) |
| `session` | A working period spanning runs | Supplied by the caller or inherited from the environment |

Two runs of the same question are still two events whose receipts must not collide, so `run` is
required. Knowing they *were* the same question is what buys replay and change detection, so a
program **SHOULD** supply `inv`. v0.2 does not fix its derivation; a program that supplies it
**MUST** document how (§2.2). Collapsing the two identifiers loses one or the other.

`session` is optional. A program **MUST** carry it when the caller supplies one and **MUST NOT**
invent one. `run`, `inv`, `session`, `tool` and `v` are never empty strings; an identity with no
content identifies nothing.

### 2.2 Computing `inv`

In v0.2 `inv` is **SHOULD** and its derivation is tool-defined. A shared derivation is the goal
for v0.3, written from a real implementation and conformance vectors rather than ahead of them;
SHA-256 over canonical JSON, full-length encoding and role-preserving inputs are the candidates
to test, not rules. Until then, a program that supplies `inv` **MUST** document its derivation
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

```json illustrative
{"event":"receipt.inputs","t":1795326412360,"seq":5,"run":"01JD3KQ8Z6V9X2M4N7P1R3T5W8",
 "inputs":[{"path":"src/tokens.css","sha256":"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"},
           {"path":"-","role":"stdin","sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},
           {"path":"vendor/","role":"tree","error":"input.unreadable"}],
 "inv":"inv_7f3a9c1e",
 "_schema":{"id":"parley.receipt.inputs","version":"1.0.0"}}
```

Illustrative: `parley.receipt.inputs` is defined with the other receipt records in
[flyingrobots/parley#10](https://github.com/flyingrobots/parley/issues/10). An input the program
could not read is recorded with an `error` code and no digest; a run that then fails still
closes a complete failed receipt (§3.3) without that digest and without `inv`.

> **The trap.** Hashing input *paths* rather than input *bytes* makes `inv` stable across an edit
> to the file. "Idempotent" then silently means "stale", and any cache built on it serves wrong
> answers. The identity is over the question *and its subject matter*.

### 2.3 What `inv` buys

Each of these holds only where no declared secret is involved on either side: the receipt carries
no `redacted` (§5.3) and the invocation comparing against it supplied none. A redacted receipt
shares its `inv` with every run that differed only in a secret, so none of them applies to it.

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
Short-circuiting **SHOULD NOT** be the default, because inputs can be identical while the world is
not — a declared input set never captures everything. A matching `inv` on its own never
authorises skipping an effect or reusing an answer; it is one input to that decision.

Eligibility is checked on **both** sides. A program **MUST NOT** short-circuit when a declared
secret was supplied to the current invocation, or when the cached receipt carries `redacted`
(§5.3). Either run may have depended on which secret was used, and `inv` cannot tell, because
§2.2 keeps secrets out of it. Whether a declared secret was supplied is known from `argv` and the
environment before the head is written (§5.3), so both sides are decidable at the moment of
choice. The rule reaches declared secrets. A credential the program obtains some other way, from
a keychain, a credential helper or a token refresh, is outside it; a program that uses such
credentials **MUST** route them through a declared argument or environment variable (§4.3) or
**MUST NOT** short-circuit at all, because a reader cannot see them and this rule offers it no
protection for them. The same two-sided rule binds a reader that serves cached answers (§5.3): it
decides the current side from that invocation's own receipt head, whose `redacted` is mandatory
when a declared secret was supplied, or from its declaration together with its `argv` and
environment, and **MUST NOT** serve when it holds neither.

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
 "inv":"inv_7f3a9c1e","run":"01JD3KQ8Z6V9X2M4N7P1R3T5W8","session":"ses_9c4f",
 "paths":{"receipt":"/work/site/.parley/receipts/01JD3KQ8Z6V9X2M4N7P1R3T5W8.jsonl"},
 "_schema":{"id":"parley.run.bootstrap","version":"1.1.1"}}
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
{"event":"startup.failed","t":1795326412345,"seq":0,"run":"01JD3KQ8Z6V9X2M4N7P1R3T5W8",
 "tool":"theme-book","v":"0.2.1","code":"startup.receipt_unwritable",
 "problem":"No writable receipt location: .parley is read-only and $XDG_STATE_HOME is unset",
 "remedy":"set XDG_STATE_HOME or make .parley writable",
 "_schema":{"id":"parley.startup.failed","version":"1.0.0"}}
```

It carries `run` because the execution still has an identity, `seq: 0` because it is the only line
the run emits, and the §6 error fields because it is an error. There is no receipt and no `end`.
This is the one line a run may emit without a bootstrap line before it.

### 3.3 The terminal event

A run that bootstrapped **MUST** close with an `end` event, the final logical event of the run,
written to stdout and to the receipt as one event (§1.3: same `seq`, `t` and `event`). Its `seq`
is the run's final sequence number; there is no separate field for it.

```json
{"event":"end","t":1795326412401,"seq":9,"run":"01JD3KQ8Z6V9X2M4N7P1R3T5W8",
 "status":0,"receipt":"/work/site/.parley/receipts/01JD3KQ8Z6V9X2M4N7P1R3T5W8.jsonl","redacted":true,
 "_schema":{"id":"parley.end","version":"1.0.0"}}
```

- `status` is the exit status the process is about to exit with (§3.4).
- `receipt` repeats the receipt path, so the last line a reader sees names it as well as the
  first.
- `redacted` is `true` when any redaction occurred anywhere in the run: the head carries
  `redacted` (§5.3), or a `redaction` event was emitted (§5.3), or a sidecar holds a replaced value.
  A replay decision (§2.3) reads this field, not the writer's memory.

Once emission of `end` begins its contents are fixed. A program **MUST NOT** emit a replacement
`end` and **MUST NOT** emit ordinary events after it. If a write or close fails after `end` was
emitted, the process's observed exit status may differ from `end.status`; a reader holding both
**MUST** report the disagreement rather than pick one.

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
| `2` | The command failed and reported a structured error (§6). |
| `3` | Setup failed before the bootstrap line; the only output is the §3.2 diagnostic. |
| `4` | Protocol output, receipt writing or finalisation failed, including a failure while writing the bootstrap line. Whatever remained possible through working sinks was preserved, subject to the immutable `end`. |
| signal-derived | Termination by signal: the documented exception. Terminal output may be absent. |
| other | Tool-owned and documented by the tool. A tool **MUST NOT** redefine `0`, `2`, `3` or `4`. |

A condition the program recovered from, so that the command still succeeded, is a warning (§6),
not a terminal error, and does not change the status.

---

## 4. Self-description

### 4.1 `--schema`

`app --schema` **MUST** print every message schema the program can emit, then exit `0`. This is
the machine counterpart of `--help` and makes a program self-describing without a registry.

It **SHOULD** also list the commands with a one-line intent each. Output discovery is not the
same as **capability** discovery, and a caller that cannot find out what questions a tool answers
will go read its source and guess.

### 4.2 `--help`

`app <command> --help` **MUST** emit JSON Lines: a line describing the command, then the schema
for its success output and the schema for **every error type it can produce**.

### 4.3 Declared effects

A command's description **MUST** declare its effects:

```json illustrative
{"effects":{"reads":["<cwd>/**/*.css"],"writes":[],"network":false,"idempotent":true,
            "bookkeeping":[{"op":"create","scope":".parley/receipts/"},
                           {"op":"create","scope":".parley/.gitignore"},
                           {"op":"delete","scope":".parley/receipts/"}]},
 "secrets":["--token","THEME_BOOK_TOKEN"]}
```

`writes` lists **subject-matter** writes: what the command exists to change. `writes: []` means
the command changes nothing it was asked about; it does not mean the filesystem is untouched,
because every conforming program writes evidence. Those writes are declared separately, in
`effects.bookkeeping`: the receipt and its sidecars (§5), the local ignore file (§5.2) and
retention operations (§5.1), each with an operation (`create`, `append`, `delete`) and a scope,
so creation and deletion are distinguishable and nothing a program does to the filesystem is
undeclared. Bookkeeping is observable behaviour, not an exemption; it cannot cover a mutation the
command was asked to make.

`secrets` names the arguments, environment variables and credential files whose values are
secrets (§5.3). It is part of the same declaration, so a caller learns before running what the
receipt will not contain. A command with no secrets declares an empty list.

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

parley schemas are **open**: they do not set `additionalProperties: false` anywhere, nested
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
on (§4.6). The same change that snapshots a version bumps the draft to a new one, since a draft
may not claim a released pair. A draft's version string does not identify exact bytes, so a fixture
or test outside
the repository that holds the draft **MUST** pin a source commit or the schema's digest, and a
reader built from a draft holds whichever bytes it shipped and **SHOULD** state their commit or
digest until a release exists.

Nothing is released yet: no changelog heading names a schema version. The `1.0.0` schemas in git
history predate every rule in this section and were never released; a reader built against any
of them is outside the promise.

### 4.6 Resolution

`_schema.id` and `_schema.version` are identifiers, not fetch instructions. A reader resolves the
pair to the schema it ships with for exactly that id and version, and applies §4.5 when it has
none. The `$id` inside each published schema is
`https://flyingrobots.dev/parley/schemas/<id>/<version>` and is likewise an identifier; it is
not required to be served. The current draft of each schema lives at `schemas/<id>.schema.json`
in this repository. Each released version is snapshotted, immutable, at
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

**Where it goes.** The default location is `.parley/receipts/<run>.jsonl` under the invocation's
**initial** working directory, resolved once at startup and unaffected by any later `chdir`. The
bootstrap line's `paths.receipt` **MUST** be absolute, so the path means the same thing to every
reader. When that location is unavailable, because the directory is read-only or cannot be
created, the program falls back to `$XDG_STATE_HOME/parley/<repo-hash>/receipts/<run>.jsonl`,
honouring `XDG_STATE_HOME` only when it is set, non-empty and absolute, and otherwise using
`~/.local/state`. `<repo-hash>` is a digest of the canonical path of the git worktree root, or of
the canonical initial working directory outside git; it keys storage and **MUST NOT** enter `inv`
(§2.2). If no permitted location is writable, the run fails at startup (§3.2, exit `3`): a
fallback improves availability, it does not promise that somewhere writable exists.

Its first line **MUST** carry `tool` and `v`, and what the bootstrap line omitted: the raw `argv`
as received, after §5.3 redaction; the `resolved` interpretation after defaults and environment are
applied; and a digest per declared input.

> Echo both raw and resolved. The gap between them is where the bugs live: a relative path
> resolved somewhere surprising, a default silently filled in, an environment variable overriding
> a flag.

```json
{"event":"receipt.head","t":1795326412346,"seq":1,"run":"01JD3KQ8Z6V9X2M4N7P1R3T5W8",
 "tool":"theme-book","v":"0.2.1","inv":"inv_7f3a9c1e","session":"ses_9c4f",
 "argv":["theme-book","count","--format","css","--token","[redacted]"],
 "resolved":{"command":"count","format":"css","cwd":"/work/site","token":"[redacted]"},
 "redacted":{"argv":[5],"resolved":["/token"]},
"inputs":[{"path":"src/tokens.css","sha256":"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"}],
 "effects":{"reads":["src/**/*.css"],"writes":[],"network":false,"idempotent":true},
 "_schema":{"id":"parley.receipt.head","version":"2.0.0"}}
```

The head takes `seq: 1` because the bootstrap line took `0` and the run holds one counter (§1.3).
It names `tool` and `v` again, although the bootstrap line already did, because a receipt is read
on its own, tomorrow, by a reader that never saw stdout; without them it cannot say what wrote it,
and a reader that knows the tool's documented derivation (§2.2) cannot recompute `inv`.
Recomputation works on a redacted receipt too, because a declared secret is never part of the
preimage.

Subsequent lines carry the program's reasoning as it works — one line per decision, emitted as it
happens rather than buffered, so a person watching sees the thing working.

The receipt also carries every result, error and warning the run emitted, as copies of the
stdout and stderr lines (§1.3: same `seq`, `t` and `event`), and closes with the `end` event
(§3.3). A reader tomorrow then has the answer, not only the reasoning that led to it. These copies
are subject to §5.3 like everything else in the receipt.

**Sidecars.** A result record whose UTF-8 serialisation, excluding its terminating newline,
exceeds **65,536 bytes** **MAY** be stored beside the receipt instead of inside it. The stdout copy
is unaffected. The receipt then carries a `sidecar` event in the record's place:

```json
{"event":"sidecar","t":1795326412395,"seq":8,"run":"01JD3KQ8Z6V9X2M4N7P1R3T5W8",
 "source":7,"path":"01JD3KQ8Z6V9X2M4N7P1R3T5W8/7.json","bytes":2097152,
 "sha256":"3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855b",
 "_schema":{"id":"parley.sidecar","version":"1.0.0"}}
```

- `source` is the `seq` of the record the sidecar holds; the sidecar event has its own `seq` and
  schema and does not pretend to be the result.
- `path` is relative to the receipt's directory.
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

### 5.2 Repository hygiene

A program writing into `.parley/` **MUST** first ensure that `.parley/.gitignore` exists and
contains `*`, creating it if absent and never overwriting a file that is already there, whether
a user wrote it or git tracks it. Two programs starting at once **MUST** both end with the file
in place; create-if-absent is the rule, not create-or-replace. A program **MUST NOT** edit the
user's tracked `.gitignore` or any other tracked file to achieve this.

Be clear about what that buys. The file ignores itself, so it does not travel through a clone;
each conforming writer establishes hygiene locally on first use, and a collaborator's first run
does the same for them. Git's ignore rules also do nothing for a file that is already tracked. If
local hygiene cannot be established, because `.parley/` cannot be created or the file cannot be
written, the program uses the state-directory fallback (§5) rather than touching tracked files.

### 5.3 Privacy

Receipts are durable and may contain file contents, resolved paths and prompts. A program
**MUST NOT** write credentials into a receipt, and **SHOULD** document what a receipt can contain.

Raw `argv` and the resolved environment are where credentials arrive, so §5's echo and this rule
collide unless the program redacts. Privacy wins:

- A program **MUST** declare which of its arguments, environment variables and credential files
  carry secrets, by name, in the `secrets` list of its command description (§4.3), so the
  declaration is visible through `--help` before the command runs. A command with no secrets
  declares an empty list. A credential file is a secret source, never a declared input (§2.2).
- It **MUST** replace the value of each declared secret with the literal string `[redacted]`
  **before** the receipt head is written, wherever the receipt would carry it. An argument given as
  its own `argv` element becomes `[redacted]`; one given as `--name=value` becomes
  `--name=[redacted]`, so the flag stays visible; a secret embedded in a longer value, such as a
  path, is replaced within it.
- The head's `redacted` field **MUST** be present, and non-empty, whenever any declared secret was
  supplied to the run, and absent otherwise. Whether a declared secret was supplied is known from
  `argv` and the environment before the head is written, so this is decidable in time. It records
  every redaction in the head: in `argv` (as indexes), in `resolved` (as JSON Pointers, RFC 6901),
  in `inputs` (as indexes) and in the environment (as the names of declared variables that were
  present, whether or not the receipt carried their values). A declared secret that reaches a
  later receipt line is replaced there too; that line needs no entry on the head, because the
  head already says the receipt is partial.
- It **MAY** redact more than it declared, in the head or in any later line, by replacing the value
  in place. Name-based redaction misses odd names and pattern-based redaction misses odd values;
  the declaration is the floor, not the ceiling. An undeclared value redacted this way is still in
  the `inv` preimage (§2.2 excludes declared secrets only), so declaring it is the real protection.
- A reader **MUST NOT** replay from, or serve a cached answer for, a receipt that carries
  `redacted`, nor serve one to an invocation that supplied a declared secret (§2.3). Two
  invocations
that differ only in a secret, for example two tokens
  selecting two accounts, have the same `inv` (§2.2 excludes the secret) and identical receipts,
  and their answers may differ.

**Late redaction.** A redaction decided after the head is written, under the MAY above or because
a declared secret surfaced in a later record or a sidecar, **MUST** be discoverable from the
completed receipt and not only from the writer's memory. The program replaces the value in place
and emits a `redaction` event into the receipt naming where:

```json
{"event":"redaction","t":1795326412398,"seq":6,"run":"01JD3KQ8Z6V9X2M4N7P1R3T5W8",
 "in":4,"at":"/detail/url",
 "_schema":{"id":"parley.redaction","version":"1.0.0"}}
```

`in` is the `seq` of the affected record (a result, an error, a reasoning line or a sidecar event)
and `at` is a JSON Pointer within it. The `end` event's `redacted` flag (§3.3) is `true` whenever
the head carries `redacted` or any `redaction` event was emitted, so a replay decision has one
place to look.

A schema checks the shape of `redacted`, not its truth. Whether an indexed element contains
`[redacted]`,
whether a pointer resolves, and whether a `[redacted]` marker in the head has a matching entry
while `redacted` is present are a reader's checks, and a reader that performs them **SHOULD**
report a mismatch as a defect in the writer.

### 5.4 Persistence

"Durable" here means ordinary-path persistence, not crash-safe durability. On every path that is
not a hard crash the program **MUST** write and close the receipt and its sidecars; it makes no
`fsync` or power-loss promise. A write or close error is an outcome, not something to swallow: it
**MUST** produce exit status `4` (§3.4) and, where a sink still works, an error line saying so.

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
 "_schema":{"id":"parley.error","version":"2.0.0"}}
```

The fields that matter are **`measured`, `limit` and `remedy`**. An error naming the constraint,
the distance from it, and the lever is actionable in one step. An error reading `make failed with
exit code: 2` costs its reader several calls to trace.

A top-level handler **MUST** convert every uncaught throw into a conforming error line. The cases
that genuinely cannot be constrained — a hard crash inside a native dependency, a signal kill —
**MUST** be documented as exceptions rather than papered over. "No surprises" is only credible if
the places it cannot hold are named.

---

## 7. Results

### 7.1 Digest

A result **SHOULD** carry a stable `digest` over its semantic content, **excluding** timestamps,
identifiers and durations, so a caller can answer "did anything change?" with one comparison
rather than diffing two payloads.

### 7.2 Pagination

Unbounded output **MUST** paginate explicitly with a cursor:

```json illustrative
{"event":"page","t":1795326412390,"seq":7,"run":"01JD3KQ8Z6V9X2M4N7P1R3T5W8","cursor":"…","has_more":true,
 "_schema":{"id":"parley.page","version":"1.0.0"}}
```

Illustrative: `parley.page` is not yet published under `schemas/`
([flyingrobots/parley#10](https://github.com/flyingrobots/parley/issues/10)).

A caller that fears a large payload will truncate it with a pipe, and silent truncation of JSON is
unparseable at best and quietly wrong at worst.

---

## 8. The history stream (informative)

This section is informative. It describes a layer that consumes the format above and does not
yet exist ([flyingrobots/parley#3](https://github.com/flyingrobots/parley/issues/3)); nothing in
it is a conformance requirement in v0.2, and it becomes normative only when an implementation and
tests support its rules.

Everything above works with no infrastructure. This layer is opt-in.

The intent is that a program additionally appends its receipt lines to a shared stream when one
is configured, via an environment variable or a known state path. Present, the caller gets a
cross-repository, cross-agent timeline; absent, the program writes locally and nothing breaks.

**The dependency runs one way.** The stream consumes the format. The format never requires the
stream.

Unlike a repository-scoped activity log, the shared stream spans tools, repositories, agents and
people, so a session can see that one agent was working here while another worked there, on one
timeline.

---

## 9. Reading history is an act (informative)

This section is informative, for the same reason as §8: the reader it describes is designed
([flyingrobots/parley#2](https://github.com/flyingrobots/parley/issues/2)), not built. The
direction is kept here so the format above stays shaped for it.

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
