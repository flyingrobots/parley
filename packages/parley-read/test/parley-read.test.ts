import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { defineTool, main, type HistoryTransform, type Run, type Sink, type ToolSpec } from "@flyingrobots/parley-emit";
import {
  LineBuffer,
  SCHEMAS,
  SCHEMA_SOURCE,
  VIEWS,
  foldRuns,
  loadReceipts,
  onFailureSurface,
  openRecords,
  digestBytes,
  digestFor,
  digestLine,
  RUN_SECTION_BYTES,
  planQuery,
  queryReceipts,
  rankRecords,
  readHistorySegment,
  readReceiptFile,
  receiptLocations,
  splitLines,
  sufficientBytes,
  validator,
  type Bundle,
  type LoadedRecord,
  type QueryAnswer,
  type QueryDeclined,
  type QueryOutcome,
  type QueryRefusal,
  type Ranking,
} from "../src/index.ts";

const SCHEMAS_DIR = resolve(import.meta.dir, "../../../schemas");
const RUN_A = "01M81NYC9E28S33150VJB8ZP7E";
const RUN_B = "01M81P0Q7R3T5W8Y9Z2B4D6F8H";

// ---- fixtures ----------------------------------------------------------------------------

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "parley-read-"));
  const state = mkdtempSync(join(tmpdir(), "parley-read-state-"));
  return { dir, state, env: { XDG_STATE_HOME: state } as Record<string, string> };
}

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

function head(run: string, over: Record<string, unknown> = {}) {
  return {
    event: "receipt.head", t: 1795326412346, seq: 1, run, tool: "t", v: "0.0.1",
    argv: ["t", "count"], resolved: { command: "count" }, inputs: [],
    ...over, _schema: { id: "parley.receipt.head", version: "2.0.0" },
  };
}

function step(run: string, seq: number, over: Record<string, unknown> = {}) {
  return {
    event: "receipt.step", t: 1795326412352, seq, run,
    decision: "read a.txt as UTF-8", because: "no BOM and no @charset",
    ...over, _schema: { id: "parley.receipt.step", version: "1.0.0" },
  };
}

function end(run: string, seq: number, receipt: string, over: Record<string, unknown> = {}) {
  return {
    event: "end", t: 1795326412400, seq, run, status: 0, receipt, redacted: false,
    ...over, _schema: { id: "parley.end", version: "1.0.0" },
  };
}

function toolResult(run: string, seq: number, over: Record<string, unknown> = {}) {
  return { event: "result", t: 1795326412360, seq, run, value: 1, ...over, _schema: { id: "t.count", version: "1.0.0" } };
}

function sidecar(run: string, seq: number, source: number, path: string, bytes: number, digest: string) {
  return {
    event: "sidecar", t: 1795326412390, seq, run, source, path, bytes, sha256: digest,
    _schema: { id: "parley.sidecar", version: "1.0.0" },
  };
}

/** Write a receipt file verbatim: objects are serialised, strings go in as they are. */
function writeReceipt(dir: string, run: string, lines: (object | string)[], opts: { terminate?: boolean } = {}): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${run}.jsonl`);
  const body = lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n");
  writeFileSync(path, opts.terminate === false ? body : body + "\n");
  return path;
}

function repoReceipts(cwd: string) { return join(cwd, ".parley", "receipts"); }

/** A complete, conforming bundle by hand: head, step, end. Returns its receipt path. */
function plainReceipt(dir: string, run = RUN_A, endOver: Record<string, unknown> = {}): string {
  const path = join(dir, `${run}.jsonl`);
  return writeReceipt(dir, run, [head(run), step(run, 2), end(run, 3, path, endOver)]);
}

const seqs = (b: Bundle) => b.records.map((r) => r.seq);
const byEvent = (b: Bundle, event: string): LoadedRecord | undefined => b.records.find((r) => r.event === event);

// ---- the writer, as a source of real receipts ---------------------------------------------

class Capture implements Sink {
  lines: string[] = [];
  write(line: string) { this.lines.push(line); }
  get objs() { return this.lines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, unknown>); }
}

const RESULT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://example.invalid/t/schemas/t.count/1.0.0",
  type: "object",
  required: ["event", "t", "seq", "run", "value", "_schema"],
  properties: { event: { const: "result" }, value: { type: "integer", minimum: 0 } },
};

function tool(over: Partial<ToolSpec> = {}): ToolSpec {
  return defineTool({
    name: "t", version: "0.0.1",
    commands: {
      count: {
        intent: "Count the things under the working directory",
        effects: { reads: ["<cwd>/**"], writes: [], network: false, idempotent: true },
        secrets: ["--token"],
        emits: [{ id: "t.count", version: "1.0.0", schema: RESULT_SCHEMA }],
      },
    },
    retention: { count: 100 },
    ...over,
  });
}

async function writerRun(
  cwd: string, env: Record<string, string>, argv: string[], body: (run: Run) => void | Promise<void>,
  over: { history?: { transform: HistoryTransform; name?: string } } = {},
) {
  const stdout = new Capture(), stderr = new Capture();
  const status = await main(tool(), ["t", ...argv], async (run) => { await body(run); }, { cwd, env, stdout, stderr, resolved: (args) => ({ command: "count", args }), ...over });
  const boot = stdout.objs[0] as { run?: string; paths?: { receipt?: string; history?: string } } | undefined;
  return { status, stdout, stderr, run: boot?.run, receipt: boot?.paths?.receipt, history: boot?.paths?.history };
}

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
  return { status: spawned.exitCode, run: boot.run, out };
}

// ---- RD-1 locating the two receipt locations ----------------------------------------------

describe("RD-1 locations", () => {
  test("both receipt locations are listed and nothing is created", () => {
    const { dir, state, env } = scratch();
    const locs = receiptLocations({ cwd: dir, env });
    expect(locs.map((l) => l.where)).toEqual(["repo", "state"]);
    expect(locs[0]!.dir).toBe(repoReceipts(dir));
    expect(locs[0]!.present).toBe(false);
    expect(locs[1]!.dir.startsWith(join(state, "parley"))).toBe(true);
    expect(locs[1]!.present).toBe(false);
    expect(existsSync(join(dir, ".parley"))).toBe(false);
    expect(existsSync(locs[1]!.dir)).toBe(false);
  });

  test("a receipt the writer put in the state directory is found there", async () => {
    const { dir, state, env } = scratch();
    chmodSync(dir, 0o555);
    const written = await writerRun(dir, env, ["count"], (run) => { run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" }); })
      .finally(() => chmodSync(dir, 0o755));
    expect(written.receipt!.startsWith(join(state, "parley"))).toBe(true);
    const load = loadReceipts({ cwd: dir, env });
    const bundle = load.bundles.find((b) => b.run === written.run);
    expect(bundle).toBeDefined();
    expect(bundle!.sources.map((s) => s.where)).toEqual(["state"]);
    expect(bundle!.sources[0]!.receipt).toBe(written.receipt!);
  });

  test("a missing location is reported as absent", () => {
    const { dir, env } = scratch();
    const load = loadReceipts({ cwd: dir, env });
    expect(load.locations.every((l) => l.present === false)).toBe(true);
    expect(load.bundles).toEqual([]);
    expect(load.quarantined).toEqual([]);
  });
});

// ---- RD-2 every run, in seq order ---------------------------------------------------------

describe("RD-2 every run", () => {
  test("every run under both locations is returned with its records in seq order", () => {
    const { dir, env } = scratch();
    plainReceipt(repoReceipts(dir), RUN_A);
    plainReceipt(repoReceipts(dir), RUN_B);
    const stateDir = receiptLocations({ cwd: dir, env })[1]!.dir;
    const third = "01M81P1XZZ3T5W8Y9Z2B4D6F8H";
    plainReceipt(stateDir, third);
    const load = loadReceipts({ cwd: dir, env });
    expect(load.bundles.map((b) => b.run).sort()).toEqual([RUN_A, RUN_B, third].sort());
    for (const b of load.bundles) expect(seqs(b)).toEqual([1, 2, 3]);
    expect(load.bundles.find((b) => b.run === third)!.sources[0]!.where).toBe("state");
    expect(load.bundles.find((b) => b.run === RUN_A)!.sources[0]!.where).toBe("repo");
  });

  test("records out of order in the file come back in seq order", () => {
    const { dir, env } = scratch();
    const path = join(repoReceipts(dir), `${RUN_A}.jsonl`);
    writeReceipt(repoReceipts(dir), RUN_A, [end(RUN_A, 3, path), head(RUN_A), step(RUN_A, 2)]);
    const [bundle] = loadReceipts({ cwd: dir, env }).bundles;
    expect(seqs(bundle!)).toEqual([1, 2, 3]);
    expect(bundle!.records.map((r) => r.event)).toEqual(["receipt.head", "receipt.step", "end"]);
  });

  test("a non-jsonl file in a receipt directory is ignored", () => {
    const { dir, env } = scratch();
    plainReceipt(repoReceipts(dir), RUN_A);
    writeFileSync(join(repoReceipts(dir), "notes.txt"), "not a receipt\n");
    const load = loadReceipts({ cwd: dir, env });
    expect(load.bundles.length).toBe(1);
    expect(load.files.map((f) => f.file)).toEqual([join(repoReceipts(dir), `${RUN_A}.jsonl`)]);
  });

  test("an unreadable receipt is reported, not thrown, and the rest of the directory loads", () => {
    const { dir, env } = scratch();
    plainReceipt(repoReceipts(dir), RUN_A);
    const bad = plainReceipt(repoReceipts(dir), RUN_B);
    chmodSync(bad, 0o000);
    try {
      const load = loadReceipts({ cwd: dir, env });
      expect(load.bundles.map((b) => b.run)).toEqual([RUN_A]);
      expect(load.files.length).toBe(2);
      expect(load.defects.map((d) => d.code)).toEqual(["receipt.unreadable"]);
      expect(load.defects[0]!.run).toBe(RUN_B);
      expect(load.defects[0]!.file).toBe(bad);
    } finally { chmodSync(bad, 0o644); }
  });

  test("an empty directory yields no bundles", () => {
    const { dir, env } = scratch();
    mkdirSync(repoReceipts(dir), { recursive: true });
    const load = loadReceipts({ cwd: dir, env });
    expect(load.locations[0]!.present).toBe(true);
    expect(load.bundles).toEqual([]);
    expect(load.quarantined).toEqual([]);
    expect(load.counts.records).toBe(0);
  });
});

// ---- RD-3 newline buffering ---------------------------------------------------------------

describe("RD-3 newline buffering", () => {
  test("a line split across two reads is one line", () => {
    const buf = new LineBuffer();
    expect(buf.push('{"event":"receipt.step","seq"')).toEqual([]);
    const lines = buf.push(":2}\n");
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]!.raw)).toEqual({ event: "receipt.step", seq: 2 });
    expect(lines[0]!.n).toBe(1);
    expect(buf.rest()).toBeNull();
  });

  test("a multi-byte character split across two reads is decoded whole", () => {
    const buf = new LineBuffer();
    const bytes = Buffer.from('{"decision":"café"}\n', "utf8");
    const cut = bytes.indexOf(0xc3) + 1; // between the two bytes of "é"
    expect(buf.push(bytes.subarray(0, cut))).toEqual([]);
    const lines = buf.push(bytes.subarray(cut));
    expect(lines.length).toBe(1);
    expect((JSON.parse(lines[0]!.raw) as { decision: string }).decision).toBe("café");
  });

  test("only a newline ends a line", () => {
    const { lines, unterminated } = splitLines('{"a":1}\r\u000c{"b":2}\n');
    expect(lines.length).toBe(1);
    expect(lines[0]!.raw).toBe('{"a":1}\r\u000c{"b":2}');
    expect(unterminated).toBeNull();
  });
});

// ---- RD-4 quarantine ----------------------------------------------------------------------

describe("RD-4 quarantine", () => {
  test("a stray line is quarantined and never a record", () => {
    const { dir, env } = scratch();
    const path = join(repoReceipts(dir), `${RUN_A}.jsonl`);
    writeReceipt(repoReceipts(dir), RUN_A, [head(RUN_A), "Segmentation fault", end(RUN_A, 3, path)]);
    const load = loadReceipts({ cwd: dir, env });
    const [bundle] = load.bundles;
    expect(seqs(bundle!)).toEqual([1, 3]);
    expect(bundle!.quarantined.length).toBe(1);
    expect(bundle!.quarantined[0]!.code).toBe("line.quarantined");
    expect(bundle!.quarantined[0]!.line).toBe(2);
    expect(bundle!.quarantined[0]!.raw).toBe("Segmentation fault");
    expect(bundle!.quarantined[0]!.section).toBe("§1.4");
    expect(bundle!.quarantined[0]!.run).toBe(RUN_A);
    expect(load.counts.quarantined).toBe(1);
    expect(JSON.stringify(bundle!.records)).not.toContain("Segmentation");
  });

  test("a JSON array or scalar on a line is quarantined", () => {
    const { dir, env } = scratch();
    const path = join(repoReceipts(dir), `${RUN_A}.jsonl`);
    writeReceipt(repoReceipts(dir), RUN_A, [head(RUN_A), "[1,2]", "3", end(RUN_A, 4, path)]);
    const [bundle] = loadReceipts({ cwd: dir, env }).bundles;
    expect(seqs(bundle!)).toEqual([1, 4]);
    expect(bundle!.quarantined.map((q) => q.raw)).toEqual(["[1,2]", "3"]);
    expect(bundle!.quarantined.every((q) => q.code === "line.quarantined")).toBe(true);
  });

  test("a blank line is quarantined", () => {
    const { dir, env } = scratch();
    const path = join(repoReceipts(dir), `${RUN_A}.jsonl`);
    writeReceipt(repoReceipts(dir), RUN_A, [head(RUN_A), "", "   ", end(RUN_A, 4, path)]);
    const [bundle] = loadReceipts({ cwd: dir, env }).bundles;
    expect(seqs(bundle!)).toEqual([1, 4]);
    expect(bundle!.quarantined.map((q) => q.code)).toEqual(["line.blank", "line.blank"]);
  });

  test("an object with no usable run and seq is quarantined", () => {
    const { dir, env } = scratch();
    const path = join(repoReceipts(dir), `${RUN_A}.jsonl`);
    writeReceipt(repoReceipts(dir), RUN_A, [head(RUN_A), { event: "x", t: 1 }, { event: "y", run: RUN_A, seq: "two" }, end(RUN_A, 4, path)]);
    const [bundle] = loadReceipts({ cwd: dir, env }).bundles;
    expect(seqs(bundle!)).toEqual([1, 4]);
    expect(bundle!.quarantined.map((q) => q.code)).toEqual(["line.no_envelope", "line.no_envelope"]);
    expect(bundle!.quarantined[0]!.section).toBe("§1.3");
  });
});

// ---- RD-5 the unterminated tail -----------------------------------------------------------

describe("RD-5 the unterminated tail", () => {
  test("an unterminated final line is ignored and reported", () => {
    const { dir, env } = scratch();
    const path = join(repoReceipts(dir), `${RUN_A}.jsonl`);
    writeReceipt(repoReceipts(dir), RUN_A, [head(RUN_A), step(RUN_A, 2), end(RUN_A, 3, path)], { terminate: false });
    const [bundle] = loadReceipts({ cwd: dir, env }).bundles;
    expect(seqs(bundle!)).toEqual([1, 2]);
    expect(byEvent(bundle!, "end")).toBeUndefined();
    expect(bundle!.terminated).toBe(false);
    const tail = bundle!.quarantined.find((q) => q.code === "line.unterminated");
    expect(tail).toBeDefined();
    expect(tail!.section).toBe("§5.4");
    expect(tail!.line).toBe(3);
  });

  test("a newline-terminated end establishes termination", () => {
    const { dir, env } = scratch();
    plainReceipt(repoReceipts(dir), RUN_A);
    const [bundle] = loadReceipts({ cwd: dir, env }).bundles;
    expect(bundle!.records.at(-1)!.event).toBe("end");
    expect(bundle!.terminated).toBe(true);
    expect(bundle!.quarantined).toEqual([]);
    expect(bundle!.status).toBe(0);
  });
});

// ---- RD-6 (run, seq) identifies an event --------------------------------------------------

describe("RD-6 run and seq", () => {
  test("two runs interleaved on one stream are separated by run", () => {
    const { dir, env } = scratch();
    const path = join(repoReceipts(dir), `${RUN_A}.jsonl`);
    writeReceipt(repoReceipts(dir), RUN_A, [head(RUN_A), head(RUN_B), step(RUN_B, 2), step(RUN_A, 2), end(RUN_A, 3, path), end(RUN_B, 3, path)]);
    const load = loadReceipts({ cwd: dir, env });
    expect(load.bundles.map((b) => b.run).sort()).toEqual([RUN_A, RUN_B].sort());
    for (const b of load.bundles) {
      expect(seqs(b)).toEqual([1, 2, 3]);
      expect(b.records.every((r) => r.run === b.run)).toBe(true);
    }
  });

  test("copies of one event are deduplicated by run and seq", () => {
    const { dir, env } = scratch();
    const path = join(repoReceipts(dir), `${RUN_A}.jsonl`);
    writeReceipt(repoReceipts(dir), RUN_A, [head(RUN_A), step(RUN_A, 2), step(RUN_A, 2), end(RUN_A, 3, path)]);
    const [bundle] = loadReceipts({ cwd: dir, env }).bundles;
    expect(seqs(bundle!)).toEqual([1, 2, 3]);
    expect(byEvent(bundle!, "receipt.step")!.copies).toBe(2);
    expect(loadReceipts({ cwd: dir, env }).counts.duplicates).toBe(1);
  });

  test("a copy may carry a field another omits, and a disagreement is reported", () => {
    const { dir, env } = scratch();
    const path = join(repoReceipts(dir), `${RUN_A}.jsonl`);
    writeReceipt(repoReceipts(dir), RUN_A, [
      head(RUN_A),
      step(RUN_A, 2),
      step(RUN_A, 2, { detail: { bytes: 18422 } }),
      toolResult(RUN_A, 3),
      toolResult(RUN_A, 3, { t: 1795326499999 }),
      end(RUN_A, 4, path),
    ]);
    const [bundle] = loadReceipts({ cwd: dir, env }).bundles;
    expect(seqs(bundle!)).toEqual([1, 2, 3, 4]);
    expect((byEvent(bundle!, "receipt.step")!.record as { detail?: unknown }).detail).toEqual({ bytes: 18422 });
    const disagreement = bundle!.defects.filter((d) => d.code === "copies.disagree");
    expect(disagreement.length).toBe(1);
    expect(disagreement[0]!.problem).toContain("t");
    expect(disagreement[0]!.section).toBe("§1.3");
  });

  test("the same run found in both locations is one bundle", () => {
    const { dir, env } = scratch();
    plainReceipt(repoReceipts(dir), RUN_A);
    const stateDir = receiptLocations({ cwd: dir, env })[1]!.dir;
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, `${RUN_A}.jsonl`), readFileSync(join(repoReceipts(dir), `${RUN_A}.jsonl`)));
    const load = loadReceipts({ cwd: dir, env });
    expect(load.bundles.length).toBe(1);
    expect(load.bundles[0]!.sources.map((s) => s.where)).toEqual(["repo", "state"]);
    expect(seqs(load.bundles[0]!)).toEqual([1, 2, 3]);
    expect(load.bundles[0]!.records.every((r) => r.copies === 2)).toBe(true);
  });
});

// ---- RD-7 exact-pair validation -----------------------------------------------------------

describe("RD-7 validation", () => {
  test("a parley line is validated against the schema for its exact pair", () => {
    const { dir, env } = scratch();
    plainReceipt(repoReceipts(dir), RUN_A);
    const load = loadReceipts({ cwd: dir, env });
    const [bundle] = load.bundles;
    expect(bundle!.records.map((r) => r.validation.state)).toEqual(["validated", "validated", "validated"]);
    expect(byEvent(bundle!, "end")!.validation.schema).toEqual({ id: "parley.end", version: "1.0.0" });
    expect(load.counts.validated).toBe(3);
    expect(load.counts.invalid).toBe(0);
  });

  test("a parley line of a version the reader does not ship is partial, never validated", () => {
    const { dir, env } = scratch();
    const path = join(repoReceipts(dir), `${RUN_A}.jsonl`);
    writeReceipt(repoReceipts(dir), RUN_A, [head(RUN_A), { ...end(RUN_A, 2, path), _schema: { id: "parley.end", version: "9.9.9" } }]);
    const load = loadReceipts({ cwd: dir, env });
    const record = byEvent(load.bundles[0]!, "end")!;
    expect(record.validation.state).toBe("partial");
    expect(record.validation.schema).toEqual({ id: "parley.end", version: "9.9.9" });
    expect(load.counts.partial).toBe(1);
    expect(load.counts.validated).toBe(1);
    expect(load.bundles[0]!.defects.some((d) => d.code === "record.unknown_pair")).toBe(true);
  });

  test("a tool-owned line is passed through as unvalidated", () => {
    const { dir, env } = scratch();
    const path = join(repoReceipts(dir), `${RUN_A}.jsonl`);
    writeReceipt(repoReceipts(dir), RUN_A, [head(RUN_A), toolResult(RUN_A, 2), end(RUN_A, 3, path)]);
    const load = loadReceipts({ cwd: dir, env });
    const record = byEvent(load.bundles[0]!, "result")!;
    expect(record.validation).toEqual({ state: "unvalidated", schema: { id: "t.count", version: "1.0.0" }, why: "tool_owned" });
    expect((record.record as { value: number }).value).toBe(1);
    expect(load.counts.unvalidated).toBe(1);
    expect(load.counts.invalid).toBe(0);
  });

  test("a parley line that breaks its schema is reported invalid", () => {
    const { dir, env } = scratch();
    const path = join(repoReceipts(dir), `${RUN_A}.jsonl`);
    writeReceipt(repoReceipts(dir), RUN_A, [head(RUN_A), end(RUN_A, 2, path, { status: "zero" })]);
    const load = loadReceipts({ cwd: dir, env });
    const record = byEvent(load.bundles[0]!, "end")!;
    expect(record.validation.state).toBe("invalid");
    expect((record.validation as unknown as { errors: string[] }).errors.join("; ")).toContain("/status");
    expect(load.counts.invalid).toBe(1);
    expect(load.bundles[0]!.defects.some((d) => d.code === "record.invalid")).toBe(true);
  });

  test("a line with no _schema is unvalidated", () => {
    const { dir, env } = scratch();
    writeReceipt(repoReceipts(dir), RUN_A, [{ event: "receipt.step", t: 1, seq: 1, run: RUN_A, decision: "d", because: "b" }]);
    const record = loadReceipts({ cwd: dir, env }).bundles[0]!.records[0]!;
    expect(record.validation).toEqual({ state: "unvalidated", schema: null, why: "no_schema_ref" });
  });
});

// ---- RD-8 sidecars ------------------------------------------------------------------------

/** A receipt whose result at `seq: 2` lives in a sidecar. Returns the bundle's paths. */
function withSidecar(dir: string, run = RUN_A, over: { path?: string; endOver?: Record<string, unknown> } = {}) {
  const stored = JSON.stringify(toolResult(run, 2, { rows: Array.from({ length: 10 }, (_, i) => ({ i })) }));
  const rel = over.path ?? `${run}/2.json`;
  const receiptPath = join(dir, `${run}.jsonl`);
  const storedPath = resolve(dir, rel);
  mkdirSync(dirname(storedPath), { recursive: true });
  writeFileSync(storedPath, stored);
  const bytes = Buffer.byteLength(stored, "utf8");
  writeReceipt(dir, run, [head(run), sidecar(run, 3, 2, rel, bytes, sha(stored)), end(run, 4, receiptPath, over.endOver ?? {})]);
  return { receiptPath, storedPath, stored, bytes };
}

describe("RD-8 sidecars", () => {
  test("a sidecar is resolved and the record it holds is returned in its place", () => {
    const { dir, env } = scratch();
    const { stored } = withSidecar(repoReceipts(dir));
    const [bundle] = loadReceipts({ cwd: dir, env }).bundles;
    expect(seqs(bundle!)).toEqual([1, 2, 3, 4]);
    const restored = bundle!.records.find((r) => r.seq === 2)!;
    expect(restored.fromSidecar).toBe(true);
    expect(restored.event).toBe("result");
    expect((restored.record as { rows: unknown[] }).rows.length).toBe(10);
    expect(JSON.stringify(restored.record)).toBe(stored);
    expect(bundle!.records.find((r) => r.seq === 3)!.event).toBe("sidecar");
    expect(bundle!.sidecars.length).toBe(1);
    expect(bundle!.sidecars[0]!.state).toBe("intact");
    expect(bundle!.sidecars[0]!.source).toBe(2);
    expect(bundle!.replay.unavailable).toBe(false);
  });

  test("with sidecar resolution off a sidecar is unchecked, never intact", () => {
    const { dir, env } = scratch();
    withSidecar(repoReceipts(dir));
    const [bundle] = loadReceipts({ cwd: dir, env, sidecars: false }).bundles;
    expect(bundle!.sidecars[0]!.state).toBe("unchecked");
    expect(bundle!.records.some((r) => r.fromSidecar)).toBe(false);
    expect(bundle!.defects).toEqual([]);
    expect(bundle!.replay.unavailable).toBe(true);
    expect(bundle!.replay.reasons).toEqual(["sidecar.unchecked"]);
  });
});

// ---- RD-9 what rules out replay -----------------------------------------------------------

describe("RD-9 replay availability", () => {
  test("a sidecar with a wrong digest marks its bundle unavailable for replay", () => {
    const { dir, env } = scratch();
    const { storedPath, stored } = withSidecar(repoReceipts(dir));
    writeFileSync(storedPath, stored.replace('"i":0', '"i":9'));
    const [bundle] = loadReceipts({ cwd: dir, env }).bundles;
    expect(bundle!.sidecars[0]!.state).toBe("digest_mismatch");
    expect(bundle!.replay.unavailable).toBe(true);
    expect(bundle!.replay.reasons).toContain("sidecar.digest_mismatch");
    expect(bundle!.records.some((r) => r.fromSidecar)).toBe(false);
    expect(bundle!.defects.some((d) => d.code === "sidecar.digest_mismatch" && d.source === 2)).toBe(true);
  });

  test("a missing sidecar marks its bundle unavailable for replay", () => {
    const { dir, env } = scratch();
    const { storedPath } = withSidecar(repoReceipts(dir));
    rmSync(storedPath);
    const [bundle] = loadReceipts({ cwd: dir, env }).bundles;
    expect(bundle!.sidecars[0]!.state).toBe("missing");
    expect(bundle!.replay.unavailable).toBe(true);
    expect(bundle!.replay.reasons).toContain("sidecar.missing");
    expect(bundle!.records.map((r) => r.seq)).toEqual([1, 3, 4]);
  });

  test("a sidecar path that would leave the bundle is never read", () => {
    const { dir, env } = scratch();
    const outside = join(dir, "escape.json");
    writeFileSync(outside, JSON.stringify(toolResult(RUN_A, 2, { smuggled: true })));
    const run = RUN_A;
    const receiptPath = join(repoReceipts(dir), `${run}.jsonl`);
    const bytes = readFileSync(outside);
    writeReceipt(repoReceipts(dir), run, [head(run), sidecar(run, 3, 2, "../../escape.json", bytes.length, sha(bytes)), end(run, 4, receiptPath)]);
    const [bundle] = loadReceipts({ cwd: dir, env }).bundles;
    expect(bundle!.sidecars[0]!.state).toBe("escapes_bundle");
    expect(bundle!.sidecars[0]!.resolved).toBeNull();
    expect(bundle!.replay.unavailable).toBe(true);
    expect(bundle!.replay.reasons).toContain("sidecar.escapes_bundle");
    expect(JSON.stringify(bundle!.records)).not.toContain("smuggled");
  });

  test("a receipt with no end is unavailable for replay", () => {
    const { dir, env } = scratch();
    writeReceipt(repoReceipts(dir), RUN_A, [head(RUN_A), step(RUN_A, 2)]);
    const [bundle] = loadReceipts({ cwd: dir, env }).bundles;
    expect(bundle!.terminated).toBe(false);
    expect(bundle!.status).toBeNull();
    expect(bundle!.replay.unavailable).toBe(true);
    expect(bundle!.replay.reasons).toContain("receipt.no_end");
  });

  test("a redacted receipt is unavailable for replay", () => {
    const { dir, env } = scratch();
    plainReceipt(repoReceipts(dir), RUN_A, { redacted: true });
    const [bundle] = loadReceipts({ cwd: dir, env }).bundles;
    expect(bundle!.redacted).toBe(true);
    expect(bundle!.replay.unavailable).toBe(true);
    expect(bundle!.replay.reasons).toContain("receipt.redacted");
  });

  test("a non-zero status is unavailable for replay", () => {
    const { dir, env } = scratch();
    plainReceipt(repoReceipts(dir), RUN_A, { status: 2 });
    const [bundle] = loadReceipts({ cwd: dir, env }).bundles;
    expect(bundle!.status).toBe(2);
    expect(bundle!.replay.unavailable).toBe(true);
    expect(bundle!.replay.reasons).toContain("end.status_nonzero");
  });

  test("an intact bundle is not ruled out for replay", () => {
    const { dir, env } = scratch();
    withSidecar(repoReceipts(dir));
    const [bundle] = loadReceipts({ cwd: dir, env }).bundles;
    expect(bundle!.replay).toEqual({ unavailable: false, reasons: [] });
    expect(bundle!.defects).toEqual([]);
  });
});

// ---- RD-10 the shipped schemas ------------------------------------------------------------

describe("RD-10 shipped schemas", () => {
  test("shipped schemas match the repository drafts", () => {
    expect(SCHEMA_SOURCE.commit).toMatch(/^[0-9a-f]{40}$/);
    const files = Object.entries(SCHEMA_SOURCE.files);
    expect(files.length).toBe(SCHEMAS.length);
    for (const [file, digest] of files) expect(sha(readFileSync(join(SCHEMAS_DIR, file)))).toBe(digest);
    const index = validator();
    for (const s of SCHEMAS) expect(index.has(s.id, s.version)).toBe(true);
  });
});

// ---- RD-11 a quarantined line is not evidence ---------------------------------------------

describe("RD-11 quarantine is not evidence", () => {
  test("a quarantined end is not termination, not a record and not validation evidence", () => {
    const { dir, env } = scratch();
    const path = join(repoReceipts(dir), `${RUN_A}.jsonl`);
    writeReceipt(repoReceipts(dir), RUN_A, [head(RUN_A), end(RUN_A, 2, path)], { terminate: false });
    const load = loadReceipts({ cwd: dir, env });
    const [bundle] = load.bundles;
    expect(bundle!.records.map((r) => r.event)).toEqual(["receipt.head"]);
    expect(bundle!.terminated).toBe(false);
    expect(bundle!.status).toBeNull();
    expect(bundle!.replay.reasons).toContain("receipt.no_end");
    expect(load.counts.validated).toBe(1);
    expect(load.counts.records).toBe(1);
    expect(load.counts.quarantined).toBe(1);
  });
});

// ---- RD-12 the writer's own receipts ------------------------------------------------------

describe("RD-12 writer-produced receipts", () => {
  test("the receipts the writer leaves behind load with zero quarantines and every parley record validates", async () => {
    const { dir, env } = scratch();
    writeFileSync(join(dir, "a.txt"), "hello");
    const golden = await writerRun(dir, env, ["count"], (run) => {
      run.step("read a.txt as UTF-8", "no BOM and no @charset", { bytes: 5 });
      run.warning({ code: "input.encoding_guessed", problem: "a.txt has no BOM; read as UTF-8", remedy: "declare the encoding" });
      run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" });
    });
    const big = await writerRun(dir, env, ["count"], (run) => {
      run.result({ event: "result", value: 2 }, { id: "t.count", version: "1.0.0" }, { rows: Array.from({ length: 3000 }, (_, i) => ({ i, text: "x".repeat(30) })) });
    });
    const threw = await writerRun(dir, env, ["count"], () => { throw new Error("boom"); });
    const discovery = await writerRun(dir, env, ["--schema"], () => {});
    const secret = await writerRun(dir, env, ["count", "--token", "s3cret"], (run) => {
      run.result({ event: "result", value: 3 }, { id: "t.count", version: "1.0.0" });
    });

    const load = loadReceipts({ cwd: dir, env });
    expect(load.bundles.map((b) => b.run).sort()).toEqual([golden.run!, big.run!, threw.run!, discovery.run!, secret.run!].sort());
    expect(load.quarantined).toEqual([]);
    expect(load.counts.invalid).toBe(0);
    expect(load.counts.partial).toBe(0);
    for (const b of load.bundles) {
      expect(b.terminated).toBe(true);
      expect(seqs(b)).toEqual([...seqs(b)].sort((x, y) => x - y));
      for (const r of b.records) {
        const id = (r.record._schema as { id: string }).id;
        expect(r.validation.state).toBe(id.startsWith("parley.") ? "validated" : "unvalidated");
      }
      expect(b.defects).toEqual([]);
    }
    const toolOwned = load.bundles.flatMap((b) => b.records).filter((r) => r.validation.state === "unvalidated");
    expect(toolOwned.length).toBeGreaterThan(0);
    expect(toolOwned.every((r) => (r.validation as { why: string }).why === "tool_owned")).toBe(true);
    expect(load.bundles.find((b) => b.run === golden.run)!.replay.unavailable).toBe(false);
    expect(load.bundles.find((b) => b.run === threw.run)!.replay.reasons).toContain("end.status_nonzero");
  });

  test("a writer run whose result went to a sidecar loads with the record restored", async () => {
    const { dir, env } = scratch();
    const big = await writerRun(dir, env, ["count"], (run) => {
      run.result({ event: "result", value: 2 }, { id: "t.count", version: "1.0.0" }, { rows: Array.from({ length: 3000 }, (_, i) => ({ i, text: "x".repeat(30) })) });
    });
    const file = readReceiptFile(big.receipt!);
    expect(file.quarantined).toEqual([]);
    const [bundle] = file.bundles;
    expect(bundle!.sidecars.length).toBe(1);
    expect(bundle!.sidecars[0]!.state).toBe("intact");
    expect(bundle!.sidecars[0]!.declared.bytes).toBeGreaterThan(65536);
    const restored = bundle!.records.find((r) => r.fromSidecar)!;
    expect(restored.event).toBe("result");
    expect((restored.record as { rows: unknown[] }).rows.length).toBe(3000);
    expect(restored.seq).toBe(bundle!.sidecars[0]!.source);
    expect(bundle!.replay.unavailable).toBe(false);
  });

  test("a writer run that redacted a secret is unavailable for replay", async () => {
    const { dir, env } = scratch();
    const secret = await writerRun(dir, env, ["count", "--token", "s3cret"], (run) => {
      run.result({ event: "result", value: 3 }, { id: "t.count", version: "1.0.0" });
    });
    const [bundle] = loadReceipts({ cwd: dir, env }).bundles;
    expect(bundle!.run).toBe(secret.run!);
    expect(bundle!.redacted).toBe(true);
    expect(bundle!.replay.unavailable).toBe(true);
    expect(bundle!.replay.reasons).toContain("receipt.redacted");
    expect(JSON.stringify(bundle!.records)).not.toContain("s3cret");
  });
});

// ---- RD-13 a thousand receipts ------------------------------------------------------------

describe("RD-13 stress", () => {
  test("a thousand small receipts load in bounded time", () => {
    const { dir, env } = scratch();
    const receipts = repoReceipts(dir);
    mkdirSync(receipts, { recursive: true });
    for (let i = 0; i < 1000; i++) {
      const run = `01M81NYC9E28S33150VJB${String(i).padStart(5, "0")}`;
      const path = join(receipts, `${run}.jsonl`);
      writeReceipt(receipts, run, [head(run), step(run, 2), step(run, 3), step(run, 4), toolResult(run, 5), end(run, 6, path)]);
    }
    const started = Date.now();
    const load = loadReceipts({ cwd: dir, env });
    const elapsed = Date.now() - started;
    expect(load.bundles.length).toBe(1000);
    expect(load.counts.records).toBe(6000);
    expect(load.counts.quarantined).toBe(0);
    expect(load.counts.invalid).toBe(0);
    expect(elapsed).toBeLessThan(30_000);
  }, 60_000);
});

// ---- RD-14, RD-15, RD-16 the query entry point --------------------------------------------
//
// A read states an asker, a view and a window (flyingrobots/parley#46), is refused when it
// cannot, and is itself recorded through the writer (spec §9). Nothing here ranks or bounds: the
// order is flyingrobots/parley#49 and the bound is flyingrobots/parley#50, below. The windows in
// these cases hold fewer records than the default budget of twenty, so what they assert about an
// answer is the whole of it.

const DAY = 86_400_000;
const T0 = 1795326412346;

/** A complete three-line receipt whose head, step and end are stamped from `at`. */
function datedReceipt(dir: string, run: string, at: number): string {
  const path = join(dir, `${run}.jsonl`);
  return writeReceipt(dir, run, [
    { ...head(run), t: at },
    { ...step(run, 2), t: at + 1 },
    { ...end(run, 3, path), t: at + 2 },
  ]);
}

function runId(n: number): string {
  return `01M81NYC9E28S33150VJB${String(n).padStart(5, "0")}`;
}

const WIDE = { from: 0, to: T0 + 365 * DAY };

/** Narrow an outcome to the answer, naming the refusal codes when there is one. */
function answered(outcome: QueryOutcome): QueryAnswer {
  if (outcome.refused) throw new Error(`refused: ${outcome.refusals.map((r) => r.code).join(", ")}`);
  if (outcome.declined) throw new Error(`declined: ${outcome.decline.problem}`);
  return outcome;
}

function refused(outcome: QueryOutcome): readonly QueryRefusal[] {
  if (!outcome.refused) throw new Error("the query was accepted; it should have been refused");
  return outcome.refusals;
}

const codes = (outcome: QueryOutcome) => refused(outcome).map((r) => r.code);

describe("RD-14 a query without an asker, a view or a window is refused", () => {
  test("a query whose asker names no tool is refused rather than defaulted", async () => {
    const { dir, env } = scratch();
    const outcome = await queryReceipts({ view: "everything", window: WIDE }, { cwd: dir, env });
    expect(codes(outcome)).toEqual(["query.asker_unnamed"]);
    const withEmpty = await queryReceipts({ asker: { tool: "" }, view: "everything", window: WIDE }, { cwd: dir, env });
    expect(codes(withEmpty)).toEqual(["query.asker_unnamed"]);
  });

  test("a query with no view is refused rather than guessed", async () => {
    const { dir, env } = scratch();
    const outcome = await queryReceipts({ asker: { tool: "t" }, window: WIDE }, { cwd: dir, env });
    expect(codes(outcome)).toEqual(["query.view_missing"]);
  });

  test("a view outside the five tokens is refused and the vocabulary is named", async () => {
    const { dir, env } = scratch();
    const outcome = await queryReceipts({ asker: { tool: "t" }, view: "what-happened", window: WIDE }, { cwd: dir, env });
    expect(codes(outcome)).toEqual(["query.view_unknown"]);
    for (const token of VIEWS) expect(refused(outcome)[0]!.remedy).toContain(token);
  });

  test("a missing, half-stated, malformed or inverted window is refused", async () => {
    const { dir, env } = scratch();
    const missing = await queryReceipts({ asker: { tool: "t" }, view: "everything" }, { cwd: dir, env });
    expect(codes(missing)).toEqual(["query.window_missing"]);
    const half = await queryReceipts({ asker: { tool: "t" }, view: "everything", window: { from: 0 } }, { cwd: dir, env });
    expect(codes(half)).toEqual(["query.window_missing"]);
    const fractional = await queryReceipts({ asker: { tool: "t" }, view: "everything", window: { from: 0.5, to: T0 } }, { cwd: dir, env });
    expect(codes(fractional)).toEqual(["query.window_invalid"]);
    const negative = await queryReceipts({ asker: { tool: "t" }, view: "everything", window: { from: -1, to: T0 } }, { cwd: dir, env });
    expect(codes(negative)).toEqual(["query.window_invalid"]);
    const inverted = await queryReceipts({ asker: { tool: "t" }, view: "everything", window: { from: T0, to: T0 - DAY } }, { cwd: dir, env });
    expect(codes(inverted)).toEqual(["query.window_inverted"]);
  });

  test("a budget that admits no records is refused", async () => {
    const { dir, env } = scratch();
    const outcome = await queryReceipts({ asker: { tool: "t" }, view: "everything", window: WIDE, budget: { records: 0 } }, { cwd: dir, env });
    expect(codes(outcome)).toEqual(["query.budget_invalid"]);
  });

  test("an asker that parley.query could not carry is refused", async () => {
    const { dir, env } = scratch();
    const relative = await queryReceipts({ asker: { tool: "t", cwd: "work" }, view: "everything", window: WIDE }, { cwd: dir, env });
    expect(codes(relative)).toEqual(["query.asker_invalid"]);
    const emptyTask = await queryReceipts({ asker: { tool: "t", task: "" }, view: "everything", window: WIDE }, { cwd: dir, env });
    expect(codes(emptyTask)).toEqual(["query.asker_invalid"]);
    const emptyNote = await queryReceipts({ asker: { tool: "t" }, view: "everything", window: WIDE, note: "" }, { cwd: dir, env });
    expect(codes(emptyNote)).toEqual(["query.note_empty"]);
    expect(existsSync(join(dir, ".parley"))).toBe(false);
  });

  test("a refusal is structured, and a refused query records nothing", async () => {
    const { dir, env } = scratch();
    const outcome = await queryReceipts({ asker: { cwd: dir } }, { cwd: dir, env });
    const refusals = refused(outcome);
    expect(refusals.map((r) => r.code).sort()).toEqual(["query.asker_unnamed", "query.view_missing", "query.window_missing"]);
    for (const r of refusals) {
      expect(r.code).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/);
      expect(r.problem.length).toBeGreaterThan(0);
      expect(r.remedy.length).toBeGreaterThan(0);
      expect(r.section.length).toBeGreaterThan(0);
    }
    expect(existsSync(join(dir, ".parley"))).toBe(false);
    const load = loadReceipts({ cwd: dir, env });
    expect(load.bundles).toEqual([]);
    expect(load.counts.records).toBe(0);
  });

  test("planQuery refuses and accepts without reading or writing anything", () => {
    expect(planQuery({ asker: { tool: "t" }, view: "everything" }).refused).toBe(true);
    const plan = planQuery({ asker: { tool: "t" }, view: "what-failed", window: WIDE });
    expect(plan.refused).toBe(false);
    if (plan.refused) throw new Error("accepted plan expected");
    expect(plan.query.budget).toEqual({ records: 20 });
    expect(plan.query.budgetDefaulted).toBe(true);
    expect(plan.query.window).toEqual(WIDE);
  });
});

describe("RD-15 an accepted query is recorded and reads back", () => {
  test("an accepted query leaves exactly one query record, carried by the read's own run", async () => {
    const { dir, env } = scratch();
    const receipts = repoReceipts(dir);
    for (let i = 0; i < 3; i++) datedReceipt(receipts, runId(i), T0 - (3 - i) * DAY);

    const answer = answered(await queryReceipts(
      { asker: { tool: "t", cwd: dir, task: "flyingrobots/parley#48" }, view: "everything", window: WIDE, note: "the golden case" },
      { cwd: dir, env },
    ));
    expect(answer.status).toBe(0);
    expect(answer.query.run).toBe(answer.run);
    expect(answer.query.seq).toBeGreaterThan(0);

    const after = loadReceipts({ cwd: dir, env });
    const queries = after.bundles.flatMap((b) => b.records).filter((r) => r.event === "query");
    expect(queries.length).toBe(1);
    expect(queries[0]!.run).toBe(answer.run);
    expect(queries[0]!.seq).toBe(answer.query.seq);
    const record = queries[0]!.record as Record<string, unknown>;
    expect(record.asker).toEqual({ tool: "t", cwd: dir, task: "flyingrobots/parley#48" });
    expect(record.view).toBe("everything");
    expect(record.window).toEqual(WIDE);
    expect(record.note).toBe("the golden case");
  });

  test("the recorded query loads as validated against parley.query 1.1.0 in its own bundle", async () => {
    const { dir, env } = scratch();
    datedReceipt(repoReceipts(dir), runId(1), T0 - DAY);
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "what-ran", window: WIDE }, { cwd: dir, env }));

    const load = loadReceipts({ cwd: dir, env });
    const own = load.bundles.find((b) => b.run === answer.run)!;
    expect(own).toBeDefined();
    expect(own.terminated).toBe(true);
    expect(own.status).toBe(0);
    expect(own.defects).toEqual([]);
    const query = own.records.find((r) => r.event === "query")!;
    expect(query.validation.state).toBe("validated");
    expect((query.validation as { schema: { id: string; version: string } }).schema).toEqual({ id: "parley.query", version: "1.1.0" });
    expect(load.counts.invalid).toBe(0);
    expect(load.quarantined).toEqual([]);
  });

  test("a query that supplies no budget records the documented default and says it defaulted", async () => {
    const { dir, env } = scratch();
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "everything", window: WIDE }, { cwd: dir, env }));
    expect(answer.budget).toEqual({ records: 20 });
    expect(answer.budgetDefaulted).toBe(true);
    const supplied = answered(await queryReceipts(
      { asker: { tool: "t" }, view: "everything", window: WIDE, budget: { records: 5, bytes: 4096 } },
      { cwd: dir, env },
    ));
    expect(supplied.budget).toEqual({ records: 5, bytes: 4096 });
    expect(supplied.budgetDefaulted).toBe(false);
    const load = loadReceipts({ cwd: dir, env });
    const recorded = load.bundles.flatMap((b) => b.records).filter((r) => r.event === "query").map((r) => (r.record as { budget: unknown }).budget);
    expect(recorded).toContainEqual({ records: 20 });
    expect(recorded).toContainEqual({ records: 5, bytes: 4096 });
  });

  test("a read that states no cwd records the directory it read", async () => {
    const { dir, env } = scratch();
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "everything", window: WIDE }, { cwd: dir, env }));
    expect(answer.asker).toEqual({ tool: "t", cwd: dir });
    const recorded = loadReceipts({ cwd: dir, env }).bundles.flatMap((b) => b.records).find((r) => r.event === "query")!;
    expect((recorded.record as { asker: unknown }).asker).toEqual({ tool: "t", cwd: dir });
    expect(recorded.validation.state).toBe("validated");
  });

  test("the query line the read put on its stream validates on its own", async () => {
    const { dir, env } = scratch();
    const stdout = new Capture();
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "how-it-decided", window: WIDE }, { cwd: dir, env, stdout }));
    const line = answer.lines.find((l) => l.event === "query")!;
    expect(line).toBeDefined();
    expect(validator().validate(line).state).toBe("validated");
    expect(stdout.objs.some((o) => o.event === "query")).toBe(true);
    expect(stdout.objs[0]!.event).toBe("run");
  });

  test("a read records its own identity at this package's name and version", async () => {
    const { dir, env } = scratch();
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dir, "../package.json"), "utf8")) as { name: string; version: string };
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "everything", window: WIDE }, { cwd: dir, env }));
    const own = loadReceipts({ cwd: dir, env }).bundles.find((b) => b.run === answer.run)!;
    const head = own.records.find((r) => r.event === "receipt.head")!.record as { tool: string; v: string };
    expect(head.tool).toBe(manifest.name.replace(/^@[^/]+\//, ""));
    expect(head.v).toBe(manifest.version);
  });

  test("a read never expires the history it reads", async () => {
    const { dir, env } = scratch();
    const receipts = repoReceipts(dir);
    for (let i = 0; i < 60; i++) datedReceipt(receipts, runId(i), T0 - (60 - i) * DAY);
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "everything", window: WIDE }, { cwd: dir, env }));
    const load = loadReceipts({ cwd: dir, env });
    expect(load.bundles.length).toBe(61);
    for (let i = 0; i < 60; i++) expect(existsSync(join(receipts, `${runId(i)}.jsonl`))).toBe(true);
    expect(load.bundles.some((b) => b.run === answer.run)).toBe(true);
    expect(answer.load.bundles.length).toBe(60 + 1);
  });

  test("a read with PARLEY_TASK set and no stated task records no asker.task", async () => {
    const { dir, env } = scratch();
    const withTask = { ...env, PARLEY_TASK: "flyingrobots/parley#999" };
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "everything", window: WIDE }, { cwd: dir, env: withTask }));
    // flyingrobots/parley#61: a task id is always supplied by the caller, never inferred. Nothing
    // reads an environment variable for it, so a stated environment value must not leak in.
    expect(answer.asker).toEqual({ tool: "t", cwd: dir });
    expect(answer.asker).not.toHaveProperty("task");
    const recorded = loadReceipts({ cwd: dir, env: withTask }).bundles.flatMap((b) => b.records).find((r) => r.event === "query")!;
    expect((recorded.record as { asker: unknown }).asker).toEqual({ tool: "t", cwd: dir });
  });
});

describe("RD-16 the window, echoed verbatim, and the read's own records left out", () => {
  test("a window returns the records inside it, ascending by t, and is echoed verbatim", async () => {
    const { dir, env } = scratch();
    const receipts = repoReceipts(dir);
    const at = [T0 - 30 * DAY, T0 - 20 * DAY, T0 - 10 * DAY, T0 - DAY, T0];
    at.forEach((t, i) => datedReceipt(receipts, runId(i), t));

    const window = { from: T0 - 21 * DAY, to: T0 - 9 * DAY };
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "everything", window }, { cwd: dir, env }));
    expect(answer.window).toEqual(window);
    expect([...new Set(answer.records.map((r) => r.run))]).toEqual([runId(1), runId(2)]);
    expect(answer.records.length).toBe(6);
    const times = answer.records.map((r) => r.t!);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(answer.counts.inWindow).toBe(6);
  });

  test("a query over an empty directory answers with no records and is still recorded", async () => {
    const { dir, env } = scratch();
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "everything", window: WIDE }, { cwd: dir, env }));
    expect(answer.records).toEqual([]);
    expect(answer.counts.inWindow).toBe(0);
    const load = loadReceipts({ cwd: dir, env });
    expect(load.bundles.flatMap((b) => b.records).filter((r) => r.event === "query").length).toBe(1);
  });

  test("a window no record falls in answers with no records", async () => {
    const { dir, env } = scratch();
    const receipts = repoReceipts(dir);
    datedReceipt(receipts, runId(0), T0 - 30 * DAY);
    datedReceipt(receipts, runId(1), T0 - 20 * DAY);
    const window = { from: T0 - 10 * DAY, to: T0 - 5 * DAY };
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "everything", window }, { cwd: dir, env }));
    expect(answer.records).toEqual([]);
    expect(answer.window).toEqual(window);
    expect(answer.counts.scanned).toBeGreaterThan(0);
    const load = loadReceipts({ cwd: dir, env });
    expect(load.bundles.flatMap((b) => b.records).filter((r) => r.event === "query").length).toBe(1);
  });

  test("a read does not answer itself", async () => {
    const { dir, env } = scratch();
    datedReceipt(repoReceipts(dir), runId(0), T0 - DAY);
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "everything", window: WIDE }, { cwd: dir, env }));
    expect(answer.records.every((r) => r.run !== answer.run)).toBe(true);
    expect(answer.records.map((r) => r.event)).not.toContain("query");
    expect(answer.counts.own).toBeGreaterThan(0);
    const next = answered(await queryReceipts({ asker: { tool: "t" }, view: "everything", window: WIDE }, { cwd: dir, env }));
    expect(next.records.some((r) => r.run === answer.run && r.event === "query")).toBe(true);
  });

  test("records written out of order come back in one ascending sequence by t", async () => {
    const { dir, env } = scratch();
    const receipts = repoReceipts(dir);
    const a = runId(1), b = runId(2);
    const pathA = join(receipts, `${a}.jsonl`), pathB = join(receipts, `${b}.jsonl`);
    writeReceipt(receipts, a, [
      { ...end(a, 3, pathA), t: T0 + 500 },
      { ...head(a), t: T0 + 100 },
      { ...step(a, 2), t: T0 + 300 },
    ]);
    writeReceipt(receipts, b, [
      { ...step(b, 2), t: T0 + 400 },
      { ...head(b), t: T0 + 200 },
      { ...end(b, 3, pathB), t: T0 + 600 },
    ]);
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "everything", window: { from: T0, to: T0 + 1000 } }, { cwd: dir, env }));
    expect(answer.records.map((r) => [r.t, r.run, r.seq])).toEqual([
      [T0 + 100, a, 1], [T0 + 200, b, 1], [T0 + 300, a, 2], [T0 + 400, b, 2], [T0 + 500, a, 3], [T0 + 600, b, 3],
    ]);
  });

  test("the view ranks the answer and hides none of it", async () => {
    const seed = (dir: string) => {
      const receipts = repoReceipts(dir);
      datedReceipt(receipts, runId(0), T0 - 2 * DAY);
      writeReceipt(receipts, runId(1), [
        { ...head(runId(1)), t: T0 - DAY },
        { event: "error", t: T0 - DAY + 1, seq: 2, run: runId(1), code: "x.failed", problem: "it failed", _schema: { id: "parley.error", version: "2.0.0" } },
        { ...end(runId(1), 3, join(receipts, `${runId(1)}.jsonl`), { status: 2 }), t: T0 - DAY + 2 },
      ]);
    };
    const one = scratch(), two = scratch();
    seed(one.dir); seed(two.dir);
    const everything = answered(await queryReceipts({ asker: { tool: "t" }, view: "everything", window: WIDE }, { cwd: one.dir, env: one.env }));
    const failed = answered(await queryReceipts({ asker: { tool: "t" }, view: "what-failed", window: WIDE }, { cwd: two.dir, env: two.env }));
    const shape = (a: QueryAnswer) => a.records.map((r) => `${r.run}:${r.seq}:${r.event}`);
    // The same records, as a set: the view orders the answer and filters none of it (§9).
    expect([...shape(failed)].sort()).toEqual([...shape(everything)].sort());
    // In two different orders: what-failed puts the error and the non-zero end first.
    expect(shape(failed)).not.toEqual(shape(everything));
    expect(failed.records.slice(0, 2).map((r) => r.event)).toEqual(["error", "end"]);
    expect(everything.view).toBe("everything");
    expect(failed.view).toBe("what-failed");
  });
});

// ---- RD-17, RD-18, RD-19 the purpose orders the answer ------------------------------------
//
// Spec §9: the purpose shapes the result, and it is the ranking function rather than a filter
// applied afterwards (flyingrobots/parley#49). The key is (tier, outcome, t, run, seq) and nothing
// is dropped at any tier. `rankRecords` still returns every record it is given; it is the digest
// below (flyingrobots/parley#50) that cuts the order it produced and says how much it cut.

/** A five-record receipt: head, step, the tool's own result, and an end, stamped from `at`. */
function richReceipt(dir: string, run: string, at: number, kind: "ok" | "failed" | "warned" = "ok"): string {
  const path = join(dir, `${run}.jsonl`);
  const lines: object[] = [{ ...head(run), t: at }, { ...step(run, 2), t: at + 1 }];
  if (kind === "warned") {
    lines.push({ event: "warning", t: at + 2, seq: 3, run, code: "input.encoding_guessed", problem: "no BOM; read as UTF-8", _schema: { id: "parley.warning", version: "1.0.0" } });
  }
  if (kind === "failed") {
    lines.push({ event: "error", t: at + 2, seq: 3, run, code: "count.unreadable", problem: "it failed", _schema: { id: "parley.error", version: "2.0.0" } });
  }
  if (kind !== "failed") lines.push({ ...toolResult(run, 4), t: at + 3 });
  lines.push({ ...end(run, 5, path, { status: kind === "failed" ? 2 : 0 }), t: at + 4 });
  return writeReceipt(dir, run, lines);
}

/** A head, a result and an end: a run that recorded no decision at all. */
function silentReceipt(dir: string, run: string, at: number): string {
  const path = join(dir, `${run}.jsonl`);
  return writeReceipt(dir, run, [
    { ...head(run), t: at },
    { ...toolResult(run, 2), t: at + 1 },
    { ...end(run, 3, path), t: at + 2 },
  ]);
}

const idOf = (r: LoadedRecord) => `${r.run}:${r.seq}`;
const ids = (recs: readonly LoadedRecord[]) => recs.map(idOf);
const timeOrder = (recs: readonly LoadedRecord[]) =>
  [...recs].sort((a, b) => (a.t! - b.t!) || a.run.localeCompare(b.run) || (a.seq - b.seq)).map(idOf);

/** Where a record landed in the answer, by `(run, seq)`. */
const at = (answer: QueryAnswer, run: string, seq: number) => ids(answer.records).indexOf(`${run}:${seq}`);
const placed = (answer: QueryAnswer, run: string, seq: number) =>
  answer.ranking.ranked.find((r) => r.record.run === run && r.record.seq === seq)!;

/** A LoadedRecord without a filesystem, for the cases that are about the pure function. */
function loaded(run: string, seq: number, event: string, t: number, over: Record<string, unknown> = {}): LoadedRecord {
  return {
    run, seq, event, t, file: `/nowhere/${run}.jsonl`, line: seq, copies: 1, fromSidecar: false,
    projected: false, projectedBy: [],
    record: { event, t, seq, run, _schema: { id: `parley.${event}`, version: "1.0.0" }, ...over },
    validation: { state: "unvalidated", schema: null, why: "no_schema_ref" },
  };
}

describe("RD-17 the view's surface orders the answer", () => {
  const seedThree = (dir: string) => {
    const receipts = repoReceipts(dir);
    richReceipt(receipts, runId(1), T0 - 3 * DAY);
    richReceipt(receipts, runId(2), T0 - 2 * DAY);
    richReceipt(receipts, runId(3), T0 - DAY);
    return receipts;
  };
  const read = async (view: string) => {
    const { dir, env } = scratch();
    seedThree(dir);
    return answered(await queryReceipts({ asker: { tool: "t" }, view, window: WIDE }, { cwd: dir, env }));
  };

  test("the view's surface ranks above the records that do not touch it", async () => {
    const answer = await read("what-changed");
    const surface = answer.ranking.ranked.filter((r) => r.tier === "surface");
    expect(surface.map((r) => r.record.event)).toEqual(["result", "result", "result"]);
    const last = Math.max(...surface.map((r) => r.rank));
    const off = answer.ranking.ranked.filter((r) => r.tier !== "surface");
    expect(off.length).toBe(9);
    expect(Math.min(...off.map((r) => r.rank))).toBeGreaterThan(last);
    expect(answer.records.length).toBe(12);
    expect(answer.ranking.counts.failure).toBe(0);
    expect(surface[0]!.why.join(" ")).toContain("what-changed");
  });

  test("how-it-decided puts the decisions first", async () => {
    const answer = await read("how-it-decided");
    expect(answer.records.slice(0, 3).map((r) => r.event)).toEqual(["receipt.step", "receipt.step", "receipt.step"]);
    expect(answer.records.slice(3).some((r) => r.event === "receipt.step")).toBe(false);
    expect(timeOrder(answer.records.slice(0, 3))).toEqual(ids(answer.records.slice(0, 3)));
    expect(timeOrder(answer.records.slice(3))).toEqual(ids(answer.records.slice(3)));
  });

  test("what-ran puts the heads and the ends first", async () => {
    const answer = await read("what-ran");
    expect(answer.records.slice(0, 6).map((r) => r.event)).toEqual(["receipt.head", "end", "receipt.head", "end", "receipt.head", "end"]);
    expect(answer.records.slice(6).map((r) => r.event)).toEqual(["receipt.step", "result", "receipt.step", "result", "receipt.step", "result"]);
  });

  test("the identity view ranks nothing", async () => {
    const answer = await read("everything");
    expect(ids(answer.records)).toEqual(timeOrder(answer.records));
    expect(answer.ranking.ranked.every((r) => r.tier === "surface")).toBe(true);
    expect(answer.ranking.impliesChange).toBe(false);
  });

  test("a view no record touches leaves the time order alone and hides nothing", async () => {
    const { dir, env } = scratch();
    const receipts = repoReceipts(dir);
    silentReceipt(receipts, runId(1), T0 - 2 * DAY);
    silentReceipt(receipts, runId(2), T0 - DAY);
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "how-it-decided", window: WIDE }, { cwd: dir, env }));
    expect(answer.records.length).toBe(6);
    expect(ids(answer.records)).toEqual(timeOrder(answer.records));
    expect(answer.ranking.ranked.every((r) => r.tier === "other")).toBe(true);
    expect(answer.ranking.counts.surface).toBe(0);
  });

  test("two records stamped the same millisecond are ordered by run and seq", async () => {
    const { dir, env } = scratch();
    const receipts = repoReceipts(dir);
    const [a, b] = [runId(7), runId(3)];
    writeReceipt(receipts, a, [{ ...head(a), t: T0 }, { ...end(a, 2, join(receipts, `${a}.jsonl`)), t: T0 }]);
    writeReceipt(receipts, b, [{ ...head(b), t: T0 }, { ...end(b, 2, join(receipts, `${b}.jsonl`)), t: T0 }]);
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "everything", window: WIDE }, { cwd: dir, env }));
    expect(ids(answer.records)).toEqual([`${b}:1`, `${b}:2`, `${a}:1`, `${a}:2`]);
  });

  test("rankRecords is pure and its order does not depend on the input order", () => {
    const { dir, env } = scratch();
    seedThree(dir);
    const plan = planQuery({ asker: { tool: "t" }, view: "what-changed", window: WIDE });
    if (plan.refused) throw new Error("the plan was refused");
    const records = loadReceipts({ cwd: dir, env }).bundles.flatMap((b) => b.records);
    const once = rankRecords(plan.query, records);
    const twice = rankRecords(plan.query, records);
    const shuffled = rankRecords(plan.query, [...records].reverse());
    expect(ids(twice.records)).toEqual(ids(once.records));
    expect(ids(shuffled.records)).toEqual(ids(once.records));
    const after = loadReceipts({ cwd: dir, env });
    expect(ids(records)).toEqual(ids(after.bundles.flatMap((b) => b.records)));
    expect(after.bundles.length).toBe(3);
    expect(after.bundles.flatMap((b) => b.records).some((r) => r.event === "query")).toBe(false);
  });

  test("a record with no usable t sorts last in its tier rather than anywhere", () => {
    const plan = planQuery({ asker: { tool: "t" }, view: "what-changed", window: WIDE });
    if (plan.refused) throw new Error("the plan was refused");
    const run = runId(1);
    const undated: LoadedRecord = { ...loaded(run, 3, "result", 0, { _schema: { id: "t.count", version: "1.0.0" } }), t: null };
    const ranking = rankRecords(plan.query, [
      undated,
      loaded(run, 4, "result", T0 + 10, { _schema: { id: "t.count", version: "1.0.0" } }),
      loaded(run, 1, "receipt.head", T0),
      loaded(run, 2, "end", T0 + 20, { status: 0 }),
    ]);
    expect(ids(ranking.records)).toEqual([`${run}:4`, `${run}:3`, `${run}:1`, `${run}:2`]);
    expect(ranking.ranked[1]!.tier).toBe("surface");
    expect(ranking.ranked[1]!.why.join(" ")).toContain("no usable t");
    expect(ranking.records.length).toBe(4);
  });
});

describe("RD-18 a purpose that implies a change puts the failures first", () => {
  const seedPair = (dir: string) => {
    const receipts = repoReceipts(dir);
    richReceipt(receipts, runId(1), T0 - 2 * DAY, "failed");
    richReceipt(receipts, runId(2), T0 - DAY, "ok");
    return receipts;
  };

  test("a change purpose puts the failure surface first", async () => {
    const { dir, env } = scratch();
    seedPair(dir);
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "what-changed", window: WIDE }, { cwd: dir, env }));
    expect(answer.ranking.impliesChange).toBe(true);
    expect(ids(answer.records).slice(0, 2)).toEqual([`${runId(1)}:3`, `${runId(1)}:5`]);
    expect(answer.records.slice(0, 2).map((r) => r.event)).toEqual(["error", "end"]);
    expect(placed(answer, runId(1), 3).tier).toBe("failure");
    expect(placed(answer, runId(1), 3).why.join(" ")).toContain("failure surface");
    expect(placed(answer, runId(1), 1).outcome).toBe("failed");
    expect(placed(answer, runId(2), 1).outcome).toBe("succeeded");
    // the failed run's head, off both surfaces, still ranks above the successful run's
    expect(at(answer, runId(1), 1)).toBeLessThan(at(answer, runId(2), 1));
    // and the successful run's result, on the surface, ranks above every off-surface record
    expect(at(answer, runId(2), 4)).toBeLessThan(at(answer, runId(1), 1));
    expect(answer.ranking.counts.failure).toBe(2);
    expect(answer.records.length).toBe(8);
  });

  test("a view that implies no change promotes no failure", async () => {
    const one = scratch(), two = scratch();
    seedPair(one.dir); seedPair(two.dir);
    const all = answered(await queryReceipts({ asker: { tool: "t" }, view: "everything", window: WIDE }, { cwd: one.dir, env: one.env }));
    expect(ids(all.records)).toEqual(timeOrder(all.records));
    expect(all.ranking.counts.failure).toBe(0);
    expect(all.ranking.ranked.every((r) => r.outcome === "failed" || r.outcome === "succeeded")).toBe(true);

    const ran = answered(await queryReceipts({ asker: { tool: "t" }, view: "what-ran", window: WIDE }, { cwd: two.dir, env: two.env }));
    expect(ran.ranking.impliesChange).toBe(false);
    expect(ran.ranking.counts.failure).toBe(0);
    expect(ids(ran.records)[0]).toBe(`${runId(1)}:1`);
    expect(ran.records[0]!.event).toBe("receipt.head");
  });

  test("a window with only successes ranks by surface and then by time", async () => {
    const { dir, env } = scratch();
    const receipts = repoReceipts(dir);
    richReceipt(receipts, runId(1), T0 - 2 * DAY);
    richReceipt(receipts, runId(2), T0 - DAY);
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "what-changed", window: WIDE }, { cwd: dir, env }));
    expect(answer.ranking.impliesChange).toBe(true);
    expect(answer.ranking.counts.failure).toBe(0);
    expect(answer.ranking.counts.succeededRuns).toBe(2);
    expect(ids(answer.records).slice(0, 2)).toEqual([`${runId(1)}:4`, `${runId(2)}:4`]);
    expect(ids(answer.records.slice(2))).toEqual(timeOrder(answer.records.slice(2)));
    expect(answer.records.length).toBe(8);
  });

  test("a run whose end the window does not hold is undetermined, not guessed", async () => {
    const { dir, env } = scratch();
    const receipts = repoReceipts(dir);
    richReceipt(receipts, runId(1), T0 - 3 * DAY, "failed");
    richReceipt(receipts, runId(2), T0 - 2 * DAY);
    richReceipt(receipts, runId(3), T0 - DAY);
    const window = { from: 0, to: T0 - DAY + 1 };
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "what-changed", window }, { cwd: dir, env }));
    expect(answer.ranking.outcomes[runId(1)]).toBe("failed");
    expect(answer.ranking.outcomes[runId(2)]).toBe("succeeded");
    expect(answer.ranking.outcomes[runId(3)]).toBe("undetermined");
    expect(answer.ranking.counts.undeterminedRuns).toBe(1);
    // the undetermined run is the latest in time and still ranks above the run known to have succeeded
    expect(at(answer, runId(3), 1)).toBeLessThan(at(answer, runId(2), 1));
    expect(at(answer, runId(1), 1)).toBeLessThan(at(answer, runId(3), 1));
    expect(placed(answer, runId(3), 1).why.join(" ")).toContain("not established");
  });

  test("a warning in a run that succeeded is not promoted and does not make its run a failed one", async () => {
    const { dir, env } = scratch();
    richReceipt(repoReceipts(dir), runId(1), T0 - DAY, "warned");
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "what-changed", window: WIDE }, { cwd: dir, env }));
    expect(placed(answer, runId(1), 3).record.event).toBe("warning");
    // off what-changed's surface, and its run went on (§6.1), so the view's own rule places it
    expect(placed(answer, runId(1), 3).tier).toBe("other");
    expect(ids(answer.records)[0]).toBe(`${runId(1)}:4`);
    expect(at(answer, runId(1), 4)).toBeLessThan(at(answer, runId(1), 3));
    expect(answer.ranking.counts.failure).toBe(0);
    expect(answer.ranking.outcomes[runId(1)]).toBe("succeeded");
    expect(answer.ranking.counts.failedRuns).toBe(0);
    expect(answer.records.length).toBe(5);
  });
});

describe("RD-40 under a change view a warning ranks with its run's failure", () => {
  /** A run that warned, then either went on to a result and an end of 0 or failed with an error and status 2. */
  const warnedRun = (dir: string, run: string, at: number, fate: "succeeded" | "failed" | "cut") => {
    const path = join(dir, `${run}.jsonl`);
    const lines: object[] = [
      { ...head(run), t: at },
      { event: "warning", t: at + 1, seq: 2, run, code: "graft.review_failed", problem: "graft is not answering", _schema: { id: "parley.warning", version: "1.0.0" } },
    ];
    if (fate === "failed") {
      lines.push({ event: "error", t: at + 2, seq: 3, run, code: "count.unreadable", problem: "it failed", _schema: { id: "parley.error", version: "2.0.0" } });
    } else {
      lines.push({ ...toolResult(run, 3), t: at + 2 });
    }
    lines.push({ ...end(run, 4, path, { status: fate === "failed" ? 2 : 0 }), t: fate === "cut" ? T0 + 10 * DAY : at + 3 });
    return writeReceipt(dir, run, lines);
  };
  const read = async (dir: string, env: Record<string, string>, view: string, window = WIDE, budget?: { records: number }) =>
    answered(await queryReceipts({ asker: { tool: "t" }, view, window, ...(budget ? { budget } : {}) }, { cwd: dir, env }));

  test("a history of runs that warned and went on still names the change surface first", async () => {
    const { dir, env } = scratch();
    const receipts = repoReceipts(dir);
    for (let i = 0; i < 25; i++) warnedRun(receipts, runId(i), T0 - (25 - i) * DAY, "succeeded");
    const answer = await read(dir, env, "what-changed", { from: 0, to: T0 + 1000 }, { records: 20 });
    expect(answer.counts.inWindow).toBe(100);
    expect(answer.digest.records.length).toBe(20);
    expect(answer.records.map((r) => r.event)).toEqual(Array(20).fill("result"));
    expect(answer.records.some((r) => r.event === "warning")).toBe(false);
    expect(answer.ranking.counts.failure).toBe(0);
    expect(answer.digest.loss).toEqual({ bound: "count-only", excluded: 80, folded: 0 });
  });

  test("a failed run's warning is promoted with its failure and a succeeded run's is not", async () => {
    const { dir, env } = scratch();
    const receipts = repoReceipts(dir);
    const [failed, ok] = [runId(1), runId(2)];
    warnedRun(receipts, failed, T0 - 2 * DAY, "failed");
    warnedRun(receipts, ok, T0 - DAY, "succeeded");
    const answer = await read(dir, env, "what-changed");
    // errors and non-zero ends still rank first, and the failed run's warning goes with them
    expect(ids(answer.records).slice(0, 3)).toEqual([`${failed}:2`, `${failed}:3`, `${failed}:4`]);
    expect(answer.records.slice(0, 3).map((r) => r.event)).toEqual(["warning", "error", "end"]);
    expect(answer.ranking.ranked.slice(0, 3).every((r) => r.tier === "failure")).toBe(true);
    expect(answer.ranking.counts.failure).toBe(3);
    // the succeeded run's result is the view's surface and ranks above its own warning
    expect(placed(answer, ok, 3).tier).toBe("surface");
    expect(placed(answer, ok, 2).tier).toBe("other");
    expect(at(answer, ok, 3)).toBeLessThan(at(answer, ok, 2));
    expect(placed(answer, ok, 2).why.join(" ")).toContain("not established as failed");
    expect(answer.records.length).toBe(8);
  });

  test("a warning in a run whose outcome is undetermined is not promoted", async () => {
    const { dir, env } = scratch();
    const receipts = repoReceipts(dir);
    const [cut, ok] = [runId(1), runId(2)];
    warnedRun(receipts, cut, T0 - 2 * DAY, "cut");
    warnedRun(receipts, ok, T0 - DAY, "succeeded");
    const answer = await read(dir, env, "what-changed", { from: 0, to: T0 });
    expect(answer.ranking.outcomes[cut]).toBe("undetermined");
    expect(placed(answer, cut, 2).tier).toBe("other");
    expect(answer.ranking.counts.failure).toBe(0);
    // within its tier, an undetermined run still ranks above a run known to have succeeded
    expect(at(answer, cut, 2)).toBeLessThan(at(answer, ok, 2));
    expect(answer.records.length).toBe(7);
  });

  test("what-failed keeps every warning on its surface", async () => {
    const { dir, env } = scratch();
    const receipts = repoReceipts(dir);
    const [failed, ok] = [runId(1), runId(2)];
    warnedRun(receipts, failed, T0 - 2 * DAY, "failed");
    warnedRun(receipts, ok, T0 - DAY, "succeeded");
    const answer = await read(dir, env, "what-failed");
    expect(placed(answer, failed, 2).tier).toBe("surface");
    expect(placed(answer, ok, 2).tier).toBe("surface");
    const surface = answer.ranking.ranked.filter((r) => r.tier === "surface");
    expect(surface.map((r) => r.record.event)).toEqual(["warning", "error", "end", "warning"]);
    expect(Math.max(...surface.map((r) => r.rank))).toBe(surface.length);
    expect(onFailureSurface(placed(answer, ok, 2).record)).toBe(true);
    expect(answer.records.length).toBe(8);
  });
});

describe("RD-19 ranking reorders and never filters", () => {
  test("all five views answer with the same records and only the order differs", async () => {
    const seed = (dir: string) => {
      const receipts = repoReceipts(dir);
      richReceipt(receipts, runId(1), T0 - 3 * DAY, "failed");
      richReceipt(receipts, runId(2), T0 - 2 * DAY, "warned");
      richReceipt(receipts, runId(3), T0 - DAY);
    };
    const orders: string[][] = [];
    for (const view of VIEWS) {
      const { dir, env } = scratch();
      seed(dir);
      const answer = answered(await queryReceipts({ asker: { tool: "t" }, view, window: WIDE }, { cwd: dir, env }));
      orders.push(ids(answer.records));
    }
    const held = orders.map((o) => [...o].sort().join("|"));
    expect(new Set(held).size).toBe(1);
    expect(orders[0]!.length).toBe(13);
    expect(new Set(orders.map((o) => o.join("|"))).size).toBeGreaterThan(1);
  });

  test("the golden case on receipts a real tool wrote", async () => {
    const { dir, state, env } = scratch();
    writeFileSync(join(dir, "a.txt"), "hello");
    const first = realRun(dir, state);
    symlinkSync(join(dir, "nothing-here"), join(dir, "dangling"));
    const broke = realRun(dir, state);
    rmSync(join(dir, "dangling"));
    const third = realRun(dir, state);
    const realDone = Date.now();
    expect([first.status, broke.status, third.status]).toEqual([0, 2, 0]);

    const window = { from: 0, to: realDone };
    const all = answered(await queryReceipts({ asker: { tool: "t" }, view: "everything", window }, { cwd: dir, env }));
    expect(ids(all.records)).toEqual(timeOrder(all.records));
    // The first and third runs are one invocation with one result, so the digest names the third
    // for both (flyingrobots/parley#79): the window holds 11 records, the digest names 7, and the
    // fold says it left out the first run's 4.
    expect(new Set(all.records.map((r) => r.run))).toEqual(new Set([broke.run, third.run]));
    expect(all.counts.inWindow).toBe(11);
    expect(all.records.length).toBe(7);
    expect(all.counts.folded).toBe(4);

    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "what-changed", window }, { cwd: dir, env }));
    const real = new Set([first.run, broke.run, third.run]);
    const realOnly = (a: QueryAnswer) => [...ids(a.records.filter((r) => real.has(r.run)))].sort();
    expect(realOnly(answer)).toEqual(realOnly(all));
    expect(realOnly(answer).length).toBe(7);
    expect(answer.ranking.outcomes[broke.run]).toBe("failed");
    expect(answer.ranking.outcomes[first.run]).toBe("succeeded");
    expect(answer.ranking.outcomes[third.run]).toBe("succeeded");
    expect(answer.records.slice(0, 2).map((r) => [r.run, r.event])).toEqual([[broke.run, "error"], [broke.run, "end"]]);
    const results = answer.ranking.ranked.filter((r) => r.record.event === "result");
    expect(results.length).toBe(1);
    expect(results.every((r) => r.tier === "surface")).toBe(true);
    for (const r of results) {
      const own = answer.ranking.ranked.filter((o) => o.record.run === r.record.run && o.record.event !== "result");
      expect(Math.min(...own.map((o) => o.rank))).toBeGreaterThan(r.rank);
    }
    expect(answer.load.counts.invalid).toBe(0);
    expect(answer.load.counts.quarantined).toBe(0);
  }, 60_000);

  test("six thousand records rank in bounded time", () => {
    const records: LoadedRecord[] = [];
    for (let i = 0; i < 1000; i++) {
      const run = runId(i);
      const t = T0 - (1000 - i) * 1000;
      const failed = i % 10 === 0;
      records.push(loaded(run, 1, "receipt.head", t, { effects: { reads: [], writes: [], network: false, idempotent: true } }));
      records.push(loaded(run, 2, "receipt.step", t + 1));
      records.push(loaded(run, 3, "receipt.step", t + 2));
      records.push(loaded(run, 4, "warning", t + 3, { code: "x.guessed", problem: "p" }));
      records.push(failed
        ? loaded(run, 5, "error", t + 4, { code: "x.failed", problem: "p" })
        : loaded(run, 5, "result", t + 4, { _schema: { id: "t.count", version: "1.0.0" } }));
      records.push(loaded(run, 6, "end", t + 5, { status: failed ? 2 : 0 }));
    }
    const thousand = records.slice(0, 1000);
    const plan = planQuery({ asker: { tool: "t" }, view: "what-changed", window: WIDE });
    if (plan.refused) throw new Error("the plan was refused");
    const query = plan.query;
    const startedSmall = Date.now();
    const small = rankRecords(query, thousand);
    const smallElapsed = Date.now() - startedSmall;
    const started = Date.now();
    const ranking: Ranking = rankRecords(query, records);
    const elapsed = Date.now() - started;
    expect(small.records.length).toBe(1000);
    expect(ranking.records.length).toBe(6000);
    expect(new Set(ids(ranking.records)).size).toBe(6000);
    expect(ranking.counts.failedRuns).toBe(100);
    // Measured on the development machine: ~1 ms for a thousand records and ~5 ms for six
    // thousand, worst of seven runs ~10 ms. The bounds below are two orders of magnitude of
    // headroom, so the case fails on a change of complexity rather than on a noisy machine.
    expect(smallElapsed).toBeLessThan(250);
    expect(elapsed).toBeLessThan(500);
  }, 60_000);
});

// ---- RD-20, RD-21, RD-22 the digest ------------------------------------------------------
//
// Spec §9: a result carries its own lens and reports what it excluded, at least as a count, so a
// later reader "cannot mistake a digest for the whole" (flyingrobots/parley#50). The digest is the
// `parley.lens` record the read emits through the writer, bounded by the query's budget, and the
// records the ranking placed beyond the bound are a count on that record and nowhere else.
//
// The windows below are **sealed** at T0 + 1 s: the seeded records are stamped at or before T0 and
// a read happens now, so a read's own records — and a previous read's — fall outside, and a case
// that reads twice reads the same window twice.
const SEALED = { from: 0, to: T0 + 1000 };

/** Seed `n` three-record receipts, one per day going back from T0, and return the record count. */
function seedDays(dir: string, n: number): number {
  const receipts = repoReceipts(dir);
  for (let i = 0; i < n; i++) datedReceipt(receipts, runId(i), T0 - (n - i) * DAY);
  return n * 3;
}

/** The `(run, seq)` pairs a digest names, as the record carries them. */
const digestIds = (answer: QueryAnswer) => answer.digest.records.map((r) => `${r.run}:${r.seq}`);

/** The lens record the read left in its own receipt, as the loader reads it back. */
function lensRecord(dir: string, env: Record<string, string>, run: string): LoadedRecord {
  const load = loadReceipts({ cwd: dir, env });
  const own = load.bundles.find((b) => b.run === run);
  if (!own) throw new Error(`the read's own bundle ${run} is not in the load`);
  const lens = own.records.find((r) => r.event === "lens");
  if (!lens) throw new Error(`the read's bundle ${run} holds no lens record`);
  return lens;
}

describe("RD-20 the first response is a digest", () => {
  test("a read answers with one lens record carried by its own run", async () => {
    const { dir, env } = scratch();
    seedDays(dir, 3);
    const answer = answered(await queryReceipts(
      { asker: { tool: "t", cwd: dir, task: "flyingrobots/parley#50" }, view: "what-ran", window: SEALED },
      { cwd: dir, env },
    ));
    const load = loadReceipts({ cwd: dir, env });
    const lenses = load.bundles.flatMap((b) => b.records).filter((r) => r.event === "lens");
    expect(lenses.length).toBe(1);
    expect(lenses[0]!.run).toBe(answer.run);
    const record = lenses[0]!.record as Record<string, unknown>;
    expect(record.query).toEqual({ run: answer.run, seq: answer.query.seq });
    expect(record.asker).toEqual({ tool: "t", cwd: dir, task: "flyingrobots/parley#50" });
    expect(record.view).toBe("what-ran");
    expect(record.window).toEqual(SEALED);
    expect(record.budget).toEqual({ records: 20 });
    // The answer's digest is the record's payload: the writer owns `t`, `seq`, `run` and `_schema`.
    const { t: _t, seq: _seq, run: _run, _schema: _pair, ...payload } = record;
    expect(payload).toEqual(answer.digest as unknown as typeof payload);
  });

  test("the digest loads as validated against parley.lens 1.1.0 in its own bundle", async () => {
    const { dir, env } = scratch();
    seedDays(dir, 2);
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "everything", window: SEALED }, { cwd: dir, env }));
    const load = loadReceipts({ cwd: dir, env });
    const own = load.bundles.find((b) => b.run === answer.run)!;
    expect(own.terminated).toBe(true);
    expect(own.status).toBe(0);
    expect(own.defects).toEqual([]);
    const lens = own.records.find((r) => r.event === "lens")!;
    expect(lens.validation.state).toBe("validated");
    expect((lens.validation as { schema: { id: string; version: string } }).schema).toEqual({ id: "parley.lens", version: "1.1.0" });
    expect(load.counts.invalid).toBe(0);
    expect(load.quarantined).toEqual([]);
  });

  test("the lens line the read put on its stream validates on its own", async () => {
    const { dir, env } = scratch();
    seedDays(dir, 2);
    const stdout = new Capture();
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "how-it-decided", window: SEALED }, { cwd: dir, env, stdout }));
    const line = answer.lines.find((l) => l.event === "lens")!;
    expect(line).toBeDefined();
    expect(validator().validate(line).state).toBe("validated");
    expect(stdout.objs[0]!.event).toBe("run");
    // The digest is the answer, so its line is the last the read puts on the stream before the run
    // closes: the query it answers is already there, and only the terminal event follows.
    const events = stdout.objs.map((o) => o.event);
    expect(events[events.length - 1]).toBe("end");
    expect(events[events.length - 2]).toBe("lens");
    expect(events.indexOf("query")).toBeLessThan(events.indexOf("lens"));
    // The bytes the read reported are the bytes it wrote.
    const written = stdout.lines.find((l) => l.includes("\"event\":\"lens\""))!;
    expect(answer.digestBytes).toBe(Buffer.byteLength(written, "utf8"));
    // And the reconstruction the byte bound is measured against is that line, byte for byte: the
    // digest's own serialisation, given the envelope the writer really used, is what went out.
    const lens = lensRecord(dir, env, answer.run);
    expect(digestLine(answer.digest, { run: answer.run, seq: lens.seq, t: lens.t! })).toBe(written);
    expect(digestBytes(answer.digest, { run: answer.run, seq: lens.seq, t: lens.t! })).toBe(answer.digestBytes);
  });

  test("the digest names the records the answer holds, in rank order", async () => {
    const { dir, env } = scratch();
    seedDays(dir, 3);
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "what-changed", window: SEALED }, { cwd: dir, env }));
    expect(digestIds(answer)).toEqual(ids(answer.records));
    expect(answer.digest.records.length).toBe(answer.records.length);
    expect(answer.counts.answered).toBe(answer.records.length);
  });
});

describe("RD-21 the digest is bounded by the budget", () => {
  test("a digest names at most the budget's records and counts the rest as excluded", async () => {
    const { dir, env } = scratch();
    const total = seedDays(dir, 10);
    expect(total).toBe(30);
    const answer = answered(await queryReceipts(
      { asker: { tool: "t" }, view: "everything", window: SEALED, budget: { records: 7 } },
      { cwd: dir, env },
    ));
    expect(answer.records.length).toBe(7);
    expect(answer.digest.records.length).toBe(7);
    expect(answer.digest.loss).toEqual({ bound: "count-only", excluded: 23, folded: 0 });
    expect(answer.counts.inWindow).toBe(30);
    expect(answer.counts.answered).toBe(7);
    expect(answer.counts.excluded).toBe(23);
    expect(answer.digest.budget).toEqual({ records: 7 });
  });

  test("a bytes budget bounds the digest line and raises the excluded count", async () => {
    const { dir, env } = scratch();
    seedDays(dir, 10);
    const loose = answered(await queryReceipts(
      { asker: { tool: "t" }, view: "everything", window: SEALED, budget: { records: 7 } },
      { cwd: dir, env },
    ));
    const bytes = loose.digestBytes - 100;
    const tight = answered(await queryReceipts(
      { asker: { tool: "t" }, view: "everything", window: SEALED, budget: { records: 7, bytes } },
      { cwd: dir, env },
    ));
    expect(tight.digestBytes).toBeLessThanOrEqual(bytes);
    expect(tight.digest.records.length).toBeLessThan(7);
    expect(tight.records.length).toBe(tight.digest.records.length);
    expect(tight.digest.loss.excluded).toBe(30 - tight.records.length);
    expect(tight.digest.loss.bound).toBe("count-only");
    // The same window, read twice: the bytes bound, not the history, is what moved.
    expect(tight.counts.inWindow).toBe(loose.counts.inWindow);
    // A bytes budget too small even for an empty digest declines rather than writing a line over
    // the bound (flyingrobots/parley#71, RD-72).
    const none = await queryReceipts(
      { asker: { tool: "t" }, view: "everything", window: SEALED, budget: { records: 7, bytes: 1 } },
      { cwd: dir, env },
    );
    expect(none.refused).toBe(false);
    if (!none.refused) expect(none.declined).toBe(true);
  });

  test("what the bound excluded is nowhere in the answer, and the count accounts for all of it", async () => {
    const { dir, env } = scratch();
    seedDays(dir, 10);
    // A budget wide enough to hold the window is the oracle for what the window held; the same
    // sealed window read under a budget of five is what the bound did to it.
    const whole = answered(await queryReceipts(
      { asker: { tool: "t" }, view: "what-ran", window: SEALED, budget: { records: 1000 } },
      { cwd: dir, env },
    ));
    const answer = answered(await queryReceipts(
      { asker: { tool: "t" }, view: "what-ran", window: SEALED, budget: { records: 5 } },
      { cwd: dir, env },
    ));
    const named = new Set(digestIds(answer));
    expect(named.size).toBe(5);
    expect(answer.counts.inWindow).toBe(30);
    expect(answer.digest.loss.excluded).toBe(answer.counts.inWindow - named.size);
    // The digest is the head of the order the wide read answered in, and what it cut is the tail.
    const order = ids(whole.records);
    expect(order.length).toBe(30);
    expect(order.slice(0, 5)).toEqual([...named]);
    // Not one excluded record is anywhere in the bounded answer: not in its records, not in the
    // digest, not in the ranking it carries. The count is all a caller gets, which is why
    // fetching them is flyingrobots/parley#51.
    const cut = order.slice(5);
    expect(cut.length).toBe(25);
    const anywhere = new Set([...ids(answer.records), ...digestIds(answer), ...ids(answer.ranking.records)]);
    expect(cut.filter((id) => anywhere.has(id))).toEqual([]);
    expect([...anywhere].sort()).toEqual([...named].sort());
  });

  test("a window that fits the budget excludes nothing and says the loss is none", async () => {
    const { dir, env } = scratch();
    seedDays(dir, 3);
    const answer = answered(await queryReceipts(
      { asker: { tool: "t" }, view: "everything", window: SEALED, budget: { records: 20 } },
      { cwd: dir, env },
    ));
    expect(answer.records.length).toBe(9);
    expect(answer.digest.loss).toEqual({ bound: "none", excluded: 0, folded: 0 });
    expect(answer.counts.excluded).toBe(0);
  });

  test("an empty history answers with an empty digest that excludes nothing", async () => {
    const { dir, env } = scratch();
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "everything", window: SEALED }, { cwd: dir, env }));
    expect(answer.records).toEqual([]);
    expect(answer.digest.records).toEqual([]);
    expect(answer.digest.loss).toEqual({ bound: "none", excluded: 0, folded: 0 });
    expect(answer.counts.answered).toBe(0);
    expect(answer.counts.excluded).toBe(0);
    const lens = lensRecord(dir, env, answer.run);
    expect(lens.validation.state).toBe("validated");
    expect((lens.record as { loss: unknown }).loss).toEqual({ bound: "none", excluded: 0, folded: 0 });
  });
});

describe("RD-22 a digest never reads as complete", () => {
  test("a truncated digest says count-only and a nonzero count", async () => {
    const { dir, env } = scratch();
    seedDays(dir, 10);
    const cut = answered(await queryReceipts(
      { asker: { tool: "t" }, view: "everything", window: SEALED, budget: { records: 4 } },
      { cwd: dir, env },
    ));
    expect(cut.digest.loss.bound).toBe("count-only");
    expect(cut.digest.loss.excluded).toBeGreaterThan(0);
    const whole = answered(await queryReceipts(
      { asker: { tool: "t" }, view: "everything", window: SEALED, budget: { records: 1000 } },
      { cwd: dir, env },
    ));
    expect(whole.digest.loss).toEqual({ bound: "none", excluded: 0, folded: 0 });
    // The loss is where the digest says what it is: there is no prose field to read instead, and
    // `none` is impossible with a non-zero count because the schema refuses it.
    const lens = validator();
    const asRecord = (a: QueryAnswer) => a.lines.find((l) => l.event === "lens")!;
    expect(lens.validate({ ...asRecord(cut), loss: { bound: "none", excluded: cut.digest.loss.excluded } }).state).toBe("invalid");
    expect(Object.keys(cut.digest.loss).sort()).toEqual(["bound", "excluded", "folded"]);
  });

  test("the digest's size stays under its bound as history grows", async () => {
    const BYTES = 2048;
    const named: number[] = [];
    const excluded: number[] = [];
    const sizes: number[] = [];
    for (const receipts of [3, 30, 300]) {
      const { dir, env } = scratch();
      seedDays(dir, receipts);
      const answer = answered(await queryReceipts(
        // The asker states its cwd, so the line does not grow with the length of the machine's
        // temporary directory and the measured sizes below hold on any machine.
        { asker: { tool: "t", cwd: "/w" }, view: "everything", window: SEALED, budget: { records: 20, bytes: BYTES } },
        { cwd: dir, env },
      ));
      named.push(answer.digest.records.length);
      excluded.push(answer.digest.loss.excluded);
      sizes.push(answer.digestBytes);
      expect(answer.counts.inWindow).toBe(receipts * 3);
      // The bytes the read reported are the bytes the receipt holds.
      const held = lensRecord(dir, env, answer.run);
      expect(Buffer.byteLength(JSON.stringify(held.record) + "\n", "utf8")).toBe(answer.digestBytes);
    }
    // A hundredfold more history, and the bytes cut before the record count does: each entry
    // carries its summary (flyingrobots/parley#77), and each run it names has a section stating
    // its identity and outcome once (flyingrobots/parley#83), about 100 bytes for each of these
    // three-record runs, while the entries lost the outcome they each repeated. 13 entries, the
    // whole of four runs and the head of a fifth, with five sections, fit at 30 receipts and at
    // 300 alike; the fourteenth entry, about 80 bytes, does not. The loss also says how much of
    // it a fold left out (flyingrobots/parley#79), `"folded":0` here because these heads carry no
    // `inv`: eleven bytes more on every line, and no fewer records. Measured, not claimed.
    // Each section also carries its head's `resolved` (flyingrobots/parley#90), here
    // `{"command":"count"}`, 31 bytes a section, which costs the thirteenth entry.
    expect(named).toEqual([9, 12, 12]);
    expect(excluded).toEqual([0, 78, 888]);
    expect(sizes).toEqual([1526, 1916, 1917]);
    // Every line is inside the stated byte bound: the line does not grow with history.
    expect(sizes.every((b) => b <= BYTES)).toBe(true);
  }, 120_000);

  test("the digest on receipts a real tool wrote validates against its schema", async () => {
    const { dir, state, env } = scratch();
    writeFileSync(join(dir, "a.txt"), "hello");
    const first = realRun(dir, state);
    symlinkSync(join(dir, "nothing-here"), join(dir, "dangling"));
    const broke = realRun(dir, state);
    rmSync(join(dir, "dangling"));
    const third = realRun(dir, state);
    expect([first.status, broke.status, third.status]).toEqual([0, 2, 0]);

    const window = { from: 0, to: Date.now() };
    const answer = answered(await queryReceipts(
      { asker: { tool: "t", task: "flyingrobots/parley#50" }, view: "what-changed", window, budget: { records: 2 } },
      { cwd: dir, env },
    ));
    expect(answer.counts.inWindow).toBe(11);
    expect(answer.records.length).toBe(2);
    // The first run is folded into the third, one invocation with one result (flyingrobots/parley#79):
    // its 4 records are part of the 9 excluded, and the loss says so.
    expect(answer.digest.loss).toEqual({ bound: "count-only", excluded: 9, folded: 4 });
    // The failing run's error is what a change purpose puts first, and the digest keeps it.
    expect(answer.digest.records[0]).toEqual({
      run: broke.run, seq: answer.records[0]!.seq, event: "error", t: answer.records[0]!.t!, code: answer.records[0]!.record.code as string,
    });
    expect(answer.records[0]!.run).toBe(broke.run);

    const lens = lensRecord(dir, env, answer.run);
    expect(lens.validation.state).toBe("validated");
    expect((lens.validation as { schema: { id: string; version: string } }).schema).toEqual({ id: "parley.lens", version: "1.1.0" });
    const { event, ...rest } = answer.digest;
    expect(lens.record).toEqual({
      event, t: lens.t!, seq: lens.seq, run: answer.run,
      ...rest, _schema: { id: "parley.lens", version: "1.1.0" },
    } as unknown as typeof lens.record);
    expect(answer.load.counts.invalid).toBe(0);
    expect(answer.load.counts.quarantined).toBe(0);
  }, 60_000);
});

// ---- RD-23 the least-projected copy -------------------------------------------------------
//
// Spec §8: a copy of a run on the shared history stream may be a projection of the receipt copy,
// and "a reader that finds the same record in more than one copy should then prefer the
// least-projected one, because the receipt copy is the record and a projection is a view of it".
// What makes a copy a projection is the `parley.history.transform` line the source carries for
// that run, so the rule is about what a source says about a run and never about which file was
// read first — the failure mode flyingrobots/parley#58 names.

const NARROW_NAMES = sha("narrow-names");
const WHAT_RAN = sha("what-ran");

/** The opening line of a projected copy: stream only, at a `seq` of its own (§8). */
function transformLine(run: string, seq: number, name: string, digest: string) {
  return {
    event: "history.transform", t: 1795326412344, seq, run, name, sha256: digest,
    _schema: { id: "parley.history.transform", version: "1.0.0" },
  };
}

/** A segment of the shared stream, verbatim: it is one file holding many runs, not one run's receipt. */
function writeSegment(dir: string, name: string, lines: (object | string)[]): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  return path;
}

const histDir = (cwd: string) => join(cwd, "history");
const NAMES = { names: ["a.txt", "b.txt"] };
/** What the projection leaves of `NAMES`: a narrowed value, not an omitted field. */
const NARROWED = { names: ["a.txt"] };

/**
 * One projected run, in the layout the writer's own produces: the stream copy opens with the
 * transform line at `seq: 1`, so the receipt has no line at that `seq` and starts at 2. The
 * stream's step carries a narrowed `detail` and its `result` is withheld altogether.
 */
function projectedRun(dir: string, run = RUN_A) {
  const receipts = repoReceipts(dir);
  const receipt = join(receipts, `${run}.jsonl`);
  writeReceipt(receipts, run, [
    { ...head(run), seq: 2 }, step(run, 3, { detail: NAMES }), toolResult(run, 4), end(run, 5, receipt),
  ]);
  const segment = writeSegment(histDir(dir), "2026-11-22.jsonl", [
    transformLine(run, 1, "narrow-names", NARROW_NAMES),
    { ...head(run), seq: 2 }, step(run, 3, { detail: NARROWED }), end(run, 5, receipt),
  ]);
  return { receipt, segment };
}

const detailOf = (r: LoadedRecord) => (r.record as { detail?: unknown }).detail;
const atSeq = (b: Bundle, seq: number) => b.records.find((r) => r.seq === seq)!;

describe("RD-23 the least-projected copy", () => {
  test("the receipt's bodies win over a projected stream copy", () => {
    const { dir, env } = scratch();
    const { receipt, segment } = projectedRun(dir);
    const load = loadReceipts({ cwd: dir, env, history: [segment] });
    const [bundle] = load.bundles;
    expect(seqs(bundle!)).toEqual([1, 2, 3, 4, 5]);

    const narrowed = atSeq(bundle!, 3);
    expect(detailOf(narrowed)).toEqual(NAMES);
    expect(narrowed.projected).toBe(false);
    expect(narrowed.projectedBy).toEqual([]);
    expect(narrowed.file).toBe(receipt);
    expect(narrowed.copies).toBe(2);

    expect(bundle!.projections.length).toBe(1);
    const note = bundle!.projections[0]!;
    expect(note.name).toBe("narrow-names");
    expect(note.sha256).toBe(NARROW_NAMES);
    expect(note.file).toBe(segment);
    expect(note.where).toBe("history");
    expect(note.seq).toBe(1);
    expect(note.superseded).toEqual([3]);
    expect(note.withheld).toEqual([4]);
    expect(note.sole).toBe(false);
    expect(bundle!.defects).toEqual([]);

    // The opening line is a record in its own right, at the one `seq` only the stream carries.
    const opening = atSeq(bundle!, 1);
    expect(opening.event).toBe("history.transform");
    expect(opening.projected).toBe(true);
    expect(opening.projectedBy).toEqual(["narrow-names"]);
    expect(opening.validation.state).toBe("validated");
  });

  test("identical copies dedupe as they did before projections", () => {
    const { dir, env } = scratch();
    const receipts = repoReceipts(dir);
    const receipt = join(receipts, `${RUN_A}.jsonl`);
    const lines = [{ ...head(RUN_A), seq: 2 }, step(RUN_A, 3, { detail: NAMES }), end(RUN_A, 4, receipt)];
    writeReceipt(receipts, RUN_A, lines);

    const plain = writeSegment(histDir(dir), "2026-11-21.jsonl", lines);
    const bare = loadReceipts({ cwd: dir, env, history: [plain] }).bundles[0]!;
    expect(seqs(bare)).toEqual([2, 3, 4]);
    expect(bare.records.every((r) => r.copies === 2 && r.projected === false)).toBe(true);
    expect(bare.projections).toEqual([]);
    expect(bare.defects).toEqual([]);
    expect(detailOf(atSeq(bare, 3))).toEqual(NAMES);

    // The same copy, this time saying it is a projection: the note is there, and it supersedes
    // nothing, because a transform that narrowed nothing left the bodies alone.
    const marked = writeSegment(histDir(dir), "2026-11-22.jsonl", [transformLine(RUN_A, 1, "identity", WHAT_RAN), ...lines]);
    const kept = loadReceipts({ cwd: dir, env, history: [marked] }).bundles[0]!;
    expect(seqs(kept)).toEqual([1, 2, 3, 4]);
    expect(kept.records.filter((r) => r.seq > 1).every((r) => r.copies === 2 && r.projected === false)).toBe(true);
    expect(kept.projections.length).toBe(1);
    expect(kept.projections[0]!.superseded).toEqual([]);
    expect(kept.projections[0]!.withheld).toEqual([]);
    expect(kept.defects).toEqual([]);
  });

  test("a seq the projected copy withholds is attributed to its transform", () => {
    const { dir, env } = scratch();
    const receipts = repoReceipts(dir);
    const receipt = join(receipts, `${RUN_A}.jsonl`);
    writeReceipt(receipts, RUN_A, [
      { ...head(RUN_A), seq: 2 }, step(RUN_A, 3), toolResult(RUN_A, 4), end(RUN_A, 5, receipt),
    ]);
    const segment = writeSegment(histDir(dir), "2026-11-22.jsonl", [
      transformLine(RUN_A, 1, "what-ran", WHAT_RAN), { ...head(RUN_A), seq: 2 }, end(RUN_A, 5, receipt),
    ]);
    const bundle = loadReceipts({ cwd: dir, env, history: [segment] }).bundles[0]!;
    expect(seqs(bundle)).toEqual([1, 2, 3, 4, 5]);
    const note = bundle.projections[0]!;
    expect(note.withheld).toEqual([3, 4]);
    expect(note.superseded).toEqual([]);
    expect(atSeq(bundle, 3).projected).toBe(false);
    expect(atSeq(bundle, 4).projected).toBe(false);
    // A withheld line is what a transform is for: it is named, and it is not a defect.
    expect(bundle.defects).toEqual([]);
  });

  test("a copy that is only on the stream is returned and marked projected", () => {
    const { dir, env } = scratch();
    const { segment } = projectedRun(dir);
    rmSync(repoReceipts(dir), { recursive: true, force: true });

    const bundle = loadReceipts({ cwd: dir, env, history: [segment] }).bundles[0]!;
    expect(seqs(bundle)).toEqual([1, 2, 3, 5]);
    const narrowed = atSeq(bundle, 3);
    expect(detailOf(narrowed)).toEqual(NARROWED);
    expect(narrowed.projected).toBe(true);
    expect(narrowed.projectedBy).toEqual(["narrow-names"]);
    expect(bundle.projections.length).toBe(1);
    expect(bundle.projections[0]!.sole).toBe(true);
    expect(bundle.projections[0]!.superseded).toEqual([]);
    expect(bundle.projections[0]!.withheld).toEqual([]);

    // The same segment read on its own, by name.
    const file = readHistorySegment(segment);
    expect(file.where).toBe("history");
    expect(file.bundles[0]!.projections[0]!.sole).toBe(true);
    expect(file.bundles[0]!.records.every((r) => r.projected)).toBe(true);
  });

  test("two projections of one run disagree as projections, not as a writer's copies", () => {
    const { dir, env } = scratch();
    const receipt = join(repoReceipts(dir), `${RUN_A}.jsonl`);
    const copy = (name: string, n: number) => [
      transformLine(RUN_A, 1, name, sha(name)),
      { ...head(RUN_A), seq: 2 }, step(RUN_A, 3, { detail: { n } }), end(RUN_A, 4, receipt),
    ];
    const alpha = writeSegment(histDir(dir), "alpha.jsonl", copy("alpha", 1));
    const beta = writeSegment(histDir(dir), "beta.jsonl", copy("beta", 2));

    const forward = loadReceipts({ cwd: dir, env, history: [alpha, beta] }).bundles[0]!;
    const backward = loadReceipts({ cwd: dir, env, history: [beta, alpha] }).bundles[0]!;
    for (const bundle of [forward, backward]) {
      expect(bundle.projections.map((p) => p.name)).toEqual(["alpha", "beta"]);
      expect(bundle.projections.every((p) => p.sole)).toBe(true);
      const narrowed = atSeq(bundle, 3);
      expect(narrowed.projected).toBe(true);
      expect(narrowed.projectedBy).toEqual(["alpha", "beta"]);
      expect(bundle.defects.length).toBeGreaterThan(0);
      expect(bundle.defects.every((d) => d.code === "copies.projected_disagree")).toBe(true);
      expect(bundle.defects.some((d) => d.code === "copies.disagree")).toBe(false);
    }
    // Neither copy is the less projected one, so the reader does not guess: the body it returns
    // is the same whichever order the two segments were handed to it in.
    expect(JSON.stringify(forward.records)).toBe(JSON.stringify(backward.records));
  });

  test("the least-projected copy wins whichever file was read first", () => {
    const whole = (receipt: string) => [
      { ...head(RUN_A), seq: 2 }, step(RUN_A, 3, { detail: NAMES }), end(RUN_A, 4, receipt),
    ];
    const narrow = (receipt: string) => [
      transformLine(RUN_A, 1, "narrow-names", NARROW_NAMES),
      { ...head(RUN_A), seq: 2 }, step(RUN_A, 3, { detail: NARROWED }), end(RUN_A, 4, receipt),
    ];
    // The two receipt locations stand in for "whichever source is read first": the repo location
    // is always read before the state one, so each arrangement puts a different copy first.
    for (const projectedFirst of [true, false]) {
      const { dir, env } = scratch();
      const repo = repoReceipts(dir);
      const state = receiptLocations({ cwd: dir, env })[1]!.dir;
      const receipt = join(repo, `${RUN_A}.jsonl`);
      writeReceipt(repo, RUN_A, projectedFirst ? narrow(receipt) : whole(receipt));
      writeReceipt(state, RUN_A, projectedFirst ? whole(receipt) : narrow(receipt));

      const bundle = loadReceipts({ cwd: dir, env }).bundles[0]!;
      expect(detailOf(atSeq(bundle, 3))).toEqual(NAMES);
      expect(atSeq(bundle, 3).projected).toBe(false);
      expect(bundle.projections.length).toBe(1);
      expect(bundle.projections[0]!.where).toBe(projectedFirst ? "repo" : "state");
      expect(bundle.projections[0]!.superseded).toEqual([3]);
      expect(bundle.defects).toEqual([]);
    }
  });

  test("a transform line names a run, so the other runs in a segment are unaffected", () => {
    const { dir, env } = scratch();
    const receipts = repoReceipts(dir);
    const pathA = join(receipts, `${RUN_A}.jsonl`);
    const pathB = join(receipts, `${RUN_B}.jsonl`);
    const runB = [head(RUN_B), step(RUN_B, 2, { detail: NAMES }), end(RUN_B, 3, pathB)];
    writeReceipt(receipts, RUN_A, [{ ...head(RUN_A), seq: 2 }, step(RUN_A, 3, { detail: NAMES }), end(RUN_A, 4, pathA)]);
    writeReceipt(receipts, RUN_B, runB);
    const segment = writeSegment(histDir(dir), "2026-11-22.jsonl", [
      transformLine(RUN_A, 1, "narrow-names", NARROW_NAMES),
      { ...head(RUN_A), seq: 2 }, step(RUN_A, 3, { detail: NARROWED }), end(RUN_A, 4, pathA),
      ...runB,
    ]);
    const load = loadReceipts({ cwd: dir, env, history: [segment] });
    const a = load.bundles.find((b) => b.run === RUN_A)!;
    const b = load.bundles.find((b) => b.run === RUN_B)!;
    expect(a.projections.length).toBe(1);
    expect(detailOf(atSeq(a, 3))).toEqual(NAMES);
    expect(b.projections).toEqual([]);
    expect(b.records.every((r) => r.copies === 2 && r.projected === false)).toBe(true);
    expect(detailOf(atSeq(b, 2))).toEqual(NAMES);
    expect(b.defects).toEqual([]);
  });

  test("a projected copy that changed the envelope is still a disagreement", () => {
    const { dir, env } = scratch();
    const receipts = repoReceipts(dir);
    const receipt = join(receipts, `${RUN_A}.jsonl`);
    writeReceipt(receipts, RUN_A, [{ ...head(RUN_A), seq: 2 }, step(RUN_A, 3, { detail: NAMES }), end(RUN_A, 4, receipt)]);
    const segment = writeSegment(histDir(dir), "2026-11-22.jsonl", [
      transformLine(RUN_A, 1, "narrow-names", NARROW_NAMES),
      { ...head(RUN_A), seq: 2 },
      { ...step(RUN_A, 3, { detail: NARROWED }), t: 1795326499999 },
      end(RUN_A, 4, receipt),
    ]);
    const bundle = loadReceipts({ cwd: dir, env, history: [segment] }).bundles[0]!;
    // §8 lets a projection narrow the body; it never changes the envelope, so §1.3 still holds.
    const disagreement = bundle.defects.filter((d) => d.code === "copies.disagree");
    expect(disagreement.length).toBe(1);
    expect(disagreement[0]!.section).toBe("§1.3");
    expect(disagreement[0]!.problem).toContain("on t");
    expect(bundle.records.find((r) => r.seq === 3)!.t).toBe(1795326412352);
    expect(detailOf(atSeq(bundle, 3))).toEqual(NAMES);
    expect(bundle.projections[0]!.superseded).toEqual([3]);
  });

  test("a read over a projected copy answers with the receipt's bodies and names the projection", async () => {
    const { dir, env } = scratch();
    const { segment } = projectedRun(dir);
    const answer = answered(await queryReceipts(
      { asker: { tool: "t" }, view: "everything", window: WIDE, budget: { records: 100 } },
      { cwd: dir, env, history: [segment] },
    ));
    const mine = answer.records.filter((r) => r.run === RUN_A);
    expect(mine.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(detailOf(mine.find((r) => r.seq === 3)!)).toEqual(NAMES);
    expect(mine.find((r) => r.seq === 3)!.projected).toBe(false);
    const opening = mine.find((r) => r.seq === 1)!;
    expect(opening.projected).toBe(true);
    expect(opening.projectedBy).toEqual(["narrow-names"]);
    expect(answer.load.bundles.find((b) => b.run === RUN_A)!.projections.map((p) => p.name)).toEqual(["narrow-names"]);
  });

  test("a history segment that cannot be read is reported, not thrown", () => {
    const { dir, env } = scratch();
    plainReceipt(repoReceipts(dir), RUN_A);
    const load = loadReceipts({ cwd: dir, env, history: [join(histDir(dir), "gone.jsonl")] });
    expect(load.bundles.length).toBe(1);
    expect(load.bundles[0]!.records.length).toBe(3);
    expect(load.defects.map((d) => d.code)).toEqual(["history.unreadable"]);
    expect(load.defects[0]!.section).toBe("§8");
  });

  test("a real writer run with a transform loads to the receipt's bodies with one projection note", async () => {
    const { dir, env } = scratch();
    const hist = mkdtempSync(join(tmpdir(), "parley-read-history-"));
    const dropDetail: HistoryTransform = (rec) => {
      if (rec.event === "result") return undefined;
      if (rec.event !== "receipt.step") return rec;
      const { detail: _detail, ...rest } = rec;
      return rest;
    };
    const written = await writerRun(dir, { ...env, PARLEY_HISTORY: hist }, ["count"], (run) => {
      run.step("counted the things", "the stream need not carry the rows", NAMES);
      run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" });
    }, { history: { transform: dropDetail, name: "drop-detail" } });
    expect(written.status).toBe(0);
    expect(written.history).toBeDefined();

    const load = loadReceipts({ cwd: dir, env, history: [written.history!] });
    const bundle = load.bundles.find((b) => b.run === written.run)!;
    expect(bundle.terminated).toBe(true);
    expect(bundle.defects).toEqual([]);
    expect(bundle.sources.map((s) => s.where)).toEqual(["repo", "history"]);

    expect(bundle.projections.length).toBe(1);
    const note = bundle.projections[0]!;
    expect(note.name).toBe("drop-detail");
    expect(note.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(note.sole).toBe(false);
    expect(note.file).toBe(written.history!);

    // The opening line took a `seq` the receipt has none at, and it is this reader's to validate.
    const opening = byEvent(bundle, "history.transform")!;
    expect(opening.seq).toBe(note.seq);
    expect(opening.projected).toBe(true);
    expect(opening.validation.state).toBe("validated");
    expect((opening.validation as { schema: { id: string; version: string } }).schema)
      .toEqual({ id: "parley.history.transform", version: "1.0.0" });

    // The receipt's step keeps the rows the stream copy dropped, and the result the stream never
    // carried is named as withheld rather than left as a gap of unknown cause.
    const counted = bundle.records.find((r) => (r.record as { decision?: string }).decision === "counted the things")!;
    expect(detailOf(counted)).toEqual(NAMES);
    expect(counted.projected).toBe(false);
    expect(counted.copies).toBe(2);
    expect(note.superseded).toEqual([counted.seq]);
    expect(note.withheld).toEqual([byEvent(bundle, "result")!.seq]);
  });
});

// ---- RD-50 a summary beside each record a lens names --------------------------------------
//
// flyingrobots/parley#77: a lens that names a record by `(run, seq)` alone makes a cold reader
// open it to learn what it is. Each entry carries the record's `event` and `t`, and the outcome
// the ranking established for its run, derived from the loaded record when the lens is built. The
// oracle in every case below is the loader read again afterwards, never the digest's own builder.
// Since flyingrobots/parley#83 the outcome is stated once per run, in the lens's `runs` section
// (RD-80), and an entry keeps its `event`, its `t` and, for an error or a warning, its `code`.

/** The keys a lens entry may carry, and no others. */
const ENTRY_KEYS = new Set(["run", "seq", "event", "t", "code"]);

/** Every loaded record in a directory, by `(run, seq)`, as a fresh load reports it. */
function loadedById(dir: string, env: Record<string, string>): Map<string, LoadedRecord> {
  const load = loadReceipts({ cwd: dir, env });
  return new Map(load.bundles.flatMap((b) => b.records).map((r) => [idOf(r), r] as const));
}

/** The entries of the lens the read left in its own receipt, as the loader reads them back. */
function heldEntries(dir: string, env: Record<string, string>, run: string): Record<string, unknown>[] {
  return (lensRecord(dir, env, run).record as { records: Record<string, unknown>[] }).records;
}

/** The `runs` section of the lens the read left in its own receipt, as the loader reads it back. */
function heldRuns(dir: string, env: Record<string, string>, run: string): Record<string, unknown>[] {
  return (lensRecord(dir, env, run).record as { runs: Record<string, unknown>[] }).runs;
}

/** The outcome each run's section states, by run id. */
function sectionOutcomes(runs: readonly Record<string, unknown>[]): Record<string, unknown> {
  return Object.fromEntries(runs.map((r) => [r.run as string, r.outcome]));
}

/** Assert each entry's summary is the loaded record's, and nothing else. */
function expectSummariesMatch(entries: readonly Record<string, unknown>[], byId: Map<string, LoadedRecord>) {
  for (const entry of entries) {
    const record = byId.get(`${entry.run}:${entry.seq}`);
    expect(record).toBeDefined();
    expect(Object.keys(entry).filter((k) => !ENTRY_KEYS.has(k))).toEqual([]);
    expect(entry.event).toBe(record!.event!);
    expect(entry.t).toBe(record!.t!);
    if (record!.event === "error" || record!.event === "warning") expect(entry.code).toBe(record!.record.code as string);
    else expect("code" in entry).toBe(false);
  }
}

describe("RD-50 a lens names each record with a summary of it", () => {
  test("a lens names each real record with the event and t the loader reports", async () => {
    const { dir, state, env } = scratch();
    writeFileSync(join(dir, "a.txt"), "hello");
    const first = realRun(dir, state);
    symlinkSync(join(dir, "nothing-here"), join(dir, "dangling"));
    const broke = realRun(dir, state);
    rmSync(join(dir, "dangling"));
    const third = realRun(dir, state);
    expect([first.status, broke.status, third.status]).toEqual([0, 2, 0]);

    const window = { from: 0, to: Date.now() };
    const answer = answered(await queryReceipts(
      { asker: { tool: "t", task: "flyingrobots/parley#77" }, view: "what-changed", window },
      { cwd: dir, env },
    ));
    // 11 in the window; the first run's 4 are folded into the third's (flyingrobots/parley#79).
    expect(answer.digest.records.length).toBe(7);
    const byId = loadedById(dir, env);
    const held = heldEntries(dir, env, answer.run);
    expect(held).toEqual(answer.digest.records as unknown as Record<string, unknown>[]);
    expectSummariesMatch(held, byId);
    // The failing run's error is what a change purpose puts first, and its entry says so without
    // being opened.
    expect(held[0]).toEqual({ run: broke.run, seq: answer.records[0]!.seq, event: "error", t: answer.records[0]!.t!, code: answer.records[0]!.record.code });
    const outcomes = sectionOutcomes(heldRuns(dir, env, answer.run));
    expect(outcomes[broke.run]).toBe("failed");
    expect(new Set(Object.entries(outcomes).filter(([r]) => r !== broke.run).map(([, o]) => o))).toEqual(new Set(["succeeded"]));
    expect(lensRecord(dir, env, answer.run).validation.state).toBe("validated");
  }, 60_000);

  test("a lens entry's summary cannot drift from the record it names", async () => {
    for (const view of VIEWS) {
      const { dir, env } = scratch();
      const receipts = repoReceipts(dir);
      richReceipt(receipts, runId(1), T0 - 3 * DAY, "failed");
      richReceipt(receipts, runId(2), T0 - 2 * DAY, "warned");
      richReceipt(receipts, runId(3), T0 - DAY);
      const answer = answered(await queryReceipts({ asker: { tool: "t" }, view, window: SEALED, budget: { records: 8 } }, { cwd: dir, env }));
      expect(answer.digest.records.length).toBe(8);
      const held = heldEntries(dir, env, answer.run);
      expect(held).toEqual(answer.digest.records as unknown as Record<string, unknown>[]);
      expectSummariesMatch(held, loadedById(dir, env));
      expect(held.every((e) => typeof e.event === "string" && typeof e.t === "number" && !("outcome" in e))).toBe(true);
    }
  });

  test("an undated record is named with no t rather than a made-up one", () => {
    const run = runId(7);
    const dated = loaded(run, 1, "receipt.head", T0);
    const absent: LoadedRecord = { ...loaded(run, 2, "receipt.step", T0 + 1), t: null };
    const fractional: LoadedRecord = { ...loaded(run, 3, "receipt.step", T0 + 2), t: 1.5 };
    const unnamed: LoadedRecord = { ...loaded(run, 4, "receipt.step", T0 + 3), event: null };
    const plan = planQuery({ asker: { tool: "t" }, view: "everything", window: WIDE });
    if (plan.refused) throw new Error("the plan was refused");
    const ranking = rankRecords(plan.query, [dated, absent, fractional, unnamed]);
    const envelope = { run: runId(8), seq: 30, t: T0 + 10 };
    const digested = digestFor(plan.query, { run: runId(8), seq: 1 }, ranking.records, envelope, ranking.outcomes);
    const entry = (seq: number) => digested.digest.records.find((e) => e.seq === seq) as unknown as Record<string, unknown>;
    expect(entry(1)).toEqual({ run, seq: 1, event: "receipt.head", t: T0 });
    expect("t" in entry(2)).toBe(false);
    expect(entry(2).event).toBe("receipt.step");
    expect("t" in entry(3)).toBe(false);
    expect("event" in entry(4)).toBe(false);
    expect(entry(4).t).toBe(T0 + 3);
    // The line built from those entries is a lens its own schema accepts.
    const line = JSON.parse(digestLine(digested.digest, envelope)) as Record<string, unknown>;
    expect(validator().validate(line).state).toBe("validated");
    // A ranking whose outcomes are not given carries no outcome: nothing is invented to fill it.
    const bare = digestFor(plan.query, { run: runId(8), seq: 1 }, ranking.records, envelope);
    expect(bare.digest.runs.some((r) => "outcome" in r || "reason" in r)).toBe(false);
  });

  test("a tool-owned event token is carried verbatim", async () => {
    const { dir, env } = scratch();
    richReceipt(repoReceipts(dir), runId(1), T0 - DAY);
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "what-changed", window: SEALED }, { cwd: dir, env }));
    const result = heldEntries(dir, env, answer.run).find((e) => e.seq === 4)!;
    expect(result).toEqual({ run: runId(1), seq: 4, event: "result", t: T0 - DAY + 3 });
    expect(loadedById(dir, env).get(`${runId(1)}:4`)!.validation.state).toBe("unvalidated");
  });

  test("a lens entry's outcome is the window's, not the digest's prefix's", async () => {
    const { dir, env } = scratch();
    const receipts = repoReceipts(dir);
    seedDays(dir, 3);
    // A run whose head and step are in the window and whose end is after it.
    const open = runId(90);
    const path = join(receipts, `${open}.jsonl`);
    writeReceipt(receipts, open, [
      { ...head(open), t: T0 - 10 * DAY },
      { ...step(open, 2), t: T0 - 10 * DAY + 1 },
      { ...end(open, 3, path), t: T0 + 2 * DAY },
    ]);
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "everything", window: SEALED, budget: { records: 4 } }, { cwd: dir, env }));
    const held = heldEntries(dir, env, answer.run);
    expect(held.map((e) => [e.run, e.seq])).toEqual([[open, 1], [open, 2], [runId(0), 1], [runId(0), 2]]);
    expect(heldRuns(dir, env, answer.run).map((r) => [r.run, r.outcome])).toEqual([
      [open, "undetermined"],
      [runId(0), "succeeded"],
    ]);
    // The digest holds none of the first seeded run's `end`, and its entries still say succeeded.
    expect(held.some((e) => e.run === runId(0) && e.event === "end")).toBe(false);
  });
});

// flyingrobots/parley#71: `budget.ms` is a deadline for the whole read, checked between phases,
// and a read that cannot meet its budget declines with a structured error naming the budget that
// would. The clock is the read's own and injected, so no case here sleeps or races the wall: the
// read calls it once at the start and once at each check — after the load, after the ranking,
// before the digest is written — and a scripted clock answers those calls in order.

/** A clock that answers its calls with `values` in order and keeps answering the last. */
function scripted(...values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)]!;
}

/** Narrow an outcome to a decline, naming what came back instead when it is not one. */
function declined(outcome: QueryOutcome): QueryDeclined {
  if (outcome.refused) throw new Error(`refused: ${outcome.refusals.map((r) => r.code).join(", ")}`);
  if (!outcome.declined) throw new Error("the read answered; it should have declined");
  return outcome;
}

/** The decisions a read's `receipt.step` records state, read back from its receipt: steps go to the receipt only (§6.1). */
function stepsOf(dir: string, env: Record<string, string>, run: string): string[] {
  const own = loadReceipts({ cwd: dir, env }).bundles.find((b) => b.run === run);
  if (!own) throw new Error(`the read's own bundle ${run} is not in the load`);
  return own.records.filter((r) => r.event === "receipt.step").map((r) => (r.record as Record<string, unknown>).decision as string);
}

describe("RD-70 budget.ms is a deadline for the whole read, checked between phases", () => {
  test("an ms deadline met exactly answers", async () => {
    const { dir, env } = scratch();
    seedDays(dir, 3);
    const answer = answered(await queryReceipts(
      { asker: { tool: "t" }, view: "everything", window: SEALED, budget: { records: 20, ms: 50 } },
      { cwd: dir, env, clock: scripted(1000, 1020, 1040, 1050) },
    ));
    expect(answer.declined).toBe(false);
    expect(answer.status).toBe(0);
    expect(answer.digest.budget).toEqual({ records: 20, ms: 50 });
    expect(answer.lines.some((l) => l.event === "lens")).toBe(true);
  });

  test("a load that alone passes the deadline declines before ranking", async () => {
    const { dir, env } = scratch();
    seedDays(dir, 3);
    const out = declined(await queryReceipts(
      { asker: { tool: "t" }, view: "everything", window: SEALED, budget: { records: 20, ms: 50 } },
      { cwd: dir, env, clock: scripted(0, 80) },
    ));
    expect(out.decline.bound).toBe("ms");
    expect(out.decline.phase).toBe("load");
    expect(out.decline.measured).toEqual({ ms: 80 });
    // The ranking and the digest were never run, so 80 ms is what the read needed at least, not
    // what would have sufficed.
    expect(out.decline.atLeast).toEqual({ ms: 80 });
    expect(out.decline.sufficient).toEqual({});
    const steps = stepsOf(dir, env, out.run);
    expect(steps.some((d) => d.startsWith("recorded the read"))).toBe(true);
    expect(steps.some((d) => d.startsWith("ranked"))).toBe(false);
    expect(steps.some((d) => d.startsWith("declined the read"))).toBe(true);
    expect(out.lines.some((l) => l.event === "lens")).toBe(false);
  });

  test("a deadline passed during the ranking declines before the digest", async () => {
    const { dir, env } = scratch();
    seedDays(dir, 3);
    const out = declined(await queryReceipts(
      { asker: { tool: "t" }, view: "everything", window: SEALED, budget: { records: 20, ms: 50 } },
      { cwd: dir, env, clock: scripted(0, 50, 51) },
    ));
    expect(out.decline.phase).toBe("rank");
    expect(out.decline.measured).toEqual({ ms: 51 });
    expect(out.decline.atLeast).toEqual({ ms: 51 });
    expect(stepsOf(dir, env, out.run).some((d) => d.startsWith("ranked"))).toBe(true);
    expect(out.lines.some((l) => l.event === "lens")).toBe(false);
  });

  test("a deadline passed before the digest names the ms that suffices", async () => {
    const { dir, env } = scratch();
    seedDays(dir, 3);
    const out = declined(await queryReceipts(
      { asker: { tool: "t" }, view: "everything", window: SEALED, budget: { records: 20, ms: 50 } },
      { cwd: dir, env, clock: scripted(0, 10, 20, 64) },
    ));
    expect(out.decline.phase).toBe("digest");
    expect(out.decline.sufficient).toEqual({ ms: 64 });
    expect(out.decline.atLeast).toEqual({});
    // The same read, under the deadline the decline named and the same scripted phases, answers.
    const again = answered(await queryReceipts(
      { asker: { tool: "t" }, view: "everything", window: SEALED, budget: { records: 20, ms: out.decline.sufficient.ms! } },
      { cwd: dir, env, clock: scripted(0, 10, 20, 64) },
    ));
    expect(again.status).toBe(0);
  });
});

describe("RD-71 a read that declines is a recorded run that ends with a structured error", () => {
  test("a declined read is a recorded run that ends with a structured error", async () => {
    const { dir, env } = scratch();
    seedDays(dir, 3);
    const out = declined(await queryReceipts(
      { asker: { tool: "t" }, view: "what-ran", window: SEALED, budget: { records: 5, ms: 50 } },
      { cwd: dir, env, clock: scripted(0, 75) },
    ));
    expect(out.status).toBe(2);
    const errors = out.lines.filter((l) => l.event === "error");
    // The error is on stderr; the answer's lines are stdout. Read it back from the receipt.
    expect(errors).toEqual([]);
    const own = loadReceipts({ cwd: dir, env }).bundles.find((b) => b.run === out.run)!;
    expect(own.terminated).toBe(true);
    expect(own.status).toBe(2);
    expect(own.defects).toEqual([]);
    const query = own.records.filter((r) => r.event === "query");
    expect(query.length).toBe(1);
    expect(query[0]!.validation.state).toBe("validated");
    expect(own.records.some((r) => r.event === "lens")).toBe(false);
    const error = own.records.filter((r) => r.event === "error");
    expect(error.length).toBe(1);
    expect(error[0]!.validation.state).toBe("validated");
    const e = error[0]!.record as Record<string, unknown>;
    expect(e.code).toBe("query.over_budget");
    expect(e.measured).toBe(75);
    expect(e.limit).toBe(50);
    expect(typeof e.remedy).toBe("string");
    expect(e.retryable).toBe(true);
    expect(e.detail).toEqual({
      bound: "ms",
      phase: "load",
      given: { records: 5, ms: 50 },
      measured: { ms: 75 },
      sufficient: {},
      at_least: { ms: 75 },
    });
    expect(out.decline.code).toBe("query.over_budget");
    expect(out.decline.given).toEqual({ records: 5, ms: 50 });
    expect(out.decline.problem).toBe(e.problem as string);
    expect(out.decline.remedy).toBe(e.remedy as string);
  });

  test("a decline is not a refusal: the next read sees it", async () => {
    const { dir, env } = scratch();
    seedDays(dir, 2);
    const out = declined(await queryReceipts(
      { asker: { tool: "t" }, view: "everything", window: SEALED, budget: { records: 5, ms: 1 } },
      { cwd: dir, env, clock: scripted(0, 2) },
    ));
    expect(out.refused).toBe(false);
    expect(out.declined).toBe(true);
    expect(out.run.length).toBeGreaterThan(0);
    expect(existsSync(out.receipt)).toBe(true);
    expect("digest" in out).toBe(false);
    expect(out.query.run).toBe(out.run);
    const next = answered(await queryReceipts({ asker: { tool: "t" }, view: "everything", window: WIDE, budget: { records: 1000 } }, { cwd: dir, env }));
    const seen = next.records.filter((r) => r.run === out.run && r.event === "query");
    expect(seen.length).toBe(1);
  });
});

describe("RD-72 a bytes budget that cannot hold an empty digest declines and names the size that would", () => {
  test("a bytes budget that cannot hold an empty digest declines and names the size that would", async () => {
    const { dir, env } = scratch();
    seedDays(dir, 10);
    const ask = (bytes: number) => queryReceipts(
      { asker: { tool: "t", cwd: "/work/site" }, view: "everything", window: SEALED, budget: { records: 7, bytes } },
      { cwd: dir, env },
    );
    const out = declined(await ask(1));
    expect(out.decline.bound).toBe("bytes");
    expect(out.decline.phase).toBe("digest");
    const smallest = out.decline.sufficient.bytes!;
    expect(smallest).toBeGreaterThan(1);
    expect(out.decline.measured.bytes).toBe(smallest);
    expect(out.decline.atLeast).toEqual({});
    expect(out.status).toBe(2);
    expect(out.lines.some((l) => l.event === "lens")).toBe(false);
    // The size named is exact: under it, the read answers with a digest naming no records…
    const fits = answered(await ask(smallest));
    expect(fits.digest.records).toEqual([]);
    expect(fits.digest.loss).toEqual({ bound: "count-only", excluded: 30, folded: 0 });
    expect(fits.digestBytes).toBeLessThanOrEqual(smallest);
    // …and one byte under it, the read declines again.
    expect(declined(await ask(smallest - 1)).decline.bound).toBe("bytes");
  });

  test("the smallest sufficient bytes is exact against the lens line as digestFor writes it", () => {
    const plan = planQuery({ asker: { tool: "t", cwd: "/work/site" }, view: "everything", window: SEALED, budget: { records: 7, bytes: 1 } });
    if (plan.refused) throw new Error("the plan was refused");
    const { dir } = scratch();
    const total = seedDays(dir, 4);
    const ranked = loadReceipts({ cwd: dir, env: {} }).bundles.flatMap((b) => b.records);
    expect(ranked.length).toBe(total);
    const answers = { run: RUN_A, seq: 1 };
    const envelope = { run: RUN_B, seq: 40, t: T0 };
    const n = sufficientBytes(plan.query, answers, ranked.length, envelope);
    const under = (bytes: number) => digestFor({ ...plan.query, budget: { ...plan.query.budget, bytes } }, answers, ranked, envelope, {});
    const fits = under(n);
    // The smallest digest names no records and so no runs: `runs` is present and empty, as the
    // lens line carries it since flyingrobots/parley#83, and it is measured with it.
    expect(fits.fits).toBe(true);
    expect(fits.digest.records).toEqual([]);
    expect(fits.digest.runs).toEqual([]);
    expect(digestLine(fits.digest, envelope)).toContain('"runs":[]');
    // At the least fixed point the line is exactly the bound, and one byte less cannot hold it.
    expect(fits.bytes).toBe(n);
    expect(under(n - 1).fits).toBe(false);
    expect(under(n - 1).digest.records).toEqual([]);
  });

  test("a read over both bounds at the last check names both", async () => {
    const { dir, env } = scratch();
    seedDays(dir, 3);
    const out = declined(await queryReceipts(
      { asker: { tool: "t" }, view: "everything", window: SEALED, budget: { records: 5, bytes: 1, ms: 50 } },
      { cwd: dir, env, clock: scripted(0, 10, 20, 70) },
    ));
    expect(out.decline.bound).toBe("ms");
    expect(out.decline.phase).toBe("digest");
    expect(out.decline.measured.ms).toBe(70);
    expect(out.decline.sufficient.ms).toBe(70);
    expect(out.decline.measured.bytes).toBe(out.decline.sufficient.bytes!);
    expect(out.decline.sufficient.bytes).toBeGreaterThan(1);
    expect(out.decline.problem).toContain("deadline");
    expect(out.decline.problem).toContain("budget.bytes");
  });
});

describe("RD-73 a read that states no ms has no deadline", () => {
  test("a read that states no ms has no deadline", async () => {
    const { dir, env } = scratch();
    seedDays(dir, 2);
    const hour = 3_600_000;
    const slow = () => scripted(0, hour, 2 * hour, 3 * hour);
    const defaulted = answered(await queryReceipts({ asker: { tool: "t" }, view: "everything", window: SEALED }, { cwd: dir, env, clock: slow() }));
    expect(defaulted.status).toBe(0);
    expect(defaulted.budgetDefaulted).toBe(true);
    const stated = answered(await queryReceipts({ asker: { tool: "t" }, view: "everything", window: SEALED, budget: { records: 3 } }, { cwd: dir, env, clock: slow() }));
    expect(stated.status).toBe(0);
  });

  test("an ms no realistic history reaches is met", async () => {
    const { dir, env } = scratch();
    seedDays(dir, 5);
    const answer = answered(await queryReceipts(
      { asker: { tool: "t" }, view: "everything", window: SEALED, budget: { records: 20, ms: 3_600_000 } },
      { cwd: dir, env },
    ));
    expect(answer.status).toBe(0);
    expect(answer.digest.records.length).toBe(15);
  });
});

// ---- RD-80 each run a lens names, stated once ------------------------------------------------
//
// flyingrobots/parley#83: a cold reader opened 26 heads to learn which invocation a run was, and
// could not tell from a digest why a run was `undetermined`. A lens now carries a `runs` section:
// one entry per run its records name, with the head's identity, the run's outcome over the whole
// window, and a reason when that outcome is `undetermined`. The oracle is the loader read again
// afterwards.

/** The keys a run section may carry, and no others. */
const SECTION_KEYS = new Set(["run", "tool", "v", "argv", "resolved", "inv", "outcome", "reason", "head", "folded", "dropped"]);

/**
 * Assert the lens's `runs` say what the loaded window says and nothing else: one section per run
 * the entries name, in first-named order; identity off the loaded head; outcome off the ranking.
 */
function expectSectionsMatch(
  lens: { records: readonly Record<string, unknown>[]; runs: readonly Record<string, unknown>[] },
  byId: Map<string, LoadedRecord>,
  outcomes: Readonly<Record<string, string>>,
) {
  const named = [...new Set(lens.records.map((e) => e.run as string))];
  expect(lens.runs.map((r) => r.run)).toEqual(named);
  for (const section of lens.runs) {
    expect(Object.keys(section).filter((k) => !SECTION_KEYS.has(k))).toEqual([]);
    const head = [...byId.values()].find((r) => r.run === section.run && r.event === "receipt.head");
    expect(head).toBeDefined();
    expect(section.tool).toBe(head!.record.tool as string);
    expect(section.v).toBe(head!.record.v as string);
    expect(section.argv).toEqual(head!.record.argv as string[]);
    if (typeof head!.record.inv === "string") expect(section.inv).toBe(head!.record.inv);
    else expect("inv" in section).toBe(false);
    expect(section.outcome).toBe(outcomes[section.run as string]!);
    expect("reason" in section).toBe(section.outcome === "undetermined");
    expect("head" in section).toBe(false);
  }
}

/** Bound a hand-built ranking with `digestFor`, as `queryReceipts` does. */
function digestOf(records: readonly LoadedRecord[], budget: { records: number; bytes?: number } = { records: 100 }, outcomes = true) {
  const plan = planQuery({ asker: { tool: "t", cwd: "/w" }, view: "everything", window: WIDE, budget });
  if (plan.refused) throw new Error("the plan was refused");
  const ranking = rankRecords(plan.query, records);
  const envelope = { run: runId(99), seq: 30, t: T0 + 10 };
  const digested = digestFor(plan.query, { run: runId(99), seq: 1 }, ranking.records, envelope, outcomes ? ranking.outcomes : undefined);
  return { digested, envelope, ranking };
}

describe("RD-80 a lens states each run it names once", () => {
  test("a lens states each real run's identity off its head", async () => {
    const { dir, state, env } = scratch();
    writeFileSync(join(dir, "a.txt"), "hello");
    const first = realRun(dir, state);
    symlinkSync(join(dir, "nothing-here"), join(dir, "dangling"));
    const broke = realRun(dir, state);
    rmSync(join(dir, "dangling"));
    const third = realRun(dir, state);
    expect([first.status, broke.status, third.status]).toEqual([0, 2, 0]);

    const answer = answered(await queryReceipts(
      { asker: { tool: "t", task: "flyingrobots/parley#83" }, view: "what-changed", window: { from: 0, to: Date.now() } },
      { cwd: dir, env },
    ));
    const lens = lensRecord(dir, env, answer.run);
    expect(lens.validation.state).toBe("validated");
    const held = lens.record as unknown as { records: Record<string, unknown>[]; runs: Record<string, unknown>[] };
    expect(held.runs).toEqual(answer.digest.runs as unknown as Record<string, unknown>[]);
    // The first and third runs are one invocation with one result, so they are folded into the
    // third (flyingrobots/parley#79, RD-90); the failing run is not the same result and stands alone.
    const byId = loadedById(dir, env);
    expect(held.runs.map((r) => r.run)).toEqual([broke.run, third.run]);
    expect(held.runs[1]!.folded).toEqual({ others: 1, records: [...byId.values()].filter((r) => r.run === first.run).length, stands_for: [first.run] });
    expectSectionsMatch(held, byId, answer.ranking.outcomes);
    expect(sectionOutcomes(held.runs)[broke.run]).toBe("failed");
    // The failing run's error entry names its code, so three failures of one case read as one.
    const error = byId.get(`${held.records[0]!.run}:${held.records[0]!.seq}`)!;
    expect(error.event).toBe("error");
    expect(held.records[0]!.code).toBe(error.record.code as string);
    expect(held.records.some((e) => "outcome" in e)).toBe(false);
  }, 60_000);

  test("a run section cannot drift from the head it summarises", async () => {
    for (const view of VIEWS) {
      const { dir, env } = scratch();
      const receipts = repoReceipts(dir);
      writeReceipt(receipts, runId(1), [
        { ...head(runId(1), { inv: "inv_one", argv: ["t", "count", "--deep"] }), t: T0 - 3 * DAY },
        { ...step(runId(1), 2), t: T0 - 3 * DAY + 1 },
        { event: "error", t: T0 - 3 * DAY + 2, seq: 3, run: runId(1), code: "count.unreadable", problem: "it failed", _schema: { id: "parley.error", version: "2.0.0" } },
        { ...end(runId(1), 4, join(receipts, `${runId(1)}.jsonl`), { status: 2 }), t: T0 - 3 * DAY + 3 },
      ]);
      richReceipt(receipts, runId(2), T0 - 2 * DAY, "warned");
      // A run with no end at all: undetermined, and the section says why.
      writeReceipt(receipts, runId(3), [{ ...head(runId(3)), t: T0 - DAY }, { ...step(runId(3), 2), t: T0 - DAY + 1 }]);
      const answer = answered(await queryReceipts({ asker: { tool: "t" }, view, window: SEALED, budget: { records: 12 } }, { cwd: dir, env }));
      const lens = lensRecord(dir, env, answer.run);
      expect(lens.validation.state).toBe("validated");
      const held = lens.record as unknown as { records: Record<string, unknown>[]; runs: Record<string, unknown>[] };
      expectSectionsMatch(held, loadedById(dir, env), answer.ranking.outcomes);
      expectSummariesMatch(held.records, loadedById(dir, env));
      expect(held.runs.find((r) => r.run === runId(3))!.reason).toBe("no_end_in_window");
      expect(held.runs.find((r) => r.run === runId(1))!.inv).toBe("inv_one");
    }
  });

  test("a run whose head is outside the window still has a section", () => {
    const run = runId(5);
    // The head is not in the ranking at all: the window began after it.
    const inputs = loaded(run, 3, "receipt.inputs", T0 + 1, { inputs: [], inv: "inv_late" });
    const finish = loaded(run, 4, "end", T0 + 2, { status: 0 });
    const { digested, envelope } = digestOf([inputs, finish]);
    expect(digested.digest.runs).toEqual([{ run, inv: "inv_late", outcome: "succeeded", head: "not_in_window" }]);
    expect(validator().validate(JSON.parse(digestLine(digested.digest, envelope))).state).toBe("validated");
  });

  test("an undetermined outcome says why, and only an undetermined one", () => {
    const open = runId(1);
    const unusable = runId(2);
    const failed = runId(3);
    const fine = runId(4);
    const records = [
      loaded(open, 1, "receipt.head", T0, { tool: "t", v: "1", argv: ["t"] }),
      loaded(unusable, 1, "receipt.head", T0 + 1, { tool: "t", v: "1", argv: ["t"] }),
      loaded(unusable, 2, "end", T0 + 2, { status: "zero" }),
      loaded(failed, 1, "receipt.head", T0 + 3, { tool: "t", v: "1", argv: ["t"] }),
      loaded(failed, 2, "end", T0 + 4, { status: 2 }),
      loaded(fine, 1, "receipt.head", T0 + 5, { tool: "t", v: "1", argv: ["t"] }),
      loaded(fine, 2, "end", T0 + 6, { status: 0 }),
    ];
    const { digested, envelope } = digestOf(records);
    const by = Object.fromEntries(digested.digest.runs.map((r) => [r.run, r]));
    expect([by[open]!.outcome, by[open]!.reason]).toEqual(["undetermined", "no_end_in_window"]);
    expect([by[unusable]!.outcome, by[unusable]!.reason]).toEqual(["undetermined", "end_status_unusable"]);
    expect(by[failed]!.outcome).toBe("failed");
    expect("reason" in by[failed]!).toBe(false);
    expect(by[fine]!.outcome).toBe("succeeded");
    expect("reason" in by[fine]!).toBe(false);
    // The schema holds the pairing: a reason beside succeeded, or an undetermined without one, is refused.
    const line = JSON.parse(digestLine(digested.digest, envelope)) as { runs: Record<string, unknown>[] };
    expect(validator().validate(line as unknown as Record<string, unknown>).state).toBe("validated");
    const lens = validator();
    const withRuns = (runs: Record<string, unknown>[]) => lens.validate({ ...line, runs } as unknown as Record<string, unknown>).state;
    expect(withRuns([{ run: fine, outcome: "succeeded", reason: "no_end_in_window" }])).toBe("invalid");
    expect(withRuns([{ run: open, outcome: "undetermined" }])).toBe("invalid");
    expect(withRuns([{ run: open, outcome: "undetermined", reason: "it hung" }])).toBe("invalid");
  });

  test("a large argv is dropped whole and the section says so", () => {
    const big = runId(1);
    const bigger = runId(2);
    const argv = ["t", ...Array.from({ length: 1000 }, (_, i) => `--flag-${i}`)];
    const records = [
      loaded(big, 1, "receipt.head", T0, { tool: "t", v: "1.2.3", argv, inv: "inv_small" }),
      loaded(big, 2, "end", T0 + 1, { status: 0 }),
      loaded(bigger, 1, "receipt.head", T0 + 2, { tool: "t", v: "1.2.3", argv, inv: "x".repeat(2000) }),
    ];
    expect(JSON.stringify(argv).length).toBeGreaterThan(10_000);
    for (const budget of [{ records: 100 }, { records: 100, bytes: 1024 }]) {
      const { digested, envelope } = digestOf(records, budget);
      const by = Object.fromEntries(digested.digest.runs.map((r) => [r.run, r]));
      expect(by[big]).toEqual({ run: big, tool: "t", v: "1.2.3", inv: "inv_small", outcome: "succeeded", dropped: ["argv"] });
      expect(by[bigger]).toEqual({ run: bigger, tool: "t", v: "1.2.3", outcome: "undetermined", reason: "no_end_in_window", dropped: ["argv", "inv"] });
      for (const section of digested.digest.runs) expect(Buffer.byteLength(JSON.stringify(section), "utf8")).toBeLessThanOrEqual(RUN_SECTION_BYTES);
      if (budget.bytes !== undefined) expect(digested.bytes).toBeLessThanOrEqual(budget.bytes);
      expect(validator().validate(JSON.parse(digestLine(digested.digest, envelope))).state).toBe("validated");
    }
  });

  test("only an error or a warning entry carries its code, and only a well-formed one", () => {
    const run = runId(1);
    const records = [
      loaded(run, 1, "error", T0, { code: "git.diff_failed", problem: "p" }),
      loaded(run, 2, "warning", T0 + 1, { code: "graft.review_failed", problem: "p" }),
      loaded(run, 3, "error", T0 + 2, { code: "Not A Code", problem: "p" }),
      loaded(run, 4, "result", T0 + 3, { code: "t.count" }),
    ];
    const { digested } = digestOf(records);
    const entry = (seq: number) => digested.digest.records.find((e) => e.seq === seq) as unknown as Record<string, unknown>;
    expect(entry(1).code).toBe("git.diff_failed");
    expect(entry(2).code).toBe("graft.review_failed");
    expect("code" in entry(3)).toBe(false);
    expect("code" in entry(4)).toBe(false);
  });

  test("the byte search is exact with run sections in the line", () => {
    const records: LoadedRecord[] = [];
    for (let r = 0; r < 6; r++) {
      const run = runId(r);
      records.push(loaded(run, 1, "receipt.head", T0 + r * 10, { tool: "t", v: "1", argv: ["t", "x".repeat(r * 7)], inv: `inv_${r}` }));
      records.push(loaded(run, 2, "warning", T0 + r * 10 + 1, { code: "w.x", problem: "p" }));
      if (r % 2 === 0) records.push(loaded(run, 3, "end", T0 + r * 10 + 2, { status: r === 2 ? 1 : 0 }));
    }
    const whole = digestOf(records).digested;
    expect(whole.excluded).toBe(0);
    for (let bytes = 1; bytes <= whole.bytes; bytes++) {
      const { digested, envelope, ranking } = digestOf(records, { records: 100, bytes });
      const kept = digested.digest.records.length;
      if (kept > 0) expect(digested.bytes).toBeLessThanOrEqual(bytes);
      if (kept < records.length) {
        // One more entry would not have fitted.
        const plan = planQuery({ asker: { tool: "t", cwd: "/w" }, view: "everything", window: WIDE, budget: { records: kept + 1 } });
        if (plan.refused) throw new Error("the plan was refused");
        const more = digestFor(plan.query, { run: runId(99), seq: 1 }, ranking.records, envelope, ranking.outcomes);
        expect(digestBytes({ ...more.digest, budget: digested.digest.budget }, envelope)).toBeGreaterThan(bytes);
      }
    }
  });

  test("ten thousand run sections are built in one bounded pass", () => {
    const records: LoadedRecord[] = [];
    for (let i = 0; i < 10_000; i++) {
      const run = runId(i);
      records.push(loaded(run, 1, "receipt.head", T0 + i * 10, { tool: "t", v: "1", argv: ["t"] }));
      records.push(loaded(run, 2, "receipt.step", T0 + i * 10 + 1));
      records.push(loaded(run, 3, "end", T0 + i * 10 + 2, { status: 0 }));
    }
    const plan = planQuery({ asker: { tool: "t" }, view: "everything", window: WIDE, budget: { records: 30_000 } });
    if (plan.refused) throw new Error("the plan was refused");
    const ranking = rankRecords(plan.query, records);
    const started = Date.now();
    const digested = digestFor(plan.query, { run: runId(99_999), seq: 1 }, ranking.records, { run: runId(99_999), seq: 30, t: T0 }, ranking.outcomes);
    const elapsed = Date.now() - started;
    expect(digested.digest.runs.length).toBe(10_000);
    // A section per run is found by an index over the window, not a scan of it per run. A scan
    // per run took 1.1 to 1.6 s here, the index about 30 ms; the bound fails on that complexity,
    // not on a noisy machine.
    expect(elapsed).toBeLessThan(500);
  }, 60_000);
});

// ---- RD-90 runs of one invocation, folded ----------------------------------------------------
//
// flyingrobots/parley#79: footprint's test suite runs the CLI about fifteen times in a burst with
// the same few argv, and those bursts filled every digest of 20 with the same runs. A digest now
// folds runs that are the same invocation with the same result (§2.2's `inv`, and every summary
// the lens would state about the run) into their most recent run, whose section says how many it
// stands for. Equal `inv` with a different result is a divergence (§2.3) and is never folded.

/** Four records of one run, stamped from `at`: a head (carrying `inv` when given), a step, a result, an end. */
function invRun(run: string, at: number, inv: string | undefined, over: { status?: unknown; error?: string; redacted?: boolean } = {}): LoadedRecord[] {
  const third = over.error === undefined
    ? loaded(run, 3, "result", at + 2, { value: 1 })
    : loaded(run, 3, "error", at + 2, { code: over.error, problem: "p" });
  return [
    loaded(run, 1, "receipt.head", at, { tool: "t", v: "1", argv: ["t", "x"], ...(inv === undefined ? {} : { inv }), ...(over.redacted ? { redacted: { argv: [1] } } : {}) }),
    loaded(run, 2, "receipt.step", at + 1),
    third,
    loaded(run, 4, "end", at + 3, { status: over.status ?? 0, ...(over.redacted ? { redacted: true } : {}) }),
  ];
}

/** The same run written as a receipt, so a real read loads it. */
function invReceipt(dir: string, run: string, at: number, inv: string) {
  const path = join(dir, `${run}.jsonl`);
  return writeReceipt(dir, run, [
    { ...head(run, { inv }), t: at },
    { ...step(run, 2), t: at + 1 },
    { ...toolResult(run, 3), t: at + 2 },
    { ...end(run, 4, path), t: at + 3 },
  ]);
}

const foldOf = (runs: readonly Record<string, unknown>[], run: string) => runs.find((r) => r.run === run)?.folded;
/** The run sections as the lens line carries them, read back from the line a reader would see. */
const digestLineSections = (d: { digest: Parameters<typeof digestLine>[0] }) =>
  (JSON.parse(digestLine(d.digest, { run: runId(99), seq: 30, t: T0 + 10 })) as { runs: { run: string; folded?: { others: number; records: number } }[] }).runs;

describe("RD-90 runs of one invocation with one result are folded", () => {
  test("five identical runs are named once and the section says five", async () => {
    const { dir, env } = scratch();
    const receipts = repoReceipts(dir);
    for (let i = 1; i <= 5; i++) invReceipt(receipts, runId(i), T0 - (6 - i) * DAY, "inv_same");
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "everything", window: SEALED, budget: { records: 100 } }, { cwd: dir, env }));
    const lens = lensRecord(dir, env, answer.run);
    expect(lens.validation.state).toBe("validated");
    const held = lens.record as unknown as { records: Record<string, unknown>[]; runs: Record<string, unknown>[]; loss: Record<string, unknown> };
    // The most recent run stands for the five.
    expect(held.records.map((e) => `${e.run}:${e.seq}`)).toEqual([1, 2, 3, 4].map((s) => `${runId(5)}:${s}`));
    expect(held.runs.length).toBe(1);
    expect(held.runs[0]!.run).toBe(runId(5));
    expect(held.runs[0]!.folded).toEqual({ others: 4, records: 16, stands_for: [4, 3, 2, 1].map(runId) });
    expect(held.loss).toEqual({ bound: "count-only", excluded: 16, folded: 16 });
    // Nothing folded away is in the answer either: not its records, not its ranking prefix.
    expect(answer.records.every((r) => r.run === runId(5))).toBe(true);
    expect(answer.ranking.ranked.map((r) => idOf(r.record))).toEqual(ids(answer.records));
    expect(answer.counts.folded).toBe(16);
    expect(answer.counts.excluded).toBe(16);
  });

  test("equal inv with a different outcome is never folded", () => {
    const records = [
      // The flaky pair: one invocation, one failure and one pass.
      ...invRun(runId(1), T0, "inv_flaky", { status: 2, error: "t.flaked" }),
      ...invRun(runId(2), T0 + 10, "inv_flaky"),
      // Both failed, with different statuses.
      ...invRun(runId(3), T0 + 20, "inv_status", { status: 1 }),
      ...invRun(runId(4), T0 + 30, "inv_status", { status: 2 }),
      // Both failed with status 2, with different errors.
      ...invRun(runId(5), T0 + 40, "inv_code", { status: 2, error: "t.one" }),
      ...invRun(runId(6), T0 + 50, "inv_code", { status: 2, error: "t.two" }),
    ];
    const { digested } = digestOf(records);
    expect(digested.digest.runs.map((r) => r.run)).toEqual([1, 2, 3, 4, 5, 6].map(runId));
    expect(digested.digest.runs.some((r) => "folded" in r)).toBe(false);
    expect(digested.digest.loss).toEqual({ bound: "none", excluded: 0, folded: 0 });
  });

  test("a run with no inv is never folded", () => {
    const records = [
      ...invRun(runId(1), T0, undefined),
      ...invRun(runId(2), T0 + 10, undefined),
      ...invRun(runId(3), T0 + 20, undefined),
      // One inv, both undetermined, for different reasons.
      loaded(runId(4), 1, "receipt.head", T0 + 30, { tool: "t", v: "1", argv: ["t"], inv: "inv_open" }),
      loaded(runId(5), 1, "receipt.head", T0 + 40, { tool: "t", v: "1", argv: ["t"], inv: "inv_open" }),
      loaded(runId(5), 2, "end", T0 + 41, { status: "zero" }),
    ];
    const { digested } = digestOf(records);
    expect(digested.digest.runs.map((r) => r.run)).toEqual([1, 2, 3, 4, 5].map(runId));
    expect(digested.digest.runs.some((r) => "folded" in r)).toBe(false);
    expect(digested.digest.loss.folded).toBe(0);
  });

  test("a redacted run is never folded", () => {
    const records = [
      ...invRun(runId(1), T0, "inv_secret", { redacted: true }),
      ...invRun(runId(2), T0 + 10, "inv_secret"),
    ];
    const { digested } = digestOf(records);
    expect(digested.digest.runs.map((r) => r.run)).toEqual([runId(1), runId(2)]);
    expect(digested.digest.runs.some((r) => "folded" in r)).toBe(false);

    // Two runs whose window holds neither head nor end, only `receipt.inputs` with one `inv`: the
    // window cannot show either is unredacted (§1.2a), so neither folds.
    const blind = [3, 4].map((n) => loaded(runId(n), 3, "receipt.inputs", T0 + n * 10, { inputs: [], inv: "inv_blind" }));
    const unknown = digestOf(blind).digested;
    expect(unknown.digest.runs.map((r) => r.run)).toEqual([runId(3), runId(4)]);
    expect(unknown.folded).toBe(0);
  });

  test("the loss separates what the fold left out from what the budget cut", () => {
    // Twelve runs in four groups of three, interleaved in time, so the representatives come last.
    const records = Array.from({ length: 12 }, (_, i) => invRun(runId(i), T0 + i * 10, `inv_g${i % 4}`)).flat();
    const wide = digestOf(records).digested;
    expect(wide.digest.runs.map((r) => [r.run, r.folded])).toEqual([8, 9, 10, 11].map((i) => [runId(i), { others: 2, records: 8, stands_for: [runId(i - 4), runId(i - 8)] }]));
    expect(wide.digest.loss).toEqual({ bound: "count-only", excluded: 32, folded: 32 });
    expect(wide.folded).toBe(32);

    const cut = digestOf(records, { records: 6 }).digested;
    expect(cut.digest.records.length).toBe(6);
    // The fold's count does not depend on the budget; the budget's loss is the rest.
    expect(cut.digest.loss).toEqual({ bound: "count-only", excluded: 42, folded: 32 });
    expect(cut.excluded - cut.folded).toBe(16 - 6);
    const stated = cut.digest.runs.reduce((n, r) => n + (r.folded?.records ?? 0), 0);
    expect(stated).toBeLessThanOrEqual(cut.digest.loss.folded);

    // The schema holds the pairing: a loss of none cannot say the fold left anything out.
    const line = JSON.parse(digestLine(wide.digest, { run: runId(99), seq: 30, t: T0 + 10 })) as Record<string, unknown>;
    expect(validator().validate(line).state).toBe("validated");
    expect(validator().validate({ ...line, loss: { bound: "none", excluded: 0, folded: 3 } }).state).toBe("invalid");
    expect(validator().validate({ ...line, runs: [{ run: runId(11), outcome: "succeeded", folded: { others: 0, records: 0 } }] }).state).toBe("invalid");
    // The old shape, which counted the representative, is no longer a fold.
    expect(validator().validate({ ...line, runs: [{ run: runId(11), outcome: "succeeded", folded: { runs: 3, records: 8 } }] }).state).toBe("invalid");
  });

  test("the byte search and the sufficient size are exact with a fold", () => {
    const records = Array.from({ length: 9 }, (_, i) => invRun(runId(i), T0 + i * 10, `inv_${i % 3}`)).flat();
    const whole = digestOf(records).digested;
    expect(whole.folded).toBe(24);
    for (let bytes = 1; bytes <= whole.bytes; bytes++) {
      const { digested, envelope, ranking } = digestOf(records, { records: 100, bytes });
      const kept = digested.digest.records.length;
      if (digested.fits) expect(digested.bytes).toBeLessThanOrEqual(bytes);
      if (kept < whole.digest.records.length && digested.fits) {
        const plan = planQuery({ asker: { tool: "t", cwd: "/w" }, view: "everything", window: WIDE, budget: { records: kept + 1 } });
        if (plan.refused) throw new Error("the plan was refused");
        const more = digestFor(plan.query, { run: runId(99), seq: 1 }, ranking.records, envelope, ranking.outcomes);
        expect(digestBytes({ ...more.digest, budget: digested.digest.budget }, envelope)).toBeGreaterThan(bytes);
      }
    }
    const { envelope, ranking } = digestOf(records);
    const plan = planQuery({ asker: { tool: "t", cwd: "/w" }, view: "everything", window: WIDE, budget: { records: 100 } });
    if (plan.refused) throw new Error("the plan was refused");
    const least = sufficientBytes(plan.query, { run: runId(99), seq: 1 }, ranking.records.length, envelope, whole.folded);
    const at = (bytes: number) => digestFor({ ...plan.query, budget: { records: 100, bytes } }, { run: runId(99), seq: 1 }, ranking.records, envelope, ranking.outcomes);
    expect(at(least).fits).toBe(true);
    expect(at(least).digest.records.length).toBe(0);
    expect(at(least).bytes).toBe(least);
    expect(at(least - 1).fits).toBe(false);
  });

  test("a thousand identical runs fold into one section in a bounded pass", () => {
    const records = Array.from({ length: 1000 }, (_, i) => invRun(runId(i), T0 + i * 10, "inv_suite")).flat();
    const plan = planQuery({ asker: { tool: "t" }, view: "everything", window: WIDE, budget: { records: 4000 } });
    if (plan.refused) throw new Error("the plan was refused");
    const ranking = rankRecords(plan.query, records);
    const started = Date.now();
    const digested = digestFor(plan.query, { run: runId(99_999), seq: 1 }, ranking.records, { run: runId(99_999), seq: 30, t: T0 }, ranking.outcomes);
    const elapsed = Date.now() - started;
    expect(digested.digest.runs).toEqual([{ run: runId(999), tool: "t", v: "1", argv: ["t", "x"], inv: "inv_suite", outcome: "succeeded", folded: { others: 999, records: 3996, stands_for: Array.from({ length: 999 }, (_, i) => runId(998 - i)) } }]);
    expect(digested.digest.records.length).toBe(4);
    expect(digested.digest.loss).toEqual({ bound: "count-only", excluded: 3996, folded: 3996 });
    expect(elapsed).toBeLessThan(500);
  }, 60_000);

  // flyingrobots/parley#100: a cold reader added the counts and could not tell whether each
  // included its own run. A section is "this run, plus `others` like it", so the count a reader
  // states from the lines alone is one per section plus its `others`.
  const statedRuns = (runs: readonly { folded?: { others: number } }[]) => runs.reduce((n, r) => n + 1 + (r.folded?.others ?? 0), 0);
  /** The cold resume's window in shape: seven groups of one invocation with one result, and ten runs alone. */
  function coldResumeShape(): { records: LoadedRecord[]; groups: number[] } {
    const groups = [4, 4, 6, 3, 3, 10, 10];
    const records: LoadedRecord[] = [];
    let n = 0;
    for (let i = 0; i < 10; i++, n++) records.push(...invRun(runId(n), T0 + n * 10, `inv_alone${i}`));
    groups.forEach((size, g) => { for (let i = 0; i < size; i++, n++) records.push(...invRun(runId(n), T0 + n * 10, `inv_group${g}`)); });
    expect(n).toBe(50);
    return { records, groups };
  }

  test("the run count a cold reader states from the sections is the window's", () => {
    const { records, groups } = coldResumeShape();
    const { digested } = digestOf(records, { records: 1000 });
    const sections = digestLineSections(digested);
    expect(sections.length).toBe(17);
    expect(statedRuns(sections)).toBe(50);
    expect(sections.filter((r) => r.folded !== undefined).map((r) => r.folded!.others).sort((a, b) => a - b)).toEqual(groups.map((g) => g - 1).sort((a, b) => a - b));
    for (const r of sections) if (r.folded) expect(r.folded.records).toBe(r.folded.others * 4);
    expect(sections.filter((r) => r.folded === undefined).length).toBe(10);
  });

  test("a cut representative takes its others' count with it, and the loss shows the gap", () => {
    const { records } = coldResumeShape();
    // The last group of ten is runs 40 to 49, the latest in the window, so its representative is
    // run 49. `everything` ranks in time order, so a budget that stops just before run 49's
    // records cuts that one section and nothing else.
    const whole = digestOf(records, { records: 1000 }).digested;
    const order = whole.digest.records.map((e) => e.run);
    const before = order.indexOf(runId(49));
    const cut = digestOf(records, { records: before }).digested;
    const sections = digestLineSections(cut);
    expect(sections.some((r) => r.run === runId(49))).toBe(false);
    const named = new Set(sections.map((r) => r.run));
    const lostGroups = digestLineSections(whole).filter((r) => !named.has(r.run));
    expect(lostGroups.some((r) => r.run === runId(49))).toBe(true);
    expect(lostGroups.length).toBe(1);
    expect(statedRuns(sections)).toBe(50 - 10);
    // The fold does not depend on the budget, so loss.folded still counts the cut groups' others.
    expect(cut.digest.loss.folded).toBe(whole.digest.loss.folded);
    const statedRecords = sections.reduce((n, r) => n + (r.folded?.records ?? 0), 0);
    expect(cut.digest.loss.folded - statedRecords).toBe(lostGroups.reduce((n, r) => n + (r.folded?.records ?? 0), 0));
    expect(cut.digest.loss.folded - statedRecords).toBeGreaterThan(0);
  });

  test("a window with no fold states one run per section", () => {
    const records = Array.from({ length: 5 }, (_, i) => invRun(runId(i), T0 + i * 10, `inv_distinct${i}`)).flat();
    const sections = digestLineSections(digestOf(records).digested);
    expect(sections.length).toBe(5);
    expect(sections.some((r) => "folded" in r)).toBe(false);
    expect(statedRuns(sections)).toBe(5);
  });

  test("three real runs of one invocation fold into one", async () => {
    const { dir, state, env } = scratch();
    writeFileSync(join(dir, "a.txt"), "hello");
    const runs = [realRun(dir, state), realRun(dir, state), realRun(dir, state)];
    expect(runs.map((r) => r.status)).toEqual([0, 0, 0]);
    const byId = loadedById(dir, env);
    const invs = runs.map((r) => byId.get(`${r.run}:1`)!.record.inv);
    expect(typeof invs[0]).toBe("string");
    expect(new Set(invs).size).toBe(1);

    const answer = answered(await queryReceipts(
      { asker: { tool: "t", task: "flyingrobots/parley#79" }, view: "what-ran", window: { from: 0, to: Date.now() } },
      { cwd: dir, env },
    ));
    const lens = lensRecord(dir, env, answer.run);
    expect(lens.validation.state).toBe("validated");
    const held = lens.record as unknown as { runs: Record<string, unknown>[] };
    expect(held.runs.length).toBe(1);
    expect(held.runs[0]!.run).toBe(runs[2]!.run);
    expect(foldOf(held.runs, runs[2]!.run)).toEqual({ others: 2, records: [...byId.values()].filter((r) => r.run === runs[0]!.run || r.run === runs[1]!.run).length, stands_for: [runs[1]!.run, runs[0]!.run] });
  }, 60_000);
});

// ---- RD-100 a run section carries the head's resolved ----------------------------------------
//
// flyingrobots/parley#90: after flyingrobots/parley#83 the cold reader still opened one head per
// burst, each for `resolved.base_commit` and `resolved.head_commit`: `argv` says `HEAD~1..HEAD`,
// and only `resolved` says which two commits that was. A section now carries `resolved` whole,
// read off the head and never chosen by key, so no tool's field names live in the reader. It is
// the first field dropped to fit the section's bound.

describe("RD-100 a run section carries the head's resolved", () => {
  test("a run section carries the resolved interpretation off its head", async () => {
    const { dir, state, env } = scratch();
    writeFileSync(join(dir, "a.txt"), "hello");
    const runs = [realRun(dir, state)];
    symlinkSync(join(dir, "nothing-here"), join(dir, "dangling"));
    runs.push(realRun(dir, state));
    expect(runs.map((r) => r.status)).toEqual([0, 2]);
    const answer = answered(await queryReceipts(
      { asker: { tool: "t", task: "flyingrobots/parley#90" }, view: "what-ran", window: { from: 0, to: Date.now() } },
      { cwd: dir, env },
    ));
    const lens = lensRecord(dir, env, answer.run);
    expect(lens.validation.state).toBe("validated");
    const held = lens.record as unknown as { runs: Record<string, unknown>[] };
    const byId = loadedById(dir, env);
    expect(held.runs.length).toBe(2);
    for (const section of held.runs) {
      const head = byId.get(`${section.run}:1`)!;
      expect(head.event).toBe("receipt.head");
      expect(section.resolved).toEqual(head.record.resolved as Record<string, unknown>);
    }
  }, 60_000);

  test("a run section's resolved cannot drift from the head", async () => {
    for (const view of VIEWS) {
      const { dir, env } = scratch();
      const receipts = repoReceipts(dir);
      writeReceipt(receipts, runId(1), [
        { ...head(runId(1), { inv: "inv_one", resolved: { command: "count", base_commit: "fb09508", depth: 2, deep: { list: [1, 2] } } }), t: T0 - 3 * DAY },
        { ...step(runId(1), 2), t: T0 - 3 * DAY + 1 },
        { ...end(runId(1), 3, join(receipts, `${runId(1)}.jsonl`)), t: T0 - 3 * DAY + 2 },
      ]);
      richReceipt(receipts, runId(2), T0 - 2 * DAY, "warned");
      writeReceipt(receipts, runId(3), [{ ...head(runId(3), { resolved: { command: "x".repeat(600) } }), t: T0 - DAY }]);
      const answer = answered(await queryReceipts({ asker: { tool: "t" }, view, window: SEALED, budget: { records: 12 } }, { cwd: dir, env }));
      const lens = lensRecord(dir, env, answer.run);
      expect(lens.validation.state).toBe("validated");
      const held = lens.record as unknown as { records: Record<string, unknown>[]; runs: Record<string, unknown>[] };
      const byId = loadedById(dir, env);
      expectSectionsMatch(held, byId, answer.ranking.outcomes);
      for (const section of held.runs) {
        const resolved = byId.get(`${section.run}:1`)!.record.resolved;
        if ("resolved" in section) expect(section.resolved).toEqual(resolved as Record<string, unknown>);
        else expect(section.dropped as string[]).toContain("resolved");
      }
      const by = Object.fromEntries(held.runs.map((r) => [r.run as string, r]));
      if (by[runId(1)]) expect(by[runId(1)]!.resolved).toEqual({ command: "count", base_commit: "fb09508", depth: 2, deep: { list: [1, 2] } });
      if (by[runId(3)]) expect(by[runId(3)]!.dropped).toEqual(["resolved"]);
    }
  });

  test("a resolved larger than the section is dropped whole, before argv", () => {
    const big = runId(1);
    const bigger = runId(2);
    const resolved = { command: "count", paths: Array.from({ length: 1000 }, (_, i) => `src/file-${i}.ts`) };
    const argv = ["t", ...Array.from({ length: 1000 }, (_, i) => `--flag-${i}`)];
    const records = [
      loaded(big, 1, "receipt.head", T0, { tool: "t", v: "1.2.3", argv: ["t", "count"], resolved, inv: "inv_small" }),
      loaded(big, 2, "end", T0 + 1, { status: 0 }),
      loaded(bigger, 1, "receipt.head", T0 + 2, { tool: "t", v: "1.2.3", argv, resolved, inv: "inv_other" }),
    ];
    expect(JSON.stringify(resolved).length).toBeGreaterThan(10_000);
    for (const budget of [{ records: 100 }, { records: 100, bytes: 1024 }]) {
      const { digested, envelope } = digestOf(records, budget);
      const by = Object.fromEntries(digested.digest.runs.map((r) => [r.run, r]));
      expect(by[big]).toEqual({ run: big, tool: "t", v: "1.2.3", argv: ["t", "count"], inv: "inv_small", outcome: "succeeded", dropped: ["resolved"] });
      expect(by[bigger]).toEqual({ run: bigger, tool: "t", v: "1.2.3", inv: "inv_other", outcome: "undetermined", reason: "no_end_in_window", dropped: ["resolved", "argv"] });
      for (const section of digested.digest.runs) expect(Buffer.byteLength(JSON.stringify(section), "utf8")).toBeLessThanOrEqual(RUN_SECTION_BYTES);
      if (budget.bytes !== undefined) expect(digested.bytes).toBeLessThanOrEqual(budget.bytes);
      expect(validator().validate(JSON.parse(digestLine(digested.digest, envelope))).state).toBe("validated");
    }
  });

  test("a redacted value in resolved stays redacted in the section", async () => {
    const { dir, env } = scratch();
    const secret = await writerRun(dir, env, ["count", "--token", "s3cret"], (run) => {
      run.result({ event: "result", value: 3 }, { id: "t.count", version: "1.0.0" });
    });
    const byId = loadedById(dir, env);
    const headResolved = byId.get(`${secret.run}:1`)!.record.resolved as Record<string, unknown>;
    expect(JSON.stringify(headResolved)).toContain("[redacted]");
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "what-ran", window: { from: 0, to: Date.now() } }, { cwd: dir, env }));
    const section = answer.digest.runs.find((r) => r.run === secret.run)!;
    expect(section.resolved).toEqual(headResolved);
    const line = readFileSync(answer.receipt, "utf8").split("\n").find((l) => l.includes('"event":"lens"'))!;
    expect(line).toContain("[redacted]");
    expect(line).not.toContain("s3cret");
  });

  test("only an object resolved is carried, and only off a head in the window", () => {
    const records = [
      loaded(runId(1), 1, "receipt.head", T0, { tool: "t", v: "1", argv: ["t"], resolved: "count" }),
      loaded(runId(2), 1, "receipt.head", T0 + 1, { tool: "t", v: "1", argv: ["t"], resolved: ["count"] }),
      loaded(runId(3), 1, "receipt.head", T0 + 2, { tool: "t", v: "1", argv: ["t"], resolved: null }),
      // The head is before the window: only receipt.inputs and the end are in it.
      loaded(runId(4), 3, "receipt.inputs", T0 + 3, { inputs: [], inv: "inv_late" }),
      loaded(runId(4), 4, "end", T0 + 4, { status: 0 }),
    ];
    const { digested } = digestOf(records);
    for (const section of digested.digest.runs) {
      expect("resolved" in section).toBe(false);
      expect("dropped" in section).toBe(false);
    }
    expect(digested.digest.runs.find((r) => r.run === runId(4))!.head).toBe("not_in_window");
  });

  test("the byte search is exact with resolved in the sections", () => {
    const records: LoadedRecord[] = [];
    for (let r = 0; r < 6; r++) {
      const run = runId(r);
      records.push(loaded(run, 1, "receipt.head", T0 + r * 10, { tool: "t", v: "1", argv: ["t"], resolved: { command: "t", base: "y".repeat(r * 40) }, inv: `inv_${r}` }));
      records.push(loaded(run, 2, "warning", T0 + r * 10 + 1, { code: "w.x", problem: "p" }));
      if (r % 2 === 0) records.push(loaded(run, 3, "end", T0 + r * 10 + 2, { status: r === 2 ? 1 : 0 }));
    }
    const whole = digestOf(records).digested;
    expect(whole.excluded).toBe(0);
    expect(whole.digest.runs.filter((s) => "resolved" in s).length).toBeGreaterThan(0);
    for (let bytes = 1; bytes <= whole.bytes; bytes++) {
      const { digested, envelope, ranking } = digestOf(records, { records: 100, bytes });
      const kept = digested.digest.records.length;
      if (digested.fits) expect(digested.bytes).toBeLessThanOrEqual(bytes);
      if (kept < records.length && digested.fits) {
        const plan = planQuery({ asker: { tool: "t", cwd: "/w" }, view: "everything", window: WIDE, budget: { records: kept + 1 } });
        if (plan.refused) throw new Error("the plan was refused");
        const more = digestFor(plan.query, { run: runId(99), seq: 1 }, ranking.records, envelope, ranking.outcomes);
        expect(digestBytes({ ...more.digest, budget: digested.digest.budget }, envelope)).toBeGreaterThan(bytes);
      }
    }
  });
});

describe("RD-100 a fold never hides a different resolved", () => {
  test("runs of one inv whose resolved differs are not folded", () => {
    // §2.2 keeps the working directory out of `inv`, so two runs in two checkouts can share one.
    // The section states its run's `resolved`, so folding them would state one run's for both.
    const at = (n: number, cwd: string) => [
      loaded(runId(n), 1, "receipt.head", T0 + n * 10, { tool: "t", v: "1", argv: ["t"], inv: "inv_same", resolved: { command: "t", cwd } }),
      loaded(runId(n), 2, "end", T0 + n * 10 + 1, { status: 0 }),
    ];
    const { digested } = digestOf([...at(1, "/a"), ...at(2, "/b"), ...at(3, "/b")]);
    expect(digested.digest.runs.map((r) => [r.run, r.folded])).toEqual([[runId(1), undefined], [runId(3), { others: 1, records: 2, stands_for: [runId(2)] }]]);
  });
});

// ---- RD-110 a fold never hides a record that differs -----------------------------------------
//
// flyingrobots/parley#133: the fold key held `inv`, the outcome, the statuses, the codes and
// `resolved`, and no result. Two runs of one invocation whose results differed, which is the
// divergence §2.3 names and a history exists to expose, were stated as one run twice, and the lens
// gave a count of what it folded and no way to it. Results now enter the key, and so do the
// decision records under a view that states them; a read can turn the fold off; and a folded
// section names the runs it stands for.

const TOOL_OWNED = { _schema: { id: "t.count", version: "1.0.0" } };

/** One run as loaded records: a head with `inv`, the given middle records from seq 2, and an end of 0. */
function runOf(n: number, inv: string, middle: readonly [event: string, over: Record<string, unknown>][], headOver: Record<string, unknown> = {}): LoadedRecord[] {
  const at = T0 + n * 100;
  return [
    loaded(runId(n), 1, "receipt.head", at, { tool: "t", v: "1", argv: ["t", "x"], inv, ...headOver }),
    ...middle.map(([event, over], i) => loaded(runId(n), i + 2, event, at + i + 1, over)),
    loaded(runId(n), middle.length + 2, "end", at + 50, { status: 0, redacted: false }),
  ];
}

const result = (value: unknown): [string, Record<string, unknown>] => ["result", { ...TOOL_OWNED, value }];

/** Whether two hand-built runs fold under a view: true when the digest names one section for them. */
function folds(a: LoadedRecord[], b: LoadedRecord[], view = "everything"): boolean {
  const plan = planQuery({ asker: { tool: "t", cwd: "/w" }, view, window: WIDE, budget: { records: 1000 } });
  if (plan.refused) throw new Error("the plan was refused");
  const ranking = rankRecords(plan.query, [...a, ...b]);
  const digested = digestFor(plan.query, { run: runId(99), seq: 1 }, ranking.records, { run: runId(99), seq: 30, t: T0 + 10 }, ranking.outcomes);
  return digested.digest.runs.length === 1;
}

/** A receipt of one run with `inv` and a result carrying `value`, stamped from `at`. */
function valueReceipt(dir: string, run: string, at: number, inv: string, value: number) {
  const path = join(dir, `${run}.jsonl`);
  return writeReceipt(dir, run, [
    { ...head(run, { inv }), t: at },
    { ...step(run, 2), t: at + 1 },
    { ...toolResult(run, 3, { value }), t: at + 2 },
    { ...end(run, 4, path), t: at + 3 },
  ]);
}

describe("RD-110 a fold never hides a record that differs", () => {
  test("two runs of one inv whose results differ are both returned", async () => {
    const { dir, env } = scratch();
    const receipts = repoReceipts(dir);
    valueReceipt(receipts, runId(1), T0 - 2 * DAY, "inv_same", 1);
    valueReceipt(receipts, runId(2), T0 - DAY, "inv_same", 2);
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "everything", window: SEALED, budget: { records: 1000 } }, { cwd: dir, env }));
    const results = answer.records.filter((r) => r.event === "result");
    expect(results.map((r) => [r.run, r.record.value])).toEqual([[runId(1), 1], [runId(2), 2]]);
    expect(answer.records.length).toBe(8);
    expect(answer.digest.runs.map((r) => r.run)).toEqual([runId(1), runId(2)]);
    expect(answer.digest.runs.some((r) => "folded" in r)).toBe(false);
    expect(answer.digest.loss).toEqual({ bound: "none", excluded: 0, folded: 0 });
    expect(lensRecord(dir, env, answer.run).validation.state).toBe("validated");
  });

  test("only runs whose result records are all equal fold", () => {
    // Equal but for key order: canonical JSON makes key order no difference.
    expect(folds(runOf(1, "i", [result({ a: 1, b: { c: 2, d: 3 } })]), runOf(2, "i", [result({ b: { d: 3, c: 2 }, a: 1 })]))).toBe(true);
    // A nested value differs.
    expect(folds(runOf(1, "i", [result({ a: 1, b: { c: 2 } })]), runOf(2, "i", [result({ a: 1, b: { c: 3 } })]))).toBe(false);
    // The review's pair.
    expect(folds(runOf(1, "i", [result(1)]), runOf(2, "i", [result(2)]))).toBe(false);
    // One result against two, and the same two in another order.
    expect(folds(runOf(1, "i", [result(1)]), runOf(2, "i", [result(1), result(1)]))).toBe(false);
    expect(folds(runOf(1, "i", [result(1), result(2)]), runOf(2, "i", [result(2), result(1)]))).toBe(false);
    // A result's own schema pair is part of it.
    expect(folds(runOf(1, "i", [result(1)]), runOf(2, "i", [["result", { _schema: { id: "t.count", version: "2.0.0" }, value: 1 }]]))).toBe(false);
    // A sidecar stands in for a result: its stored bytes are the result, its path is not.
    const side = (sha256: string, path: string): [string, Record<string, unknown>] => ["sidecar", { source: 2, path, bytes: 10, sha256 }];
    expect(folds(runOf(1, "i", [side(sha("x"), "a.json")]), runOf(2, "i", [side(sha("x"), "b.json")]))).toBe(true);
    expect(folds(runOf(1, "i", [side(sha("x"), "a.json")]), runOf(2, "i", [side(sha("y"), "a.json")]))).toBe(false);
    // A page carries output too.
    const page = (items: unknown): [string, Record<string, unknown>] => ["page", { has_more: false, items }];
    expect(folds(runOf(1, "i", [page([1])]), runOf(2, "i", [page([1])]))).toBe(true);
    expect(folds(runOf(1, "i", [page([1])]), runOf(2, "i", [page([2])]))).toBe(false);
    // A read's result is its lens. The query it names is that read's own identity, not its result.
    const lens = (n: number, seqs: number[]): [string, Record<string, unknown>] => ["lens", { query: { run: runId(n), seq: 2 }, loss: { bound: "none", excluded: 0, folded: 0 }, records: seqs.map((seq) => ({ run: runId(50), seq })) }];
    expect(folds(runOf(1, "i", [lens(1, [1, 2])]), runOf(2, "i", [lens(2, [1, 2])]))).toBe(true);
    expect(folds(runOf(1, "i", [lens(1, [1, 2])]), runOf(2, "i", [lens(2, [1, 2, 3])]))).toBe(false);
    // `foldRuns` itself, with no view stated, holds results to the same rule.
    const pair = [...runOf(1, "i", [result(1)]), ...runOf(2, "i", [result(2)])];
    expect(foldRuns(pair, { [runId(1)]: "succeeded", [runId(2)]: "succeeded" }).folded).toBe(0);
  });

  test("runs whose decisions differ do not fold under a view that states decisions", () => {
    const stepped = (n: number, decision: string) => runOf(n, "i", [["receipt.step", { decision, because: "b" }], result(1)]);
    const hit = (n: number, served: string) => runOf(n, "i", [["cache.hit", { inv: "i", served_run: served, receipt: "/r" }], result(1)]);
    // A step is on the surface of `how-it-decided` and `everything`; a cache hit, the decision
    // not to run at all, is on `what-ran`'s too.
    const steps: Record<string, boolean> = { "what-ran": true, "what-failed": true, "what-changed": true, "how-it-decided": false, everything: false };
    const hits: Record<string, boolean> = { ...steps, "what-ran": false };
    for (const view of VIEWS) {
      expect([view, folds(stepped(1, "took the fast path"), stepped(2, "took the slow path"), view)]).toEqual([view, steps[view]!]);
      expect([view, folds(hit(1, runId(7)), hit(2, runId(8)), view)]).toEqual([view, hits[view]!]);
      // Equal decisions fold under every view.
      expect([view, folds(stepped(1, "same"), stepped(2, "same"), view)]).toEqual([view, true]);
    }
  });

  test("a read that states fold false folds nothing and says so", async () => {
    const { dir, env } = scratch();
    const receipts = repoReceipts(dir);
    for (let i = 1; i <= 5; i++) invReceipt(receipts, runId(i), T0 - (6 - i) * DAY, "inv_same");
    const request = { asker: { tool: "t" }, view: "everything", window: SEALED, budget: { records: 100 } };
    const unfolded = answered(await queryReceipts({ ...request, fold: false }, { cwd: dir, env }));
    expect(unfolded.records.length).toBe(20);
    expect(unfolded.digest.runs.map((r) => r.run)).toEqual([1, 2, 3, 4, 5].map(runId));
    expect(unfolded.digest.runs.some((r) => "folded" in r)).toBe(false);
    expect(unfolded.digest.loss).toEqual({ bound: "none", excluded: 0, folded: 0 });
    expect(unfolded.counts.folded).toBe(0);
    const own = loadReceipts({ cwd: dir, env }).bundles.find((b) => b.run === unfolded.run)!;
    const query = own.records.find((r) => r.event === "query")!;
    const lens = own.records.find((r) => r.event === "lens")!;
    expect(query.record.fold).toBe(false);
    expect(lens.record.fold).toBe(false);
    expect(query.validation).toEqual({ state: "validated", schema: { id: "parley.query", version: "1.1.0" } });
    expect(lens.validation).toEqual({ state: "validated", schema: { id: "parley.lens", version: "1.1.0" } });

    // Without it, the same window folds and neither line carries the field.
    const folded = answered(await queryReceipts(request, { cwd: dir, env }));
    expect(folded.records.length).toBe(4);
    const again = loadReceipts({ cwd: dir, env }).bundles.find((b) => b.run === folded.run)!;
    expect("fold" in again.records.find((r) => r.event === "query")!.record).toBe(false);
    expect("fold" in again.records.find((r) => r.event === "lens")!.record).toBe(false);
  });

  test("a fold that is not a boolean is refused", () => {
    const plan = planQuery({ asker: { tool: "t" }, view: "everything", window: WIDE, fold: "no" as unknown as boolean });
    expect(plan.refused).toBe(true);
    if (!plan.refused) throw new Error("accepted");
    expect(plan.refusals.map((r) => [r.code, r.field])).toEqual([["query.fold_invalid", "fold"]]);
    const stated = planQuery({ asker: { tool: "t" }, view: "everything", window: WIDE, fold: true });
    expect(!stated.refused && stated.query.fold).toBe(true);
    const silent = planQuery({ asker: { tool: "t" }, view: "everything", window: WIDE });
    expect(!silent.refused && "fold" in silent.query).toBe(false);
  });

  test("a fold names the runs it stands for, and their records open", async () => {
    const { dir, env } = scratch();
    const receipts = repoReceipts(dir);
    for (let i = 1; i <= 5; i++) invReceipt(receipts, runId(i), T0 - (6 - i) * DAY, "inv_same");
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "everything", window: SEALED, budget: { records: 100 } }, { cwd: dir, env }));
    const lens = lensRecord(dir, env, answer.run);
    expect(lens.validation.state).toBe("validated");
    const section = (lens.record as unknown as { runs: { run: string; folded?: { others: number; records: number; stands_for: string[] } }[] }).runs[0]!;
    expect(section.run).toBe(runId(5));
    // Most recent first, the representative itself excluded.
    expect(section.folded).toEqual({ others: 4, records: 16, stands_for: [4, 3, 2, 1].map(runId) });
    expect(section.folded!.stands_for.length).toBe(section.folded!.others);

    const opened = await openRecords(
      { asker: { tool: "t" }, view: "everything", window: SEALED, records: section.folded!.stands_for.map((run) => ({ run, seq: 3 })) },
      { cwd: dir, env },
    );
    if (opened.refused || opened.declined) throw new Error("the drill-down did not answer");
    expect(opened.opened.map((o) => [o.outcome, o.record?.run, o.record?.event])).toEqual([4, 3, 2, 1].map((n) => ["opened", runId(n), "result"]));
  });

  test("the ids a fold names are outside the section's bound and inside the byte budget", () => {
    const resolved = { command: "t", note: "x".repeat(200) };
    const records = Array.from({ length: 41 }, (_, i) => runOf(i, "inv_many", [result(1)], { resolved })).flat();
    const { digested, envelope } = digestOf(records, { records: 1000 });
    expect(digested.digest.runs.length).toBe(1);
    const section = digested.digest.runs[0]!;
    expect(section.folded!.others).toBe(40);
    expect(section.folded!.stands_for.length).toBe(40);
    // Forty ids alone are over the section's bound, and nothing was dropped for them.
    expect(Buffer.byteLength(JSON.stringify(section.folded!.stands_for), "utf8")).toBeGreaterThan(RUN_SECTION_BYTES);
    expect("dropped" in section).toBe(false);
    expect(section.resolved).toEqual(resolved);
    const { stands_for: _ids, ...counts } = section.folded!;
    expect(Buffer.byteLength(JSON.stringify({ ...section, folded: counts }), "utf8")).toBeLessThanOrEqual(RUN_SECTION_BYTES);
    // The line's byte bound still holds with the ids in it.
    for (const bytes of [digested.bytes, digested.bytes - 1, Math.floor(digested.bytes / 2)]) {
      const bounded = digestOf(records, { records: 1000, bytes }).digested;
      expect(bounded.fits).toBe(true);
      expect(digestBytes(bounded.digest, envelope)).toBeLessThanOrEqual(bytes);
    }
    // The budget is echoed in the line, so the bound that holds all three records is the unbounded
    // size plus the echoed `bytes`; one byte under that cuts a record.
    const all = digestOf(records, { records: 1000, bytes: digested.bytes + 100 }).digested;
    expect(all.digest.records.length).toBe(3);
    expect(digestOf(records, { records: 1000, bytes: all.bytes - 1 }).digested.digest.records.length).toBeLessThan(3);
  });

  test("the reader validates the released 1.0.0 lines beside the 1.1.0 ones", () => {
    const index = validator();
    for (const id of ["parley.query", "parley.lens"]) {
      expect([id, index.has(id, "1.0.0"), index.has(id, "1.1.0")]).toEqual([id, true, true]);
    }
    const records = Array.from({ length: 3 }, (_, i) => runOf(i, "inv_same", [result(1)])).flat();
    const { digested, envelope } = digestOf(records);
    const line = JSON.parse(digestLine(digested.digest, envelope)) as Record<string, unknown> & { runs: Record<string, unknown>[] };
    expect(line._schema).toEqual({ id: "parley.lens", version: "1.1.0" });
    expect(index.validate(line).state).toBe("validated");
    // A line a 0.1.x reader wrote: the 1.0.0 pair, a fold that names no runs.
    const old = { ...line, runs: [{ ...line.runs[0]!, folded: { others: 2, records: 6 } }], _schema: { id: "parley.lens", version: "1.0.0" } };
    expect(index.validate(old)).toEqual({ state: "validated", schema: { id: "parley.lens", version: "1.0.0" } });
    const withFold = (folded: unknown) => ({ ...line, runs: [{ ...line.runs[0]!, folded }] });
    expect(index.validate(withFold({ others: 2, records: 6, stands_for: [] })).state).toBe("invalid");
    expect(index.validate(withFold({ others: 2, records: 6, stands_for: "all" })).state).toBe("invalid");
    expect(index.validate(withFold({ others: 2, records: 6, stands_for: [1, 2] })).state).toBe("invalid");
    expect(index.validate({ ...line, fold: "no" }).state).toBe("invalid");
    expect(index.validate({ ...line, fold: false }).state).toBe("validated");
  });

  // The three below hold sentences the pre-freeze review added to the 1.1.0 descriptions
  // (flyingrobots/parley#146). They pin behaviour the reader already had.

  /** One run of `inv_same` with one result, its head stamped `at` and its end 50 ms later; `null` leaves every record undated. */
  const runStamped = (n: number, at: number | null): LoadedRecord[] => {
    const t = (d: number) => (at === null ? null : at + d) as number;
    return [
      loaded(runId(n), 1, "receipt.head", t(0), { tool: "t", v: "1", argv: ["t", "x"], inv: "inv_same" }),
      loaded(runId(n), 2, "result", t(1), { ...TOOL_OWNED, value: 1 }),
      loaded(runId(n), 3, "end", t(50), { status: 0, redacted: false }),
    ];
  };

  test("a fold lists its runs by their latest record, then by the greater id, an undated run last", () => {
    // Runs 3 and 7 are the latest and tie; 2 and 4 tie; 6 has no dated record at all.
    const stamps: [number, number | null][] = [[1, T0 + 500], [2, T0 + 100], [3, T0 + 900], [4, T0 + 100], [5, T0 + 300], [6, null], [7, T0 + 900]];
    const { digested } = digestOf(stamps.flatMap(([n, at]) => runStamped(n, at)));
    expect(digested.digest.runs.map((r) => r.run)).toEqual([runId(7)]);
    expect(digested.digest.runs[0]!.folded).toEqual({ others: 6, records: 18, stands_for: [3, 1, 5, 4, 2, 6].map(runId) });
  });

  test("a byte budget never shortens the ids a fold names: the section is whole or absent", () => {
    // An older run of another invocation ranks first, then a fold of 41 whose ids alone are over a kilobyte.
    const other = [
      loaded(runId(50), 1, "receipt.head", T0 - 10_000, { tool: "t", v: "1", argv: ["t", "y"], inv: "inv_other" }),
      loaded(runId(50), 2, "result", T0 - 9_999, { ...TOOL_OWNED, value: 9 }),
      loaded(runId(50), 3, "end", T0 - 9_950, { status: 0, redacted: false }),
    ];
    const records = [...other, ...Array.from({ length: 41 }, (_, i) => runStamped(i, T0 + i * 100)).flat()];
    const whole = digestOf(records, { records: 1000 }).digested;
    expect(whole.digest.loss).toEqual({ bound: "count-only", excluded: 120, folded: 120 });
    let withSection = 0;
    let countOnly = 0;
    for (let bytes = 1; bytes <= whole.bytes + 20; bytes++) {
      const { digest, fits } = digestOf(records, { records: 1000, bytes }).digested;
      if (!fits) continue;
      // The fold does not depend on the budget, so its count is in every line that is written.
      expect(digest.loss.folded).toBe(120);
      const section = digest.runs.find((r) => r.folded !== undefined);
      if (section === undefined) {
        // The representative is not named, so no section says which runs: the count is all there is.
        expect(digest.records.some((e) => e.run === runId(40))).toBe(false);
        countOnly++;
        continue;
      }
      expect(section.folded!.stands_for.length).toBe(40);
      expect(section.folded!.others).toBe(40);
      withSection++;
    }
    expect(withSection).toBeGreaterThan(0);
    expect(countOnly).toBeGreaterThan(0);
  });

  test("a fold names runs, not records: a folded run's result can sit at another seq", () => {
    // Under `what-changed` a decision is not compared, so a run that took one more step still folds.
    const longer = [
      loaded(runId(1), 1, "receipt.head", T0, { tool: "t", v: "1", argv: ["t", "x"], inv: "inv_same" }),
      loaded(runId(1), 2, "receipt.step", T0 + 1, { decision: "warm the cache", because: "it was cold" }),
      loaded(runId(1), 3, "result", T0 + 2, { ...TOOL_OWNED, value: 1 }),
      loaded(runId(1), 4, "end", T0 + 50, { status: 0, redacted: false }),
    ];
    const plan = planQuery({ asker: { tool: "t", cwd: "/w" }, view: "what-changed", window: WIDE, budget: { records: 100 } });
    if (plan.refused) throw new Error("the plan was refused");
    const all = [...longer, ...runStamped(2, T0 + 100)];
    const ranking = rankRecords(plan.query, all);
    const { digest } = digestFor(plan.query, { run: runId(99), seq: 1 }, ranking.records, { run: runId(99), seq: 30, t: T0 + 10 }, ranking.outcomes);
    expect(digest.runs.map((r) => [r.run, r.folded])).toEqual([[runId(2), { others: 1, records: 4, stands_for: [runId(1)] }]]);
    // The representative's result is at seq 2 and the lens names it; the folded run's is at seq 3
    // and no entry says so, and its seq 2 is a decision.
    expect(digest.records.filter((e) => e.event === "result").map((e) => [e.run, e.seq])).toEqual([[runId(2), 2]]);
    expect(all.filter((r) => r.run === runId(1)).map((r) => [r.seq, r.event]).slice(1, 3)).toEqual([[2, "receipt.step"], [3, "result"]]);
  });
});
