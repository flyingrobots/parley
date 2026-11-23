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
  loadReceipts,
  digestBytes,
  digestLine,
  planQuery,
  queryReceipts,
  rankRecords,
  readHistorySegment,
  readReceiptFile,
  receiptLocations,
  splitLines,
  validator,
  type Bundle,
  type LoadedRecord,
  type QueryAnswer,
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

  test("a warning is on the failure surface and does not make its run a failed one", async () => {
    const { dir, env } = scratch();
    richReceipt(repoReceipts(dir), runId(1), T0 - DAY, "warned");
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "what-changed", window: WIDE }, { cwd: dir, env }));
    expect(placed(answer, runId(1), 3).record.event).toBe("warning");
    expect(placed(answer, runId(1), 3).tier).toBe("failure");
    expect(ids(answer.records)[0]).toBe(`${runId(1)}:3`);
    expect(answer.ranking.outcomes[runId(1)]).toBe("succeeded");
    expect(answer.ranking.counts.failedRuns).toBe(0);
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
    expect(new Set(all.records.map((r) => r.run))).toEqual(new Set([first.run, broke.run, third.run]));
    expect(all.records.length).toBe(11);

    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "what-changed", window }, { cwd: dir, env }));
    const real = new Set([first.run, broke.run, third.run]);
    const realOnly = (a: QueryAnswer) => [...ids(a.records.filter((r) => real.has(r.run)))].sort();
    expect(realOnly(answer)).toEqual(realOnly(all));
    expect(realOnly(answer).length).toBe(11);
    expect(answer.ranking.outcomes[broke.run]).toBe("failed");
    expect(answer.ranking.outcomes[first.run]).toBe("succeeded");
    expect(answer.ranking.outcomes[third.run]).toBe("succeeded");
    expect(answer.records.slice(0, 2).map((r) => [r.run, r.event])).toEqual([[broke.run, "error"], [broke.run, "end"]]);
    const results = answer.ranking.ranked.filter((r) => r.record.event === "result");
    expect(results.length).toBe(2);
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

  test("the digest loads as validated against parley.lens 1.0.0 in its own bundle", async () => {
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
    expect((lens.validation as { schema: { id: string; version: string } }).schema).toEqual({ id: "parley.lens", version: "1.0.0" });
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
    expect(answer.digest.loss).toEqual({ bound: "count-only", excluded: 23 });
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
    // A bytes budget too small even for an empty digest names no records rather than lying.
    const none = answered(await queryReceipts(
      { asker: { tool: "t" }, view: "everything", window: SEALED, budget: { records: 7, bytes: 1 } },
      { cwd: dir, env },
    ));
    expect(none.digest.records).toEqual([]);
    expect(none.digest.loss).toEqual({ bound: "count-only", excluded: 30 });
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
    expect(answer.digest.loss).toEqual({ bound: "none", excluded: 0 });
    expect(answer.counts.excluded).toBe(0);
  });

  test("an empty history answers with an empty digest that excludes nothing", async () => {
    const { dir, env } = scratch();
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "everything", window: SEALED }, { cwd: dir, env }));
    expect(answer.records).toEqual([]);
    expect(answer.digest.records).toEqual([]);
    expect(answer.digest.loss).toEqual({ bound: "none", excluded: 0 });
    expect(answer.counts.answered).toBe(0);
    expect(answer.counts.excluded).toBe(0);
    const lens = lensRecord(dir, env, answer.run);
    expect(lens.validation.state).toBe("validated");
    expect((lens.record as { loss: unknown }).loss).toEqual({ bound: "none", excluded: 0 });
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
    expect(whole.digest.loss).toEqual({ bound: "none", excluded: 0 });
    // The loss is where the digest says what it is: there is no prose field to read instead, and
    // `none` is impossible with a non-zero count because the schema refuses it.
    const lens = validator();
    const asRecord = (a: QueryAnswer) => a.lines.find((l) => l.event === "lens")!;
    expect(lens.validate({ ...asRecord(cut), loss: { bound: "none", excluded: cut.digest.loss.excluded } }).state).toBe("invalid");
    expect(Object.keys(cut.digest.loss).sort()).toEqual(["bound", "excluded"]);
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
        { asker: { tool: "t" }, view: "everything", window: SEALED, budget: { records: 20, bytes: BYTES } },
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
    // A hundredfold more history: the digest names 20 records at 30 receipts and still 20 at 300.
    expect(named).toEqual([9, 20, 20]);
    expect(excluded).toEqual([0, 70, 880]);
    // Measured, not claimed: every line is inside the stated byte bound, and the last two differ
    // by exactly the one digit the excluded count gained — the line does not grow with history.
    expect(sizes.map((b) => b <= BYTES)).toEqual([true, true, true]);
    expect(sizes[1]!).toBeGreaterThan(sizes[0]!);
    expect(sizes[2]! - sizes[1]!).toBe(1);
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
    expect(answer.digest.loss).toEqual({ bound: "count-only", excluded: 9 });
    // The failing run's error is what a change purpose puts first, and the digest keeps it.
    expect(answer.digest.records[0]).toEqual({ run: broke.run, seq: answer.records[0]!.seq });
    expect(answer.records[0]!.run).toBe(broke.run);

    const lens = lensRecord(dir, env, answer.run);
    expect(lens.validation.state).toBe("validated");
    expect((lens.validation as { schema: { id: string; version: string } }).schema).toEqual({ id: "parley.lens", version: "1.0.0" });
    const { event, ...rest } = answer.digest;
    expect(lens.record).toEqual({
      event, t: lens.t!, seq: lens.seq, run: answer.run,
      ...rest, _schema: { id: "parley.lens", version: "1.0.0" },
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
