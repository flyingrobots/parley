# Observer geometry and spec §9

What [§9 of the specification](../../../spec/parley-vous-v0.3.md) takes from the observer-geometry
treatment it cites, and where it departs from it. This page is a reference: it does not change the
spec, and the revised §9 wording below is a **proposal**, because a spec change carries its own
version.

§9 was written from a one-line description of the treatment. This page is the result of reading the
treatment ([flyingrobots/parley#45](https://github.com/flyingrobots/parley/issues/45)) so that the
representation decision ([flyingrobots/parley#46](https://github.com/flyingrobots/parley/issues/46))
and the reader tasks under
[flyingrobots/parley#2](https://github.com/flyingrobots/parley/issues/2) can cite a source rather
than a sketch.

## The source, and how it is cited

**WARP Graphs: Rulial Distance & Observer Geometry.** James Ross, AIΩN Foundations Series Paper IV,
December 2025. DOI [10.5281/zenodo.18038297](https://doi.org/10.5281/zenodo.18038297). Licensed
CC BY 4.0.

Citations below are to the manuscript's own section numbers and to its numbered environments
(`Definition 3.1`, `Remark 6.10`, and so on), read from the LaTeX manuscript. Quoted phrases are
verbatim from it; everything unquoted is this page's reading, not the treatment's words. Nothing
here certifies the treatment's results — it is used as a source of design constraints, not as a
proof obligation parley inherits.

Paper IV builds on three earlier papers in the same series. Those were not read for this page, so
every claim traced to Papers I–III is left where the treatment puts it and is not relied on.

## What the treatment actually says

Six results carry the whole comparison.

**An observer is a view, not a viewer.** §3.2, `Definition 3.1`: an observer is a functor from a
history category into a trace space — operationally, "an algorithm that maps any derivation path
`h` to a trace value `O(h)`". It is the *shape of the answer*, not the identity of whoever wants
it. §3.3 gives a small taxonomy of such views induced by holography: *boundary* observers
(the compact artefact only), *bulk* observers (interior states, matches, receipts, causal cones)
and *semantic* observers, "that collapse syntactic evolution into invariant properties". §3.4 adds
four worked projections of a single artefact: coarse stages, semantic effects, adversarial or
counterfactual branches, and every microstep.

**A view without a budget is not a view.** §3.2, `Definition 3.2`, defines a `(τ, m)`-bounded
observer, and `Remark 3.3` says why the bound is constitutive rather than a refinement: without
explicit budgets "all observers collapse into an uninformative equivalence: ``compute the full
worldline and output it''".

**Distance between views is translation cost, and it is directed.** §4 and §5.1 define the cost of
going from one view to another as translator description length plus residual distortion
(`Definition 5.1`), with the symmetrised distance as the sum of both directions
(`Definition 5.2`). §5.5 keeps the directed form as the primary object: `Definition 5.10` takes
`+∞` when no admissible translator exists, and `Example 5.13` is the asymmetry in one line — the
forgetful projection from a bulk view down to a boundary view is `O(1)` and lossless, while the
reverse direction "can be `+∞` under strict budgets". §5.6, titled "Budget effects: replay is
short but not fast", proves it: `Proposition 5.14` has the replay translator at `O(1)` description
length and `+∞` directed cost once the payload outruns the time budget. Appendix A works the same
pair numerically on a three-tick worldline.

**Costs compose, additively.** §5.5, `Proposition 5.11`: directed cost satisfies the triangle
inequality up to a fixed prefix-coding constant, and §5.4 `Remark 5.8` records that this makes the
symmetrised distance a quasi-pseudometric rather than a metric. §5.3, `Proposition 5.6`: relaxing
a budget can only lower the distance.

**Whether a summary can answer a question is a distortion question, not a count.** §6.4,
`Proposition 6.9`, is the sharpest result for parley: if every predicate under test is
`δ`-robust in trace space and the translation's residual distortion is at most `δ`, then temporal
truth transports exactly between views. `Remark 6.10` states the converse case directly: "if an
observer suppresses events relevant to a predicate (for example by strong summarisation), then
either the predicate is not `δ`-robust under the chosen trace metric or the translation distortion
exceeds `δ`". The same remark notes that `δ`-robustness is strict for "hashes, exact logs,
serialisations", where "a tiny change in representation can flip an atomic predicate", and that
practice recovers it by canonicalising or coarse-graining before evaluating a predicate.

**There is no privileged view, and the distance is not a truth claim.** §6.5: "rulial distance is
not a semantic truth predicate; it is a geometry induced by translation constraints", likened to
choosing a coordinate chart, where an ill-conditioned chart makes simple structure look complex.
`Remark 6.11` introduces balls of views reachable within a fixed cost, as a way of talking about
nearby frames "without privileging a single canonical observer". §6.6 draws the engineering
consequence: if a compliance view is far from a diagnostic view under deployment budgets, then
emitting only compliance traces "is not a neutral optimisation --- it is a choice that can make
subsequent diagnosis prohibitively expensive or impossible".

Two scope limits the treatment sets on itself, which this page honours. §6.6, under
*Computability*, says the distance is "a useful specification but not something we claim to compute
exactly in a deployed system"; the recommended practice is to build an explicit translator and use
its measured description length and distortion as a computable **upper bound**. And §1, under
*Scope management*, declines to axiomatise a canonical trace metric at all. So nothing below asks
parley to compute a distance. What parley inherits is the shape of the question and the list of
things a result has to say about itself.

## §9 bullet by bullet

§9's bullets are labelled here §9.1–§9.5 for the five intended rules in source order, and §9.F1
and §9.F2 for the two failure modes. Nothing is dropped; five of the seven change.

| Bullet | Verdict | Why |
| --- | --- | --- |
| §9.1 "A query declares its **observer** (who is asking) and its **purpose** (why)" | **changed** | The treatment's observer is the view, not the asker (§3.2, `Definition 3.1`), and it is incomplete without a budget (`Definition 3.2`, `Remark 3.3`). §9 uses the treatment's central term for a different thing, which will mislead anyone who reads both. Three fields, not two: the asker, the view, the budget. |
| §9.2 "The purpose **shapes the result** … Without a declared purpose, relevance is a guess" | **changed** | The claim survives; the mechanism does not. In the treatment a purpose names a *target view* and the answer is a translation into it at a stated cost and distortion (§5.1), not a relevance ordering over one fixed view. The last clause is also right for a different reason: §6.5 and `Remark 6.11` say there is no privileged view to fall back on, which is stronger than relevance being hard to guess. |
| §9.3 "A query is recorded as an event. The store then learns which questions are actually asked" | **kept** | Unchanged — but the treatment neither supports nor grounds it. Its observers are pure functors; observing leaves no mark on a history. This bullet follows from parley's own §3 and §5: a query is a run, and a run writes a receipt. The treatment's nearest statement, that replay "becomes an ethically significant act, not a neutral debugging primitive", is in §8 as a forward reference to Paper V, not a result of Paper IV. §9's own title therefore rests on a paper it does not cite. |
| §9.4 "A result carries its own lens — the observer, the purpose and the window" | **changed** | Right instinct, short list. The budget is constitutive (`Remark 3.3`), so a lens without it does not identify the view that produced the result, and `Proposition 5.6` means two results computed under different budgets are not comparable. The lens also needs a stated bound on what the view loses, by `Proposition 6.9`: that bound is what tells a later reader which questions the result can still answer. |
| §9.5 "A result reports what it excluded, at least as a count" | **changed** | The count stays, demoted to a proxy, with its weakness stated. The treatment's instrument is distortion, and `Definition 4.10` lifts it as a **supremum** over histories — worst case, not average. A cardinality cannot bound a worst case even in principle: one dropped record can matter more than fifty. `Proposition 6.9` ties trust to a distortion bound, and §6.6 gives the practical form, a measured upper bound from a concrete translator. |
| §9.F1 "**Ceremony.** … It should be mostly inferable from context" | **kept** | The risk is real and the treatment adds a cheaper remedy than inference: §3.3 and §3.4 show that useful views come in a handful of recognisable families, so declaring one costs a single token from a closed set. Worth noting that §9.F1 and [#2](https://github.com/flyingrobots/parley/issues/2)'s "refused, not silently defaulted" pull against each other; the closed vocabulary is how both hold. |
| §9.F2 "**Over-filtering.** … This is why the excluded count is required" | **changed** | The failure mode is confirmed, almost in these terms, by `Remark 6.10`. The stated remedy is wrong: by that same remark, suppression of predicate-relevant events shows up as distortion exceeding `δ`, not as a count. The remedy moves to §9.5's loss bound. |

Kept: 2. Changed: 5. Dropped: 0.

## What the treatment has that §9 omits

Four things, each with a direct consequence for the reader.

**Direction.** `Example 5.13` and `Proposition 5.14`: projecting down is `O(1)`, expanding back up
can be `+∞` under a finite budget. Summarising is cheap and irreversible within a budget. A digest
that does not carry the way back to the records it was built from is a one-way loss, so
retrieval by `(run, seq)` is not a convenience feature — it is the only admissible direction, and
the path has to be *stored* rather than recomputed.

**`+∞` as a legitimate answer.** `Definition 5.10` takes the value `+∞` when no admissible
translator exists within the budget. §9 has no notion of declining to answer on budget grounds. A
reader should be able to say "not within your budget, and here is the budget that would do it"
instead of silently returning a worse view.

**Composition cost.** `Proposition 5.11`: cost and distortion add along a chain. Digesting a
digest is not free; it takes the second step's loss on top of the first's. A result should be
built from records, never from another result.

**Origin is not quotiented.** §6.2, `Remark 6.3`, keeps histories distinct when they arise from
different causal origins even if they are identical as data, in deliberate contrast to a merging
view that "thereby erases origin information". parley already does the right thing — §1.3
deduplicates by `(run, seq)`, which is origin-preserving — and the treatment supplies the reason
not to add content-digest deduplication across runs later.

## What parley should not take

The treatment's three-layer time model (§6.3) distinguishes *Chronos*, the committed linear order
on one worldline; *Kairos*, the loci where alternative continuations exist; and *Aion*, the
possibility space of all derivations. The branch machinery built on it — the `A`/`E` path
quantifiers of §6.4, `Example 6.8`'s claim that every continuation eventually reconciles — ranges
over alternatives that were never taken.

parley's receipts record what did happen: one committed sequence per run, no alternative
continuations. A query over them is a Chronos query, and there is no Kairos or Aion layer to
quantify over. Importing the branch vocabulary would add terms with nothing underneath them.

Likewise, the treatment's `λ` weighting, the choice of trace metric (§1 declines to fix one), and
the Lawvere-enrichment apparatus of §5.5 are mathematical structure that a reader over receipt
files has no use for. What transfers is the asymmetry those tools describe, not the tools.

## Proposed revision of §9

**This is a proposal, not the specification.** The spec on `main` is unchanged; adopting any of
this is a versioned spec change. It replaces §9's bullet list and its two failure modes, keeps the
section informative, and keeps the preamble's two sentences.

> A read against the stream is not a passive lookup. It is itself an event, and it is
> task-oriented. The intended rules:
>
> - A query declares the **view** it wants — the shape of the answer, drawn from a short closed
>   set — together with a **budget**, the size of answer it will accept. A view without a budget
>   is not a view: with no bound, every view collapses into "return every record".
> - A query declares its **asker**: the identity the query is recorded under, and the context the
>   view and budget can be inferred from. The asker is not the view. Two askers requesting the
>   same view under the same budget get the same answer.
> - The view **shapes the result**. "I am about to change this program's audit path" names a view
>   over that surface, and the result is that view, not the last fifty records in chronological
>   order. There is no privileged view to fall back on when none is declared.
> - A query is recorded as an event. The store then learns which questions are actually asked,
>   which is the signal for what to index and roll up.
> - A result carries its own lens — the view, the asker, the budget and the window that produced
>   it — and a stated bound on what the view loses against the records it was built from, so a
>   later reader knows which questions the result can still answer and cannot mistake a digest for
>   the whole.
> - A result names the records it was built from, by `(run, seq)`, and is built from records
>   rather than from another result. Summarising is cheap; recovering a record from a summary is
>   not, and may be impossible within the caller's budget. Each further summarising step adds its
>   own loss to the loss already taken.
> - A result that cannot be produced within the declared budget says so, and says what budget
>   would suffice. "Not within your budget" is an answer, not a failure.
>
> Two failure modes to design against:
>
> - **Ceremony.** If declaring a view and a budget is expensive, callers will skip them or write
>   noise. Both should be one token from a closed set, defaulted from the asker's context — tool,
>   working directory, current task id — with free text optional. A missing view is refused rather
>   than guessed, because a guess is a view the caller cannot see in the lens.
> - **Over-filtering.** A view-shaped result can hide the very thing the caller needed because
>   they did not know to ask for it. The loss bound is what guards against this; an excluded count
>   is its cheapest proxy and a weak one, because one withheld record can matter more than fifty.

A sketch of the lens this implies, for the representation decision rather than as a schema — no
schema id is assigned until
[flyingrobots/parley#46](https://github.com/flyingrobots/parley/issues/46) decides one:

```json illustrative
{
  "asker": "claude-code",
  "view": "what-failed",
  "budget": {"records": 20},
  "window": {"from": 1795240012399, "to": 1795326412399},
  "loss": {"excluded": 184, "bound": "count-only"},
  "records": [{"run": "01JD3KQ8Z6V9X2M4N7P1R3T5W8", "seq": 14}]
}
```

## Consequences for the reader tasks

| Task | What changes |
| --- | --- |
| [#46](https://github.com/flyingrobots/parley/issues/46) representation | Decide **three** fields, not two: asker, view, budget. Reserve "observer" for the view or drop the word; §9's current use of it for the asker collides with the source it cites. The view's vocabulary should be a closed set, after §3.3 and §3.4. |
| [#47](https://github.com/flyingrobots/parley/issues/47) loader | No change required; `(run, seq)` deduplication is already origin-preserving, and `Remark 6.3` is the reason not to add content-digest deduplication across runs. |
| [#48](https://github.com/flyingrobots/parley/issues/48) query and refusal | Refusing rather than defaulting is confirmed by `Remark 6.11`. Add a second refusal case: a view that cannot be produced within the declared budget, answered with the budget that would suffice. That case landed in [#71](https://github.com/flyingrobots/parley/issues/71) as a **decline** rather than a refusal: a verdict about a budget is about real history, which a pure, pre-load refusal cannot see, so a declined read is a recorded run that ends with a `query.over_budget` error naming the budget given, what was measured and the budget that would suffice ([parley-read](../parley-read/README.md#when-a-read-declines)). |
| [#49](https://github.com/flyingrobots/parley/issues/49) ranking | Ranking survives as an approximation of filling a declared view, not as the mechanism itself. Rank over records, never over an already-digested result (`Proposition 5.11`). |
| [#50](https://github.com/flyingrobots/parley/issues/50) digest | The lens needs the budget as well as observer, purpose and window. The excluded count ships, labelled as a proxy, because `Definition 4.10`'s worst-case lifting means a count cannot bound what a digest loses. |
| [#51](https://github.com/flyingrobots/parley/issues/51) drill-down | Reclassify from convenience to requirement. `Example 5.13` and `Proposition 5.14` make digest-to-record the only direction that is cheap under a budget, so the path back has to be stored in the digest. |
