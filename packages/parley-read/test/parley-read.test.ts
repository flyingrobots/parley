import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { defineTool, main, type Run, type Sink, type ToolSpec } from "@flyingrobots/parley-emit";
import {
  LineBuffer,
  SCHEMAS,
  SCHEMA_SOURCE,
  VIEWS,
  loadReceipts,
  planQuery,
  queryReceipts,
  readReceiptFile,
  receiptLocations,
  splitLines,
  validator,
  type Bundle,
  type LoadedRecord,
  type QueryAnswer,
  type QueryOutcome,
  type QueryRefusal,
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

async function writerRun(cwd: string, env: Record<string, string>, argv: string[], body: (run: Run) => void | Promise<void>) {
  const stdout = new Capture(), stderr = new Capture();
  const status = await main(tool(), ["t", ...argv], async (run) => { await body(run); }, { cwd, env, stdout, stderr, resolved: (args) => ({ command: "count", args }) });
  const boot = stdout.objs[0] as { run?: string; paths?: { receipt?: string } } | undefined;
  return { status, stdout, stderr, run: boot?.run, receipt: boot?.paths?.receipt };
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
// cannot, and is itself recorded through the writer (spec §9). Nothing here ranks, projects or
// truncates: that is flyingrobots/parley#49 and flyingrobots/parley#50.

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

  test("a missing window and an inverted window are both refused", async () => {
    const { dir, env } = scratch();
    const missing = await queryReceipts({ asker: { tool: "t" }, view: "everything" }, { cwd: dir, env });
    expect(codes(missing)).toEqual(["query.window_missing"]);
    const inverted = await queryReceipts({ asker: { tool: "t" }, view: "everything", window: { from: T0, to: T0 - DAY } }, { cwd: dir, env });
    expect(codes(inverted)).toEqual(["query.window_inverted"]);
  });

  test("a budget that admits no records is refused", async () => {
    const { dir, env } = scratch();
    const outcome = await queryReceipts({ asker: { tool: "t" }, view: "everything", window: WIDE, budget: { records: 0 } }, { cwd: dir, env });
    expect(codes(outcome)).toEqual(["query.budget_invalid"]);
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

  test("the recorded query loads as validated against parley.query 1.0.0 in its own bundle", async () => {
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
    expect((query.validation as { schema: { id: string; version: string } }).schema).toEqual({ id: "parley.query", version: "1.0.0" });
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
});

describe("RD-16 the window, in time order, with nothing projected or ranked", () => {
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

  test("the view is recorded and applied to nothing: two views over one window answer the same", async () => {
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
    expect(shape(failed)).toEqual(shape(everything));
    expect(everything.view).toBe("everything");
    expect(failed.view).toBe("what-failed");
  });
});
