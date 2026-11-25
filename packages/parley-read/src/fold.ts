// Runs of one invocation with one result are named once (flyingrobots/parley#79).
//
// A test suite runs its program many times in a burst with the same few argument vectors, and in
// the cold resume (`docs/topics/reader/cold-resume.md`) those bursts filled every digest of 20 with
// the same runs: the same three `git.diff_failed` errors, the same pair of warnings from each of
// fifteen runs. The distinct things that happened were few, and a digest could not reach past the
// first burst. A digest therefore **folds** runs that are the same invocation with the same
// result into one representative, and the representative's run section says how many runs it
// stands for and how many of their records the fold left out.
//
// **What "the same" is.** §2.2's `inv` is the run's identity: the same tool and version, the same
// normalised arguments, the same input content. It is not the run's result, and §2.3 is explicit
// that "same `inv`, different result" is a divergence, the thing a reader most needs to see. So
// two runs fold only when their `inv` is equal **and** all of the following are equal too:
//
// - what the run section states: the outcome, the `reason` an undetermined outcome carries, the
//   `end` statuses, the error, warning and startup-failure codes in the order the run emitted
//   them, and the head's `resolved` (flyingrobots/parley#90);
// - **every result record** (flyingrobots/parley#133): the tool's own records, each `page`,
//   each `sidecar`'s `bytes` and `sha256` and a read's own `lens`, in `seq` order, compared as canonical JSON without the
//   envelope's `t`, `seq` and `run`, and a read's own `lens` also without its `session` and the
//   `query` it names. `session` is identity on the protocol lines whose schemas define it (§2.1),
//   and `parley.lens` is the only one of those the fold compares. On a record of the tool's own,
//   a `page` or a decision record, no schema of the protocol defines a top-level `session`
//   (a `sidecar` is compared by `bytes` and `sha256` alone), so one found there is that record's own content, and two results that differ
//   only in it are two results (flyingrobots/parley#146). Until 0.2.0 no result entered the key, so two
//   successful runs of one invocation that answered 1 and 2 were stated as one run twice;
// - **the decision records, under a view that states them**: every `receipt.step` and
//   `cache.hit`, compared the same way, when the view's surface holds them, which is
//   `how-it-decided` and `everything`. Under the other three views two runs that reached one
//   result by different decisions still fold.
//
// A flaky run that failed once and passed once is two results and two sections, never one. The
// key does not hold an error's or a warning's text, only its code, and it does not hold the head's
// `argv`, which may differ between two runs of one `inv`.
//
// **What never folds.**
// - A run with no `inv`. §2.2 makes `inv` SHOULD in v0.2 and omits it when the program cannot
//   make it safe, and a discovery run (§4.1) has none: without it there is no claim of identity to
//   fold by, and argument vectors are not identity.
// - A redacted run: one whose head carries `redacted`, whose `end` says `redacted: true`, or that
//   emitted a `redaction`. §2.3 says a redacted receipt shares its `inv` with every run that
//   differed only in a secret, so equal `inv` does not make it the same invocation as anything.
//   Nor a run the window cannot show is unredacted, because it holds neither its head nor an `end`
//   saying `redacted: false`: a missing statement is not a negative one (§1.2a).
// - A run with a line the loader held back because it holds a number the reader cannot represent
//   (`line.number_unrepresentable`, flyingrobots/parley#159). The run has a record the fold
//   cannot compare, so it is not known to be the same as any other. The loader marks every
//   record of such a run (`runHeldBack`), so the fold knows it from the records it is given; a
//   caller may also name runs in `heldBack`, which covers a run none of whose records were
//   handed over.
// - Anything when the caller states no outcomes: "the same result" cannot be established.
// - Anything when the read states `fold: false` (`digestFor` then does not call this module).
//
// **The representative is the most recent run of its group**: the one whose latest dated record
// in the window is latest, ties broken by the greater run id. The most recent run is the one a
// resuming reader is likeliest to act on, and its head is the current statement of the invocation.
//
// **The fold is part of how the digest is built, not a view** and not a ranking. The ranking still
// orders every record of the window and drops none of them; the fold removes the records of
// folded-away runs from what the digest may name, keeping the ranking's order, and the digest's
// bound cuts the tail of what remains. Every record the fold removed is still counted in
// `loss.excluded`, and `loss.folded` says how many of those the fold, rather than the budget, left
// out, so the two kinds of loss are told apart structurally. The fold depends on the window, its
// outcomes and the view, never on the budget, so the same window folds the same way under any
// budget.
//
// **A fold names what it stands for** (flyingrobots/parley#133): `stands_for` lists the other
// runs' ids, most recent first, so a reader can open their records by `(run, seq)` instead of
// taking the count on trust.
import { exactJson } from "@flyingrobots/parley-emit";
import type { LoadedRecord } from "./load.ts";
import type { View } from "./query.ts";
import { PROTOCOL_EVENTS, onViewSurface, toolOwned, type Outcome } from "./rank.ts";

/** What a representative's run section says it stands for. */
export interface RunFold {
  /**
   * How many other runs the representative stands for, itself excluded (flyingrobots/parley#100):
   * the section reads as "this run, plus `others` like it". Always at least 1.
   */
  readonly others: number;
  /** How many records of those other runs, in the window, the fold left out of the digest. */
  readonly records: number;
  /**
   * The ids of those other runs, most recent first by the rule that picks the representative:
   * the later latest dated record, ties to the greater run id. As long as `others`. Named as the
   * lens carries it (`parley.lens` 1.1.0), so the fold is the wire shape.
   */
  readonly stands_for: readonly string[];
}

export interface Folding {
  /** The ranked records with every folded-away run's records removed, in the ranking's order. */
  readonly records: readonly LoadedRecord[];
  /** Each representative's fold, by its run id. A run that stands only for itself has none. */
  readonly folds: ReadonlyMap<string, RunFold>;
  /** How many records of the window the fold left out: the sum of every fold's `records`. */
  readonly folded: number;
}

/** The events whose codes are part of a run's result. */
const CODED: ReadonlySet<string> = new Set(["error", "warning", "startup.failed"]);

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/**
 * The envelope fields (§1.3) that differ between any two runs and are no part of what a record
 * says. `session` is not one of them: the writers refuse none of a tool's payload under that
 * name, so on a tool's own record a top-level `session` is content the fold must compare
 * (flyingrobots/parley#146).
 */
const ENVELOPE_ONLY: ReadonlySet<string> = new Set(["t", "seq", "run"]);

/**
 * What a read's own `lens` carries that is the read's identity and not its result: the `query`
 * it names by that read's `(run, seq)`, and the `session` `parley.lens` defines (§2.1), so two
 * reads made in different working periods can still fold. Of the protocol's messages that define
 * a top-level `session` (`parley.run.bootstrap`, `parley.receipt.head`, `parley.query`,
 * `parley.lens`), the lens is the only one the fold compares.
 */
const LENS_IDENTITY: ReadonlySet<string> = new Set(["query", "session"]);

/** The decision records: the ones `how-it-decided` is an answer about (`rank.ts`). */
const DECISIONS = ["receipt.step", "cache.hit"] as const;

/**
 * Whether a record carries a run's result: a record of the tool's own (§7), a `page` of its output
 * (§7.2), a `sidecar` standing in for one (§5), or the `lens` a read answered with (§9), which is
 * what a read produces. A record with no event token, or one the protocol does not define, counts
 * too, whatever pair it advertises, so nothing the reader cannot attribute is left out of the
 * comparison.
 */
function isResult(record: LoadedRecord): boolean {
  if (record.event === "page" || record.event === "sidecar" || record.event === "lens") return true;
  return toolOwned(record) || record.event === null || !PROTOCOL_EVENTS.has(record.event);
}

/** A record as the fold compares it: its payload with canonical key order and no envelope. */
function payload(record: LoadedRecord): unknown {
  // A sidecar's stored bytes are the result; its `path` and `source` are where it was put.
  if (record.event === "sidecar") return canonical({ event: "sidecar", bytes: record.record.bytes, sha256: record.record.sha256 });
  // A read's own lens, not a record of the tool's that happens to carry that event name: the
  // tool's record is compared whole.
  const lens = record.event === "lens" && !toolOwned(record);
  const skip = (k: string) => ENVELOPE_ONLY.has(k) || (lens && LENS_IDENTITY.has(k));
  return canonical(Object.fromEntries(Object.entries(record.record).filter(([k]) => !skip(k))));
}

/**
 * The key two runs must share to fold, or null when the run never folds. It is the run's `inv`
 * (the head's, or else `receipt.inputs`'s, as the run section reads it), what the run section
 * states about its result, every result record, and, when `view` is one whose surface holds the
 * decision records, every decision record. With no `view`, decisions are not compared.
 */
function foldKey(own: readonly LoadedRecord[], outcome: Outcome | undefined, view: View | undefined): string | null {
  if (outcome === undefined) return null;
  const head = own.find((r) => r.event === "receipt.head");
  const inputs = own.find((r) => r.event === "receipt.inputs" && nonEmpty(r.record.inv));
  const inv = nonEmpty(head?.record.inv) ? head.record.inv : inputs?.record.inv;
  if (!nonEmpty(inv)) return null;
  const ends = own.filter((r) => r.event === "end");
  const redacted = (head !== undefined && head.record.redacted !== undefined)
    || ends.some((r) => r.record.redacted === true)
    || own.some((r) => r.event === "redaction");
  if (redacted) return null;
  // Not redacted only on evidence: the head says so by carrying no `redacted`, or an `end` says
  // `redacted: false`. A window holding neither cannot tell (§1.2a), so the run does not fold.
  if (head === undefined && !ends.some((r) => r.record.redacted === false)) return null;
  // The same rule the run section states its reason by: an undetermined run with an `end` has an
  // unusable status, one without has no end in the window.
  const reason = outcome !== "undetermined" ? null : ends.length > 0 ? "end_status_unusable" : "no_end_in_window";
  const codes = own
    .filter((r) => r.event !== null && CODED.has(r.event))
    .sort((a, b) => a.seq - b.seq)
    .map((r) => [r.event, typeof r.record.code === "string" ? r.record.code : null]);
  // The head's `resolved` too, since a section states it (flyingrobots/parley#90): §2.2 keeps the
  // working directory and the like out of `inv`, so one `inv` can carry two interpretations, and
  // a fold must not state one run's for another. Keys are sorted so key order is not a difference.
  const inSeq = [...own].sort((a, b) => a.seq - b.seq);
  // Every result, so "same `inv`, different result" (§2.3) is never one run (flyingrobots/parley#133).
  const results = inSeq.filter(isResult).map(payload);
  // The view decides whether decisions are part of what the answer states: a kind of record on
  // the view's surface is one the reader asked about.
  const decisions = view === undefined
    ? []
    : inSeq.filter((r) => (DECISIONS as readonly string[]).includes(r.event ?? "") && onViewSurface(view, r)).map(payload);
  // `exactJson`, so an integer beyond the safe range is compared by its digits (flyingrobots/parley#159).
  return exactJson([inv, outcome, reason, ends.map((r) => r.record.status ?? null), codes, canonical(head?.record.resolved), results, decisions]);
}

/** A JSON value with every object's keys sorted, so two equal values serialise alike. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value ?? null;
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])]));
}

/** The latest dated record's `t`, or -1 when the run has none dated. */
function latest(own: readonly LoadedRecord[]): number {
  let t = -1;
  for (const r of own) if (typeof r.t === "number" && r.t > t) t = r.t;
  return t;
}

/**
 * Fold the runs of a ranked window that are one invocation with one result. Pure: it reads,
 * writes and mutates nothing. `ranked` is the whole window in rank order and `outcomes` the
 * ranking's verdict per run over it; without `outcomes` nothing folds. `view` is the view the
 * answer is for: under one whose surface holds the decision records, runs must agree on those
 * too. Without it only results are compared. `heldBack` names runs that never fold: the ones the
 * loader held a line back from (`heldBackRuns`).
 */
export function foldRuns(ranked: readonly LoadedRecord[], outcomes?: Readonly<Record<string, Outcome>>, view?: View, heldBack?: ReadonlySet<string>): Folding {
  const none: Folding = { records: ranked, folds: new Map(), folded: 0 };
  if (outcomes === undefined) return none;

  const byRun = new Map<string, LoadedRecord[]>();
  for (const record of ranked) {
    const own = byRun.get(record.run);
    if (own === undefined) byRun.set(record.run, [record]);
    else own.push(record);
  }

  const groups = new Map<string, string[]>();
  for (const [run, own] of byRun) {
    if (heldBack?.has(run) === true || own.some((r) => r.runHeldBack === true)) continue;
    const key = foldKey(own, outcomes[run], view);
    if (key === null) continue;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [run]);
    else group.push(run);
  }

  const away = new Set<string>();
  const folds = new Map<string, RunFold>();
  let folded = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // Most recent first: the later latest dated record, ties to the greater run id. The first is
    // the representative and the rest are what it stands for, in that order.
    const at = new Map(group.map((run) => [run, latest(byRun.get(run)!)]));
    const order = [...group].sort((a, b) => (at.get(b)! - at.get(a)!) || (a < b ? 1 : a > b ? -1 : 0));
    const [best, ...rest] = order as [string, ...string[]];
    let records = 0;
    for (const run of rest) {
      away.add(run);
      records += byRun.get(run)!.length;
    }
    folds.set(best, { others: rest.length, records, stands_for: rest });
    folded += records;
  }
  if (away.size === 0) return none;
  return { records: ranked.filter((r) => !away.has(r.run)), folds, folded };
}
