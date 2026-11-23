// TRANSITIONAL SCAFFOLDING, deleted by flyingrobots/parley#119.
//
// The hand-written JSON Schemas under schemas/ are the source of truth today. This test holds the
// Wesley SDL in schemas/parley.graphql to them, so the SDL cannot drift while both exist: it lowers
// the SDL with the pinned Wesley, derives a JSON Schema value per message from the IR and the
// interim `parley_` directives (scripts/sdl-to-json-schema.ts), and compares that with each
// top-level schema as parsed JSON. Ledger: docs/topics/message-sdl/test-plan.md.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schemaFiles } from "./check-examples.ts";
import {
  INTERIM_DIRECTIVES,
  WESLEY_IR_VERSION,
  agreement,
  deriveSchemas,
  findWesley,
  lowerSdl,
  wesleyGate,
  type IR,
} from "./sdl-to-json-schema.ts";

const SDL_PATH = "schemas/parley.graphql";
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
      { name: "SchemaRef", kind: "OBJECT", directives: { parley_closed: true }, fields: [
        { name: "id", type: { base: "String", nullable: false, isList: false }, directives: {} },
        { name: "version", type: { base: "String", nullable: false, isList: false }, directives: {} },
      ] },
      { name: "Tiny", kind: "OBJECT", description: "A tiny message.",
        directives: { parley_message: { id: "parley.tiny", version: "1.0.0", title: "parley tiny" }, parley_open: true },
        fields: [
          { name: "event", type: { base: "String", nullable: false, isList: false }, directives: { parley_const: { string: "tiny" } } },
          { name: "note", type: { base: "String", nullable: true, isList: false }, directives: { parley_optional: true } },
          { name: "_schema", type: { base: "SchemaRef", nullable: false, isList: false }, directives: { parley_message_ref: true } },
        ] },
    ],
  };
}
const tiny = () => tinyIr();
const typeOf = (ir: IR, name: string) => ir.types.find((t) => t.name === name)!;

describe("SDL derivation refuses what it cannot translate faithfully (SDL-6)", () => {
  test("the tiny IR derives, so each refusal below is caused by its one change", () => {
    const s = deriveSchemas(tiny()).get("parley.tiny") as Record<string, any>;
    expect(s.properties.event).toEqual({ const: "tiny" });
    expect(s.required).toEqual(["event", "_schema"]);
    expect(s.properties._schema.properties.id).toEqual({ const: "parley.tiny" });
  });

  test("SDL-6a: an unknown parley_ directive", () => {
    const ir = tiny();
    typeOf(ir, "Tiny").fields![1]!.directives.parley_maxLenght = { value: 3 };
    expect(() => deriveSchemas(ir)).toThrow(/parley_maxLenght/);
  });

  test("SDL-6b: a nullable field not marked @parley_optional", () => {
    const ir = tiny();
    typeOf(ir, "Tiny").fields![1]!.directives = {};
    expect(() => deriveSchemas(ir)).toThrow(/Tiny\.note.*@parley_optional/);
  });

  test("SDL-6c: an object type that is neither open nor closed", () => {
    const ir = tiny();
    delete typeOf(ir, "Tiny").directives.parley_open;
    expect(() => deriveSchemas(ir)).toThrow(/Tiny.*@parley_open.*@parley_closed/);
  });

  test("SDL-6d: a rule naming a field the type does not have", () => {
    const ir = tiny();
    typeOf(ir, "Tiny").directives.parley_exclusive = { fields: ["note", "nope"] };
    expect(() => deriveSchemas(ir)).toThrow(/@parley_exclusive.*Tiny\.nope/);
  });
});

describe("the Wesley pin (SDL-4)", () => {
  test("SDL-4a: the pin is one exact version, and another version fails naming both", () => {
    expect(pin).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/);
    const g = wesleyGate({ bin: "/x/wesley", version: "0.3.0-alpha.5" }, pin, false);
    expect(g.kind).toBe("fail");
    if (g.kind === "fail") expect(g.reason).toContain(`0.3.0-alpha.5`), expect(g.reason).toContain(pin);
    expect(wesleyGate({ bin: "/x/wesley", version: pin }, pin, true)).toEqual({ kind: "run", bin: "/x/wesley" });
  });

  test("SDL-4c: no binary on a workstation skips, saying why and how to install it", () => {
    const g = wesleyGate(null, pin, false);
    expect(g.kind).toBe("skip");
    if (g.kind === "skip") expect(g.reason).toContain(`cargo install wesley-cli --version =${pin} --locked`);
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
      const m = /^directive @(parley_\w+)/.exec(line);
      if (!m) return;
      // The comment block directly above a declaration names the Wesley issue that replaces it.
      const issues: string[] = [];
      for (let j = i - 1; j >= 0 && lines[j]!.startsWith("#"); j--) issues.push(...(lines[j]!.match(/flyingrobots\/wesley#\d+/g) ?? []));
      declared.set(m[1]!, issues);
    });
    expect([...declared.keys()].sort()).toEqual(Object.keys(INTERIM_DIRECTIVES).sort());
    for (const [name, issues] of declared) expect({ name, issues }).toEqual({ name, issues: [INTERIM_DIRECTIVES[name]!] });

    const doc = readFileSync("docs/topics/message-sdl/README.md", "utf8");
    const rows = new Map<string, string>();
    for (const m of doc.matchAll(/^\| `@(parley_\w+)[^`]*` \|.*\| (flyingrobots\/wesley#\d+) \|$/gm)) rows.set(m[1]!, m[2]!);
    expect(Object.fromEntries([...rows].sort())).toEqual(Object.fromEntries(Object.entries(INTERIM_DIRECTIVES).sort()));
  });
});

const gate = wesleyGate(findWesley(), pin, Boolean(process.env.CI));

if (gate.kind === "skip") {
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

    test("SDL-3a: a minLength changed in the SDL only", () => {
      failsWith(lowerEdited(
        `"The execution this line belongs to (spec §2.1)."\n  run: String! @parley_minLength(value: 1)\n  "The exit status`,
        `"The execution this line belongs to (spec §2.1)."\n  run: String! @parley_minLength(value: 2)\n  "The exit status`,
      ), "parley.end", "/properties/run/minLength");
    });

    test("SDL-3b: a required field made optional in the SDL only", () => {
      failsWith(lowerEdited("redacted: Boolean!", "redacted: Boolean @parley_optional"), "parley.end", "/required");
    });

    test("SDL-3c: an enum value changed in the SDL only", () => {
      failsWith(lowerEdited(
        `view: String! @parley_enum(values: ["what-ran", "what-failed", "what-changed", "how-it-decided", "everything"])\n  "The size of answer`,
        `view: String! @parley_enum(values: ["what_ran", "what-failed", "what-changed", "how-it-decided", "everything"])\n  "The size of answer`,
      ), "parley.query", "/properties/view/enum/0");
    });

    test("SDL-3d: a literal changed in the SDL only", () => {
      failsWith(lowerEdited(`event: String! @parley_const(string: "end")`, `event: String! @parley_const(string: "ended")`), "parley.end", "/properties/event/const");
    });

    test("SDL-3e: a cross-field rule's value changed in the SDL only", () => {
      failsWith(lowerEdited(`path: ["has_more"], equals: true`, `path: ["has_more"], equals: false`), "parley.page", "/if/properties/has_more/const");
    });

    test("SDL-3f: a description edited in the SDL only", () => {
      const from = `"What is wrong, in one sentence."\n  problem: String! @parley_minLength(value: 1)\n  "The value observed, when the failure is a threshold."\n  measured: JSON @parley_optional\n  "The threshold that was not met."\n  limit: JSON @parley_optional\n  "The lever to pull. Omit rather than invent one."\n  remedy: String @parley_optional\n  "What the remedy applies to."\n  remedy_target: String @parley_optional\n  retryable: Boolean @parley_optional`;
      failsWith(lowerEdited(from, from.replace("in one sentence.", "in a sentence.")), "parley.error", "/properties/problem/description");
    });

    test("SDL-3g: the hand-written schema changed alone", () => {
      const edit = (id: string, f: (s: any) => void) => {
        const s = structuredClone(handWritten.get(id));
        f(s);
        return agreement(id, derived.get(id), s);
      };
      expect(edit("parley.error", (s) => { s.properties.code.pattern = "^[a-z0-9_.]+$"; }).some((d) => d.startsWith("parley.error: /properties/code/pattern:"))).toBe(true);
      expect(edit("parley.lens", (s) => { s.required = s.required.filter((k: string) => k !== "loss"); }).some((d) => d.startsWith("parley.lens: /required:"))).toBe(true);
      expect(edit("parley.sidecar", (s) => { s.properties.bytes.maximum = 1e12; }).some((d) => d.startsWith("parley.sidecar: /properties/bytes/maximum:"))).toBe(true);
    });
  });
}
