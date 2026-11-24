// The Bun side of the Python writer's gate (flyingrobots/parley#84). It runs the Python unittest
// suite, and it holds the oracles that live in TypeScript: the repository doctor over real
// captured runs of examples/count.py, parley-read's loader over the receipts those runs left, ajv
// against the Python checker, and the TypeScript writer's inv derivation against the Python one.
// `bun test` at the repository root runs this file, so the gate fails when the Python writer stops
// conforming.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { doctor } from "../../../scripts/doctor.ts";
import { loadReceipts } from "../../parley-read/src/index.ts";
import { computeInv, SCHEMAS } from "../../parley-emit/src/index.ts";

const PKG = resolve(import.meta.dir, "..");
const ROOT = resolve(PKG, "../..");
const SCHEMAS_DIR = join(ROOT, "schemas");
const PY = process.env.PARLEY_PYTHON ?? "python3";
const SLOW = 120_000;

interface Captured { status: number | null; stdout: string; stderr: string; dir: string; env: Record<string, string> }

function scratch(files: string[] = ["a.txt", "b.txt"]): { dir: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "parley-py-oracle-"));
  const state = mkdtempSync(join(tmpdir(), "parley-py-oracle-state-"));
  for (const f of files) writeFileSync(join(dir, f), f);
  mkdirSync(join(dir, "a-directory"));
  return { dir, env: { XDG_STATE_HOME: state } };
}

function py(script: string, args: string[], at: { dir: string; env: Record<string, string> }, extraEnv: Record<string, string> = {}): Captured {
  const p = spawnSync(PY, [script, ...args], { cwd: at.dir, env: { ...process.env, ...at.env, ...extraEnv }, encoding: "utf8", maxBuffer: 1 << 28 });
  return { status: p.status, stdout: p.stdout, stderr: p.stderr, ...at };
}
const example = (args: string[], at = scratch(), extraEnv: Record<string, string> = {}) => py(join(PKG, "examples", "count.py"), args, at, extraEnv);
const objs = (text: string) => text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

function receiptOf(c: Captured): { path: string; text: string } {
  const boot = objs(c.stdout)[0] as { paths: { receipt: string } };
  return { path: boot.paths.receipt, text: readFileSync(boot.paths.receipt, "utf8") };
}

function violations(c: Captured) {
  const { path, text } = receiptOf(c);
  return doctor({ stdout: c.stdout, stderr: c.stderr, receipt: text, receiptPresent: existsSync(path) }, SCHEMAS_DIR).filter((v) => v.event === "doctor.violation");
}

/** PY-1b: the loader reads every receipt this directory holds with no defect and every parley.* record validated. */
function expectLoadsClean(c: Captured, runs: number) {
  const load = loadReceipts({ cwd: c.dir, env: c.env });
  expect(load.defects).toEqual([]);
  expect(load.quarantined).toEqual([]);
  expect(load.bundles.length).toBe(runs);
  for (const b of load.bundles) {
    expect(b.defects).toEqual([]);
    expect(b.terminated).toBe(true);
    for (const r of b.records) {
      const id = (r.record._schema as { id: string }).id;
      if (id.startsWith("parley.")) expect(r.validation.state, `${id} seq ${r.seq}`).toBe("validated");
      else expect(r.validation.state).toBe("unvalidated");
    }
  }
  expect(load.counts.invalid).toBe(0);
  expect(load.counts.partial).toBe(0);
  return load;
}

describe("parley-emit-py: the unittest suite", () => {
  test("python3 -m unittest passes", () => {
    const p = spawnSync(PY, ["-m", "unittest", "discover", "-s", "tests"], { cwd: PKG, encoding: "utf8" });
    expect(p.status, `${p.stdout}\n${p.stderr}`).toBe(0);
    expect(p.stderr).toMatch(/\nOK\n?$/);
  }, SLOW);
});

describe("parley-emit-py: the doctor over captured runs of examples/count.py", () => {
  test("PY-1a success: the doctor passes and the receipt loads clean", () => {
    const c = example(["files"]);
    expect(c.status).toBe(0);
    expect(c.stderr).toBe("");
    expect(violations(c)).toEqual([]);
    expect(objs(c.stdout).find((o) => o.event === "result")).toMatchObject({ files: 2, _schema: { id: "count.result", version: "1.0.0" } });
    expectLoadsClean(c, 1);
  }, SLOW);

  test("PY-2a usage error: checked before the bootstrap line, so a startup failure, exit 3, and the doctor passes", () => {
    const at = scratch();
    const c = example(["files", "--frobnicate"], at);
    expect(c.status).toBe(3);
    expect(c.stdout).toBe("");
    const errs = objs(c.stderr);
    expect(errs.length).toBe(1);
    expect(errs[0]).toMatchObject({ event: "startup.failed", seq: 0, code: "startup.arguments_invalid" });
    expect(String(errs[0]?.problem)).toContain("files takes no arguments");
    const vs = doctor({ stdout: c.stdout, stderr: c.stderr }, SCHEMAS_DIR);
    expect(vs.filter((v) => v.event === "doctor.violation")).toEqual([]);
    expect(vs.at(-1)).toMatchObject({ event: "doctor.summary", passed: true, status: null });
    // A startup failure leaves no receipt (spec §3.2): the loader finds nothing.
    expect(loadReceipts({ cwd: at.dir, env: at.env }).bundles).toEqual([]);
  }, SLOW);

  test("PY-3a runtime failure: exit 2, the traceback in the receipt only, and the doctor passes", () => {
    const at = scratch();
    chmodSync(at.dir, 0o300); // searchable and writable, not listable: the handler's listdir raises
    let c: Captured;
    try { c = example(["files"], at); } finally { chmodSync(at.dir, 0o755); }
    expect(c.status).toBe(2);
    expect(c.stderr).not.toContain("Traceback");
    const errs = objs(c.stderr);
    expect(errs.map((o) => o.code)).toEqual(["uncaught.exception"]);
    expect(String(errs[0]?.problem)).toContain("PermissionError");
    const rec = objs(receiptOf(c).text).find((o) => o.event === "error") as { detail: { traceback: string } };
    expect(rec.detail.traceback).toContain("Traceback");
    expect(violations(c)).toEqual([]);
    expectLoadsClean(c, 1);
  }, SLOW);

  test("PY-4b --help: the command, its success schema and every error type, and the doctor passes", () => {
    const c = example(["files", "--help"]);
    expect(c.status).toBe(0);
    const out = objs(c.stdout);
    expect(out.filter((o) => o.event === "command").map((o) => o.name)).toEqual(["files"]);
    expect(out.filter((o) => o.event === "schema").map((o) => `${o.id}@${o.version}`)).toEqual(["count.result@1.0.0", "parley.error@2.0.0", "parley.startup.failed@1.0.0"]);
    expect(violations(c)).toEqual([]);
    expectLoadsClean(c, 1);
  }, SLOW);

  test("PY-4c the two writers' example tools list the same types under --help, startup.failed among them", () => {
    // flyingrobots/parley#92: count.py and count.ts are the same tool; their discovery must agree.
    const c = example(["files", "--help"]);
    const at = scratch();
    const t = spawnSync("bun", [join(ROOT, "packages", "parley-emit", "examples", "count.ts"), "files", "--help"], { cwd: at.dir, env: { ...process.env, ...at.env }, encoding: "utf8" });
    expect(c.status).toBe(0); expect(t.status).toBe(0);
    const py = objs(c.stdout), ts = objs(t.stdout);
    const emits = (out: Record<string, unknown>[]) => out.filter((o) => o.event === "command").map((o) => o.emits);
    const schemas = (out: Record<string, unknown>[]) => out.filter((o) => o.event === "schema").map((o) => `${o.id}@${o.version}`);
    expect(emits(ts)).toEqual(emits(py));
    expect(schemas(ts)).toEqual(schemas(py));
    expect(schemas(ts)).toContain("parley.error@2.0.0");
    expect(schemas(ts)).toContain("parley.startup.failed@1.0.0");
  }, SLOW);

  test("PY-4a --schema: every message type the writer can emit, and the doctor passes", () => {
    const c = example(["--schema"]);
    expect(c.status).toBe(0);
    const ids = objs(c.stdout).filter((o) => o.event === "schema").map((o) => `${o.id}@${o.version}`);
    for (const want of ["count.result@1.0.0", "parley.error@2.0.0", "parley.run.bootstrap@1.1.1", "parley.receipt.head@2.0.0", "parley.end@1.0.0", "parley.sidecar@1.0.0"]) expect(ids).toContain(want);
    expect(ids).not.toContain("parley.history.transform@1.0.0");
    expect(violations(c)).toEqual([]);
    expectLoadsClean(c, 1);
  }, SLOW);

  test("PY-5a --human: prose on stdout, and the receipt alone passes the doctor", () => {
    const at = scratch();
    const c = example(["files", "--human"], at);
    expect(c.status).toBe(0);
    expect(c.stdout).toBe("2 file(s)\n");
    expect(c.stderr).toBe("");
    const load = expectLoadsClean(c, 1);
    const file = load.bundles[0]?.sources[0]?.receipt;
    expect(file).toBeDefined();
    const vs = doctor({ receipt: readFileSync(file ?? "", "utf8") }, SCHEMAS_DIR);
    expect(vs.filter((v) => v.event === "doctor.violation")).toEqual([]);
    expect(vs.at(-1)).toMatchObject({ event: "doctor.summary", passed: true, status: 0 });
  }, SLOW);

  test("PY-1b every example run in one directory: the loader reads them all clean", () => {
    const at = scratch();
    for (const args of [["files"], ["files", "--frobnicate"], ["files", "--help"], ["--schema"], ["files", "--human"], ["files", "--dry-run"]]) example(args, at);
    // The usage error is a startup failure and leaves no receipt, so five runs left bundles.
    expectLoadsClean({ status: 0, stdout: "", stderr: "", ...at }, 5);
  }, SLOW);
});

describe("parley-emit-py: secrets, the counter and stray output, checked by the doctor", () => {
  const SECRET = "tok-9f8e7d6c5b4a";

  test("PY-6c a declared secret on the command line and in the environment reaches no stream", () => {
    const at = scratch();
    const tool = join(PKG, "tests", "fixtures", "secret_tool.py");
    const argv = py(tool, ["fetch", "--token", SECRET], at);
    const env = py(tool, ["fetch"], at, { SECRET_TOOL_TOKEN: SECRET });
    for (const c of [argv, env]) {
      expect(c.status).toBe(2);
      const { text } = receiptOf(c);
      expect(c.stdout + c.stderr + text).not.toContain(SECRET);
      expect(text).toContain("a library logged the token [redacted]");
      expect(violations(c)).toEqual([]);
      expect((objs(c.stdout).at(-1) as { redacted: boolean }).redacted).toBe(true);
    }
    const head = objs(receiptOf(argv).text)[0] as { argv: string[]; redacted: { argv: number[] } };
    expect(head.argv).toEqual(["secret-tool", "fetch", "--token", "[redacted]"]);
    expect(head.redacted.argv).toEqual([3]);
    expect((objs(receiptOf(env).text)[0] as { redacted: { env: string[] } }).redacted.env).toEqual(["SECRET_TOOL_TOKEN"]);
    expectLoadsClean({ status: 0, stdout: "", stderr: "", ...at }, 2);
  }, SLOW);

  test("PY-23h a result redaction made invalid: the process exits 4, the result reaches no stream, and the doctor passes", () => {
    const c = py(join(PKG, "tests", "fixtures", "typed_secret_tool.py"), ["count", "--token", "867530986753091"], scratch());
    expect(c.status).toBe(4);
    const { text } = receiptOf(c);
    expect(c.stdout + c.stderr + text).not.toContain("867530986753091");
    expect(objs(c.stdout).map((o) => o.event)).toEqual(["run", "end"]);
    expect(objs(c.stdout).at(-1)).toMatchObject({ event: "end", status: 4 });
    expect(objs(c.stderr)).toEqual([expect.objectContaining({ event: "error", code: "redaction.schema_conflict", detail: { schema: { id: "typed-secret-tool.count", version: "1.0.0" }, at: ["/value"], redacted: ["/value"] } })]);
    expect(objs(text).filter((o) => o.event === "result")).toEqual([]);
    const seqs = [...new Set([...objs(c.stdout), ...objs(c.stderr), ...objs(text)].map((o) => o.seq as number))].sort((a, b) => a - b);
    expect(seqs).toEqual(seqs.map((_, i) => i));
    expect(violations(c)).toEqual([]);
  }, SLOW);

  test("PY-24h a result redaction changed under a schema the writer cannot evaluate: the process exits 4 with one redaction.schema_unchecked error, and the doctor passes", () => {
    // The reviewers' variants: `value` is an integer in each, beside one construct outside the checker's subset.
    const variants: Record<string, unknown> = {
      "format date-time": { type: "object", required: ["value"], properties: { value: { type: "integer" }, when: { type: "string", format: "date-time" } } },
      multipleOf: { type: "object", required: ["value"], properties: { value: { type: "integer" }, step: { type: "number", multipleOf: 0.5 } } },
      uniqueItems: { type: "object", required: ["value"], properties: { value: { type: "integer" }, tags: { type: "array", uniqueItems: true } } },
      "$ref into $defs": { type: "object", required: ["value"], properties: { value: { $ref: "#/$defs/n" } }, $defs: { n: { type: "integer" } } },
      "an empty $defs": { type: "object", required: ["value"], properties: { value: { type: "integer" } }, $defs: {} },
    };
    for (const [name, schema] of Object.entries(variants)) {
      const c = py(join(PKG, "tests", "fixtures", "typed_secret_tool.py"), ["count", "--token", "867530986753091"], scratch(), { TYPED_SECRET_SCHEMA: JSON.stringify(schema) });
      expect([name, c.status]).toEqual([name, 4]);
      const { text } = receiptOf(c);
      expect(c.stdout + c.stderr + text).not.toContain("867530986753091");
      expect(objs(c.stdout).map((o) => o.event)).toEqual(["run", "end"]);
      expect(objs(c.stdout).at(-1)).toMatchObject({ event: "end", status: 4 });
      expect(objs(c.stderr)).toEqual([expect.objectContaining({ event: "error", code: "redaction.schema_unchecked", detail: { schema: { id: "typed-secret-tool.count", version: "1.0.0" }, redacted: ["/value"] } })]);
      expect(objs(text).filter((o) => o.event === "result")).toEqual([]);
      const seqs = [...new Set([...objs(c.stdout), ...objs(c.stderr), ...objs(text)].map((o) => o.seq as number))].sort((a, b) => a - b);
      expect(seqs).toEqual(seqs.map((_, i) => i));
      expect(violations(c)).toEqual([]);
    }
  }, SLOW);

  test("PY-7a ten thousand results keep one gapless seq counter, and the doctor passes", () => {
    const at = scratch([]);
    const c = py(join(PKG, "tests", "fixtures", "many.py"), ["emit", "10000"], at);
    expect(c.status).toBe(0);
    const all = [...objs(c.stdout), ...objs(c.stderr), ...objs(receiptOf(c).text)];
    const seqs = [...new Set(all.map((o) => o.seq as number))].sort((a, b) => a - b);
    const final = (objs(c.stdout).at(-1) as { seq: number }).seq;
    expect(seqs).toEqual(Array.from({ length: final + 1 }, (_, i) => i));
    expect(objs(c.stdout).filter((o) => o.event === "result").length).toBe(10_000);
    expect(violations(c)).toEqual([]);
    expectLoadsClean(c, 1);
  }, SLOW);
});

describe("parley-emit-py: the bounded checker against ajv", () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true }); addFormats(ajv);
  const check = (cases: { id: string; version: string; value: unknown }[]) => {
    const prog = `import json, sys\nsys.path.insert(0, ${JSON.stringify(PKG)})\nimport parley_emit as pe\ncases = json.load(sys.stdin)\nprint(json.dumps([pe.check_record(c["value"], pe.schema_for((c["id"], c["version"]))).ok for c in cases]))`;
    const p = spawnSync(PY, ["-c", prog], { input: JSON.stringify(cases), encoding: "utf8", maxBuffer: 1 << 26 });
    expect(p.status, p.stderr).toBe(0);
    return JSON.parse(p.stdout) as boolean[];
  };

  test("PY-17a the verdicts agree on samples of eleven drafts and on every single-field mutation of them", () => {
    const samples: Record<string, unknown>[] = [
      { event: "warning", t: 1, seq: 3, run: "r", code: "a.b", problem: "p", _schema: { id: "parley.warning", version: "1.0.0" } },
      { event: "error", t: 1, seq: 4, run: "r", code: "contrast.unsatisfiable", problem: "p", measured: 5.3, limit: 7, remedy: "x", _schema: { id: "parley.error", version: "2.0.0" } },
      { event: "redaction", t: 1, seq: 6, run: "r", in: 4, at: "/detail/url", _schema: { id: "parley.redaction", version: "1.0.0" } },
      { event: "end", t: 1, seq: 9, run: "r", status: 0, receipt: "/w/r.jsonl", redacted: false, _schema: { id: "parley.end", version: "1.0.0" } },
      { event: "page", t: 1, seq: 7, run: "r", has_more: true, cursor: "c", _schema: { id: "parley.page", version: "1.0.0" } },
      { event: "receipt.step", t: 1, seq: 2, run: "r", decision: "d", because: "b", _schema: { id: "parley.receipt.step", version: "1.0.0" } },
      { event: "sidecar", t: 1, seq: 8, run: "r", source: 7, path: "r/7.json", bytes: 70000, sha256: "a".repeat(64), _schema: { id: "parley.sidecar", version: "1.0.0" } },
      { event: "startup.failed", t: 1, seq: 0, run: "r", tool: "t", v: "1", code: "startup.receipt_unwritable", problem: "p", remedy: "r", _schema: { id: "parley.startup.failed", version: "1.0.0" } },
      { event: "receipt.inputs", t: 1, seq: 5, run: "r", inputs: [{ path: "a", sha256: "b".repeat(64) }, { path: "-", role: "stdin", error: "input.unread" }], _schema: { id: "parley.receipt.inputs", version: "1.0.0" } },
      { event: "run", t: 1, seq: 0, run: "r", tool: "t", v: "1", paths: { receipt: "/w/r.jsonl" }, _schema: { id: "parley.run.bootstrap", version: "1.1.1" } },
      { event: "receipt.head", t: 1, seq: 1, run: "r", tool: "t", v: "1", argv: ["t", "--token", "[redacted]"], resolved: {}, redacted: { argv: [2], resolved: ["/a~1b"] }, inputs: [], _schema: { id: "parley.receipt.head", version: "2.0.0" } },
    ];
    const cases: { id: string; version: string; value: unknown }[] = [];
    for (const s of samples) {
      const { id, version } = s._schema as { id: string; version: string };
      cases.push({ id, version, value: s });
      for (const key of Object.keys(s)) {
        if (key === "_schema") continue;
        const { [key]: _dropped, ...without } = s;
        for (const v of [undefined, null, 12345, -1, "x", "", 1.5, true, [], {}, "a\n"]) cases.push({ id, version, value: v === undefined ? without : { ...s, [key]: v } });
      }
    }
    const got = check(cases);
    const schemaOf = (c: { id: string; version: string }) => {
      const found = SCHEMAS.find((s) => s.id === c.id && s.version === c.version);
      if (!found) throw new Error(`no shipped schema for ${c.id}@${c.version}`);
      return found.schema;
    };
    const want = cases.map((c) => Boolean(ajv.validate(schemaOf(c), c.value)));
    const disagreements = cases.map((c, i) => ({ c, py: got[i], ajv: want[i] })).filter((x) => x.py !== x.ajv);
    expect(disagreements).toEqual([]);
    expect(cases.length).toBeGreaterThan(700);
  }, SLOW);
});

describe("parley-emit-py: identity and vendoring", () => {
  test("PY-15e the same preimage gives the same inv in both writers", () => {
    const preimages = [
      { tool: "count", v: "0.1.0", command: "files", resolved: { command: "files", args: [] }, inputs: [] },
      { tool: "t", v: "1.2.3", command: "c", resolved: { z: 1, a: [true, null, "é ☃ 😀"], m: { "a/b": 2.5, "~": "[redacted]" } }, inputs: [{ path: "a.txt", sha256: "c".repeat(64) }, { path: "-", role: "stdin", sha256: "d".repeat(64) }] },
    ];
    const prog = `import json, sys\nsys.path.insert(0, ${JSON.stringify(PKG)})\nimport parley_emit as pe\nprint(json.dumps([pe.compute_inv(p["tool"], p["v"], p["command"], p["resolved"], p["inputs"]) for p in json.load(sys.stdin)]))`;
    const p = spawnSync(PY, ["-c", prog], { input: JSON.stringify(preimages), encoding: "utf8" });
    expect(p.status, p.stderr).toBe(0);
    expect(JSON.parse(p.stdout)).toEqual(preimages.map((x) => computeInv(x)));
  }, SLOW);

  test("PY-19a --vendor-info is one line valid against its schema, naming the file's own digest", () => {
    const p = spawnSync(PY, [join(PKG, "parley_emit.py"), "--vendor-info"], { encoding: "utf8" });
    expect(p.status).toBe(0);
    expect(p.stderr).toBe("");
    const lines = objs(p.stdout);
    expect(lines.length).toBe(1);
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(JSON.parse(readFileSync(join(PKG, "vendor-info.schema.json"), "utf8")));
    expect(validate(lines[0]), JSON.stringify(validate.errors)).toBe(true);
    expect(lines[0]?.sha256).toBe(createHash("sha256").update(readFileSync(join(PKG, "parley_emit.py"))).digest("hex"));
    for (const args of [["--help"], ["--nope"]]) {
      const q = spawnSync(PY, [join(PKG, "parley_emit.py"), ...args], { encoding: "utf8" });
      for (const l of objs(q.stdout + q.stderr)) expect(validate(l), JSON.stringify(validate.errors)).toBe(true);
    }
  }, SLOW);

  test("PY-21e both writers select the same command and pass the same arguments", () => {
    // flyingrobots/parley#101: one two-command tool written against each writer, run as real processes.
    const dir = mkdtempSync(join(tmpdir(), "parley-py-select-"));
    const decl = "{'intent': 'x', 'effects': {'reads': [], 'writes': [], 'network': False, 'idempotent': True}, 'secrets': [], 'emits': [{'id': 'sel.args', 'version': '1.0.0'}]}";
    writeFileSync(join(dir, "sel.py"), [
      "import sys",
      `sys.path.insert(0, ${JSON.stringify(PKG)})`,
      "import parley_emit as pe",
      `tool = pe.define_tool(name='sel', version='0.0.1', commands={'plan': ${decl}, 'edit': ${decl}}, retention={'count': 50})`,
      "sys.exit(pe.main(tool, ['sel', *sys.argv[1:]], lambda run, args: run.result({'event': 'result', 'args': args}, ('sel.args', '1.0.0')), resolved=lambda args, c: {'command': c, 'args': args}))",
      "",
    ].join("\n"));
    const tsDecl = "{ intent: 'x', effects: { reads: [], writes: [], network: false, idempotent: true }, secrets: [], emits: [{ id: 'sel.args', version: '1.0.0' }] }";
    writeFileSync(join(dir, "sel.ts"), [
      `import { defineTool, main } from ${JSON.stringify(join(ROOT, "packages", "parley-emit", "src", "index.ts"))};`,
      `const tool = defineTool({ name: 'sel', version: '0.0.1', commands: { plan: ${tsDecl}, edit: ${tsDecl} }, retention: { count: 50 } });`,
      "process.exitCode = await main(tool, ['sel', ...process.argv.slice(2)], (run, args) => { run.result({ event: 'result', args }, { id: 'sel.args', version: '1.0.0' }); }, { resolved: (args, command) => ({ command, args }) });",
      "",
    ].join("\n"));
    const seen = (p: ReturnType<typeof spawnSync>) => {
      const out = objs(String(p.stdout)), err = objs(String(p.stderr));
      const boot = out[0] as { paths?: { receipt?: string } } | undefined;
      const head = boot?.paths?.receipt ? objs(readFileSync(boot.paths.receipt, "utf8"))[0] : undefined;
      return { status: p.status, resolved: head?.resolved, results: out.filter((o) => o.event === "result").map((o) => o.args), codes: err.map((o) => o.code) };
    };
    const cases = [["edit", "--reason", "edit"], ["edit", "--reason", "plan"], ["--reason", "plan", "edit"], ["--dry-run", "edit", "--reason", "edit"]];
    const expected = [
      { status: 0, resolved: { command: "edit", args: ["--reason", "edit"] }, results: [["--reason", "edit"]], codes: [] },
      { status: 0, resolved: { command: "edit", args: ["--reason", "plan"] }, results: [["--reason", "plan"]], codes: [] },
      { status: 3, resolved: undefined, results: [], codes: ["startup.unknown_command"] },
      { status: 0, resolved: { command: "edit", args: ["--reason", "edit"] }, results: [["--reason", "edit"]], codes: [] },
    ];
    cases.forEach((argv, i) => {
      const at = scratch([]);
      const env = { ...process.env, ...at.env };
      const p = seen(spawnSync(PY, [join(dir, "sel.py"), ...argv], { cwd: at.dir, env, encoding: "utf8" }));
      const t = seen(spawnSync("bun", [join(dir, "sel.ts"), ...argv], { cwd: at.dir, env, encoding: "utf8" }));
      expect(p, JSON.stringify(argv)).toEqual(expected[i]!);
      expect(t, JSON.stringify(argv)).toEqual(p);
    });
  }, SLOW);

  test("PY-22f both writers end their flags at the first --", () => {
    // flyingrobots/parley#103: one two-command tool written against each writer, run as real processes on the same argv.
    const dir = mkdtempSync(join(tmpdir(), "parley-py-dash-"));
    const decl = "{'intent': 'x', 'effects': {'reads': [], 'writes': [], 'network': False, 'idempotent': True}, 'secrets': [], 'emits': [{'id': 'sel.args', 'version': '1.0.0'}]}";
    writeFileSync(join(dir, "sel.py"), [
      "import sys",
      `sys.path.insert(0, ${JSON.stringify(PKG)})`,
      "import parley_emit as pe",
      `tool = pe.define_tool(name='sel', version='0.0.1', commands={'plan': ${decl}, 'edit': ${decl}}, retention={'count': 50})`,
      "sys.exit(pe.main(tool, ['sel', *sys.argv[1:]], lambda run, args: run.result({'event': 'result', 'args': args}, ('sel.args', '1.0.0')), resolved=lambda args, c: {'command': c, 'args': args}))",
      "",
    ].join("\n"));
    const tsDecl = "{ intent: 'x', effects: { reads: [], writes: [], network: false, idempotent: true }, secrets: [], emits: [{ id: 'sel.args', version: '1.0.0' }] }";
    writeFileSync(join(dir, "sel.ts"), [
      `import { defineTool, main } from ${JSON.stringify(join(ROOT, "packages", "parley-emit", "src", "index.ts"))};`,
      `const tool = defineTool({ name: 'sel', version: '0.0.1', commands: { plan: ${tsDecl}, edit: ${tsDecl} }, retention: { count: 50 } });`,
      "process.exitCode = await main(tool, ['sel', ...process.argv.slice(2)], (run, args) => { run.result({ event: 'result', args }, { id: 'sel.args', version: '1.0.0' }); }, { resolved: (args, command) => ({ command, args }) });",
      "",
    ].join("\n"));
    const seen = (p: ReturnType<typeof spawnSync>) => {
      const out = objs(String(p.stdout));
      const boot = out[0] as { paths?: { receipt?: string } } | undefined;
      const head = boot?.paths?.receipt ? objs(readFileSync(boot.paths.receipt, "utf8"))[0] : undefined;
      return { status: p.status, described: out.filter((o) => o.event === "command").map((o) => o.name), resolved: head?.resolved, results: out.filter((o) => o.event === "result").map((o) => o.args) };
    };
    const cases = [["edit", "--note", "-h"], ["edit", "--", "--note", "-h"], ["edit", "--"], ["edit", "--", "a", "--", "b"]];
    const expected = [
      { status: 0, described: ["edit"], resolved: { discovery: "help", command: "edit" }, results: [] },
      { status: 0, described: [], resolved: { command: "edit", args: ["--note", "-h"] }, results: [["--note", "-h"]] },
      { status: 0, described: [], resolved: { command: "edit", args: [] }, results: [[]] },
      { status: 0, described: [], resolved: { command: "edit", args: ["a", "--", "b"] }, results: [["a", "--", "b"]] },
    ];
    cases.forEach((argv, i) => {
      const at = scratch([]);
      const env = { ...process.env, ...at.env };
      const p = seen(spawnSync(PY, [join(dir, "sel.py"), ...argv], { cwd: at.dir, env, encoding: "utf8" }));
      const t = seen(spawnSync("bun", [join(dir, "sel.ts"), ...argv], { cwd: at.dir, env, encoding: "utf8" }));
      expect(p, JSON.stringify(argv)).toEqual(expected[i]!);
      expect(t, JSON.stringify(argv)).toEqual(p);
    });
  }, SLOW);

  test("PY-19b a vendored copy alone in a directory runs a tool the doctor passes", () => {
    const at = scratch();
    const vendor = mkdtempSync(join(tmpdir(), "parley-py-vendor-"));
    writeFileSync(join(vendor, "parley_emit.py"), readFileSync(join(PKG, "parley_emit.py")));
    writeFileSync(join(vendor, "tool.py"), [
      "import sys, os",
      "sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))",
      "import parley_emit as pe",
      "tool = pe.define_tool(name='vendored', version='0.0.1', commands={'go': {'intent': 'Say it works', 'effects': {'reads': [], 'writes': [], 'network': False, 'idempotent': True}, 'secrets': [], 'emits': [{'id': 'vendored.ok', 'version': '1.0.0'}]}}, retention={'count': 5})",
      "sys.exit(pe.main(tool, ['vendored', *sys.argv[1:]], lambda run, args: run.result({'event': 'result', 'ok': True}, ('vendored.ok', '1.0.0'))))",
      "",
    ].join("\n"));
    const c = spawnSync(PY, ["-I", join(vendor, "tool.py"), "go"], { cwd: at.dir, env: { ...process.env, ...at.env }, encoding: "utf8" });
    const cap: Captured = { status: c.status, stdout: c.stdout, stderr: c.stderr, ...at };
    expect(cap.status).toBe(0);
    expect(violations(cap)).toEqual([]);
    expectLoadsClean(cap, 1);
  }, SLOW);
});

describe("parley-emit-py: the two writers read a .gitignore negation alike, and neither stays where git stages", () => {
  // PY-12f / PE-6g (spec §5.2). For each generated negation line: the TypeScript writer's verdict
  // and the Python writer's are the same, and wherever real git would stage a file under
  // `.parley/receipts/` (with `*` in force and the files re-included), the verdict is "matches".
  const TARGET = "receipts";
  const classes = (c: string): string[] => {
    const up = c.toUpperCase(), before = String.fromCharCode(c.charCodeAt(0) - 2), after = String.fromCharCode(c.charCodeAt(0) + 2);
    return [
      `[${c}]`, `[${up}]`, `[^x]`, `[!x]`, `[^${c}]`, `[!${c}]`, `[]${c}]`, `[^]]`, `[!]]`, `[]]`, `[${before}-${after}]`, `[${after}-${before}]`,
      `[${c}-]`, `[-${c}]`, `[a-${before}-${c}]`, `[!-${c}]`, `[^-]`, `[]-a]`, `[--${after}]`, `[%-${after}]`, `[[:alpha:]]`, `[^[:digit:]]`, `[[:lower:]_]`,
      `[_[:lower:]]`, `[[=${c}=]]`, `[[.${c}.]]`, `[[]`, `[[${c}]`, `[${c}[]`, `[]`, `[^]`, `[!]`, `[`, `]`, `[${c}`, `[^${c}`, `[\\${c}]`, `[${c}\u0000]`, `?`, `*`, `**`, `{${c}}`, `ſ`, `K`, `\t`, " ",
    ];
  };
  const lines: string[] = [];
  for (const at of [0, 3, TARGET.length - 1]) for (const k of classes(TARGET[at]!)) lines.push(`!${TARGET.slice(0, at)}${k}${TARGET.slice(at + 1)}`);
  lines.push("!receipts", "!receipts/", "!/receipts", "!**/receipts", "!**/receipts/**", "!a/receipts", "!receipts ", "! receipts", "!Receipts", "!RECEIPTS", "!r*", "!*s", "!r*s", "!r**s", "!????????", "!?????????", "!???????", "!", "!!receipts", "receipts", "#!receipts", "\\!receipts", "!receipts\u0000", "!receipts\u0000x", "!rece\u0000ipts", "\u0000!receipts", "!keep", "!*.jsonl", "!receipts\r", "!receipt", "!receiptss");

  const tsVerdicts = async (): Promise<boolean[]> => {
    const { negationReachesReceipts } = await import("../../parley-emit/src/location.ts") as { negationReachesReceipts?: (line: string) => boolean };
    expect(typeof negationReachesReceipts).toBe("function");
    return lines.map((l) => negationReachesReceipts!(l));
  };
  const pyVerdicts = (): boolean[] => {
    const prog = `import json, sys\nsys.path.insert(0, ${JSON.stringify(PKG)})\nimport parley_emit as pe\nprint(json.dumps([pe._negation_reaches_receipts(l) for l in json.load(sys.stdin)]))`;
    const p = spawnSync(PY, ["-c", prog], { input: JSON.stringify(lines), encoding: "utf8" });
    expect(p.status, p.stderr).toBe(0);
    expect(p.stderr).toBe("");
    return JSON.parse(p.stdout) as boolean[];
  };

  test("PY-12f the verdicts agree on every generated line", async () => {
    const ts = await tsVerdicts(), py = pyVerdicts();
    expect(lines.map((l, i) => [l, py[i]])).toEqual(lines.map((l, i) => [l, ts[i]]));
    // The table is not vacuous: both verdicts occur.
    expect(new Set(ts).size).toBe(2);
  });

  const GIT_ENV = { PATH: process.env.PATH ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: tmpdir() };
  const hasGit = spawnSync("git", ["--version"], { env: GIT_ENV }).status === 0;
  test.skipIf(!hasGit)("PY-12g wherever real git would stage a receipt, both verdicts are 'matches'", async () => {
    const repo = mkdtempSync(join(tmpdir(), "parley-gitignore-oracle-"));
    expect(spawnSync("git", ["-C", repo, "init", "-q"], { env: GIT_ENV }).status).toBe(0);
    mkdirSync(join(repo, ".parley", "receipts"), { recursive: true });
    writeFileSync(join(repo, ".parley", "receipts", "01PROBE.jsonl"), "{}\n");
    const ts = await tsVerdicts(), py = pyVerdicts();
    let staged = 0;
    lines.forEach((line, i) => {
      // A line break inside the generated line would be a different file; none is generated.
      writeFileSync(join(repo, ".parley", ".gitignore"), `*\n${line}\n!*.jsonl\n`);
      const p = spawnSync("git", ["-C", repo, "add", "-A", "-n", "."], { env: GIT_ENV, encoding: "utf8" });
      expect(p.status, p.stderr).toBe(0);
      if (!p.stdout.includes("receipts/01PROBE.jsonl")) return;
      staged += 1;
      expect([line, "ts", ts[i]]).toEqual([line, "ts", true]);
      expect([line, "py", py[i]]).toEqual([line, "py", true]);
    });
    expect(staged).toBeGreaterThan(20);
  }, SLOW);
});

describe("parley-emit-py: the two checkers on patterns and malformed keywords", () => {
  // PY-25e / PE-31e (spec §5.3). The writers may differ on which schemas they can evaluate; they
  // may not differ on a verdict, and neither may answer for a pattern its engine reads otherwise.
  const PATTERNS = [
    "^a.c$", "^a$", "^\\s+$", "^\\S+$", "^[\\s]$", "^[^\\s]$", "^\\d+$", "^\\D$", "^\\w+$", "^\\W$", "\\bfoo\\b", "\\Bfoo", "^[a-c]+$", "^[^a-c]$", "^[\\]\\-\\\\]+$", "^[[]$",
    "^a\\/b$", "^\\u0041\\x42\\u{43}$", "^\\u{1F600}$", "^.$", "^\\cJ$", "^[\\b]$", "^\\0$", "^a{2,3}?$", "^a{2,}$", "^(?:a|b)+?c$", "^(?!/)(?!.*(^|/)\\.\\.(/|$)).+$",
    "(?<=a)b", "(?<!a)b", "^[a-z]{3}-[0-9]+$", "^#$", "^ $", "^[-a]$", "^[a-]$", "^[&&]$", "^[a~~b]$", "^[a||b]$", "^[a--b]$", "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$", "^[0-9a-f]{4}$",
    "a|b|", "^$", "", "^\\t\\n\\r\\f\\v$", "^[\\t\\n]$", "^\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]$", "^[.*+?^${}()|/]$", "^x*?y+?z??$", "(a(b(c)))", "^(a|)$", "^\\x41$",
    // Read differently by Python's `re`, or valid only in ECMAScript: Python must say unsupported.
    "^\\p{Lu}", "\\P{L}", "(?<=Z.*)d", "(?<year>[0-9]{4})", "(a)\\1", "[^]", "[]", "[\\S]", "[\\D\\d]x{2}(?<n>a)\\k<n>", "\\ud83d\\ude00",
    // Not ECMAScript with the `u` flag, or an inline flag: both must say unsupported.
    "(?i)^zed", "^(?i:zed)", "(?-i:a)", "(?s:a)", "^Z(", "a{,3}", "a**", "a*+", "a{2}{3}", "(?=a)+", "\\-", "\\a", "\\Z", "\\A", "(?#c)", "(?P<n>a)", "a{2", "a}", "a]", "\\07", "\\x4",
    "\\u12", "\\u{110000}", "[z-a]", "[\\d-x]", "a)", "*a", "a|*", "^*", "\\c1", "\\", "{", "a{1,2,3}", "a{3,1}", "(?<!a*)b",
  ];
  const VALUES = ["", "a", "abc", "a\nc", "a c", "a\n", " ", "﻿", "\u001c", "\u0085", " ", "\t", "x", "٣", "é", "a_9", "d", "]-\\", "[", "a/b", "ABC", "\u{1F600}", "\n", "\b", "a foo b", "foo", "\u0000", "aa", "aaa", "abac", "a/../b", "ab", "b", "abc-12", "#", "-", "&", "~", "|", "1.0", "01.0", "beef", "Zed", "zed", "Zd", "\t\n\r\f\v", ".*+?^${}()|[]", "A", "xyz", "é", "aé"];
  const SHAPES: Record<string, unknown>[] = [
    { enum: 5 }, { enum: {} }, { enum: [] }, { required: "a" }, { required: [5] }, { required: [] }, { properties: [] }, { properties: 5 }, { properties: { a: 5 } }, { type: 5 }, { type: "text" }, { type: [] }, { type: ["string", 5] },
    { type: ["string", "null"] }, { minLength: "3" }, { minLength: -1 }, { minLength: 1.5 }, { minLength: 2.0 }, { maxLength: true }, { minItems: null }, { maxItems: [] }, { minProperties: {} }, { maxProperties: 1e400 }, { minimum: "0" }, { maximum: true },
    { exclusiveMinimum: null }, { exclusiveMaximum: [] }, { minimum: 1.5 }, { pattern: 5 }, { pattern: null }, { format: 5 }, { format: ["json-pointer"] }, { format: "json-pointer" }, { anyOf: {} }, { anyOf: [] }, { allOf: 5 }, { oneOf: "x" }, { oneOf: [5] },
    { items: 5 }, { items: [] }, { items: null }, { not: null }, { not: 5 }, { if: "x" }, { then: 5 }, { else: [] }, { additionalProperties: "no" }, { additionalProperties: null }, { const: null }, { const: { a: [1] } }, { description: 5, title: [], default: null, examples: 7 },
  ];
  const SHAPE_VALUES: unknown[] = ["abc", 1, 1.5, null, true, [], ["a"], {}, { a: 1 }];

  const { checkRecord } = require("../../parley-emit/src/index.ts") as typeof import("../../parley-emit/src/index.ts");
  type Verdict = "ok" | "no" | "unsupported";
  const tsVerdict = (value: unknown, schema: unknown): Verdict => { const v = checkRecord(value, schema); return v.ok ? "ok" : "unsupported" in v ? "unsupported" : "no"; };
  const pyVerdicts = (cases: { value: unknown; schema: unknown }[]): Verdict[] => {
    const prog = `import json, sys, warnings\nwarnings.simplefilter("error")\nsys.path.insert(0, ${JSON.stringify(PKG)})\nimport parley_emit as pe\ndef v(c):\n    r = pe.check_record(c["value"], c["schema"])\n    return "ok" if r.ok else ("unsupported" if r.unsupported is not None else "no")\nprint(json.dumps([v(c) for c in json.load(sys.stdin)]))`;
    const p = spawnSync(PY, ["-c", prog], { input: JSON.stringify(cases), encoding: "utf8", maxBuffer: 1 << 26 });
    expect(p.status, p.stderr).toBe(0);
    expect(p.stderr).toBe("");
    return JSON.parse(p.stdout) as Verdict[];
  };

  test("PY-25e on every pattern and value: Python evaluates only what TypeScript evaluates, the verdicts then agree, and TypeScript's is the engine's own", () => {
    const cases = PATTERNS.flatMap((pattern) => VALUES.map((value) => ({ value, schema: { type: "string", pattern } })));
    const py = pyVerdicts(cases);
    let both = 0, pyOnlyRefuses = 0, bothRefuse = 0;
    cases.forEach((c, i) => {
      const ts = tsVerdict(c.value, c.schema), pattern = c.schema.pattern;
      let engine: Verdict;
      try { engine = /\(\?[A-Za-z-]/.test(pattern) ? "unsupported" : new RegExp(pattern, "u").test(c.value) ? "ok" : "no"; } catch { engine = "unsupported"; }
      expect([pattern, c.value, "ts", ts]).toEqual([pattern, c.value, "ts", engine]);
      if (py[i] === "unsupported") { if (ts === "unsupported") bothRefuse += 1; else pyOnlyRefuses += 1; return; }
      both += 1;
      expect([pattern, c.value, "py", py[i]]).toEqual([pattern, c.value, "py", ts]);
    });
    expect(both).toBeGreaterThan(1000);
    expect(pyOnlyRefuses).toBeGreaterThan(100);
    expect(bothRefuse).toBeGreaterThan(500);
  });

  test("PY-25f on keywords whose value has the wrong shape, and their well-formed neighbours, the two checkers give one verdict", () => {
    const cases = SHAPES.flatMap((schema) => SHAPE_VALUES.map((value) => ({ value, schema })));
    // JSON cannot carry 1e400; the TypeScript side sees Infinity and the Python side null, both of which are refused.
    const py = pyVerdicts(cases);
    const ts = cases.map((c) => tsVerdict(c.value, c.schema));
    expect(cases.map((c, i) => [JSON.stringify(c.schema), JSON.stringify(c.value), py[i]])).toEqual(cases.map((c, i) => [JSON.stringify(c.schema), JSON.stringify(c.value), ts[i]]));
    expect(new Set(ts)).toEqual(new Set<Verdict>(["ok", "no", "unsupported"]));
  });
});

describe("parley-emit-py: a secret that coincides with one of the writer's own words", () => {
  // PY-26 (spec §5.3): `--token create` beside the bookkeeping `op` `create`. Every line of every
  // run is validated against the RELEASED snapshot of its exact pair with ajv.
  const RELEASED = join(SCHEMAS_DIR, "released");
  const ajv = new Ajv2020({ strict: false, allErrors: true }); addFormats(ajv);
  const validators = new Map<string, ReturnType<typeof ajv.compile>>();
  const invalid = (o: Record<string, unknown>): string | null => {
    const stamp = o._schema as { id: string; version: string };
    const file = join(RELEASED, stamp.id, `${stamp.version}.schema.json`);
    if (!existsSync(file)) { expect(stamp.id.startsWith("parley.")).toBe(false); return null; }
    const key = `${stamp.id}@${stamp.version}`;
    if (!validators.has(key)) validators.set(key, ajv.compile(JSON.parse(readFileSync(file, "utf8")) as object));
    const v = validators.get(key)!;
    return v(o) ? null : `${key} ${ajv.errorsText(v.errors)}: ${JSON.stringify(o)}`;
  };
  const neutral = (secret: string) => {
    for (let i = 0; i < 64; i++) { const at = scratch(["a.txt"]); if (!at.dir.includes(secret) && !at.env.XDG_STATE_HOME!.includes(secret)) return at; }
    throw new Error(`no temporary directory free of ${secret} could be made`);
  };

  test("PY-26a under --help, --schema and an ordinary command, every line validates against its released snapshot", () => {
    for (const secret of ["create", "delete", "append", "stdin", "tree", "true", "unreadable", "input", "op", "scope", "paths", "tool", "code", "status", "effects", "inputs", "argv", "/zq", "zq7kx9control"]) {
      for (const mode of [["--help"], ["--schema"], []]) {
        const c = py(join(PKG, "tests", "fixtures", "coincide_tool.py"), ["count", ...mode, "--token", secret], neutral(secret));
        expect([secret, mode, c.status]).toEqual([secret, mode, 0]);
        const lines = [...objs(c.stdout), ...objs(c.stderr), ...objs(receiptOf(c).text)];
        expect(lines.length).toBeGreaterThan(4);
        expect([secret, mode, lines.map(invalid).filter((x) => x !== null)]).toEqual([secret, mode, []]);
        expect(violations(c)).toEqual([]);
      }
    }
  }, SLOW);
});

describe("parley-emit-py: a record the writer raises on its own account, and a main that always ends the run", () => {
  // PY-28 (spec §3.3, §5.3, flyingrobots/parley#161): tests/fixtures/own_records_tool.py as a
  // real process, with a declared secret equal to each field name of the writer's own records.
  // Every line of every run is validated against the RELEASED snapshot of its exact pair with ajv.
  const RELEASED = join(SCHEMAS_DIR, "released");
  const ajv = new Ajv2020({ strict: false, allErrors: true }); addFormats(ajv);
  const validators = new Map<string, ReturnType<typeof ajv.compile>>();
  const invalid = (o: Record<string, unknown>): string | null => {
    const stamp = o._schema as { id: string; version: string };
    const file = join(RELEASED, stamp.id, `${stamp.version}.schema.json`);
    if (!existsSync(file)) { expect(stamp.id.startsWith("parley.")).toBe(false); return null; }
    const key = `${stamp.id}@${stamp.version}`;
    if (!validators.has(key)) validators.set(key, ajv.compile(JSON.parse(readFileSync(file, "utf8")) as object));
    const v = validators.get(key)!;
    return v(o) ? null : `${key} ${ajv.errorsText(v.errors)}: ${JSON.stringify(o)}`;
  };
  const neutral = (secret: string) => {
    for (let i = 0; i < 64; i++) { const at = scratch([]); if (!at.dir.includes(secret) && !at.env.XDG_STATE_HOME!.includes(secret)) return at; }
    throw new Error(`no temporary directory free of ${secret} could be made`);
  };
  const FIXTURE = join(PKG, "tests", "fixtures", "own_records_tool.py");
  const CONTROL = "zq7kx9control";
  const SECRETS = ["code", "problem", "remedy", "decision", "because", "detail", "event", "status", "uncaught.exception", "boom", "traceback", "stream", "text", CONTROL];
  // The tool's own step is scrubbed in full: under these two its field is renamed and it is withheld (§5.3).
  const TOOL_STEP_WITHHELD = new Set(["decision", "because"]);
  /** A real process: the exit status is an integer, stdout ends with a newline-terminated `end` carrying it, stderr is JSON Lines only, and every line validates. */
  const settled = (c: Captured, secret: string, mode: string, status: number) => {
    expect([secret, mode, c.status]).toEqual([secret, mode, status]);
    expect(c.stdout.endsWith("\n")).toBe(true);
    expect(objs(c.stdout).at(-1)).toMatchObject({ event: "end", status });
    const lines = [...objs(c.stdout), ...objs(c.stderr), ...objs(receiptOf(c).text)];
    expect([secret, mode, lines.map(invalid).filter((x) => x !== null)]).toEqual([secret, mode, []]);
    expect(violations(c)).toEqual([]);
    return objs(receiptOf(c).text);
  };

  test("PY-28a a handler that raises, alone and after a step of its own, under each secret", () => {
    for (const secret of SECRETS) {
      const alone = py(FIXTURE, ["count", "throw", "--token", secret], neutral(secret));
      settled(alone, secret, "throw", 2);
      expect([secret, objs(alone.stderr).map((o) => [o.code, o.problem])]).toEqual([secret, [["uncaught.exception", secret === "boom" ? "uncaught RuntimeError: [redacted]" : "uncaught RuntimeError: boom"]]]);
      if (secret === "boom" || secret === CONTROL) expect(alone.stdout + alone.stderr + receiptOf(alone).text).not.toContain(secret);

      const after = py(FIXTURE, ["count", "step-throw", "--token", secret], neutral(secret));
      const withheld = TOOL_STEP_WITHHELD.has(secret);
      const receipt = settled(after, secret, "step-throw", withheld ? 4 : 2);
      expect([secret, objs(after.stderr).map((o) => o.code)]).toEqual([secret, [withheld ? "redaction.schema_conflict" : "uncaught.exception"]]);
      expect([secret, receipt.filter((o) => o.event === "receipt.step").map((o) => [o.decision, o.because])]).toEqual([secret, withheld ? [] : [["d", "b"]]]);
    }
  }, SLOW);

  test("PY-28b the writer's retention step and its captured-output step under each secret: status 0", () => {
    for (const secret of SECRETS) {
      const at = neutral(secret);
      expect(py(FIXTURE, ["count", "quiet"], at).status).toBe(0);
      const kept = py(FIXTURE, ["count", "quiet", "--token", secret], at);
      const retained = settled(kept, secret, "quiet", 0);
      expect(kept.stderr).toBe("");
      expect([secret, retained.filter((o) => o.event === "receipt.step").map((o) => o.decision)]).toEqual([secret, ["retention: deleted 1 receipt bundle(s)"]]);

      const printed = py(FIXTURE, ["count", "print", "--token", secret], neutral(secret));
      const receipt = settled(printed, secret, "print", 0);
      expect(printed.stderr).toBe("");
      expect([secret, receipt.filter((o) => o.event === "receipt.step").map((o) => [o.decision, o.detail])]).toEqual([secret, [["captured stray output", { stream: "stdout", text: "a library says [redacted]\n" }]]]);
    }
  }, SLOW);
});
