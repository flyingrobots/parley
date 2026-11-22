# The reader: asker, view and budget

How a read against parley history states what it wants, and what a result says about itself. This
page is a reference for the two message types that exist today, `parley.query` and `parley.lens`.

**The reader is not built.** What exists on `main` is this representation, its two draft schemas
under [`schemas/`](../../../schemas/README.md), and the examples below. The query entry point, the
ranking, the digest and the drill-down are
[flyingrobots/parley#2](https://github.com/flyingrobots/parley/issues/2) and are not described
here, because they do not exist yet. Spec [§9](../../../spec/parley-v0.2.md) is informative and
unchanged; the reasoning behind the three fields is
[Observer geometry and spec §9](../related-work/observer-geometry.md), and the decision itself is
[flyingrobots/parley#46](https://github.com/flyingrobots/parley/issues/46).

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

| `view` | The answer it asks for |
| --- | --- |
| `what-ran` | One line per run: tool, version, status, time |
| `what-failed` | The errors, the warnings and the ends of runs that did not succeed |
| `what-changed` | Subject-matter writes, and the inputs they consumed |
| `how-it-decided` | The decisions and their reasons — the `receipt.step` records |
| `everything` | Every record in the window, in `(run, seq)` order |

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
| `asker.task` | The caller's current task id in the environment | Omitted |
| `view` | Nothing | **Refused.** There is no privileged view to fall back on, and a guessed view is one the caller cannot see in the lens |
| `budget` | One documented default, `{"records": 20}` | n/a — the default applies, and the result's lens carries the budget that was actually applied |
| `note` | Nothing | Omitted. Free text, recorded, never parsed; nothing in the answer branches on it |

The budget is the one field with a default, and the default is not silent: the lens states the
budget that produced the result, so a caller who got twenty records can see that twenty was the
number and say otherwise next time. A defaulted *view* could not be made visible that way — it
would be a different answer to a different question, reported as the answer to theirs.

## What a read costs on a command line

One argument each, each argument one token, and nothing positional:

```text
--asker <tool>                     # fills asker.tool; cwd and task come from context
--view <token>                     # one of the five
--budget <kind>=<n>[,<kind>=<n>]   # records, bytes, ms; --budget 20 means records=20
--note <text>                      # optional, free text, never parsed
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
  each further summarising step adds its own loss to the loss already taken;
- **a loss bound**, `loss.bound`, with the count of what was left out beside it.

`loss.bound` is `none` when the view is the identity on the window — then `excluded` is `0` — or
`count-only` when the count is all that is known. The count is a proxy and the schema says so:
what a view loses is worst-case, and one withheld record can matter more than fifty, so a
cardinality cannot bound it even in principle. A bound measured from a real translator is a later
version of `parley.lens`, written when something exists to measure it.

## The two messages

Both are drafts. See [`schemas/README.md`](../../../schemas/README.md) for the table and the rules
that govern a draft.

| Schema | Version | Message |
| --- | --- | --- |
| `parley.query` | 1.0.0 (draft) | A read, recorded as an event |
| `parley.lens` | 1.0.0 (draft) | The lens a result carries |

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
 "_schema":{"id":"parley.query","version":"1.0.0"}}
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
 "records":[{"run":"01JD3KQ8Z6V9X2M4N7P1R3T5W8","seq":4},
            {"run":"01JD3KQ8Z6V9X2M4N7P1R3T5W8","seq":9}],
 "_schema":{"id":"parley.lens","version":"1.0.0"}}
```

`bun run check` validates both of these against the schemas on every push, and
`scripts/schemas.test.ts` holds the invariants the schemas themselves must satisfy.

## What is still open

- A read that cannot be answered within the declared budget should say so, and say what budget
  would suffice ([flyingrobots/parley#48](https://github.com/flyingrobots/parley/issues/48)).
  Nothing in `parley.lens` 1.0.0 expresses that refusal.
- The digest that a lens precedes has its own message type and its own bound
  ([flyingrobots/parley#50](https://github.com/flyingrobots/parley/issues/50)).
- Whether the view vocabulary is the right five is a question for the first reader built on it.
  It is five tokens in a draft schema, not a settled list.
