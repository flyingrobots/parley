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
// two runs fold only when their `inv` is equal **and** every summary a lens would state about the
// run is equal too: the outcome, the `reason` an undetermined outcome carries, the `end` status,
// the error, warning and startup-failure codes in the order the run emitted them, and the head's
// `resolved`, which the section carries (flyingrobots/parley#90). A flaky run
// that failed once and passed once is two results and two sections, never one.
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
// - Anything when the caller states no outcomes: "the same result" cannot be established.
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
// out, so the two kinds of loss are told apart structurally. The fold depends on the window and the
// outcomes alone, never on the budget, so the same window folds the same way under any budget.
import type { LoadedRecord } from "./load.ts";
import type { Outcome } from "./rank.ts";

/** What a representative's run section says it stands for. */
export interface RunFold {
  /**
   * How many other runs the representative stands for, itself excluded (flyingrobots/parley#100):
   * the section reads as "this run, plus `others` like it". Always at least 1.
   */
  readonly others: number;
  /** How many records of those other runs, in the window, the fold left out of the digest. */
  readonly records: number;
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
 * The key two runs must share to fold, or null when the run never folds. It is the run's `inv`
 * (the head's, or else `receipt.inputs`'s, as the run section reads it) and its whole result as a
 * lens would state it.
 */
function foldKey(own: readonly LoadedRecord[], outcome: Outcome | undefined): string | null {
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
  return JSON.stringify([inv, outcome, reason, ends.map((r) => r.record.status ?? null), codes, canonical(head?.record.resolved)]);
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
 * ranking's verdict per run over it; without `outcomes` nothing folds.
 */
export function foldRuns(ranked: readonly LoadedRecord[], outcomes?: Readonly<Record<string, Outcome>>): Folding {
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
    const key = foldKey(own, outcomes[run]);
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
    let best = group[0]!;
    let bestT = latest(byRun.get(best)!);
    for (const run of group.slice(1)) {
      const t = latest(byRun.get(run)!);
      if (t > bestT || (t === bestT && run > best)) {
        best = run;
        bestT = t;
      }
    }
    let records = 0;
    for (const run of group) {
      if (run === best) continue;
      away.add(run);
      records += byRun.get(run)!.length;
    }
    folds.set(best, { others: group.length - 1, records });
    folded += records;
  }
  if (away.size === 0) return none;
  return { records: ranked.filter((r) => !away.has(r.run)), folds, folded };
}
