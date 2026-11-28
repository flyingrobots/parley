// The drill-down (flyingrobots/parley#51): full records by `(run, seq)`, the identity a digest
// names them by. RD-30 to RD-34 in docs/topics/parley-read/test-plan.md.
//
// The fixtures here are deliberately the same shapes as parley-read.test.ts's, written out again
// rather than imported: a test file is not a module, and the cases below read on their own.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  loadReceipts,
  openRecords,
  queryReceipts,
  validator,
  type LoadedRecord,
  type OpenAnswer,
  type OpenDeclined,
  type OpenOutcome,
  type Opened,
  type QueryAnswer,
  type QueryOutcome,
} from "../src/index.ts";

const RUN_A = "01M81NYC9E28S33150VJB8ZP7E";
const RUN_B = "01M81P0Q7R3T5W8Y9Z2B4D6F8H";
const RUN_C = "01M81P0Q7R3T5W8Y9Z2B4D6F9J";
const T0 = 1795326412346;
const WIDE = { from: 0, to: T0 + 365 * 86_400_000 };
const ASKER = { tool: "t", task: "flyingrobots/parley#51" };

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "parley-open-"));
  const state = mkdtempSync(join(tmpdir(), "parley-open-state-"));
  return { dir, state, env: { XDG_STATE_HOME: state } as Record<string, string> };
}

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const repoReceipts = (cwd: string) => join(cwd, ".parley", "receipts");

function head(run: string) {
  return {
    event: "receipt.head", t: T0, seq: 1, run, tool: "t", v: "0.0.1",
    argv: ["t", "count"], resolved: { command: "count" }, inputs: [],
    _schema: { id: "parley-vous.receipt.head", version: "1.0.0" },
  };
}

function step(run: string, seq: number, decision = "read a.txt as UTF-8") {
  return {
    event: "receipt.step", t: T0 + seq, seq, run, decision, because: "no BOM and no @charset",
    _schema: { id: "parley-vous.receipt.step", version: "1.0.0" },
  };
}

function end(run: string, seq: number, receipt: string, status = 0) {
  return { event: "end", t: T0 + 100, seq, run, status, receipt, redacted: false, _schema: { id: "parley-vous.end", version: "1.0.0" } };
}

function toolResult(run: string, seq: number, over: Record<string, unknown> = {}) {
  return { event: "result", t: T0 + 50, seq, run, value: 1, ...over, _schema: { id: "t.count", version: "1.0.0" } };
}

function writeReceipt(dir: string, run: string, lines: object[]): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${run}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

/** Head, four decisions, end: five records worth opening, seq 1 to 6. */
function fiveSteps(dir: string, run = RUN_A, status = 0): string {
  const path = join(dir, `${run}.jsonl`);
  return writeReceipt(dir, run, [head(run), step(run, 2, "first"), step(run, 3, "second"), step(run, 4, "third"), step(run, 5, "fourth"), end(run, 6, path, status)]);
}

/** A run whose result at seq 2 is stored beside the receipt, with the `sidecar` event at seq 3. */
function withSidecar(dir: string, run = RUN_A) {
  const stored = JSON.stringify(toolResult(run, 2, { rows: Array.from({ length: 10 }, (_, i) => ({ i })) }));
  const rel = `${run}/2.json`;
  const receiptPath = join(dir, `${run}.jsonl`);
  const storedPath = resolve(dir, rel);
  mkdirSync(dirname(storedPath), { recursive: true });
  writeFileSync(storedPath, stored);
  const bytes = Buffer.byteLength(stored, "utf8");
  writeReceipt(dir, run, [
    head(run),
    { event: "sidecar", t: T0 + 60, seq: 3, run, source: 2, path: rel, bytes, sha256: sha(stored), _schema: { id: "parley-vous.sidecar", version: "1.0.0" } },
    end(run, 4, receiptPath),
  ]);
  return { storedPath, stored, bytes };
}

function opened(outcome: OpenOutcome): OpenAnswer {
  if (outcome.refused) throw new Error(`refused: ${outcome.refusals.map((r) => r.code).join(", ")}`);
  if (outcome.declined) throw new Error(`declined: ${outcome.decline.problem}`);
  return outcome;
}

function answered(outcome: QueryOutcome): QueryAnswer {
  if (outcome.refused) throw new Error(`refused: ${outcome.refusals.map((r) => r.code).join(", ")}`);
  if (outcome.declined) throw new Error(`declined: ${outcome.decline.problem}`);
  return outcome;
}

const loadedAt = (dir: string, env: Record<string, string>, run: string, seq: number): LoadedRecord =>
  loadReceipts({ cwd: dir, env }).bundles.find((b) => b.run === run)!.records.find((r) => r.seq === seq)!;

const kinds = (answer: OpenAnswer) => answer.opened.map((o) => o.outcome);
const recordOf = (o: Opened) => { if (!o.record) throw new Error(`no record for ${o.id.run}:${o.id.seq}: ${o.outcome}`); return o.record; };

/** The writer's own example tool, run as a real process so the receipts under test are real. */
const COUNT_EXAMPLE = resolve(import.meta.dir, "../../parley-emit/examples/count.ts");

function realRun(dir: string, state: string) {
  const spawned = Bun.spawnSync({
    cmd: [process.execPath, "run", COUNT_EXAMPLE, "files"],
    cwd: dir,
    env: { ...process.env, XDG_STATE_HOME: state },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = new TextDecoder().decode(spawned.stdout);
  const boot = JSON.parse(out.split("\n")[0]!) as { run: string };
  return { status: spawned.exitCode, run: boot.run };
}

// ---- RD-30 ------------------------------------------------------------------------------------

describe("RD-30 a drill-down opens records by identity, in full", () => {
  test("a drill-down answers every id in the order asked, in full", async () => {
    const { dir, env } = scratch();
    fiveSteps(repoReceipts(dir));
    const ids = [{ run: RUN_A, seq: 4 }, { run: RUN_A, seq: 1 }, { run: RUN_A, seq: 6 }];
    const answer = opened(await openRecords({ asker: ASKER, view: "how-it-decided", window: WIDE, records: ids }, { cwd: dir, env }));
    expect(answer.opened.map((o) => o.id)).toEqual(ids);
    expect(kinds(answer)).toEqual(["opened", "opened", "opened"]);
    for (const o of answer.opened) {
      expect(recordOf(o).record).toEqual(loadedAt(dir, env, o.id.run, o.id.seq).record);
    }
    expect((recordOf(answer.opened[0]!).record as { decision: string }).decision).toBe("third");
    expect(answer.counts).toEqual({ asked: 3, opened: 3, sidecarUnavailable: 0, runNotFound: 0, seqNotFound: 0, overBudget: 0 });
  });

  test("every id a digest names opens to the record the read answered with", async () => {
    const { dir, env } = scratch();
    fiveSteps(repoReceipts(dir), RUN_A);
    fiveSteps(repoReceipts(dir), RUN_B, 2);
    const read = answered(await queryReceipts({ asker: ASKER, view: "what-failed", window: WIDE, budget: { records: 5 } }, { cwd: dir, env }));
    expect(read.digest.records.length).toBe(5);
    const answer = opened(await openRecords({ asker: ASKER, view: read.view, window: read.window, records: read.digest.records }, { cwd: dir, env }));
    expect(kinds(answer)).toEqual(["opened", "opened", "opened", "opened", "opened"]);
    answer.opened.forEach((o, i) => {
      expect(recordOf(o).record).toEqual(read.records[i]!.record);
    });
  });

  test("a drill-down sees the history segments a load would", async () => {
    const { dir, env } = scratch();
    // A run present only on the shared stream (§8): one plain segment, no receipt in either location.
    const segmentDir = mkdtempSync(join(tmpdir(), "parley-open-history-"));
    const segment = fiveSteps(segmentDir, RUN_B);
    const ids = [{ run: RUN_B, seq: 3 }];
    const without = opened(await openRecords({ asker: ASKER, view: "everything", window: WIDE, records: ids }, { cwd: dir, env }));
    expect(kinds(without)).toEqual(["run_not_found"]);
    const withSegment = opened(await openRecords({ asker: ASKER, view: "everything", window: WIDE, records: ids }, { cwd: dir, env, history: [segment] }));
    expect(kinds(withSegment)).toEqual(["opened"]);
    const loaded = loadReceipts({ cwd: dir, env, history: [segment] }).bundles.find((b) => b.run === RUN_B)!.records.find((r) => r.seq === 3)!;
    expect(recordOf(withSegment.opened[0]!).record).toEqual(loaded.record);
  });

  test("an id asked twice is answered twice", async () => {
    const { dir, env } = scratch();
    fiveSteps(repoReceipts(dir));
    const ids = [{ run: RUN_A, seq: 2 }, { run: RUN_A, seq: 3 }, { run: RUN_A, seq: 2 }];
    const answer = opened(await openRecords({ asker: ASKER, view: "everything", window: WIDE, records: ids }, { cwd: dir, env }));
    expect(answer.opened.length).toBe(3);
    expect(kinds(answer)).toEqual(["opened", "opened", "opened"]);
    expect(recordOf(answer.opened[0]!).record).toEqual(recordOf(answer.opened[2]!).record);
  });
});

// ---- RD-31 ------------------------------------------------------------------------------------

describe("RD-31 a sidecar opens with its contents, or says why not", () => {
  test("a record stored in a sidecar opens with its contents", async () => {
    const { dir, env } = scratch();
    const { stored } = withSidecar(repoReceipts(dir));
    const answer = opened(await openRecords({ asker: ASKER, view: "what-changed", window: WIDE, records: [{ run: RUN_A, seq: 2 }] }, { cwd: dir, env }));
    const [o] = answer.opened;
    expect(o!.outcome).toBe("opened");
    expect(recordOf(o!).fromSidecar).toBe(true);
    expect(JSON.stringify(recordOf(o!).record)).toBe(stored);
    expect((recordOf(o!).record as { rows: unknown[] }).rows.length).toBe(10);
    expect(o!.sidecar!.state).toBe("intact");
    expect(o!.sidecar!.actual!.sha256).toBe(o!.sidecar!.declared.sha256!);
  });

  test("opening the sidecar pointer brings the record it holds", async () => {
    const { dir, env } = scratch();
    const { stored } = withSidecar(repoReceipts(dir));
    const answer = opened(await openRecords({ asker: ASKER, view: "what-changed", window: WIDE, records: [{ run: RUN_A, seq: 3 }] }, { cwd: dir, env }));
    const [o] = answer.opened;
    expect(o!.outcome).toBe("opened");
    expect(recordOf(o!).event).toBe("sidecar");
    expect(o!.held!.seq).toBe(2);
    expect(JSON.stringify(o!.held!.record)).toBe(stored);
    expect(o!.sidecar!.state).toBe("intact");
  });

  test("a missing sidecar is that id's outcome and does not lose the others", async () => {
    const { dir, env } = scratch();
    const { storedPath } = withSidecar(repoReceipts(dir));
    fiveSteps(repoReceipts(dir), RUN_B);
    rmSync(storedPath);
    const ids = [{ run: RUN_A, seq: 2 }, { run: RUN_A, seq: 3 }, { run: RUN_B, seq: 3 }];
    const answer = opened(await openRecords({ asker: ASKER, view: "what-changed", window: WIDE, records: ids }, { cwd: dir, env }));
    expect(kinds(answer)).toEqual(["sidecar_unavailable", "sidecar_unavailable", "opened"]);
    for (const o of answer.opened.slice(0, 2)) {
      expect(o.sidecar!.state).toBe("missing");
      expect(o.held).toBeUndefined();
      // What is there is the pointer, and only the pointer: no contents are claimed.
      expect(recordOf(o).event).toBe("sidecar");
      expect(o.problem).toContain("missing");
      expect(o.bundle!.replay.reasons).toContain("sidecar.missing");
    }
    expect(answer.counts.sidecarUnavailable).toBe(2);
    expect(answer.counts.opened).toBe(1);
  });

  test("a mismatched sidecar is reported, not opened", async () => {
    const { dir, env } = scratch();
    const { storedPath, stored } = withSidecar(repoReceipts(dir));
    writeFileSync(storedPath, stored.replace('"i":0', '"i":9'));
    const answer = opened(await openRecords({ asker: ASKER, view: "what-changed", window: WIDE, records: [{ run: RUN_A, seq: 2 }] }, { cwd: dir, env }));
    const [o] = answer.opened;
    expect(o!.outcome).toBe("sidecar_unavailable");
    expect(o!.sidecar!.state).toBe("digest_mismatch");
    expect(o!.sidecar!.declared.sha256).toBe(sha(stored));
    expect(o!.sidecar!.actual!.sha256).not.toBe(sha(stored));
  });

  test("with resolution off a sidecar is unchecked, never intact", async () => {
    const { dir, env } = scratch();
    withSidecar(repoReceipts(dir));
    const answer = opened(await openRecords({ asker: ASKER, view: "what-changed", window: WIDE, records: [{ run: RUN_A, seq: 2 }, { run: RUN_A, seq: 3 }] }, { cwd: dir, env, sidecars: false }));
    expect(kinds(answer)).toEqual(["sidecar_unavailable", "sidecar_unavailable"]);
    expect(answer.opened.map((o) => o.sidecar!.state)).toEqual(["unchecked", "unchecked"]);
  });
});

// ---- RD-32 ------------------------------------------------------------------------------------

describe("RD-32 an id that does not resolve, and a bundle that cannot be replayed", () => {
  test("an id that does not resolve says which half did not", async () => {
    const { dir, env } = scratch();
    fiveSteps(repoReceipts(dir));
    const ids = [{ run: RUN_C, seq: 1 }, { run: RUN_A, seq: 99 }, { run: RUN_A, seq: 2 }];
    const answer = opened(await openRecords({ asker: ASKER, view: "everything", window: WIDE, records: ids }, { cwd: dir, env }));
    expect(kinds(answer)).toEqual(["run_not_found", "seq_not_found", "opened"]);
    for (const o of answer.opened.slice(0, 2)) {
      expect(o.record).toBeUndefined();
      expect(o.problem!.length).toBeGreaterThan(0);
      expect(o.remedy!.length).toBeGreaterThan(0);
    }
    expect(answer.opened[0]!.bundle).toBeUndefined();
    expect(answer.opened[1]!.bundle!.terminated).toBe(true);
    expect(answer.counts).toEqual({ asked: 3, opened: 1, sidecarUnavailable: 0, runNotFound: 1, seqNotFound: 1, overBudget: 0 });
  });

  test("a record whose bundle is unavailable for replay still opens and says so", async () => {
    const { dir, env } = scratch();
    const receipts = repoReceipts(dir);
    writeReceipt(receipts, RUN_A, [head(RUN_A), step(RUN_A, 2)]); // no end: it never terminated
    fiveSteps(receipts, RUN_B, 2); // ended with status 2
    const answer = opened(await openRecords({ asker: ASKER, view: "what-failed", window: WIDE, records: [{ run: RUN_A, seq: 2 }, { run: RUN_B, seq: 6 }] }, { cwd: dir, env }));
    expect(kinds(answer)).toEqual(["opened", "opened"]);
    const [unended, failed] = answer.opened;
    expect(recordOf(unended!).record).toEqual(loadedAt(dir, env, RUN_A, 2).record);
    expect(unended!.bundle!.replay.unavailable).toBe(true);
    expect(unended!.bundle!.replay.reasons).toContain("receipt.no_end");
    expect(unended!.bundle!.terminated).toBe(false);
    expect((recordOf(failed!).record as { status: number }).status).toBe(2);
    expect(failed!.bundle!.replay.reasons).toContain("end.status_nonzero");
    expect(failed!.bundle!.status).toBe(2);
  });
});

// ---- RD-33 ------------------------------------------------------------------------------------

describe("RD-33 a drill-down is a recorded read", () => {
  test("a drill-down that cannot state its question is refused and writes nothing", async () => {
    const { dir, state, env } = scratch();
    const id = [{ run: RUN_A, seq: 1 }];
    const codes = async (request: Parameters<typeof openRecords>[0]) => {
      const outcome = await openRecords(request, { cwd: dir, env });
      if (!outcome.refused) throw new Error("accepted; it should have been refused");
      for (const r of outcome.refusals) {
        expect(r.code).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/);
        expect(r.problem.length).toBeGreaterThan(0);
        expect(r.remedy.length).toBeGreaterThan(0);
      }
      return outcome.refusals.map((r) => r.code).sort();
    };
    expect(await codes({ view: "everything", window: WIDE, records: id })).toEqual(["query.asker_unnamed"]);
    expect(await codes({ asker: ASKER, window: WIDE, records: id })).toEqual(["query.view_missing"]);
    expect(await codes({ asker: ASKER, view: "everything", records: id })).toEqual(["query.window_missing"]);
    expect(await codes({ asker: ASKER, view: "everything", window: WIDE })).toEqual(["open.records_missing"]);
    expect(await codes({ asker: ASKER, view: "everything", window: WIDE, records: [] })).toEqual(["open.records_missing"]);
    expect(await codes({ asker: ASKER, view: "everything", window: WIDE, records: [{ run: "", seq: 1 }] })).toEqual(["open.records_invalid"]);
    expect(await codes({ asker: ASKER, view: "everything", window: WIDE, records: [{ run: RUN_A, seq: -1 }] })).toEqual(["open.records_invalid"]);
    expect(await codes({ asker: ASKER, view: "everything", window: WIDE, records: [{ run: RUN_A, seq: 1.5 }] })).toEqual(["open.records_invalid"]);
    expect(await codes({})).toEqual(["open.records_missing", "query.asker_unnamed", "query.view_missing", "query.window_missing"]);
    expect(existsSync(join(dir, ".parley"))).toBe(false);
    expect(readdirSync(state)).toEqual([]);
  });

  test("a drill-down is recorded as a query naming the ids it opens", async () => {
    const { dir, env } = scratch();
    fiveSteps(repoReceipts(dir));
    const ids = [{ run: RUN_A, seq: 2 }, { run: RUN_C, seq: 1 }];
    const answer = opened(await openRecords({ asker: ASKER, view: "how-it-decided", window: WIDE, records: ids, note: "resuming" }, { cwd: dir, env }));
    expect(answer.status).toBe(0);
    const load = loadReceipts({ cwd: dir, env });
    const own = load.bundles.find((b) => b.run === answer.run)!;
    expect(own.terminated).toBe(true);
    expect(own.status).toBe(0);
    expect(own.defects).toEqual([]);
    const queries = own.records.filter((r) => r.event === "query");
    expect(queries.length).toBe(1);
    const q = queries[0]!;
    expect(q.seq).toBe(answer.query.seq);
    expect(q.validation.state).toBe("validated");
    expect((q.validation as { schema: { id: string; version: string } }).schema).toEqual({ id: "parley-vous.query", version: "1.0.0" });
    const record = q.record as Record<string, unknown>;
    expect(record.records).toEqual(ids);
    expect(record.view).toBe("how-it-decided");
    expect(record.window).toEqual(WIDE);
    expect(record.budget).toEqual({ records: 2 });
    expect((record.asker as { tool: string }).tool).toBe("t");
    expect(record.note).toBe("resuming");
    // The outcome is a decision in the receipt, so the next reader sees what the drill-down found.
    const steps = own.records.filter((r) => r.event === "receipt.step").map((r) => r.record as { detail?: Record<string, unknown> });
    expect(steps.some((s) => s.detail?.opened === 1 && s.detail?.run_not_found === 1)).toBe(true);
    // Its own records are nowhere in the answer: a read does not answer itself.
    expect(answer.opened.some((o) => o.record?.run === answer.run)).toBe(false);
    expect(load.counts.invalid).toBe(0);
    expect(load.quarantined).toEqual([]);
    // The query line on the drill-down's own stream validates on its own, too.
    const line = answer.lines.find((l) => l.event === "query")!;
    expect(validator().validate(line).state).toBe("validated");
  });

  test("a drill-down's own record can be opened by the next one", async () => {
    const { dir, env } = scratch();
    fiveSteps(repoReceipts(dir));
    const ids = [{ run: RUN_A, seq: 5 }];
    const first = opened(await openRecords({ asker: ASKER, view: "everything", window: WIDE, records: ids }, { cwd: dir, env }));
    const second = opened(await openRecords({ asker: ASKER, view: "everything", window: WIDE, records: [first.query] }, { cwd: dir, env }));
    const [o] = second.opened;
    expect(o!.outcome).toBe("opened");
    expect(recordOf(o!).event).toBe("query");
    expect((recordOf(o!).record as { records: unknown }).records).toEqual(ids);
  });
});

// ---- RD-34 ------------------------------------------------------------------------------------

describe("RD-34 every id a real digest names opens", () => {
  test("every id a real digest names opens", async () => {
    const { dir, state, env } = scratch();
    writeFileSync(join(dir, "a.txt"), "hello");
    const first = realRun(dir, state);
    symlinkSync(join(dir, "nothing-here"), join(dir, "dangling"));
    const broke = realRun(dir, state);
    rmSync(join(dir, "dangling"));
    const third = realRun(dir, state);
    expect([first.status, broke.status, third.status]).toEqual([0, 2, 0]);

    const window = { from: 0, to: Date.now() };
    const read = answered(await queryReceipts({ asker: ASKER, view: "what-changed", window, budget: { records: 4 } }, { cwd: dir, env }));
    // The ids come from the lens as the receipt holds it, not from the answer object: a cold
    // reader has the receipt and nothing else.
    const lens = loadReceipts({ cwd: dir, env }).bundles.find((b) => b.run === read.run)!.records.find((r) => r.event === "lens")!;
    const ids = (lens.record as { records: { run: string; seq: number }[] }).records;
    expect(ids.length).toBe(4);

    const answer = opened(await openRecords({ asker: ASKER, view: "what-changed", window, records: ids }, { cwd: dir, env }));
    expect(kinds(answer)).toEqual(["opened", "opened", "opened", "opened"]);
    const [top] = answer.opened;
    expect(recordOf(top!).run).toBe(broke.run);
    expect(recordOf(top!).event).toBe("error");
    expect(top!.bundle!.replay.unavailable).toBe(true);
    expect(top!.bundle!.replay.reasons).toContain("end.status_nonzero");
    const load = loadReceipts({ cwd: dir, env });
    for (const o of answer.opened) {
      const loaded = load.bundles.find((b) => b.run === o.id.run)!.records.find((r) => r.seq === o.id.seq)!;
      expect(recordOf(o).record).toEqual(loaded.record);
      expect(recordOf(o).validation.state).toBe(loaded.validation.state);
    }
  }, 60_000);
});

// ---- RD-60 ------------------------------------------------------------------------------------

/** The size a record has as returned: the UTF-8 bytes of its JSON, the definition the module states. */
const sizeOf = (r: LoadedRecord | undefined): number => (r === undefined ? 0 : Buffer.byteLength(JSON.stringify(r), "utf8"));
const costOf = (o: Opened): number => sizeOf(o.record) + sizeOf(o.held);

/** Head, three large results (seq 2 to 4, about 6 KB each), a small step at 5, end at 6. */
function bigResults(dir: string, run = RUN_A): string {
  const path = join(dir, `${run}.jsonl`);
  const big = (seq: number) => toolResult(run, seq, { report: `${"r".repeat(6000)}${seq}` });
  return writeReceipt(dir, run, [head(run), big(2), big(3), big(4), step(run, 5, "small"), end(run, 6, path)]);
}

const ask = (records: { run: string; seq: number }[], bytes?: number) => ({
  asker: ASKER, view: "how-it-decided" as const, window: WIDE, records,
  ...(bytes === undefined ? {} : { budget: { bytes } }),
});

describe("RD-60 a byte budget on the drill-down: whole records up to the bound, over_budget past it", () => {
  test("a bound that fits two of three large records opens two and refuses the third", async () => {
    const { dir, env } = scratch();
    bigResults(repoReceipts(dir));
    const ids = [2, 3, 4].map((seq) => ({ run: RUN_A, seq }));
    const each = sizeOf(loadedAt(dir, env, RUN_A, 2));
    const answer = opened(await openRecords(ask(ids, each * 2 + 100), { cwd: dir, env }));
    expect(kinds(answer)).toEqual(["opened", "opened", "over_budget"]);
    const [a, b, c] = answer.opened;
    expect(recordOf(a!)).toEqual(loadedAt(dir, env, RUN_A, 2));
    expect(recordOf(b!)).toEqual(loadedAt(dir, env, RUN_A, 3));
    expect(c!.bytes).toBe(sizeOf(loadedAt(dir, env, RUN_A, 4)));
    expect(c!.record).toBeUndefined();
    expect(c!.held).toBeUndefined();
    expect(c!.problem).toContain("budget");
    expect(c!.remedy).toBeTruthy();
    expect(c!.bundle?.terminated).toBe(true);
    expect(answer.counts).toEqual({ asked: 3, opened: 2, sidecarUnavailable: 0, runNotFound: 0, seqNotFound: 0, overBudget: 1 });
  });

  test("the bound is inclusive", async () => {
    const { dir, env } = scratch();
    bigResults(repoReceipts(dir));
    const ids = [2, 3].map((seq) => ({ run: RUN_A, seq }));
    const total = sizeOf(loadedAt(dir, env, RUN_A, 2)) + sizeOf(loadedAt(dir, env, RUN_A, 3));
    expect(kinds(opened(await openRecords(ask(ids, total), { cwd: dir, env })))).toEqual(["opened", "opened"]);
    expect(kinds(opened(await openRecords(ask(ids, total - 1), { cwd: dir, env })))).toEqual(["opened", "over_budget"]);
  });

  test("a bound smaller than the first record refuses it and still opens a later small one", async () => {
    const { dir, env } = scratch();
    bigResults(repoReceipts(dir));
    const ids = [{ run: RUN_A, seq: 2 }, { run: RUN_A, seq: 5 }];
    const small = sizeOf(loadedAt(dir, env, RUN_A, 5));
    const answer = opened(await openRecords(ask(ids, small + 10), { cwd: dir, env }));
    expect(kinds(answer)).toEqual(["over_budget", "opened"]);
    expect(answer.opened.map((o) => o.id)).toEqual(ids);
    expect(answer.opened[0]!.bytes).toBeGreaterThan(small + 10);
  });

  test("a sidecar record is sized by its contents", async () => {
    const { dir, env } = scratch();
    withSidecar(repoReceipts(dir));
    const rec = loadedAt(dir, env, RUN_A, 2);
    const contents = sizeOf(rec);
    expect(contents).toBeGreaterThan(100);
    const byRecord = [{ run: RUN_A, seq: 2 }];
    const below = opened(await openRecords(ask(byRecord, contents - 1), { cwd: dir, env }));
    expect(kinds(below)).toEqual(["over_budget"]);
    expect(below.opened[0]!.bytes).toBe(contents);
    expect(kinds(opened(await openRecords(ask(byRecord, contents), { cwd: dir, env })))).toEqual(["opened"]);
    // The pointer is not a way past the bound: it is sized by the record as returned plus what it holds.
    const byPointer = [{ run: RUN_A, seq: 3 }];
    const full = opened(await openRecords(ask(byPointer), { cwd: dir, env })).opened[0]!;
    const cost = costOf(full);
    expect(cost).toBeGreaterThan(contents);
    const refused = opened(await openRecords(ask(byPointer, cost - 1), { cwd: dir, env })).opened[0]!;
    expect(refused.outcome).toBe("over_budget");
    expect(refused.bytes).toBe(cost);
    expect(refused.held).toBeUndefined();
    expect(kinds(opened(await openRecords(ask(byPointer, cost), { cwd: dir, env })))).toEqual(["opened"]);
  });

  test("outcomes that return no contents cost nothing", async () => {
    const { dir, env } = scratch();
    withSidecar(repoReceipts(dir), RUN_A);
    bigResults(repoReceipts(dir), RUN_B);
    rmSync(resolve(repoReceipts(dir), `${RUN_A}/2.json`));
    const rec = loadedAt(dir, env, RUN_B, 2);
    const ids = [{ run: RUN_C, seq: 1 }, { run: RUN_B, seq: 99 }, { run: RUN_A, seq: 2 }, { run: RUN_B, seq: 2 }];
    const answer = opened(await openRecords(ask(ids, sizeOf(rec)), { cwd: dir, env }));
    expect(kinds(answer)).toEqual(["run_not_found", "seq_not_found", "sidecar_unavailable", "opened"]);
  });

  test("a record is never cut part-way", async () => {
    const { dir, env } = scratch();
    bigResults(repoReceipts(dir));
    const ids = [2, 3, 4, 5].map((seq) => ({ run: RUN_A, seq }));
    for (const bytes of [1, 5000, 6500, 13000, 20000, 25000]) {
      const answer = opened(await openRecords(ask(ids, bytes), { cwd: dir, env }));
      let used = 0;
      for (const o of answer.opened) {
        if (o.outcome === "opened") {
          expect(recordOf(o)).toEqual(loadedAt(dir, env, o.id.run, o.id.seq));
          used += costOf(o);
        } else {
          expect(o.outcome).toBe("over_budget");
          expect(o.record).toBeUndefined();
          expect(o.held).toBeUndefined();
          expect(o.bytes).toBe(sizeOf(loadedAt(dir, env, o.id.run, o.id.seq)));
        }
      }
      expect(used).toBeLessThanOrEqual(bytes);
    }
    // Six recorded drill-downs and a load after each: real I/O, which a loaded machine stretches past
    // the default 5 s. The case bounds bytes, not time.
  }, 60_000);

  test("the recorded budget is the one applied", async () => {
    const { dir, env } = scratch();
    bigResults(repoReceipts(dir));
    const ids = [2, 3, 4].map((seq) => ({ run: RUN_A, seq }));
    const answer = opened(await openRecords(ask(ids, 7000), { cwd: dir, env }));
    expect(answer.budget).toEqual({ records: 3, bytes: 7000 });
    const own = loadReceipts({ cwd: dir, env }).bundles.find((b) => b.run === answer.run)!;
    const q = own.records.find((r) => r.event === "query")!;
    expect(q.validation.state).toBe("validated");
    expect((q.record as { budget: unknown }).budget).toEqual({ records: 3, bytes: 7000 });
    const steps = own.records.filter((r) => r.event === "receipt.step").map((r) => r.record as { detail?: Record<string, unknown> });
    expect(steps.some((s) => s.detail?.opened === 1 && s.detail?.over_budget === 2)).toBe(true);
    expect(validator().validate(answer.lines.find((l) => l.event === "query")!).state).toBe("validated");

    const plain = opened(await openRecords(ask(ids), { cwd: dir, env }));
    expect(plain.budget).toEqual({ records: 3 });
    expect(kinds(plain)).toEqual(["opened", "opened", "opened"]);
  });

  test("a malformed byte bound is refused and writes nothing", async () => {
    const { dir, env } = scratch();
    bigResults(repoReceipts(dir));
    const before = readdirSync(repoReceipts(dir)).sort();
    for (const bytes of [0, -1, 1.5]) {
      const outcome = await openRecords(ask([{ run: RUN_A, seq: 2 }], bytes), { cwd: dir, env });
      expect(outcome.refused).toBe(true);
      if (outcome.refused) expect(outcome.refusals.map((r) => r.code)).toContain("query.budget_invalid");
    }
    expect(readdirSync(repoReceipts(dir)).sort()).toEqual(before);
    expect(existsSync(join(env.XDG_STATE_HOME!, "parley"))).toBe(false);
  });
});

// flyingrobots/parley#71: the drill-down applies the read's deadline rule. Its clock is called once
// at the start, once after the load and once after the ids are opened, and a scripted clock
// answers those calls in order, so nothing here sleeps.
function scripted(...values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)]!;
}

describe("RD-74 the drill-down applies the same deadline", () => {
  test("a drill-down past its deadline declines and opens nothing", async () => {
    const { dir, env } = scratch();
    fiveSteps(repoReceipts(dir));
    const ids = [{ run: RUN_A, seq: 2 }, { run: RUN_A, seq: 3 }];
    const request = { asker: ASKER, view: "everything", window: WIDE, records: ids, budget: { ms: 40 } };

    const late = await openRecords(request, { cwd: dir, env, clock: scripted(0, 41) });
    if (late.refused || !late.declined) throw new Error("the drill-down should have declined");
    const out: OpenDeclined = late;
    expect(out.status).toBe(2);
    expect(out.decline.code).toBe("query.over_budget");
    expect(out.decline.bound).toBe("ms");
    expect(out.decline.phase).toBe("load");
    expect(out.decline.measured).toEqual({ ms: 41 });
    expect(out.decline.atLeast).toEqual({ ms: 41 });
    expect("opened" in out).toBe(false);
    const own = loadReceipts({ cwd: dir, env }).bundles.find((b) => b.run === out.run)!;
    expect(own.status).toBe(2);
    const query = own.records.find((r) => r.event === "query")!;
    expect(query.validation.state).toBe("validated");
    expect((query.record as Record<string, unknown>).budget).toEqual({ records: 2, ms: 40 });
    const error = own.records.find((r) => r.event === "error")!;
    expect(error.validation.state).toBe("validated");
    expect((error.record as Record<string, unknown>).code).toBe("query.over_budget");

    const onTime = opened(await openRecords(request, { cwd: dir, env, clock: scripted(0, 30, 40) }));
    expect(onTime.status).toBe(0);
    expect(kinds(onTime)).toEqual(["opened", "opened"]);
    expect(onTime.budget).toEqual({ records: 2, ms: 40 });
  });
});
