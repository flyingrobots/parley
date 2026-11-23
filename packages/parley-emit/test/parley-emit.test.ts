import { describe, expect, test } from "bun:test";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { doctor } from "../../../scripts/doctor.ts";
import { checkRecord, defineTool, main, schemaSubsetGap, SCHEMA_SOURCE, SCHEMAS, transformDigest, ulid, writeWholeLine, historyDays, declaredProjection, findSuspectedSecret, isHistoryRefusal, refuse, refuseSuspectedSecrets, SECRET_PATTERNS, HISTORY_DEFAULT_DAYS, HISTORY_MAX_DAYS, type HistoryTransform, type MainOptions, type Run, type Sink, type ToolSpec } from "../src/index.ts";
import { inspectSegment } from "../../../scripts/doctor.ts";

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

function scratch() {
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
  });

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
  });

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
  });

  test("the decision counts the tool's own receipts", async () => {
    const { dir, env } = scratch();
    for (let i = 0; i < 3; i++) await runCount(dir, env, ["count"], body, { name: "reader", retention: { count: 2 } });
    for (let i = 0; i < 3; i++) await runCount(dir, env, ["count"], body, { retention: { count: 2 } });
    const step = readFileSync((await runCount(dir, env, ["count"], body, { retention: { count: 2 } })).path!, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { event: string; decision?: string }).find((o) => o.event === "receipt.step" && /retention/.test(o.decision ?? ""));
    expect(step?.decision).toBe("retention: deleted 1 receipt bundle(s)");
    expect(JSON.stringify(step)).toContain("3 of this tool's receipts exceeded the retention count of 2");
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
    expect(ids).toEqual(["t.count@1.0.0", "parley.error@2.0.0"]);
    expect(check(dir, s).violations).toEqual([]);
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
    expect(r.receipt.includes("def")).toBe(false);
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
const pathsOf = (boot: Record<string, unknown>) => boot.paths as Record<string, string>;

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
    expect(checkRecord({ a: 1 }, { properties: { a: { uniqueItems: true } } }).unsupported).toBe("uniqueItems");
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
    expect(vs.filter((v) => v.event === "doctor.gap").map((v) => v.seq)).toContain(r.receiptLines[0]!.seq);
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
