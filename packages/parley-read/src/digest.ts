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
// fits. The envelope and the lens's own fields are not negotiable, because a lens that dropped
// them would no longer say what it is, so a `bytes` budget too small even for a digest naming no
// records cannot be met at all: `digestFor` reports that as `fits: false`, and the read declines
// rather than write a line over the bound, naming the smallest budget that would hold one
// (`sufficientBytes`, flyingrobots/parley#71). `budget.ms` is a deadline on the read as a whole,
// not on the digest, and is applied in `query.ts`.
//
// **What the bound cuts is the tail of the ranking**, never a record chosen some other way. The
// order is `rankRecords`'s total order (flyingrobots/parley#49), which reorders and never filters,
// so "the records the digest does not name" is exactly "the records the fold left out and the
// records the ranking placed beyond the bound" — two numbers the loss can state honestly, and does.
// A digest built over a filtered ranking could not.
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
//
// **Each run is stated once** (flyingrobots/parley#83). Which invocation a run was is the same for
// every record of it, so it is said in the lens's `runs` section, once per run the entries name,
// rather than on each entry: the head's `tool`, `v`, `argv` and `inv`, the run's outcome over the
// whole window, and, when that outcome is `undetermined`, a `reason` from a closed vocabulary.
// The outcome moved there from the entries, where a four-record run repeated it four times. An
// entry keeps its `event` and `t`, and an `error` or `warning` entry also carries its `code`, so
// three failures of one case read as one case without opening them. A section is read off the
// window's own records, the same ones the ranking was given, so it cannot drift from the head it
// summarises; a run whose head the window does not hold still gets a section, saying so.
//
// **A section says what the run compared** (flyingrobots/parley#90). `argv` says `HEAD~1..HEAD`;
// only the head's `resolved`, the interpretation after defaults and environment (§5), says which
// two commits that was. So a section carries `resolved` too, copied whole off the head and already
// redacted there (§5.3). It is the tool's own shape, so the reader chooses none of its keys: a
// subset picked by name would be one tool's field names living in the reader, and a declared
// subset could drift from the head it summarises.
//
// **A section is bounded** by `RUN_SECTION_BYTES`: when its serialised JSON is larger, whole
// fields are dropped, `resolved` first, then `argv`, `inv`, `v` and `tool`, until it fits, and the
// section names what it dropped in `dropped`. `resolved` goes first because it is the largest and
// the tool's own shape, while `argv` is the protocol's. A string is never cut part-way, because a cut
// argument reads as a different argument. The run's id, outcome, reason and head statement are
// never dropped: without them the section does not say which run it is or what became of it.
//
// **Runs of one invocation with one result are named once** (flyingrobots/parley#79, `fold.ts`).
// Before the bound is applied, the runs whose `inv` and whole result are equal are folded into
// their most recent run: the others' records are not named, the representative's section says
// `folded: {others, records}`, both counting the others only (flyingrobots/parley#100), and
// `loss.folded` counts every record the fold left out. Those
// records are in `loss.excluded` too, so the count still accounts for every record not named, and
// `excluded − folded` is what the budget cut.
import { foldRuns, type RunFold } from "./fold.ts";
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
  /** An `error` or `warning` record's code (spec §6); absent on any other record and on a malformed code. */
  readonly code?: string;
}

/**
 * Why a run's outcome is `undetermined`, from a closed set that covers every way `runOutcomes`
 * reaches it: the window holds no `end` for the run, or it holds one whose `status` is not a
 * number. A missing `end` is not a successful one (§1.2a); the window cannot say whether the run
 * ended later or never did.
 */
export const UNDETERMINED_REASONS = ["no_end_in_window", "end_status_unusable"] as const;
export type UndeterminedReason = (typeof UNDETERMINED_REASONS)[number];

/** The fields a section may drop to fit `RUN_SECTION_BYTES`, in the order they are dropped. */
export const DROPPABLE = ["resolved", "argv", "inv", "v", "tool"] as const;
export type Droppable = (typeof DROPPABLE)[number];

/** The most UTF-8 bytes one run section's serialised JSON takes, unless its undroppable fields alone exceed it. */
export const RUN_SECTION_BYTES = 512;

/**
 * What a lens says about one run its entries name, once. Every field but `run` is present only
 * when it is known:
 *
 * - `tool`, `v`, `argv`: the run's `receipt.head` as the loader read it, when the window holds the
 *   head; `argv` is already redacted there (§5.3).
 * - `resolved`: the head's `resolved`, whole, when it is a JSON object; redacted there too (§5.3).
 * - `inv`: the head's, or else the window's `receipt.inputs` for the run (§2.2).
 * - `outcome`: the window's verdict on the run (`rank.ts`), absent when no outcomes were given.
 * - `reason`: present exactly when `outcome` is `undetermined`.
 * - `head`: `not_in_window` when the window does not hold the run's head; absent when it does.
 * - `folded`: present on a run that stands for others of one invocation with one result
 *   (`fold.ts`): how many other runs it stands for and how many of their records the fold left
 *   out, both excluding this run (flyingrobots/parley#100). Never dropped.
 * - `dropped`: the fields left out to fit `RUN_SECTION_BYTES`, in the order they were dropped.
 */
export interface RunSection {
  readonly run: string;
  readonly tool?: string;
  readonly v?: string;
  readonly argv?: readonly string[];
  readonly resolved?: Readonly<Record<string, unknown>>;
  readonly inv?: string;
  readonly outcome?: Outcome;
  readonly reason?: UndeterminedReason;
  readonly head?: "not_in_window";
  readonly folded?: RunFold;
  readonly dropped?: readonly Droppable[];
}

/**
 * What the digest lost against the records it was drawn from. The count is a proxy and a weak one
 * — one withheld record can matter more than fifty — which is why `bound` says what kind of
 * statement it is rather than letting a caller read the number as a distortion bound.
 */
export interface Loss {
  readonly bound: LossBound;
  /** Every record of the window the digest does not name, whatever left it out. */
  readonly excluded: number;
  /**
   * How many of `excluded` the fold left out (flyingrobots/parley#79): the records of runs folded
   * into a representative. It depends on the window alone, never on the budget, and
   * `excluded − folded` is what the budget cut. Zero is a count, not an absence.
   */
  readonly folded: number;
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
  /** One section per run `records` names, in the order the entries first name them. */
  readonly runs: readonly RunSection[];
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
  /** How many records of the ranking the digest does not name, the folded ones included. Zero is a count, not an absence. */
  readonly excluded: number;
  /** How many of `excluded` the fold left out rather than the bound (`fold.ts`). */
  readonly folded: number;
  /** The digest's line in UTF-8 bytes, its newline included, as the writer will write it. */
  readonly bytes: number;
  /**
   * Whether the line is within `budget.bytes`. Always true when no byte bound is stated; false only
   * when even a digest naming no records is over it, which the read declines rather than writes.
   */
  readonly fits: boolean;
}

/** Spec §6's code shape, the same pattern `parley.error` and `parley.warning` declare. */
const CODE = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/**
 * The entry a digest names a record by, read off the loaded record. The key order is fixed,
 * `run, seq, event, t, code`, because the byte bound is measured against the serialised line.
 */
export function lensEntry(record: LoadedRecord): LensEntry {
  const code = record.record.code;
  const coded = (record.event === "error" || record.event === "warning") && typeof code === "string" && CODE.test(code);
  return {
    run: record.run,
    seq: record.seq,
    ...(nonEmpty(record.event) ? { event: record.event } : {}),
    ...(typeof record.t === "number" && Number.isInteger(record.t) && record.t >= 0 ? { t: record.t } : {}),
    ...(coded ? { code } : {}),
  };
}

const sectionBytes = (section: RunSection) => Buffer.byteLength(JSON.stringify(section), "utf8");

/**
 * What a lens says about one run, read off the window's records for it (`window` may hold other
 * runs' records too; `digestFor` passes only the run's own) and the window's outcomes, with the
 * run's fold when it stands for others. The key order is fixed, `run, tool, v, argv, resolved, inv,
 * outcome, reason, head, folded, dropped`, and the section is bounded by `RUN_SECTION_BYTES` by dropping
 * whole fields, never by cutting a string.
 */
export function runSection(run: string, window: readonly LoadedRecord[], outcomes?: Readonly<Record<string, Outcome>>, fold?: RunFold): RunSection {
  const own = window.filter((r) => r.run === run);
  const head = own.find((r) => r.event === "receipt.head");
  const inputs = own.find((r) => r.event === "receipt.inputs" && nonEmpty(r.record.inv));
  const argv = head?.record.argv;
  const resolved = head?.record.resolved;
  const inv = nonEmpty(head?.record.inv) ? head.record.inv : inputs?.record.inv as string | undefined;
  const outcome = outcomes?.[run];
  const reason: UndeterminedReason | undefined = outcome !== "undetermined"
    ? undefined
    : own.some((r) => r.event === "end") ? "end_status_unusable" : "no_end_in_window";
  const fields: Partial<Record<Droppable, unknown>> = {
    ...(nonEmpty(head?.record.tool) ? { tool: head.record.tool } : {}),
    ...(nonEmpty(head?.record.v) ? { v: head.record.v } : {}),
    ...(Array.isArray(argv) && argv.every((a) => typeof a === "string") ? { argv } : {}),
    ...(resolved !== null && typeof resolved === "object" && !Array.isArray(resolved) ? { resolved } : {}),
    ...(inv === undefined ? {} : { inv }),
  };
  const build = (dropped: readonly Droppable[]): RunSection => {
    const kept = (k: Droppable) => (k in fields && !dropped.includes(k) ? { [k]: fields[k] } : {});
    return {
      run,
      ...kept("tool"),
      ...kept("v"),
      ...kept("argv"),
      ...kept("resolved"),
      ...kept("inv"),
      ...(outcome === undefined ? {} : { outcome }),
      ...(reason === undefined ? {} : { reason }),
      ...(head === undefined ? { head: "not_in_window" as const } : {}),
      ...(fold === undefined ? {} : { folded: { others: fold.others, records: fold.records } }),
      ...(dropped.length === 0 ? {} : { dropped: [...dropped] }),
    } as RunSection;
  };
  const dropped: Droppable[] = [];
  let section = build(dropped);
  for (const field of DROPPABLE) {
    if (sectionBytes(section) <= RUN_SECTION_BYTES) break;
    if (!(field in fields)) continue;
    dropped.push(field);
    section = build(dropped);
  }
  return section;
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
 * The digest naming `kept`, the head of a ranking `total` records long of which the fold left
 * `folded` out, with `runs`, one section per run `kept` names. The one place the lens payload's
 * shape and key order are written, so the smallest digest `sufficientBytes` measures is the digest
 * `digestFor` would write.
 */
function buildDigest(query: AcceptedQuery, answers: RecordRef, kept: readonly LensEntry[], total: number, runs: readonly RunSection[], folded: number): Digest {
  const excluded = total - kept.length;
  return {
    event: "lens",
    query: answers,
    asker: query.asker,
    view: query.view,
    budget: query.budget,
    window: query.window,
    // `none` is a claim that nothing was left out, so it is only ever paired with 0; the schema
    // refuses `none` beside a non-zero count (flyingrobots/parley#46).
    // A fold leaves records out, so a digest that folded anything is never `none`.
    loss: { bound: excluded === 0 ? "none" : "count-only", excluded, folded },
    runs,
    records: kept,
  };
}

/**
 * The smallest `budget.bytes` under which this query's digest, over a ranking `total` records
 * long of which the fold leaves `folded` out (`Digested.folded`; 0 when nothing folds), can be
 * written at all: the line of a digest naming no records, with that very number as its stated
 * `bytes`. Pure.
 *
 * The digest carries the budget it was bounded by, so the size depends on the digits of the bound
 * itself. The search starts from 1 and takes the size the line would have under the current
 * candidate, until a candidate holds its own line. Each step is a size some smaller candidate
 * already needed, so no smaller bound can fit and the first fixed point is the least one; the size
 * only grows with the digits of the bound, so it stops within a few steps.
 *
 * The answer is exact for a read of the same question over the same ranking, measured against the
 * same envelope: `digestFor` under it names no records and fits, and one byte less does not.
 */
export function sufficientBytes(query: AcceptedQuery, answers: RecordRef, total: number, envelope: LineEnvelope, folded = 0): number {
  const size = (bytes: number) =>
    // A digest naming no records names no runs either: its `runs` is empty, as `digestFor` writes it.
    digestBytes(buildDigest({ ...query, budget: { ...query.budget, bytes } }, answers, [], total, [], folded), envelope);
  let bytes = 1;
  for (let next = size(bytes); next > bytes; next = size(bytes)) bytes = next;
  return bytes;
}

/**
 * Bound a ranking to a query's budget and state what that cost.
 *
 * Pure: it reads nothing, writes nothing, records nothing, and mutates neither its arguments nor
 * the records in them. `ranked` is the whole of the window in rank order
 * (flyingrobots/parley#49). The runs of one invocation with one result are folded first
 * (`fold.ts`), which needs `outcomes`; the digest is the prefix of what the fold leaves, in the
 * same order, and `excluded` is the rest of the window counted, the folded records included.
 * `outcomes` is the ranking's verdict per run over that whole window, and each run section carries
 * its run's; without it, no section carries an outcome or a reason. Each section is read off the
 * whole window too, so a head the bound cut from the entries still identifies its run.
 *
 * The byte search is a binary search over the prefix length, which is sound because the line only
 * grows as the prefix does: one more record adds its entry, at least its `(run, seq)` pair, and
 * perhaps its run's section, while the excluded count beside it can shrink by at most one digit
 * and `loss.bound` by the six bytes between `count-only` and `none`.
 */
export function digestFor(
  query: AcceptedQuery,
  answers: RecordRef,
  ranked: readonly LoadedRecord[],
  envelope: LineEnvelope,
  outcomes?: Readonly<Record<string, Outcome>>,
): Digested {
  // The fold depends on the window and its outcomes, never on the budget.
  const folding = foldRuns(ranked, outcomes);
  const named = folding.records;
  // Built once, so every candidate prefix the byte search measures is cut from the same entries.
  const entries = named.map((record) => lensEntry(record));
  // One pass over the window groups each run's records, so a section never scans the whole
  // window for its own (RD-80h).
  const byRun = new Map<string, LoadedRecord[]>();
  for (const record of ranked) {
    const own = byRun.get(record.run);
    if (own === undefined) byRun.set(record.run, [record]);
    else own.push(record);
  }
  const sections = new Map<string, RunSection>();
  const sectionOf = (run: string) => {
    let section = sections.get(run);
    if (section === undefined) sections.set(run, section = runSection(run, byRun.get(run) ?? [], outcomes, folding.folds.get(run)));
    return section;
  };
  const build = (keep: number): Digest => {
    const kept = entries.slice(0, keep);
    return buildDigest(query, answers, kept, ranked.length, [...new Set(kept.map((e) => e.run))].map(sectionOf), folding.folded);
  };

  let keep = Math.min(named.length, query.budget.records);
  const bytes = query.budget.bytes;
  if (bytes !== undefined && digestBytes(build(keep), envelope) > bytes) {
    // The largest prefix whose line fits. `lo` is a length that is kept rather than one known to
    // fit: a budget too small even for an empty digest leaves 0, and `fits` below says the bound
    // could not be met, so the read declines instead of writing the line.
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
  const size = digestBytes(digest, envelope);
  return {
    digest,
    records: named.slice(0, keep),
    excluded: ranked.length - keep,
    folded: folding.folded,
    bytes: size,
    fits: bytes === undefined || size <= bytes,
  };
}
