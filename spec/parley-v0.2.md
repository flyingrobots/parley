# parley v0.2 — specification

**Status:** proposal. **Spec version:** `0.2.0`, versioned independently of any implementation.
**Normative terms:** **MUST**, **SHOULD**, **MAY** indicate requirement strength.

A protocol for programs whose primary caller is an agent. It defines how a program speaks on its
output streams, how it describes itself, what it leaves behind, and how that record is read.

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
- No colour, spinners, progress bars, emoji or box drawing in the default format.

### 1.2 Stream roles

| Stream | Carries |
| --- | --- |
| **stdout** | The result. The smallest payload that answers the question, plus the bootstrap line. |
| **stderr** | Errors, and only errors. |
| **receipt file** | The proof: argv, resolved interpretation, input digests, per-step reasoning. |

**stdout carries what you need to act; the receipt carries what you need to verify.** A reader
should not have to pay context to re-read the program's own reasoning in order to use its answer,
and should always be able to go find that reasoning later.

A program **MUST NOT** allow a third-party library to write unstructured text to either stream.
Capture or silence it.

### 1.3 Every line

Every emitted line **MUST** carry:

| Field | Meaning |
| --- | --- |
| `event` | Discriminator naming the line's kind |
| `t` | POSIX time in **integer milliseconds**. No timezone, sortable as an integer |
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
recorded in the receipt, is one event and **MUST** carry the same `seq` in every copy. The pair
`(run, seq)` therefore identifies an event uniquely, and a consumer merging streams **MUST** treat
two lines with the same pair as one event. Because the bootstrap line (§3) is emitted first, it is
always `seq: 0`; nothing else is pinned.

---

## 2. Identity

### 2.1 Three identifiers, and why

| Id | Scope | Derivation |
| --- | --- | --- |
| `run` | One execution | Unique per execution, lexicographically sortable (ULID or equivalent) |
| `inv` | One *question* | **Content-addressed**: a digest over the tool, its version, the normalised arguments, and the **bytes of every declared input** |
| `session` | A working period spanning runs | Supplied by the caller or inherited from the environment |

Two runs of the same question are still two events whose receipts must not collide, so `run` is
required. But knowing they *were* the same question is what buys replay and change detection, so
`inv` is required too. Collapsing them loses one or the other.

`session` is optional. A program **MUST** carry it when the caller supplies one and **MUST NOT**
invent one.

### 2.2 Computing `inv`

`inv` **MUST** be derived from:

- tool name and version;
- the normalised argument vector, with flag order and defaults resolved;
- a digest of the **content** of every declared input, not its path.

`inv` **MUST NOT** incorporate wall-clock time, process id, working directory, temporary paths,
session id, or any value that varies between otherwise identical invocations.

> **The trap.** Hashing input *paths* rather than input *bytes* makes `inv` stable across an edit
> to the file. "Idempotent" then silently means "stale", and any cache built on it serves wrong
> answers. The identity is over the question *and its subject matter*.

### 2.3 What `inv` buys

- **Change detection.** Same `inv`, same result ⇒ nothing moved.
- **Non-determinism detection, free.** Same `inv`, *different* result ⇒ the program is not
  deterministic, which is a defect worth knowing about.
- **Replay.** A prior receipt for the same `inv` can answer without recomputing.

A program **MAY** short-circuit on a known `inv`. If it does, it **MUST** emit the hit as an
event rather than silently serving a cached answer, and **MUST** offer a way to force recompute.
Short-circuiting **SHOULD NOT** be the default, because inputs can be identical while the world is
not — a declared input set never captures everything.

---

## 3. The bootstrap line

The **first** line of stdout, emitted **before work begins**.

```json
{"event":"run","t":1763790412345,"seq":0,
 "tool":"theme-book","v":"0.2.1",
 "inv":"inv_7f3a…","run":"01JD3K…","session":"ses_9c…",
 "paths":{"receipt":".parley/receipts/01JD3K….jsonl",
          "log":".parley/logs/01JD3K….jsonl",
          "error":".parley/errors/01JD3K….jsonl"},
 "_schema":{"id":"parley.run.bootstrap","version":"1.1.0"}}
```

It **MUST** be emitted before the work starts, not after it finishes. **If the run crashes, the
caller still needs to know where the partial receipt is** — and a path printed at the end is a
path you never get on the failure path.

The bootstrap line **MUST** stay small. The argv echo, the resolved interpretation and the input
digests belong in the receipt's own first line (§5).

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
{"effects":{"reads":["<cwd>/**/*.css"],"writes":[],"network":false,"idempotent":true}}
```

A caller needs to know whether something mutates **before** running it. Every command **SHOULD**
accept `--dry-run`, reporting what it would do without doing it.

### 4.4 Schema versioning

- Every message type has a JSON Schema published in the repository under `schemas/`.
- **Each message type is versioned separately from the program's own version.** They change for
  unrelated reasons; coupling them forces false breaking changes on every release and hides real
  ones inside a patch bump.
- Schemas **MUST** be validated against real output in the program's own tests, line by line. A
  schema nothing checks drifts from what it describes, and is then worse than no schema because it
  is believed.

### 4.5 Compatibility

Schema versions are SemVer, and the number is a promise to readers:

- A **minor** bump is additive. A line valid under `1.1.0` is valid under `1.0.0` with its new
  fields ignored. A reader **MUST** ignore fields it does not know, so a reader built against
  `1.0.0` keeps working when a writer moves to `1.1.0`.
- A **major** bump may remove, rename or retype a field, or add a required one. A reader
  **MUST** reject a line whose major version is newer than the one it was built against, since it
  cannot know what changed.
- A **patch** bump changes descriptions only.

Because readers ignore unknown fields, parley schemas are **open**: they do not set
`additionalProperties: false` at the top level. `_schema` itself is closed, and pinned by `const`
in each message schema to that schema's own id and version, so a line cannot claim a schema it
was not written to.

### 4.6 Resolution

`_schema.id` and `_schema.version` are identifiers, not fetch instructions. A reader resolves them
to the schema it ships with for that id, and applies the rule in §4.5 to the version. The `$id`
inside each published schema is `https://flyingrobots.dev/parley/schemas/<id>/<version>` and
is likewise an identifier; it is not required to be served. Each schema lives at
`schemas/<id>.schema.json` in this repository at its current version; earlier versions are in
git history at the tag that published them.

---

## 5. Receipts

A receipt is a JSON Lines file written for every run, at the path the bootstrap line declared.
It is written **whether or not anyone asked for it**.

Its first line **MUST** carry what the bootstrap line omitted: the raw `argv`, the `resolved`
interpretation after defaults and environment are applied, and a digest per declared input.

> Echo both raw and resolved. The gap between them is where the bugs live: a relative path
> resolved somewhere surprising, a default silently filled in, an environment variable overriding
> a flag.

Subsequent lines carry the program's reasoning as it works — one line per decision, emitted as it
happens rather than buffered, so a person watching sees the thing working.

### 5.1 Retention

Receipts accumulate. A conforming program **MUST** state a retention policy and **SHOULD**
enforce it by count, age or total size. Unbounded growth that nobody notices until it hurts is a
failure mode worth designing out rather than discovering.

### 5.2 Repository hygiene

A program writing receipts into a repository **MUST** add a real `.gitignore` entry on first use.
A machine-local `.git/info/exclude` does not protect a collaborator who clones the repo.

### 5.3 Privacy

Receipts are durable and may contain file contents, resolved paths and prompts. A program
**MUST NOT** write credentials into a receipt, and **SHOULD** document what a receipt can contain.

---

## 6. Errors

Errors go to stderr, as JSON Lines, and **MUST** carry structure rather than prose:

```json abridged
{"event":"error","t":…,"seq":…,"run":"01JD3K…","code":"contrast.unsatisfiable",
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
{"event":"page","t":1763790412390,"seq":7,"run":"01JD3K…","cursor":"…","has_more":true,
 "_schema":{"id":"parley.page","version":"1.0.0"}}
```

A caller that fears a large payload will truncate it with a pipe, and silent truncation of JSON is
unparseable at best and quietly wrong at worst.

---

## 8. The history stream — optional

Everything above works with no infrastructure. This layer is opt-in.

A program **SHOULD** additionally append its receipt lines to a shared stream when one is
configured, via an environment variable or a known state path. Present, the caller gets a
cross-repository, cross-agent timeline; absent, the program writes locally and nothing breaks.

**The dependency runs one way.** The stream consumes the format. The format never requires the
stream.

Unlike a repository-scoped activity log, the shared stream spans tools, repositories, agents and
people, so a session can see that one agent was working here while another worked there, on one
timeline.

---

## 9. Reading history is an act

A read against the stream is **not** a passive lookup. It is itself an event, and it is
task-oriented.

- A query **MUST** declare its **observer** (who is asking) and its **purpose** (why).
- The purpose **shapes the result**. "I am about to change this program's audit path" should
  return records touching that surface, not the last fifty things in chronological order.
  Without a declared purpose, relevance is a guess.
- A query **MUST** be recorded as an event. The store then learns which questions are actually
  asked, which is the signal for what to index and roll up.
- A result **MUST** carry its own lens — the observer, the purpose and the window that produced
  it — so a later reader knows what it is looking at and cannot mistake a digest for the whole.
- A result **MUST** report what it excluded, at least as a count, so a caller can widen
  deliberately rather than never learning what it missed.

Two failure modes to design against:

- **Ceremony.** If declaring purpose is expensive, callers will skip it or write noise. It
  **SHOULD** be mostly inferable from context — tool, working directory, current task id — with
  free text optional.
- **Over-filtering.** A purpose-shaped result can hide the very thing the caller needed because
  they did not know to ask for it. This is why the excluded count is required.

> This section is deliberately thin. It rests on the observer-geometry treatment in the AIΩN
> Foundations Series, which has not yet been read against this spec. Expect it to change.

---

## 9a. Lineage

parley is not a new idea. It is the same idea as `echo`, `graft`, `jedit` and the witness work:
that a system should record what happened as it happens, carry its provenance, and let that
record be read as history rather than reconstructed from guesswork. Those apply it to code,
structure, editing and proof. parley applies it to the narrowest surface there is — what a
program prints.

That narrowness is the point. A tool conforms to parley by changing how it writes to stdout. It
needs no substrate, no daemon, no causal graph. If the same tool later writes into a richer
history, nothing it emits has to change, because the shape is already causal: identified,
ordered, provenanced, replayable.

It is a doorway, deliberately sized so someone can walk through it without agreeing to anything
larger.

## 10. Open questions

1. Whether short-circuiting on a known `inv` should ever be the default, and what declares the
   boundary of "the world" that a declared input set does not capture.
2. Where the shared stream lives, and how a record is scoped and expired.
3. How `observer` and `purpose` are represented so they are cheap to supply and useful to filter on.
4. Whether `--human` output should be derivable from the JSON Lines by a separate renderer rather
   than implemented twice.
