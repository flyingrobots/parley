# Pre-freeze review of `parley.query` 1.1.0 and `parley.lens` 1.1.0

**Recommendation: freeze as 1.1.0 after these named fixes.**

1. Four descriptions in the two drafts promised more than the reader does or left a rule
   unstated. They are reworded in the same pull request as this page
   ([findings 1 to 5](#findings)); no field or version moved.
2. The release notes must not say that 1.1.0 "removes or narrows nothing" without qualification.
   One statement the released `parley.lens` 1.0.0 makes about `loss.folded` does not hold of a
   1.1.0 line ([finding 6](#6-lossfolded-no-longer-depends-on-the-window-alone)). The
   `Unreleased` entry in `CHANGELOG.md` now says so, and
   [the compatibility statement](#the-compatibility-statement-the-release-should-make) below is
   the corrected one.
3. An empty string was a valid `stands_for` entry. The items now have `minLength: 1`, as every
   other run id in the two schemas has
   ([finding 7](#7-an-empty-string-was-a-valid-stands_for-entry)). This is the one constraint
   the review changed, on a field 1.0.0 does not define.

No finding shows the reader contradicting what a schema should say, so no bug is filed and the
released-schema hotfix is not needed.

## What this is

A dated review record, written on 2026-11-24 for
[flyingrobots/parley#146](https://github.com/flyingrobots/parley/issues/146). It reviewed the two
draft schemas at commit `04f213c` of `main`, as contracts: every key that differs from the
released 1.0.0 snapshots under `schemas/released/`, compared as parsed JSON, every `description`
included. The drafts came from
[flyingrobots/parley#133](https://github.com/flyingrobots/parley/issues/133). Spec release 0.2.1
([flyingrobots/parley#148](https://github.com/flyingrobots/parley/issues/148)) freezes them, and a
frozen description is frozen text.

Each finding cites the schema's words and either a named test in
`packages/parley-read/test/parley-read.test.ts` or the output of a probe. The probes were
throwaway scripts run against the reader's source at that commit; their output is
[captured below](#captured-probe-output), not written by hand. Where a probe found behaviour that
a reworded description now states and no test held, a test was added (RD-110i, RD-110j, RD-110k
in the [test plan](../parley-read/test-plan.md)); they passed without any change to the reader.

The current reference for the two messages is [the reader](README.md), and for the fold
[the library's page](../parley-read/README.md#runs-of-one-invocation-are-named-once). This page
does not replace either.

## The questions, answered

| Question | Answer |
| --- | --- |
| What counts as an equivalent run for folding, under each view | Under every view: an equal `inv`, outcome, `reason`, `end` statuses, error, warning and startup-failure codes, head's `resolved`, and result records equal one for one in `seq` order. Under `how-it-decided` and `everything`, equal `receipt.step` and `cache.hit` records too. Under `what-ran`, equal `cache.hit` records too. The draft named only the first two of those three views ([finding 2](#2-a-cachehit-is-compared-under-what-ran-too)) |
| What `stands_for` contains, how its order is determined, how its length relates to `others` | The other runs' ids, never the section's own, exactly `others` of them, ordered by each run's latest `t` in the window, the greater run id first in a tie, a run with no dated record last. The draft said "most recent first" and gave no rule ([finding 3](#3-stands_for-its-order-and-what-it-does-not-give)) |
| What `fold: false` guarantees | Nothing is folded: `loss.folded` is 0, no section carries `folded`, and the lens echoes `fold: false`. It does not guarantee that every run is returned. The budget still cuts the tail of the ranking, and `loss.excluded` counts what it cut ([finding 5](#5-what-fold-false-guarantees)) |
| What a constrained budget may omit from a folded section, and how that is reported | Nothing from inside it. `stands_for` is never shortened, by `budget.bytes` or by the 512-byte section bound. What a budget omits is the whole section: when no record of the representative is named, the run has no section, and its fold is reported only as a count in `loss.folded`. The draft said the lens "names every run a fold stands for" ([finding 1](#1-a-budget-can-leave-a-folds-names-out-of-the-lens)) |
| Whether 1.1.0 is the right version for each schema under spec §4.5 | Yes for `parley.query`. Yes for `parley.lens`, with one stated exception to "preserves the meaning" that the release must name ([the version question](#is-110-the-right-version-under-spec-45)) |
| The compatibility statement | The proposed one is accurate and incomplete: the lens has the same hazard the query has, in two fields, and the version selects the fold rule as well as the schema ([the statement](#the-compatibility-statement-the-release-should-make)) |

## Every difference from 1.0.0

Each row is one key or one sentence that differs. The classes are the issue's:

- **(a)** a clarification of a meaning 1.0.0 already had;
- **(b)** a correction so that the implementation honours a meaning 1.0.0 already had;
- **(c)** a new commitment a consumer may rely on.

The two rows marked "identity" are the version itself and carry no meaning of their own. "As
reviewed" is the draft at `04f213c`; "now" is after this pull request.

### `parley.query`

| # | Key or sentence, as reviewed | Class | Freezable as reviewed | Evidence |
| --- | --- | --- | --- | --- |
| Q0 | `$id` and `_schema.version` `const`: `1.0.0` to `1.1.0` | identity | yes | — |
| Q1 | `fold`: `type: boolean`, optional | (c) | yes | RD-110e, RD-110h; probe P7 |
| Q2 | "Whether the read may fold runs it judges to be repeats of one invocation with one result into the most recent of them" | (c) | yes; the rule it "judges" by is the lens's `runs[].folded` description | RD-90a |
| Q3 | "false: nothing is folded, so every run in the window keeps its own records and the budget alone decides what the answer names" | (c) | yes | RD-110d; probe P4 |
| Q4 | "true or absent: the reader folds, and the result's lens names every run a fold stands for." | (c) | **no**: false when the budget cuts a representative. Reworded ([finding 1](#1-a-budget-can-leave-a-folds-names-out-of-the-lens)) | RD-90j, RD-110j; probes P2, P3 |
| Q5 | "Never inferred: the reader records it only when the asker states it, and the lens echoes it." | (c) | yes | RD-110d, RD-110e; probe P4 |
| Q6 | "It selects nothing on a drill-down." | (c) | yes; parley-read's drill-down neither takes nor records `fold` | probe P6 |

### `parley.lens`

| # | Key or sentence, as reviewed | Class | Freezable as reviewed | Evidence |
| --- | --- | --- | --- | --- |
| L0 | `$id` and `_schema.version` `const`: `1.0.0` to `1.1.0` | identity | yes | — |
| L1 | `fold`: `type: boolean`, optional | (c) | yes | RD-110h; probe P7 |
| L2 | `fold`: "Echoed from the query, present exactly when the query states it" | (c) | yes | RD-110d; probe P4 |
| L3 | `fold`: "false: the read folded nothing, so loss.folded is 0 and no runs section carries folded because none was allowed to, not because no runs repeated." | (c) | yes | RD-110d; probe P4 |
| L4 | `fold`: "Two results over one window, one folded and one not, are not comparable, so a lens says which it is." | (a) | yes; it gives the reason and commits to nothing more | — |
| L5 | `runs[].folded.stands_for`: `type: array`, `minItems: 1`, `items.type: string`, optional | (c) | **no**: an empty string was a valid entry. `minLength: 1` added to the items ([finding 7](#7-an-empty-string-was-a-valid-stands_for-entry)) | RD-110h; probe P7 |
| L6 | `stands_for`: "The run ids of the other runs this section stands for, this run excluded, most recent first, so that their records can be opened by (run, seq) or read under a window that holds them" | (c) | **no**: the order has no stated rule, and "opened by (run, seq)" needs a `seq` the lens does not give. Reworded ([finding 3](#3-stands_for-its-order-and-what-it-does-not-give)) | RD-110f, RD-110i, RD-110k; probes P1, P6 |
| L7 | `stands_for`: "As many as others." | (c) | yes; now also says a schema cannot check it | RD-110f; probe P1 |
| L8 | `stands_for`: "Optional so that a line written under 1.0.0, which listed none, has the same shape; parley-read always writes it, never drops it to fit the section's bound and does not count it against that bound." | (c) | yes for the commitments. The reason given for "optional" was reworded: a 1.0.0 line is validated against 1.0.0 whatever 1.1.0 requires, and a minor may add only optional fields (§4.5) | RD-110g |
| L9 | `stands_for`: "It is part of the line budget.bytes bounds." | (c) | **no**: it did not say what the bound does to it. Reworded ([finding 1](#1-a-budget-can-leave-a-folds-names-out-of-the-lens)) | RD-110g, RD-110j; probe P3 |
| L10 | `loss.folded`: "It depends on the window, the view and fold, never on the budget" (1.0.0: "on the window alone, never on the budget") | (c), and it withdraws a statement 1.0.0 made | yes as text; it is the one place a 1.0.0 meaning is not preserved ([finding 6](#6-lossfolded-no-longer-depends-on-the-window-alone)) | RD-90e, RD-110c; probe P5 |
| L11 | `runs[].folded`: "…codes **and head's resolved** are equal too" | (a) | yes; the released reader already compared `resolved` and the 1.0.0 text omitted it | RD-100g |
| L12 | `runs[].folded`: "and whose result records are all equal: the tool's own records, each page and each sidecar's stored bytes, compared without the envelope's t, seq, run and session" | (b) | **no**: it omitted a read's own `lens`, records the protocol does not define, and that the comparison is in `seq` order. Reworded ([finding 4](#4-which-records-are-the-result-and-which-runs-never-fold)) | RD-110a, RD-110b; probe P5 |
| L13 | `runs[].folded`: "Under a view that states the decision records, how-it-decided and everything, their receipt.step and cache.hit records are equal as well." | (c) | **no**: a `cache.hit` is compared under `what-ran` too. Reworded ([finding 2](#2-a-cachehit-is-compared-under-what-ran-too)) | RD-110c; probe P5 |
| L14 | `runs[].folded`: "Two runs whose results differ are a divergence (spec §2.3) and never stand for one another." | (b) | yes | RD-110a |
| L15 | `runs[].folded`: "…and stands_for lists the others' run ids." | (c) | yes | RD-110f |
| L16 | `runs[].folded`: 1.0.0's sentence removed: "The folded runs' ids are not listed, to keep the line small: a read of a window that holds one of them without this run, or a load of the window, finds them." | (c), the other side of L15 | yes | RD-110f |

**Counts.** 24 differences: 2 identity, 2 of class (a), 2 of class (b), 18 of class (c). Of the
18 commitments, 13 were precise enough to freeze as reviewed and 5 were not (Q4, L5, L6, L9,
L13). One class (b) sentence, L12, was incomplete. Four of the five and L12 are reworded, L5
gained a constraint, and all are freezable now. The
rewording also changed two sentences that 1.0.0 and the draft shared, which the tables above do
not list because they did not differ: the first sentence of `loss.folded`
([finding 1](#1-a-budget-can-leave-a-folds-names-out-of-the-lens)) and "A run with no inv, and a
redacted run, never stands for another"
([finding 4](#4-which-records-are-the-result-and-which-runs-never-fold)).

## Findings

### 1. A budget can leave a fold's names out of the lens

**Schema text, as reviewed.** `parley.query` `fold`: "true or absent: the reader folds, and the
result's lens names every run a fold stands for." `parley.lens` `loss.folded`, unchanged from
1.0.0: "the records of every run a runs section's folded stands for, other than the section's
own." `stands_for`: "It is part of the line budget.bytes bounds."

**Behaviour.** `runs` holds "one section per run that records names … and none for any other
run". The fold is applied before the budget. So when the budget names no record of a
representative, that run has no section, nothing in the lens carries its `stands_for`, and the
runs it stands for are named nowhere. `loss.folded` still counts their records. Under
`budget.bytes` the same thing happens whenever the line cannot hold the section with all of its
ids: the ids are never shortened, so the digest stops before the representative's first record.

- Probe P2: a window of 19 records that holds five repeated runs. Under `budget.records` 4 the lens has
  no folded section, and `loss` is `{excluded: 15, folded: 12}`.
- Probe P3: a fold of 41 runs. Under 2,587 byte budgets no `stands_for` was ever shorter than
  `others`; 2,002 of the lines written counted the fold in `loss.folded` and had no section for
  it. From 745 to 2,392 bytes the lens named three records and no folded section.
- Tests: `a cut representative takes its others' count with it, and the loss shows the gap`
  (RD-90j), and `a byte budget never shortens the ids a fold names: the section is whole or
  absent` (RD-110j, added here).

**Verdict.** The reader is consistent, and the omission is reported: the sections'
`folded.records` sum to less than `loss.folded` exactly when a representative was cut. But two
sentences said otherwise and the third did not say what happens. The second of them is wrong in
the released 1.0.0 as well, which cannot be changed.

**Fix made.** `parley.query` `fold` now says the lens names the runs "in the section of the run
that stands for them", and: "The budget can leave that run out of the answer, and its section
with it; the lens then reports that fold as a count alone". `loss.folded` now says it counts "the
records of every run the fold left out", and that the sections' `folded.records` sum to it unless
the budget left a representative out. `stands_for` now says "when the line cannot hold it whole,
no record of this run is named and this section is absent, and loss.folded still counts the
fold", and that parley-read "never shortens it".

### 2. A `cache.hit` is compared under `what-ran` too

**Schema text, as reviewed.** "Under a view that states the decision records, how-it-decided and
everything, their receipt.step and cache.hit records are equal as well."

**Behaviour.** The reader compares a decision record when the view's surface holds that kind of
record. A `cache.hit` is on the surface of `what-ran` as well as of the two views named.

- Test: `runs whose decisions differ do not fold under a view that states decisions` (RD-110c)
  asserts that two runs whose `cache.hit` records differ do not fold under `what-ran`.
- Probe P5, row "cache.hit differs": no fold under `what-ran`, `how-it-decided` and `everything`;
  a fold under `what-failed` and `what-changed`.

**Verdict.** The reader, its test and the library's page agree with one another and the schema
did not. A consumer who read the schema would expect two runs served from different receipts to
fold under `what-ran`, and they do not. The rule the reader follows is the principled one, so the
description was wrong, not the reader.

**Fix made.** "Under a view whose surface holds decision records those are equal as well,
compared the same way: receipt.step under how-it-decided and everything, cache.hit under those
two and what-ran. A decision record of a kind the view's surface does not hold is not compared,
so runs that differ only in such records still stand for one another."

### 3. `stands_for`: its order, and what it does not give

**Schema text, as reviewed.** "most recent first, so that their records can be opened by (run,
seq) or read under a window that holds them".

**Order.** "Most recent" had no definition and no tie-break. The reader orders by the latest `t`
among each run's records in the window, the greater run id first in a tie, and a run with no
dated record last. That is the rule that picks the representative, so the section's own run and
its `stands_for` are one ordering.

- Probe P1: seven runs whose latest records are at 550, 150, 950, 150, 350, none and 950 ms. The
  representative is run 7 and `stands_for` is `[3, 1, 5, 4, 2, 6]`.
- Probe P1, randomised: 300 windows and 503 folded sections, with no section whose `stands_for`
  differed in length from `others`, repeated an id or held its own run.
- Test: `a fold lists its runs by their latest record, then by the greater id, an undated run
  last` (RD-110i, added here). No test held the tie-break before.

**What it does not give.** A drill-down opens a record by `(run, seq)`. `stands_for` gives the
run and not the `seq`. The fold does not compare `seq`, and under `what-ran`, `what-failed` and
`what-changed` it does not compare `receipt.step` records, so a folded run's result need not sit
at the representative's `seq`.

- Probe P6: two runs fold under `what-changed`; the representative's result is at `seq` 3.
  Opening `(folded run, 3)` returned `opened`, and the record was a `receipt.step`.
- Test: `a fold names runs, not records: a folded run's result can sit at another seq`
  (RD-110k, added here). The earlier test, `a fold names the runs it stands for, and their
  records open` (RD-110f), opens `seq` 3 of each folded run and finds results because its five
  runs have one layout.

**Verdict.** Not a reader defect: the library's page already says "The lens does not list their
`seq`s". The schema's sentence read as though the ids were enough to open the records.

**Fix made.** The description now states the order rule, and says: "It names runs, not records:
the others' seq numbers are not listed and need not be this run's, so their records are read
under a window that holds them with fold false, or opened by (run, seq) once their seq is known."
`runs[].folded` states the same rule for "the most recent of them".

### 4. Which records are the result, and which runs never fold

**Schema text, as reviewed.** "whose result records are all equal: the tool's own records, each
page and each sidecar's stored bytes". And, unchanged from 1.0.0: "A run with no inv, and a
redacted run, never stands for another (spec §2.3)."

**Behaviour, from probe P5 and `only runs whose result records are all equal fold` (RD-110b).**

- The comparison is one for one in `seq` order: the same two results in the other order do not
  fold.
- A read's own `lens` is a result, compared without the `query` it names. Two reads whose lenses
  name different records do not fold.
- A record whose event the protocol does not define is compared as a result, whatever pair it
  advertises.
- A sidecar is compared by `bytes` and `sha256`. Its `path` is not compared.
- Not compared, so runs that differ only in these fold: an error's or a warning's text (its code
  is compared), the head's `argv`, and the `command`, `schema` and `receipt.inputs` records.
- A run whose window holds neither its head nor an `end` that states `redacted: false` never
  folds, because nothing shows it is unredacted (`a redacted run is never folded`, RD-90d). The
  sentence listing what never folds did not include it.

**Verdict.** The description is an enumeration, and a consumer reads an enumeration as complete.
It was short by two kinds of result record, by the order, and by one kind of run that never
folds. Nothing it said was false.

**Fix made.** "whose result records are equal one for one in seq order: the tool's own records
and any other record the protocol does not define, each page, each sidecar by its bytes and
sha256, and a read's own lens without the query it names". And: "A run with no inv, a redacted
run, and a run the window does not show to be unredacted, because it holds neither the run's
receipt head nor an end that states redacted false, never stand for another (spec §1.2a, §2.3)."
What is not compared stays on the library's page: a description that listed every record a fold
ignores would freeze the list.

### 5. What `fold: false` guarantees

**Schema text.** `parley.query`: "false: nothing is folded, so every run in the window keeps its
own records and the budget alone decides what the answer names". `parley.lens`: "false: the read
folded nothing, so loss.folded is 0 and no runs section carries folded".

**Behaviour.** Probe P4, over five identical runs of three records:

| Request | Lens `fold` | Named | `loss` |
| --- | --- | --- | --- |
| no `fold` | absent | 3 | `{count-only, excluded: 12, folded: 12}` |
| `fold: true` | `true` | 3 | `{count-only, excluded: 12, folded: 12}` |
| `fold: false` | `false` | 15 | `{none, excluded: 0, folded: 0}` |
| `fold: false`, `budget.records` 4 | `false` | 4 | `{count-only, excluded: 11, folded: 0}` |
| `fold: false`, `budget.bytes` 900 | `false` | 3 | `{count-only, excluded: 12, folded: 0}` |

Every line validated against 1.1.0. Test: `a read that states fold false folds nothing and says
so` (RD-110d).

**Verdict.** Precise enough to freeze as reviewed. The guarantee is that the fold removes
nothing, not that the answer is complete: with the fold off, all of `loss.excluded` is the
budget's. No change made.

### 6. `loss.folded` no longer depends on the window alone

**Schema text.** 1.0.0: "It depends on the window alone, never on the budget, so excluded minus
folded is what the budget cut." Draft: "It depends on the window, the view and fold, never on the
budget, so excluded minus folded is what the budget cut."

**Behaviour.** Probe P5, one window of 16 records under each view, at two budgets:

| `budget.records` | `what-ran` | `what-failed` | `what-changed` | `how-it-decided` | `everything` |
| --- | --- | --- | --- | --- | --- |
| 1000 | 4 | 8 | 8 | 0 | 0 |
| 3 | 4 | 8 | 8 | 0 | 0 |

The draft's sentence is true: the number moves with the view and not with the budget. Test: `the
loss separates what the fold left out from what the budget cut` (RD-90e).

**Verdict.** The sentence is accurate and freezable. It is also the one place where 1.1.0 does
not preserve something 1.0.0 said: a consumer of 1.0.0 was told the number is a property of the
window. See [the version question](#is-110-the-right-version-under-spec-45). No wording change;
the release notes changed.

### 7. An empty string was a valid `stands_for` entry

**Schema text, as reviewed.** `stands_for`: `{"type": "array", "minItems": 1, "items": {"type":
"string"}}`. Every other run id in the two schemas is `{"type": "string", "minLength": 1}`.

**Behaviour.** Probe P7, as reviewed: a 1.1.0 lens with `stands_for: [""]` validated. So does
one whose `stands_for` is longer than `others`, which no schema can refuse and the description
now says.

**Verdict.** The reader never writes an empty id. The schema, once frozen, would have accepted
one forever. `minLength: 1` on the items is a constraint on a field 1.0.0 did not define, so it
is free in a draft and impossible after the freeze without a major version.

**Fix made.** The review first left this to the owner, because it is a constraint and not
wording. It was then decided and made in the same pull request: the items are `{"type":
"string", "minLength": 1}`, and the SDL field carries `@parley_minLength(value: 1)`. The test
`the reader validates the released 1.0.0 lines beside the 1.1.0 ones` (RD-110h) asserts that
`stands_for: [""]` is invalid; it was committed failing before the schema changed. Probe P7 after
the change is [captured below](#captured-probe-output). No line the reader writes is affected.

### 8. What was checked and stands

- `stands_for` has exactly `others` entries in every folded section a probe or a test produced
  (P1, P3; RD-110f, RD-110g).
- The 512-byte section bound never drops or shortens it and does not count it: a section of 1,560
  bytes kept its `argv` and `resolved` because it is 385 bytes without the ids (P3; `the ids a
  fold names are outside the section's bound and inside the byte budget`, RD-110g).
- The lens echoes `fold` exactly when the query states it, `true` included (P4; RD-110d).
- A drill-down given `fold` records a `parley.query` 1.1.0 line with no `fold`, and it validates
  (P6).
- Nothing in either description depends on something the reader does not use, apart from the
  findings above.

## Is 1.1.0 the right version under spec §4.5?

§4.5: a minor "**MAY** add optional fields that are safe to ignore. It **MUST** preserve the
meaning and the constraints of every field the previous minor defined." A patch "changes
descriptions only".

**`parley.query`: yes.** One optional field is added. No constraint and no description of a
1.0.0 field differs (the diff has five keys: the two identity keys and `fold`'s two).

**`parley.lens`: yes, with one exception the release must state.** Two optional fields are
added. No constraint of a 1.0.0 field differs. Two descriptions of 1.0.0 fields changed meaning:

- `runs[].folded`. The equivalence is narrower: results, and under some views decisions, are now
  compared. Every statement a 1.0.0 consumer could draw from a section that carries `folded` is
  still true of a 1.1.0 line, because every run that folds under 1.1.0 also meets 1.0.0's
  conditions. What changes is which runs fold, and that is the defect of
  flyingrobots/parley#133 being fixed: 1.0.0 called these runs of "the same result" and the
  reader did not compare results. The absence of `folded` never meant "no run repeated": under
  1.0.0 too a budget could cut a representative, and the released reader compared `resolved`,
  which the 1.0.0 text does not mention.
- `loss.folded`. What the number counts is unchanged, and so is the invariant the field exists
  for: it never depends on the budget, so `excluded − folded` is what the budget cut. What 1.0.0
  also said, and 1.1.0 withdraws, is that it depends on the window alone. A consumer that
  compared `loss.folded` across two views of one window was entitled to equality under 1.0.0 and
  is not under 1.1.0.

That second point is a statement in a released description that is not true of the next minor.
Read strictly, §4.5 does not allow it. This review still recommends 1.1.0, for three reasons. The
value, its constraint and its relation to `excluded` are preserved, and those are what a consumer
computes with. The statement withdrawn follows from fixing a fold that 1.0.0's own words ("the
same result") already ruled out. And a 2.0.0 would tell every reader holding 1.0.0 that it may
rely on no field of a line whose every 1.0.0 field it can still read correctly. The owner may
overrule this and take 2.0.0 for the lens; the query would stay 1.1.0 either way.

`fold` on the lens is "safe to ignore" in the sense §4.5 needs: a consumer that ignores it reads
a `fold: false` lens as one in which nothing happened to fold, and every count in it is still
true.

§4.5 has no rule for a description whose stated invariant weakens while its constraints stand.
This review applied "preserve the meaning" to what the field counts and what a consumer can
compute from it. Whether the spec should say so is outside this issue.

## The compatibility statement the release should make

The statement proposed in the issue is accurate in each clause (probe P7; `the reader validates
the released 1.0.0 lines beside the 1.1.0 ones`, RD-110h). It is corrected in three places: the
lens has the hazard the query has, the version selects the fold rule, and one 1.0.0 statement
does not carry over.

> `parley.query` 1.1.0 and `parley.lens` 1.1.0 add optional fields: `fold` on both, and
> `stands_for` in a lens section's `folded`. They remove no field and narrow no constraint of
> 1.0.0. The released 1.0.0 schemas are unchanged.
>
> **Schemas are selected by the advertised pair and never substituted.** A reader that ships
> both versions validates each line against the pair it advertises, so a line written under
> 1.0.0 is validated against 1.0.0. Full validation of a 1.1.0 line needs the exact 1.1.0
> schema; a reader without it may check the version-independent core and reports the result as
> partial, never as validated (spec §4.5). 1.0.0 is open, so a 1.0.0 query may carry a `fold` of
> any type, and a 1.0.0 lens may carry a `fold` of any type or a `stands_for` of any shape in a
> section's `folded`. 1.1.0 would reject a `fold` that is not a boolean and a `stands_for` that
> is empty, is not an array of strings or holds an empty string. A 1.1.0 schema is therefore not a check of a 1.0.0 line.
>
> **The version also says which fold produced the line.** A 1.0.0 lens was folded without
> comparing results, so its `folded` can stand for a run whose result differed
> (flyingrobots/parley#133). A 1.1.0 lens folds only runs whose result records are equal, and
> under a view that holds decision records, whose decision records are equal too. Fold counts
> from the two versions are not comparable.
>
> **One 1.0.0 statement does not hold of a 1.1.0 line.** 1.0.0 says `loss.folded` depends on the
> window alone. In 1.1.0 it depends on the window, the view and `fold`. It still never depends
> on the budget, and `excluded − folded` is still what the budget cut.
>
> A lens names the runs a fold stands for only in the section of the run that stands for them.
> When the budget leaves that run out, the fold is reported as a count in `loss.folded` and by
> no id.

What a reader without the 1.1.0 schemas reports, captured (probe P7):

```jsonl illustrative
{"probe":"P7.reader_without_1.1.0","has_lens_1_1_0":false,"lens_1_1_0":{"state":"partial","schema":{"id":"parley.lens","version":"1.1.0"},"missing":[]},"query_1_1_0":{"state":"partial","schema":{"id":"parley.query","version":"1.1.0"},"missing":[]}}
```

## What this review could not determine

- Whether any consumer outside this repository holds 1.0.0 lenses and compares `loss.folded`
  across views. Finding 6 is argued from the text alone.
- Whether another reader implementation would define view surfaces as parley-read does. The
  lens's description now names, view by view, which decision records are compared. No schema
  defines what a view's surface holds, so that sentence is the only frozen statement of it.

## Captured probe output

Captured on 2026-11-24 from throwaway scripts run with Bun against
`packages/parley-read/src/index.ts`, first at `04f213c` and again, byte for byte the same, after
the rewording. One P7 line changed when `minLength: 1` was added, and both captures of it are
shown. Run ids are shown by their last digits. Lines are verbatim; rows not cited above
are left out, and nothing else is abridged.

P1, the order of `stands_for`:

```jsonl illustrative
{"probe":"P1.order","latest_t_minus_T0":{"1":550,"2":150,"3":950,"4":150,"5":350,"6":null,"7":950},"sections":[{"run":7,"others":6,"records":18,"stands_for":[3,1,5,4,2,6]}],"loss":{"bound":"count-only","excluded":18,"folded":18}}
{"probe":"P1.random","windows":300,"folded_sections":503,"violations":0}
```

P2, `budget.records` against a window of one older run and five repeats:

```jsonl illustrative
{"probe":"P2.records_budget","budget_records":1000,"window_records":19,"named":7,"runs":[50,5],"folded_sections":[{"run":5,"others":4,"records":12,"stands_for":[4,3,2,1]}],"loss":{"bound":"count-only","excluded":12,"folded":12},"sum_section_folded_records":12}
{"probe":"P2.records_budget","budget_records":5,"window_records":19,"named":5,"runs":[50,5],"folded_sections":[{"run":5,"others":4,"records":12,"stands_for":[4,3,2,1]}],"loss":{"bound":"count-only","excluded":14,"folded":12},"sum_section_folded_records":12}
{"probe":"P2.records_budget","budget_records":4,"window_records":19,"named":4,"runs":[50],"folded_sections":[],"loss":{"bound":"count-only","excluded":15,"folded":12},"sum_section_folded_records":0}
{"probe":"P2.records_budget","budget_records":2,"window_records":19,"named":2,"runs":[50],"folded_sections":[],"loss":{"bound":"count-only","excluded":17,"folded":12},"sum_section_folded_records":0}
```

P3, every `budget.bytes` against a fold of 41 runs:

```jsonl illustrative
{"probe":"P3.unbounded","line_bytes":2537,"named":6,"runs":2,"section_bytes":1560,"section_bytes_without_ids":385,"RUN_SECTION_BYTES":512,"others":40,"stands_for_length":40,"dropped":null,"loss":{"bound":"count-only","excluded":120,"folded":120}}
{"probe":"P3.every_byte_budget","budgets_tried":2587,"declined_fits_false":390,"lines_over_budget":0,"with_folded_section":195,"stands_for_shorter_than_others":0,"folded_counted_but_no_section":2002,"smallest_budget_with_the_section":2393}
{"probe":"P3.shape","bytes_from":391,"bytes_to":587,"named":0,"runs":0,"folded_section":false,"loss":{"bound":"count-only","excluded":126,"folded":120}}
{"probe":"P3.shape","bytes_from":588,"bytes_to":667,"named":1,"runs":1,"folded_section":false,"loss":{"bound":"count-only","excluded":125,"folded":120}}
{"probe":"P3.shape","bytes_from":668,"bytes_to":744,"named":2,"runs":1,"folded_section":false,"loss":{"bound":"count-only","excluded":124,"folded":120}}
{"probe":"P3.shape","bytes_from":745,"bytes_to":2392,"named":3,"runs":1,"folded_section":false,"loss":{"bound":"count-only","excluded":123,"folded":120}}
{"probe":"P3.shape","bytes_from":2393,"bytes_to":2472,"named":4,"runs":2,"folded_section":true,"loss":{"bound":"count-only","excluded":122,"folded":120}}
{"probe":"P3.shape","bytes_from":2473,"bytes_to":2549,"named":5,"runs":2,"folded_section":true,"loss":{"bound":"count-only","excluded":121,"folded":120}}
{"probe":"P3.shape","bytes_from":2550,"bytes_to":2587,"named":6,"runs":2,"folded_section":true,"loss":{"bound":"count-only","excluded":120,"folded":120}}
```

P4, the `fold` flag:

```jsonl illustrative
{"probe":"P4.fold_flag","request":{},"lens_fold":"(absent)","named":3,"runs":[5],"any_folded_section":true,"loss":{"bound":"count-only","excluded":12,"folded":12},"validation":"validated"}
{"probe":"P4.fold_flag","request":{"fold":true},"lens_fold":true,"named":3,"runs":[5],"any_folded_section":true,"loss":{"bound":"count-only","excluded":12,"folded":12},"validation":"validated"}
{"probe":"P4.fold_flag","request":{"fold":false},"lens_fold":false,"named":15,"runs":[1,2,3,4,5],"any_folded_section":false,"loss":{"bound":"none","excluded":0,"folded":0},"validation":"validated"}
{"probe":"P4.fold_flag","request":{"fold":false,"budget":{"records":4}},"lens_fold":false,"named":4,"runs":[1,2],"any_folded_section":false,"loss":{"bound":"count-only","excluded":11,"folded":0},"validation":"validated"}
{"probe":"P4.fold_flag","request":{"fold":false,"budget":{"records":1000,"bytes":900}},"lens_fold":false,"named":3,"runs":[1],"any_folded_section":false,"loss":{"bound":"count-only","excluded":12,"folded":0},"validation":"validated"}
```

P5, whether a pair of runs with one `inv` folds, under each view:

```jsonl illustrative
{"probe":"P5.folds","pair":"equal results","what-ran":true,"what-failed":true,"what-changed":true,"how-it-decided":true,"everything":true}
{"probe":"P5.folds","pair":"results differ","what-ran":false,"what-failed":false,"what-changed":false,"how-it-decided":false,"everything":false}
{"probe":"P5.folds","pair":"same results, other order","what-ran":false,"what-failed":false,"what-changed":false,"how-it-decided":false,"everything":false}
{"probe":"P5.folds","pair":"receipt.step differs","what-ran":true,"what-failed":true,"what-changed":true,"how-it-decided":false,"everything":false}
{"probe":"P5.folds","pair":"cache.hit differs","what-ran":false,"what-failed":true,"what-changed":true,"how-it-decided":false,"everything":false}
{"probe":"P5.folds","pair":"one has an extra receipt.step","what-ran":true,"what-failed":true,"what-changed":true,"how-it-decided":false,"everything":false}
{"probe":"P5.folds","pair":"warning text differs, code equal","what-ran":true,"what-failed":true,"what-changed":true,"how-it-decided":true,"everything":true}
{"probe":"P5.folds","pair":"warning code differs","what-ran":false,"what-failed":false,"what-changed":false,"how-it-decided":false,"everything":false}
{"probe":"P5.folds","pair":"head argv differs","what-ran":true,"what-failed":true,"what-changed":true,"how-it-decided":true,"everything":true}
{"probe":"P5.folds","pair":"head resolved differs","what-ran":false,"what-failed":false,"what-changed":false,"how-it-decided":false,"everything":false}
{"probe":"P5.folds","pair":"receipt.inputs differs (same inv)","what-ran":true,"what-failed":true,"what-changed":true,"how-it-decided":true,"everything":true}
{"probe":"P5.folds","pair":"sidecar path differs, bytes and sha256 equal","what-ran":true,"what-failed":true,"what-changed":true,"how-it-decided":true,"everything":true}
{"probe":"P5.folds","pair":"sidecar sha256 differs","what-ran":false,"what-failed":false,"what-changed":false,"how-it-decided":false,"everything":false}
{"probe":"P5.folds","pair":"a read's lens differs","what-ran":false,"what-failed":false,"what-changed":false,"how-it-decided":false,"everything":false}
{"probe":"P5.folds","pair":"a read's lens equal but for its query pointer","what-ran":true,"what-failed":true,"what-changed":true,"how-it-decided":true,"everything":true}
{"probe":"P5.folds","pair":"unknown protocol-stamped event differs","what-ran":false,"what-failed":false,"what-changed":false,"how-it-decided":false,"everything":false}
{"probe":"P5.folds","pair":"no inv","what-ran":false,"what-failed":false,"what-changed":false,"how-it-decided":false,"everything":false}
{"probe":"P5.folds","pair":"head carries redacted","what-ran":false,"what-failed":false,"what-changed":false,"how-it-decided":false,"everything":false}
{"probe":"P5.folds","pair":"no head in window; end says redacted false; inv from receipt.inputs","what-ran":true,"what-failed":true,"what-changed":true,"how-it-decided":true,"everything":true}
{"probe":"P5.folds","pair":"no head in window; end silent on redacted","what-ran":false,"what-failed":false,"what-changed":false,"how-it-decided":false,"everything":false}
{"probe":"P5.loss_folded_by_view","budget_records":1000,"what-ran":4,"what-failed":8,"what-changed":8,"how-it-decided":0,"everything":0}
{"probe":"P5.loss_folded_by_view","budget_records":3,"what-ran":4,"what-failed":8,"what-changed":8,"how-it-decided":0,"everything":0}
```

P6, opening a folded run at the representative's `seq`, and a drill-down given `fold`:

```jsonl illustrative
{"probe":"P6.query","view":"what-changed","runs":[2],"folded":{"run":2,"others":1,"records":5,"stands_for":[1]},"named":[[2,3,"result"],[2,1,"receipt.head"],[2,2,"receipt.step"],[2,4,"end"]],"loss":{"bound":"count-only","excluded":5,"folded":5}}
{"probe":"P6.open_at_the_representatives_result_seq","asked":[[1,3]],"opened":[["opened",1,3,"receipt.step"]]}
{"probe":"P6.drill_down_fold","refused":false,"query_line_has_fold":false,"query_schema":{"id":"parley.query","version":"1.1.0"},"validation":"validated"}
```

P7, one line validated against each schema. The empty-id line appears twice: first as reviewed,
then after `minLength: 1` was added. "1.0.0 line" is stamped 1.0.0; "restamped" is the
same line stamped 1.1.0, which isolates the field from the version `const`:

```jsonl illustrative
{"probe":"P7.validate","line":"query fold=\"yes\"","1.0.0 line under 1.0.0":"valid","the same 1.0.0 line under 1.1.0":["/fold must be boolean","/_schema/version must be equal to constant"],"restamped 1.1.0 under 1.1.0":["/fold must be boolean"]}
{"probe":"P7.validate","line":"query fold=0","1.0.0 line under 1.0.0":"valid","the same 1.0.0 line under 1.1.0":["/fold must be boolean","/_schema/version must be equal to constant"],"restamped 1.1.0 under 1.1.0":["/fold must be boolean"]}
{"probe":"P7.validate","line":"query fold=null","1.0.0 line under 1.0.0":"valid","the same 1.0.0 line under 1.1.0":["/fold must be boolean","/_schema/version must be equal to constant"],"restamped 1.1.0 under 1.1.0":["/fold must be boolean"]}
{"probe":"P7.validate","line":"query fold={\"a\":1}","1.0.0 line under 1.0.0":"valid","the same 1.0.0 line under 1.1.0":["/fold must be boolean","/_schema/version must be equal to constant"],"restamped 1.1.0 under 1.1.0":["/fold must be boolean"]}
{"probe":"P7.validate","line":"query fold=false","1.0.0 line under 1.0.0":"valid","the same 1.0.0 line under 1.1.0":["/_schema/version must be equal to constant"],"restamped 1.1.0 under 1.1.0":"valid"}
{"probe":"P7.validate","line":"query, no fold","1.0.0 line under 1.0.0":"valid","the same 1.0.0 line under 1.1.0":["/_schema/version must be equal to constant"],"restamped 1.1.0 under 1.1.0":"valid"}
{"probe":"P7.validate","line":"lens fold=\"yes\"","1.0.0 line under 1.0.0":"valid","the same 1.0.0 line under 1.1.0":["/fold must be boolean","/_schema/version must be equal to constant"],"restamped 1.1.0 under 1.1.0":["/fold must be boolean"]}
{"probe":"P7.validate","line":"lens folded.stands_for=[]","1.0.0 line under 1.0.0":"valid","the same 1.0.0 line under 1.1.0":["/runs/0/folded/stands_for must NOT have fewer than 1 items","/_schema/version must be equal to constant"],"restamped 1.1.0 under 1.1.0":["/runs/0/folded/stands_for must NOT have fewer than 1 items"]}
{"probe":"P7.validate","line":"lens folded.stands_for=\"all\"","1.0.0 line under 1.0.0":"valid","the same 1.0.0 line under 1.1.0":["/runs/0/folded/stands_for must be array","/_schema/version must be equal to constant"],"restamped 1.1.0 under 1.1.0":["/runs/0/folded/stands_for must be array"]}
{"probe":"P7.validate","line":"lens folded.stands_for=[7]","1.0.0 line under 1.0.0":"valid","the same 1.0.0 line under 1.1.0":["/runs/0/folded/stands_for/0 must be string","/_schema/version must be equal to constant"],"restamped 1.1.0 under 1.1.0":["/runs/0/folded/stands_for/0 must be string"]}
{"probe":"P7.validate","line":"lens folded.stands_for=[\"\"] (an empty id)","1.0.0 line under 1.0.0":"valid","the same 1.0.0 line under 1.1.0":["/_schema/version must be equal to constant"],"restamped 1.1.0 under 1.1.0":"valid"}
{"probe":"P7.validate","line":"lens folded.stands_for=[\"\"] (an empty id)","1.0.0 line under 1.0.0":"valid","the same 1.0.0 line under 1.1.0":["/runs/0/folded/stands_for/0 must NOT have fewer than 1 characters","/_schema/version must be equal to constant"],"restamped 1.1.0 under 1.1.0":["/runs/0/folded/stands_for/0 must NOT have fewer than 1 characters"]}
{"probe":"P7.validate","line":"lens folded.stands_for longer than others","1.0.0 line under 1.0.0":"valid","the same 1.0.0 line under 1.1.0":["/_schema/version must be equal to constant"],"restamped 1.1.0 under 1.1.0":"valid"}
{"probe":"P7.validate","line":"lens folded without stands_for","1.0.0 line under 1.0.0":"valid","the same 1.0.0 line under 1.1.0":["/_schema/version must be equal to constant"],"restamped 1.1.0 under 1.1.0":"valid"}
{"probe":"P7.reader_with_both","lens_1_0_0_line":"validated","lens_1_0_0_line_with_string_fold":"validated","query_1_0_0_line_with_string_fold":"validated","query_1_1_0_line_with_string_fold":"invalid"}
```
