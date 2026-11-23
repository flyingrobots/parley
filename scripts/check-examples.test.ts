import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { check, stamp, type Verdict } from "./check-examples.ts";

const F = (name: string) => `scripts/fixtures/${name}`;
const only = (vs: Verdict[], event: Verdict["event"]) => vs.filter((v) => v.event === event);
const summary = (vs: Verdict[]) => vs[vs.length - 1] as Extract<Verdict, { event: "summary" }>;

describe("check-examples", () => {
  test("every example in the repository is valid or labeled", () => {
    const vs = check(["README.md", "spec", "docs"], "schemas");
    expect(only(vs, "example.invalid")).toEqual([]);
    expect(summary(vs).passed).toBe(true);
    expect(summary(vs).examples).toBeGreaterThan(0);
  });

  test("the pre-fix README bootstrap shape fails on paths", () => {
    const vs = check([F("readme-shape.md")], "schemas");
    const bad = only(vs, "example.invalid") as Extract<Verdict, { event: "example.invalid" }>[];
    expect(bad).toHaveLength(1);
    expect(bad[0]?.reason).toBe("invalid");
    expect(bad[0]?.detail).toContain("paths");
    expect(bad[0]?.line).toBe(4);
    expect(summary(vs).passed).toBe(false);
  });

  test("a conforming bootstrap passes and a tool-owned result is skipped", () => {
    const vs = check([F("conforming.md")], "schemas");
    expect(only(vs, "example.ok")).toHaveLength(1);
    const sk = only(vs, "example.skipped") as Extract<Verdict, { event: "example.skipped" }>[];
    expect(sk).toHaveLength(1);
    expect(sk[0]?.reason).toBe("tool_owned");
    expect(summary(vs).passed).toBe(true);
  });

  test("an unlabeled abridged example is a parse failure", () => {
    const vs = check([F("unlabeled-ellipsis.md")], "schemas");
    const bad = only(vs, "example.invalid") as Extract<Verdict, { event: "example.invalid" }>[];
    expect(bad).toHaveLength(1);
    expect(bad[0]?.reason).toBe("parse");
  });

  test("a labeled abridged example is skipped, not failed", () => {
    const vs = check([F("labeled-abridged.md")], "schemas");
    expect(only(vs, "example.invalid")).toEqual([]);
    expect(only(vs, "example.skipped")).toHaveLength(1);
  });

  test("an illustrative example must parse but is not validated", () => {
    const vs = check([F("illustrative.md")], "schemas");
    expect(only(vs, "example.invalid")).toEqual([]);
    const sk = only(vs, "example.skipped") as Extract<Verdict, { event: "example.skipped" }>[];
    expect(sk[0]?.reason).toBe("illustrative");
  });

  test("a schema version that does not exist is a failure", () => {
    const vs = check([F("unknown-version.md")], "schemas");
    const bad = only(vs, "example.invalid") as Extract<Verdict, { event: "example.invalid" }>[];
    expect(bad).toHaveLength(1);
    expect(bad[0]?.reason).toBe("unknown_schema");
  });

  test("an unlabeled example with no _schema is a failure", () => {
    const vs = check([F("no-schema.md")], "schemas");
    const bad = only(vs, "example.invalid") as Extract<Verdict, { event: "example.invalid" }>[];
    expect(bad).toHaveLength(1);
    expect(bad[0]?.reason).toBe("no_schema");
  });

  test("every output line validates against the checker's own schema", () => {
    const schema = JSON.parse(readFileSync("scripts/check-examples.schema.json", "utf8"));
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);
    const all = [
      ...check(["README.md", "spec", "docs"], "schemas"),
      ...check([F("readme-shape.md"), F("unlabeled-ellipsis.md"), F("labeled-abridged.md"), F("illustrative.md"), F("unknown-version.md"), F("no-schema.md"), F("conforming.md")], "schemas"),
      { event: "error", code: "check.crashed", problem: "x" } as Verdict,
    ];
    for (const v of all) {
      const line = stamp(v);
      expect(validate(line), JSON.stringify(validate.errors) + " for " + JSON.stringify(line)).toBe(true);
    }
  });
});
