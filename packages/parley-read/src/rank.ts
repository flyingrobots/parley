// The purpose orders the answer (spec §9, informative; flyingrobots/parley#49).
//
// §9 says the purpose *shapes* the result: "I am about to change this program's audit path"
// should return records touching that surface, not the last fifty things in chronological order.
// It is the ranking function, not a filter applied afterwards, and this module is only the
// ranking function: it reorders the records it is given and returns every one of them. Over-
// filtering is the failure mode §9 names, so nothing here can drop a record even in principle.
// The budget, the truncation and the excluded count are the digest's (flyingrobots/parley#50,
// `digest.ts`), which cuts the tail of the order this module produced and says how long that tail
// was — a cut above a total order can state its loss, and a cut inside one cannot.
//
// What the purpose is as data was decided in flyingrobots/parley#46: a read states a `view`, one
// token from a closed set of five, and `docs/topics/reader/README.md` says what each one is an
// answer to. Those five definitions are the whole source of the rules below. Nothing here reads a
// field `parley.query` does not have, and no schema moves.
//
// The order is one total order on a key per record, compared left to right:
//
//   1. **the failure surface of the runs that failed, when the view implies a change.** A read
//      made in order to change something is a read made in order not to repeat a failure, so what
//      failed goes first. A `warning` from a run the records do not establish as failed is not a
//      failure (§6.1): it is placed by the view's own surface rule like any other record, so a
//      history of runs that warned and went on cannot crowd the view's own surface out of a digest
//      (flyingrobots/parley#76).
//   2. **the view's own surface.** The records the view is an answer about, above the records it
//      is not. This is §9's sentence, and for the identity view every record is on the surface, so
//      the tier is empty of consequence.
//   3. **`(t, run, seq)` ascending.** The order a read already answers in, so a view whose surface
//      no record touches leaves the answer exactly as it was.
//
// A record's tier is a property of the record and, for the failure tier only, of its run's outcome.
// A record's outcome is a property of its run, and it is established from the records being ranked rather than from the whole history: a window that
// does not hold a run's `end` leaves that run `undetermined`, which §1.2a asks for — a reader must
// not take one kind of evidence for another, and "no `end` in this window" is not "it succeeded".
import type { LoadedRecord } from "./load.ts";
import type { AcceptedQuery, View } from "./query.ts";
import { PROTOCOL_PREFIX } from "./validate.ts";

/**
 * The three tiers, best first. A tier is a property of the record, except that the `failure` tier
 * holds a failure-surface record only when its run failed: an `error`, a `startup.failed` and a
 * non-zero `end` make their run a failed one, so that condition binds only a `warning`.
 */
export const TIERS = ["failure", "surface", "other"] as const;
export type Tier = (typeof TIERS)[number];

/**
 * What the records being ranked establish about a run's outcome, best-known-worst first: a run
 * that failed is nearer what a change purpose needs than a run whose fate is unknown, which is
 * nearer than a run known to have succeeded.
 */
export const OUTCOMES = ["failed", "undetermined", "succeeded"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/**
 * The views that imply a change, derived from the vocabulary rather than from a field.
 *
 * `parley.query` 1.0.0 carries no field saying "this purpose implies a change", and inventing one
 * would be this library extending a decided message. It does not need one: of the five tokens,
 * exactly one is an answer about a change — `what-changed`, "subject-matter writes, and the inputs
 * they consumed" — and it is the view §9's own example asks for. `what-ran`, `how-it-decided` and
 * `everything` describe history without proposing to change it. `what-failed` is left out
 * deliberately: failure is already that view's whole surface, so promoting it would restate the
 * surface rather than order the answer.
 *
 * Adding a token to the vocabulary moves `parley.query` and `parley.lens` (flyingrobots/parley#46)
 * and must decide the new token's surface and whether it implies a change.
 */
export const CHANGE_VIEWS: ReadonlySet<View> = new Set<View>(["what-changed"]);

/** True when the view is an answer about a change, so the failed runs' failures rank above everything else. */
export function impliesChange(view: View): boolean {
  return CHANGE_VIEWS.has(view);
}

/** The event tokens the protocol itself defines (§1.3 through §9). Anything else is a tool's own. */
export const PROTOCOL_EVENTS: ReadonlySet<string> = new Set([
  "run", "receipt.head", "command", "schema", "receipt.inputs", "receipt.step",
  "warning", "error", "cache.hit", "sidecar", "page", "redaction", "end",
  "startup.failed", "query", "lens",
]);

/** The records §9's `what-failed` is an answer about: the errors, the warnings, and the ends that did not succeed. */
const FAILURE_EVENTS: ReadonlySet<string> = new Set(["error", "startup.failed", "warning"]);

/** The records that identify a run and its outcome: `what-ran`'s "tool, version, status, time". */
const RAN_EVENTS: ReadonlySet<string> = new Set(["run", "receipt.head", "cache.hit", "end", "startup.failed"]);

/** The records that carry a decision and its reason: §5's `receipt.step`, and the decision not to run at all. */
const DECIDED_EVENTS: ReadonlySet<string> = new Set(["receipt.step", "cache.hit"]);

function schemaId(record: LoadedRecord): string | null {
  const stamp = record.record._schema as { id?: unknown } | undefined;
  return stamp !== undefined && typeof stamp.id === "string" ? stamp.id : null;
}

/**
 * A record of the tool's own rather than of the protocol: §7's results, which are the subject
 * matter a command exists to produce. A line that advertises no pair at all and carries no
 * protocol event token is the tool's too — the reader cannot attribute it to the protocol, and
 * §4.6 says a line whose id is not ours is passed through rather than reinterpreted.
 */
export function toolOwned(record: LoadedRecord): boolean {
  const id = schemaId(record);
  if (id !== null) return !id.startsWith(PROTOCOL_PREFIX);
  return record.event === null || !PROTOCOL_EVENTS.has(record.event);
}

/** A `receipt.head` or `command` that declares a subject-matter write (§4.3): what the command exists to change. */
function declaresWrite(record: LoadedRecord): boolean {
  const effects = record.record.effects;
  if (effects === null || typeof effects !== "object" || Array.isArray(effects)) return false;
  const writes = (effects as { writes?: unknown }).writes;
  return Array.isArray(writes) && writes.length > 0;
}

/** `end` with a status that is a number other than zero: a run that did not succeed (§3.3, §3.4). */
function endedBadly(record: LoadedRecord): boolean {
  return record.event === "end" && typeof record.record.status === "number" && record.record.status !== 0;
}

/**
 * On the failure surface: an error, a startup failure, a warning, or an `end` that did not succeed.
 * This is `what-failed`'s surface, which a warning is on. It is not, on its own, the change-view
 * promotion: `rankRecords` promotes a failure-surface record only when its run failed.
 */
export function onFailureSurface(record: LoadedRecord): boolean {
  if (record.event !== null && FAILURE_EVENTS.has(record.event)) return true;
  return endedBadly(record);
}

/**
 * Whether a record is on a view's surface, one view at a time, from the vocabulary's own
 * definition of each token. `everything` is the identity, so every record is on its surface.
 */
export function onViewSurface(view: View, record: LoadedRecord): boolean {
  switch (view) {
    case "everything":
      return true;
    case "what-ran":
      return record.event !== null && RAN_EVENTS.has(record.event);
    case "what-failed":
      return onFailureSurface(record);
    case "how-it-decided":
      return record.event !== null && DECIDED_EVENTS.has(record.event);
    case "what-changed":
      if (toolOwned(record)) return true;
      if (record.event === "sidecar") return true;
      if (record.event === "receipt.inputs") return true;
      if (record.event === "receipt.head" || record.event === "command") return declaresWrite(record);
      return false;
  }
}

/**
 * What the given records establish about each run's outcome. A run that emitted an `error` or a
 * `startup.failed`, or whose `end` carries a non-zero status, failed. A run with an `end` of zero
 * and nothing against it succeeded. Anything else — including a run whose `end` the window does
 * not hold — is `undetermined`, because a missing `end` is not a successful one (§1.2a, §5.4). A
 * `warning` is not a failed run: §6.1 makes it a warning precisely because the run went on.
 */
export function runOutcomes(records: readonly LoadedRecord[]): Readonly<Record<string, Outcome>> {
  const failed = new Set<string>();
  const succeeded = new Set<string>();
  const seen = new Set<string>();
  for (const record of records) {
    seen.add(record.run);
    if (record.event === "error" || record.event === "startup.failed" || endedBadly(record)) {
      failed.add(record.run);
      continue;
    }
    if (record.event === "end" && record.record.status === 0) succeeded.add(record.run);
  }
  const outcomes: Record<string, Outcome> = {};
  for (const run of seen) outcomes[run] = failed.has(run) ? "failed" : succeeded.has(run) ? "succeeded" : "undetermined";
  return outcomes;
}

/** One record, with the key it was placed by and the reasons for that key. */
export interface Ranked {
  readonly record: LoadedRecord;
  /** 1-based position in the order. */
  readonly rank: number;
  readonly tier: Tier;
  /** What the ranked records establish about this record's run. */
  readonly outcome: Outcome;
  /** Why the record is where it is, in the order the key was compared. Stated, not inferred by a caller. */
  readonly why: readonly string[];
}

export interface Ranking {
  readonly view: View;
  /** True when the view is an answer about a change, so the failed runs' failure surface ranks first and failed runs lead each tier. */
  readonly impliesChange: boolean;
  /**
   * Every record given, reordered. Never a subset as `rankRecords` returns it: ranking reorders
   * and never filters. A read's answer carries this ranking cut at the digest's bound, which is
   * stated on `QueryAnswer.ranking` — the cut happens above the full order, never inside it.
   */
  readonly records: readonly LoadedRecord[];
  /** The same records in the same order, each with its key and its reasons. */
  readonly ranked: readonly Ranked[];
  /** The outcome each run's records establish, by run id. */
  readonly outcomes: Readonly<Record<string, Outcome>>;
  readonly counts: {
    readonly failure: number;
    readonly surface: number;
    readonly other: number;
    readonly failedRuns: number;
    readonly undeterminedRuns: number;
    readonly succeededRuns: number;
  };
}

/**
 * The part of an accepted query the ranking reads. An `AcceptedQuery` is one; nothing else about
 * the query shapes the order, and in particular the budget does not — the budget is the digest's
 * bound (`digest.ts`), and a ranking that had already applied it could not say what it cut.
 */
export type RankQuery = Pick<AcceptedQuery, "view">;

/** A record with no usable `t` cannot be placed in time, so it sorts last within its tier rather than anywhere. */
const UNDATED = Number.MAX_SAFE_INTEGER;

/**
 * Order the records of an accepted query by its view.
 *
 * Pure: it reads nothing, writes nothing, records nothing and mutates neither its argument nor the
 * records in it. It returns every record it was given, which is what makes it safe for
 * flyingrobots/parley#50 to truncate and state what it left out.
 */
export function rankRecords(query: RankQuery, records: readonly LoadedRecord[]): Ranking {
  const view = query.view;
  const promotes = impliesChange(view);
  const outcomes = runOutcomes(records);

  const keyed = records.map((record, index) => {
    const outcome = outcomes[record.run] ?? "undetermined";
    // Promoted only with its run's failure. Every error, startup failure and non-zero end is in a
    // failed run by `runOutcomes`' own rule, so this excludes exactly the warnings of runs the
    // records do not establish as failed — a recovered condition, not a failure (§6.1).
    const failure = onFailureSurface(record);
    const tier: Tier = promotes && failure && outcome === "failed" ? "failure" : onViewSurface(view, record) ? "surface" : "other";
    return {
      record,
      index,
      tier,
      outcome,
      tierIndex: TIERS.indexOf(tier),
      // The outcome only orders anything when the view implies a change; otherwise every record
      // carries the same outcome key and the tier falls straight through to time.
      outcomeIndex: promotes ? OUTCOMES.indexOf(outcome) : 0,
      t: typeof record.t === "number" ? record.t : UNDATED,
      // On the failure surface under a change view and still not promoted: a warning of a run that went on.
      demoted: promotes && failure && tier !== "failure",
    };
  });

  keyed.sort((a, b) =>
    (a.tierIndex - b.tierIndex)
    || (a.outcomeIndex - b.outcomeIndex)
    || (a.t - b.t)
    || a.record.run.localeCompare(b.record.run)
    || (a.record.seq - b.record.seq),
  );

  const ranked: Ranked[] = keyed.map((entry, i) => ({
    record: entry.record,
    rank: i + 1,
    tier: entry.tier,
    outcome: entry.outcome,
    why: why(view, promotes, entry.tier, entry.outcome, entry.t === UNDATED, entry.demoted),
  }));

  const runs = Object.values(outcomes);
  return {
    view,
    impliesChange: promotes,
    records: ranked.map((r) => r.record),
    ranked,
    outcomes,
    counts: {
      failure: ranked.filter((r) => r.tier === "failure").length,
      surface: ranked.filter((r) => r.tier === "surface").length,
      other: ranked.filter((r) => r.tier === "other").length,
      failedRuns: runs.filter((o) => o === "failed").length,
      undeterminedRuns: runs.filter((o) => o === "undetermined").length,
      succeededRuns: runs.filter((o) => o === "succeeded").length,
    },
  };
}

function why(view: View, promotes: boolean, tier: Tier, outcome: Outcome, undated: boolean, demoted: boolean): string[] {
  const reasons: string[] = [];
  if (tier === "failure") reasons.push(`on the failure surface, and ${view} is an answer about a change`);
  else {
    if (demoted) reasons.push("a warning, and its run is not established as failed, so it is placed by the view's surface (§6.1)");
    reasons.push(tier === "surface" ? `touches the ${view} surface` : `off the ${view} surface`);
  }
  if (promotes) {
    reasons.push(outcome === "failed"
      ? "its run failed"
      : outcome === "succeeded"
        ? "its run succeeded"
        : "its run's outcome is not established by the records ranked");
  }
  reasons.push(undated ? "no usable t, so it sorts last in its tier" : "then t, run and seq ascending");
  return reasons;
}
