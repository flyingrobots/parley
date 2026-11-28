// TRANSITIONAL SCAFFOLDING, deleted by flyingrobots/parley#119.
//
// The hand-written JSON Schemas under schemas/ are the source of truth today. This test holds the
// Wesley SDL in spec/parley-vous.graphql to them, so the SDL cannot drift while both exist: it lowers
// the SDL with the pinned Wesley, derives a JSON Schema value per message from the IR and the
// interim `parley_vous_` directives (scripts/sdl-to-json-schema.ts), and compares that with each
// top-level schema as parsed JSON. Ledger: docs/topics/message-sdl/test-plan.md.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { schemaFiles } from "./check-examples.ts";
import {
  DIRECTIVE_ARGS,
  INTERIM_DIRECTIVES,
  WESLEY_IR_VERSION,
  agreement,
  deriveSchemas,
  assertUniqueTypes,
  findWesley,
  lowerSdl,
  wesleyGate,
  type IR,
  type IRTypeRef,
} from "./sdl-to-json-schema.ts";

const SDL_PATH = "spec/parley-vous.graphql";
const pin: string = JSON.parse(readFileSync("package.json", "utf8")).config.wesley;
const topLevel = schemaFiles("schemas").filter((p) => !p.startsWith("schemas/released/"));
const handWritten = new Map(topLevel.map((p) => {
  const s = JSON.parse(readFileSync(p, "utf8"));
  return [p.replace(/^schemas\//, "").replace(/\.schema\.json$/, ""), s] as const;
}));

// A minimal well-formed IR for the refusal cases: one open message with a closed `_schema`.
function tinyIr(): IR {
  return {
    version: WESLEY_IR_VERSION,
    types: [
      { name: "SchemaRef", kind: "OBJECT", directives: { parley_vous_closed: true }, fields: [
        { name: "id", type: { base: "String", nullable: false, isList: false }, directives: {} },
        { name: "version", type: { base: "String", nullable: false, isList: false }, directives: {} },
      ] },
      { name: "Tiny", kind: "OBJECT", description: "A tiny message.",
        directives: { parley_vous_message: { id: "parley-vous.tiny", version: "1.0.0", title: "parley-vous tiny" }, parley_vous_open: true },
        fields: [
          { name: "event", type: { base: "String", nullable: false, isList: false }, directives: { parley_vous_const: { string: "tiny" } } },
          { name: "note", type: { base: "String", nullable: true, isList: false }, directives: { parley_vous_optional: true } },
          { name: "_schema", type: { base: "SchemaRef", nullable: false, isList: false }, directives: { parley_vous_message_ref: true } },
        ] },
    ],
  };
}
const tiny = () => tinyIr();
const typeOf = (ir: IR, name: string) => ir.types.find((t) => t.name === name)!;

describe("SDL derivation refuses what it cannot translate faithfully (SDL-6)", () => {
  test("the tiny IR derives, so each refusal below is caused by its one change", () => {
    const s = deriveSchemas(tiny()).get("parley-vous.tiny") as Record<string, any>;
    expect(s.properties.event).toEqual({ const: "tiny" });
    expect(s.required).toEqual(["event", "_schema"]);
    expect(s.properties._schema.properties.id).toEqual({ const: "parley-vous.tiny" });
  });

  test("SDL-6a: an unknown parley_vous_ directive", () => {
    const ir = tiny();
    typeOf(ir, "Tiny").fields![1]!.directives.parley_vous_maxLenght = { value: 3 };
    expect(() => deriveSchemas(ir)).toThrow(/parley_vous_maxLenght/);
  });

  test("SDL-6b: a nullable field not marked @parley_vous_optional", () => {
    const ir = tiny();
    typeOf(ir, "Tiny").fields![1]!.directives = {};
    expect(() => deriveSchemas(ir)).toThrow(/Tiny\.note.*@parley_vous_optional/);
  });

  test("SDL-6c: an object type that is neither open nor closed", () => {
    const ir = tiny();
    delete typeOf(ir, "Tiny").directives.parley_vous_open;
    expect(() => deriveSchemas(ir)).toThrow(/Tiny.*@parley_vous_open.*@parley_vous_closed/);
  });

  test("SDL-6d: a rule naming a field the type does not have", () => {
    const ir = tiny();
    typeOf(ir, "Tiny").directives.parley_vous_exclusive = { fields: ["note", "nope"] };
    expect(() => deriveSchemas(ir)).toThrow(/@parley_vous_exclusive.*Tiny\.nope/);
  });

  test("SDL-6e: an unknown argument on a known directive", () => {
    const ir = tiny();
    typeOf(ir, "Tiny").fields![1]!.directives.parley_vous_minLength = { value: 2, maximum: 3 };
    expect(() => deriveSchemas(ir)).toThrow(/Tiny\.note.*@parley_vous_minLength.*maximum/);
    typeOf(ir, "Tiny").fields![1]!.directives.parley_vous_minLength = { value: 2 };
    expect((deriveSchemas(ir).get("parley-vous.tiny") as any).properties.note.minLength).toBe(2);
  });

  test("SDL-6f: a field declared twice", () => {
    const ir = tiny();
    const t = typeOf(ir, "Tiny");
    t.fields!.unshift({ ...t.fields![1]!, directives: { parley_vous_optional: true, parley_vous_minLength: { value: 2 } } });
    expect(() => deriveSchemas(ir)).toThrow(/Tiny\.note.*twice|duplicate.*Tiny\.note/i);
  });

  test("SDL-6g: a type defined twice is refused before Wesley merges the two", () => {
    const sdl = "type A @parley_vous_open {\n  a: String!\n}\n\ntype A {\n  a: String!\n}\n";
    expect(() => assertUniqueTypes(sdl, "x.graphql")).toThrow(/type A.*twice|duplicate.*\bA\b/i);
    expect(() => assertUniqueTypes("type A {\n  a: String!\n}\nextend type A {\n  b: String\n}\n", "x.graphql")).not.toThrow();
    expect(() => assertUniqueTypes(readFileSync(SDL_PATH, "utf8"), SDL_PATH)).not.toThrow();
  });

  test("SDL-6h: a nested list type", () => {
    const ir = tiny();
    const note = typeOf(ir, "Tiny").fields![1]!;
    note.type = { base: "String", nullable: false, isList: true, listItemNullable: false, listWrappers: [{ nullable: false }, { nullable: false }] } as IRTypeRef;
    note.directives = {};
    expect(() => deriveSchemas(ir)).toThrow(/Tiny\.note.*nested list/i);
  });

  test("SDL-6i: a list-valued @parley_vous_message_ref", () => {
    const ir = tiny();
    typeOf(ir, "Tiny").fields![2]!.type = { base: "SchemaRef", nullable: false, isList: true, listItemNullable: false };
    expect(() => deriveSchemas(ir)).toThrow(/Tiny\._schema.*@parley_vous_message_ref.*list/);
  });

  test("SDL-6j: a list-typed member of the message reference type", () => {
    const ir = tiny();
    typeOf(ir, "SchemaRef").fields![0]!.type = { base: "String", nullable: false, isList: true, listItemNullable: false };
    expect(() => deriveSchemas(ir)).toThrow(/SchemaRef\.id.*bare String!/);
  });

  test("SDL-6k: @parley_vous_exclusive over three names, which `not` of all present would under-enforce", () => {
    const ir = tiny();
    const t = typeOf(ir, "Tiny");
    for (const n of ["a", "b", "c"]) t.fields!.push({ name: n, type: { base: "String", nullable: true, isList: false }, directives: { parley_vous_optional: true } });
    t.directives.parley_vous_exclusive = { fields: ["a", "b"] };
    expect(() => deriveSchemas(ir)).not.toThrow();
    t.directives.parley_vous_exclusive = { fields: ["a", "b", "c"] };
    expect(() => deriveSchemas(ir)).toThrow(/@parley_vous_exclusive.*Tiny.*exactly two/);
  });

  // A message whose `detail` object is optional and whose rule is on detail.enabled.
  const whenIr = (rule: Record<string, unknown>): IR => {
    const ir = tiny();
    ir.types.push({ name: "Detail", kind: "OBJECT", directives: { parley_vous_open: true }, fields: [
      { name: "enabled", type: { base: "Boolean", nullable: false, isList: false }, directives: {} },
      { name: "reason", type: { base: "String", nullable: true, isList: false }, directives: { parley_vous_optional: true } },
      { name: "note2", type: { base: "String", nullable: true, isList: false }, directives: { parley_vous_optional: true } },
    ] });
    const t = typeOf(ir, "Tiny");
    t.fields!.push({ name: "detail", type: { base: "Detail", nullable: true, isList: false }, directives: { parley_vous_optional: true } });
    t.directives.parley_vous_when = { path: ["detail", "enabled"], equals: true, guarded: true, forbidOtherwise: true, ...rule };
    return ir;
  };
  const valid = (ir: IR, doc: unknown) => new Ajv2020({ strict: false }).compile(deriveSchemas(ir).get("parley-vous.tiny")!)(doc);
  const base = { event: "tiny", _schema: { id: "parley-vous.tiny", version: "1.0.0" } };

  test("SDL-6l: a guarded forbid rule does not reject an object that omits the rule's parent", () => {
    const ir = whenIr({ require: ["reason"] });
    expect(valid(ir, base)).toBe(true);
    expect(valid(ir, { ...base, detail: { enabled: true, reason: "x" } })).toBe(true);
    expect(valid(ir, { ...base, detail: { enabled: true } })).toBe(false);
    expect(valid(ir, { ...base, detail: { enabled: false, reason: "x" } })).toBe(false);
    expect(valid(ir, { ...base, detail: { enabled: false } })).toBe(true);
  });

  test("SDL-6m: forbidOtherwise with two required fields, which `not` of both would under-enforce", () => {
    expect(() => deriveSchemas(whenIr({ require: ["reason", "note2"] }))).toThrow(/forbidOtherwise.*one/);
  });

  test("SDL-6n: a rule literal that violates the field's own constraints", () => {
    const ir = whenIr({ guarded: true, forbidOtherwise: false, set: { n: -1 }, require: [] });
    const detail = typeOf(ir, "Detail");
    detail.fields!.push({ name: "n", type: { base: "Int", nullable: true, isList: false }, directives: { parley_vous_optional: true, parley_vous_minimum: { value: 0 } } });
    expect(() => deriveSchemas(ir)).toThrow(/set n.*-1.*cannot hold/);
    (typeOf(ir, "Tiny").directives.parley_vous_when as any).set = { n: 0 };
    expect(() => deriveSchemas(ir)).not.toThrow();
  });
});

describe("the Wesley pin (SDL-4)", () => {
  test("SDL-4a: the pin is one exact version, and another version fails naming both", () => {
    expect(pin).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/);
    const other = pin === "9.9.9" ? "9.9.8" : "9.9.9"; // valid, and never the pin
    const g = wesleyGate({ bin: "/x/wesley", version: other }, pin, false);
    expect(g.kind).toBe("fail");
    if (g.kind === "fail") expect(g.reason).toContain(other), expect(g.reason).toContain(pin);
    expect(wesleyGate({ bin: "/x/wesley", version: pin }, pin, true)).toEqual({ kind: "run", bin: "/x/wesley" });
  });

  test("SDL-4c: no binary on a workstation skips, saying why and how to install it", () => {
    const g = wesleyGate(null, pin, false);
    expect(g.kind).toBe("skip");
    if (g.kind === "skip") expect(g.reason).toContain(`cargo install wesley-cli --version =${pin} --locked`);
  });

  test("SDL-4c: a $WESLEY that names nothing runnable counts as no binary, not a crash", () => {
    const saved = process.env.WESLEY;
    process.env.WESLEY = "/nonexistent/wesley";
    try {
      expect(findWesley()).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.WESLEY;
      else process.env.WESLEY = saved;
    }
  });

  test("SDL-4d: no binary in CI fails", () => {
    const g = wesleyGate(null, pin, true);
    expect(g.kind).toBe("fail");
    if (g.kind === "fail") expect(g.reason).toContain("not installed");
  });
});

describe("interim directives are declared, known and documented (SDL-5)", () => {
  test("SDL-5a: the SDL declarations, the derivation's vocabulary and the docs table agree", () => {
    const sdl = readFileSync(SDL_PATH, "utf8");
    const declared = new Map<string, string[]>();
    const lines = sdl.split("\n");
    lines.forEach((line, i) => {
      const m = /^directive @(parley_vous_\w+)/.exec(line);
      if (!m) return;
      // The comment block directly above a declaration names the Wesley issue that replaces it.
      const issues: string[] = [];
      for (let j = i - 1; j >= 0 && lines[j]!.startsWith("#"); j--) issues.push(...(lines[j]!.match(/flyingrobots\/wesley#\d+/g) ?? []));
      declared.set(m[1]!, issues);
    });
    expect([...declared.keys()].sort()).toEqual(Object.keys(INTERIM_DIRECTIVES).sort());
    for (const [name, issues] of declared) expect({ name, issues }).toEqual({ name, issues: [INTERIM_DIRECTIVES[name]!] });

    // The arguments the derivation accepts are the ones the SDL declares.
    const declaredArgs = Object.fromEntries([...sdl.matchAll(/^directive @(parley_vous_\w+)(?:\(([^)]*)\))?/gm)]
      .map((m) => [m[1]!, (m[2] ?? "").split(",").map((a) => a.split(":")[0]!.trim()).filter(Boolean)] as const));
    expect(declaredArgs).toEqual(DIRECTIVE_ARGS);

    const doc = readFileSync("docs/topics/message-sdl/README.md", "utf8");
    const rows = new Map<string, string>();
    for (const m of doc.matchAll(/^\| `@(parley_vous_\w+)[^`]*` \|.*\| (flyingrobots\/wesley#\d+) \|$/gm)) rows.set(m[1]!, m[2]!);
    expect(Object.fromEntries([...rows].sort())).toEqual(Object.fromEntries(Object.entries(INTERIM_DIRECTIVES).sort()));
  });
});

const gate = wesleyGate(findWesley(), pin, Boolean(process.env.CI));

if (gate.kind === "skip") {
  // bun test lists only a count of skipped tests, so the reason is also printed where it is seen.
  console.warn(`scripts/sdl-agreement.test.ts: SKIPPING the SDL agreement cases (SDL-1 to SDL-3): ${gate.reason}`);
  test.skip(`SDL agreement (SDL-1 to SDL-3): ${gate.reason}`, () => {});
} else if (gate.kind === "fail") {
  test("SDL agreement: the pinned wesley runs (SDL-4)", () => { throw new Error(gate.reason); });
} else {
  const bin = gate.bin;
  const sdl = readFileSync(SDL_PATH, "utf8");
  const dir = mkdtempSync(join(tmpdir(), "parley-sdl-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  // Lower an edited copy of the SDL; `from` must occur exactly once, so each edit is the one intended.
  const lowerEdited = (from: string, to: string): IR => {
    const count = sdl.split(from).length - 1;
    if (count !== 1) throw new Error(`expected exactly one occurrence of ${JSON.stringify(from)} in ${SDL_PATH}, found ${count}`);
    const p = join(dir, `edit-${n++}.graphql`);
    writeFileSync(p, sdl.replace(from, to));
    return lowerSdl(bin, p);
  };
  const ir = lowerSdl(bin, SDL_PATH);
  const derived = deriveSchemas(ir);

  describe("the SDL agrees with the hand-written schemas (SDL-1, SDL-2)", () => {
    test("SDL-4b: the IR is the shape this scaffolding reads", () => expect(ir.version).toBe(WESLEY_IR_VERSION));

    test("SDL-1a: the SDL declares exactly the messages schemas/ has", () => {
      expect([...derived.keys()].sort()).toEqual([...handWritten.keys()].sort());
      expect(derived.size).toBe(17);
    });

    for (const [id, schema] of handWritten) {
      test(`SDL-2a: ${id} derived from the SDL equals the hand-written schema`, () => {
        expect(agreement(id, derived.get(id), schema)).toEqual([]);
      });
    }
  });

  describe("a change on one side alone fails, naming the message and the field (SDL-3)", () => {
    const failsWith = (edited: IR, id: string, pointer: string) => {
      const diffs = agreement(id, deriveSchemas(edited).get(id), handWritten.get(id));
      expect(diffs.length).toBeGreaterThan(0);
      expect(diffs.some((d) => d.startsWith(`${id}: ${pointer}:`))).toBe(true);
    };

    // Mutate a copy of the lowered IR by type and field name, so a routine edit to a message's
    // wording or limits cannot break the fixture; the real-file agreement stays in SDL-2a.
    const mutated = (f: (ir: IR) => void): IR => {
      const copy = structuredClone(ir);
      f(copy);
      return copy;
    };
    const fieldOf = (ir: IR, type: string, field: string) => ir.types.find((t) => t.name === type)!.fields!.find((x) => x.name === field)!;

    test("SDL-3a: a minLength changed in the SDL only", () => {
      failsWith(mutated((m) => {
        const d = fieldOf(m, "End", "run").directives;
        d.parley_vous_minLength = { value: (d.parley_vous_minLength as { value: number }).value + 1 };
      }), "parley-vous.end", "/properties/run/minLength");
    });

    test("SDL-3b: a required field made optional in the SDL only", () => {
      failsWith(lowerEdited("redacted: Boolean!", "redacted: Boolean @parley_vous_optional"), "parley-vous.end", "/required");
    });

    test("SDL-3c: an enum value changed in the SDL only", () => {
      failsWith(lowerEdited(
        `view: String! @parley_vous_enum(values: ["what-ran", "what-failed", "what-changed", "how-it-decided", "everything"])\n  "The size of answer`,
        `view: String! @parley_vous_enum(values: ["what_ran", "what-failed", "what-changed", "how-it-decided", "everything"])\n  "The size of answer`,
      ), "parley-vous.query", "/properties/view/enum/0");
    });

    test("SDL-3d: a literal changed in the SDL only", () => {
      failsWith(lowerEdited(`event: String! @parley_vous_const(string: "end")`, `event: String! @parley_vous_const(string: "ended")`), "parley-vous.end", "/properties/event/const");
    });

    test("SDL-3e: a cross-field rule's value changed in the SDL only", () => {
      failsWith(lowerEdited(`path: ["has_more"], equals: true`, `path: ["has_more"], equals: false`), "parley-vous.page", "/if/properties/has_more/const");
    });

    test("SDL-3f: a description edited in the SDL only", () => {
      failsWith(mutated((m) => {
        const f = fieldOf(m, "Error", "problem");
        f.description = `${f.description} (edited)`;
      }), "parley-vous.error", "/properties/problem/description");
    });

    test("SDL-6g: lowering an SDL that defines a type twice is refused before Wesley merges it", () => {
      const p = join(dir, "dup.graphql");
      writeFileSync(p, `${sdl}\ntype End {\n  extra: String\n}\n`);
      expect(() => lowerSdl(bin, p)).toThrow(/type End is defined twice/);
    });

    test("SDL-3g: the hand-written schema changed alone", () => {
      const edit = (id: string, f: (s: any) => void) => {
        const s = structuredClone(handWritten.get(id));
        f(s);
        return agreement(id, derived.get(id), s);
      };
      expect(edit("parley-vous.error", (s) => { s.properties.code.pattern = "^[a-z0-9_.]+$"; }).some((d) => d.startsWith("parley-vous.error: /properties/code/pattern:"))).toBe(true);
      expect(edit("parley-vous.lens", (s) => { s.required = s.required.filter((k: string) => k !== "loss"); }).some((d) => d.startsWith("parley-vous.lens: /required:"))).toBe(true);
      expect(edit("parley-vous.sidecar", (s) => { s.properties.bytes.maximum = 1e12; }).some((d) => d.startsWith("parley-vous.sidecar: /properties/bytes/maximum:"))).toBe(true);
    });
  });
}
