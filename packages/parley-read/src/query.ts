// A read against the history, recorded as a run of its own (spec §9, informative).
//
// §9 asks a query for an observer and a purpose. What those are as data was decided in
// flyingrobots/parley#46 and is written up in `docs/topics/reader/README.md`: a read states an
// **asker** (who it is for), a **view** (the shape of the answer it wants) and a **budget** (the
// size of answer it will accept), over an explicit **window**. Three rules follow from that
// decision and are the whole of this module:
//
//   1. `asker.tool` and `view` are never inferred. §2.1 forbids inventing an identity, and there
//      is no privileged view to fall back on, so a read that cannot state either is **refused**
//      with a structured error rather than answered under a guess.
//   2. An accepted read is **recorded**: the `parley.query` event is emitted through the writer,
//      so the read is a run with a receipt like any other parley program and the next reader can
//      see what was asked. A refused read is not a run and records nothing: §9 records a question
//      that was asked, and there is nothing to attribute a question nobody could state to.
//   3. The **window** is explicit and echoed in the answer. Two timestamps, inclusive at both
//      ends, because a defaulted window is a different question answered as if it were yours.
//
// What this module does **not** do, and must not be read as doing:
//
//   - **It does not filter by the view.** The view *orders* the answer — §9's purpose is the
//      ranking function, not a filter applied afterwards — and the answer is still every record in
//      the window. The rules are in `rank.ts`; the over-filtering §9 warns about is impossible
//      here because nothing is dropped at any tier.
//   - **It does not fetch what the digest left out.** The digest below bounds the answer to the
//      budget and names what it dropped as a count, and names nothing else: the way to those
//      records is a wider read. Opening the records a digest *does* name, by identity, is
//      `openRecords` in `open.ts` (flyingrobots/parley#51).
//
// What it **does** do with the budget is the digest (flyingrobots/parley#50): the first response
// is a `parley.lens` record, bounded by `budget.records` and by `budget.bytes` when the query
// states one, carrying the asker, the view, the window and the budget applied, and reporting the
// records the ranking placed beyond the bound as a count — zero included, never absent. `digest.ts`
// holds the bound and `docs/topics/parley-read/README.md` states it.
import { resolve } from "node:path";
import { defineTool, main, type Sink } from "@flyingrobots/parley-emit";
import { LENS_SCHEMA, digestFor, type Digest } from "./digest.ts";
import { loadReceipts, type Load, type LoadOptions, type LoadedRecord } from "./load.ts";
import { repoReceiptDir, stateReceiptDir } from "./locate.ts";
import { rankRecords, type Ranking } from "./rank.ts";

/** The `parley.query` pair this reader emits; a change to the message moves this version. */
export const QUERY_SCHEMA = { id: "parley.query", version: "1.0.0" } as const;

/** The closed view vocabulary (flyingrobots/parley#46). Adding a token moves the two schema versions. */
export const VIEWS = ["what-ran", "what-failed", "what-changed", "how-it-decided", "everything"] as const;
export type View = (typeof VIEWS)[number];

/** The one documented default: a read that states no budget will accept twenty records. */
export const DEFAULT_BUDGET: Budget = { records: 20 };

/**
 * The retention policy a read states (§5.1). A reader must never expire the history it reads, and
 * the writer asks every tool for a count, so the count a read states is one no directory reaches.
 */
export const NO_RETENTION = Number.MAX_SAFE_INTEGER;

export interface Asker {
  /** The calling program, named as in §2.1. Never invented: a read that cannot name it is refused. */
  readonly tool: string;
  /** Absolute POSIX working directory the read was made from. */
  readonly cwd?: string;
  /** The caller's current task id. Not the session: a session is a working period, a task a unit of work in one. */
  readonly task?: string;
}

export interface Budget {
  readonly records: number;
  readonly bytes?: number;
  readonly ms?: number;
}

/** The stretch of history a read covers: POSIX milliseconds, inclusive at both ends. */
export interface QueryWindow {
  readonly from: number;
  readonly to: number;
}

/** What a caller asks for. Every field is optional here so that a missing one can be refused rather than rejected by a type. */
export interface QueryRequest {
  readonly asker?: { readonly tool?: string; readonly cwd?: string; readonly task?: string };
  readonly view?: string;
  readonly budget?: { readonly records?: number; readonly bytes?: number; readonly ms?: number };
  readonly window?: { readonly from?: number; readonly to?: number };
  /** Free text, recorded and never parsed. Nothing in the answer branches on it. */
  readonly note?: string;
}

export type QueryRefusalCode =
  | "query.asker_unnamed"
  | "query.asker_invalid"
  | "query.view_missing"
  | "query.view_unknown"
  | "query.window_missing"
  | "query.window_invalid"
  | "query.window_inverted"
  | "query.budget_invalid"
  | "query.note_empty";

/**
 * Why a read was refused. The field names are §6's: a caller that is itself a parley tool can hand
 * one straight to `run.error`, and `code` satisfies §6's two-or-more-lowercase-segments rule.
 */
export interface QueryRefusal {
  readonly code: QueryRefusalCode;
  readonly field: "asker" | "view" | "budget" | "window" | "note";
  readonly problem: string;
  readonly remedy: string;
  /** What the refusal is measured against. */
  readonly section: string;
}

/** A read that stated everything it had to. This is what gets recorded. */
export interface AcceptedQuery {
  readonly asker: Asker;
  readonly view: View;
  readonly budget: Budget;
  readonly window: QueryWindow;
  readonly note?: string;
  /** True when the budget is `DEFAULT_BUDGET` because the caller stated none (§9: a default is never invisible). */
  readonly budgetDefaulted: boolean;
}

export interface QueryRefused {
  readonly refused: true;
  readonly refusals: readonly QueryRefusal[];
}

export type QueryPlan = { readonly refused: false; readonly query: AcceptedQuery } | QueryRefused;

export interface QueryAnswer {
  readonly refused: false;
  /** The read's own run (§2.1): the run the query record belongs to, never a run being read. */
  readonly run: string;
  /** The receipt the read wrote, which is where the recorded query lives. */
  readonly receipt: string;
  /** The recorded query, by `(run, seq)`: what a `parley.lens` will name once there is one. */
  readonly query: { readonly run: string; readonly seq: number };
  readonly asker: Asker;
  readonly view: View;
  readonly budget: Budget;
  readonly budgetDefaulted: boolean;
  /** Echoed verbatim from the query, inclusive at both ends. */
  readonly window: QueryWindow;
  readonly note?: string;
  /**
   * The records the digest names, in full: the window ordered by the view — the failure surface
   * of the runs that failed first when the view implies a change, then the view's own surface, then `(t, run, seq)`
   * ascending — and cut at the budget. Never more than `budget.records` of them, and fewer when a
   * stated `budget.bytes` cuts first. What the bound left out is `counts.excluded`; it is named
   * nowhere, so reaching it is a wider read, not a drill-down.
   */
  readonly records: readonly LoadedRecord[];
  /** The digest this read answered with, exactly as the `parley.lens` record carries it. */
  readonly digest: Digest;
  /** The digest's line in UTF-8 bytes, its newline included, as the read wrote it. */
  readonly digestBytes: number;
  /**
   * The ranking the digest was cut from: `records` and `ranked` hold what the digest names, in
   * rank order, while `outcomes` and `counts` describe the **whole window** the digest was drawn
   * from. The two are deliberately not the same population: a run's outcome is established from
   * the window (§1.2a), so recomputing it from a bounded prefix would turn a run whose `end` the
   * bound cut into an undetermined one, and a tier census of the window is what tells a caller
   * the digest is not the whole of it.
   */
  readonly ranking: Ranking;
  readonly counts: {
    /** Records the load returned, the read's own run included. */
    readonly scanned: number;
    /** Records in the window, the digest's bound disregarded: the population the digest was drawn from. */
    readonly inWindow: number;
    /** Records the digest names. */
    readonly answered: number;
    /** Records the ranking placed beyond the bound. Zero is a count, not an absence (§9). */
    readonly excluded: number;
    /** Records whose `t` is not a number, which cannot be placed in a window and are therefore not in the answer. */
    readonly undated: number;
    /** The read's own records, which a read does not answer itself with. */
    readonly own: number;
  };
  /** The whole load behind the answer, so a caller sees the defects and quarantines too. */
  readonly load: Load;
  /** The protocol lines the read wrote to its own stdout, parsed. */
  readonly lines: readonly Record<string, unknown>[];
  /** The read's exit status (§3.4). */
  readonly status: number;
}

export type QueryOutcome = QueryAnswer | QueryRefused;

export interface QueryOptions extends LoadOptions {
  /**
   * The reading program's own identity, for the run the read records under. The default is this
   * package; a host program that embeds the reader names itself here, and nothing is invented
   * either way (§2.1). This is not the asker: the asker is who the read is *for*.
   */
  readonly tool?: { readonly name: string; readonly version: string };
  /** Where the read's own protocol lines go. The default keeps them in the answer's `lines` and off the host's streams. */
  readonly stdout?: Sink;
  readonly stderr?: Sink;
  /** Carried as `session` on the read's lines; never invented (§2.1). */
  readonly session?: string;
  readonly now?: () => number;
}

/** The reading program's default identity; the drill-down (`open.ts`) records under the same one. */
export const READER = { name: "parley-read", version: "0.1.0" } as const;

/** Collects the read's own lines and forwards them to a caller's sink when there is one. */
export class Tee implements Sink {
  readonly lines: string[] = [];
  constructor(private readonly to?: Sink) {}
  write(line: string): void {
    this.lines.push(line);
    this.to?.write(line);
  }
}

function refusal(code: QueryRefusalCode, field: QueryRefusal["field"], problem: string, remedy: string, section: string): QueryRefusal {
  return { code, field, problem, remedy, section };
}

function positiveInteger(n: unknown): boolean {
  return typeof n === "number" && Number.isInteger(n) && n >= 1;
}

/**
 * Check a request and fill the one field that has a default. Pure: it reads nothing, writes
 * nothing and records nothing, so a caller can ask whether a read would be accepted before making
 * it.
 */
export function planQuery(request: QueryRequest): QueryPlan {
  const refusals: QueryRefusal[] = [];
  const tool = request.asker?.tool;
  if (typeof tool !== "string" || tool.length === 0) {
    refusals.push(refusal(
      "query.asker_unnamed", "asker",
      "the read names no asker: asker.tool is absent or empty",
      "name the calling program in asker.tool; it is one argument and it is never inferred, because §2.1 forbids inventing an identity",
      "§2.1, §9",
    ));
  }
  if (request.view === undefined) {
    refusals.push(refusal(
      "query.view_missing", "view",
      "the read states no view, and there is no privileged view to fall back on",
      `state one of: ${VIEWS.join(", ")}; a guessed view is a different answer to a different question, and the caller cannot see it`,
      "§9",
    ));
  } else if (!(VIEWS as readonly string[]).includes(request.view)) {
    refusals.push(refusal(
      "query.view_unknown", "view",
      `${JSON.stringify(request.view)} is not a view: the vocabulary is closed`,
      `state one of: ${VIEWS.join(", ")}; extending the vocabulary moves the parley.query and parley.lens schema versions`,
      "§9",
    ));
  }

  const window = request.window;
  if (window === undefined || window.from === undefined || window.to === undefined) {
    refusals.push(refusal(
      "query.window_missing", "window",
      "the read states no window, or only one of its two bounds",
      "state window.from and window.to as POSIX milliseconds, inclusive at both ends; 0 means the start of the history",
      "§9",
    ));
  } else if (!Number.isInteger(window.from) || !Number.isInteger(window.to) || window.from < 0 || window.to < 0) {
    refusals.push(refusal(
      "query.window_invalid", "window",
      "a window bound is not a non-negative integer number of POSIX milliseconds",
      "state window.from and window.to as integers at or above 0",
      "§1.3, §9",
    ));
  } else if (window.to < window.from) {
    refusals.push(refusal(
      "query.window_inverted", "window",
      `the window ends before it begins: to ${window.to} is below from ${window.from}`,
      "state a window whose to is at or after its from; a window that covers nothing is not a window",
      "§9",
    ));
  }

  let budget: Budget | undefined;
  let budgetDefaulted = false;
  if (request.budget === undefined) {
    budget = DEFAULT_BUDGET;
    budgetDefaulted = true;
  } else {
    const b = request.budget;
    const bad = !positiveInteger(b.records)
      || (b.bytes !== undefined && !positiveInteger(b.bytes))
      || (b.ms !== undefined && !positiveInteger(b.ms));
    if (bad) {
      refusals.push(refusal(
        "query.budget_invalid", "budget",
        "a budget bound is not a positive integer: records is required, and a bound that admits nothing is not a bound",
        "state budget.records as an integer of 1 or more, with bytes and ms optional and positive, or state no budget at all and take the documented default of 20 records",
        "§9",
      ));
    } else {
      budget = {
        records: b.records!,
        ...(b.bytes === undefined ? {} : { bytes: b.bytes }),
        ...(b.ms === undefined ? {} : { ms: b.ms }),
      };
    }
  }

  const cwd = request.asker?.cwd;
  if (cwd !== undefined && !(cwd.startsWith("/") && cwd.length >= 2)) {
    refusals.push(refusal(
      "query.asker_invalid", "asker",
      `asker.cwd ${JSON.stringify(cwd)} is not an absolute POSIX path`,
      "give asker.cwd as an absolute path, or omit it and let the read record the directory it read; v0.2 of the spec is POSIX-only",
      "§4.5",
    ));
  }
  if (request.asker?.task !== undefined && request.asker.task.length === 0) {
    refusals.push(refusal(
      "query.asker_invalid", "asker",
      "asker.task is an empty string, which parley.query does not carry",
      "omit the task, or give it the caller's task id",
      "§4.5",
    ));
  }

  if (request.note !== undefined && request.note.length === 0) {
    refusals.push(refusal(
      "query.note_empty", "note",
      "the note is an empty string, which parley.query does not carry",
      "omit the note, or give it text; it is recorded and never parsed",
      "§4.5",
    ));
  }

  if (refusals.length > 0) return { refused: true, refusals };

  const asker: Asker = {
    tool: tool!,
    ...(request.asker?.cwd === undefined ? {} : { cwd: request.asker.cwd }),
    ...(request.asker?.task === undefined ? {} : { task: request.asker.task }),
  };
  return {
    refused: false,
    query: {
      asker,
      view: request.view as View,
      budget: budget!,
      window: { from: window!.from!, to: window!.to! },
      ...(request.note === undefined ? {} : { note: request.note }),
      budgetDefaulted,
    },
  };
}

/** The `parley.query` payload for an accepted read. The writer owns the envelope (§1.3). */
export function queryRecord(query: AcceptedQuery): Record<string, unknown> {
  return {
    event: "query",
    asker: query.asker,
    view: query.view,
    budget: query.budget,
    window: query.window,
    ...(query.note === undefined ? {} : { note: query.note }),
  };
}

function inWindow(record: LoadedRecord, window: QueryWindow): boolean {
  return typeof record.t === "number" && record.t >= window.from && record.t <= window.to;
}

/**
 * Make a read: refuse it, or record it and answer it.
 *
 * A refused read returns its refusals and does nothing else — no run, no receipt, nothing written.
 * An accepted read is a run of its own: the `parley.query` event goes through the writer into a
 * receipt beside the ones being read, so the loader finds it on the next read, and the answer
 * names it by `(run, seq)`.
 *
 * The answer is the window's records ordered by the view and **bounded by the budget**, excluding
 * the read's own run: a read does not answer itself, and the record of it is there for the next
 * one. The bound is the digest's (flyingrobots/parley#50): a second `parley.lens` record goes
 * through the writer naming the asker, the view, the window, the budget applied and the records
 * the digest holds, and reporting the rest of the ranking as a count. Nothing is dropped by the
 * ranking itself — it reorders and never filters — so the count is exactly the tail of one total
 * order. The tail is named nowhere, so a caller reaches it by reading again under a wider budget;
 * `openRecords` opens what the digest does name (flyingrobots/parley#51).
 */
export async function queryReceipts(request: QueryRequest, opts: QueryOptions = {}): Promise<QueryOutcome> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  // §9's inference, as flyingrobots/parley#46 settled it and flyingrobots/parley#61 decided in
  // full: `asker.cwd` comes from the process when the caller does not state it. `asker.task` is
  // never inferred at all — there is no environment variable for it — so it is taken from the
  // request and omitted when the caller does not state it.
  const plan = planQuery({ ...request, asker: { ...request.asker, cwd: request.asker?.cwd ?? cwd } });
  if (plan.refused) return plan;
  const query = plan.query;

  const env = opts.env ?? process.env;
  const stdout = new Tee(opts.stdout);
  const stderr = new Tee(opts.stderr);
  const identity = opts.tool ?? READER;

  const spec = defineTool({
    name: identity.name,
    version: identity.version,
    commands: {
      read: {
        intent: "Answer a read against this working directory's receipt bundles, and record the read",
        effects: {
          reads: [`${repoReceiptDir(cwd)}/*`, `${stateReceiptDir({ ...opts, cwd })}/*`],
          writes: [],
          network: false,
          idempotent: true,
        },
        secrets: [],
        emits: [{ ...QUERY_SCHEMA }, { ...LENS_SCHEMA }],
      },
    },
    // §5.1 asks every tool for a stated policy. A read states one that deletes nothing: expiring
    // the receipts it was asked to read would destroy the history to answer a question about it.
    retention: { count: NO_RETENTION },
  });

  let answer: Omit<QueryAnswer, "status" | "lines"> | undefined;
  const status = await main(spec, [spec.name, "read"], (run) => {
    const seq = run.result(queryRecord(query), QUERY_SCHEMA);
    run.step(
      "recorded the read before answering it",
      "spec §9: a query is itself an event, so the store learns what was asked and a result can name the query it answers",
      { view: query.view, window: query.window, budget: query.budget, budget_defaulted: query.budgetDefaulted },
    );

    const load = loadReceipts({ cwd, env, ...(opts.home === undefined ? {} : { home: opts.home }), ...(opts.sidecars === undefined ? {} : { sidecars: opts.sidecars }), ...(opts.validate === undefined ? {} : { validate: opts.validate }), ...(opts.history === undefined ? {} : { history: opts.history }) });
    const all = load.bundles.flatMap((b) => b.records);
    const own = all.filter((r) => r.run === run.id);
    const others = all.filter((r) => r.run !== run.id);
    const undated = others.filter((r) => typeof r.t !== "number");
    // One place decides the order, and it is the ranking: `(t, run, seq)` ascending is the last
    // part of its key, so sorting here first would be the same order computed twice and two
    // places for it to drift.
    const inside = others.filter((r) => inWindow(r, query.window));
    const ranking = rankRecords(query, inside);

    const ranked = run.step(
      `ranked ${ranking.records.length} record(s) of the window by the ${query.view} view`,
      "spec §9's purpose is the ranking function, not a filter: every record in the window is ranked, so the digest that follows cuts the tail of one total order and can say how long that tail was (flyingrobots/parley#49)",
      {
        scanned: all.length, in_window: ranking.records.length, undated: undated.length, own: own.length,
        view: query.view, implies_change: ranking.impliesChange, tiers: ranking.counts,
      },
    );

    // The digest's line is bounded in bytes before it is written, so the envelope it will be
    // written with has to be known here. `run.result` and `run.step` each take one seq in order
    // and return it, a read declares no secrets so no redaction line comes between them, and the
    // one step below sits between this ranking step and the digest: the digest's seq is therefore
    // `ranked + 2`, and `t` comes from the same clock the writer stamps with. RD-20c pins that
    // reconstruction against the line the writer really wrote.
    //
    // The seq is measured an order of magnitude larger than that, which is one more digit and so
    // one byte of headroom. It is not paranoia about the arithmetic above: the writer can raise a
    // line of its own in between — a history stream that fails mid-run is a `warning` — and a seq
    // that gained a digit would put the line one byte over a budget the caller stated. A stated
    // bound that holds is worth a byte.
    const digested = digestFor(
      query,
      { run: run.id, seq },
      ranking.records,
      { run: run.id, seq: (ranked + 2) * 10, t: (opts.now ?? Date.now)() },
      // Each entry's outcome is the whole window's verdict on its run, not the prefix's.
      ranking.outcomes,
    );
    const records = digested.records;

    run.step(
      digested.excluded === 0
        ? `answered with all ${records.length} ranked record(s): the budget cut nothing`
        : `answered with ${records.length} of ${ranking.records.length} ranked record(s) and excluded ${digested.excluded}`,
      "spec §9: a result is bounded and reports what it excluded, at least as a count, so a later reader cannot mistake a digest for the whole (flyingrobots/parley#50)",
      {
        records_bound: query.budget.records,
        ...(query.budget.bytes === undefined ? {} : { bytes_bound: query.budget.bytes }),
        named: records.length, excluded: digested.excluded, loss_bound: digested.digest.loss.bound,
        digest_bytes: digested.bytes,
      },
    );

    const before = stdout.lines.length;
    run.result(digested.digest as unknown as Record<string, unknown>, LENS_SCHEMA);
    // The bytes the answer reports are the bytes that went out, not the reconstruction the bound
    // was measured against; a stream the host replaced cannot hide a line the read wrote, because
    // the read's own tee holds it.
    const written = stdout.lines[before];
    const digestBytes = written === undefined ? digested.bytes : Buffer.byteLength(written, "utf8");

    answer = {
      refused: false,
      run: run.id,
      receipt: run.receiptPath,
      query: { run: run.id, seq },
      asker: query.asker,
      view: query.view,
      budget: query.budget,
      budgetDefaulted: query.budgetDefaulted,
      window: query.window,
      ...(query.note === undefined ? {} : { note: query.note }),
      records,
      digest: digested.digest,
      digestBytes,
      // The ranking's records stop where the digest does; its outcomes and counts describe the
      // window the digest was drawn from (see `QueryAnswer.ranking`).
      ranking: { ...ranking, records, ranked: ranking.ranked.slice(0, records.length) },
      counts: {
        scanned: all.length,
        inWindow: ranking.records.length,
        answered: records.length,
        excluded: digested.excluded,
        undated: undated.length,
        own: own.length,
      },
      load,
    };
  }, {
    cwd,
    env,
    ...(opts.home === undefined ? {} : { home: opts.home }),
    ...(opts.session === undefined ? {} : { session: opts.session }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
    stdout,
    stderr,
    // What enters `inv` is the question, not the clock or the directory (§2.2): the view, the
    // window and the budget, with the asker's tool and task. `asker.cwd` is left out on purpose —
    // it moves with the process, and an `inv` that moves with the directory identifies nothing.
    resolved: () => ({
      command: "read",
      view: query.view,
      window: query.window,
      budget: query.budget,
      asker: { tool: query.asker.tool, ...(query.asker.task === undefined ? {} : { task: query.asker.task }) },
    }),
  });

  const lines = stdout.lines
    .map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
    .filter((l): l is Record<string, unknown> => l !== null);

  if (!answer) {
    // The handler did not finish: the writer has already recorded why on the read's own streams
    // and in its receipt, and the status says so. There is no answer to return and none is
    // invented.
    throw new Error(`the read did not complete: status ${status}; see the receipt it recorded`);
  }
  return { ...answer, lines, status };
}
