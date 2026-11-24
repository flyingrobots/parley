import { describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, utimesSync, writeFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { doctor } from "../../../scripts/doctor.ts";
import { checkRecord, defineTool, main, ParleyRedactionConflict, ParleyRedactionUnchecked, schemaSubsetGap, SCHEMA_SOURCE, SCHEMAS, transformDigest, ulid, writeWholeLine, historyDays, declaredProjection, findSuspectedSecret, isHistoryRefusal, refuse, refuseSuspectedSecrets, SECRET_PATTERNS, HISTORY_DEFAULT_DAYS, HISTORY_MAX_DAYS, type HistoryTransform, type MainOptions, type Run, type Sink, type ToolSpec } from "../src/index.ts";
import { inspectSegment } from "../../../scripts/doctor.ts";
import { retain } from "../src/tool.ts";

const SCHEMAS_DIR = resolve(import.meta.dir, "../../../schemas");

class Capture implements Sink {
  lines: string[] = [];
  onWrite?: (line: string) => void;
  write(line: string) { this.onWrite?.(line); this.lines.push(line); }
  get text() { return this.lines.join(""); }
  get objs() { return this.lines.map((l) => JSON.parse(l) as Record<string, unknown>); }
}

const RESULT = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://example.invalid/t/schemas/t.count/1.0.0",
  type: "object",
  required: ["event", "t", "seq", "run", "value", "_schema"],
  properties: { event: { const: "result" }, value: { type: "integer", minimum: 0 }, _schema: { type: "object", required: ["id", "version"], additionalProperties: false, properties: { id: { const: "t.count" }, version: { const: "1.0.0" } } } },
};

function tool(over: Partial<ToolSpec> = {}): ToolSpec {
  return defineTool({
    name: "t", version: "0.0.1",
    commands: {
      count: {
        intent: "Count the things under the working directory",
        effects: { reads: ["<cwd>/**"], writes: [], network: false, idempotent: true },
        secrets: ["--token", "T_TOKEN", "netrc"],
        emits: [{ id: "t.count", version: "1.0.0", schema: RESULT }],
      },
    },
    retention: { count: 100 },
    ...over,
  });
}

function scratch() { return scratchAnywhere(); }
function scratchAnywhere() {
  const dir = mkdtempSync(join(tmpdir(), "parley-emit-"));
  const state = mkdtempSync(join(tmpdir(), "parley-state-"));
  return { dir, state, env: { XDG_STATE_HOME: state } as Record<string, string> };
}

function streams() { return { stdout: new Capture(), stderr: new Capture() }; }

function check(cwd: string, s: { stdout: Capture; stderr: Capture }, receiptPath?: string) {
  const boot = s.stdout.objs[0] as { paths?: { receipt?: string } } | undefined;
  const path = receiptPath ?? boot?.paths?.receipt;
  const receipt = path && existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const verdicts = doctor({ stdout: s.stdout.text, stderr: s.stderr.text, receipt, receiptPresent: path ? existsSync(path) : undefined }, SCHEMAS_DIR);
  const violations = verdicts.filter((v) => v.event === "doctor.violation");
  return { violations, receipt: receipt ?? "", receiptLines: receipt ? receipt.trimEnd().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>) : [], path };
}

async function runCount(cwd: string, env: Record<string, string>, argv: string[], body: (run: Run) => Promise<void> | void, over: Partial<ToolSpec> = {}, inputs: { path: string; role?: string }[] = [], extra: Partial<MainOptions> = {}) {
  const s = streams();
  const status = await main(tool(over), ["t", ...argv], async (run) => { await body(run); }, { cwd, env, inputs: () => inputs, resolved: (args) => ({ command: "count", args }), ...s, ...extra });
  return { ...s, status, ...check(cwd, s) };
}

describe("PE-1 conformance", () => {
  test("golden run conforms line by line", async () => {
    const { dir, env } = scratch();
    writeFileSync(join(dir, "a.txt"), "hello");
    const r = await runCount(dir, env, ["count"], async (run) => {
      run.step("read a.txt as UTF-8", "no BOM; the default for this tool is UTF-8", { bytes: 5 });
      run.warning({ code: "input.encoding_guessed", problem: "a.txt has no BOM or charset; read as UTF-8", remedy: "declare the encoding", remedy_target: "a.txt" });
      run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" });
    }, {}, [{ path: "a.txt" }]);
    expect(r.violations).toEqual([]);
    expect(r.status).toBe(0);
    const out = r.stdout.objs;
    expect(out[0]!.event).toBe("run"); expect(out[0]!.seq).toBe(0);
    expect(out.at(-1)!.event).toBe("end");
    expect(r.receiptLines[0]!.event).toBe("receipt.head");
    expect(r.receiptLines.at(-1)!.event).toBe("end");
    const maxSeq = Math.max(...[...out, ...r.receiptLines, ...r.stderr.objs].map((o) => o.seq as number));
    expect(out.at(-1)!.seq).toBe(maxSeq);
    expect(r.receiptLines.some((o) => o.event === "receipt.inputs")).toBe(true);
  });

  test("tool-owned result validates against its declared schema", async () => {
    const { dir, env } = scratch();
    const r = await runCount(dir, env, ["count"], (run) => { run.result({ event: "result", value: 3 }, { id: "t.count", version: "1.0.0" }); });
    const ajv = new Ajv2020({ strict: false }); addFormats(ajv);
    const line = r.stdout.objs.find((o) => o.event === "result");
    expect(ajv.validate(RESULT, line)).toBe(true);
    expect(r.violations).toEqual([]);
  });
});

describe("PE-2 inv", () => {
  const body = (run: Run) => { run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" }); };
  const invOf = (r: { receiptLines: Record<string, unknown>[] }) => (r.receiptLines.find((o) => o.event === "receipt.inputs") as { inv?: string } | undefined)?.inv;

  test("inv is stable across reruns", async () => {
    const { dir, env } = scratch(); writeFileSync(join(dir, "a.txt"), "hello");
    const a = await runCount(dir, env, ["count"], body, {}, [{ path: "a.txt" }]);
    const b = await runCount(dir, env, ["count"], body, {}, [{ path: "a.txt" }]);
    expect(invOf(a)).toMatch(/^[0-9a-f]{64}$/); expect(invOf(a)).toBe(invOf(b));
  });

  test("inv changes when an input changes", async () => {
    const { dir, env } = scratch(); writeFileSync(join(dir, "a.txt"), "hello");
    const a = await runCount(dir, env, ["count"], body, {}, [{ path: "a.txt" }]);
    writeFileSync(join(dir, "a.txt"), "hellp");
    const b = await runCount(dir, env, ["count"], body, {}, [{ path: "a.txt" }]);
    expect(invOf(a)).not.toBe(invOf(b));
  });

  test("inv is known at bootstrap when nothing is declared", async () => {
    const { dir, env } = scratch();
    const r = await runCount(dir, env, ["count"], body);
    expect(r.stdout.objs[0]!.inv).toMatch(/^[0-9a-f]{64}$/);
    expect(r.receiptLines[0]!.inv).toBe(r.stdout.objs[0]!.inv);
    expect(r.violations).toEqual([]);
  });

  test("inv arrives in receipt.inputs when inputs are declared", async () => {
    const { dir, env } = scratch(); writeFileSync(join(dir, "a.txt"), "hello");
    const r = await runCount(dir, env, ["count"], body, {}, [{ path: "a.txt" }]);
    expect(r.stdout.objs[0]!.inv).toBeUndefined(); expect(r.receiptLines[0]!.inv).toBeUndefined();
    const inputs = r.receiptLines.find((o) => o.event === "receipt.inputs") as { inputs: { path: string; sha256?: string }[]; inv?: string; seq: number };
    expect(inputs.inputs[0]!.sha256).toBe(createHash("sha256").update("hello").digest("hex"));
    expect(inputs.inv).toMatch(/^[0-9a-f]{64}$/);
    expect(inputs.seq).toBeLessThan((r.receiptLines.at(-1) as { seq: number }).seq);
    expect(r.violations).toEqual([]);
  });

  test("a missing input is recorded and inv is omitted", async () => {
    const { dir, env } = scratch();
    const r = await runCount(dir, env, ["count"], body, {}, [{ path: "nope.txt" }]);
    const inputs = r.receiptLines.find((o) => o.event === "receipt.inputs") as { inputs: { path: string; sha256?: string; error?: string }[]; inv?: string };
    expect(inputs.inputs[0]).toEqual({ path: "nope.txt", error: "input.unreadable" });
    expect(inputs.inv).toBeUndefined();
    expect([...r.stdout.objs, ...r.receiptLines].some((o) => "inv" in o)).toBe(false);
    expect(r.stdout.objs.at(-1)!.event).toBe("end");
    expect(r.violations).toEqual([]);
  });

  test("inv excludes declared secrets", async () => {
    const { dir, env } = scratch();
    const a = await runCount(dir, env, ["count", "--token", "s3cret-one"], body);
    const b = await runCount(dir, env, ["count", "--token", "s3cret-two"], body);
    expect(a.stdout.objs[0]!.inv).toBe(b.stdout.objs[0]!.inv);
  });

  test("an input the handler could not read is recorded unread, even when it appears later", async () => {
    // PE-2g (flyingrobots/parley#110): the writer must not hash bytes the program never saw.
    const { dir, env } = scratch();
    const refused: string[] = [];
    const r = await runCount(dir, env, ["count"], (run) => {
      run.inputUnreadable("dag.json");
      writeFileSync(join(run.cwd, "dag.json"), "{}");
      try { run.inputUnreadable("typo.json"); } catch { refused.push("undeclared"); }
      run.finaliseInputs();
      try { run.inputUnreadable("dag.json"); } catch { refused.push("settled"); }
      run.error({ code: "dag_spec.unreadable", problem: "could not read dag.json" });
    }, {}, [{ path: "dag.json" }]);
    expect(r.status).toBe(2);
    const inputs = r.receiptLines.find((o) => o.event === "receipt.inputs") as { inputs: unknown[]; inv?: string };
    expect(inputs.inputs).toEqual([{ path: "dag.json", error: "input.unreadable" }]);
    expect([...r.stdout.objs, ...r.receiptLines].some((o) => "inv" in o)).toBe(false);
    expect(refused).toEqual(["undeclared", "settled"]);
    expect(r.violations).toEqual([]);
  });

  const digestOf = (text: string) => createHash("sha256").update(text).digest("hex");
  const inputsOf = (r: { receiptLines: Record<string, unknown>[] }) => r.receiptLines.find((o) => o.event === "receipt.inputs") as { inputs: { path: string; role?: string; sha256?: string; error?: string }[]; inv?: string };

  test("an input read through readInput and then rewritten is recorded as the bytes read", async () => {
    // PE-2h (flyingrobots/parley#132): an in-place editor. The receipt says what the answer was
    // computed from, which is the bytes the tool read, not the bytes it left behind.
    const { dir, env } = scratch(); writeFileSync(join(dir, "input.txt"), "before");
    let read = "";
    const r = await runCount(dir, env, ["count"], (run) => {
      read = run.readInput("input.txt").toString("utf8");
      writeFileSync(join(run.cwd, "input.txt"), "after");
      run.result({ event: "result", value: read.length }, { id: "t.count", version: "1.0.0" });
    }, {}, [{ path: "input.txt" }]);
    expect(read).toBe("before");
    expect(readFileSync(join(dir, "input.txt"), "utf8")).toBe("after");
    expect(inputsOf(r).inputs).toEqual([{ path: "input.txt", sha256: digestOf("before") }]);
    // The same question as a run that read the same bytes and left the file alone.
    writeFileSync(join(dir, "input.txt"), "before");
    const untouched = await runCount(dir, env, ["count"], (run) => { run.readInput("input.txt"); }, {}, [{ path: "input.txt" }]);
    expect(inputsOf(r).inv).toMatch(/^[0-9a-f]{64}$/);
    expect(inputsOf(r).inv).toBe(inputsOf(untouched).inv);
    expect(r.status).toBe(0);
    expect(r.violations).toEqual([]);
  });

  test("a declared file never read through the writer is digested when the handler finishes", async () => {
    // PE-2i (flyingrobots/parley#132): the default path, kept. The tool reads the file itself and
    // rewrites it; the writer digests what is on disk at finalisation, bytes the tool never read.
    const { dir, env } = scratch(); writeFileSync(join(dir, "input.txt"), "before");
    const r = await runCount(dir, env, ["count"], (run) => {
      const read = readFileSync(join(run.cwd, "input.txt"), "utf8");
      writeFileSync(join(run.cwd, "input.txt"), "after");
      run.result({ event: "result", value: read.length }, { id: "t.count", version: "1.0.0" });
    }, {}, [{ path: "input.txt" }]);
    expect(inputsOf(r).inputs).toEqual([{ path: "input.txt", sha256: digestOf("after") }]);
    expect(r.violations).toEqual([]);
  });

  test("readInput on a file that cannot be read throws and records the input unread", async () => {
    // PE-2j (flyingrobots/parley#132): the same record inputUnreadable leaves, and the error
    // reaches the caller. The file appearing later does not change the record.
    const { dir, env } = scratch();
    let caught: unknown;
    const r = await runCount(dir, env, ["count"], (run) => {
      try { run.readInput("input.txt"); } catch (e) { caught = e; }
      writeFileSync(join(run.cwd, "input.txt"), "late");
      run.error({ code: "input.missing", problem: "could not read input.txt" });
    }, {}, [{ path: "input.txt" }]);
    expect((caught as NodeJS.ErrnoException).code).toBe("ENOENT");
    expect(inputsOf(r).inputs).toEqual([{ path: "input.txt", error: "input.unreadable" }]);
    expect([...r.stdout.objs, ...r.receiptLines].some((o) => "inv" in o)).toBe(false);
    expect(r.status).toBe(2);
    expect(r.violations).toEqual([]);
  });

  test("readInput resolves like a declared input, keeps its digest, and refuses what it cannot record", async () => {
    // PE-2k (flyingrobots/parley#132).
    const { dir, env } = scratch();
    const elsewhere = mkdtempSync(join(tmpdir(), "parley-emit-abs-"));
    writeFileSync(join(dir, "rel.txt"), "relative"); writeFileSync(join(elsewhere, "abs.txt"), "absolute");
    mkdirSync(join(dir, "src")); writeFileSync(join(dir, "src", "a.txt"), "one");
    const abs = join(elsewhere, "abs.txt");
    const refused: string[] = [];
    const attempt = (what: string, f: () => unknown) => { try { f(); } catch (e) { if (e instanceof TypeError) refused.push(what); } };
    const r = await runCount(dir, env, ["count"], (run) => {
      // Mutating the returned buffer does not move the recorded digest.
      const bytes = run.readInput("rel.txt"); bytes.fill(0);
      expect(run.readInput(abs).toString("utf8")).toBe("absolute");
      attempt("undeclared", () => run.readInput("typo.txt"));
      attempt("stdin", () => run.readInput("-"));
      attempt("tree", () => run.readInput("src"));
      // A later read replaces the earlier record; so does a later run.input or inputUnreadable.
      writeFileSync(join(run.cwd, "twice.txt"), "first"); run.readInput("twice.txt");
      writeFileSync(join(run.cwd, "twice.txt"), "second"); run.readInput("twice.txt");
      writeFileSync(join(run.cwd, "supplied.txt"), "on disk"); run.readInput("supplied.txt"); run.input("supplied.txt", "supplied later");
      writeFileSync(join(run.cwd, "retracted.txt"), "on disk"); run.readInput("retracted.txt"); run.inputUnreadable("retracted.txt", "input.retracted");
      run.finaliseInputs();
      attempt("settled", () => run.readInput("rel.txt"));
    }, {}, [{ path: "rel.txt" }, { path: abs }, { path: "-", role: "stdin" }, { path: "src", role: "tree" }, { path: "twice.txt" }, { path: "supplied.txt" }, { path: "retracted.txt" }], {});
    expect(r.status).toBe(0);
    expect(refused).toEqual(["undeclared", "stdin", "tree", "settled"]);
    const got = Object.fromEntries(inputsOf(r).inputs.map((i) => [i.path, i.sha256 ?? i.error]));
    expect(got["rel.txt"]).toBe(digestOf("relative"));
    expect(got[abs]).toBe(digestOf("absolute"));
    expect(got["-"]).toBe("input.unread");
    expect(got["twice.txt"]).toBe(digestOf("second"));
    expect(got["supplied.txt"]).toBe(digestOf("supplied later"));
    expect(got["retracted.txt"]).toBe("input.retracted");
    expect(inputsOf(r).inv).toBeUndefined();
    expect(r.violations).toEqual([]);
  });
});

describe("PE-3 bootstrap before work", () => {
  test("bootstrap precedes work and the receipt exists", async () => {
    const { dir, env } = scratch();
    let seen: { lines: number; exists: boolean } | undefined;
    const s = streams();
    await main(tool(), ["t", "count"], async (run) => { seen = { lines: s.stdout.lines.length, exists: existsSync(run.receiptPath) }; }, { cwd: dir, env, ...s });
    expect(seen).toEqual({ lines: 1, exists: true });
    expect(s.stdout.objs[0]!.paths).toEqual({ receipt: expect.stringMatching(/^\//) });
  });
});

describe("PE-4 uncaught throws", () => {
  test("an uncaught throw becomes an error line and a complete failed receipt", async () => {
    const { dir, env } = scratch();
    const r = await runCount(dir, env, ["count"], () => { throw new Error("boom"); });
    expect(r.status).toBe(2);
    const err = r.stderr.objs.find((o) => o.event === "error") as { code: string; problem: string; seq: number };
    expect(err.code).toBe("uncaught.exception"); expect(err.problem).toContain("boom");
    expect(r.receiptLines.find((o) => o.event === "error")!.seq).toBe(err.seq);
    expect((r.stdout.objs.at(-1) as { status: number }).status).toBe(2);
    expect(r.violations).toEqual([]);
  });

  test("a reported error closes the run with status 2", async () => {
    const { dir, env } = scratch();
    const r = await runCount(dir, env, ["count"], (run) => { run.error({ code: "contrast.unsatisfiable", problem: "No foreground reaches the contrast", measured: 5.3, limit: 7, remedy: "adjust the background" }); });
    expect(r.status).toBe(2);
    expect((r.stdout.objs.at(-1) as { status: number }).status).toBe(2);
    expect(r.violations).toEqual([]);
  });
});

describe("PE-5 retention", () => {
  const body = () => {};
  test("retention by count deletes the oldest bundles", async () => {
    const { dir, env } = scratch();
    const paths: string[] = [];
    for (let i = 0; i < 5; i++) { const r = await runCount(dir, env, ["count"], body, { retention: { count: 3 } }); paths.push(r.path!); }
    const dirPath = join(dir, ".parley", "receipts");
    const kept = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl")).sort();
    expect(kept.length).toBe(3);
    expect(existsSync(paths[0]!)).toBe(false); expect(existsSync(paths[1]!)).toBe(false); expect(existsSync(paths[4]!)).toBe(true);
    const last = readFileSync(paths[4]!, "utf8").trimEnd().split("\n").map((l) => JSON.parse(l) as { event: string; decision?: string });
    expect(last.some((o) => o.event === "receipt.step" && /retention/.test(o.decision ?? ""))).toBe(true);
  });

  test("a dry run deletes nothing and says so", async () => {
    const { dir, env } = scratch();
    for (let i = 0; i < 4; i++) await runCount(dir, env, ["count"], body, { retention: { count: 2 } });
    const before = readdirSync(join(dir, ".parley", "receipts")).length;
    const r = await runCount(dir, env, ["count", "--dry-run"], body, { retention: { count: 2 } });
    expect(readdirSync(join(dir, ".parley", "receipts")).length).toBe(before + 1);
    expect(r.stdout.objs[0]!.dry_run).toBe(true); expect(r.receiptLines[0]!.dry_run).toBe(true);
    expect(r.violations).toEqual([]);
  });
});

describe("PE-26 retention is per tool", () => {
  const body = () => {};
  const names = (d: string) => readdirSync(d).filter((f) => f.endsWith(".jsonl")).sort();
  async function populate(dir: string, env: Record<string, string>) {
    const own: string[] = [], other: string[] = [];
    for (let i = 0; i < 49; i++) own.push((await runCount(dir, env, ["count"], body, { retention: { count: 50 } })).path!);
    for (let i = 0; i < 14; i++) other.push((await runCount(dir, env, ["count"], body, { name: "reader", retention: { count: 50 } })).path!);
    return { own, other };
  }

  test("fourteen reads beside fifty receipts do not push any of the tool's history out", async () => {
    const { dir, env } = scratch();
    const { own, other } = await populate(dir, env);
    const last = await runCount(dir, env, ["count"], body, { retention: { count: 50 } });
    expect([...own, last.path!].every((p) => existsSync(p))).toBe(true);
    expect(other.every((p) => existsSync(p))).toBe(true);
    expect(names(join(dir, ".parley", "receipts")).length).toBe(64);
    expect(last.receiptLines.some((o) => o.event === "receipt.step" && /retention/.test(String(o.decision)))).toBe(false);
  }, 60_000);

  test("the tool's own excess is still expired, oldest first, and a neighbour's receipts are never counted", async () => {
    const { dir, env } = scratch();
    const { own, other } = await populate(dir, env);
    await runCount(dir, env, ["count"], body, { retention: { count: 50 } });
    const next = await runCount(dir, env, ["count"], body, { retention: { count: 50 } });
    expect(existsSync(own[0]!)).toBe(false);
    expect(own.slice(1).every((p) => existsSync(p))).toBe(true);
    expect(other.every((p) => existsSync(p))).toBe(true);
    expect(names(join(dir, ".parley", "receipts")).length).toBe(64);
    expect(next.violations).toEqual([]);
  }, 60_000);

  test("a file whose head cannot be read is not the tool's and is left alone", async () => {
    const { dir, env } = scratch();
    for (let i = 0; i < 2; i++) await runCount(dir, env, ["count"], body, { retention: { count: 2 } });
    const rd = join(dir, ".parley", "receipts");
    writeFileSync(join(rd, "a-empty.jsonl"), "");
    writeFileSync(join(rd, "b-garbage.jsonl"), "not json\n{\"event\":\"end\"}\n");
    writeFileSync(join(rd, "c-nohead.jsonl"), JSON.stringify({ event: "receipt.step", tool: "t" }) + "\n" + JSON.stringify({ event: "end" }) + "\n");
    const r = await runCount(dir, env, ["count"], body, { retention: { count: 2 } });
    expect(["a-empty.jsonl", "b-garbage.jsonl", "c-nohead.jsonl"].every((f) => existsSync(join(rd, f)))).toBe(true);
    expect(names(rd).length).toBe(5);
    expect(r.status).toBe(0);
  }, 60_000);

  test("the decision counts the tool's own receipts", async () => {
    const { dir, env } = scratch();
    for (let i = 0; i < 3; i++) await runCount(dir, env, ["count"], body, { name: "reader", retention: { count: 2 } });
    for (let i = 0; i < 3; i++) await runCount(dir, env, ["count"], body, { retention: { count: 2 } });
    const step = readFileSync((await runCount(dir, env, ["count"], body, { retention: { count: 2 } })).path!, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { event: string; decision?: string }).find((o) => o.event === "receipt.step" && /retention/.test(o.decision ?? ""));
    expect(step?.decision).toBe("retention: deleted 1 receipt bundle(s)");
    expect(JSON.stringify(step)).toContain("3 of this tool's receipts exceeded the retention count of 2");
  }, 60_000);
});

describe("PE-27 the command is chosen by position (flyingrobots/parley#101)", () => {
  const plain = { reads: [], writes: [], network: false, idempotent: true };
  const twoCommands: ToolSpec["commands"] = {
    plan: { intent: "plan", effects: plain, emits: [{ id: "t.count", version: "1.0.0" }] },
    edit: { intent: "edit", effects: plain, emits: [{ id: "t.count", version: "1.0.0" }] },
  };
  async function select(argv: string[], commands?: ToolSpec["commands"]) {
    const { dir, env } = scratch();
    const s = streams();
    let resolvedSaw: [string, string[]] | undefined, handlerSaw: string[] | undefined;
    const status = await main(tool(commands ? { commands } : {}), ["t", ...argv], (_run, args) => { handlerSaw = [...args]; }, {
      cwd: dir, env, ...s, resolved: (args, command) => { resolvedSaw = [command, [...args]]; return { command, args: [...args] }; },
    });
    return { status, resolved: resolvedSaw, handler: handlerSaw, codes: s.stderr.objs.map((o) => o.code) };
  }

  test("a flag value equal to the command's name reaches the tool", async () => {
    const r = await select(["edit", "--reason", "edit"], twoCommands);
    expect(r.status).toBe(0);
    expect(r.resolved).toEqual(["edit", ["--reason", "edit"]]);
    expect(r.handler).toEqual(["--reason", "edit"]);
  });

  test("a flag value naming another command does not select it", async () => {
    const r = await select(["edit", "--reason", "plan"], twoCommands);
    expect(r.status).toBe(0);
    expect(r.resolved).toEqual(["edit", ["--reason", "plan"]]);
    expect(r.handler).toEqual(["--reason", "plan"]);
  });

  test("the command is the first argument once the writer's flags are set aside", async () => {
    const bad = await select(["--reason", "plan", "edit"], twoCommands);
    expect(bad.status).toBe(3);
    expect(bad.codes).toEqual(["startup.unknown_command"]);
    expect(bad.resolved).toBeUndefined();
    expect(bad.handler).toBeUndefined();
    const ok = await select(["--dry-run", "edit", "--reason", "edit"], twoCommands);
    expect(ok.status).toBe(0);
    expect(ok.resolved).toEqual(["edit", ["--reason", "edit"]]);
    expect(ok.handler).toEqual(["--reason", "edit"]);
  });

  test("a one-command tool removes its name only from the first position", async () => {
    for (const argv of [["count", "--label", "count"], ["--label", "count"]]) {
      const r = await select(argv);
      expect(r.status).toBe(0);
      expect(r.resolved).toEqual(["count", ["--label", "count"]]);
      expect(r.handler).toEqual(["--label", "count"]);
    }
  });
});

describe("PE-28 -- ends the writer's flags (flyingrobots/parley#103)", () => {
  const plain = { reads: [], writes: [], network: false, idempotent: true };
  const twoCommands: ToolSpec["commands"] = {
    plan: { intent: "plan", effects: plain, emits: [{ id: "t.count", version: "1.0.0" }] },
    edit: { intent: "edit", effects: plain, emits: [{ id: "t.count", version: "1.0.0" }] },
  };
  async function run(argv: string[], commands?: ToolSpec["commands"]) {
    const { dir, env } = scratch();
    const s = streams();
    let resolvedSaw: [string, string[]] | undefined, handlerSaw: string[] | undefined, dryRun: boolean | undefined;
    const status = await main(tool(commands ? { commands } : {}), ["t", ...argv], (r, args) => { handlerSaw = [...args]; dryRun = r.dryRun; }, {
      cwd: dir, env, ...s, resolved: (args, command) => { resolvedSaw = [command, [...args]]; return { command, args: [...args] }; },
    });
    const out = s.stdout.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    return { status, resolved: resolvedSaw, handler: handlerSaw, dryRun, out, codes: s.stderr.objs.map((o) => o.code) };
  }

  test("a writer flag before -- is the writer's, even as a tool flag's value", async () => {
    const r = await run(["edit", "--note", "-h"], twoCommands);
    expect(r.status).toBe(0);
    expect(r.handler).toBeUndefined();
    expect(r.out.filter((o) => o.event === "command").map((o) => o.name)).toEqual(["edit"]);
  });

  test("after --, a writer flag's text reaches the tool", async () => {
    const r = await run(["edit", "--", "--note", "-h"], twoCommands);
    expect(r.status).toBe(0);
    expect(r.resolved).toEqual(["edit", ["--note", "-h"]]);
    expect(r.handler).toEqual(["--note", "-h"]);
    expect(r.out.some((o) => o.event === "command")).toBe(false);
  });

  test("-- with nothing after it gives the tool nothing, and only the first -- is removed", async () => {
    const empty = await run(["edit", "--"], twoCommands);
    expect(empty.status).toBe(0);
    expect(empty.resolved).toEqual(["edit", []]);
    expect(empty.handler).toEqual([]);
    const two = await run(["edit", "--", "a", "--", "b"], twoCommands);
    expect(two.status).toBe(0);
    expect(two.resolved).toEqual(["edit", ["a", "--", "b"]]);
    expect(two.handler).toEqual(["a", "--", "b"]);
  });

  test("writer flags after -- are not the writer's", async () => {
    const r = await run(["edit", "--", "--dry-run", "--human"], twoCommands);
    expect(r.status).toBe(0);
    expect(r.dryRun).toBe(false);
    expect(r.out[0]!.dry_run).toBeUndefined();
    expect(r.handler).toEqual(["--dry-run", "--human"]);
  });

  test("the command is never taken from after --", async () => {
    const bad = await run(["--", "edit"], twoCommands);
    expect(bad.status).toBe(3);
    expect(bad.codes).toEqual(["startup.unknown_command"]);
    expect(bad.handler).toBeUndefined();
    const one = await run(["--", "count"]);
    expect(one.status).toBe(0);
    expect(one.resolved).toEqual(["count", ["count"]]);
    expect(one.handler).toEqual(["count"]);
  });
});

describe("PE-6 repository hygiene", () => {
  test("first write creates the ignore file", async () => {
    const { dir, env } = scratch();
    await runCount(dir, env, ["count"], () => {});
    expect(readFileSync(join(dir, ".parley", ".gitignore"), "utf8").split("\n")).toContain("*");
  });

  test("an existing ignore file is never overwritten", async () => {
    const { dir, env } = scratch();
    mkdirSync(join(dir, ".parley")); writeFileSync(join(dir, ".parley", ".gitignore"), "# mine\n*\n!keep\n");
    const r = await runCount(dir, env, ["count"], () => {});
    expect(readFileSync(join(dir, ".parley", ".gitignore"), "utf8")).toBe("# mine\n*\n!keep\n");
    expect(r.path!.startsWith(join(dir, ".parley"))).toBe(true);
  });

  test("a user's ignore file sends the receipt to the fallback", async () => {
    const { dir, env, state } = scratch();
    mkdirSync(join(dir, ".parley")); writeFileSync(join(dir, ".parley", ".gitignore"), "receipts/\n");
    const r = await runCount(dir, env, ["count"], () => {});
    expect(readFileSync(join(dir, ".parley", ".gitignore"), "utf8")).toBe("receipts/\n");
    expect(r.path!.startsWith(join(state, "parley"))).toBe(true);
    expect(r.stderr.objs.some((o) => o.event === "warning" && (o.code as string).startsWith("receipt."))).toBe(true);
    expect(r.violations).toEqual([]);
  });

  test("concurrent runs do not collide", async () => {
    const { dir, env } = scratch();
    const rs = await Promise.all(Array.from({ length: 8 }, () => runCount(dir, env, ["count"], async () => { await new Promise((r) => setTimeout(r, 5)); })));
    expect(new Set(rs.map((r) => r.path)).size).toBe(8);
    for (const r of rs) expect(r.violations).toEqual([]);
    expect(readFileSync(join(dir, ".parley", ".gitignore"), "utf8").split("\n")).toContain("*");
  });

  test("a negation that can re-include receipts/ sends the receipt to the fallback", async () => {
    // PE-6e (flyingrobots/parley#109): with `*`, nothing under receipts/ can be staged unless a
    // negation re-includes the directory itself; a writer that cannot tell treats it as one.
    for (const text of ["*\n!receipts/\n!receipts/**\n", "*\n!rec*\n", "*\n!*/\n", "*\n!**/receipts\n", "*\n!receipts/**\n", "*\n!/Receipts/\n", "*\n!r[e]ceipts\n"]) {
      const { dir, env, state } = scratch();
      mkdirSync(join(dir, ".parley")); writeFileSync(join(dir, ".parley", ".gitignore"), text);
      const r = await runCount(dir, env, ["count"], () => {});
      expect(readFileSync(join(dir, ".parley", ".gitignore"), "utf8")).toBe(text);
      expect([text, r.path!.startsWith(join(state, "parley"))]).toEqual([text, true]);
      const warning = r.stderr.objs.find((o) => o.code === "receipt.relocated") as { problem: string } | undefined;
      expect(warning?.problem).toContain("negation");
      expect(r.violations).toEqual([]);
    }
    for (const text of ["*\n!keep\n", "*\n# !receipts/\n", "*\n\\!receipts\n", "*\n"]) {
      const { dir, env } = scratch();
      mkdirSync(join(dir, ".parley")); writeFileSync(join(dir, ".parley", ".gitignore"), text);
      const r = await runCount(dir, env, ["count"], () => {});
      expect([text, r.path!.startsWith(join(dir, ".parley"))]).toEqual([text, true]);
    }
  });

  // PE-6f (spec §5.2, "a program that cannot tell whether a negation matches MUST treat it as one
  // that does"): the oracle is real git. Each content is written to `.parley/.gitignore` in a fresh
  // repository, the writer runs, and `git add -A -n` must not list the receipt the writer wrote.
  const F = "!*.jsonl\n";
  /** Contents whose negation the writer cannot evaluate exactly, or that match: the receipt must leave the repository. */
  const RELOCATED: Record<string, string> = {
    "a POSIX class at the start": `*\n![[:alpha:]]eceipts\n${F}`,
    "a POSIX class in the middle": `*\n!r[[:lower:]]ceipts\n${F}`,
    "a POSIX class beside a literal": `*\n!r[[:alnum:]_]ceipts\n${F}`,
    "a negated POSIX class": `*\n!r[^[:digit:]]ceipts\n${F}`,
    "a NUL byte after the pattern": `*\n!receipts\u0000\n${F}`,
    "an equivalence class": `*\n!r[[=e=]]ceipts\n${F}`,
    "a collating symbol": `*\n!r[[.e.]]ceipts\n${F}`,
    "an unterminated bracket": `*\n![receipts\n${F}`,
    "a negated class whose first member is ]": `*\n![^]]eceipts\n${F}`,
    "the same with !": `*\n![!]]eceipts\n${F}`,
    "a class whose first member is ]": `*\n![]r]eceipts\n${F}`,
    "a range": `*\n!r[a-f]ceipts\n${F}`,
    "a range then a literal dash": `*\n!r[a-e-g]ceipts\n${F}`,
    "a negated class": `*\n!r[!x]ceipts\n${F}`,
    "upper case": `*\n!RECEIPTS\n${F}`,
    "a long s": `*\n!receiptſ\n${F}`,
    "a Kelvin sign": `*\n!receiKts\n${F}`,
    "a tab after the pattern": `*\n!receipts\t\n${F}`,
    "CRLF line endings": `*\r\n!receipts\r\n!*.jsonl\r\n`,
    "no final newline": `*\n!receipts\n!*.jsonl`,
  };
  /** Controls the writer evaluates exactly and that cannot match `receipts`: the receipt stays. */
  const KEPT: Record<string, string> = {
    "* alone": "*\n",
    "the files re-included, the directory not": `*\n${F}`,
    "another name": `*\n!keep\n${F}`,
    "a reversed range": `*\n!r[f-a]ceipts\n${F}`,
    "a class without the letter": `*\n!r[abc]ceipts\n${F}`,
    "a negated class holding the letter": `*\n!r[!e]ceipts\n${F}`,
    "braces, which git reads literally": `*\n!{receipts}\n${F}`,
    "a comment": `*\n#!receipts\n${F}`,
    "an escaped bang": `*\n\\!receipts\n${F}`,
  };
  const GIT_ENV = { PATH: process.env.PATH ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: tmpdir() };
  const HAS_GIT = Bun.spawnSync(["git", "--version"], { env: GIT_ENV }).exitCode === 0;
  const git = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync(["git", "-C", cwd, ...args], { env: GIT_ENV });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
    return p.stdout.toString();
  };
  /** Whether real git would stage a file at `.parley/receipts/` under this ignore file, in a repository of its own. */
  const gitWouldStage = (text: string): boolean => {
    const o = mkdtempSync(join(tmpdir(), "parley-emit-oracle-"));
    git(o, "init", "-q");
    mkdirSync(join(o, ".parley", "receipts"), { recursive: true });
    writeFileSync(join(o, ".parley", ".gitignore"), text);
    writeFileSync(join(o, ".parley", "receipts", "01PROBE.jsonl"), "{}\n");
    return git(o, "add", "-A", "-n", ".").includes("receipts/01PROBE.jsonl");
  };
  const runWith = async (text: string) => {
    const { dir, env, state } = scratch();
    if (HAS_GIT) git(dir, "init", "-q");
    mkdirSync(join(dir, ".parley")); writeFileSync(join(dir, ".parley", ".gitignore"), text);
    const r = await runCount(dir, env, ["count"], () => {});
    expect(readFileSync(join(dir, ".parley", ".gitignore"), "utf8")).toBe(text);
    expect(r.status).toBe(0);
    // The property itself: whatever the writer decided, git does not stage what it wrote.
    if (HAS_GIT) expect(git(dir, "add", "-A", "-n", ".")).not.toContain(".parley/receipts/");
    return { r, dir, state };
  };

  for (const [name, text] of Object.entries(RELOCATED)) {
    test(`a negation the writer cannot evaluate exactly counts as one that matches: ${name}`, async () => {
      const { r, state } = await runWith(text);
      expect([name, r.path!.startsWith(join(state, "parley"))]).toEqual([name, true]);
      const warning = r.stderr.objs.find((o) => o.code === "receipt.relocated") as { problem: string } | undefined;
      expect(warning?.problem).toContain("negation");
      expect(r.violations).toEqual([]);
    });
  }

  for (const [name, text] of Object.entries(KEPT)) {
    test(`a negation that cannot match receipts leaves the receipt in the repository, where git does not stage it: ${name}`, async () => {
      if (HAS_GIT) expect([name, gitWouldStage(text)]).toEqual([name, false]);
      const { r, dir } = await runWith(text);
      expect([name, r.path!.startsWith(join(dir, ".parley"))]).toEqual([name, true]);
      expect(r.stderr.objs).toEqual([]);
    });
  }

  test.skipIf(!HAS_GIT)("real git stages a receipt under each of the reviewed contents, which is why the writer must leave", () => {
    for (const name of ["a POSIX class at the start", "a POSIX class in the middle", "a POSIX class beside a literal", "a negated POSIX class", "a NUL byte after the pattern", "a negated class whose first member is ]", "the same with !"]) {
      expect([name, gitWouldStage(RELOCATED[name]!)]).toEqual([name, true]);
    }
  });
});

describe("PE-7 redaction", () => {
  const SECRET = "s3cret-value-xyz";
  test("declared secrets are redacted in the head", async () => {
    const { dir, env } = scratch();
    const r = await runCount(dir, { ...env, T_TOKEN: SECRET }, ["count", "--token", SECRET, "--other=" + SECRET + "-tail", "--token=" + SECRET], () => {}, { sources: { netrc: () => true } });
    const head = r.receiptLines[0] as { argv: string[]; resolved: Record<string, unknown>; redacted: Record<string, unknown[]> };
    expect(head.argv).toEqual(["t", "count", "--token", "[redacted]", "--other=[redacted]-tail", "--token=[redacted]"]);
    expect(head.redacted.argv).toEqual([3, 4, 5]);
    expect(head.redacted.env).toEqual(["T_TOKEN"]);
    expect(head.redacted.sources).toEqual(["netrc"]);
    expect(head.redacted.resolved!.length).toBeGreaterThan(0);
    const everything = r.stdout.text + r.stderr.text + r.receipt;
    expect(everything.includes(SECRET)).toBe(false);
    expect((r.stdout.objs.at(-1) as { redacted: boolean }).redacted).toBe(true);
    expect(r.violations).toEqual([]);
  });

  test("a secret in a later record is replaced and recorded", async () => {
    const { dir, env } = scratch();
    const r = await runCount(dir, env, ["count", "--token", SECRET], (run) => { run.step("fetched", "because", { url: "https://x/?t=" + SECRET }); });
    const step = r.receiptLines.find((o) => o.event === "receipt.step") as { seq: number; detail: { url: string } };
    expect(step.detail.url).toBe("https://x/?t=[redacted]");
    const red = r.receiptLines.find((o) => o.event === "redaction") as { in: number; at: string; seq: number };
    expect(red.in).toBe(step.seq); expect(red.at).toBe("/detail/url"); expect(red.seq).toBeGreaterThan(step.seq);
    expect(r.receipt.includes(SECRET)).toBe(false);
    expect(r.violations).toEqual([]);
  });

  test("no redaction field when nothing was redacted", async () => {
    const { dir, env } = scratch();
    const r = await runCount(dir, env, ["count"], () => {});
    expect("redacted" in r.receiptLines[0]!).toBe(false);
    expect((r.stdout.objs.at(-1) as { redacted: boolean }).redacted).toBe(false);
  });

  test("scrub widely, resolve narrowly: another command's variable is scrubbed and listed, its source is never resolved", async () => {
    // flyingrobots/parley#93, spec §5.3.
    const { dir, env } = scratch();
    const OTHER = "b-token-value-q7";
    const called: string[] = [];
    const two = defineTool({
      name: "t", version: "0.0.1",
      commands: {
        a: { intent: "The command that runs", effects: { reads: [], writes: [], network: false, idempotent: true }, secrets: ["--token", "A_TOKEN", "alpha"], emits: [{ id: "t.count", version: "1.0.0", schema: RESULT }] },
        b: { intent: "A command that does not run", effects: { reads: [], writes: [], network: false, idempotent: true }, secrets: ["B_TOKEN", "beta"], emits: [{ id: "t.count", version: "1.0.0", schema: RESULT }] },
      },
      retention: { count: 100 },
      sources: { alpha: () => { called.push("alpha"); return true; }, beta: () => { called.push("beta"); return true; } },
    });
    const s = streams();
    const status = await main(two, ["t", "a", "--note=" + OTHER], (run) => { run.step("noted", "the argument is echoed", { note: OTHER }); }, { cwd: dir, env: { ...env, B_TOKEN: OTHER }, ...s });
    expect(status).toBe(0);
    const c = check(dir, s);
    const head = c.receiptLines[0] as { argv: string[]; redacted: { env?: string[]; sources?: string[]; argv?: number[] } };
    expect(head.argv).toEqual(["t", "a", "--note=[redacted]"]);
    expect(head.redacted.env).toEqual(["B_TOKEN"]);
    expect(head.redacted.sources).toEqual(["alpha"]);
    expect(called).toEqual(["alpha"]);
    expect((s.stdout.text + s.stderr.text + c.receipt).includes(OTHER)).toBe(false);
    expect(c.violations).toEqual([]);
  });
});

describe("PE-8 locations and startup failure", () => {
  test("a read-only working directory falls back to the state directory", async () => {
    const { dir, env, state } = scratch();
    chmodSync(dir, 0o555);
    try {
      const r = await runCount(dir, env, ["count"], () => {});
      expect(r.path!.startsWith(join(state, "parley"))).toBe(true);
      expect(r.violations).toEqual([]);
    } finally { chmodSync(dir, 0o755); }
  });

  test("no writable location is a startup failure", async () => {
    const { dir, state } = scratch();
    chmodSync(dir, 0o555); chmodSync(state, 0o555);
    try {
      const s = streams();
      const status = await main(tool(), ["t", "count"], async () => {}, { cwd: dir, env: { XDG_STATE_HOME: state }, ...s });
      expect(status).toBe(3);
      expect(s.stdout.lines).toEqual([]);
      expect(s.stderr.objs.length).toBe(1);
      expect(s.stderr.objs[0]).toMatchObject({ event: "startup.failed", seq: 0, code: "startup.receipt_unwritable" });
      const v = doctor({ stdout: "", stderr: s.stderr.text }, SCHEMAS_DIR).filter((x) => x.event === "doctor.violation");
      expect(v).toEqual([]);
    } finally { chmodSync(dir, 0o755); chmodSync(state, 0o755); }
  });
});

describe("PE-9 sinks and end", () => {
  test("a sink failure before end is reported and exits 4", async () => {
    const { dir, env } = scratch();
    const s = streams();
    s.stdout.onWrite = (l) => { if (l.includes('"result"')) throw new Error("EPIPE"); };
    const status = await main(tool(), ["t", "count"], async (run) => { run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" }); }, { cwd: dir, env, ...s });
    expect(status).toBe(4);
    const err = s.stderr.objs.find((o) => o.event === "error") as { code: string };
    expect(err.code).toMatch(/^sink\./);
    const { receiptLines } = check(dir, s);
    expect((receiptLines.at(-1) as { status: number }).status).toBe(4);
  });

  test("nothing follows end", async () => {
    const { dir, env } = scratch();
    const s = streams();
    let threw = false;
    const status = await main(tool(), ["t", "count"], async (run) => {
      run.end(0);
      try { run.step("late", "too late"); } catch { threw = true; }
    }, { cwd: dir, env, ...s });
    expect(threw).toBe(true);
    expect(s.stdout.objs.at(-1)!.event).toBe("end");
    expect(s.stdout.objs.filter((o) => o.event === "end").length).toBe(1);
    expect(status).toBe(0);
    expect(check(dir, s).violations).toEqual([]);
  });
});

describe("PE-10 discovery", () => {
  test("--schema is a run", async () => {
    const { dir, env } = scratch();
    const s = streams();
    const status = await main(tool(), ["t", "--schema"], async () => { throw new Error("handler must not run"); }, { cwd: dir, env, ...s });
    expect(status).toBe(0);
    const out = s.stdout.objs;
    expect(out[0]!.event).toBe("run"); expect(out.at(-1)!.event).toBe("end");
    expect(out.filter((o) => o.event === "command").map((o) => o.name)).toEqual(["count"]);
    const ids = out.filter((o) => o.event === "schema").map((o) => `${o.id}@${o.version}`);
    expect(ids).toContain("t.count@1.0.0"); expect(ids).toContain("parley.error@2.0.0"); expect(ids).toContain("parley.run.bootstrap@1.1.1");
    expect(check(dir, s).violations).toEqual([]);
  });

  test("--help describes one command", async () => {
    const { dir, env } = scratch();
    const s = streams();
    const status = await main(tool(), ["t", "count", "--help"], async () => { throw new Error("handler must not run"); }, { cwd: dir, env, ...s });
    expect(status).toBe(0);
    const out = s.stdout.objs;
    expect(out.filter((o) => o.event === "command").length).toBe(1);
    const ids = out.filter((o) => o.event === "schema").map((o) => `${o.id}@${o.version}`);
    expect(ids).toEqual(["t.count@1.0.0", "parley.error@2.0.0", "parley.startup.failed@1.0.0"]);
    expect(check(dir, s).violations).toEqual([]);
  });

  test("--help lists parley.startup.failed beside parley.error when the command declares no errors", async () => {
    // flyingrobots/parley#92: every command can produce a startup failure, so §4.2's "every error
    // type it can produce" includes it, in the command line's emits and as a schema line.
    const { dir, env } = scratch();
    const s = streams();
    expect(await main(tool(), ["t", "count", "--help"], async () => {}, { cwd: dir, env, ...s })).toBe(0);
    const command = s.stdout.objs.find((o) => o.event === "command") as { emits: { id: string; version: string }[] };
    expect(command.emits).toEqual([{ id: "t.count", version: "1.0.0" }, { id: "parley.error", version: "2.0.0" }, { id: "parley.startup.failed", version: "1.0.0" }]);
    const ids = s.stdout.objs.filter((o) => o.event === "schema").map((o) => `${o.id}@${o.version}`);
    expect(ids).toEqual(["t.count@1.0.0", "parley.error@2.0.0", "parley.startup.failed@1.0.0"]);
    expect(check(dir, s).violations).toEqual([]);
  });

  test("a schema document is published as declared, even when a secret value occurs in it", async () => {
    // PE-10d (flyingrobots/parley#111): a static schema document is not run data; scrubbing a
    // coincidental match would advertise a pair whose document it no longer is.
    const { dir, env } = scratch();
    const s = streams();
    const spec = tool({ commands: { count: { intent: "Count each object under the working directory", effects: { reads: ["<cwd>/**"], writes: [], network: false, idempotent: true }, secrets: ["T_TOKEN"], emits: [{ id: "t.count", version: "1.0.0", schema: RESULT }] } } });
    expect(await main(spec, ["t", "count", "--help"], async () => {}, { cwd: dir, env: { ...env, T_TOKEN: "object" }, ...s })).toBe(0);
    const docs = new Map(s.stdout.objs.filter((o) => o.event === "schema").map((o) => [o.id as string, o.schema]));
    expect(docs.get("t.count")).toEqual(RESULT);
    expect(docs.get("parley.error")).toEqual(SCHEMAS.find((x) => x.id === "parley.error" && x.version === "2.0.0")!.schema);
    expect((s.stdout.objs.find((o) => o.event === "command") as { intent: string }).intent).toBe("Count each [redacted] under the working directory");
    const c = check(dir, s);
    const schemaSeqs = new Set(c.receiptLines.filter((o) => o.event === "schema").map((o) => o.seq));
    expect(c.receiptLines.some((o) => o.event === "redaction" && schemaSeqs.has(o.in))).toBe(false);
    expect(s.stdout.objs.at(-1)!.redacted).toBe(true);
    expect(c.violations).toEqual([]);
  });
});

describe("PE-11 sidecars", () => {
  test("a large record is stored as a sidecar", async () => {
    const { dir, env } = scratch();
    const rows = Array.from({ length: 3000 }, (_, i) => ({ i, text: "x".repeat(30) }));
    const r = await runCount(dir, env, ["count"], (run) => { run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" }, { rows }); });
    const stdoutResult = r.stdout.objs.find((o) => o.event === "result")!;
    expect("rows" in stdoutResult).toBe(false);
    const side = r.receiptLines.find((o) => o.event === "sidecar") as { source: number; path: string; bytes: number; sha256: string };
    expect(side.source).toBe(stdoutResult.seq as number);
    const stored = readFileSync(join(r.path!, "..", side.path));
    expect(stored.length).toBe(side.bytes); expect(side.bytes).toBeGreaterThan(65536);
    expect(createHash("sha256").update(stored).digest("hex")).toBe(side.sha256);
    expect((JSON.parse(stored.toString("utf8")) as { rows: unknown[] }).rows.length).toBe(3000);
    expect(r.receiptLines.some((o) => o.event === "result")).toBe(false);
    expect(r.violations).toEqual([]);
  });
});

describe("PE-12 one JSON object per line, always", () => {
  test("every line on every stream is one JSON object", async () => {
    const { dir, env } = scratch();
    let seed = 7; const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const weird = () => Array.from({ length: Math.floor(rnd() * 40) }, () => String.fromCodePoint([10, 13, 9, 0, 0x7f, 0x2028, 0x1f600, 34, 92, 65][Math.floor(rnd() * 10)]!)).join("");
    const records: Record<string, unknown>[] = [];
    const r = await runCount(dir, env, ["count"], (run) => {
      for (let i = 0; i < 300; i++) {
        const rec = { event: "result", value: i, note: weird(), nested: { a: weird(), b: [weird(), weird()] } };
        records.push(rec); run.result(rec, { id: "t.count", version: "1.0.0" });
      }
    });
    for (const line of [...r.stdout.lines, ...r.stderr.lines, ...r.receipt.split("\n").filter(Boolean)]) {
      expect(line.endsWith("\n") || !r.stdout.lines.includes(line) ? true : false).toBe(true);
      expect(line.trimEnd().includes("\n")).toBe(false);
      expect(typeof JSON.parse(line)).toBe("object");
    }
    const out = r.stdout.objs.filter((o) => o.event === "result");
    expect(out.map((o) => o.note)).toEqual(records.map((o) => o.note));
    expect(r.violations).toEqual([]);
  });

  test("library console output is captured", async () => {
    const { dir, env } = scratch();
    const r = await runCount(dir, env, ["count"], () => { console.log("hello from a library"); console.error("and an error"); });
    for (const l of [...r.stdout.lines, ...r.stderr.lines]) expect(() => JSON.parse(l)).not.toThrow();
    expect(r.stderr.lines.length).toBe(0);
    expect(r.receipt).toContain("hello from a library");
    expect(r.receipt).toContain("and an error");
    expect(r.violations).toEqual([]);
  });

  test("--human renders prose and keeps the receipt", async () => {
    const { dir, env } = scratch();
    const s = streams();
    const status = await main(tool({ human: (line) => (line.event === "result" ? `counted ${String(line.value)}` : null) }), ["t", "count", "--human"], async (run) => { run.result({ event: "result", value: 9 }, { id: "t.count", version: "1.0.0" }); }, { cwd: dir, env, ...s });
    expect(status).toBe(0);
    expect(s.stdout.lines).toEqual(["counted 9\n"]);
    const boot = JSON.parse(readFileSync(join(dir, ".parley", "receipts", readdirSync(join(dir, ".parley", "receipts")).find((f) => f.endsWith(".jsonl"))!), "utf8").split("\n")[0]!) as { event: string };
    expect(boot.event).toBe("receipt.head");
  });
});

describe("PE-13 shipped schemas", () => {
  test("shipped schemas match the drafts", () => {
    for (const [file, digest] of Object.entries(SCHEMA_SOURCE.files)) {
      expect(createHash("sha256").update(readFileSync(join(SCHEMAS_DIR, file))).digest("hex")).toBe(digest);
    }
    expect(SCHEMAS.length).toBe(readdirSync(SCHEMAS_DIR).filter((f) => f.endsWith(".schema.json")).length);
    expect(SCHEMA_SOURCE.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  test("run ids are ULIDs, unique and sortable", () => {
    const ids = Array.from({ length: 50 }, () => ulid());
    for (const id of ids) expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(new Set(ids).size).toBe(50);
    const a = ulid(1000), b = ulid(2000);
    expect(a < b).toBe(true);
  });
});

// ---- cases added after the review of f59a7c7 (case parley-pr42-parley-emit-2026-11-22) ----

const SECRET2 = "s3cret-pr42";

function twoCommands(over: Partial<ToolSpec> = {}): ToolSpec {
  return defineTool({
    name: "t", version: "0.0.1",
    commands: {
      count: { intent: "count", effects: { reads: [], writes: [], network: false, idempotent: true }, secrets: ["--token"], emits: [{ id: "t.count", version: "1.0.0", schema: RESULT }] },
      other: { intent: "other", effects: { reads: [], writes: [], network: false, idempotent: true }, secrets: ["--key"], emits: [{ id: "t.count", version: "1.0.0", schema: RESULT }] },
    },
    retention: { count: 100 }, ...over,
  });
}

describe("PE-14 secrets never reach a stream (F-1, F-2, F-3)", () => {
  test("no command selected: the startup line and nothing else, with no secret in it", async () => {
    const { dir, env } = scratch();
    const s = streams();
    const status = await main(twoCommands(), ["t", "--token", SECRET2], async () => {}, { cwd: dir, env, ...s });
    expect(status).toBe(3);
    expect(s.stdout.lines).toEqual([]);
    expect(s.stderr.objs.length).toBe(1);
    expect(s.stderr.objs[0]!.event).toBe("startup.failed");
    expect(s.stderr.text.includes(SECRET2)).toBe(false);
    expect(existsSync(join(dir, ".parley", "receipts")) ? readdirSync(join(dir, ".parley", "receipts")).length : 0).toBe(0);
  });

  test("discovery with a secret on the command line redacts it in the head", async () => {
    const { dir, env } = scratch();
    const s = streams();
    await main(twoCommands(), ["t", "--schema", "--key", SECRET2], async () => {}, { cwd: dir, env, ...s });
    const { receipt, receiptLines } = check(dir, s);
    expect(receipt.includes(SECRET2)).toBe(false);
    expect((receiptLines[0] as { redacted: { argv: number[] } }).redacted.argv).toEqual([3]);
  });

  test("a secret that is a substring of the working directory relocates the receipt and never appears in clear", async () => {
    const { dir, env, state } = scratch();
    const zone = join(dir, "zone-x9"); mkdirSync(zone);
    const s = streams();
    const status = await main(tool(), ["t", "count", "--token", "zone-x9"], async (run) => { run.result({ event: "result", value: 1, note: "zone-x9 is in" }, { id: "t.count", version: "1.0.0" }); }, { cwd: zone, env, ...s });
    expect(status).toBe(0);
    const boot = s.stdout.objs[0] as { paths: { receipt: string }; event: string; _schema: { id: string } };
    expect(boot.event).toBe("run"); expect(boot._schema.id).toBe("parley.run.bootstrap");
    expect(boot.paths.receipt.startsWith(join(state, "parley"))).toBe(true);
    const all = s.stdout.text + s.stderr.text + readFileSync(boot.paths.receipt, "utf8");
    expect(all.includes("zone-x9")).toBe(false);
    expect((s.stdout.objs.find((o) => o.event === "result") as { note: string }).note).toBe("[redacted] is in");
    expect(s.stderr.objs.some((o) => o.event === "warning" && o.code === "receipt.relocated")).toBe(true);
    expect(check(zone, s).violations).toEqual([]);
  });

  test("a secret that every receipt path would carry is a startup failure", async () => {
    const { dir, env } = scratch();
    const s = streams();
    const status = await main(tool(), ["t", "count", "--token", "receipts"], async () => {}, { cwd: dir, env, ...s });
    expect(status).toBe(3);
    expect(s.stdout.lines).toEqual([]);
    expect(s.stderr.objs).toEqual([expect.objectContaining({ event: "startup.failed", code: "startup.secret_in_path" })]);
    expect(s.stderr.text.includes("receipts")).toBe(false);
    expect(existsSync(join(dir, ".parley", "receipts")) ? readdirSync(join(dir, ".parley", "receipts")).length : 0).toBe(0);
  });

  test("a secret that collides with an envelope word redacts payload values only", async () => {
    const { dir, env } = scratch();
    const r = await runCount(dir, env, ["count", "--token", "run"], (run) => { run.step("a run of the mill", "because a run is a run", { word: "run" }); run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" }); });
    for (const o of [...r.stdout.objs, ...r.receiptLines]) { expect(typeof o.event).toBe("string"); expect(o.run).toBe(r.stdout.objs[0]!.run); expect((o._schema as { id: string }).id.startsWith("parley.") || (o._schema as { id: string }).id === "t.count").toBe(true); }
    expect(r.stdout.objs[0]!.event).toBe("run");
    const step = r.receiptLines.find((o) => o.event === "receipt.step") as { decision: string; detail: { word: string } };
    expect(step.decision).toBe("a [redacted] of the mill"); expect(step.detail.word).toBe("[redacted]");
    expect(r.violations).toEqual([]);
  });

  test("a secret in a declared input path does not enter inv", async () => {
    const { dir, env } = scratch();
    for (const sec of ["alpha-secret", "beta-secret"]) { mkdirSync(join(dir, sec)); writeFileSync(join(dir, sec, "a.txt"), "same bytes"); }
    const invOf = (r: { receiptLines: Record<string, unknown>[] }) => (r.receiptLines.find((o) => o.event === "receipt.inputs") as { inv?: string } | undefined)?.inv;
    const a = await runCount(dir, env, ["count", "--token", "alpha-secret"], () => {}, {}, [{ path: "alpha-secret/a.txt" }]);
    const b = await runCount(dir, env, ["count", "--token", "beta-secret"], () => {}, {}, [{ path: "beta-secret/a.txt" }]);
    expect(invOf(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(invOf(a)).toBe(invOf(b));
    expect(a.receipt.includes("alpha-secret")).toBe(false);
  });
});

describe("PE-15 throws outside the handler (F-4)", () => {
  test("a throwing resolved callback is a startup failure, exit 3, and leaves no receipt", async () => {
    const { dir, env } = scratch();
    const s = streams();
    const status = await main(tool(), ["t", "count"], async () => {}, { cwd: dir, env, ...s, resolved: () => { throw new Error("bad flag"); } });
    expect(status).toBe(3);
    expect(s.stdout.lines).toEqual([]);
    expect(s.stderr.objs).toEqual([expect.objectContaining({ event: "startup.failed", seq: 0, code: "startup.arguments_invalid" })]);
    expect(s.stderr.objs[0]!.problem).toContain("bad flag");
    expect(readdirSync(join(dir, ".parley", "receipts")).length).toBe(0);
  });

  test("the example checks its arguments before the bootstrap line, so a usage error is a startup failure", () => {
    // flyingrobots/parley#91: the bootstrap line is the boundary; examples/count.ts checks in
    // `resolved`, before it, so a mistaken call is exit 3 with no receipt.
    const { dir, env } = scratch();
    const p = Bun.spawnSync(["bun", resolve(import.meta.dir, "../examples/count.ts"), "files", "extra"], { cwd: dir, env: { ...process.env, ...env } });
    const stdout = p.stdout.toString(), stderr = p.stderr.toString();
    expect(p.exitCode).toBe(3);
    expect(stdout).toBe("");
    const lines = stderr.trimEnd().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toEqual([expect.objectContaining({ event: "startup.failed", seq: 0, code: "startup.arguments_invalid" })]);
    expect(readdirSync(join(dir, ".parley", "receipts")).length).toBe(0);
    expect(doctor({ stdout, stderr }, SCHEMAS_DIR).filter((v) => v.event === "doctor.violation")).toEqual([]);
  });

  test("a throwing human renderer falls back to the default rendering and the run completes", async () => {
    const { dir, env } = scratch();
    const s = streams();
    const status = await main(tool({ human: () => { throw new Error("renderer broke"); } }), ["t", "count", "--human"], async (run) => { run.result({ event: "result", value: 2 }, { id: "t.count", version: "1.0.0" }); }, { cwd: dir, env, ...s });
    expect(status).toBe(0);
    expect(s.stdout.text).toContain("result:");
    const file = readdirSync(join(dir, ".parley", "receipts")).find((f) => f.endsWith(".jsonl"))!;
    const lines = readFileSync(join(dir, ".parley", "receipts", file), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.at(-1)).toMatchObject({ event: "end", status: 0 });
  });
});

describe("PE-16 retention and in-flight runs (F-5)", () => {
  test("retention never deletes a receipt that has not ended", async () => {
    const { dir, env } = scratch();
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const a = streams();
    const first = main(tool({ retention: { count: 1 } }), ["t", "count"], async () => { await gate; }, { cwd: dir, env, ...a });
    await new Promise((r) => setTimeout(r, 20));
    const b = streams();
    const second = await main(tool({ retention: { count: 1 } }), ["t", "count"], async () => {}, { cwd: dir, env, ...b });
    expect(second).toBe(0);
    release();
    expect(await first).toBe(0);
    const pathA = (a.stdout.objs[0] as { paths: { receipt: string } }).paths.receipt;
    expect(existsSync(pathA)).toBe(true);
    expect(check(dir, a).violations).toEqual([]);
  });

  test("retention deletes a bundle's sidecar directory with its receipt", async () => {
    const { dir, env } = scratch();
    const rows = Array.from({ length: 3000 }, (_, i) => ({ i, text: "x".repeat(30) }));
    const big = await runCount(dir, env, ["count"], (run) => { run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" }, { rows }); }, { retention: { count: 1 } });
    const sidecarDir = join(dir, ".parley", "receipts", (big.stdout.objs[0] as { run: string }).run);
    expect(existsSync(sidecarDir)).toBe(true);
    await runCount(dir, env, ["count"], () => {}, { retention: { count: 1 } });
    expect(existsSync(big.path!)).toBe(false);
    expect(existsSync(sidecarDir)).toBe(false);
  });

  test("retention re-reads a receipt's age at the decision and spares one that moved", async () => {
    // PE-16c (flyingrobots/parley#112): an incomplete receipt silent for two days whose owner
    // appends after the scan must not be judged by the scan's mtime.
    const { dir, env } = scratch();
    await runCount(dir, env, ["count"], () => {});
    const rdir = join(dir, ".parley", "receipts");
    const id = ulid(5);
    const stale = join(rdir, `${id}.jsonl`);
    writeFileSync(stale, JSON.stringify({ event: "receipt.head", t: 1, seq: 1, run: id, tool: "t", v: "0.0.1", argv: [], resolved: {}, inputs: [], _schema: { id: "parley.receipt.head", version: "2.0.0" } }) + "\n");
    const twoDays = (Date.now() - 2 * 86_400_000) / 1000;
    utimesSync(stale, twoDays, twoDays);
    await runCount(dir, env, ["count"], (run) => {
      retain(run, run.receiptDir, 1, false, Date.now(), () => {
        appendFileSync(stale, JSON.stringify({ event: "receipt.step", t: 2, seq: 2, run: id, decision: "resumed", because: "its owner woke", _schema: { id: "parley.receipt.step", version: "1.0.0" } }) + "\n");
      });
    });
    expect(existsSync(stale)).toBe(true);
  });

  // PE-16d to PE-16f (flyingrobots/parley#112): no lock. An incomplete receipt is exempt until it
  // has gone unmodified for 24 hours; a complete one has no writer left (§3.3). The decision time
  // is injected, so no test sleeps or depends on the wall clock.
  const HOUR = 3_600_000;
  function plant(rdir: string, n: number, ended: boolean, mtimeMs: number): string {
    const id = ulid(n);
    const p = join(rdir, `${id}.jsonl`);
    const head = { event: "receipt.head", t: 1, seq: 1, run: id, tool: "t", v: "0.0.1", argv: [], resolved: {}, inputs: [], _schema: { id: "parley.receipt.head", version: "2.0.0" } };
    const end = { event: "end", t: 2, seq: 2, run: id, status: 0, receipt: p, redacted: false, _schema: { id: "parley.end", version: "1.0.0" } };
    writeFileSync(p, JSON.stringify(head) + "\n" + (ended ? JSON.stringify(end) + "\n" : ""));
    utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
    return p;
  }
  // A whole second survives utimes exactly on every filesystem, so the 24-hour boundary is exact.
  const wholeSecond = (ms: number) => Math.floor(ms / 1000) * 1000;
  function retentionStep(lines: Record<string, unknown>[]) {
    return lines.find((o) => o.event === "receipt.step" && /^retention:/.test(String(o.decision ?? ""))) as { decision?: string } | undefined;
  }

  test("retention spares an incomplete receipt written within the grace period", async () => {
    const { dir, env } = scratch();
    await runCount(dir, env, ["count"], () => {});
    const rdir = join(dir, ".parley", "receipts");
    const written = wholeSecond(Date.now() - 2 * HOUR);
    const flight = plant(rdir, 5, false, written);
    const r = await runCount(dir, env, ["count"], (run) => { retain(run, run.receiptDir, 1, false, written + HOUR); });
    expect(existsSync(flight)).toBe(true);
    expect(retentionStep(r.receiptLines)?.decision).toBe("retention: deleted 1 receipt bundle(s)");
    // The first run's receipt, complete, went in the in-flight one's place.
    expect(readdirSync(rdir).filter((f) => f.endsWith(".jsonl")).length).toBe(2);
  });

  test("retention deletes a complete receipt beyond the count whatever its age", async () => {
    const { dir, env } = scratch();
    const rdir = join(dir, ".parley", "receipts");
    await runCount(dir, env, ["count"], () => {});
    const written = wholeSecond(Date.now() - 2 * HOUR);
    const done = plant(rdir, 5, true, written);
    const side = join(rdir, basename(done, ".jsonl"));
    mkdirSync(side); writeFileSync(join(side, "3.json"), "{}");
    const flight = plant(rdir, 6, false, written + 1000);
    const r = await runCount(dir, env, ["count"], (run) => { retain(run, run.receiptDir, 2, false, written + HOUR); });
    expect(existsSync(done)).toBe(false);
    expect(existsSync(side)).toBe(false);
    expect(existsSync(flight)).toBe(true);
    expect(retentionStep(r.receiptLines)?.decision).toBe("retention: deleted 2 receipt bundle(s)");
  });

  test("retention deletes an incomplete receipt once it is unmodified past the grace period", async () => {
    const { dir, env } = scratch();
    await runCount(dir, env, ["count"], () => {}, { name: "other" });
    const rdir = join(dir, ".parley", "receipts");
    const written = wholeSecond(Date.now() - 3 * 24 * HOUR);
    const crashed = plant(rdir, 5, false, written);
    const atGrace = await runCount(dir, env, ["count"], (run) => { retain(run, run.receiptDir, 1, false, written + 24 * HOUR); });
    expect(existsSync(crashed)).toBe(true);
    expect(retentionStep(atGrace.receiptLines)?.decision).toBe("retention: nothing to delete");
    const past = await runCount(dir, env, ["count"], (run) => { retain(run, run.receiptDir, 2, false, written + 24 * HOUR + 1); });
    expect(existsSync(crashed)).toBe(false);
    expect(retentionStep(past.receiptLines)?.decision).toBe("retention: deleted 1 receipt bundle(s)");
  });
});

describe("PE-17 the head is first and sinks fail gracefully (F-6, F-7, F-8)", () => {
  test("a head over the sidecar threshold is still the receipt's first line", async () => {
    const { dir, env } = scratch();
    const s = streams();
    await main(tool(), ["t", "count"], async () => {}, { cwd: dir, env, ...s, resolved: () => ({ command: "count", blob: "y".repeat(70_000) }) });
    const { receiptLines, violations } = check(dir, s);
    expect(receiptLines[0]!.event).toBe("receipt.head");
    expect(receiptLines.some((o) => o.event === "sidecar")).toBe(false);
    expect(violations).toEqual([]);
  });

  test("a stdout failure on the bootstrap write still puts the head first", async () => {
    const { dir, env } = scratch();
    const s = streams();
    s.stdout.onWrite = (l) => { if (l.includes('"event":"run"')) throw new Error("EPIPE"); };
    const status = await main(tool(), ["t", "count"], async () => {}, { cwd: dir, env, ...s });
    expect(status).toBe(4);
    const file = readdirSync(join(dir, ".parley", "receipts")).find((f) => f.endsWith(".jsonl"))!;
    const { receiptLines } = check(dir, s, join(dir, ".parley", "receipts", file));
    expect(receiptLines[0]!.event).toBe("receipt.head");
    expect(receiptLines.some((o) => o.event === "error")).toBe(true);
    expect(receiptLines.at(-1)).toMatchObject({ event: "end", status: 4 });
  });

  test("a sidecar write failure is an error line and the receipt still ends", async () => {
    const { dir, env } = scratch();
    const rows = Array.from({ length: 3000 }, (_, i) => ({ i, text: "x".repeat(30) }));
    const s = streams();
    let runId = "";
    const status = await main(tool(), ["t", "count"], async (run) => {
      runId = run.id;
      writeFileSync(join(run.receiptDir, run.id), "a file where the sidecar directory should go");
      run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" }, { rows });
    }, { cwd: dir, env, ...s });
    expect(status).toBe(4);
    expect(runId).not.toBe("");
    const { receiptLines } = check(dir, s);
    expect(receiptLines.at(-1)).toMatchObject({ event: "end", status: 4 });
    expect(receiptLines.some((o) => o.event === "error" && String(o.code).startsWith("sink."))).toBe(true);
    expect(s.stderr.objs.some((o) => o.event === "error")).toBe(true);
  });

  // flyingrobots/parley#130: the copies of one event agree on every field they share (spec §1.3),
  // so a receiptExtra key the payload also carries must hold an equal value, or the call is refused
  // before either copy is written.
  test("a receiptExtra field that contradicts the payload is refused before either copy is written", async () => {
    const { dir, env } = scratch();
    const ref = { id: "t.count", version: "1.0.0" };
    const r = await runCount(dir, env, ["count"], (run) => {
      expect(() => run.result({ event: "result", value: 1 }, ref, { value: 2 })).toThrow(TypeError);
      expect(() => run.result({ event: "result", value: 1 }, ref, { event: "other" })).toThrow(TypeError);
      expect(() => run.result({ event: "result", value: 1, at: { a: 1, b: [1, 2] } }, ref, { at: { b: [2, 1], a: 1 } })).toThrow(TypeError);
      // Equal shared values pass, key order aside, and receipt-only fields are still allowed.
      run.result({ event: "result", value: 3, at: { a: 1, b: [1, 2] } }, ref, { value: 3, at: { b: [1, 2], a: 1 }, rows: ["x"] });
    });
    expect(r.violations).toEqual([]);
    const { receiptLines } = check(dir, r);
    const results = (lines: Record<string, unknown>[]) => lines.filter((o) => o.event === "result");
    expect(results(r.stdout.objs).map((o) => o.value)).toEqual([3]);
    expect(results(receiptLines)).toHaveLength(1);
    expect(results(receiptLines)[0]).toMatchObject({ value: 3, rows: ["x"] });
    // A refused call takes no seq: the one counter has no gap.
    const seqs = receiptLines.map((o) => o.seq as number);
    expect(seqs).toEqual(seqs.map((_, i) => seqs[0]! + i));
  });

  test("envelope keys supplied by the tool are refused", async () => {
    const { dir, env } = scratch();
    const r = await runCount(dir, env, ["count"], (run) => {
      expect(() => run.result({ event: "result", value: 1, seq: 99 }, { id: "t.count", version: "1.0.0" })).toThrow(TypeError);
      expect(() => run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" }, { run: "other" })).toThrow(TypeError);
      expect(() => run.page(null, true)).toThrow(TypeError);
    });
    expect(r.violations).toEqual([]);
  });
});

describe("PE-18 console capture (F-9)", () => {
  test("every console function is captured and nothing reaches a stream", async () => {
    const { dir, env } = scratch();
    const r = await runCount(dir, env, ["count"], () => {
      console.table([{ a: 1 }]); console.dir({ b: 2 }); console.group("g"); console.count("c"); console.groupEnd(); console.assert(false, "asserted"); console.time("t"); console.timeLog("t"); console.timeEnd("t");
    });
    expect(r.stderr.lines).toEqual([]);
    for (const l of r.stdout.lines) expect(() => JSON.parse(l)).not.toThrow();
    expect(r.receipt).toContain("asserted");
    expect(r.violations).toEqual([]);
  });

  test("overlapping runs restore the original console once the last one ends", async () => {
    const original = console.log;
    const { dir, env } = scratch();
    let release2!: () => void; const gate2 = new Promise<void>((r) => { release2 = r; });
    const second = (async () => { await new Promise((r) => setTimeout(r, 10)); return main(tool(), ["t", "count"], async () => { await gate2; }, { cwd: dir, env, ...streams() }); })();
    await main(tool(), ["t", "count"], async () => { await new Promise((r) => setTimeout(r, 30)); }, { cwd: dir, env, ...streams() });
    expect(console.log).not.toBe(original);
    release2(); await second;
    expect(console.log).toBe(original);
  });
});

describe("PE-18b console capture before the handler and in a real process", () => {
  test("console output from a resolver or callback before the bootstrap line lands in the receipt", async () => {
    const { dir, env } = scratch();
    const r = await runCount(dir, env, ["count"], () => {}, { sources: { netrc: () => { console.log("resolver says hello"); return false; } } });
    expect(r.stdout.objs.every((o) => typeof o.event === "string")).toBe(true);
    expect(r.receipt).toContain("resolver says hello");
    expect(r.violations).toEqual([]);
  });

  test("in a real process, console.table and console.dir reach the receipt and not stdout", async () => {
    const { dir, env } = scratch();
    const script = join(dir, "t.ts");
    writeFileSync(script, `import { defineTool, main } from ${JSON.stringify(resolve(import.meta.dir, "../src/index.ts"))};
const tool = defineTool({ name: "t", version: "0.0.1", commands: { count: { intent: "count", effects: { reads: [], writes: [], network: false, idempotent: true }, secrets: [], emits: [{ id: "t.count", version: "1.0.0" }] } }, retention: { count: 10 } });
process.exit(await main(tool, ["t", "count"], (run) => { console.table([{ a: 1 }]); console.dir({ b: 2 }); console.assert(false, "asserted-in-process"); run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" }); }));`);
    const proc = Bun.spawn(["bun", script], { cwd: dir, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
    const [out, err, status] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(status).toBe(0);
    expect(err).toBe("");
    const lines = out.trimEnd().split("\n");
    for (const l of lines) expect(typeof JSON.parse(l)).toBe("object");
    const receipt = readFileSync((JSON.parse(lines[0]!) as { paths: { receipt: string } }).paths.receipt, "utf8");
    expect(receipt).toContain("asserted-in-process");
    expect(receipt).toContain("console.table");
  });

  test("a throwing renderer is reported once as a warning", async () => {
    const { dir, env } = scratch();
    const s = streams();
    await main(tool({ human: () => { throw new Error("renderer broke"); } }), ["t", "count", "--human"], async (run) => { run.result({ event: "result", value: 2 }, { id: "t.count", version: "1.0.0" }); run.result({ event: "result", value: 3 }, { id: "t.count", version: "1.0.0" }); }, { cwd: dir, env, ...s });
    expect(s.stderr.lines.filter((l) => l.includes("human.renderer_failed")).length).toBe(1);
  });

  test("a throw while emitting discovery is an error line and the run still ends", async () => {
    const { dir, env } = scratch();
    const s = streams();
    const circular: Record<string, unknown> = {}; circular.self = circular;
    const status = await main(tool({ commands: { count: { ...tool().commands.count!, emits: [{ id: "t.count", version: "1.0.0", schema: circular }] } } }), ["t", "--schema"], async () => {}, { cwd: dir, env, ...s });
    expect(status).toBe(2);
    expect(s.stderr.objs.some((o) => o.event === "error" && o.code === "uncaught.exception")).toBe(true);
    expect(s.stdout.objs.at(-1)).toMatchObject({ event: "end", status: 2 });
    expect(check(dir, s).violations).toEqual([]);
  });
});

describe("PE-19 inputs (F-11, F-13, F-14)", () => {
  test("a tree input skips .parley and honours exclude, and its digest follows content", async () => {
    const { dir, env } = scratch();
    mkdirSync(join(dir, "src")); writeFileSync(join(dir, "src", "a.txt"), "one"); writeFileSync(join(dir, "src", "secret.pem"), "key-1");
    const invOf = (r: { receiptLines: Record<string, unknown>[] }) => (r.receiptLines.find((o) => o.event === "receipt.inputs") as { inv?: string } | undefined)?.inv;
    const decl = [{ path: ".", role: "tree", exclude: ["src/secret.pem"] }];
    const a = await runCount(dir, env, ["count"], () => {}, {}, decl);
    const b = await runCount(dir, env, ["count"], () => {}, {}, decl);
    expect(invOf(a)).toMatch(/^[0-9a-f]{64}$/); expect(invOf(a)).toBe(invOf(b));
    writeFileSync(join(dir, "src", "secret.pem"), "key-2");
    const c = await runCount(dir, env, ["count"], () => {}, {}, decl);
    expect(invOf(c)).toBe(invOf(a));
    writeFileSync(join(dir, "src", "a.txt"), "two");
    const d = await runCount(dir, env, ["count"], () => {}, {}, decl);
    expect(invOf(d)).not.toBe(invOf(a));
  });

  test("a supplied stdin input is digested and an absolute path resolves", async () => {
    const { dir, env } = scratch();
    writeFileSync(join(dir, "abs.txt"), "absolute");
    const r = await runCount(dir, env, ["count"], (run) => { run.input("-", "from stdin"); }, {}, [{ path: "-", role: "stdin" }, { path: join(dir, "abs.txt") }]);
    const inputs = r.receiptLines.find((o) => o.event === "receipt.inputs") as { inputs: { path: string; sha256?: string; error?: string }[]; inv?: string };
    expect(inputs.inputs[0]!.sha256).toBe(createHash("sha256").update("from stdin").digest("hex"));
    expect(inputs.inputs[1]!.sha256).toBe(createHash("sha256").update("absolute").digest("hex"));
    expect(inputs.inv).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a secret in receiptExtra is replaced and recorded", async () => {
    const { dir, env } = scratch();
    const r = await runCount(dir, env, ["count", "--token", SECRET2], (run) => { run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" }, { note: "token=" + SECRET2 }); });
    expect(r.receipt.includes(SECRET2)).toBe(false);
    expect(r.receiptLines.some((o) => o.event === "redaction" && o.at === "/note")).toBe(true);
    expect(r.violations).toEqual([]);
  });
});

describe("PE-20 smaller contract gaps (F-13)", () => {
  test("an Object.prototype name is not a command", async () => {
    const { dir, env } = scratch();
    const s = streams();
    const status = await main(twoCommands(), ["t", "toString"], async () => {}, { cwd: dir, env, ...s });
    expect(status).toBe(3);
    expect(s.stderr.objs[0]).toMatchObject({ event: "startup.failed", code: "startup.unknown_command" });
  });

  test("end(0) after a reported error is refused", async () => {
    const { dir, env } = scratch();
    let threw = false;
    const r = await runCount(dir, env, ["count"], (run) => { run.error({ code: "x.y", problem: "p" }); try { run.end(0); } catch { threw = true; } });
    expect(threw).toBe(true); expect(r.status).toBe(2);
  });

  test("bookkeeping declares the state directory's retention and an empty secret is still recorded", async () => {
    const { dir, env } = scratch();
    const r = await runCount(dir, env, ["count", "--token", ""], () => {});
    const head = r.receiptLines[0] as { effects: { bookkeeping: { op: string; scope: string }[] }; redacted?: { argv?: number[] } };
    expect(head.effects.bookkeeping.some((b) => b.op === "delete" && b.scope.includes("parley") && !b.scope.includes(".parley"))).toBe(true);
    expect(head.redacted?.argv).toEqual([3]);
    const cmd = (await (async () => { const s = streams(); await main(tool(), ["t", "--schema"], async () => {}, { cwd: dir, env, ...s }); return s.stdout.objs.find((o) => o.event === "command") as { effects: { bookkeeping: { op: string; scope: string }[] } }; })());
    expect(cmd.effects.bookkeeping.filter((b) => b.op === "delete").length).toBe(2);
  });

  test("the ignore file is created whole", async () => {
    const { dir, env } = scratch();
    await runCount(dir, env, ["count"], () => {});
    expect(readFileSync(join(dir, ".parley", ".gitignore"), "utf8")).toBe("*\n");
    expect(readdirSync(join(dir, ".parley")).sort()).toEqual([".gitignore", "receipts"]);
  });
});

describe("PE-21 found by the blind pass over the repaired head", () => {
  test("a stalled pipe reader does not fail the stdout sink", async () => {
    const { dir, env } = scratch();
    const script = join(dir, "big.ts");
    writeFileSync(script, `import { defineTool, main } from ${JSON.stringify(resolve(import.meta.dir, "../src/index.ts"))};
const tool = defineTool({ name: "t", version: "0.0.1", commands: { count: { intent: "count", effects: { reads: [], writes: [], network: false, idempotent: true }, secrets: [], emits: [{ id: "t.count", version: "1.0.0" }] } }, retention: { count: 10 } });
process.exit(await main(tool, ["t", "count"], (run) => { console.log("touch console so the runtime may flip fd 1"); for (let i = 0; i < 60; i++) run.result({ event: "result", value: i, pad: "x".repeat(5000) }, { id: "t.count", version: "1.0.0" }); }));`);
    // A shell pipe whose reader sleeps first: the 64 KiB pipe buffer fills while the writer is still writing.
    const proc = Bun.spawn(["bash", "-c", `bun ${JSON.stringify(script)} 2>${JSON.stringify(join(dir, "err.txt"))} | (sleep 1.5; cat); exit \${PIPESTATUS[0]}`], { cwd: dir, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
    const [out, status] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(readFileSync(join(dir, "err.txt"), "utf8")).toBe("");
    expect(status).toBe(0);
    const lines = out.trimEnd().split("\n");
    expect(lines.length).toBe(62);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ event: "end", status: 0 });
  });

  test("a secret parsed to a number or used as a key is still redacted and stays out of inv", async () => {
    const { dir, env } = scratch();
    const run1 = streams(), run2 = streams();
    const resolved = (args: string[]) => ({ command: "count", pin: Number(args[1]), [args[1]!]: true });
    await main(tool(), ["t", "count", "--token", "4321"], async (run) => { run.step("checked", "because", { 4321: "key", n: 4321 }); }, { cwd: dir, env, ...run1, resolved });
    await main(tool(), ["t", "count", "--token", "9999"], async () => {}, { cwd: dir, env, ...run2, resolved });
    const r1 = check(dir, run1), r2 = check(dir, run2);
    const head = r1.receiptLines[0] as { resolved: Record<string, unknown>; inv: string; redacted: { resolved: string[] } };
    expect(head.resolved.pin).toBe("[redacted]");
    expect(head.resolved["[redacted]"]).toBe(true);
    expect(head.redacted.resolved.sort()).toEqual(["/[redacted]", "/pin"]);
    expect(head.inv).toBe((r2.receiptLines[0] as { inv: string }).inv);
    expect(r1.receipt.includes("4321")).toBe(false);
    expect(r1.violations).toEqual([]);
  });

  test("a secret that contains another secret leaves no tail behind", async () => {
    const { dir, env } = scratch();
    const r = await runCount(dir, { ...env, T_TOKEN: "abcdef" }, ["count", "--token", "abc"], (run) => { run.step("s", "b", { a: "abcdef", b: "abc", c: "xabcdefx" }); });
    const step = r.receiptLines.find((o) => o.event === "receipt.step") as { detail: Record<string, string> };
    expect(step.detail).toEqual({ a: "[redacted]", b: "[redacted]", c: "x[redacted]x" });
    // The tail a shorter-secret-first scrub would leave is "[redacted]def". The receipt also holds
    // lowercase hex (the state directory's hashed path, digests), where "def" turns up by chance in
    // about one run in sixty, so the check is for the secret and for the tail itself.
    expect(r.receipt.includes("abcdef")).toBe(false);
    expect(r.receipt.includes("[redacted]def")).toBe(false);
  });

  test("a secret inside the session is a startup failure; one inside the public tool version is not", async () => {
    const { dir, env } = scratch();
    const s = streams();
    const status = await main(tool(), ["t", "count", "--token", "s3s"], async () => {}, { cwd: dir, env, ...s, session: "ses_s3s_1" });
    expect(status).toBe(3);
    expect(s.stderr.objs).toEqual([expect.objectContaining({ event: "startup.failed", code: "startup.secret_in_identity" })]);
    expect(s.stderr.text.includes("s3s")).toBe(false);
    const v = streams();
    expect(await main(tool(), ["t", "count", "--token", "0.0.1"], async () => {}, { cwd: dir, env, ...v })).toBe(0);
    expect(v.stdout.objs[0]!.v).toBe("0.0.1");
    expect(check(dir, v).receiptLines[0]!.event).toBe("receipt.head");
  });

  test("discovery lines are writer-built: a secret equal to a command name or schema version does not corrupt them", async () => {
    const { dir, env } = scratch();
    for (const secret of ["count", "1.0.0"]) {
      const s = streams();
      const status = await main(tool(), ["t", "--schema", "--token", secret], async () => {}, { cwd: dir, env, ...s });
      expect(status).toBe(0);
      const cmd = s.stdout.objs.find((o) => o.event === "command") as { name: string; emits: { id: string; version: string }[] };
      expect(cmd.name).toBe("count");
      expect(cmd.emits[0]).toEqual({ id: "t.count", version: "1.0.0" });
      expect(check(dir, s).violations).toEqual([]);
    }
  });

  test("a secret equal to false or a small number leaves the writer's own scalars alone", async () => {
    const { dir, env } = scratch();
    const s = streams();
    const status = await main(tool(), ["t", "count", "--token", "false", "--dry-run"], async (run) => { run.step("s", "b", { flag: false, n: 4729 }); }, { cwd: dir, env: { ...env, T_TOKEN: "4729" }, ...s });
    expect(status).toBe(0);
    expect(s.stdout.objs[0]!.dry_run).toBe(true);
    const { receiptLines, violations } = check(dir, s);
    expect(receiptLines[0]!.event).toBe("receipt.head");
    expect((receiptLines[0] as { effects: { network: boolean } }).effects.network).toBe(false);
    expect(s.stdout.objs.at(-1)).toMatchObject({ event: "end", status: 0, redacted: true });
    const step = receiptLines.find((o) => o.event === "receipt.step") as { detail: Record<string, unknown> };
    expect(step.detail).toEqual({ flag: "[redacted]", n: "[redacted]" });
    expect(violations).toEqual([]);
  });

  test("when a sidecar cannot be written the record is kept inline and the bundle is complete", async () => {
    const { dir, env } = scratch();
    const rows = Array.from({ length: 3000 }, (_, i) => ({ i, text: "x".repeat(30) }));
    const s = streams();
    const status = await main(tool(), ["t", "count"], async (run) => {
      writeFileSync(join(run.receiptDir, run.id), "a file where the sidecar directory should go");
      run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" }, { rows });
    }, { cwd: dir, env, ...s });
    expect(status).toBe(4);
    const { receiptLines, violations } = check(dir, s);
    expect((receiptLines.find((o) => o.event === "result") as { rows: unknown[] }).rows.length).toBe(3000);
    expect(violations).toEqual([]);
  });

  test("a startup failure's problem never carries the secret", async () => {
    const { dir, env } = scratch();
    const s = streams();
    const status = await main(tool(), ["t", "count", "--token", SECRET2], async () => {}, { cwd: dir, env, ...s, resolved: () => { throw new Error("bad value " + SECRET2); } });
    expect(status).toBe(3);
    expect(s.stderr.objs[0]!.code).toBe("startup.arguments_invalid");
    expect(s.stderr.text.includes(SECRET2)).toBe(false);
    expect(String(s.stderr.objs[0]!.problem)).toContain("[redacted]");
  });
});

// ---- PE-22: the shared history stream (spec §8, informative) -----------------------------
// The sink is opt-in, receives the receipt's bytes and nothing else, appends whole lines, keeps
// daily segments by age, and never changes a run that has no stream configured.

const DAY_MS = 86_400_000;
const segmentFor = (t: number) => `${new Date(t).toISOString().slice(0, 10)}.jsonl`;

function historyScratch() {
  const s = scratch();
  return { ...s, hist: mkdtempSync(join(tmpdir(), "parley-history-")) };
}

function segmentPath(hist: string): string {
  const names = readdirSync(hist).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  expect(names.length).toBe(1);
  return join(hist, names[0]!);
}

function segmentText(hist: string): string { return readFileSync(segmentPath(hist), "utf8"); }
function segmentObjs(hist: string): Record<string, unknown>[] {
  return segmentText(hist).trimEnd().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}
const bookkeepingOf = (head: Record<string, unknown>) => (head.effects as { bookkeeping: { op: string; scope: string }[] }).bookkeeping;
const pathsOf = (boot: Record<string, unknown>) => boot.paths as Record<string, string> & { receipt: string };

describe("PE-22 the shared history stream", () => {
  test("a run with no stream configured is untouched", async () => {
    const { dir, env } = scratch();
    const r = await runCount(dir, env, ["count"], (run) => { run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" }); });
    expect(r.violations).toEqual([]);
    expect(r.status).toBe(0);
    expect(pathsOf(r.stdout.objs[0]!)).toEqual({ receipt: r.path! });
    expect(bookkeepingOf(r.receiptLines[0]!).some((b) => b.scope.includes("history"))).toBe(false);
    expect(bookkeepingOf(r.receiptLines[0]!).length).toBe(5);
    expect(r.stderr.lines).toEqual([]);
    expect(existsSync(join(env.XDG_STATE_HOME!, "parley", "history"))).toBe(false);
  });

  test("the stream receives the receipt's bytes exactly", async () => {
    const { dir, env, hist } = historyScratch();
    const r = await runCount(dir, { ...env, PARLEY_HISTORY: hist }, ["count"], (run) => {
      run.step("counted the things", "the stream carries reasoning as well as results");
      run.warning({ code: "input.encoding_guessed", problem: "no charset declared", remedy: "declare it" });
      run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" });
    });
    expect(r.violations).toEqual([]);
    const seg = segmentPath(hist);
    expect(seg).toBe(join(hist, segmentFor(Date.now())));
    expect(pathsOf(r.stdout.objs[0]!).history).toBe(seg);
    expect(readFileSync(seg, "utf8")).toBe(r.receipt);
    expect(segmentObjs(hist).every((o) => o.run === r.stdout.objs[0]!.run)).toBe(true);
    expect(bookkeepingOf(r.receiptLines[0]!)).toContainEqual({ op: "append", scope: seg });
    expect(bookkeepingOf(r.receiptLines[0]!)).toContainEqual({ op: "delete", scope: `${hist}/` });
    expect(statSync(seg).mode & 0o777).toBe(0o600);
  });

  test("an existing state directory enables the stream and a created one is owner-only", async () => {
    const { dir, env } = scratch();
    const hist = join(env.XDG_STATE_HOME!, "parley", "history");
    mkdirSync(hist, { recursive: true });
    const r = await runCount(dir, env, ["count"], (run) => { run.result({ event: "result", value: 2 }, { id: "t.count", version: "1.0.0" }); });
    expect(r.violations).toEqual([]);
    expect(segmentText(hist)).toBe(r.receipt);

    const made = join(env.XDG_STATE_HOME!, "elsewhere", "history");
    const r2 = await runCount(dir, { ...env, PARLEY_HISTORY: made }, ["count"], () => {});
    expect(r2.violations).toEqual([]);
    expect(statSync(made).mode & 0o777).toBe(0o700);
  });

  test("the stream can be switched off explicitly", async () => {
    const { dir, env } = scratch();
    const hist = join(env.XDG_STATE_HOME!, "parley", "history");
    mkdirSync(hist, { recursive: true });
    const r = await runCount(dir, { ...env, PARLEY_HISTORY: "off" }, ["count"], () => {});
    expect(r.violations).toEqual([]);
    expect(readdirSync(hist)).toEqual([]);
    expect(pathsOf(r.stdout.objs[0]!).history).toBeUndefined();
    expect(bookkeepingOf(r.receiptLines[0]!).length).toBe(5);
  });

  test("two tools in two repositories share one timeline ordered by t", async () => {
    const a = scratch(), b = scratch();
    const hist = mkdtempSync(join(tmpdir(), "parley-history-"));
    const runOne = async (name: string, s: { dir: string; env: Record<string, string> }, session: string) => {
      const cap = streams();
      const status = await main(tool({ name }), [name, "count"], async (run) => {
        run.step(`${name} worked here`, "two tools, two repositories, one timeline");
        run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" });
      }, { cwd: s.dir, env: { ...s.env, PARLEY_HISTORY: hist, PARLEY_SESSION: session }, ...cap, resolved: (args) => ({ command: "count", args }) });
      expect(status).toBe(0);
      const checked = check(s.dir, cap);
      expect(checked.violations).toEqual([]);
      return { id: cap.stdout.objs[0]!.run as string, receipt: checked.receipt };
    };
    const one = await runOne("alpha", a, "ses_one");
    const two = await runOne("beta", b, "ses_two");

    const lines = segmentObjs(hist);
    expect(lines.every((l) => typeof l.run === "string" && l.run !== "")).toBe(true);
    expect(new Set(lines.map((l) => l.run))).toEqual(new Set([one.id, two.id]));
    const heads = lines.filter((l) => l.event === "receipt.head");
    expect(heads.map((h) => h.tool).sort()).toEqual(["alpha", "beta"]);
    expect(heads.map((h) => h.session).sort()).toEqual(["ses_one", "ses_two"]);
    expect(heads.find((h) => h.tool === "alpha")!.run).toBe(one.id);
    expect(bookkeepingOf(heads.find((h) => h.tool === "alpha")!).some((bk) => bk.scope.startsWith(a.dir))).toBe(true);
    expect(bookkeepingOf(heads.find((h) => h.tool === "beta")!).some((bk) => bk.scope.startsWith(b.dir))).toBe(true);

    // One timeline: ordering the whole stream by (t, seq) keeps every run's own order intact,
    // and each run's slice is exactly its receipt.
    const sorted = [...lines].sort((x, y) => (x.t as number) - (y.t as number) || (x.seq as number) - (y.seq as number));
    for (const { id, receipt } of [one, two]) {
      const mine = sorted.filter((l) => l.run === id);
      expect(mine.map((l) => l.seq as number)).toEqual([...mine.map((l) => l.seq as number)].sort((p, q) => p - q));
      expect(mine[0]!.event).toBe("receipt.head");
      expect(mine.at(-1)!.event).toBe("end");
      expect(mine.map((l) => JSON.stringify(l)).join("\n") + "\n").toBe(receipt);
    }
    expect(lines.length).toBe(sorted.length);
  });

  test("an unreachable stream is a warning, not a failure", async () => {
    const { dir, env } = scratch();
    const blocked = join(dir, "blocked");
    mkdirSync(blocked); chmodSync(blocked, 0o500);
    try {
      const r = await runCount(dir, { ...env, PARLEY_HISTORY: join(blocked, "history") }, ["count"], (run) => { run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" }); });
      expect(r.status).toBe(0);
      expect(r.violations).toEqual([]);
      expect(r.stderr.objs.filter((o) => o.event === "warning" && o.code === "history.unavailable").length).toBe(1);
      expect(pathsOf(r.stdout.objs[0]!).history).toBeUndefined();
      expect(bookkeepingOf(r.receiptLines[0]!).length).toBe(5);
    } finally { chmodSync(blocked, 0o700); }

    const rel = await runCount(dir, { ...env, PARLEY_HISTORY: "history" }, ["count"], () => {});
    expect(rel.status).toBe(0);
    expect(rel.violations).toEqual([]);
    expect(rel.stderr.objs.filter((o) => o.event === "warning" && o.code === "history.unavailable").length).toBe(1);
    expect(existsSync(join(dir, "history"))).toBe(false);
  });

  test("a stream that fails mid-run is one warning and leaves the status alone", async () => {
    const { dir, env } = scratch();
    const s = streams();
    let appends = 0;
    const sink = { dir: "/nonexistent", path: "/nonexistent/today.jsonl", append() { appends += 1; throw new Error("ENOSPC: no space left on device"); }, close() {} };
    const status = await main(tool(), ["t", "count"], async (run) => {
      run.step("one", "a");
      run.step("two", "b");
      run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" });
    }, { cwd: dir, env, ...s, history: sink, resolved: (args) => ({ command: "count", args }) });
    expect(status).toBe(0);
    expect(appends).toBe(1);
    const r = check(dir, s);
    expect(r.violations).toEqual([]);
    expect(s.stderr.objs.filter((o) => o.event === "warning" && o.code === "history.write_failed").length).toBe(1);
    expect(r.receiptLines.filter((o) => o.event === "warning" && o.code === "history.write_failed").length).toBe(1);
    expect(r.receiptLines.at(-1)).toMatchObject({ event: "end", status: 0 });
  });

  test("a short append is abandoned rather than continued", () => {
    const file = join(mkdtempSync(join(tmpdir(), "parley-history-")), "seg.jsonl");
    const fd = openSync(file, "a", 0o600);
    try {
      expect(() => writeWholeLine(fd, '{"a":1}\n', () => 3)).toThrow(/truncated/);
      expect(writeWholeLine(fd, '{"a":1}\n')).toBe(8);
      expect(readFileSync(file, "utf8")).toBe('{"a":1}\n');
    } finally { closeSync(fd); }
  });

  test("stream retention keeps the configured number of daily segments and never the live one", async () => {
    const { dir, env, hist } = historyScratch();
    const stale = [segmentFor(Date.now() - 2 * DAY_MS), segmentFor(Date.now() - 400 * DAY_MS)];
    const keep = [segmentFor(Date.now() - DAY_MS)];
    for (const name of [...stale, ...keep]) writeFileSync(join(hist, name), "{}\n");
    writeFileSync(join(hist, "notes.txt"), "not a segment");
    const r = await runCount(dir, { ...env, PARLEY_HISTORY: hist, PARLEY_HISTORY_DAYS: "2" }, ["count"], () => {});
    expect(r.violations).toEqual([]);
    expect(readdirSync(hist).sort()).toEqual([segmentFor(Date.now()), ...keep, "notes.txt"].sort());
    const step = r.receiptLines.find((o) => o.event === "receipt.step" && String(o.decision).startsWith("history retention")) as { decision: string; detail: { segments: string[] } };
    expect(step.detail.segments.sort()).toEqual(stale.sort());

    const dry = historyScratch();
    for (const name of stale) writeFileSync(join(dry.hist, name), "{}\n");
    const d = await runCount(dry.dir, { ...dry.env, PARLEY_HISTORY: dry.hist, PARLEY_HISTORY_DAYS: "2" }, ["count", "--dry-run"], () => {});
    expect(d.violations).toEqual([]);
    expect(readdirSync(dry.hist).filter((f) => stale.includes(f)).sort()).toEqual(stale.sort());
    expect(d.receiptLines.some((o) => o.event === "receipt.step" && String(o.decision).startsWith("history retention: would delete"))).toBe(true);
  });

  test("concurrent appends from separate processes never tear a line", async () => {
    const { dir, env, hist } = historyScratch();
    const script = join(dir, "h.ts");
    writeFileSync(script, `import { defineTool, main } from ${JSON.stringify(resolve(import.meta.dir, "../src/index.ts"))};
const tool = defineTool({ name: "t" + process.argv[2], version: "0.0.1", commands: { count: { intent: "count", effects: { reads: [], writes: [], network: false, idempotent: true }, secrets: [], emits: [{ id: "t.count", version: "1.0.0" }] } }, retention: { count: 100 } });
process.exit(await main(tool, ["t", "count"], (run) => {
  for (let i = 0; i < 60; i++) run.step("step " + i, "hammering the shared stream", { pad: "z".repeat(900) });
  run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" });
}));`);
    const procs = Array.from({ length: 8 }, (_, i) => Bun.spawn(["bun", script, String(i)], { cwd: dir, env: { ...process.env, ...env, PARLEY_HISTORY: hist }, stdout: "pipe", stderr: "pipe" }));
    const results = await Promise.all(procs.map(async (p) => {
      const [out, err, status] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { out, err, status };
    }));
    for (const { err, status } of results) { expect(err).toBe(""); expect(status).toBe(0); }

    const raw = segmentText(hist);
    expect(raw.endsWith("\n")).toBe(true);
    const objs = raw.slice(0, -1).split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(objs.every((o) => typeof o.run === "string" && o.run !== "")).toBe(true);
    const byRun = new Map<string, Record<string, unknown>[]>();
    for (const o of objs) byRun.set(o.run as string, [...(byRun.get(o.run as string) ?? []), o]);
    expect(byRun.size).toBe(8);
    let total = 0;
    for (const { out } of results) {
      const boot = JSON.parse(out.split("\n")[0]!) as Record<string, unknown>;
      const receipt = readFileSync(pathsOf(boot).receipt, "utf8");
      const mine = byRun.get(boot.run as string)!;
      expect(mine.map((l) => JSON.stringify(l)).join("\n") + "\n").toBe(receipt);
      total += mine.length;
    }
    expect(total).toBe(objs.length);
  });

  test("a large record reaches the stream as its receipt line", async () => {
    const { dir, env, hist } = historyScratch();
    const rows = Array.from({ length: 3000 }, (_, i) => ({ i, text: "x".repeat(30) }));
    const s = streams();
    const status = await main(tool(), ["t", "count"], async (run) => {
      run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" }, { rows });
    }, { cwd: dir, env: { ...env, PARLEY_HISTORY: hist }, ...s, resolved: () => ({ command: "count", pad: "y".repeat(70_000) }) });
    expect(status).toBe(0);
    const r = check(dir, s);
    expect(r.violations).toEqual([]);
    expect(segmentText(hist)).toBe(r.receipt);
    const objs = segmentObjs(hist);
    expect(objs[0]!.event).toBe("receipt.head");
    expect(Buffer.byteLength(JSON.stringify(objs[0]), "utf8")).toBeGreaterThan(65_536);
    expect(objs.some((o) => o.event === "sidecar")).toBe(true);
    expect(segmentText(hist).includes('"rows"')).toBe(false);
  });

  test("the stream carries the receipt's redaction and nothing more", async () => {
    const { dir, env, hist } = historyScratch();
    const s = streams();
    const status = await main(tool(), ["t", "count", "--token", SECRET2], async (run) => {
      run.step("used the token", "the value must not reach the stream", { url: `https://x.invalid/?k=${SECRET2}` });
      run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" });
    }, { cwd: dir, env: { ...env, PARLEY_HISTORY: hist }, ...s, resolved: (args) => ({ command: "count", args }) });
    expect(status).toBe(0);
    const r = check(dir, s);
    expect(r.violations).toEqual([]);
    const text = segmentText(hist);
    expect(text).toBe(r.receipt);
    expect(text.includes(SECRET2)).toBe(false);
    expect(text).toContain("[redacted]");
    expect(segmentObjs(hist).some((o) => o.event === "redaction")).toBe(true);
  });
});

describe("PE-22 a secret the stream's path or field name would carry", () => {
  test("a secret in the stream's path means no stream, and the head is still the receipt's first line", async () => {
    const { dir, env } = scratch();
    const hist = mkdtempSync(join(tmpdir(), "parley-history-"));
    const secret = hist.split("/").pop()!.slice(-4);
    const s = streams();
    const status = await main(tool(), ["t", "count", "--token", secret], async (run) => {
      run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" });
    }, { cwd: dir, env: { ...env, PARLEY_HISTORY: hist }, ...s, resolved: () => ({ command: "count" }) });
    expect(status).toBe(0);
    const r = check(dir, s);
    expect(r.violations).toEqual([]);
    expect(r.receiptLines[0]!.event).toBe("receipt.head");
    expect(pathsOf(s.stdout.objs[0]!)).toEqual({ receipt: r.path! });
    expect(s.stdout.text.includes(secret)).toBe(false);
    expect(s.stderr.objs.filter((o) => o.event === "warning" && o.code === "history.unavailable").length).toBe(1);
    expect(s.stderr.text.includes(secret)).toBe(false);
    expect(readdirSync(hist)).toEqual([]);
  });

  test("a secret that would rename the paths field means no stream", async () => {
    const { dir, env } = scratch();
    const hist = mkdtempSync(join(tmpdir(), "parley-h-"));
    const s = streams();
    const status = await main(tool(), ["t", "count", "--token", "hist"], async () => {}, { cwd: dir, env: { ...env, PARLEY_HISTORY: hist }, ...s, resolved: () => ({ command: "count" }) });
    expect(status).toBe(0);
    const r = check(dir, s);
    expect(r.violations).toEqual([]);
    expect(r.receiptLines[0]!.event).toBe("receipt.head");
    expect(Object.keys(pathsOf(s.stdout.objs[0]!))).toEqual(["receipt"]);
    expect(s.stderr.objs.filter((o) => o.event === "warning" && o.code === "history.unavailable").length).toBe(1);
  });
});

describe("PE-22 the retention window", () => {
  test("an unusable PARLEY_HISTORY_DAYS falls back to the default rather than failing the run", async () => {
    for (const raw of ["0", "-3", "2.5", "many", "", "1e400", String(Number.MAX_SAFE_INTEGER)]) {
      expect(historyDays({ PARLEY_HISTORY_DAYS: raw })).toBe(HISTORY_DEFAULT_DAYS);
    }
    expect(historyDays({})).toBe(HISTORY_DEFAULT_DAYS);
    expect(historyDays({ PARLEY_HISTORY_DAYS: " 3 " })).toBe(3);
    expect(historyDays({ PARLEY_HISTORY_DAYS: String(HISTORY_MAX_DAYS) })).toBe(HISTORY_MAX_DAYS);

    // A window so wide that its own start date is not a date would throw where nothing catches
    // it. The run completes, and the default window is applied: five days old survives, four
    // hundred does not.
    const { dir, env, hist } = historyScratch();
    const recent = segmentFor(Date.now() - 5 * DAY_MS);
    const ancient = segmentFor(Date.now() - 400 * DAY_MS);
    writeFileSync(join(hist, recent), "{}\n");
    writeFileSync(join(hist, ancient), "{}\n");
    const r = await runCount(dir, { ...env, PARLEY_HISTORY: hist, PARLEY_HISTORY_DAYS: String(Number.MAX_SAFE_INTEGER) }, ["count"], () => {});
    expect(r.status).toBe(0);
    expect(r.violations).toEqual([]);
    expect(readdirSync(hist).sort()).toEqual([recent, segmentFor(Date.now())].sort());
  });
});

// ---- PE-23: the history sink's user-defined transform (flyingrobots/parley#57) -------------
// The transform is the stream's own aperture: it narrows the stream copy and never the receipt.
// The writer enforces the contract around it, so nothing it does can put an invalid line or a
// changed envelope on the shared timeline, and a run without one is unchanged in every byte.

const TRANSFORM_PAIR = { id: "parley.history.transform", version: "1.0.0" } as const;
const draftOf = (id: string) => JSON.parse(readFileSync(join(SCHEMAS_DIR, `${id}.schema.json`), "utf8")) as object;
const digestOfSource = (fn: HistoryTransform) => createHash("sha256").update(fn.toString()).digest("hex");
const warningsOf = (r: { stderr: Capture }, code: string) => r.stderr.objs.filter((o) => o.event === "warning" && o.code === code);
/** The stream copy's lines after the opening transform line. */
const projectedLines = (hist: string) => segmentText(hist).trimEnd().split("\n").slice(1);

async function projected(transform: HistoryTransform, body: (run: Run) => void, opts: { argv?: string[]; name?: string; over?: Partial<ToolSpec> } = {}) {
  const { dir, env, hist } = historyScratch();
  const r = await runCount(dir, { ...env, PARLEY_HISTORY: hist }, opts.argv ?? ["count"], body, opts.over ?? {}, [], { history: { transform, ...(opts.name ? { name: opts.name } : {}) } });
  return { ...r, hist, objs: segmentObjs(hist), text: segmentText(hist) };
}

describe("PE-23 the history sink's transform", () => {
  test("a transform projects the stream copy and never the receipt", async () => {
    const dropDetail: HistoryTransform = (rec) => { if (rec.decision !== "counted the things") return rec; const { detail: _d, ...rest } = rec; return rest; };
    const r = await projected(dropDetail, (run) => {
      run.step("counted the things", "the stream need not carry the rows", { names: ["a.txt", "b.txt"] });
      run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" });
    });
    expect(r.violations).toEqual([]);
    expect(r.status).toBe(0);
    expect(r.stderr.lines).toEqual([]);
    const recStep = r.receiptLines.find((o) => o.event === "receipt.step" && o.decision === "counted the things")!;
    const streamStep = r.objs.find((o) => o.event === "receipt.step" && o.decision === "counted the things")!;
    expect(recStep.detail).toEqual({ names: ["a.txt", "b.txt"] });
    expect("detail" in streamStep).toBe(false);
    for (const k of ["event", "t", "seq", "run", "_schema"]) expect(streamStep[k]).toEqual(recStep[k]);
  });

  test("the envelope is reattached after the transform", async () => {
    const forge: HistoryTransform = (rec) => ({ ...rec, event: "forged", t: 0, seq: 999, run: "FORGED", _schema: { id: "forged", version: "9.9.9" }, extra: 1 });
    const r = await projected(forge, (run) => { run.result({ event: "result", value: 2 }, { id: "t.count", version: "1.0.0" }); });
    expect(r.violations).toEqual([]);
    expect(warningsOf(r, "history.transform_invalid")).toEqual([]);
    const head = r.receiptLines[0]!;
    const streamHead = r.objs.find((o) => o.event === "receipt.head")!;
    for (const k of ["event", "t", "seq", "run", "_schema"]) expect(streamHead[k]).toEqual(head[k]);
    expect(streamHead.extra).toBe(1);
    expect(r.objs.every((o) => o.run === head.run || o.event === "history.transform")).toBe(true);
    expect(r.objs.some((o) => o.event === "forged")).toBe(false);

    // The same, in place: a transform that mutates the record it was handed and returns it must
    // not hand back its own envelope, so the envelope is taken before it runs.
    const mutate: HistoryTransform = (rec) => {
      rec.event = "forged"; rec.t = 0; rec.seq = 999; rec.run = "FORGED";
      (rec._schema as Record<string, unknown>).version = "9.9.9";
      delete rec._schema; rec.extra = 2;
      return rec;
    };
    const m = await projected(mutate, (run) => { run.result({ event: "result", value: 3 }, { id: "t.count", version: "1.0.0" }); });
    expect(warningsOf(m, "history.transform_invalid")).toEqual([]);
    expect(warningsOf(m, "history.transform_uncheckable")).toEqual([]);
    const mHead = m.receiptLines[0]!;
    const mStreamHead = m.objs.find((o) => o.seq === mHead.seq)!;
    for (const k of ["event", "t", "seq", "run", "_schema"]) expect(mStreamHead[k]).toEqual(mHead[k]);
    expect(mStreamHead.extra).toBe(2);
    expect(m.objs.some((o) => o.run === "FORGED")).toBe(false);
  });

  test("an invalid body is withheld and warned by seq", async () => {
    const strip: HistoryTransform = (rec) => { if (rec.decision !== "counted the things") return rec; const { because: _b, ...rest } = rec; return rest; };
    const r = await projected(strip, (run) => {
      run.step("counted the things", "a step without a reason is not a step");
      run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" });
    });
    expect(r.violations).toEqual([]);
    expect(r.status).toBe(0);
    const stepSeq = r.receiptLines.find((o) => o.decision === "counted the things")!.seq as number;
    const warns = warningsOf(r, "history.transform_invalid");
    expect(warns.length).toBe(1);
    expect(String(warns[0]!.problem)).toContain(`seq ${stepSeq}`);
    expect(r.receiptLines.some((o) => o.event === "warning" && o.code === "history.transform_invalid")).toBe(true);
    expect(r.objs.some((o) => o.event === "receipt.step" && o.seq === stepSeq)).toBe(false);
    expect(r.objs.some((o) => o.event === "result")).toBe(true);
  });

  test("a throwing transform withholds the line and leaves the status alone", async () => {
    const boom: HistoryTransform = (rec) => { if (rec.decision === "counted the things") throw new Error("the projection blew up"); return rec; };
    const r = await projected(boom, (run) => {
      run.step("counted the things", "a transform that throws withholds and warns");
      run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" });
    });
    expect(r.violations).toEqual([]);
    expect(r.status).toBe(0);
    const stepSeq = r.receiptLines.find((o) => o.decision === "counted the things")!.seq as number;
    const warns = warningsOf(r, "history.transform_failed");
    expect(warns.length).toBe(1);
    expect(String(warns[0]!.problem)).toContain(`seq ${stepSeq}`);
    expect(String(warns[0]!.problem)).toContain("the projection blew up");
    expect(r.objs.some((o) => o.seq === stepSeq)).toBe(false);
    expect(r.objs.at(-1)!.event).toBe("end");
  });

  test("an identity transform changes nothing but the opening line", async () => {
    const identity: HistoryTransform = (rec) => rec;
    const r = await projected(identity, (run) => {
      run.step("counted the things", "the identity projection is still a projection");
      run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" });
    });
    expect(r.violations).toEqual([]);
    expect(r.stderr.lines).toEqual([]);
    expect(projectedLines(r.hist).join("\n") + "\n").toBe(r.receipt);
    expect(r.objs[0]!.event).toBe("history.transform");
  });

  test("a transform that withholds everything leaves the opening line alone", async () => {
    const nothing: HistoryTransform = () => undefined;
    const r = await projected(nothing, (run) => { run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" }); });
    expect(r.violations).toEqual([]);
    expect(r.status).toBe(0);
    expect(r.stderr.lines).toEqual([]);
    expect(r.objs.length).toBe(1);
    expect(r.objs[0]!.event).toBe("history.transform");
  });

  test("the stream copy opens with the transform line and the receipt explains the gap", async () => {
    const dropNothing: HistoryTransform = (rec) => rec;
    const r = await projected(dropNothing, (run) => { run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" }); }, { name: "drop-nothing" });
    const open = r.objs[0]!;
    expect(open.event).toBe("history.transform");
    expect(open._schema).toEqual(TRANSFORM_PAIR);
    expect(open.name).toBe("drop-nothing");
    expect(open.sha256).toBe(digestOfSource(dropNothing));
    expect(open.run).toBe(r.receiptLines[0]!.run);
    const ajv = new Ajv2020({ strict: false, allErrors: true }); addFormats(ajv);
    const validate = ajv.compile(draftOf("parley.history.transform"));
    expect(validate(open), JSON.stringify(validate.errors)).toBe(true);
    // The receipt never carries the line, and the seq it takes is accounted for there.
    expect(r.receiptLines.some((o) => o.event === "history.transform")).toBe(false);
    expect(r.receiptLines.some((o) => o.seq === open.seq)).toBe(false);
    const step = r.receiptLines.find((o) => o.event === "receipt.step" && String(o.decision).includes("projection"))!;
    expect(step).toBeDefined();
    expect(String(step.because)).toContain(String(open.sha256));
    expect(String(step.because)).toContain(`seq ${String(open.seq)}`);
    expect(r.violations).toEqual([]);
  });

  test("a run with no transform is the run that existed before the transform did", async () => {
    const { dir, env, hist } = historyScratch();
    const r = await runCount(dir, { ...env, PARLEY_HISTORY: hist }, ["count"], (run) => {
      run.step("counted the things", "no transform, no projection");
      run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" });
    });
    expect(r.violations).toEqual([]);
    expect(segmentText(hist)).toBe(r.receipt);
    expect(segmentObjs(hist).some((o) => o.event === "history.transform")).toBe(false);
    expect(r.receiptLines.some((o) => o.event === "receipt.step" && String(o.decision).includes("projection"))).toBe(false);
    expect(r.stderr.lines).toEqual([]);
  });

  test("a transform with no stream configured changes nothing", async () => {
    const { dir, env } = scratch();
    const seen: string[] = [];
    const spy: HistoryTransform = (rec) => { seen.push(String(rec.event)); return rec; };
    const r = await runCount(dir, env, ["count"], (run) => { run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" }); }, {}, [], { history: { transform: spy } });
    expect(r.violations).toEqual([]);
    expect(seen).toEqual([]);
    expect(r.stderr.lines).toEqual([]);
    expect(r.receiptLines.map((o) => o.event)).toEqual(["receipt.head", "result", "end"]);
    expect((r.stdout.objs[0]!.paths as Record<string, string>).history).toBeUndefined();
  });

  test("a tool-owned type is re-validated against the schema the tool declared", async () => {
    const negative: HistoryTransform = (rec) => (rec.event === "result" ? { ...rec, value: -1 } : rec);
    const bad = await projected(negative, (run) => { run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" }); });
    const resultSeq = bad.receiptLines.find((o) => o.event === "result")!.seq as number;
    expect(warningsOf(bad, "history.transform_invalid").length).toBe(1);
    expect(String(warningsOf(bad, "history.transform_invalid")[0]!.problem)).toContain("t.count@1.0.0");
    expect(bad.objs.some((o) => o.seq === resultSeq)).toBe(false);

    const bigger: HistoryTransform = (rec) => (rec.event === "result" ? { ...rec, value: 7 } : rec);
    const ok = await projected(bigger, (run) => { run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" }); });
    expect(warningsOf(ok, "history.transform_invalid")).toEqual([]);
    expect(ok.objs.find((o) => o.event === "result")!.value).toBe(7);
    expect(ok.receiptLines.find((o) => o.event === "result")!.value).toBe(1);
  });

  test("a line the writer cannot re-validate is withheld rather than projected", async () => {
    const identity: HistoryTransform = (rec) => rec;
    const r = await projected(identity, (run) => { run.result({ event: "result", value: 1 }, { id: "t.undeclared", version: "3.1.4" }); });
    const resultSeq = r.receiptLines.find((o) => o.event === "result")!.seq as number;
    const warns = warningsOf(r, "history.transform_uncheckable");
    expect(warns.length).toBe(1);
    expect(String(warns[0]!.problem)).toContain(`seq ${resultSeq}`);
    expect(String(warns[0]!.problem)).toContain("t.undeclared@3.1.4");
    expect(r.objs.some((o) => o.seq === resultSeq)).toBe(false);
    expect(r.status).toBe(0);
  });

  test("a transform that fails on every line cannot warn about its own warning", async () => {
    const always: HistoryTransform = () => { throw new Error("every line"); };
    let captured: Run | undefined;
    const r = await projected(always, (run) => {
      captured = run;
      run.step("counted the things", "every line fails");
      run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" });
    });
    expect(r.status).toBe(0);
    expect(r.violations).toEqual([]);
    const warns = warningsOf(r, "history.transform_failed");
    expect(warns.length).toBeGreaterThan(0);
    const warnSeqs = new Set(r.receiptLines.filter((o) => o.event === "warning").map((o) => o.seq));
    for (const w of warns) {
      const named = Number(/seq (\d+)/.exec(String(w.problem))![1]);
      expect(warnSeqs.has(named)).toBe(false);
    }
    expect(r.objs.length).toBe(1);
    expect(r.objs[0]!.event).toBe("history.transform");
    // The gaps, not the warning count, are the ground truth for what the copy is missing.
    expect(captured!.withheldFromHistory).toBeGreaterThan(warns.length);
  });

  test("the transform's identity is its name and the digest of its source", async () => {
    function namedProjection(rec: Record<string, unknown>) { return rec; }
    const r = await projected(namedProjection, () => {});
    expect(r.objs[0]!.name).toBe("namedProjection");
    expect(r.objs[0]!.sha256).toBe(digestOfSource(namedProjection));
    expect(transformDigest(namedProjection)).toBe(digestOfSource(namedProjection));
    const other: HistoryTransform = (rec) => ({ ...rec });
    expect(transformDigest(other)).not.toBe(transformDigest(namedProjection));
    expect(transformDigest(namedProjection)).toBe(transformDigest(namedProjection));
    const anon = await projected((rec) => rec, () => {});
    expect(String(anon.objs[0]!.name).length).toBeGreaterThan(0);
  });

  test("a transform cannot see or restore a declared secret", async () => {
    const secret = "sk-live-9c1f2a";
    const seen: string[] = [];
    const restore: HistoryTransform = (rec) => { seen.push(JSON.stringify(rec)); return rec.decision === "called the api" ? { ...rec, detail: { url: `https://api/${secret}` } } : rec; };
    const { dir, env, hist } = historyScratch();
    const r = await runCount(dir, { ...env, PARLEY_HISTORY: hist }, ["count", "--token", secret], (run) => {
      run.step("called the api", "the step surfaces the token", { url: `https://api/${secret}` });
      run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" });
    }, {}, [], { history: { transform: restore } });
    expect(r.violations).toEqual([]);
    expect(seen.some((l) => l.includes("[redacted]"))).toBe(true);
    expect(seen.some((l) => l.includes(secret))).toBe(false);
    const text = segmentText(hist);
    expect(text.includes(secret)).toBe(false);
    const warns = warningsOf(r, "history.transform_unredacted");
    expect(warns.length).toBe(1);
    expect(String(warns[0]!.problem)).not.toContain(secret);
    expect(r.status).toBe(0);
  });

  test("a record that cannot be serialised is withheld, not a sink failure", async () => {
    // A cycle in what the transform returns throws inside JSON.stringify, which runs inside the
    // receipt's own write. If that escaped, the optional stream would close the run with 4.
    const cyclic: HistoryTransform = (rec) => {
      if (rec.event !== "result") return rec;
      const loop: Record<string, unknown> = { ...rec };
      loop.self = loop;
      return loop;
    };
    const r = await projected(cyclic, (run) => { run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" }); });
    expect(r.status).toBe(0);
    expect(r.violations).toEqual([]);
    const resultSeq = r.receiptLines.find((o) => o.event === "result")!.seq as number;
    const warns = warningsOf(r, "history.transform_failed");
    expect(warns.length).toBe(1);
    expect(String(warns[0]!.problem)).toContain(`seq ${resultSeq}`);
    expect(r.objs.some((o) => o.seq === resultSeq)).toBe(false);
    expect(r.receiptLines.some((o) => o.event === "error")).toBe(false);
    expect(r.objs.at(-1)!.event).toBe("end");
  });

  test("the re-validation checker covers every shipped schema", async () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true }); addFormats(ajv);
    const samples: Record<string, unknown>[] = [
      { event: "warning", t: 1, seq: 3, run: "r", code: "a.b", problem: "p", _schema: { id: "parley.warning", version: "1.0.0" } },
      { event: "redaction", t: 1, seq: 6, run: "r", in: 4, at: "/detail/url", _schema: { id: "parley.redaction", version: "1.0.0" } },
      { event: "end", t: 1, seq: 9, run: "r", status: 0, receipt: "/w/r.jsonl", redacted: false, _schema: { id: "parley.end", version: "1.0.0" } },
      { event: "page", t: 1, seq: 7, run: "r", has_more: true, cursor: "c", _schema: { id: "parley.page", version: "1.0.0" } },
      { event: "receipt.step", t: 1, seq: 2, run: "r", decision: "d", because: "b", _schema: { id: "parley.receipt.step", version: "1.0.0" } },
    ];
    for (const sample of samples) {
      const pair = sample._schema as { id: string; version: string };
      const doc = SCHEMAS.find((s) => s.id === pair.id && s.version === pair.version)!.schema;
      const validate = ajv.compile(doc);
      expect(checkRecord(sample, doc).ok).toBe(validate(sample));
      for (const key of Object.keys(sample)) {
        if (key === "_schema") continue;
        const { [key]: _dropped, ...without } = sample;
        expect(checkRecord(without, doc).ok).toBe(Boolean(validate(without)));
      }
    }
    // Every shipped draft is inside the subset the checker implements, or the gate fails here.
    // The walk is over the document, not over one record, so a keyword nested under a property no
    // sample happens to carry cannot slip past it.
    for (const s of SCHEMAS) expect(schemaSubsetGap(s.schema), `${s.id}@${s.version}`).toBeNull();
    expect(schemaSubsetGap({ type: "object", properties: { a: { $ref: "#/$defs/x" } } })).toBe("$ref");
    expect(schemaSubsetGap({ type: "string", format: "uri" })).toBe("format uri");
    const unsupported = checkRecord({ a: 1 }, { properties: { a: { uniqueItems: true } } });
    expect("unsupported" in unsupported ? unsupported.unsupported : undefined).toBe("uniqueItems");
  });

  test("the doctor reports a segment's projection and its withheld gaps", async () => {
    const dropSteps: HistoryTransform = (rec) => (rec.decision === "counted the things" ? undefined : rec);
    const r = await projected(dropSteps, (run) => {
      run.step("counted the things", "steps stay local");
      run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" });
    });
    const stepSeq = r.receiptLines.find((o) => o.event === "receipt.step" && o.decision === "counted the things")!.seq as number;
    const vs = inspectSegment(r.text);
    const proj = vs.filter((v) => v.event === "doctor.projection") as { run: string; name: string; sha256: string }[];
    expect(proj.length).toBe(1);
    expect(proj[0]!.name).toBe("dropSteps");
    expect(proj[0]!.sha256).toBe(digestOfSource(dropSteps));
    expect(proj[0]!.run).toBe(String(r.receiptLines[0]!.run));
    const gaps = (vs.filter((v) => v.event === "doctor.gap") as { run: string; seq: number }[]).map((g) => g.seq);
    expect(gaps).toContain(stepSeq);
    const summary = vs.at(-1) as { event: string; runs: number; projected: number; gaps: number; torn: number; passed: boolean };
    expect(summary.event).toBe("doctor.segment");
    expect(summary).toMatchObject({ runs: 1, projected: 1, torn: 0, passed: true });
    expect(summary.gaps).toBe(gaps.length);

    const { dir, env, hist } = historyScratch();
    const plain = await runCount(dir, { ...env, PARLEY_HISTORY: hist }, ["count"], (run) => { run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" }); });
    expect(plain.violations).toEqual([]);
    const plainVs = inspectSegment(segmentText(hist));
    expect(plainVs.filter((v) => v.event === "doctor.projection")).toEqual([]);
    expect(plainVs.filter((v) => v.event === "doctor.gap")).toEqual([]);
    expect(plainVs.at(-1)).toMatchObject({ event: "doctor.segment", runs: 1, projected: 0, gaps: 0, passed: true });
  });
});

// ---- PE-25: refuseSuspectedSecrets (flyingrobots/parley#60) --------------------------------
// Declared redaction cannot catch a secret nobody declared. The built-in withholds a line whose
// body matches one of a documented list of token shapes and says so under its own code. It
// refuses rather than rewrites, so a false positive costs one stream line and never a changed
// receipt, and it never scans the envelope, which is the writer's.

/**
 * One positive and one negative sample per shipped pattern, assembled from fragments so no
 * token-shaped literal is committed — which is also what a planted test token is. The negative
 * is the same shape with one thing wrong, and must match no pattern at all.
 */
const SAMPLES: Record<string, { yes: string; no: string }> = {
  "aws.access_key_id": { yes: "AKIA" + "IOSFODNN7EXAMPLE", no: "AKIA" + "iosfodnn7example" },
  "github.token": { yes: "ghp_" + "0123456789abcdefghij0123456789abcdef", no: "ghp_" + "0123456789abcdef" },
  "github.fine_grained_pat": { yes: "github_pat_" + "0123456789abcdefghijkl" + "_" + "0123456789012345678901234567890123456789012345678901234567A", no: "github_pat_" + "0123456789abcdefghijkl" },
  "slack.token": { yes: "xoxb-" + "123456789012-1234567890123-abcdefghijklmnopqrstuvwx", no: "xoxb-" + "abc" },
  "google.api_key": { yes: "AIza" + "0123456789012345678901234567890123A", no: "AIza" + "0123456789012345678" },
  "pem.private_key": { yes: "-----BEGIN RSA PRIVATE KEY-----", no: "-----BEGIN CERTIFICATE-----" },
  "jwt": { yes: "eyJ" + "hbGciOiJIUzI1NiJ9" + "." + "eyJzdWIiOiJ0ZXN0In0" + "." + "c2lnbmF0dXJlLXBsYWNlaG9sZGVy", no: "eyJ" + "hbGciOiJIUzI1NiJ9" + "." + "eyJzdWIiOiJ0ZXN0In0" },
  "http.bearer_token": { yes: "Bearer " + "abcdefghijklmnopqrstuvwxyz0123", no: "Bearer " + "short" },
  "npm.token": { yes: "npm_" + "0123456789abcdefghij0123456789abcdef", no: "npm_" + "token" },
  "stripe.live_key": { yes: "sk_live_" + "0123456789abcdef", no: "sk_test_" + "0123456789abcdef" },
};

/** The planted token of the definition of done: GitHub-shaped, the right length, clearly fake. */
const PLANTED = SAMPLES["github.token"]!.yes;

const stepRecord = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  event: "receipt.step", t: 1795390370294, seq: 5, run: "01M82SNWFCYTA4NZ7K43TESPAT",
  decision: "counted the things", because: "only regular files count",
  _schema: { id: "parley.receipt.step", version: "1.0.0" }, ...over,
});

describe("PE-25 refuseSuspectedSecrets", () => {
  test("every shipped pattern has a positive and a negative sample, and each behaves", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(SECRET_PATTERNS.map((p) => p.name).sort());
    expect(SECRET_PATTERNS.length).toBe(Object.keys(SAMPLES).length);
    for (const p of SECRET_PATTERNS) {
      expect(p.why.length).toBeGreaterThan(0);
      expect(() => new RegExp(p.regex)).not.toThrow();
      const { yes, no } = SAMPLES[p.name]!;
      const hit = findSuspectedSecret(stepRecord({ detail: { value: yes } }));
      expect(hit).toEqual({ pattern: p.name, at: "/detail/value" });
      // The negative is not merely unmatched by its own pattern: no pattern claims it.
      expect(findSuspectedSecret(stepRecord({ detail: { value: no } }))).toBeNull();
    }
  });

  test("a planted token is withheld from the stream, kept in the receipt and named by seq", async () => {
    const r = await projected(refuseSuspectedSecrets(), (run) => {
      run.step("read the credential", "the token is the thing under test", { token: PLANTED });
      run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" });
    });
    expect(r.status).toBe(0);
    expect(r.violations).toEqual([]);
    const planted = r.receiptLines.find((o) => o.decision === "read the credential")!;
    expect((planted.detail as Record<string, unknown>).token).toBe(PLANTED);
    expect(r.objs.some((o) => o.seq === planted.seq)).toBe(false);
    expect(r.text.includes(PLANTED)).toBe(false);
    const warns = warningsOf(r, "history.suspected_secret");
    expect(warns.length).toBe(1);
    expect(String(warns[0]!.problem)).toContain(`seq ${String(planted.seq)}`);
    expect(String(warns[0]!.problem)).toContain("github.token");
    expect(r.receiptLines.some((o) => o.event === "warning" && o.code === "history.suspected_secret")).toBe(true);
    // The warning is projected like any other line, so a refusal cannot hide its own warning.
    expect(r.objs.some((o) => o.event === "warning" && o.code === "history.suspected_secret")).toBe(true);
    // PE-25j: the warning names the shape and the pointer, never the matched text.
    expect(r.stderr.text.includes(PLANTED)).toBe(false);
    expect(String(warns[0]!.problem)).toContain("/detail/token");
  });

  test("it refuses and never rewrites: the receipt copy is the run that had no transform", async () => {
    const body = (run: Run) => {
      run.step("read the credential", "the token is the thing under test", { token: PLANTED });
      run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" });
    };
    const r = await projected(refuseSuspectedSecrets(), body);
    const bare = await projected((rec) => rec, body);
    // The same receipt, line for line, but for the one warning the refusal adds: the projection
    // narrows the stream and the receipt is whatever it would have been (§8, informative).
    const shape = (lines: Record<string, unknown>[]) => lines
      .filter((o) => !(o.event === "warning" && o.code === "history.suspected_secret"))
      .filter((o) => !(o.event === "receipt.step" && String(o.decision).startsWith("the shared stream's copy")))
      .map((o) => o.event);
    expect(shape(r.receiptLines)).toEqual(shape(bare.receiptLines));
    const bodyOf = (lines: Record<string, unknown>[]) => { const { t: _t, seq: _s, run: _r, ...rest } = lines.find((o) => o.decision === "read the credential")!; return rest; };
    expect(bodyOf(r.receiptLines)).toEqual(bodyOf(bare.receiptLines));
    expect(r.receipt.includes(PLANTED)).toBe(true);
    expect(r.receipt.includes("[redacted]")).toBe(false);
    // Nothing partial, truncated or masked reaches the stream either: the line is simply absent.
    expect(r.text.includes(PLANTED.slice(0, 12))).toBe(false);
  });

  test("a token split across two keys passes, and so does one in an object key", () => {
    const halves = stepRecord({ detail: { a: "ghp_" + "0123456789abcdefghij", b: "0123456789abcdef" } });
    expect(findSuspectedSecret(halves)).toBeNull();
    const asKey = stepRecord({ detail: { [PLANTED]: 1 } });
    expect(findSuspectedSecret(asKey)).toBeNull();
  });

  test("a legitimate value that matches a pattern costs one withheld stream line", async () => {
    // The documented cost of refusing rather than rewriting: this is a commit message quoting a
    // key id, not a credential, and it is still kept off the shared timeline.
    const r = await projected(refuseSuspectedSecrets(), (run) => {
      run.step("quoted a key id in prose", `the rotation ticket names ${SAMPLES["aws.access_key_id"]!.yes}`, { quoted: SAMPLES["aws.access_key_id"]!.yes });
      run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" });
    });
    expect(r.status).toBe(0);
    expect(r.violations).toEqual([]);
    expect(warningsOf(r, "history.suspected_secret").length).toBe(1);
    expect(r.receiptLines.some((o) => o.decision === "quoted a key id in prose")).toBe(true);
    expect(r.objs.some((o) => o.decision === "quoted a key id in prose")).toBe(false);
  });

  test("the envelope is never scanned", () => {
    expect(findSuspectedSecret({ event: PLANTED, t: 1, seq: 2, run: PLANTED, _schema: { id: PLANTED, version: PLANTED } })).toBeNull();
    const t = refuseSuspectedSecrets();
    const rec = stepRecord({ run: PLANTED });
    expect(t(rec)).toBe(rec);
  });

  test("a caller's pattern list replaces the default, and an empty one refuses nothing", () => {
    const only = refuseSuspectedSecrets([{ name: "internal.ticket", regex: "\\bTICKET-[0-9]{6}\\b", why: "the internal tracker's ids are not for the shared timeline" }]);
    const rec = stepRecord({ detail: { ticket: "TICKET-123456", token: PLANTED } });
    const refusal = only(rec);
    expect(isHistoryRefusal(refusal)).toBe(true);
    expect((refusal as { code: string }).code).toBe("history.suspected_secret");
    expect(String((refusal as { problem: string }).problem)).toContain("internal.ticket");
    expect(refuseSuspectedSecrets([])(rec)).toBe(rec);
    expect(findSuspectedSecret(rec, [])).toBeNull();
  });

  test("a transform refuses under its own code, and the writer still owns the namespace", async () => {
    const own = await projected((rec) => (rec.event === "receipt.step" ? refuse("policy.off_timeline", `seq ${String(rec.seq)} is not for the shared timeline`, "widen the policy") : rec), (run) => {
      run.step("counted the things", "the stream need not carry this");
      run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" });
    });
    expect(own.status).toBe(0);
    expect(own.violations).toEqual([]);
    const w = warningsOf(own, "policy.off_timeline");
    expect(w.length).toBeGreaterThanOrEqual(1);
    expect(String(w[0]!.remedy)).toBe("widen the policy");
    expect(own.objs.some((o) => o.event === "receipt.step" && o.decision === "counted the things")).toBe(false);

    // A code the protocol would not accept cannot be smuggled through a refusal: the line is
    // still withheld, and the writer reports it under its own code (spec §6).
    const bad = await projected((rec) => (rec.decision === "counted the things" ? ({ [Symbol.for("parley.history.refusal")]: true, code: "Not A Code", problem: "no" } as unknown as Record<string, unknown>) : rec), (run) => {
      run.step("counted the things", "the stream need not carry this");
      run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" });
    });
    expect(bad.status).toBe(0);
    expect(bad.violations).toEqual([]);
    expect(warningsOf(bad, "history.transform_failed").length).toBe(1);
    expect(bad.objs.some((o) => o.event === "receipt.step" && o.decision === "counted the things")).toBe(false);

    // Nor can a non-string problem or remedy: a warning whose problem is a number does not
    // validate, and stderr and the receipt have no re-validation behind them (§4.5).
    const typed = await projected((rec) => (rec.decision === "counted the things" ? ({ [Symbol.for("parley.history.refusal")]: true, code: "policy.off_timeline", problem: 5, remedy: 7 } as unknown as Record<string, unknown>) : rec), (run) => {
      run.step("counted the things", "the stream need not carry this");
      run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" });
    });
    expect(typed.violations).toEqual([]);
    expect(warningsOf(typed, "history.transform_failed").length).toBe(1);
    expect(typed.stderr.objs.every((o) => o.event !== "warning" || typeof o.problem === "string")).toBe(true);

    // And a refusal whose code carries a declared secret value is itself refused: a diagnostic's
    // code is the one string the writer does not scrub (§5.3).
    const { dir, env, hist } = historyScratch();
    const leak = await runCount(dir, { ...env, PARLEY_HISTORY: hist }, ["count", "--token", "abcdef"], (run) => {
      run.step("counted the things", "the stream need not carry this");
    }, {}, [], { history: { transform: (rec) => (rec.event === "receipt.step" ? refuse("policy.abcdef", "a code that carries the token") : rec) } });
    expect(leak.status).toBe(0);
    expect(leak.violations).toEqual([]);
    expect(leak.stderr.objs.filter((o) => o.event === "warning" && o.code === "history.transform_unredacted").length).toBeGreaterThanOrEqual(1);
    expect(segmentText(hist).includes("abcdef")).toBe(false);
    expect(leak.stderr.text.includes("policy.abcdef")).toBe(false);
  });

  test("the pointer a warning names cannot itself carry a suspected secret", async () => {
    // A JSON Pointer is built from the record's own keys, and a key can be anything. A line
    // withheld for one suspected secret must not put a different one on the stream through the
    // warning that explains it.
    const r = await projected(refuseSuspectedSecrets(), (run) => {
      run.step("cached a response per token", "the token is the cache key, which is the mistake", { [PLANTED]: { key_id: SAMPLES["aws.access_key_id"]!.yes } });
      run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" });
    });
    expect(r.status).toBe(0);
    expect(r.violations).toEqual([]);
    const warns = warningsOf(r, "history.suspected_secret");
    expect(warns.length).toBe(1);
    expect(String(warns[0]!.problem)).toContain("aws.access_key_id");
    expect(String(warns[0]!.problem)).toContain("github.token");
    expect(String(warns[0]!.problem)).not.toContain(PLANTED);
    expect(r.stderr.text.includes(PLANTED)).toBe(false);
    expect(r.receipt.includes(PLANTED)).toBe(true);
    expect(r.text.includes(PLANTED)).toBe(false);
  });

  test("a pattern that will not compile fails at configuration, not once per line", () => {
    expect(() => refuseSuspectedSecrets([{ name: "bad.shape", regex: "([", why: "a typo in a caller's own pattern" }])).toThrow();
    // And every shipped pattern compiles, which is what makes the default safe to construct.
    expect(() => refuseSuspectedSecrets()).not.toThrow();
  });

  test("an undeclared token on the command line withholds the head itself", async () => {
    // The line that most often carries an undeclared token is the head: it echoes `argv` and
    // `resolved` (§5). Nothing exempts it, so the whole head is withheld and the stream copy of
    // the run has no head at all. The receipt is complete, the doctor reports the gap, and the
    // status does not move — which is the trade this built-in makes, stated rather than hidden.
    const { dir, env, hist } = historyScratch();
    const r = await runCount(dir, { ...env, PARLEY_HISTORY: hist }, ["count", "--planted", PLANTED], (run) => {
      run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" });
    }, {}, [], { history: { transform: refuseSuspectedSecrets() } });
    expect(r.status).toBe(0);
    expect(r.violations).toEqual([]);
    expect(r.receiptLines[0]!.event).toBe("receipt.head");
    const objs = segmentObjs(hist);
    expect(objs.some((o) => o.event === "receipt.head")).toBe(false);
    expect(segmentText(hist).includes(PLANTED)).toBe(false);
    expect(r.receipt.includes(PLANTED)).toBe(true);
    const warns = warningsOf(r, "history.suspected_secret");
    expect(warns.length).toBe(1);
    expect(String(warns[0]!.problem)).toContain(`seq ${String(r.receiptLines[0]!.seq)}`);
    const vs = inspectSegment(segmentText(hist)) as { event: string; seq?: number }[];
    expect(vs.filter((v) => v.event === "doctor.gap").map((v) => v.seq)).toContain(r.receiptLines[0]!.seq as number | undefined);
    expect(vs.at(-1)).toMatchObject({ event: "doctor.segment", runs: 1, projected: 1, torn: 0, passed: true });
  });

  test("declaredProjection then refuseSuspectedSecrets compose in a caller's own function", async () => {
    // There is no composition helper; composing is the caller's function, and this is the whole
    // of it. A refusal from the first is passed on untouched, a record goes on to the second.
    const declared = declaredProjection(["db-prod-7"])!;
    const suspect = refuseSuspectedSecrets();
    const both: HistoryTransform = (rec) => {
      const out = declared(rec);
      return out && !isHistoryRefusal(out) ? suspect(out) : out;
    };
    const r = await projected(both, (run) => {
      run.step("connected to db-prod-7", "the host is fine in a receipt", { host: "db-prod-7" });
      run.step("read the credential", "the token is the thing under test", { token: PLANTED, host: "db-prod-7" });
      run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" });
    }, { name: "declared-then-suspect" });
    expect(r.status).toBe(0);
    expect(r.violations).toEqual([]);
    const hostStep = r.objs.find((o) => o.event === "receipt.step" && String(o.decision).startsWith("connected to"))!;
    expect(hostStep.decision).toBe("connected to [redacted]");
    expect(r.objs.some((o) => o.decision === "read the credential" || String(o.decision).startsWith("read the"))).toBe(false);
    expect(warningsOf(r, "history.suspected_secret").length).toBe(1);
    expect(r.text.includes("db-prod-7")).toBe(false);
    expect(r.text.includes(PLANTED)).toBe(false);
    expect(r.receipt.includes("db-prod-7")).toBe(true);
    expect(r.receipt.includes(PLANTED)).toBe(true);
  });

  test("ten thousand lines of one segment terminate inside the stated bound", async () => {
    // Two bounds, both measured here. The scan is the built-in's own cost; the run is the whole
    // of it, the receipt's ten thousand writes included, because a scan per line must not turn a
    // segment into a stall. Locally the scan takes about 30 ms and the run about 0.8 s, so these
    // are generous by more than an order of magnitude and still fail a quadratic walk outright.
    const SCAN_BOUND_MS = 2_000;
    const RUN_BOUND_MS = 10_000;
    const LINES = 10_000;
    const scan = refuseSuspectedSecrets();
    const scanStarted = Date.now();
    let refused = 0;
    for (let i = 0; i < LINES; i++) {
      const rec = stepRecord({ seq: i, decision: `line ${i}`, detail: { i, note: i % 100 === 0 ? PLANTED : "nothing to see", names: ["a.txt", "b.txt", "c.txt"] } });
      if (scan(rec) !== rec) refused++;
    }
    expect(Date.now() - scanStarted).toBeLessThan(SCAN_BOUND_MS);
    expect(refused).toBe(LINES / 100);

    const started = Date.now();
    const r = await projected(refuseSuspectedSecrets(), (run) => {
      for (let i = 0; i < LINES; i++) {
        const planted = i % 100 === 0;
        run.step(`line ${i}`, "one of ten thousand", { i, note: planted ? PLANTED : "nothing to see" });
      }
    });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(RUN_BOUND_MS);
    expect(r.status).toBe(0);
    expect(warningsOf(r, "history.suspected_secret").length).toBe(LINES / 100);
    expect(r.objs.filter((o) => o.event === "receipt.step" && typeof o.decision === "string" && (o.decision as string).startsWith("line ")).length).toBe(LINES - LINES / 100);
    expect(r.text.includes(PLANTED)).toBe(false);
  }, 60_000);
});

// A record that redaction made invalid under its declared schema is never published
// (flyingrobots/parley#131, spec §5.3). The writer validates the scrubbed record before any copy
// is written and before a seq is taken, and reports one structured error in its place.
describe("PE-29 a record redaction made invalid is never published (flyingrobots/parley#131)", () => {
  const PAIR = { id: "t.count", version: "1.0.0" };
  const TYPED_PAIR = { id: "t.typed", version: "1.0.0" };
  const PATTERN = "^[a-z]{3}-[0-9]+$";
  const TYPED = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["event", "t", "seq", "run", "_schema"],
    properties: {
      event: { const: "result" },
      ref: { type: "string", pattern: PATTERN },
      mode: { enum: ["fast", "slow"] },
      count: { type: "integer" },
      note: { type: "string" },
      _schema: { type: "object", required: ["id", "version"], additionalProperties: false, properties: { id: { const: "t.typed" }, version: { const: "1.0.0" } } },
    },
  };
  const typed = { commands: { count: { intent: "count", effects: { reads: [], writes: [], network: false, idempotent: true }, secrets: ["--token", "T_TOKEN"], emits: [{ ...TYPED_PAIR, schema: TYPED }, { id: "t.loose", version: "1.0.0" }] } } };
  /**
   * A scratch directory whose paths carry none of the given secrets. These cases use short
   * secrets such as `42`, and a temporary directory's random name holds one about once in a few
   * hundred runs; the writer then relocates the receipt or fails at startup (§5.3), which is
   * right and is not what these cases are about.
   */
  const scratch = (...secrets: string[]) => {
    for (let i = 0; i < 64; i++) {
      const s = scratchAnywhere();
      if (!secrets.some((v) => s.dir.includes(v) || s.state.includes(v))) return s;
    }
    throw new Error(`no temporary directory free of ${secrets.join(", ")} could be made`);
  };
  type R = Awaited<ReturnType<typeof runCount>>;
  const everyLine = (r: R) => [...r.stdout.objs, ...r.stderr.objs, ...r.receiptLines];
  const expectGapless = (r: R) => {
    const seqs = [...new Set(everyLine(r).map((o) => o.seq as number))].sort((a, b) => a - b);
    expect(seqs).toEqual(seqs.map((_, i) => i));
  };
  const conflicts = (r: R) => r.stderr.objs.filter((o) => o.code === "redaction.schema_conflict") as { event: string; seq: number; code: string; problem: string; remedy: string; detail: { schema: { id: string; version: string }; at: string[]; redacted: string[] } }[];
  /** Everything the error says, outside its envelope: the text a secret or a validator message would have to be in. */
  const said = (e: { problem: string; remedy: string; detail: unknown }) => `${e.problem}\n${e.remedy}\n${JSON.stringify(e.detail)}`;

  test("an integer field equal to a declared secret: the result is not published and the run ends with status 4 and one structured error", async () => {
    const { dir, env } = scratch("42");
    let thrown: unknown;
    const r = await runCount(dir, env, ["count", "--token", "42"], (run) => {
      try { run.result({ event: "result", value: 42 }, PAIR); } catch (e) { thrown = e; throw e; }
    });
    expect(r.status).toBe(4);
    expect(thrown).toBeInstanceOf(ParleyRedactionConflict);
    // Nothing of the record reached any sink, in either form.
    expect(everyLine(r).filter((o) => o.event === "result")).toEqual([]);
    expect(everyLine(r).some((o) => "value" in o)).toBe(false);
    const errs = r.stderr.objs.filter((o) => o.event === "error");
    expect(errs.length).toBe(1);
    const [e] = conflicts(r);
    expect(e).toMatchObject({ event: "error", code: "redaction.schema_conflict", detail: { schema: PAIR, at: ["/value"], redacted: ["/value"] } });
    expect(e!.problem).toContain("/value");
    expect(e!.problem).toContain("t.count@1.0.0");
    // No value, no validator message, no schema fragment.
    expect(said(e!)).not.toContain("42");
    for (const leak of ["integer", "is string", "minimum", "not integer"]) expect(said(e!)).not.toContain(leak);
    // The receipt holds the same error and still ends; the counter has no hole where the record would have been.
    expect(r.receiptLines.filter((o) => o.event === "error").map((o) => o.seq)).toEqual([e!.seq]);
    expect(r.receiptLines.at(-1)).toMatchObject({ event: "end", status: 4 });
    expectGapless(r);
    expect(r.violations).toEqual([]);
  });

  test("a distinctive numeric secret appears on no stream and in no receipt line", async () => {
    const { dir, env } = scratch("8675309");
    const r = await runCount(dir, env, ["count", "--token", "8675309"], (run) => { run.result({ event: "result", value: 8675309 }, PAIR); });
    expect(r.status).toBe(4);
    expect(r.stdout.text + r.stderr.text + r.receipt).not.toContain("8675309");
    expect(conflicts(r).length).toBe(1);
    expect(r.violations).toEqual([]);
  });

  test("a string field whose pattern or enum [redacted] breaks is refused the same way, naming each field", async () => {
    const { dir, env } = scratch("abc-123", "fast");
    const r = await runCount(dir, { ...env, T_TOKEN: "fast" }, ["count", "--token", "abc-123"], (run) => {
      run.result({ event: "result", ref: "abc-123", mode: "fast", note: "kept" }, TYPED_PAIR);
    }, typed);
    expect(r.status).toBe(4);
    const [e] = conflicts(r);
    expect(e!.detail).toEqual({ schema: TYPED_PAIR, at: ["/ref", "/mode"], redacted: ["/ref", "/mode"] });
    expect(e!.problem).toContain("/ref");
    expect(e!.problem).toContain("/mode");
    expect(e!.problem).toContain("t.typed@1.0.0");
    for (const leak of ["abc-123", "fast", "slow", PATTERN, "[a-z]", "does not match", "must be one of"]) expect(said(e!)).not.toContain(leak);
    expect(everyLine(r).filter((o) => o.event === "result")).toEqual([]);
    expect(r.stdout.text + r.stderr.text + r.receipt).not.toContain("abc-123");
    expectGapless(r);
    expect(r.violations).toEqual([]);
  });

  test("a redaction that leaves the record valid is written as before, with its redaction event", async () => {
    const { dir, env } = scratch("abc-123");
    const r = await runCount(dir, env, ["count", "--token", "abc-123"], (run) => {
      run.result({ event: "result", ref: "xyz-9", mode: "slow", note: "saw abc-123" }, TYPED_PAIR);
    }, typed);
    expect(r.status).toBe(0);
    const out = r.stdout.objs.find((o) => o.event === "result")!;
    expect(out).toMatchObject({ ref: "xyz-9", mode: "slow", note: "saw [redacted]" });
    expect(r.receiptLines.find((o) => o.event === "redaction")).toMatchObject({ in: out.seq, at: "/note" });
    expect(r.stderr.objs).toEqual([]);
    expect(checkRecord(out, TYPED)).toEqual({ ok: true });
    expectGapless(r);
    expect(r.violations).toEqual([]);
  });

  test("with receiptExtra, neither copy is written when either would be invalid", async () => {
    const { dir, env } = scratch("42");
    // The stream copy alone is valid; the receipt copy carries the typed field the secret lands in.
    const r = await runCount(dir, env, ["count", "--token", "42"], (run) => { run.result({ event: "result", note: "fine" }, TYPED_PAIR, { count: 42 }); }, typed);
    expect(r.status).toBe(4);
    expect(everyLine(r).filter((o) => o.event === "result")).toEqual([]);
    expect(conflicts(r)[0]!.detail).toEqual({ schema: TYPED_PAIR, at: ["/count"], redacted: ["/count"] });
    expectGapless(r);
    expect(r.violations).toEqual([]);
    // And the other way round: the receipt-only field is fine and the shared record is not.
    const s = scratch("42");
    const r2 = await runCount(s.dir, s.env, ["count", "--token", "42"], (run) => { run.result({ event: "result", count: 42 }, TYPED_PAIR, { note: "fine" }); }, typed);
    expect(r2.status).toBe(4);
    expect(everyLine(r2).filter((o) => o.event === "result")).toEqual([]);
    expect(conflicts(r2).length).toBe(1);
    expectGapless(r2);
  });

  test("a handler that catches the refusal carries on: later records follow with no gap, and end(0) cannot bring the status back from 4", async () => {
    const { dir, env } = scratch("42");
    const r = await runCount(dir, env, ["count", "--token", "42"], (run) => {
      try { run.result({ event: "result", value: 42 }, PAIR); } catch (e) { if (!(e instanceof ParleyRedactionConflict)) throw e; expect(e.message).not.toContain("42"); expect(e.pointers).toEqual(["/value"]); expect(e.schema).toEqual(PAIR); }
      run.result({ event: "result", value: 7 }, PAIR);
      // Like a sink failure, the refusal forces 4 whatever the handler asks for (spec §3.4).
      expect(run.end(0)).toBe(4);
    });
    expect(r.status).toBe(4);
    expect(r.stdout.objs.at(-1)).toMatchObject({ event: "end", status: 4 });
    expect(r.stdout.objs.filter((o) => o.event === "result").map((o) => o.value)).toEqual([7]);
    expect(r.stderr.objs.map((o) => o.code)).toEqual(["redaction.schema_conflict"]);
    expectGapless(r);
    expect(r.violations).toEqual([]);
  });

  test("a tool's own error whose code or typed field the secret lands in is refused, not published invalid", async () => {
    const { dir, env } = scratch("42", "true");
    const r = await runCount(dir, { ...env, T_TOKEN: "true" }, ["count", "--token", "42"], (run) => {
      try { run.error({ code: "http.42", problem: "the fetch failed" }); } catch (e) { if (!(e instanceof ParleyRedactionConflict)) throw e; }
      run.error({ code: "fetch.failed", problem: "the fetch failed", retryable: true });
    });
    expect(r.status).toBe(4);
    const cs = conflicts(r);
    expect(cs.map((c) => c.detail)).toEqual([
      { schema: { id: "parley.error", version: "2.0.0" }, at: ["/code"], redacted: ["/code"] },
      { schema: { id: "parley.error", version: "2.0.0" }, at: ["/retryable"], redacted: ["/retryable"] },
    ]);
    expect(r.stderr.objs.map((o) => o.code)).toEqual(["redaction.schema_conflict", "redaction.schema_conflict"]);
    expectGapless(r);
    expect(r.violations).toEqual([]);
  });

  test("the error's own text is scrubbed without looping when the secret is the field's name", async () => {
    const { dir, env } = scratch("value");
    // The key `value` is renamed by the scrub, so the required field is missing, and the pointer
    // the error would print is itself the secret.
    const r = await runCount(dir, env, ["count", "--token", "value"], (run) => { run.result({ event: "result", value: 7 }, PAIR); });
    expect(r.status).toBe(4);
    const cs = conflicts(r);
    expect(cs.length).toBe(1);
    expect(cs[0]!.detail.schema).toEqual(PAIR);
    expect(cs[0]!.detail.at).toContain("/[redacted]");
    expect(said(cs[0]!)).not.toContain("value");
    expect(r.stderr.objs.length).toBe(1);
    expect(r.receiptLines.filter((o) => o.event === "redaction" && o.in === cs[0]!.seq).length).toBeGreaterThan(0);
    expectGapless(r);
    expect(r.violations).toEqual([]);
  });

  test("scope: a record already invalid for another reason, and a type with no schema document, are written as before", async () => {
    const { dir, env } = scratch("abc-123");
    const r = await runCount(dir, env, ["count", "--token", "abc-123"], (run) => {
      // `count` was never an integer; the redaction in `note` did not make the record invalid.
      run.result({ event: "result", count: "many", note: "saw abc-123" }, TYPED_PAIR);
      // No schema document is declared for t.loose, so there is nothing to validate against.
      run.result({ event: "result", n: "abc-123" }, { id: "t.loose", version: "1.0.0" });
    }, typed);
    expect(r.status).toBe(0);
    expect(r.stdout.objs.filter((o) => o.event === "result").map((o) => [o.note, o.n])).toEqual([["saw [redacted]", undefined], [undefined, "[redacted]"]]);
    expect(r.stderr.objs).toEqual([]);
    expectGapless(r);
  });

  test("in a real process the exit status is 4 and stdout carries end with status 4", () => {
    const { dir, env } = scratch("8675309");
    const script = join(dir, "typed.ts");
    writeFileSync(script, `import { defineTool, main } from ${JSON.stringify(resolve(import.meta.dir, "../src/index.ts"))};
const schema = { type: "object", required: ["value"], properties: { value: { type: "integer" } } };
const tool = defineTool({ name: "t", version: "0.0.1", commands: { count: { intent: "count", effects: { reads: [], writes: [], network: false, idempotent: true }, secrets: ["--token"], emits: [{ id: "t.count", version: "1.0.0", schema }] } }, retention: { count: 10 } });
process.exit(await main(tool, ["t", ...process.argv.slice(2)], (run) => { run.result({ event: "result", value: 8675309 }, { id: "t.count", version: "1.0.0" }); }));`);
    const p = Bun.spawnSync(["bun", script, "count", "--token", "8675309"], { cwd: dir, env: { ...process.env, ...env } });
    const out = p.stdout.toString(), err = p.stderr.toString();
    expect(p.exitCode).toBe(4);
    const outObjs = out.trimEnd().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(outObjs.map((o) => o.event)).toEqual(["run", "end"]);
    expect(outObjs.at(-1)).toMatchObject({ status: 4 });
    const errObjs = err.trimEnd().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(errObjs.map((o) => o.code)).toEqual(["redaction.schema_conflict"]);
    const receipt = readFileSync((outObjs[0] as { paths: { receipt: string } }).paths.receipt, "utf8");
    expect(out + err + receipt).not.toContain("8675309");
    expect(doctor({ stdout: out, stderr: err, receipt, receiptPresent: true }, SCHEMAS_DIR).filter((v) => v.event === "doctor.violation")).toEqual([]);
  }, 30_000);

  test("--human: the refusal is rendered as prose and the receipt holds the structured error", async () => {
    const { dir, env } = scratch("8675309");
    const s = streams();
    const status = await main(tool(), ["t", "count", "--human", "--token", "8675309"], async (run) => { run.result({ event: "result", value: 8675309 }, PAIR); }, { cwd: dir, env, ...s });
    expect(status).toBe(4);
    expect(s.stderr.text).toStartWith("error redaction.schema_conflict: ");
    expect(s.stdout.text + s.stderr.text).not.toContain("8675309");
    const receipts = join(dir, ".parley", "receipts");
    const text = readFileSync(join(receipts, readdirSync(receipts).find((f) => f.endsWith(".jsonl"))!), "utf8");
    expect(text).not.toContain("8675309");
    const lines = text.trimEnd().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.filter((o) => o.event === "result")).toEqual([]);
    expect(lines.filter((o) => o.event === "error").map((o) => o.code)).toEqual(["redaction.schema_conflict"]);
    expect(doctor({ receipt: text }, SCHEMAS_DIR).filter((v) => v.event === "doctor.violation")).toEqual([]);
  });
});

// A record redaction changed, under a schema document the writer holds and cannot evaluate, is
// withheld like a conflict (spec §5.3, flyingrobots/parley#131, decided on flyingrobots/parley#144):
// the writer cannot show the redacted record is valid, so publishing it would be the silent invalid
// line the rule exists to prevent. Every case is a real run through `main`.
describe("PE-30 a record redaction changed under a schema the writer cannot evaluate is withheld (flyingrobots/parley#144)", () => {
  const PAIR = { id: "t.count", version: "1.0.0" };
  const SECRET = "8675309";
  /** The reviewers' variants: `value` is an integer in every one, and each but the control adds one construct outside the checker's subset. */
  const CONTROL = { type: "object", required: ["value"], properties: { value: { type: "integer" } } };
  const UNEVALUABLE: Record<string, { schema: Record<string, unknown>; words: string[] }> = {
    "format date-time on an unrelated property": { schema: { type: "object", required: ["value"], properties: { value: { type: "integer" }, when: { type: "string", format: "date-time" } } }, words: ["date-time", "format"] },
    "multipleOf on an unrelated property": { schema: { type: "object", required: ["value"], properties: { value: { type: "integer" }, step: { type: "number", multipleOf: 0.5 } } }, words: ["multipleOf"] },
    "uniqueItems on an unrelated property": { schema: { type: "object", required: ["value"], properties: { value: { type: "integer" }, tags: { type: "array", uniqueItems: true } } }, words: ["uniqueItems"] },
    "a $ref into $defs": { schema: { type: "object", required: ["value"], properties: { value: { $ref: "#/$defs/n" } }, $defs: { n: { type: "integer" } } }, words: ["$ref", "$defs"] },
    "an empty $defs": { schema: { type: "object", required: ["value"], properties: { value: { type: "integer" } }, $defs: {} }, words: ["$defs"] },
  };
  const over = (schema: Record<string, unknown>, more: { id: string; version: string }[] = []) => ({ commands: { count: { intent: "count", effects: { reads: [], writes: [], network: false, idempotent: true }, secrets: ["--token"], emits: [{ ...PAIR, schema }, ...more] } } });
  const scratch = (...secrets: string[]) => {
    for (let i = 0; i < 64; i++) {
      const s = scratchAnywhere();
      if (!secrets.some((v) => s.dir.includes(v) || s.state.includes(v))) return s;
    }
    throw new Error(`no temporary directory free of ${secrets.join(", ")} could be made`);
  };
  type R = Awaited<ReturnType<typeof runCount>>;
  type Unchecked = { event: string; seq: number; code: string; problem: string; remedy: string; detail: { schema: { id: string; version: string }; redacted: string[] } };
  const everyLine = (r: R) => [...r.stdout.objs, ...r.stderr.objs, ...r.receiptLines];
  const expectGapless = (r: R) => {
    const seqs = [...new Set(everyLine(r).map((o) => o.seq as number))].sort((a, b) => a - b);
    expect(seqs).toEqual(seqs.map((_, i) => i));
  };
  const said = (e: Unchecked) => `${e.problem}\n${e.remedy}\n${JSON.stringify(e.detail)}`;
  const expectWithheld = (r: R, redacted: string[]): Unchecked => {
    expect(r.status).toBe(4);
    expect(everyLine(r).filter((o) => o.event === "result")).toEqual([]);
    expect(everyLine(r).some((o) => "value" in o)).toBe(false);
    expect(r.stdout.text + r.stderr.text + r.receipt).not.toContain(SECRET);
    expect(r.stderr.objs.map((o) => [o.event, o.code])).toEqual([["error", "redaction.schema_unchecked"]]);
    const e = r.stderr.objs[0] as unknown as Unchecked;
    expect(e.detail).toEqual({ schema: PAIR, redacted });
    expect(e.problem).toContain("t.count@1.0.0");
    for (const p of redacted) expect(e.problem).toContain(p);
    // The code means "not checked": the line says so, and never calls it a conflict.
    expect(e.problem).toContain("could not be checked");
    expect(said(e)).not.toContain("conflict");
    expect(e.remedy).toContain("not shown to be invalid");
    expect(r.receiptLines.filter((o) => o.event === "error").map((o) => [o.seq, o.code])).toEqual([[e.seq, "redaction.schema_unchecked"]]);
    expect(r.receiptLines.at(-1)).toMatchObject({ event: "end", status: 4 });
    expectGapless(r);
    expect(r.violations).toEqual([]);
    return e;
  };

  test("the control inside the checker's subset is a conflict, as before", async () => {
    const { dir, env } = scratch(SECRET);
    const r = await runCount(dir, env, ["count", "--token", SECRET], (run) => { run.result({ event: "result", value: 8675309 }, PAIR); }, over(CONTROL));
    expect(r.status).toBe(4);
    expect(r.stderr.objs.map((o) => o.code)).toEqual(["redaction.schema_conflict"]);
  });

  for (const [name, { schema, words }] of Object.entries(UNEVALUABLE)) {
    test(`${name}: the result is withheld, the run ends with status 4 and one redaction.schema_unchecked error`, async () => {
      const { dir, env } = scratch(SECRET);
      let thrown: unknown;
      const r = await runCount(dir, env, ["count", "--token", SECRET], (run) => {
        try { run.result({ event: "result", value: 8675309 }, PAIR); } catch (e) { thrown = e; throw e; }
      }, over(schema));
      const e = expectWithheld(r, ["/value"]);
      // The line carries no value, no validator message and no part of the schema: not even the
      // name of the construct the writer could not evaluate, which is in the exception alone.
      for (const leak of [...words, "integer", "does not implement"]) expect(said(e)).not.toContain(leak);
      expect(thrown).toBeInstanceOf(ParleyRedactionUnchecked);
      expect(thrown).toBeInstanceOf(ParleyRedactionConflict);
      const u = thrown as ParleyRedactionUnchecked;
      expect(u.schema).toEqual(PAIR);
      expect(u.redacted).toEqual(["/value"]);
      expect(u.pointers).toEqual([]);
      expect(u.message).not.toContain(SECRET);
      expect(u.construct).toBe(schemaSubsetGap(schema));
      expect(u.message).toContain(u.construct!);
    });
  }

  test("a record the scrub did not change is written under an unevaluable schema, and so is a changed record of a type with no schema document", async () => {
    const { dir, env } = scratch(SECRET);
    const r = await runCount(dir, env, ["count", "--token", SECRET], (run) => {
      run.result({ event: "result", value: 7 }, PAIR);
      run.result({ event: "result", n: 8675309, note: `saw ${SECRET}` }, { id: "t.loose", version: "1.0.0" });
    }, over(UNEVALUABLE["a $ref into $defs"]!.schema, [{ id: "t.loose", version: "1.0.0" }]));
    expect(r.status).toBe(0);
    expect(r.stderr.objs).toEqual([]);
    expect(r.stdout.objs.filter((o) => o.event === "result").map((o) => [o.value, o.n, o.note])).toEqual([[7, undefined, undefined], [undefined, "[redacted]", "saw [redacted]"]]);
    expect(r.stdout.text + r.stderr.text + r.receipt).not.toContain(SECRET);
    expectGapless(r);
    expect(r.violations).toEqual([]);
  });

  test("the surprising case: a secret inside an unconstrained string, where the redacted record would still be valid, is withheld under an unevaluable schema", async () => {
    const { dir, env } = scratch(SECRET);
    const schema = { type: "object", properties: { note: { type: "string" }, when: { type: "string", format: "date-time" } } };
    // A full validator accepts the redacted record: the refusal is "not checked", not "invalid".
    const ajv = new Ajv2020({ strict: false }); addFormats(ajv);
    expect(ajv.validate(schema, { event: "result", note: "saw [redacted]" })).toBe(true);
    expect(schemaSubsetGap(schema)).toBe("format date-time");
    const r = await runCount(dir, env, ["count", "--token", SECRET], (run) => { run.result({ event: "result", note: `saw ${SECRET}` }, PAIR); }, over(schema));
    expectWithheld(r, ["/note"]);
  });

  test("an unevaluable schema where the scrub replaced nothing: the record is written and the run ends with status 0", async () => {
    const { dir, env } = scratch(SECRET);
    const schema = { type: "object", properties: { note: { type: "string" }, when: { type: "string", format: "date-time" } } };
    const r = await runCount(dir, env, ["count", "--token", SECRET], (run) => { run.result({ event: "result", note: "saw nothing", when: "2026-11-24T00:00:00Z" }, PAIR); }, over(schema));
    expect(r.status).toBe(0);
    expect(r.stderr.objs).toEqual([]);
    expect(r.stdout.objs.filter((o) => o.event === "result").map((o) => o.note)).toEqual(["saw nothing"]);
    expect(r.receiptLines.filter((o) => o.event === "result").length).toBe(1);
    expect(r.receiptLines.at(-1)).toMatchObject({ event: "end", status: 0 });
    expectGapless(r);
    expect(r.violations).toEqual([]);
  });

  test("with receiptExtra, neither copy is written, whichever copy the secret is in", async () => {
    const schema = UNEVALUABLE["multipleOf on an unrelated property"]!.schema;
    const a = scratch(SECRET);
    const r = await runCount(a.dir, a.env, ["count", "--token", SECRET], (run) => { run.result({ event: "result", step: 1 }, PAIR, { value: 8675309 }); }, over(schema));
    expectWithheld(r, ["/value"]);
    const b = scratch(SECRET);
    const r2 = await runCount(b.dir, b.env, ["count", "--token", SECRET], (run) => { run.result({ event: "result", value: 8675309 }, PAIR, { step: 1 }); }, over(schema));
    expectWithheld(r2, ["/value"]);
  });

  test("a handler that catches the refusal carries on: later records follow with no gap, and end(0) cannot bring the status back from 4", async () => {
    const { dir, env } = scratch(SECRET);
    const r = await runCount(dir, env, ["count", "--token", SECRET], (run) => {
      try { run.result({ event: "result", value: 8675309 }, PAIR); } catch (e) { if (!(e instanceof ParleyRedactionUnchecked)) throw e; }
      run.result({ event: "result", value: 7 }, PAIR);
      expect(run.redactionRefused).toBe(true);
      expect(run.end(0)).toBe(4);
    }, over(UNEVALUABLE["an empty $defs"]!.schema));
    expect(r.status).toBe(4);
    expect(r.stdout.objs.filter((o) => o.event === "result").map((o) => o.value)).toEqual([7]);
    expect(r.stderr.objs.map((o) => o.code)).toEqual(["redaction.schema_unchecked"]);
    expect(r.stdout.text + r.stderr.text + r.receipt).not.toContain(SECRET);
    expectGapless(r);
    expect(r.violations).toEqual([]);
  });

  test("in a real process each variant exits 4 with one redaction.schema_unchecked error, and the doctor passes", () => {
    const { dir, env } = scratch(SECRET);
    const script = join(dir, "unchecked.ts");
    writeFileSync(script, `import { defineTool, main } from ${JSON.stringify(resolve(import.meta.dir, "../src/index.ts"))};
const schema = JSON.parse(process.env.T_SCHEMA!);
const tool = defineTool({ name: "t", version: "0.0.1", commands: { count: { intent: "count", effects: { reads: [], writes: [], network: false, idempotent: true }, secrets: ["--token"], emits: [{ id: "t.count", version: "1.0.0", schema }] } }, retention: { count: 10 } });
process.exit(await main(tool, ["t", ...process.argv.slice(2)], (run) => { run.result({ event: "result", value: 8675309 }, { id: "t.count", version: "1.0.0" }); }));`);
    for (const [name, { schema }] of Object.entries(UNEVALUABLE)) {
      const p = Bun.spawnSync(["bun", script, "count", "--token", SECRET], { cwd: dir, env: { ...process.env, ...env, T_SCHEMA: JSON.stringify(schema) } });
      const out = p.stdout.toString(), err = p.stderr.toString();
      expect([name, p.exitCode]).toEqual([name, 4]);
      const outObjs = out.trimEnd().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(outObjs.map((o) => o.event)).toEqual(["run", "end"]);
      expect(outObjs.at(-1)).toMatchObject({ status: 4 });
      const errObjs = err.trimEnd().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(errObjs.map((o) => o.code)).toEqual(["redaction.schema_unchecked"]);
      const receipt = readFileSync((outObjs[0] as { paths: { receipt: string } }).paths.receipt, "utf8");
      expect(out + err + receipt).not.toContain(SECRET);
      expect(receipt.trimEnd().split("\n").map((l) => (JSON.parse(l) as { event: string }).event)).not.toContain("result");
      expect(doctor({ stdout: out, stderr: err, receipt, receiptPresent: true }, SCHEMAS_DIR).filter((v) => v.event === "doctor.violation")).toEqual([]);
    }
  }, 60_000);

  test("--human: the refusal is rendered as prose and the receipt holds the structured error", async () => {
    const { dir, env } = scratch(SECRET);
    const s = streams();
    const status = await main(tool(over(UNEVALUABLE["a $ref into $defs"]!.schema)), ["t", "count", "--human", "--token", SECRET], async (run) => { run.result({ event: "result", value: 8675309 }, PAIR); }, { cwd: dir, env, ...s });
    expect(status).toBe(4);
    expect(s.stderr.text).toStartWith("error redaction.schema_unchecked: ");
    expect(s.stdout.text + s.stderr.text).not.toContain(SECRET);
    const receipts = join(dir, ".parley", "receipts");
    const text = readFileSync(join(receipts, readdirSync(receipts).find((f) => f.endsWith(".jsonl"))!), "utf8");
    expect(text).not.toContain(SECRET);
    const lines = text.trimEnd().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.filter((o) => o.event === "result")).toEqual([]);
    expect(lines.filter((o) => o.event === "error").map((o) => o.code)).toEqual(["redaction.schema_unchecked"]);
    expect(doctor({ receipt: text }, SCHEMAS_DIR).filter((v) => v.event === "doctor.violation")).toEqual([]);
  });
});
