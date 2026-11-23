// The drill-down: full records by `(run, seq)` (spec §9, informative; flyingrobots/parley#51).
//
// A digest names records by identity and holds none of them, because §9 keeps a result small and
// "projecting down is cheap, expanding back up may be impossible within a budget". This is the way
// back up: a caller hands in the `(run, seq)` pairs a `parley.lens` names and gets each record in
// full, with an outcome per id.
//
// Three rules, and the reasons for them:
//
//   1. **A drill-down is a recorded read.** It reads history, so by the reasoning of
//      flyingrobots/parley#48 it states an asker, a view and a window, is refused without them,
//      and is recorded through the writer as a `parley.query` event — the same message, with
//      `records` naming the ids it opens. The store then learns which records were opened as well
//      as which questions were asked. The view and window are recorded and **select nothing**: the
//      ids are opened by identity whatever their `t`, in the order asked.
//   2. **One outcome per id asked, never a throw.** An id is `opened`, or `sidecar_unavailable`
//      when it is a sidecar or a record stored in one and the stored bytes could not be
//      established, or `run_not_found` / `seq_not_found` when half of it does not resolve. One
//      broken id does not lose the others.
//   3. **The loader's rulings travel with the record.** Every id whose run resolved carries its
//      bundle's replay ruling, so a record whose bundle is unavailable for replay still opens — the
//      failed run's `error` is usually the record a reader most needs — and says so (§2.3, §5.4).
//
// A sidecar's contents are checked by the loader, not here: the declared `bytes` and `sha256` are
// compared with the stored bytes before the record is restored (§5), and this module reports the
// loader's resolution rather than reading the file a second time.
import { resolve } from "node:path";
import { defineTool, main } from "@flyingrobots/parley-emit";
import type { RecordRef } from "./digest.ts";
import { loadReceipts, type Bundle, type Load, type LoadedRecord, type Replay, type SidecarResolution } from "./load.ts";
import { repoReceiptDir, stateReceiptDir } from "./locate.ts";
import {
  NO_RETENTION, QUERY_SCHEMA, READER, Tee, planQuery, queryRecord,
  type AcceptedQuery, type Asker, type QueryOptions, type QueryRefusal, type QueryRequest, type QueryWindow, type View,
} from "./query.ts";

export type OpenRefusalCode = QueryRefusal["code"] | "open.records_missing" | "open.records_invalid";

/** Why a drill-down was refused: §6's fields, as a query's refusal carries them. */
export interface OpenRefusal {
  readonly code: OpenRefusalCode;
  readonly field: QueryRefusal["field"] | "records";
  readonly problem: string;
  readonly remedy: string;
  readonly section: string;
}

export interface OpenRefused {
  readonly refused: true;
  readonly refusals: readonly OpenRefusal[];
}

/** What a caller asks for. A budget is not taken: the ids are the bound, and the record says so. */
export interface OpenRequest {
  readonly asker?: QueryRequest["asker"];
  readonly view?: string;
  readonly window?: QueryRequest["window"];
  readonly note?: string;
  /** The records to open, by `(run, seq)`, as a `parley.lens` names them. */
  readonly records?: readonly { readonly run?: unknown; readonly seq?: unknown }[];
}

export type OpenOutcomeKind = "opened" | "sidecar_unavailable" | "run_not_found" | "seq_not_found";

/** What the loader established about the bundle an id's run resolved to. */
export interface BundleRuling {
  readonly terminated: boolean;
  readonly status: number | null;
  readonly redacted: boolean;
  readonly replay: Replay;
}

/** One id's outcome. */
export interface Opened {
  readonly id: RecordRef;
  readonly outcome: OpenOutcomeKind;
  /**
   * The record at that `(run, seq)`, in full, when there is one. For `sidecar_unavailable` this is
   * the `sidecar` pointer and nothing more: the contents it stands for are not claimed.
   */
  readonly record?: LoadedRecord;
  /** When the id names a `sidecar` event whose stored bytes are intact: the record it holds, in full. */
  readonly held?: LoadedRecord;
  /** The sidecar involved, when the id is one or is stored in one. */
  readonly sidecar?: SidecarResolution;
  /** The bundle's rulings, whenever the id's run resolved. */
  readonly bundle?: BundleRuling;
  /** For any outcome but `opened`: what went wrong, and what a caller can do about it. */
  readonly problem?: string;
  readonly remedy?: string;
}

export interface OpenAnswer {
  readonly refused: false;
  /** The drill-down's own run, never a run being read. */
  readonly run: string;
  readonly receipt: string;
  /** The recorded `parley.query`, by `(run, seq)`. */
  readonly query: RecordRef;
  readonly asker: Asker;
  readonly view: View;
  readonly window: QueryWindow;
  readonly note?: string;
  /** The ids asked, in the order asked, exactly as recorded. */
  readonly records: readonly RecordRef[];
  /** One outcome per id asked, in the same order. */
  readonly opened: readonly Opened[];
  readonly counts: {
    readonly asked: number;
    readonly opened: number;
    readonly sidecarUnavailable: number;
    readonly runNotFound: number;
    readonly seqNotFound: number;
  };
  readonly load: Load;
  readonly lines: readonly Record<string, unknown>[];
  readonly status: number;
}

export type OpenOutcome = OpenAnswer | OpenRefused;

/** The same options a read takes: the loader's, plus the reading program's identity and its sinks. */
export type OpenOptions = QueryOptions;


const isRef = (r: { readonly run?: unknown; readonly seq?: unknown }): boolean =>
  r !== null && typeof r === "object" && typeof r.run === "string" && r.run.length > 0
  && typeof r.seq === "number" && Number.isInteger(r.seq) && r.seq >= 0;

export type OpenPlan = { readonly refused: false; readonly query: AcceptedQuery; readonly records: readonly RecordRef[] } | OpenRefused;

/**
 * The refusal rules for a drill-down, as a pure function: a query's rules for the asker, the view,
 * the window and the note, and two of its own for the ids.
 */
export function planOpen(request: OpenRequest): OpenPlan {
  const ids = request.records;
  // The budget is the ids: one record per id asked, stated rather than defaulted.
  const n = Array.isArray(ids) && ids.length > 0 ? ids.length : 1;
  const plan = planQuery({
    ...(request.asker === undefined ? {} : { asker: request.asker }),
    ...(request.view === undefined ? {} : { view: request.view }),
    ...(request.window === undefined ? {} : { window: request.window }),
    ...(request.note === undefined ? {} : { note: request.note }),
    budget: { records: n },
  });
  const refusals: OpenRefusal[] = plan.refused ? [...plan.refusals] : [];
  if (!Array.isArray(ids) || ids.length === 0) {
    refusals.push({
      code: "open.records_missing", field: "records",
      problem: "the drill-down names no records to open",
      remedy: "name at least one record by (run, seq), as a parley.lens names them in its records",
      section: "§9",
    });
  } else if (!ids.every(isRef)) {
    refusals.push({
      code: "open.records_invalid", field: "records",
      problem: "a record is not named by a non-empty run and a non-negative integer seq",
      remedy: "name each record as {run, seq}, exactly as a parley.lens carries it",
      section: "§1.3",
    });
  }
  if (refusals.length > 0 || plan.refused || !Array.isArray(ids)) return { refused: true, refusals };
  return { refused: false, query: plan.query, records: ids.map((r) => ({ run: r.run as string, seq: r.seq as number })) };
}

function ruling(bundle: Bundle): BundleRuling {
  return { terminated: bundle.terminated, status: bundle.status, redacted: bundle.redacted, replay: bundle.replay };
}

function sidecarProblem(s: SidecarResolution): string {
  return s.state === "unchecked"
    ? `the sidecar at ${s.path} was not resolved, so its contents are not established either way`
    : `the sidecar at ${s.path} holding seq ${s.source} is ${s.state.replace("_", " ")}, so the record it stands for cannot be opened`;
}

/** Resolve one id against the load. Pure over the load: it reads nothing further. */
export function openOne(id: RecordRef, bundles: ReadonlyMap<string, Bundle>): Opened {
  const bundle = bundles.get(id.run);
  if (!bundle) {
    return {
      id, outcome: "run_not_found",
      problem: `no receipt in either location holds run ${id.run}`,
      remedy: "check the working directory the read was made against: receipts are found under the initial working directory of the run that wrote them (§5)",
    };
  }
  const bundleRuling = ruling(bundle);
  const record = bundle.records.find((r) => r.seq === id.seq);
  // A sidecar involved in this id: the id is the `sidecar` event, or the record it holds.
  const sidecar = bundle.sidecars.find((s) => s.seq === id.seq) ?? bundle.sidecars.find((s) => s.source === id.seq);
  if (sidecar && sidecar.state !== "intact") {
    // The pointer is what there is; the contents are not claimed. When the id was the record the
    // sidecar holds, the pointer is its stand-in (§5), so it is the record returned.
    const pointer = bundle.records.find((r) => r.seq === sidecar.seq);
    return {
      id, outcome: "sidecar_unavailable",
      ...(pointer === undefined ? {} : { record: pointer }),
      sidecar, bundle: bundleRuling,
      problem: sidecarProblem(sidecar),
      remedy: sidecar.state === "unchecked"
        ? "open it again with sidecar resolution on"
        : "the receipt and its sidecars are one bundle (§5): restore the bundle from wherever it was copied whole",
    };
  }
  if (!record) {
    return {
      id, outcome: "seq_not_found", bundle: bundleRuling,
      problem: `run ${id.run} holds no record at seq ${id.seq}`,
      remedy: "name a seq the run's receipt holds; a quarantined line has no seq and cannot be opened (§1.4)",
    };
  }
  if (sidecar && sidecar.seq === id.seq) {
    const held = bundle.records.find((r) => r.seq === sidecar.source);
    return { id, outcome: "opened", record, ...(held === undefined ? {} : { held }), sidecar, bundle: bundleRuling };
  }
  return { id, outcome: "opened", record, ...(sidecar === undefined ? {} : { sidecar }), bundle: bundleRuling };
}

/**
 * Open records by identity: refuse, or record the drill-down and answer it with one outcome per id.
 *
 * A refused drill-down writes nothing. An accepted one is a run of its own, like a query: its
 * `parley.query` record names the ids, a `receipt.step` states what it found, and its own records
 * are never in its answer.
 */
export async function openRecords(request: OpenRequest, opts: OpenOptions = {}): Promise<OpenOutcome> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const plan = planOpen({ ...request, asker: { ...request.asker, cwd: request.asker?.cwd ?? cwd } });
  if (plan.refused) return plan;
  const { query, records: ids } = plan;

  const env = opts.env ?? process.env;
  const stdout = new Tee(opts.stdout);
  const stderr = new Tee(opts.stderr);
  const identity = opts.tool ?? READER;

  const spec = defineTool({
    name: identity.name,
    version: identity.version,
    commands: {
      open: {
        intent: "Open records by (run, seq) from this working directory's receipt bundles, and record the drill-down",
        effects: {
          reads: [`${repoReceiptDir(cwd)}/*`, `${stateReceiptDir({ ...opts, cwd })}/*`],
          writes: [],
          network: false,
          idempotent: true,
        },
        secrets: [],
        emits: [{ ...QUERY_SCHEMA }],
      },
    },
    retention: { count: NO_RETENTION },
  });

  let answer: Omit<OpenAnswer, "status" | "lines"> | undefined;
  const status = await main(spec, [spec.name, "open"], (run) => {
    const seq = run.result({ ...queryRecord(query), records: ids }, QUERY_SCHEMA);
    run.step(
      `recorded the drill-down into ${ids.length} record(s) before opening them`,
      "spec §9: reading history is an act, so opening records is recorded like any other read, and the next reader can see which records were opened (flyingrobots/parley#51)",
      { view: query.view, window: query.window, asked: ids.length },
    );

    const load = loadReceipts({ cwd, env, ...(opts.home === undefined ? {} : { home: opts.home }), ...(opts.sidecars === undefined ? {} : { sidecars: opts.sidecars }), ...(opts.validate === undefined ? {} : { validate: opts.validate }), ...(opts.history === undefined ? {} : { history: opts.history }) });
    // A read does not answer itself: its own bundle is not among those an id can resolve to.
    const bundles = new Map(load.bundles.filter((b) => b.run !== run.id).map((b) => [b.run, b]));
    const opened = ids.map((id) => openOne(id, bundles));
    const count = (k: OpenOutcomeKind) => opened.filter((o) => o.outcome === k).length;
    const counts = {
      asked: ids.length,
      opened: count("opened"),
      sidecarUnavailable: count("sidecar_unavailable"),
      runNotFound: count("run_not_found"),
      seqNotFound: count("seq_not_found"),
    };

    run.step(
      `opened ${counts.opened} of ${counts.asked} record(s)`,
      "an id that does not resolve, or whose sidecar cannot be established, is that id's outcome rather than a failure of the read: one broken id must not lose the others",
      {
        asked: counts.asked, opened: counts.opened, sidecar_unavailable: counts.sidecarUnavailable,
        run_not_found: counts.runNotFound, seq_not_found: counts.seqNotFound,
        replay_unavailable: opened.filter((o) => o.bundle?.replay.unavailable === true).length,
      },
    );

    answer = {
      refused: false,
      run: run.id,
      receipt: run.receiptPath,
      query: { run: run.id, seq },
      asker: query.asker,
      view: query.view,
      window: query.window,
      ...(query.note === undefined ? {} : { note: query.note }),
      records: ids,
      opened,
      counts,
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
    // What enters `inv` is the question (§2.2): the ids, the view and the window, with the asker's
    // tool and task. `asker.cwd` moves with the process, so it is left out, as a query leaves it.
    resolved: () => ({
      command: "open",
      records: ids,
      view: query.view,
      window: query.window,
      asker: { tool: query.asker.tool, ...(query.asker.task === undefined ? {} : { task: query.asker.task }) },
    }),
  });

  const lines = stdout.lines
    .map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
    .filter((l): l is Record<string, unknown> => l !== null);

  if (!answer) throw new Error(`the drill-down did not complete: status ${status}; see the receipt it recorded`);
  return { ...answer, lines, status };
}
