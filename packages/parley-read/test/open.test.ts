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
    _schema: { id: "parley.receipt.head", version: "2.0.0" },
  };
}

function step(run: string, seq: number, decision = "read a.txt as UTF-8") {
  return {
    event: "receipt.step", t: T0 + seq, seq, run, decision, because: "no BOM and no @charset",
    _schema: { id: "parley.receipt.step", version: "1.0.0" },
  };
}

function end(run: string, seq: number, receipt: string, status = 0) {
  return { event: "end", t: T0 + 100, seq, run, status, receipt, redacted: false, _schema: { id: "parley.end", version: "1.0.0" } };
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
    { event: "sidecar", t: T0 + 60, seq: 3, run, source: 2, path: rel, bytes, sha256: sha(stored), _schema: { id: "parley.sidecar", version: "1.0.0" } },
    end(run, 4, receiptPath),
  ]);
  return { storedPath, stored, bytes };
}

function opened(outcome: OpenOutcome): OpenAnswer {
  if (outcome.refused) throw new Error(`refused: ${outcome.refusals.map((r) => r.code).join(", ")}`);
  return outcome;
}

function answered(outcome: QueryOutcome): QueryAnswer {
  if (outcome.refused) throw new Error(`refused: ${outcome.refusals.map((r) => r.code).join(", ")}`);
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
    expect(answer.counts).toEqual({ asked: 3, opened: 3, sidecarUnavailable: 0, runNotFound: 0, seqNotFound: 0 });
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
    expect(answer.counts).toEqual({ asked: 3, opened: 1, sidecarUnavailable: 0, runNotFound: 1, seqNotFound: 1 });
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
    expect((q.validation as { schema: { id: string; version: string } }).schema).toEqual({ id: "parley.query", version: "1.0.0" });
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
