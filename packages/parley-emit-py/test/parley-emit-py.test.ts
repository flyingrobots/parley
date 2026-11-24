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
    const c = py(join(PKG, "tests", "fixtures", "typed_secret_tool.py"), ["count", "--token", "8675309"], scratch());
    expect(c.status).toBe(4);
    const { text } = receiptOf(c);
    expect(c.stdout + c.stderr + text).not.toContain("8675309");
    expect(objs(c.stdout).map((o) => o.event)).toEqual(["run", "end"]);
    expect(objs(c.stdout).at(-1)).toMatchObject({ event: "end", status: 4 });
    expect(objs(c.stderr)).toEqual([expect.objectContaining({ event: "error", code: "redaction.schema_conflict", detail: { schema: { id: "typed-secret-tool.count", version: "1.0.0" }, at: ["/value"], redacted: ["/value"] } })]);
    expect(objs(text).filter((o) => o.event === "result")).toEqual([]);
    const seqs = [...new Set([...objs(c.stdout), ...objs(c.stderr), ...objs(text)].map((o) => o.seq as number))].sort((a, b) => a - b);
    expect(seqs).toEqual(seqs.map((_, i) => i));
    expect(violations(c)).toEqual([]);
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
