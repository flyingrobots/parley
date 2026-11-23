// Invariants every schema under schemas/ must hold, independent of any example.
// These are the spec's own rules (§1.3, §4.5) stated as tests, so a future schema cannot drift.
import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { check } from "./check-examples.ts";

import { schemaFiles, loadSchemas } from "./check-examples.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Drafts at the top level and released snapshots under released/<id>/<version>.schema.json (spec §4.6).
const paths = schemaFiles("schemas");
const files = paths.map((p) => p.replace(/^schemas\//, ""));
const load = (f: string) => JSON.parse(readFileSync(`schemas/${f}`, "utf8"));
// The id a file's location promises: the basename for a draft, the parent directory for a snapshot.
const idOf = (f: string) => f.startsWith("released/") ? f.split("/")[1] : f.replace(/\.schema\.json$/, "");
const versionOf = (f: string) => f.startsWith("released/") ? f.split("/")[2].replace(/\.schema\.json$/, "") : null;

function walk(node: unknown, path: string, visit: (n: Record<string, unknown>, p: string) => void) {
  if (node && typeof node === "object" && !Array.isArray(node)) {
    visit(node as Record<string, unknown>, path);
    for (const [k, v] of Object.entries(node)) walk(v, `${path}/${k}`, visit);
  }
}

describe("schemas/", () => {
  test("there is at least one schema", () => expect(files.length).toBeGreaterThan(0));

  for (const f of files) {
    const s = load(f);
    const id = idOf(f);
    const m = /\/schemas\/([^/]+)\/(\d+)\.(\d+)\.(\d+)$/.exec(String(s.$id));

    test(`${f}: $id names its own location and a SemVer version`, () => {
      expect(m).not.toBeNull();
      expect(m![1]).toBe(id);
      const v = versionOf(f);
      if (v) expect(`${m![2]}.${m![3]}.${m![4]}`).toBe(v);
    });

    test(`${f}: compiles under strict ajv and meta-validates`, () => {
      const ajv = new Ajv2020({ strict: true, allErrors: true });
      addFormats(ajv);
      expect(ajv.validateSchema(s)).toBe(true);
      expect(() => ajv.compile(s)).not.toThrow();
    });

    test(`${f}: envelope fields are required (§1.3)`, () => {
      for (const k of ["event", "t", "seq", "run", "_schema"]) expect(s.required).toContain(k);
    });

    test(`${f}: _schema pins id and the exact version by const (§4.5)`, () => {
      const sch = s.properties._schema;
      expect(sch.additionalProperties).toBe(false);
      expect(sch.properties.id.const).toBe(id);
      expect(sch.properties.version.const).toBe(`${m![2]}.${m![3]}.${m![4]}`);
    });

    test(`${f}: open everywhere except _schema (§4.5)`, () => {
      walk(s, "", (n, p) => {
        if (n.additionalProperties === false) expect(p).toBe("/properties/_schema");
      });
    });

    test(`${f}: t is a non-negative integer and identities are non-empty (§1.3, §2.1)`, () => {
      expect(s.properties.t.minimum).toBe(0);
      for (const k of ["run", "tool", "v", "inv", "session"]) if (s.properties[k]) expect(s.properties[k].minLength).toBe(1);
    });

    test(`${f}: seq is const 0 only for the bootstrap and startup-failure lines, otherwise minimum 1 (§1.3)`, () => {
      const seq = s.properties.seq;
      if (s.properties.event?.const === "run" || s.properties.event?.const === "startup.failed") expect(seq.const).toBe(0);
      else {
        expect(seq.const).toBeUndefined();
        expect(seq.minimum).toBeGreaterThanOrEqual(1);
      }
    });
  }

  test("the receipt head names its tool and version (§5)", () => {
    const s = load("parley.receipt.head.schema.json");
    expect(s.required).toContain("tool");
    expect(s.required).toContain("v");
  });

  test("the error code is a dotted identifier and the problem is non-empty (§6)", () => {
    const s = load("parley.error.schema.json");
    expect(s.properties.code.pattern).toBeDefined();
    expect(s.properties.problem.minLength).toBe(1);
  });

  describe("constraints reject what the spec forbids", () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(ajv);
    const validate = (f: string) => ajv.compile(load(f));
    const error = validate("parley.error.schema.json");
    const head = validate("parley.receipt.head.schema.json");
    const boot = validate("parley.run.bootstrap.schema.json");
    const okError = { event: "error", t: 1, seq: 4, run: "r", code: "a.b", problem: "p", _schema: { id: "parley.error", version: "2.0.0" } };
    const okHead = { event: "receipt.head", t: 1, seq: 1, run: "r", tool: "x", v: "1", inv: "i", argv: [], resolved: {}, inputs: [], _schema: { id: "parley.receipt.head", version: "2.0.0" } };
    const okBoot = { event: "run", t: 1, seq: 0, run: "r", tool: "x", v: "1", inv: "i", paths: { receipt: "/p/r.jsonl" }, _schema: { id: "parley.run.bootstrap", version: "1.1.1" } };

    test("baselines validate", () => {
      expect(error(okError)).toBe(true);
      expect(head(okHead)).toBe(true);
      expect(boot(okBoot)).toBe(true);
    });
    test("negative t", () => expect(error({ ...okError, t: -5 })).toBe(false));
    test("prose code", () => expect(error({ ...okError, code: "Something went wrong" })).toBe(false));
    test("single-segment code", () => expect(error({ ...okError, code: "oops" })).toBe(false));
    test("empty problem", () => expect(error({ ...okError, problem: "" })).toBe(false));
    test("empty identities", () => {
      expect(boot({ ...okBoot, tool: "" })).toBe(false);
      expect(boot({ ...okBoot, v: "" })).toBe(false);
      expect(boot({ ...okBoot, run: "" })).toBe(false);
      expect(boot({ ...okBoot, inv: "" })).toBe(false);
      expect(head({ ...okHead, v: "" })).toBe(false);
      expect(head({ ...okHead, inv: "" })).toBe(false);
      expect(head({ ...okHead, t: -1 })).toBe(false);
      expect(boot({ ...okBoot, t: -1 })).toBe(false);
      expect(boot({ ...okBoot, session: "" })).toBe(false);
      expect(head({ ...okHead, session: "" })).toBe(false);
    });
    test("code grammar permits digits and underscores, rejects uppercase, hyphens and one segment", () => {
      expect(error({ ...okError, code: "http.404" })).toBe(true);
      expect(error({ ...okError, code: "fs.not_found" })).toBe(true);
      expect(error({ ...okError, code: "ENOENT" })).toBe(false);
      expect(error({ ...okError, code: "Contrast.Unsatisfiable" })).toBe(false);
      expect(error({ ...okError, code: "contrast.Unsatisfiable" })).toBe(false);
      expect(error({ ...okError, code: "Contrast.unsatisfiable" })).toBe(false);
      expect(error({ ...okError, code: "contrast-unsatisfiable" })).toBe(false);
      expect(error({ ...okError, code: "a.b." })).toBe(false);
    });
    test("another version of the same id does not validate against this schema", () => {
      expect(error({ ...okError, _schema: { id: "parley.error", version: "2.1.0" } })).toBe(false);
      expect(error({ ...okError, _schema: { id: "parley.error", version: "1.0.0" } })).toBe(false);
    });
    test("unknown fields are still accepted at the exact version", () => expect(error({ ...okError, extra: 1 })).toBe(true));
    test("receipt head without tool or v", () => {
      const { tool, ...noTool } = okHead;
      const { v, ...noV } = okHead;
      expect(head(noTool)).toBe(false);
      expect(head(noV)).toBe(false);
    });
    test("inv is optional in v0.2 and inputs may lack a digest", () => {
      const { inv, ...noInv } = okHead;
      expect(head(noInv)).toBe(true);
      const { inv: _b, ...bootNoInv } = okBoot;
      expect(boot(bootNoInv)).toBe(true);
      expect(head({ ...okHead, inputs: [{ path: "vendor/", role: "tree", error: "input.unreadable" }] })).toBe(true);
      expect(head({ ...okHead, inputs: [{ role: "tree" }] })).toBe(false);
    });
    test("each new schema's own constraints reject what the spec forbids", () => {
      const end = validate("parley.end.schema.json"), side = validate("parley.sidecar.schema.json"), start = validate("parley.startup.failed.schema.json"), warn = validate("parley.warning.schema.json"), red = validate("parley.redaction.schema.json");
      const okEnd = { event: "end", t: 1, seq: 9, run: "r", status: 0, receipt: "/w/r.jsonl", redacted: false, _schema: { id: "parley.end", version: "1.0.0" } };
      expect(end(okEnd)).toBe(true);
      for (const status of [-1, 256, 3, "0"]) expect(end({ ...okEnd, status })).toBe(false);
      const { redacted: _r, ...noRedacted } = okEnd; expect(end(noRedacted)).toBe(false);
      const { receipt: _p, ...noReceipt } = okEnd; expect(end(noReceipt)).toBe(false);
      expect(end({ ...okEnd, receipt: "rel/r.jsonl" })).toBe(false);
      const okSide = { event: "sidecar", t: 1, seq: 8, run: "r", source: 7, path: "r/7.json", bytes: 10, sha256: "a".repeat(64), _schema: { id: "parley.sidecar", version: "1.0.0" } };
      expect(side(okSide)).toBe(true);
      expect(side({ ...okSide, sha256: "zz" })).toBe(false);
      expect(side({ ...okSide, source: 0 })).toBe(false);
      expect(side({ ...okSide, path: "/abs/7.json" })).toBe(false);
      expect(side({ ...okSide, path: "../escape.json" })).toBe(false);
      expect(side({ ...okSide, bytes: -1 })).toBe(false);
      const okStart = { event: "startup.failed", t: 1, seq: 0, run: "r", tool: "x", v: "1", code: "startup.receipt_unwritable", problem: "p", _schema: { id: "parley.startup.failed", version: "1.0.0" } };
      expect(start(okStart)).toBe(true);
      expect(start({ ...okStart, code: "args.unparseable" })).toBe(false);
      const okWarn = { event: "warning", t: 1, seq: 3, run: "r", code: "a.b", problem: "p", _schema: { id: "parley.warning", version: "1.0.0" } };
      expect(warn(okWarn)).toBe(true);
      expect(warn({ ...okWarn, code: "Something went wrong" })).toBe(false);
      expect(warn({ ...okWarn, problem: "" })).toBe(false);
      const okRed = { event: "redaction", t: 1, seq: 6, run: "r", in: 4, at: "/detail/url", _schema: { id: "parley.redaction", version: "1.0.0" } };
      expect(red(okRed)).toBe(true);
      expect(red({ ...okRed, in: 0 })).toBe(false);
      expect(red({ ...okRed, at: "token" })).toBe(false);
      expect(head({ ...okHead, dry_run: "yes" })).toBe(false);
      expect(boot({ ...okBoot, dry_run: "yes" })).toBe(false);
      expect(boot({ ...okBoot, paths: { receipt: "rel.jsonl" } })).toBe(false);
      expect(head({ ...okHead, redacted: { argv: [], env: [] } })).toBe(false);
      expect(head({ ...okHead, redacted: { sources: ["netrc"] } })).toBe(true);
      expect(head({ ...okHead, inputs: [{ path: "x", sha256: "a".repeat(64), error: "input.unreadable" }] })).toBe(false);
      expect(head({ ...okHead, redacted: { sources: [""] } })).toBe(false);
      const inputs = validate("parley.receipt.inputs.schema.json");
      const okInputs = { event: "receipt.inputs", t: 1, seq: 5, run: "r", inputs: [{ path: "x", sha256: "a".repeat(64) }], _schema: { id: "parley.receipt.inputs", version: "1.0.0" } };
      expect(inputs(okInputs)).toBe(true);
      expect(inputs({ ...okInputs, inputs: [{ path: "x", sha256: "a".repeat(64), error: "input.unreadable" }] })).toBe(false);
      expect(inputs({ ...okInputs, inputs: [{ path: "x", sha256: "zz" }] })).toBe(false);
    });
    test("the query record carries asker, view and budget, and the view is a closed set (§9)", () => {
      const query = validate("parley.query.schema.json");
      const okQuery = {
        event: "query", t: 1, seq: 1, run: "r",
        asker: { tool: "claude-code", cwd: "/w", task: "owner/repo#1" },
        view: "what-failed",
        budget: { records: 20 },
        window: { from: 0, to: 2 },
        _schema: { id: "parley.query", version: "1.0.0" },
      };
      expect(query(okQuery)).toBe(true);
      for (const k of ["asker", "view", "budget", "window"]) {
        const { [k]: _dropped, ...without } = okQuery as Record<string, unknown>;
        expect(query(without)).toBe(false);
      }
      expect(query({ ...okQuery, view: "what-i-feel-like" })).toBe(false);
      expect(query({ ...okQuery, view: "" })).toBe(false);
      expect(query({ ...okQuery, asker: { tool: "" } })).toBe(false);
      expect(query({ ...okQuery, asker: {} })).toBe(false);
      expect(query({ ...okQuery, asker: "claude-code" })).toBe(false);
      expect(query({ ...okQuery, asker: { tool: "x", cwd: "rel/dir" } })).toBe(false);
      expect(query({ ...okQuery, budget: {} })).toBe(false);
      expect(query({ ...okQuery, budget: { records: 0 } })).toBe(false);
      expect(query({ ...okQuery, budget: { records: 1.5 } })).toBe(false);
      expect(query({ ...okQuery, budget: 20 })).toBe(false);
      expect(query({ ...okQuery, budget: { records: 20, bytes: 0 } })).toBe(false);
      expect(query({ ...okQuery, budget: { records: 20, bytes: 4096, ms: 250 } })).toBe(true);
      expect(query({ ...okQuery, window: { from: 0 } })).toBe(false);
      expect(query({ ...okQuery, window: { from: -1, to: 2 } })).toBe(false);
      expect(query({ ...okQuery, note: "" })).toBe(false);
      expect(query({ ...okQuery, session: "" })).toBe(false);
    });
    test("a drill-down query names the records it opens by (run, seq), at least one (flyingrobots/parley#51)", () => {
      // The case above compiled this schema on the shared validator; take that one rather than
      // registering its $id a second time.
      const query = ajv.getSchema("https://flyingrobots.dev/parley/schemas/parley.query/1.0.0") ?? validate("parley.query.schema.json");
      const okOpen = {
        event: "query", t: 1, seq: 1, run: "r",
        asker: { tool: "claude-code" },
        view: "what-failed",
        budget: { records: 2 },
        window: { from: 0, to: 2 },
        records: [{ run: "a", seq: 0 }, { run: "b", seq: 7 }],
        _schema: { id: "parley.query", version: "1.0.0" },
      };
      expect(query(okOpen)).toBe(true);
      expect(query({ ...okOpen, records: [] })).toBe(false);
      expect(query({ ...okOpen, records: [{ run: "a" }] })).toBe(false);
      expect(query({ ...okOpen, records: [{ run: "", seq: 1 }] })).toBe(false);
      expect(query({ ...okOpen, records: [{ run: "a", seq: -1 }] })).toBe(false);
      expect(query({ ...okOpen, records: [{ run: "a", seq: 1.5 }] })).toBe(false);
      expect(query({ ...okOpen, records: { run: "a", seq: 1 } })).toBe(false);
    });
    test("a lens names its query, its budget, its loss bound and its records (§9)", () => {
      const lens = validate("parley.lens.schema.json");
      const okLens = {
        event: "lens", t: 1, seq: 2, run: "r",
        query: { run: "r", seq: 1 },
        asker: { tool: "claude-code" },
        view: "what-failed",
        budget: { records: 20 },
        window: { from: 0, to: 2 },
        loss: { bound: "count-only", excluded: 184 },
        records: [{ run: "q", seq: 4 }],
        _schema: { id: "parley.lens", version: "1.0.0" },
      };
      expect(lens(okLens)).toBe(true);
      for (const k of ["query", "asker", "view", "budget", "window", "loss", "records"]) {
        const { [k]: _dropped, ...without } = okLens as Record<string, unknown>;
        expect(lens(without)).toBe(false);
      }
      expect(lens({ ...okLens, view: "what-i-feel-like" })).toBe(false);
      expect(lens({ ...okLens, budget: {} })).toBe(false);
      expect(lens({ ...okLens, query: { run: "r" } })).toBe(false);
      expect(lens({ ...okLens, query: { run: "r", seq: 0 } })).toBe(false);
      expect(lens({ ...okLens, loss: { bound: "count-only" } })).toBe(false);
      expect(lens({ ...okLens, loss: { excluded: 1 } })).toBe(false);
      expect(lens({ ...okLens, loss: { bound: "measured", excluded: 1 } })).toBe(false);
      expect(lens({ ...okLens, loss: { bound: "count-only", excluded: -1 } })).toBe(false);
      // A lossless view is the identity on its window: nothing excluded, and it must say 0.
      expect(lens({ ...okLens, view: "everything", loss: { bound: "none", excluded: 0 } })).toBe(true);
      expect(lens({ ...okLens, view: "everything", loss: { bound: "none", excluded: 1 } })).toBe(false);
      // The way back to the records is (run, seq) pairs; seq 0 is the bootstrap line.
      expect(lens({ ...okLens, records: [] })).toBe(true);
      expect(lens({ ...okLens, records: [{ run: "q", seq: 0 }] })).toBe(true);
      expect(lens({ ...okLens, records: [{ run: "", seq: 4 }] })).toBe(false);
      expect(lens({ ...okLens, records: [{ seq: 4 }] })).toBe(false);
      expect(lens({ ...okLens, records: [{ run: "q", seq: -1 }] })).toBe(false);
      expect(lens({ ...okLens, records: [{ run: "q" }] })).toBe(false);
      expect(lens({ ...okLens, records: "q/4" })).toBe(false);
      // Each entry may carry a summary of the record it names (flyingrobots/parley#77): the
      // record's event and t, and on an error or warning its code (flyingrobots/parley#83). Each
      // is optional, because a record with no usable event or t is named without one.
      const entry = { run: "q", seq: 4, event: "error", t: 1, code: "git.diff_failed" };
      expect(lens({ ...okLens, records: [entry] })).toBe(true);
      expect(lens({ ...okLens, records: [{ ...entry, code: "Not A Code" }] })).toBe(false);
      expect(lens({ ...okLens, records: [{ ...entry, code: "nodot" }] })).toBe(false);
      expect(lens({ ...okLens, records: [{ ...entry, event: "" }] })).toBe(false);
      expect(lens({ ...okLens, records: [{ ...entry, event: 7 }] })).toBe(false);
      expect(lens({ ...okLens, records: [{ ...entry, t: -1 }] })).toBe(false);
      expect(lens({ ...okLens, records: [{ ...entry, t: 1.5 }] })).toBe(false);
      expect(lens({ ...okLens, records: [{ ...entry, t: null }] })).toBe(false);
      const { t: _t, event: _e, code: _c, ...bare } = entry;
      expect(lens({ ...okLens, records: [bare] })).toBe(true);
      // Each run the entries name is stated once in runs (flyingrobots/parley#83). A reason is
      // present exactly when the outcome is undetermined, from a closed set; a dropped field is
      // named from the droppable set; the head statement has one value.
      const section = { run: "q", tool: "footprint", v: "0.2.0", argv: ["footprint", "HEAD~1..HEAD"], inv: "abc", outcome: "failed" };
      expect(lens({ ...okLens, runs: [section] })).toBe(true);
      expect(lens({ ...okLens, runs: [{ run: "q" }] })).toBe(true);
      expect(lens({ ...okLens, runs: [{ run: "" }] })).toBe(false);
      expect(lens({ ...okLens, runs: [{ tool: "t" }] })).toBe(false);
      expect(lens({ ...okLens, runs: [{ ...section, outcome: "unknown" }] })).toBe(false);
      expect(lens({ ...okLens, runs: [{ ...section, argv: ["t", 7] }] })).toBe(false);
      expect(lens({ ...okLens, runs: [{ ...section, inv: "" }] })).toBe(false);
      for (const reason of ["no_end_in_window", "end_status_unusable"]) {
        expect(lens({ ...okLens, runs: [{ ...section, outcome: "undetermined", reason }] })).toBe(true);
      }
      expect(lens({ ...okLens, runs: [{ ...section, outcome: "undetermined" }] })).toBe(false);
      expect(lens({ ...okLens, runs: [{ ...section, outcome: "undetermined", reason: "hung" }] })).toBe(false);
      expect(lens({ ...okLens, runs: [{ ...section, reason: "no_end_in_window" }] })).toBe(false);
      expect(lens({ ...okLens, runs: [{ run: "q", reason: "no_end_in_window" }] })).toBe(false);
      expect(lens({ ...okLens, runs: [{ run: "q", head: "not_in_window" }] })).toBe(true);
      expect(lens({ ...okLens, runs: [{ run: "q", head: "in_window" }] })).toBe(false);
      expect(lens({ ...okLens, runs: [{ ...section, dropped: ["argv", "inv"] }] })).toBe(true);
      expect(lens({ ...okLens, runs: [{ ...section, dropped: [] }] })).toBe(false);
      expect(lens({ ...okLens, runs: [{ ...section, dropped: ["argv", "inv", "v", "tool", "argv"] }] })).toBe(false);
      expect(lens({ ...okLens, runs: [{ ...section, dropped: ["run"] }] })).toBe(false);
    });
    test("a page with has_more needs a cursor; the last page does not (§7.2)", () => {
      const page = validate("parley.page.schema.json");
      const okPage = { event: "page", t: 1, seq: 7, run: "r", has_more: false, _schema: { id: "parley.page", version: "1.0.0" } };
      expect(page(okPage)).toBe(true);
      expect(page({ ...okPage, has_more: true })).toBe(false);
      expect(page({ ...okPage, has_more: true, cursor: "abc" })).toBe(true);
    });
    test("redacted marker shape", () => {
      expect(head({ ...okHead, redacted: { argv: [5], resolved: ["/token"], env: ["GITHUB_TOKEN"] } })).toBe(true);
      expect(head({ ...okHead, redacted: { argv: [-1] } })).toBe(false);
      expect(head({ ...okHead, redacted: { argv: ["5"] } })).toBe(false);
      expect(head({ ...okHead, redacted: { resolved: [""] } })).toBe(false);
      expect(head({ ...okHead, redacted: { env: [""] } })).toBe(false);
      expect(head({ ...okHead, redacted: {} })).toBe(false);
      expect(head({ ...okHead, redacted: { resolved: ["token"] } })).toBe(false);
      expect(head({ ...okHead, redacted: { resolved: ["/auth/token"], inputs: [0] } })).toBe(true);
      expect(head({ ...okHead, redacted: "argv" })).toBe(false);
      expect(head({ ...okHead, redacted: { inputs: ["0"] } })).toBe(false);
      expect(head({ ...okHead, redacted: { inputs: [-1] } })).toBe(false);
    });
  });

  test("no draft and released snapshot claim the same (id, version) pair (§4.5)", () => {
    expect(() => loadSchemas("schemas")).not.toThrow();
  });

  test("the loader resolves a released snapshot by its exact pair and rejects a collision", () => {
    const dir = mkdtempSync(join(tmpdir(), "parley-schemas-"));
    const draft = load("parley.error.schema.json");
    writeFileSync(join(dir, "parley.error.schema.json"), JSON.stringify(draft));
    mkdirSync(join(dir, "released", "parley.error"), { recursive: true });
    const snap = structuredClone(draft);
    snap.$id = "https://flyingrobots.dev/parley/schemas/parley.error/1.9.0";
    snap.properties._schema.properties.version.const = "1.9.0";
    writeFileSync(join(dir, "released", "parley.error", "1.9.0.schema.json"), JSON.stringify(snap));
    expect([...loadSchemas(dir).byKey.keys()].sort()).toEqual(["parley.error@1.9.0", "parley.error@2.0.0"]);
    writeFileSync(join(dir, "released", "parley.error", "2.0.0.schema.json"), JSON.stringify(draft));
    expect(() => loadSchemas(dir)).toThrow(/both claim parley.error@2.0.0/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("every schema is exercised by a validated example in the repository", () => {
    const ok = new Set(
      check(["README.md", "spec", "docs"], "schemas")
        .filter((v) => v.event === "example.ok")
        .map((v) => (v as { schema: string }).schema),
    );
    for (const f of files) expect(ok.has(idOf(f))).toBe(true);
  });
});
