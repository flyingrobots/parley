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

    test(`${f}: seq is const 0 only for the bootstrap line, otherwise minimum 1 (§1.3)`, () => {
      const seq = s.properties.seq;
      if (s.properties.event?.const === "run") expect(seq.const).toBe(0);
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
    const okBoot = { event: "run", t: 1, seq: 0, run: "r", tool: "x", v: "1", inv: "i", paths: { receipt: "p" }, _schema: { id: "parley.run.bootstrap", version: "1.1.1" } };

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
