import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { doctor } from "../../../scripts/doctor.ts";
import { defineTool, main, SCHEMA_SOURCE, SCHEMAS, ulid, type Run, type Sink, type ToolSpec } from "../src/index.ts";

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

async function runCount(cwd: string, env: Record<string, string>, argv: string[], body: (run: Run) => Promise<void> | void, over: Partial<ToolSpec> = {}, inputs: { path: string; role?: string }[] = []) {
  const s = streams();
  const status = await main(tool(over), ["t", ...argv], async (run) => { await body(run); }, { cwd, env, inputs: () => inputs, resolved: (args) => ({ command: "count", args }), ...s });
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
    expect(r.violations.filter((v) => !v.rule.startsWith("R3"))).toEqual([]);
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
