// The first response to a read is a digest (spec §9, informative; flyingrobots/parley#50).
//
// §9 asks two things of a result that this module is the whole of: it "carries its own lens — the
// observer, the purpose and the window that produced it — so a later reader knows what it is
// looking at and **cannot mistake a digest for the whole**", and it "reports what it excluded, at
// least as a count, so a caller can widen deliberately rather than never learning what it
// missed". The failure mode §9 names against is over-filtering: a result that reads as complete
// when it is not.
//
// The digest is the `parley.lens` 1.0.0 record decided in flyingrobots/parley#46 — not a new
// message. That decision already gives a lens the asker, the view, the budget applied, the
// window, the query it answers by `(run, seq)`, a `loss` bound with the excluded count beside it,
// and the records it was built from by `(run, seq)`, which is the way back a drill-down takes
// (`openRecords`, flyingrobots/parley#51). Inventing a second message for the same job would have been this
// library redeciding a decided one.
//
// **The bound, exactly.** `budget.records` is required and bounds the count: the digest names at
// most that many records. `budget.bytes` is optional and bounds the line: when it is stated, the
// `parley.lens` line the read writes — serialised JSON plus its newline, measured in UTF-8 bytes
// — is at most that many bytes, and records are dropped from the end of the ranking until it
// fits. A `bytes` budget too small even for a digest naming no records leaves it naming none: the
// envelope and the lens's own fields are not negotiable, because a lens that dropped them would
// no longer say what it is. `budget.ms` bounds nothing here, and the reader's page says so.
//
// **What the bound cuts is the tail of the ranking**, never a record chosen some other way. The
// order is `rankRecords`'s total order (flyingrobots/parley#49), which reorders and never filters,
// so "the records the digest does not name" is exactly "the records the ranking placed beyond the
// bound" — and that is a number the count can state honestly. A digest built over a filtered
// ranking could not.
//
// **`loss.bound` is `none` only when `loss.excluded` is 0**, and the schema refuses the other
// pairing, so a digest that left something out says so structurally rather than in prose. Since
// ranking reorders and never filters, a digest that reached the end of its ranking lost nothing at
// all, whichever view produced it.
//
// **Each name carries a summary** (flyingrobots/parley#77). A record named by `(run, seq)` alone
// has to be opened before a reader can tell an `error` from a `receipt.step`, so every entry also
// carries the record's `event` and `t` and the outcome the ranking established for its run. The
// summary is read off the loaded record when the digest is built, never from anywhere else, so it
// cannot drift from the record; a field the record does not carry usably is left out rather than
// filled in. It is part of the line, so `budget.bytes` bounds it like everything else.
import type { LoadedRecord } from "./load.ts";
import type { AcceptedQuery, Asker, Budget, QueryWindow, View } from "./query.ts";
import type { Outcome } from "./rank.ts";

/** The `parley.lens` pair a digest is emitted as; a change to the message moves this version. */
export const LENS_SCHEMA = { id: "parley.lens", version: "1.0.0" } as const;

/** What kind of statement the loss is. `none` is only ever paired with an excluded count of 0. */
export type LossBound = "none" | "count-only";

/** A record named by its identity (§1.3), which is what a lens stores rather than the record itself. */
export interface RecordRef {
  readonly run: string;
  readonly seq: number;
}

/**
 * One record a digest names: its identity, which is the way back to it, and a fixed summary of it
 * so a reader can choose what to open. Each summary field is present only when it is known:
 *
 * - `event`: the record's event token as the loader reports it, a tool's own included verbatim;
 *   absent when the record carries none.
 * - `t`: the record's POSIX milliseconds as the loader reports them; absent when the record has no
 *   non-negative integer `t`, rather than a made-up one.
 * - `outcome`: what the ranked window establishes about the record's run (`rank.ts`), which is the
 *   window's verdict and not the digest's prefix's; absent when no ranking outcomes were given.
 */
export interface LensEntry extends RecordRef {
  readonly event?: string;
  readonly t?: number;
  readonly outcome?: Outcome;
}

/**
 * What the digest lost against the records it was drawn from. The count is a proxy and a weak one
 * — one withheld record can matter more than fifty — which is why `bound` says what kind of
 * statement it is rather than letting a caller read the number as a distortion bound.
 */
export interface Loss {
  readonly bound: LossBound;
  readonly excluded: number;
}

/** The `parley.lens` payload. The writer owns the envelope (§1.3), so `t`, `seq` and `run` are not here. */
export interface Digest {
  readonly event: "lens";
  /** The recorded query this digest answers, by `(run, seq)`. */
  readonly query: RecordRef;
  readonly asker: Asker;
  readonly view: View;
  /** The budget actually applied, the default included: two digests under different budgets are not comparable. */
  readonly budget: Budget;
  readonly window: QueryWindow;
  readonly loss: Loss;
  /** The records the digest names, in rank order, never more than `budget.records` of them, each with its summary. */
  readonly records: readonly LensEntry[];
}

/** The envelope the writer will put on the digest's line, which the byte bound is measured against. */
export interface LineEnvelope {
  readonly run: string;
  readonly seq: number;
  readonly t: number;
}

export interface Digested {
  readonly digest: Digest;
  /** The records the digest names, in full and in rank order. */
  readonly records: readonly LoadedRecord[];
  /** How many records the ranking placed beyond the bound. Zero is a count, not an absence. */
  readonly excluded: number;
  /** The digest's line in UTF-8 bytes, its newline included, as the writer will write it. */
  readonly bytes: number;
}

/**
 * The entry a digest names a record by, read off the loaded record and its run's ranked outcome.
 * The key order is fixed, `run, seq, event, t, outcome`, because the byte bound is measured
 * against the serialised line.
 */
export function lensEntry(record: LoadedRecord, outcomes?: Readonly<Record<string, Outcome>>): LensEntry {
  const outcome = outcomes?.[record.run];
  return {
    run: record.run,
    seq: record.seq,
    ...(typeof record.event === "string" && record.event.length > 0 ? { event: record.event } : {}),
    ...(typeof record.t === "number" && Number.isInteger(record.t) && record.t >= 0 ? { t: record.t } : {}),
    ...(outcome === undefined ? {} : { outcome }),
  };
}

/**
 * The line the writer will write for this digest, byte for byte.
 *
 * The writer builds a record as `{event, t, seq, run, ...payload, _schema}` and writes
 * `JSON.stringify(record) + "\n"` (spec §1.1, §1.3), and a read declares no secrets, so nothing
 * is scrubbed and the payload's own key order survives. Reconstructing it here is what lets a
 * byte budget be applied **before** the line is written rather than discovered after it.
 */
export function digestLine(digest: Digest, envelope: LineEnvelope): string {
  const { event, ...rest } = digest;
  return JSON.stringify({
    event,
    t: envelope.t,
    seq: envelope.seq,
    run: envelope.run,
    ...rest,
    _schema: { id: LENS_SCHEMA.id, version: LENS_SCHEMA.version },
  }) + "\n";
}

/** The digest's line in UTF-8 bytes, its newline included. */
export function digestBytes(digest: Digest, envelope: LineEnvelope): number {
  return Buffer.byteLength(digestLine(digest, envelope), "utf8");
}

/**
 * Bound a ranking to a query's budget and state what that cost.
 *
 * Pure: it reads nothing, writes nothing, records nothing, and mutates neither its arguments nor
 * the records in them. `ranked` is the whole of the window in rank order
 * (flyingrobots/parley#49); the digest is its prefix, and `excluded` is the rest of it counted.
 * `outcomes` is the ranking's verdict per run over that whole window, and each entry carries its
 * run's; without it, no entry carries an outcome.
 *
 * The byte search is a binary search over the prefix length, which is sound because the line only
 * grows as the prefix does: one more record adds its entry, at least its `(run, seq)` pair, while
 * the excluded count beside it can shrink by at most one digit.
 */
export function digestFor(
  query: AcceptedQuery,
  answers: RecordRef,
  ranked: readonly LoadedRecord[],
  envelope: LineEnvelope,
  outcomes?: Readonly<Record<string, Outcome>>,
): Digested {
  // Built once, so every candidate prefix the byte search measures is cut from the same entries.
  const entries = ranked.map((record) => lensEntry(record, outcomes));
  const build = (keep: number): Digest => {
    const excluded = ranked.length - keep;
    return {
      event: "lens",
      query: answers,
      asker: query.asker,
      view: query.view,
      budget: query.budget,
      window: query.window,
      // `none` is a claim that nothing was left out, so it is only ever paired with 0; the schema
      // refuses `none` beside a non-zero count (flyingrobots/parley#46).
      loss: { bound: excluded === 0 ? "none" : "count-only", excluded },
      records: entries.slice(0, keep),
    };
  };

  let keep = Math.min(ranked.length, query.budget.records);
  const bytes = query.budget.bytes;
  if (bytes !== undefined && digestBytes(build(keep), envelope) > bytes) {
    // The largest prefix whose line fits. `lo` is a length that is kept rather than one known to
    // fit: a budget too small even for an empty digest leaves 0, which names no records and says
    // so, rather than writing a line that breaks the bound the caller stated.
    let lo = 0;
    let hi = keep;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (digestBytes(build(mid), envelope) <= bytes) lo = mid;
      else hi = mid - 1;
    }
    keep = lo;
  }

  const digest = build(keep);
  return {
    digest,
    records: ranked.slice(0, keep),
    excluded: ranked.length - keep,
    bytes: digestBytes(digest, envelope),
  };
}
