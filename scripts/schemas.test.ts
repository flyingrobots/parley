// Invariants every schema under schemas/ must hold, independent of any example.
// These are the spec's own rules (§1.3, §4.5) stated as tests, so a future schema cannot drift.
import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readdirSync, readFileSync } from "node:fs";
import { check } from "./check-examples.ts";

const files = readdirSync("schemas").filter((f) => f.endsWith(".schema.json")).sort();
const load = (f: string) => JSON.parse(readFileSync(`schemas/${f}`, "utf8"));

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
    const id = f.replace(/\.schema\.json$/, "");
    const m = /\/schemas\/([^/]+)\/(\d+)\.(\d+)\.(\d+)$/.exec(String(s.$id));

    test(`${f}: $id names its own file and a SemVer version`, () => {
      expect(m).not.toBeNull();
      expect(m![1]).toBe(id);
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

    test(`${f}: _schema pins id by const and version to the major (§4.5)`, () => {
      const sch = s.properties._schema;
      expect(sch.additionalProperties).toBe(false);
      expect(sch.properties.id.const).toBe(id);
      expect(sch.properties.version.pattern).toBe(`^${m![2]}\\.[0-9]+\\.[0-9]+$`);
    });

    test(`${f}: open everywhere except _schema (§4.5)`, () => {
      walk(s, "", (n, p) => {
        if (n.additionalProperties === false) expect(p).toBe("/properties/_schema");
      });
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

  test("every schema is exercised by a validated example in the repository", () => {
    const ok = new Set(
      check(["README.md", "spec", "docs"], "schemas")
        .filter((v) => v.event === "example.ok")
        .map((v) => (v as { schema: string }).schema),
    );
    for (const f of files) expect(ok.has(f.replace(/\.schema\.json$/, ""))).toBe(true);
  });
});
