# The reader: asker, view and budget

How a read against parley history states what it wants, and what a result says about itself. This
page is a reference for the two message types that exist today, `parley.query` and `parley.lens`.

**Both messages are now written by something.** What is on `main` is this representation, its two
schemas under [`schemas/`](../../../schemas/README.md), the examples below, and a read in
the reader library that states these fields, is refused without them, is recorded as a
`parley.query` event, comes back **ordered by its view**, and answers with a **`parley.lens`
digest bounded by its budget** that states what the bound left out —
[parley-read](../parley-read/README.md#making-a-read),
[how the purpose orders the answer](../parley-read/README.md#how-the-purpose-orders-the-answer)
and [the digest](../parley-read/README.md#the-digest-and-what-it-left-out) — and a **drill-down**
that opens the records a digest names, recorded as a `parley.query` carrying `records`
([opening records by identity](../parley-read/README.md#opening-records-by-identity)). What is
read nowhere is what a digest excluded: it is a count, named by no id, and a caller reaches it by
reading again under a wider budget. [A cold resume on real history](cold-resume.md) is what this
reader was able to reconstruct, and what it was not, when an agent with no other context used it. Spec
[§9](../../../spec/parley-v0.2.md) is informative and unchanged; the reasoning behind the three
fields is [Observer geometry and spec §9](../related-work/observer-geometry.md), and the decision
itself is [flyingrobots/parley#46](https://github.com/flyingrobots/parley/issues/46).

## Three fields, not two

§9 asks a query for an **observer** (who is asking) and a **purpose** (why). The treatment §9
cites uses "observer" for something else — the *view*, a map from a history to the shape of an
answer — and holds that a view without a resource budget is not a view at all, because with no
bound every view collapses into "return every record". So a query carries three fields under three
names that do not collide with the source:

| Field | What it is | Shape |
| --- | --- | --- |
| `asker` | Who the read is for, and the context the budget comes from | A record: `tool` required, `cwd` and `task` optional |
| `view` | The shape of the answer | One token from a closed set of five |
| `budget` | The size of answer the asker will accept | A record of bounds: `records` required, `bytes` and `ms` optional |

The asker is not the view. Two askers requesting the same view under the same budget over the same
window get the same answer; that is what makes the view the thing a result can be compared on.

### The view vocabulary

Five tokens. Four are projections of a receipt stream that the treatment's taxonomy recognises as
distinct families, and the fifth is the identity.

| `view` | The answer it asks for | Implies a change |
| --- | --- | --- |
| `what-ran` | One line per run: tool, version, status, time | no |
| `what-failed` | The errors, the warnings and the ends of runs that did not succeed | no — failure is already its whole surface |
| `what-changed` | Subject-matter writes, and the inputs they consumed | **yes** |
| `how-it-decided` | The decisions and their reasons — the `receipt.step` records | no |
| `everything` | Every record in the window, in `(run, seq)` order | no — it is the identity |

The third column is a **derivation from this vocabulary, not a field**. `parley.query` carries
nothing saying "this purpose implies a change"; of the five tokens exactly one is an answer about a
change, and that is the one §9's own example — "I am about to change this program's audit path" —
asks for. A read under that view puts what failed above what succeeded, because a read made in
order to change something is a read made in order not to repeat a failure. The rules, and the
surface each token names, are on
[the reader library's page](../parley-read/README.md#how-the-purpose-orders-the-answer); adding a
token here has to decide both.

Closed, for two reasons. Declaring a view then costs one token, which is the only answer to §9's
ceremony failure mode that does not end in callers writing noise. And a view that is free text
cannot be refused, cannot be compared with another view, and cannot be stated in a lens as a claim
about what the result is. `everything` is in the set because a caller who suspects the view hid
what they needed has to be able to widen deliberately without learning a second interface.

Adding or removing a token changes `parley.query` and `parley.lens`, and so moves their schema
versions. The vocabulary is not extensible by a caller.

## Inference, and what is refused instead

| Field | Inferred from | When it cannot be |
| --- | --- | --- |
| `asker.tool` | The calling program's own identity | **Refused.** Spec §2.1 forbids inventing an identity; a read whose caller cannot be named is not recorded under a guess |
| `asker.cwd` | The process working directory | Omitted |
| `asker.task` | Nothing. There is no environment variable for it; the caller always supplies it ([flyingrobots/parley#61](https://github.com/flyingrobots/parley/issues/61)) | Omitted |
| `view` | Nothing | **Refused.** There is no privileged view to fall back on, and a guessed view is one the caller cannot see in the lens |
| `budget` | One documented default, `{"records": 20}` | n/a — the default applies, and the result's lens carries the budget that was actually applied |
| `note` | Nothing | Omitted. Free text, recorded, never parsed; nothing in the answer branches on it |
| `fold` | Nothing | Omitted, and the reader folds repeated runs. A caller who wants every run states `fold: false`, and the lens echoes it ([flyingrobots/parley#133](https://github.com/flyingrobots/parley/issues/133)) |

The budget is the one field with a default, and the default is not silent: the lens states the
budget that produced the result, so a caller who got twenty records can see that twenty was the
number and say otherwise next time. A defaulted *view* could not be made visible that way — it
would be a different answer to a different question, reported as the answer to theirs.

## What a read costs on a command line

One argument each, each argument one token, and nothing positional:

```text
--asker <tool>                     # fills asker.tool; cwd comes from context, task from the caller
--view <token>                     # one of the five
--budget <kind>=<n>[,<kind>=<n>]   # records, bytes, ms; --budget 20 means records=20
--note <text>                      # optional, free text, never parsed
--no-fold                          # optional; fills fold: false
```

A caller run from a program that knows its own name, in a working directory, with the default
budget, supplies one argument: `--view`. No form of the interface requires writing JSON on a
command line.

## What a result carries

A result is preceded by one `parley.lens` line. It names the view, the asker, the budget and the
window that produced it — the four together, because a lens missing the budget does not identify
the view, and results computed under different budgets are not comparable. It also names:

- **the query it answers**, by `(run, seq)`, since §9 records every query and a result whose query
  was not recorded cannot be audited;
- **the records it was built from**, by `(run, seq)`. Stored, not recomputed: projecting records
  down into a result is cheap, and expanding a result back up into records may be impossible
  within the caller's budget. A result is built from records, never from another result, because
  each further summarising step adds its own loss to the loss already taken. Each name also
  carries a **fixed summary** of the record: its `event`, its `t`, and on an `error` or a
  `warning` its `code`, each absent when the record does not carry it rather than filled in. It
  is what lets a reader choose what to open before opening anything
  ([flyingrobots/parley#77](https://github.com/flyingrobots/parley/issues/77)), and it is part of
  the line a byte budget bounds;
- **each run those records belong to**, once, in `runs`: the head's `tool`, `v`, `argv`,
  `resolved` (whole, the tool's own shape; flyingrobots/parley#90) and `inv`, the `outcome` the window establishes for the run (`failed`, `undetermined` or
  `succeeded`) and, when it is `undetermined`, a `reason` (`no_end_in_window` or
  `end_status_unusable`). A run whose head the window does not hold still has a section, saying
  `head: "not_in_window"`, and a section too large for its bound drops whole fields and names them
  rather than cutting a string
  ([flyingrobots/parley#83](https://github.com/flyingrobots/parley/issues/83)). Runs that are one
  invocation with one result — an equal `inv`, an equal outcome, status and error and warning
  codes, and equal result records — are named once, by the most recent of them, whose section says
  `folded: {others, records, stands_for}`: two counts of the other runs only, and those runs' ids
  ([flyingrobots/parley#79](https://github.com/flyingrobots/parley/issues/79),
  [flyingrobots/parley#100](https://github.com/flyingrobots/parley/issues/100),
  [flyingrobots/parley#133](https://github.com/flyingrobots/parley/issues/133)). Two runs whose
  results differ are never one, and a read that states `fold: false` folds nothing; the lens then
  echoes `fold`. The exact criterion is
  [the library's](../parley-read/README.md#runs-of-one-invocation-are-named-once);
- **a loss bound**, `loss.bound`, with the count of what was left out beside it, and
  `loss.folded`, how many of those a fold rather than the budget left out.

`loss.bound` is `none` when nothing in the window was left out — then `excluded` is `0`, and the
schema refuses any other pairing — or `count-only` when the count is all that is known. `none` is
not restricted to the identity view: a view orders a result and filters none of it
([flyingrobots/parley#49](https://github.com/flyingrobots/parley/issues/49)), so any view whose
result reached the end of its order lost nothing. The count is a proxy and the schema says so:
what a view loses is worst-case, and one withheld record can matter more than fifty, so a
cardinality cannot bound it even in principle. A bound measured from a real translator is a later
version of `parley.lens`, written when something exists to measure it.

Which budget field bounds what, and how the count is arrived at, is
[the digest](../parley-read/README.md#the-digest-and-what-it-left-out) on the library's page.

## The two messages

Both were released at 1.0.0 with spec `0.2.0`, so a change to either needs a new version. Both
are now at **draft 1.1.0**, which adds optional fields and removes nothing
([flyingrobots/parley#133](https://github.com/flyingrobots/parley/issues/133)): `fold` on the
query, and on the lens `fold` and a folded section's `stands_for`. The released 1.0.0 of each is
unchanged under `schemas/released/`, and the reader validates a line against the version it
advertises. See [`schemas/README.md`](../../../schemas/README.md) for the table and the rules that
govern a release and a draft.

| Schema | Version | Message |
| --- | --- | --- |
| `parley.query` | 1.1.0 (draft) | A read, recorded as an event; with `records`, a drill-down naming the records it opens |
| `parley.lens` | 1.1.0 (draft) | The lens a result carries |

A read is a run, so both lines carry the §1.3 envelope. `run` on these lines is the read's own run,
not the run being read: the read writes its own receipt like any other parley program, and `asker`
is who the read was for.

A query, asking what failed in the last day:

```json
{"event":"query","t":1795326500000,"seq":1,"run":"01JD5MN4T2A7B9C1D3E5F7G9H1",
 "asker":{"tool":"claude-code","cwd":"/Users/j/git/theme-book","task":"flyingrobots/theme-book#88"},
 "view":"what-failed",
 "budget":{"records":20},
 "window":{"from":1795240100000,"to":1795326500000},
 "note":"resuming after a crash; which run broke the audit path",
 "_schema":{"id":"parley.query","version":"1.1.0"}}
```

The lens of the result that answers it, naming the failed run of this specification's examples:

```json
{"event":"lens","t":1795326500004,"seq":2,"run":"01JD5MN4T2A7B9C1D3E5F7G9H1",
 "query":{"run":"01JD5MN4T2A7B9C1D3E5F7G9H1","seq":1},
 "asker":{"tool":"claude-code","cwd":"/Users/j/git/theme-book","task":"flyingrobots/theme-book#88"},
 "view":"what-failed",
 "budget":{"records":20},
 "window":{"from":1795240100000,"to":1795326500000},
 "loss":{"bound":"count-only","excluded":184},
 "runs":[{"run":"01JD3KQ8Z6V9X2M4N7P1R3T5W8","tool":"theme-book","v":"0.2.1",
          "argv":["theme-book","count","--format","css","--token","[redacted]"],"outcome":"failed"}],
 "records":[{"run":"01JD3KQ8Z6V9X2M4N7P1R3T5W8","seq":4,"event":"error","t":1795326412380,"code":"contrast.unsatisfiable"},
            {"run":"01JD3KQ8Z6V9X2M4N7P1R3T5W8","seq":9,"event":"end","t":1795326412401}],
 "_schema":{"id":"parley.lens","version":"1.1.0"}}
```

A drill-down is the same `parley.query` message with `records` naming what it opens, by the
`(run, seq)` pairs a lens carries, in the order asked. The view and window are the purpose and the
stretch of history the records were named from, and select nothing; `budget.records` is the number
of ids asked, and `budget.bytes`, when stated, bounds the records that open: the rest come back
`over_budget` with their size and no contents ([the rules](../parley-read/README.md#a-byte-bound)). Opening the two records the lens above names:

```json
{"event":"query","t":1795326530000,"seq":1,"run":"01JD5MP2W8C4E6G8J0K2M4P6R8",
 "asker":{"tool":"claude-code","cwd":"/Users/j/git/theme-book","task":"flyingrobots/theme-book#88"},
 "view":"what-failed",
 "budget":{"records":2},
 "window":{"from":1795240100000,"to":1795326500000},
 "records":[{"run":"01JD3KQ8Z6V9X2M4N7P1R3T5W8","seq":4},
            {"run":"01JD3KQ8Z6V9X2M4N7P1R3T5W8","seq":9}],
 "_schema":{"id":"parley.query","version":"1.1.0"}}
```

`bun run check` validates all three of these against the schemas on every push, and
`scripts/schemas.test.ts` holds the invariants the schemas themselves must satisfy.

## What is still open

- A deadline is checked between phases, not inside them. `budget.ms` bounds the whole read and a
  read past it declines and names the budget it measured
  ([parley-read](../parley-read/README.md#when-a-read-declines),
  [flyingrobots/parley#71](https://github.com/flyingrobots/parley/issues/71)), but the load reads
  every receipt in both locations whatever the window, so a slow load is only discovered once it
  has finished. Making a time bound cheap to honour needs an index
  ([flyingrobots/parley#2](https://github.com/flyingrobots/parley/issues/2)).
- `loss.bound` has two values and only one of them is a measurement. A distortion bound measured
  from a real translator is a later version of `parley.lens`, and nothing exists to measure it
  yet, so a caller who needs to know *what* a digest lost still has to widen the budget and read
  again.
- Whether the view vocabulary is the right five is a question for the first reader built on it.
  It is five tokens in a released schema, so adding a sixth is a minor version of `parley.query` and
  `parley.lens`, not an edit in place. All five now rank an answer, so each has
  a surface and a test behind it, but no caller outside this repository has asked for one yet.
