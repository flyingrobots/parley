// PE-35: a `bigint` in a payload is carried exactly through the whole output path
// (flyingrobots/parley#171).
//
// The oracle throughout is the **emitted text**: a line is searched for literal digits, or two
// lines are compared as strings. An ordinary `JSON.parse` is never the oracle for a number here,
// because it rounds the expected value and the actual one alike; it is used only to find a line
// by its `event` or to read a string field such as a path.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as emit from "../src/index.ts";
import { checkRecord, canonical, computeInv, defineTool, main, scrub, declaredProjection, ParleyRedactionConflict, ParleyRedactionUnchecked, type HistoryTransform, type MainOptions, type Run, type ToolSpec } from "../src/index.ts";
import { pinned } from "./fixtures/pin-inv.ts";
import { unwritable } from "../src/exact.ts";
/** The cap guard alone: whether `unwritable` refuses the value for an integer past the cap. */
const holdsUnreadable = (v: unknown): boolean => unwritable(v) === "integer";

const ROOT = resolve(import.meta.dir, "../../..");
const CORPUS = join(ROOT, "conformance/numbers/cases.jsonl");
const BIG = 9007199254740993n; // 2^53 + 1: no double holds it
const BIG_TEXT = "9007199254740993";

interface Case { id: string; pins: string; text: string; outcome: "exact" | "unrepresentable"; kinds?: string[]; emit?: string; tokens?: string[] }
/** The corpus holds strings and lists of strings only, so `JSON.parse` reads it without rounding anything. */
const cases = readFileSync(CORPUS, "utf8").trimEnd().split("\n").map((l) => JSON.parse(l) as Case);

const stamp = (id: string) => ({ type: "object", required: ["id", "version"], additionalProperties: false, properties: { id: { const: id }, version: { const: "1.0.0" } } });
const COUNT = { type: "object", required: ["event", "t", "seq", "run", "value", "_schema"], properties: { event: { const: "result" }, value: { type: "integer", minimum: 0 }, _schema: stamp("t.count") } };
const NOTE = { type: "object", required: ["event", "t", "seq", "run", "_schema"], properties: { event: { const: "result" }, note: { type: "string" }, value: { type: "integer" }, _schema: stamp("t.note") } };
/** A bound no double states exactly as written: 2^64 - 1 loads as 2^64. */
const BOUND = { type: "object", required: ["event", "t", "seq", "run", "_schema"], properties: { event: { const: "result" }, note: { type: "string" }, value: { type: "integer", maximum: 18446744073709551615 }, _schema: stamp("t.bound") } };
const P = { count: { id: "t.count", version: "1.0.0" }, note: { id: "t.note", version: "1.0.0" }, bound: { id: "t.bound", version: "1.0.0" }, any: { id: "t.any", version: "1.0.0" } };

function tool(over: Partial<ToolSpec> = {}): ToolSpec {
  return defineTool({
    name: "t", version: "0.0.1",
    commands: { count: { intent: "Count things", effects: { reads: [], writes: [], network: false, idempotent: true }, secrets: ["--token"], emits: [{ ...P.count, schema: COUNT }, { ...P.note, schema: NOTE }, { ...P.bound, schema: BOUND }, P.any] } },
    retention: { count: 100 },
    ...over,
  });
}

interface Outcome { status: number; out: string[]; err: string[]; receipt: string[]; receiptPath: string; stream: string[]; thrown: unknown[] }

async function go(body: (run: Run) => void | Promise<void>, o: { argv?: string[]; over?: Partial<ToolSpec>; transform?: HistoryTransform; stream?: boolean; extra?: Partial<MainOptions> } = {}): Promise<Outcome> {
  const cwd = mkdtempSync(join(tmpdir(), "parley-exact-"));
  const state = mkdtempSync(join(tmpdir(), "parley-exact-state-"));
  const hist = mkdtempSync(join(tmpdir(), "parley-exact-hist-"));
  const out: string[] = [], err: string[] = [], thrown: unknown[] = [];
  let receiptPath = "";
  const history = o.transform !== undefined || o.stream === true;
  const status = await main(tool(o.over), ["t", ...(o.argv ?? ["count"])], async (run) => {
    receiptPath = run.receiptPath;
    try { await body(run); } catch (e) { thrown.push(e); throw e; }
  }, {
    cwd, env: { XDG_STATE_HOME: state, ...(history ? { PARLEY_HISTORY: hist } : {}) }, home: state,
    stdout: { write: (l) => { out.push(l); } }, stderr: { write: (l) => { err.push(l); } },
    ...(o.transform !== undefined ? { history: { transform: o.transform } } : history ? {} : { history: null }),
    ...o.extra,
  });
  const lines = (text: string) => (text === "" ? [] : text.trimEnd().split("\n"));
  const receipt = receiptPath === "" ? [] : lines(readFileSync(receiptPath, "utf8"));
  const stream = history ? readdirSync(hist).sort().flatMap((n) => lines(readFileSync(join(hist, n), "utf8"))) : [];
  return { status, out: out.flatMap(lines), err: err.flatMap(lines), receipt, receiptPath, stream, thrown };
}

/** The lines of one event, as written. `JSON.parse` here reads `event` and nothing else. */
const of = (lines: string[], event: string) => lines.filter((l) => (JSON.parse(l) as { event?: unknown }).event === event);
/** The text of a result line's `value`, cut out of the line as written. */
function valueText(line: string): string {
  const from = line.indexOf('"value":'), to = line.lastIndexOf(',"_schema"');
  expect(from).toBeGreaterThan(-1); expect(to).toBeGreaterThan(from);
  return line.slice(from + '"value":'.length, to);
}
const codes = (lines: string[]) => lines.map((l) => (JSON.parse(l) as { code?: string }).code);
/** A scalar's exact value as sign, digits and exponent, read from its text by this test alone: the independent normaliser. */
function normal(token: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (m === null) throw new Error(`not a number: ${token.slice(0, 40)}`);
  const all = (m[2]! + (m[3] ?? "")).replace(/^0+/, "");
  const digits = all.replace(/0+$/, "");
  if (digits === "") return "0";
  const exponent = BigInt(m[4] ?? "0") - BigInt((m[3] ?? "").length) + BigInt(all.length - digits.length);
  return `${m[1]}${digits}e${exponent}`;
}

describe("PE-35 a bigint is written as exact unquoted digits (flyingrobots/parley#171)", () => {
  test("golden: a result holding 9007199254740993n is on stdout and in the receipt as 9007199254740993, and the run ends with status 0", async () => {
    const r = await go((run) => { run.result({ event: "result", value: BIG }, P.count); });
    expect(r.err).toEqual([]);
    expect(r.status).toBe(0);
    const [stdout] = of(r.out, "result"), [receipt] = of(r.receipt, "result");
    expect(valueText(stdout!)).toBe(BIG_TEXT);
    // One exact value, serialised for both sinks: the two copies are the same bytes.
    expect(receipt).toBe(stdout!);
    expect(stdout).not.toContain(`"${BIG_TEXT}"`);
    expect(stdout).not.toContain(`${BIG_TEXT}n`);
    expect(r.out.join("\n")).not.toContain("9007199254740992");
  });

  test("the envelope the writer sets stays plain numbers beside a bigint", async () => {
    const r = await go((run) => { run.result({ event: "result", value: BIG }, P.count); });
    const [line] = of(r.out, "result");
    expect(line).toMatch(/^\{"event":"result","t":\d{1,16},"seq":\d{1,6},"run":"[0-9A-Z]{26}","value":9007199254740993,"_schema":\{"id":"t\.count","version":"1\.0\.0"\}\}$/);
    expect(of(r.out, "end")[0]).toMatch(/"status":0,/);
  });

  test("two adjacent integers beyond the safe range stay two values on every sink", async () => {
    const r = await go((run) => {
      run.result({ event: "result", value: 9007199254740992n }, P.count);
      run.result({ event: "result", value: 9007199254740993n }, P.count);
    }, { stream: true });
    for (const lines of [r.out, r.receipt, r.stream]) expect(of(lines, "result").map(valueText)).toEqual(["9007199254740992", "9007199254740993"]);
  });

  test("a bigint inside the safe range is the same JSON number a number is", async () => {
    const r = await go((run) => { run.result({ event: "result", value: 5n }, P.count); run.result({ event: "result", value: -0n }, P.count); });
    expect(of(r.out, "result").map(valueText)).toEqual(["5", "0"]);
    expect(of(r.receipt, "result").map(valueText)).toEqual(["5", "0"]);
  });

  test("a bigint in a step's detail, a diagnostic's detail, a page and receiptExtra is exact", async () => {
    const r = await go((run) => {
      run.step("picked the row", "it is the newest", { id: BIG });
      run.warning({ code: "row.stale", problem: "the row is old", detail: { id: BIG, ids: [BIG, -BIG] } });
      run.page(null, false, { first: BIG });
      run.result({ event: "result", value: 1 }, P.any, { rows: [{ id: BIG }] });
    });
    expect(r.status).toBe(0);
    expect(of(r.receipt, "receipt.step").find((l) => l.includes("picked the row"))).toContain(`"detail":{"id":${BIG_TEXT}}`);
    expect(of(r.err, "warning")[0]).toContain(`"detail":{"id":${BIG_TEXT},"ids":[${BIG_TEXT},-${BIG_TEXT}]}`);
    expect(of(r.receipt, "warning")[0]).toBe(of(r.err, "warning")[0]!);
    expect(of(r.out, "page")[0]).toContain(`"first":${BIG_TEXT},`);
    expect(of(r.receipt, "result")[0]).toContain(`"rows":[{"id":${BIG_TEXT}}]`);
    expect(of(r.out, "result")[0]).not.toContain("rows");
  });

  test("receiptExtra that disagrees with the record by one beyond the safe range is refused, and one that agrees is not", async () => {
    const r = await go((run) => {
      run.result({ event: "result", value: BIG }, P.any, { value: BIG });
      expect(() => run.result({ event: "result", value: BIG }, P.any, { value: BIG - 1n })).toThrow(/differs from the record's value/);
    });
    expect(of(r.out, "result").map(valueText)).toEqual([BIG_TEXT]);
    expect(r.status).toBe(0);
  });
});

describe("PE-35 the shared numeric corpus through the writer (conformance/numbers)", () => {
  test("the corpus covers what it says it covers", () => {
    expect(cases.length).toBe(50);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const c of cases) {
      if (c.outcome === "exact") { expect(typeof c.emit).toBe("string"); expect(Array.isArray(c.kinds)).toBe(true); }
      else expect(c.tokens!.length).toBeGreaterThan(0);
    }
    const byId = new Map(cases.map((c) => [c.id, c]));
    expect(byId.get("cap-4096-digits")!.text.length).toBe(4096);
    expect(byId.get("cap-4097-digits")!.text.length).toBe(4097);
  });

  test("each scalar case's expected text states the value its input states, by an independent normaliser", () => {
    for (const c of cases) {
      if (c.outcome !== "exact" || !/^-?\d/.test(c.text)) continue;
      expect(normal(c.emit!), c.id).toBe(normal(c.text));
    }
  });

  for (const c of cases) {
    if (c.outcome === "exact") {
      test(`${c.id}: ${c.text.length > 60 ? `${c.text.slice(0, 24)}… (${c.text.length} characters)` : c.text} is read exactly and written as the expected text`, async () => {
        const parsed = emit.parseExact(c.text);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        const kinds: string[] = [];
        const walk = (v: unknown): void => {
          if (typeof v === "number" || typeof v === "bigint") kinds.push(typeof v);
          else if (Array.isArray(v)) v.forEach(walk);
          else if (v !== null && typeof v === "object") Object.values(v).forEach(walk);
        };
        walk(parsed.value);
        expect(kinds).toEqual(c.kinds!);
        expect(emit.exactJson(parsed.value)).toBe(c.emit!);
        // And through the writer itself: stdout, the receipt and the unprojected stream.
        const r = await go((run) => { run.result({ event: "result", value: parsed.value }, P.any); }, { stream: true });
        expect(r.status).toBe(0);
        expect(valueText(of(r.out, "result")[0]!)).toBe(c.emit!);
        expect(valueText(of(r.receipt, "result")[0]!)).toBe(c.emit!);
        expect(valueText(of(r.stream, "result")[0]!)).toBe(c.emit!);
      });
    } else {
      test(`${c.id}: ${c.text.length > 60 ? `${c.text.slice(0, 24)}… (${c.text.length} characters)` : c.text} is not representable, and each such number is named`, () => {
        const parsed = emit.parseExact(c.text);
        expect(parsed.ok).toBe(false);
        if (parsed.ok) return;
        expect([...parsed.tokens]).toEqual(c.tokens!);
      });
    }
  }

  test("equivalent spellings are one value and distinct decimals sharing a double are not", () => {
    const text = (id: string) => cases.find((c) => c.id === id)!;
    expect(new Set(["five", "five-point-zero", "five-exponent"].map((id) => text(id).emit))).toEqual(new Set(["5"]));
    expect(new Set(["tenth", "tenth-trailing-zero", "tenth-exponent"].map((id) => text(id).emit))).toEqual(new Set(["0.1"]));
    expect(Number("0.10000000000000001")).toBe(0.1); // one double
    expect(text("tenth-seventeen-digits").outcome).toBe("unrepresentable"); // two decimals
    expect(text("string-of-digits").emit).not.toBe(text("unsafe-adjacent").emit);
  });

  test("an enormous exponent and a token past the cap are classified without being built", () => {
    const started = performance.now();
    for (const t of ["1e1000000000", "-1e999999999999", "1e-1000000000", `[${"7".repeat(2_000_000)}]`]) expect(emit.parseExact(t).ok).toBe(false);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(emit.MAX_EXACT_DIGITS).toBe(4096);
  });
});

describe("PE-35 the exact parser and serialiser are the writer's, and exported", () => {
  test("the index exports parseExact, exactJson, holdsExact, MAX_EXACT_DIGITS and UNREPRESENTABLE", () => {
    expect(typeof emit.parseExact).toBe("function");
    expect(typeof emit.exactJson).toBe("function");
    expect(typeof emit.holdsExact).toBe("function");
    expect(emit.MAX_EXACT_DIGITS).toBe(4096);
    expect(typeof emit.UNREPRESENTABLE).toBe("symbol");
    expect(emit.holdsExact({ a: [1, { b: 2n }] })).toBe(true);
    expect(emit.holdsExact({ a: [1, { b: 2 }] })).toBe(false);
  });

  test("exactJson is JSON.stringify's own text for a value with no bigint", () => {
    for (const v of [null, 0, -0, 1.5, 1e21, "a\"b ", [undefined, () => 1, Number.NaN], { a: undefined, b: { toJSON: () => "j" }, c: new Date(0) }, undefined]) {
      expect(emit.exactJson(v)).toBe(JSON.stringify(v) ?? "null");
    }
  });

  test("exactJson writes a bigint as digits and everything beside it as JSON.stringify does", () => {
    expect(emit.exactJson({ id: BIG, s: "x\n", list: [undefined, -BIG, Number.NaN], gone: undefined, when: new Date(0), j: { toJSON: () => ({ n: 7n }) } }))
      .toBe(`{"id":${BIG_TEXT},"s":"x\\n","list":[null,-${BIG_TEXT},null],"when":"1970-01-01T00:00:00.000Z","j":{"n":7}}`);
  });

  test("exactJson writes a bigint that exists only in a toJSON result (review of flyingrobots/parley#175)", () => {
    expect(emit.exactJson({ toJSON() { return { id: BIG }; } })).toBe(`{"id":${BIG_TEXT}}`);
    expect(emit.exactJson({ a: 1, inner: { toJSON: () => [BIG] } })).toBe(`{"a":1,"inner":[${BIG_TEXT}]}`);
  });

  test("exactJson applies toJSON once per value, as JSON.stringify does (review of flyingrobots/parley#175)", () => {
    // The hook's result is serialised as it is: its own toJSON is not called again.
    const twice = { big: BIG, value: { toJSON() { return { kept: true, toJSON() { return "wrong"; } }; } } };
    expect(emit.exactJson(twice)).toBe(`{"big":${BIG_TEXT},"value":{"kept":true}}`);
    // A hook that returns its own object does not recurse.
    const self: { big: bigint; toJSON(): unknown } = { big: BIG, toJSON() { return this; } };
    expect(emit.exactJson(self)).toBe(`{"big":${BIG_TEXT}}`);
    // A member of the hook's result still has its own hook applied.
    expect(emit.exactJson({ big: BIG, v: { toJSON: () => ({ when: new Date(0) }) } })).toBe(`{"big":${BIG_TEXT},"v":{"when":"1970-01-01T00:00:00.000Z"}}`);
  });

  test("a boxed bigint is written as its digits, and is seen by holdsExact and the cap guard (review of flyingrobots/parley#175)", () => {
    expect(emit.exactJson({ id: Object(BIG) })).toBe(`{"id":${BIG_TEXT}}`);
    expect(emit.exactJson([Object(5n), { n: Object(-BIG) }])).toBe(`[5,{"n":-${BIG_TEXT}}]`);
    expect(emit.holdsExact({ id: Object(5n) })).toBe(true);
    expect(holdsUnreadable({ id: Object(10n ** BigInt(emit.MAX_EXACT_DIGITS)) })).toBe(true);
    expect(holdsUnreadable({ id: Object(5n) })).toBe(false);
  });

  test("exactJson reads a value once, with a bigint in it or without (case 2026-11-25, F-3; it read a getter twice beside a bigint before)", () => {
    let reads = 0;
    const text = emit.exactJson({ get id() { reads++; return BIG; } });
    expect(text).toBe(`{"id":${BIG_TEXT}}`);
    expect(reads).toBe(1);
    reads = 0;
    emit.exactJson({ get id() { reads++; return 5; } });
    expect(reads).toBe(1);
  });

  test("holdsUnreadable sees an integer past the cap that only a toJSON hook returns (review of flyingrobots/parley#175)", () => {
    const past = 10n ** BigInt(emit.MAX_EXACT_DIGITS);
    class Hidden { own = 5n; toJSON() { return past; } }
    expect(holdsUnreadable({ field: new Hidden() })).toBe(true);
    expect(holdsUnreadable({ field: { toJSON: () => ({ deep: [past] }) } })).toBe(true);
    expect(holdsUnreadable({ field: { toJSON: () => ({ deep: [5n] }) } })).toBe(false);
    // The hook is applied once per value, as the serialiser applies it.
    const self: { n: bigint; toJSON(): unknown } = { n: 5n, toJSON() { return this; } };
    expect(holdsUnreadable(self)).toBe(false);
  });

  test("exactJson follows JSON.stringify for boxed primitives and array holes beside a bigint, and a cycle is still a TypeError", () => {
    // eslint-disable-next-line no-sparse-arrays
    const beside = { n: new Number(5), s: new String("x"), b: new Boolean(false), holes: [, 1], map: new Map([[1, 2]]) };
    expect(emit.exactJson({ id: BIG, ...beside })).toBe(`{"id":${BIG_TEXT},${JSON.stringify(beside).slice(1)}`);
    const loop: Record<string, unknown> = { id: BIG };
    loop.self = loop;
    expect(() => emit.exactJson(loop)).toThrow(TypeError);
    const plain: Record<string, unknown> = {};
    plain.self = plain;
    expect(() => emit.exactJson(plain)).toThrow(TypeError);
  });

  test("a partial parse marks each unrepresentable number and keeps the fields beside it", () => {
    const p = emit.parseExact('{"seq":4,"value":0.10000000000000001}');
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.partial).toEqual({ seq: 4, value: emit.UNREPRESENTABLE });
  });

  test("parseExact throws exactly when JSON.parse throws", () => {
    for (const bad of ["", "{", "01", "1.", "[1,]", "9007199254740993n", "NaN"]) expect(() => emit.parseExact(bad)).toThrow(SyntaxError);
  });

  test("the package is 0.5.0 and its changelog has the entry", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "packages/parley-emit/package.json"), "utf8")) as { version: string };
    expect(manifest.version).toBe("0.5.0");
    expect(readFileSync(join(ROOT, "packages/parley-emit/CHANGELOG.md"), "utf8")).toMatch(/^## \[0\.5\.0\]/m);
  });
});

describe("PE-35 a sidecar holds exact digits", () => {
  test("a record over the threshold that holds bigints is stored as written, and the sidecar event describes those bytes", async () => {
    const ids = Array.from({ length: 4000 }, (_, i) => BIG + BigInt(i));
    const r = await go((run) => { run.result({ event: "result", value: 1 }, P.any, { ids }); });
    expect(r.status).toBe(0);
    const side = JSON.parse(of(r.receipt, "sidecar")[0]!) as { path: string; bytes: number; sha256: string };
    const stored = readFileSync(join(r.receiptPath, "..", side.path));
    expect(stored.length).toBe(side.bytes);
    expect(side.bytes).toBeGreaterThan(65536);
    expect(createHash("sha256").update(stored).digest("hex")).toBe(side.sha256);
    expect(stored.toString("utf8")).toContain(`"ids":[${ids.map(String).join(",")}]`);
  });
});

describe("PE-35 a history transform is handed exact values and writes exact values", () => {
  test("an identity transform: the stream copy is the receipt line, digit for digit, and the transform saw a bigint", async () => {
    const seen: unknown[] = [];
    const r = await go((run) => { run.result({ event: "result", value: BIG }, P.count); }, { transform: (rec) => { if (rec.event === "result") seen.push(rec.value); return rec; } });
    expect(r.err).toEqual([]);
    expect(seen).toEqual([BIG]);
    expect(of(r.stream, "result")).toEqual(of(r.receipt, "result"));
    expect(valueText(of(r.stream, "result")[0]!)).toBe(BIG_TEXT);
  });

  test("a transform that computes with the bigint writes its exact result", async () => {
    const r = await go((run) => { run.result({ event: "result", value: BIG }, P.count); }, { transform: (rec) => (rec.event === "result" ? { ...rec, value: (rec.value as bigint) + 2n } : rec) });
    expect(r.err).toEqual([]);
    expect(valueText(of(r.stream, "result")[0]!)).toBe("9007199254740995");
    expect(valueText(of(r.receipt, "result")[0]!)).toBe(BIG_TEXT);
  });

  test("a number the receipt writes beyond the safe range reaches the transform as the integer the text states", async () => {
    const seen: unknown[] = [];
    const r = await go((run) => { run.result({ event: "result", value: 2 ** 53 }, P.count); run.result({ event: "result", value: 1e21 }, P.count); }, { transform: (rec) => { if (rec.event === "result") seen.push(rec.value); return rec; } });
    expect(r.err).toEqual([]);
    expect(of(r.receipt, "result").map(valueText)).toEqual(["9007199254740992", "1e+21"]);
    expect(seen).toEqual([9007199254740992n, 10n ** 21n]);
    // The stream copy states the same values; the second is spelt as digits.
    expect(of(r.stream, "result").map(valueText)).toEqual(["9007199254740992", "1000000000000000000000"]);
  });

  test("the re-validation of a projected body decides a bigint exactly: one that breaks the schema is withheld as invalid, and the stream holds no rounded copy", async () => {
    const r = await go((run) => { run.result({ event: "result", value: BIG }, P.count); }, { transform: (rec) => (rec.event === "result" ? { ...rec, value: -BIG } : rec) });
    expect(codes(of(r.err, "warning"))).toEqual(["history.transform_invalid"]);
    expect(of(r.stream, "result")).toEqual([]);
    expect(r.status).toBe(0);
  });

  test("a projected bigint under a bound the checker cannot compare it with exactly is withheld as uncheckable, not as invalid", async () => {
    const r = await go((run) => { run.result({ event: "result", value: 1 }, P.bound); }, { transform: (rec) => (rec.event === "result" ? { ...rec, value: 18446744073709551616n } : rec) });
    expect(codes(of(r.err, "warning"))).toEqual(["history.transform_uncheckable"]);
    expect(of(r.stream, "result")).toEqual([]);
    expect(valueText(of(r.receipt, "result")[0]!)).toBe("1");
    expect(r.status).toBe(0);
  });

  test("a transform that returns a bigint the writer could not read back is withheld", async () => {
    const r = await go((run) => { run.result({ event: "result", value: 1 }, P.count); }, { transform: (rec) => (rec.event === "result" ? { ...rec, value: 10n ** 4096n } : rec) });
    expect(codes(of(r.err, "warning"))).toEqual(["history.transform_invalid"]);
    expect(of(r.err, "warning")[0]).toContain("more than 4096 digits");
    expect(of(r.stream, "result")).toEqual([]);
    expect(r.status).toBe(0);
  });

  test("a transform written for numbers that adds one to an integer beyond the safe range throws, and the line is withheld as failed", async () => {
    const r = await go((run) => { run.result({ event: "result", value: 2 ** 53 }, P.count); }, { transform: (rec) => (rec.event === "result" ? { ...rec, value: (rec.value as number) + 1 } : rec) });
    expect(codes(of(r.err, "warning"))).toEqual(["history.transform_failed"]);
    expect(of(r.stream, "result")).toEqual([]);
    expect(r.status).toBe(0);
  });

  test("declaredProjection beside a bigint: the declared value is replaced and the bigint survives exactly", async () => {
    const r = await go((run) => { run.result({ event: "result", note: "built on host-a17", value: BIG }, P.note); }, { transform: declaredProjection(["host-a17"])! });
    expect(r.err).toEqual([]);
    expect(of(r.stream, "result")[0]).toContain(`"note":"built on [redacted]","value":${BIG_TEXT},`);
    expect(of(r.receipt, "result")[0]).toContain(`"note":"built on host-a17","value":${BIG_TEXT},`);
  });

  test("a transform that restores a bigint secret is withheld as unredacted", async () => {
    const secret = "900719925474099312";
    const r = await go((run) => { run.result({ event: "result", value: 1 }, P.count); }, { argv: ["count", "--token", secret], transform: (rec) => (rec.event === "result" ? { ...rec, value: BigInt(secret) } : rec) });
    expect(codes(of(r.err, "warning"))).toContain("history.transform_unredacted");
    expect(r.stream.join("\n")).not.toContain(secret);
  });

  test("receipt text holding a number the writer cannot represent is never rounded for a transform: the line is withheld from the stream and warned", async () => {
    // No public call writes such text: an emission that holds a number the writer cannot read
    // back is refused before it is written. This reaches the reparse directly, so the branch that
    // keeps a rounded value from a transform is held by a test and not only by that refusal.
    const seen: unknown[] = [];
    const r = await go((run) => {
      const internals = run as unknown as { project(text: string, p: unknown): string | null; init: { projection: unknown } };
      const line = internals.project(`{"event":"result","t":1,"seq":77,"run":"${run.id}","value":0.10000000000000001,"_schema":{"id":"t.any","version":"1.0.0"}}`, internals.init.projection);
      expect(line).toBeNull();
      run.step("carried on", "the stream is an observer");
    }, { transform: (rec) => { seen.push(rec.value); return rec; } });
    expect(seen).not.toContain(0.1);
    const warnings = of(r.err, "warning");
    expect(codes(warnings)).toEqual(["history.number_unrepresentable"]);
    expect(warnings[0]).toContain("seq 77");
    expect(warnings[0]).toContain("0.10000000000000001");
    expect(r.status).toBe(0);
  });
});

describe("PE-35 redaction of and beside a bigint", () => {
  const SECRET = "900719925474099312"; // eighteen digits: no double holds it, and it is no timestamp

  test("a bigint that equals a declared numeric secret is replaced, on every sink, and the redaction is recorded", async () => {
    const r = await go((run) => { run.result({ event: "result", value: BigInt(SECRET), other: BigInt(SECRET) + 1n }, P.any); }, { argv: ["count", "--token", SECRET], stream: true });
    expect(r.status).toBe(0);
    for (const lines of [r.out, r.receipt, r.stream]) {
      expect(lines.join("\n")).not.toContain(SECRET);
      expect(of(lines, "result")[0]).toContain('"value":"[redacted]","other":900719925474099313,');
    }
    expect(of(r.receipt, "redaction").some((l) => l.includes('"at":"/value"'))).toBe(true);
  });

  // flyingrobots/parley#178: with a secret present, the scrub rebuilt every object from its own
  // keys, so a value whose JSON form comes from a hook or a box was rewritten or let through.
  test("PE-36 a Date, a boxed primitive and a hooked value are the same record with a secret present as without", async () => {
    const body = (run: Run) => { run.result({ event: "result", when: new Date(0), n: new Number(5), s: new String("x"), b: new Boolean(true), big: Object(BIG), hook: { toJSON: () => ({ kept: 1 }) } }, P.any); };
    const without = await go(body);
    const withSecret = await go(body, { argv: ["count", "--token", "zq7kx9unrelated"] });
    const text = `"when":"1970-01-01T00:00:00.000Z","n":5,"s":"x","b":true,"big":${BIG_TEXT},"hook":{"kept":1},`;
    expect(of(without.receipt, "result")[0]).toContain(text);
    expect(of(withSecret.receipt, "result")[0]).toContain(text);
    expect(of(withSecret.out, "result")[0]).toContain(text);
    expect(withSecret.status).toBe(0);
  });

  test("PE-36 a secret that only a toJSON hook returns is replaced, on every sink", async () => {
    const secret = "zq7kx9hooksecret";
    class Carrier { toJSON() { return { token: secret, note: `the ${secret} inside` }; } }
    const r = await go((run) => { run.result({ event: "result", own: { toJSON: () => secret }, inherited: new Carrier(), list: [{ toJSON: () => [secret] }] }, P.any); }, { argv: ["count", "--token", secret], stream: true });
    for (const lines of [r.out, r.err, r.receipt, r.stream]) expect(lines.join("\n")).not.toContain(secret);
    expect(of(r.receipt, "result")[0]).toContain('"own":"[redacted]","inherited":{"token":"[redacted]","note":"the [redacted] inside"},"list":[["[redacted]"]],');
    expect(of(r.receipt, "redaction").length).toBeGreaterThan(0);
  });

  test("PE-36 a URL holding a secret, and a hook's result that carries its own hook, are scrubbed as what is written", async () => {
    const secret = "zq7kx9urlsecret";
    const r = await go((run) => {
      run.result({ event: "result", url: new URL(`https://user:${secret}@example.test/p`), twice: { toJSON() { return { kept: true, toJSON() { return secret; } }; } } }, P.any);
    }, { argv: ["count", "--token", secret] });
    for (const lines of [r.out, r.err, r.receipt]) expect(lines.join("\n")).not.toContain(secret);
    // The hook is applied once, as JSON.stringify applies it: the result's own hook is not called.
    expect(of(r.receipt, "result")[0]).toContain('"url":"https://user:[redacted]@example.test/p","twice":{"kept":true},');
  });

  test("PE-36 a function with a toJSON hook is scrubbed as what its hook returns, and a hook's callable result is never called again (review of flyingrobots/parley#179)", async () => {
    const secret = "zq7kx9fnsecret";
    const body = (run: Run) => {
      const callable = Object.assign(function () { /* no JSON form of its own */ }, { toJSON: () => secret });
      run.result({
        event: "result",
        hooked_fn: Object.assign(function () { /* */ }, { toJSON: () => ({ kept: 1, note: secret }) }),
        returns_callable: { toJSON: () => callable },
        plain_fn: () => 1,
        list: [Object.assign(function () { /* */ }, { toJSON: () => "from a function" }), () => 2],
      }, P.any);
    };
    const without = await go(body);
    // With no secret, JSON.stringify decides: a hooked function is its hook's result, a hook's callable result is absent.
    expect(of(without.receipt, "result")[0]).toContain(`"hooked_fn":{"kept":1,"note":"${secret}"},"list":["from a function",null],`);
    const r = await go(body, { argv: ["count", "--token", secret], stream: true });
    for (const lines of [r.out, r.err, r.receipt, r.stream]) expect(lines.join("\n")).not.toContain(secret);
    expect(of(r.receipt, "result")[0]).toContain('"hooked_fn":{"kept":1,"note":"[redacted]"},"list":["from a function",null],');
    expect(of(r.receipt, "result")[0]).not.toContain("returns_callable");
    expect(of(r.receipt, "result")[0]).not.toContain("plain_fn");
  });

  test("PE-36 the scrub follows the serialiser's own rules for a hook's result and for a box (second review of flyingrobots/parley#179)", async () => {
    const body = (run: Run) => {
      run.result({
        event: "result",
        // A hook's result is not asked for a hook again, so a throwing `toJSON` getter on it is never read.
        guarded: { toJSON: () => Object.defineProperty({ kept: 1 }, "toJSON", { get() { throw new Error("unexpected lookup"); } }) },
        // A boxed number is converted as the serialiser converts it, which honours Symbol.toPrimitive.
        boxed: { toJSON: () => Object.assign(new Number(5), { [Symbol.toPrimitive]() { return 8; } }) },
        text: Object.assign(new String("a"), { toString() { return "b"; } }),
      }, P.any);
    };
    const without = await go(body);
    const withSecret = await go(body, { argv: ["count", "--token", "zq7kx9unrelated"] });
    const text = '"guarded":{"kept":1},"boxed":8,"text":"b",';
    expect(without.status).toBe(0);
    expect(of(without.receipt, "result")[0]).toContain(text);
    expect(withSecret.status).toBe(0);
    expect(of(withSecret.receipt, "result")[0]).toContain(text);
  });

  test("PE-36 a toJSON installed on BigInt.prototype is never consulted: a bigint is its digits, and what that hook would return is written nowhere (case 2026-11-25, F-1)", async () => {
    // Before, the scrub and the serialiser both asked the prototype hook, and a bigint that a
    // payload's own hook returned was written through it after the scrub: the limit recorded as
    // flyingrobots/parley#180. A bigint is now written as its digits whatever the process has
    // installed, so there is no hook left to leak through.
    const secret = "zq7kx9protosecret";
    const proto = BigInt.prototype as unknown as { toJSON?: () => unknown };
    proto.toJSON = function (this: bigint) { return `${secret}:${this.toString()}`; };
    try {
      const body = (run: Run) => { run.result({ event: "result", value: { id: 42n, list: [7n], hooked: { toJSON: () => 9007199254740993n }, boxed: Object(5n) } }, P.any); };
      for (const argv of [["count"], ["count", "--token", secret]]) {
        const r = await go(body, { argv, stream: true });
        expect(r.status).toBe(0);
        for (const lines of [r.out, r.err, r.receipt, r.stream]) expect(lines.join("\n")).not.toContain(secret);
        for (const lines of [r.out, r.receipt, r.stream]) expect(of(lines, "result").map(valueText)).toEqual([`{"id":42,"list":[7],"hooked":9007199254740993,"boxed":5}`]);
      }
    } finally { delete proto.toJSON; }
  });

  test("PE-36 a bigint equal to a declared secret is replaced whatever BigInt.prototype holds, including one a payload hook returns", async () => {
    const secret = "900719925474099312";
    const proto = BigInt.prototype as unknown as { toJSON?: () => unknown };
    proto.toJSON = function (this: bigint) { return this.toString(); };
    try {
      const r = await go((run) => { run.result({ event: "result", value: { id: { toJSON: () => 42n }, pin: { toJSON: () => BigInt(secret) } } }, P.any); }, { argv: ["count", "--token", secret] });
      for (const lines of [r.out, r.err, r.receipt]) expect(lines.join("\n")).not.toContain(secret);
      expect(of(r.receipt, "result").map(valueText)).toEqual([`{"id":42,"pin":"[redacted]"}`]);
    } finally { delete proto.toJSON; }
  });

  test("a bigint secret under a schema that requires an integer is a conflict, never a rounded or a quoted number", async () => {
    const r = await go((run) => { run.result({ event: "result", value: BigInt(SECRET) }, P.count); }, { argv: ["count", "--token", SECRET] });
    expect(r.status).toBe(4);
    expect(codes(of(r.err, "error"))).toEqual(["redaction.schema_conflict"]);
    expect(r.thrown[0]).toBeInstanceOf(ParleyRedactionConflict);
    expect(of(r.out, "result")).toEqual([]);
    expect([...r.out, ...r.err, ...r.receipt].join("\n")).not.toContain(SECRET);
  });

  test("a bigint beside another redacted field survives exactly, and the post-redaction check passes it as an integer", async () => {
    const r = await go((run) => { run.result({ event: "result", note: `token ${SECRET} was used`, value: BIG }, P.note); }, { argv: ["count", "--token", SECRET] });
    expect(r.err).toEqual([]);
    expect(r.status).toBe(0);
    expect(of(r.out, "result")[0]).toContain(`"note":"token [redacted] was used","value":${BIG_TEXT},`);
    expect(of(r.receipt, "result")[0]).toBe(of(r.out, "result")[0]!);
    expect(of(r.receipt, "redaction").some((l) => l.includes('"at":"/note"'))).toBe(true);
  });

  test("a bigint beside a redacted field, under a bound the checker cannot compare it with exactly, is unchecked: not invalid, not checked as a rounded number", async () => {
    // 2^64 is one more than the schema's text allows, and equals the double the bound loaded as.
    const r = await go((run) => { run.result({ event: "result", note: `token ${SECRET}`, value: 18446744073709551616n }, P.bound); }, { argv: ["count", "--token", SECRET] });
    expect(r.status).toBe(4);
    expect(codes(of(r.err, "error"))).toEqual(["redaction.schema_unchecked"]);
    expect(r.thrown[0]).toBeInstanceOf(ParleyRedactionUnchecked);
    expect(of(r.out, "result")).toEqual([]);
  });

  test("scrub never throws on a bigint and never rounds one", () => {
    const found: string[] = [];
    const value = { a: BIG, list: [BIG, 12345678901234567890n, { deep: -BIG }], s: "x 12345678901234567890 y" };
    const out = scrub(value, new Set(["12345678901234567890"]), "", found) as typeof value;
    expect(out.a).toBe(BIG);
    expect(out.list[0]).toBe(BIG);
    expect(out.list[1]).toBe("[redacted]" as unknown as bigint);
    expect((out.list[2] as { deep: bigint }).deep).toBe(-BIG);
    expect(out.s).toBe("x [redacted] y");
    expect(found).toEqual(["/list/1", "/s"]);
  });
});

describe("PE-35 the bounded checker decides a bigint exactly or says it cannot", () => {
  const ok = { ok: true } as const;
  test("a bigint is a JSON number and an integer", () => {
    expect(checkRecord(BIG, { type: "integer" })).toEqual(ok);
    expect(checkRecord(BIG, { type: "number" })).toEqual(ok);
    expect(checkRecord(BIG, { type: ["string", "integer"] })).toEqual(ok);
    expect(checkRecord(5n, { type: "integer" })).toEqual(ok);
    const wrong = checkRecord(BIG, { type: "string" });
    expect(wrong).toEqual({ ok: false, errors: ["/ is integer, not string"], pointers: ["/"] });
  });

  test("bounds inside the safe range are decided with exact comparison", () => {
    expect(checkRecord(BIG, { minimum: 0 })).toEqual(ok);
    expect(checkRecord(-BIG, { minimum: 0 })).toEqual({ ok: false, errors: ["/ is below 0"], pointers: ["/"] });
    expect(checkRecord(BIG, { maximum: 9007199254740991 })).toEqual({ ok: false, errors: ["/ is above 9007199254740991"], pointers: ["/"] });
    expect(checkRecord(BIG, { exclusiveMinimum: 0.5, exclusiveMaximum: 1.5 })).toEqual({ ok: false, errors: ["/ is not below 1.5"], pointers: ["/"] });
    expect(checkRecord(5n, { minimum: 5, maximum: 5 })).toEqual(ok);
    expect(checkRecord(5n, { exclusiveMinimum: 5 })).toEqual({ ok: false, errors: ["/ is not above 5"], pointers: ["/"] });
  });

  test("a definite match among alternatives decides enum, anyOf and oneOf, wherever an undecidable alternative sits (review of flyingrobots/parley#175)", () => {
    // 9007199254740992 is a schema number beyond the safe range: beside BIG it cannot be placed.
    for (const options of [[9007199254740992, BIG], [BIG, 9007199254740992]]) expect(checkRecord(BIG, { enum: options })).toEqual(ok);
    for (const anyOf of [[{ maximum: 9007199254740992 }, { type: "integer" }], [{ type: "integer" }, { maximum: 9007199254740992 }]]) expect(checkRecord(BIG, { anyOf })).toEqual(ok);
    // No alternative matches and one cannot be decided: unchecked, never invalid.
    expect("unsupported" in checkRecord(BIG, { enum: [9007199254740992, "x"] })).toBe(true);
    expect("unsupported" in checkRecord(BIG, { anyOf: [{ maximum: 9007199254740992 }, { type: "string" }] })).toBe(true);
    // No alternative matches and all were decided: invalid, as before.
    expect("pointers" in checkRecord(BIG, { enum: [1, "x"] })).toBe(true);
    // oneOf: two definite matches fail whatever the third is; one match beside an undecided one is unchecked.
    expect("pointers" in checkRecord(BIG, { oneOf: [{ type: "integer" }, { minimum: 0 }, { maximum: 9007199254740992 }] })).toBe(true);
    expect("unsupported" in checkRecord(BIG, { oneOf: [{ type: "integer" }, { maximum: 9007199254740992 }] })).toBe(true);
    expect(checkRecord(BIG, { oneOf: [{ type: "integer" }, { type: "string" }] })).toEqual(ok);
  });

  test("a bound beyond the safe range is unchecked for a bigint, whichever way a rounded comparison would have gone", () => {
    for (const schema of [{ maximum: 18446744073709551615 }, { minimum: 9007199254740992 }, { exclusiveMaximum: 1e30 }, { exclusiveMinimum: -1e30 }]) {
      for (const value of [BIG, 18446744073709551616n, -BIG, 10n ** 40n]) {
        const verdict = checkRecord(value, schema);
        expect(verdict.ok).toBe(false);
        expect("unsupported" in verdict).toBe(true);
      }
    }
    // A bigint inside the safe range is placed against any bound, and the same bounds still
    // decide an ordinary number as they always did.
    expect(checkRecord(5n, { maximum: 18446744073709551615, exclusiveMinimum: -1e30 })).toEqual(ok);
    expect(checkRecord(5n, { minimum: 1e30 })).toEqual({ ok: false, errors: ["/ is below 1e+30"], pointers: ["/"] });
    expect(checkRecord(5n, { const: 1e30 }).ok).toBe(false);
    expect("pointers" in checkRecord(5n, { const: 1e30 })).toBe(true);
    expect(checkRecord(5, { maximum: 18446744073709551615 })).toEqual(ok);
    expect(checkRecord(1e31, { exclusiveMaximum: 1e30 })).toEqual({ ok: false, errors: ["/ is not below 1e+30"], pointers: ["/"] });
  });

  test("const and enum compare a bigint by value: equal to the same safe number, and unchecked against a number beyond the safe range", () => {
    expect(checkRecord(5n, { const: 5 })).toEqual(ok);
    expect(checkRecord(5n, { enum: [1, 5] })).toEqual(ok);
    expect(checkRecord(BIG, { const: 5 }).ok).toBe(false);
    expect("pointers" in checkRecord(BIG, { const: 5 })).toBe(true);
    expect("pointers" in checkRecord(BIG, { enum: [1, "a", null] })).toBe(true);
    expect("unsupported" in checkRecord(BIG, { const: 9007199254740992 })).toBe(true);
    expect("unsupported" in checkRecord(BIG, { enum: [1, 9007199254740992] })).toBe(true);
    expect(checkRecord({ id: BIG }, { const: { id: 1 } }).ok).toBe(false);
    expect(checkRecord(BIG, { const: "9007199254740993" }).ok).toBe(false);
  });

  test("unchecked reaches the top from inside anyOf, not, items and properties, and the message of a failed const never throws", () => {
    expect("unsupported" in checkRecord({ a: [BIG] }, { properties: { a: { items: { anyOf: [{ type: "string" }, { maximum: 1e30 }] } } } })).toBe(true);
    expect("unsupported" in checkRecord(BIG, { not: { const: 9007199254740992 } })).toBe(true);
    expect(checkRecord("x", { const: BIG })).toEqual({ ok: false, errors: [`/ must be ${BIG_TEXT}`], pointers: ["/"] });
    expect(checkRecord("x", { enum: [BIG, 1] })).toEqual({ ok: false, errors: [`/ must be one of [${BIG_TEXT},1]`], pointers: ["/"] });
    expect(checkRecord(BIG, { const: BIG })).toEqual(ok);
  });

  test("a keyword about another kind of value says nothing about a bigint", () => {
    expect(checkRecord(BIG, { minLength: 3, maxItems: 0, pattern: "^a$", required: ["a"], minProperties: 4 })).toEqual(ok);
  });
});

describe("PE-35 inv and the canonical form", () => {
  test("canonical writes a bigint as its digits, the form the same integer has as a number", () => {
    expect(canonical(BIG)).toBe(BIG_TEXT);
    expect(canonical({ b: [BIG, -BIG], a: 5n })).toBe(`{"a":5,"b":[${BIG_TEXT},-${BIG_TEXT}]}`);
    expect(canonical(5n)).toBe(canonical(5));
    expect(canonical(9007199254740992n)).toBe(canonical(2 ** 53));
  });

  test("two questions that differ by one beyond the safe range have two identities", () => {
    const pre = (id: bigint) => ({ tool: "t", v: "0.0.1", command: "count", resolved: { id }, inputs: [] });
    const a = computeInv(pre(9007199254740992n)), b = computeInv(pre(9007199254740993n));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(a).toBe(createHash("sha256").update('{"command":"count","inputs":[],"resolved":{"id":9007199254740992},"tool":"t","v":"0.0.1"}').digest("hex"));
  });

  test("resolved holding a bigint: the head carries it exactly, and the bootstrap line's inv is the canonical form's digest", async () => {
    const r = await go(() => {}, { extra: { resolved: () => ({ command: "count", id: BIG }) } });
    expect(r.status).toBe(0);
    expect(r.receipt[0]).toContain(`"resolved":{"command":"count","id":${BIG_TEXT}},`);
    const inv = createHash("sha256").update(`{"command":"count","inputs":[],"resolved":{"command":"count","id":${BIG_TEXT}},"tool":"t","v":"0.0.1"}`).digest("hex");
    expect(r.out[0]).toContain(`"inv":"${inv}"`);
    expect(r.receipt[0]).toContain(`"inv":"${inv}"`);
  });

  test("every identity pinned on origin/main is unchanged: canonical text, computeInv and the inv of whole runs", async () => {
    const before = readFileSync(join(import.meta.dir, "fixtures/inv-pinned.jsonl"), "utf8").trimEnd().split("\n");
    const now = await pinned(resolve(import.meta.dir, "../src"));
    expect(before.length).toBe(25);
    // One identity is withdrawn, not moved (flyingrobots/parley#177): a number that is not finite
    // was canonical as `null`, the text of a real `null`, and is now refused. The other 24 stand.
    const notFinite = (l: string) => (JSON.parse(l) as { name: string }).name === "not finite";
    expect(before.filter(notFinite)).toEqual([`{"name":"not finite","how":"canonical","input":["(NaN)","(Infinity)","(-Infinity)"],"text":"[null,null,null]"}`]);
    expect(now.filter(notFinite)).toEqual([`{"name":"not finite","how":"canonical","input":["(NaN)","(Infinity)","(-Infinity)"],"refused":"TypeError"}`]);
    expect(now.filter((l) => !notFinite(l))).toEqual(before.filter((l) => !notFinite(l)));
  });
});

describe("PE-35 nothing throws on a bigint", () => {
  test("--human: the default rendering of a record holding a bigint is its exact text", async () => {
    const r = await go((run) => { run.result({ event: "result", value: BIG }, P.count); }, { argv: ["count", "--human"] });
    expect(r.status).toBe(0);
    expect(r.err).toEqual([]);
    expect(r.out.find((l) => l.startsWith("result: "))).toContain(`"value":${BIG_TEXT},`);
    expect(valueText(of(r.receipt, "result")[0]!)).toBe(BIG_TEXT);
  });

  test("an integer past the cap that only a toJSON hook returns is refused before a seq is taken (review of flyingrobots/parley#175)", async () => {
    const past = 10n ** BigInt(emit.MAX_EXACT_DIGITS);
    const r = await go((run) => {
      run.result({ event: "result", value: { toJSON() { return past; } } }, P.any);
    });
    expect(r.status).toBe(2);
    expect(codes(of(r.err, "error"))).toEqual(["uncaught.exception"]);
    expect(of(r.receipt, "result")).toEqual([]);
    // No line anywhere carries the digits.
    expect([...r.out, ...r.err, ...r.receipt].some((l) => l.includes("1" + "0".repeat(64)))).toBe(false);
  });

  test("--human: a tool's renderer is handed the bigint", async () => {
    const r = await go((run) => { run.result({ event: "result", value: BIG }, P.count); }, { argv: ["count", "--human"], over: { human: (line) => (line.event === "result" ? `counted ${String(line.value)} (${typeof line.value})` : null) } });
    expect(r.out).toContain(`counted ${BIG_TEXT} (bigint)`);
  });

  test("an error with a bigint in its detail and measured is a structured line, and the run ends with status 2", async () => {
    const r = await go((run) => { run.error({ code: "row.too_big", problem: "the row is too big", measured: BIG, detail: { id: BIG } }); });
    expect(r.status).toBe(2);
    expect(of(r.err, "error")[0]).toContain(`"measured":${BIG_TEXT},"detail":{"id":${BIG_TEXT}}`);
    expect(of(r.receipt, "error")[0]).toBe(of(r.err, "error")[0]!);
  });

  test("a thrown bigint, and an error carrying one, are reported as uncaught.exception", async () => {
    const a = await go(() => { throw BIG; });
    expect(a.status).toBe(2);
    expect(codes(of(a.err, "error"))).toEqual(["uncaught.exception"]);
    expect(of(a.err, "error")[0]).toContain(BIG_TEXT);
    const b = await go(() => { throw Object.assign(new Error("row failed"), { cause: { id: BIG } }); });
    expect(b.status).toBe(2);
    expect(codes(of(b.err, "error"))).toEqual(["uncaught.exception"]);
  });

  test("a record that refers to itself is reported as it was before: an uncaught TypeError from the serialiser", async () => {
    const loop: Record<string, unknown> = { event: "result", value: 1 };
    loop.self = loop;
    const r = await go((run) => { run.result(loop, P.any); });
    expect(r.status).toBe(2);
    expect(r.thrown[0]).toBeInstanceOf(TypeError);
    expect(codes(of(r.err, "error"))).toEqual(["uncaught.exception"]);
  });

  test("captured console output of an object holding a bigint keeps its digits", async () => {
    const r = await go(() => { console.log("row", { id: BIG }); });
    expect(r.status).toBe(0);
    expect(of(r.receipt, "receipt.step").find((l) => l.includes("captured console output"))).toContain(`row {\\"id\\":${BIG_TEXT}}`);
  });
});

describe("PE-35 what the writer refuses", () => {
  test("end refuses a bigint status with a TypeError that says so, and main reports it as a structured error with status 2", async () => {
    const r = await go((run) => { run.end(1n as unknown as number); });
    expect(r.thrown[0]).toBeInstanceOf(TypeError);
    expect((r.thrown[0] as Error).message).toContain("not a bigint");
    expect(codes(of(r.err, "error"))).toEqual(["uncaught.exception"]);
    expect(r.status).toBe(2);
    expect(of(r.out, "end")[0]).toContain('"status":2,');
  });

  test("a bigint of more digits than the writer can read back is refused before a seq is taken, and one at the cap is written", async () => {
    const atCap = 10n ** 4096n - 1n, past = 10n ** 4096n;
    const r = await go((run) => {
      for (const emitIt of [
        () => run.result({ event: "result", value: past }, P.any),
        () => run.result({ event: "result", value: 1 }, P.any, { rows: [{ id: -past }] }),
        () => run.step("d", "b", { id: past }),
      ]) expect(emitIt).toThrow(TypeError);
      run.result({ event: "result", value: atCap }, P.any);
    });
    expect(r.err).toEqual([]);
    expect(r.status).toBe(0);
    expect(of(r.out, "result").map(valueText)).toEqual(["9".repeat(4096)]);
    // No gap: the refused emissions took no seq.
    const seqs = r.receipt.map((l) => Number(/"seq":(\d+)/.exec(l)![1]));
    expect(seqs).toEqual(seqs.map((_, i) => seqs[0]! + i));
  });

  test("resolved holding a bigint the writer cannot read back is a startup failure, not a rejection", async () => {
    const r = await go(() => {}, { extra: { resolved: () => ({ command: "count", id: 10n ** 4096n }) } });
    expect(r.status).toBe(3);
    expect(r.out).toEqual([]);
    expect(codes(r.err)).toEqual(["startup.arguments_invalid"]);
  });
});

describe("PE-37 a number that is not finite is refused, never written as null (flyingrobots/parley#177)", () => {
  const NOT_FINITE = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

  test("golden: a result of Infinity ends the run with uncaught.exception and status 2, and no sink holds a null in its place", async () => {
    const r = await go((run) => { run.result({ event: "result", value: Number.POSITIVE_INFINITY }, P.any); });
    expect(r.status).toBe(2);
    expect(codes(of(r.err, "error"))).toEqual(["uncaught.exception"]);
    expect(of(r.err, "error")[0]).toContain("not finite");
    expect(of(r.out, "result")).toEqual([]);
    expect(of(r.receipt, "result")).toEqual([]);
    expect([...r.out, ...r.err, ...r.receipt].some((l) => l.includes(`"value":null`))).toBe(false);
  });

  test("every emitting call refuses one before a seq is taken, wherever it sits, and finite extremes are still written", async () => {
    const r = await go((run) => {
      for (const bad of NOT_FINITE) for (const emitIt of [
        () => run.result({ event: "result", value: bad }, P.any),
        () => run.result({ event: "result", value: { deep: [1, { ratio: bad }] } }, P.any),
        () => run.result({ event: "result", value: 1 }, P.any, { rows: [{ ratio: bad }] }),
        () => run.result({ event: "result", value: { toJSON: () => bad } }, P.any),
        () => run.result({ event: "result", value: Object(bad) }, P.any),
        () => run.step("d", "b", { ratio: bad }),
      ]) expect(emitIt).toThrow(TypeError);
      run.result({ event: "result", value: [Number.MAX_VALUE, 5e-324, -0, null] }, P.any);
    });
    expect(r.err).toEqual([]);
    expect(r.status).toBe(0);
    expect(of(r.out, "result").map(valueText)).toEqual(["[1.7976931348623157e+308,5e-324,0,null]"]);
    const seqs = r.receipt.map((l) => Number(/"seq":(\d+)/.exec(l)![1]));
    expect(seqs).toEqual(seqs.map((_, i) => seqs[0]! + i));
  });

  test("the guard refuses only what the serialiser would write: a hook is given its key, and a box's own properties are not read (review of flyingrobots/parley#181)", async () => {
    const keyed = { toJSON(key: string) { return key === "value" ? 42 : Number.POSITIVE_INFINITY; } };
    const indexed = { toJSON(key: string) { return key === "1" ? 7 : Number.NaN; } };
    const r = await go((run) => {
      run.result({ event: "result", value: keyed }, P.any);
      run.result({ event: "result", value: [0, indexed] }, P.any);
      run.result({ event: "result", value: [Object.assign(new Boolean(true), { ignored: Number.POSITIVE_INFINITY }), Object.assign(new String("s"), { ignored: Number.NaN })] }, P.any);
      run.result({ event: "result", value: [1, Object.assign(() => 1, { ignored: Number.NaN })] }, P.any);
      // And the other way: what a hook on a function returns is written, so it is looked at.
      expect(() => run.result({ event: "result", value: Object.assign(() => 1, { toJSON: () => Number.NaN }) }, P.any)).toThrow(TypeError);
      expect(() => run.result({ event: "result", value: { toJSON(key: string) { return key === "value" ? Number.NaN : 1; } } }, P.any)).toThrow(TypeError);
    });
    expect(r.err).toEqual([]);
    expect(r.status).toBe(0);
    expect(of(r.out, "result").map(valueText)).toEqual(["42", "[0,7]", `[true,"s"]`, "[1,null]"]);
  });

  test("a value whose own toJSON gives null is still null: an invalid Date is what its hook says", async () => {
    const r = await go((run) => { run.result({ event: "result", value: new Date(Number.NaN) }, P.any); });
    expect(r.status).toBe(0);
    expect(of(r.out, "result").map(valueText)).toEqual(["null"]);
  });

  test("resolved holding one is a startup failure", async () => {
    for (const bad of NOT_FINITE) {
      const r = await go(() => {}, { extra: { resolved: () => ({ command: "count", ratio: bad }) } });
      expect(r.status).toBe(3);
      expect(r.out).toEqual([]);
      expect(codes(r.err)).toEqual(["startup.arguments_invalid"]);
      expect(r.err[0]).toContain("not finite");
    }
  });

  test("a transform that returns one is withheld as invalid, and the receipt keeps the record", async () => {
    const r = await go((run) => { run.result({ event: "result", value: 1 }, P.count); }, { transform: (rec) => (rec.event === "result" ? { ...rec, value: Number.NaN } : rec) });
    expect(codes(of(r.err, "warning"))).toEqual(["history.transform_invalid"]);
    expect(of(r.err, "warning")[0]).toContain("not finite");
    expect(of(r.stream, "result")).toEqual([]);
    expect(of(r.receipt, "result").map(valueText)).toEqual(["1"]);
    expect(r.status).toBe(0);
  });

  test("canonical refuses one, so NaN and null are never one identity", () => {
    for (const bad of NOT_FINITE) {
      expect(() => emit.canonical(bad)).toThrow(TypeError);
      expect(() => emit.canonical({ command: "count", ratio: [bad] })).toThrow(TypeError);
    }
    expect(emit.canonical({ ratio: null })).toBe(`{"ratio":null}`);
    expect(() => emit.computeInv({ tool: "t", v: "0.0.1", command: "count", resolved: { ratio: Number.NaN }, inputs: [] })).toThrow(TypeError);
  });

  // The second review of flyingrobots/parley#181: `inv` is the identity of what the head writes.
  const invOf = (resolvedText: string) => createHash("sha256").update(`{"command":"count","inputs":[],"resolved":${resolvedText},"tool":"t","v":"0.0.1"}`).digest("hex");

  test("resolved is identified as it is written: a Date is its string in the head and in inv, and two Dates are two identities", async () => {
    const a = await go(() => {}, { extra: { resolved: () => ({ command: "count", since: new Date(0) }) } });
    const b = await go(() => {}, { extra: { resolved: () => ({ command: "count", since: new Date(86400000) }) } });
    expect(a.status).toBe(0);
    expect(a.receipt[0]).toContain(`"resolved":{"command":"count","since":"1970-01-01T00:00:00.000Z"},`);
    expect(a.out[0]).toContain(`"inv":"${invOf(`{"command":"count","since":"1970-01-01T00:00:00.000Z"}`)}"`);
    expect(b.out[0]).toContain(`"inv":"${invOf(`{"command":"count","since":"1970-01-02T00:00:00.000Z"}`)}"`);
  });

  test("a field a hook leaves out is not read: resolved whose hook returns 42 beside a hidden NaN starts, and inv is over 42", async () => {
    const r = await go(() => {}, { extra: { resolved: () => ({ command: "count", ratio: { raw: Number.NaN, toJSON() { return 42; } }, n: Object(5), skip: () => 1 }) } });
    expect(r.status).toBe(0);
    expect(r.receipt[0]).toContain(`"resolved":{"command":"count","ratio":42,"n":5},`);
    expect(r.out[0]).toContain(`"inv":"${invOf(`{"command":"count","n":5,"ratio":42}`)}"`);
  });

  test("resolved whose hook is on a function and returns NaN is a startup failure, and a hook's callable result is never asked for its own hook", async () => {
    const bad = await go(() => {}, { extra: { resolved: () => ({ command: "count", ratio: Object.assign(() => 1, { toJSON: () => Number.NaN }) }) } });
    expect(bad.status).toBe(3);
    expect(codes(bad.err)).toEqual(["startup.arguments_invalid"]);
    const trap = Object.defineProperty(() => 1, "toJSON", { get() { throw new Error("unused"); } });
    const ok = await go((run) => { run.result({ event: "result", value: { a: 1, gone: { toJSON: () => trap } } }, P.any); }, { extra: { resolved: () => ({ command: "count", gone: { toJSON: () => trap } }) } });
    expect(ok.err).toEqual([]);
    expect(ok.status).toBe(0);
    expect(ok.receipt[0]).toContain(`"resolved":{"command":"count"},`);
    expect(of(ok.out, "result").map(valueText)).toEqual([`{"a":1}`]);
  });

  test("canonical is the form of what the serialiser writes: a hook's result, a box's primitive, and no member for a function", () => {
    expect(emit.canonical(new Date(0))).toBe(`"1970-01-01T00:00:00.000Z"`);
    expect(emit.canonical({ b: Object(5), a: Object("s"), f: () => 1, list: [() => 1, undefined] })).toBe(`{"a":"s","b":5,"list":[null,null]}`);
    expect(emit.canonical({ ratio: { raw: Number.NaN, toJSON: () => 42 } })).toBe(`{"ratio":42}`);
    expect(() => emit.canonical(Object(Number.NaN))).toThrow(TypeError);
    expect(() => emit.canonical(Object.assign(() => 1, { toJSON: () => Number.NaN }))).toThrow(TypeError);
    expect(() => emit.canonical({ r: { toJSON: (key: string) => (key === "r" ? Number.POSITIVE_INFINITY : 1) } })).toThrow(TypeError);
  });

  test("a startup refusal over resolved closes the history stream it had opened", async () => {
    let closed = 0;
    const sink = { dir: "/nowhere", path: "/nowhere/x.jsonl", append() {}, close() { closed++; } };
    const r = await go(() => {}, { extra: { history: sink, resolved: () => ({ command: "count", ratio: Number.NaN }) } });
    expect(r.status).toBe(3);
    expect(closed).toBe(1);
  });

  test("a hook on a boxed bigint is read before the box is, and receiptExtra is compared under each member's key (third review of flyingrobots/parley#181)", async () => {
    const keyed = () => ({ toJSON(key: string) { return key === "value" ? 42 : Number.POSITIVE_INFINITY; } });
    const r = await go((run) => {
      expect(() => run.result({ event: "result", value: Object.assign(Object(1n), { toJSON: () => Number.POSITIVE_INFINITY }) }, P.any)).toThrow(TypeError);
      run.result({ event: "result", value: Object.assign(Object(1n), { toJSON: () => 7 }) }, P.any);
      run.result({ event: "result", value: keyed() }, P.any, { value: keyed() });
    });
    expect(r.err).toEqual([]);
    expect(r.status).toBe(0);
    expect(of(r.out, "result").map(valueText)).toEqual(["7", "42"]);
    expect(of(r.receipt, "result").map(valueText)).toEqual(["7", "42"]);
  });

  test("a boxed primitive from another realm is its primitive: in resolved, in a record, with a secret present and without (fourth review of flyingrobots/parley#181)", async () => {
    const { runInNewContext } = await import("node:vm");
    const foreign = () => runInNewContext(`({ amount: new Number(42), enabled: new Boolean(true), name: new String("n"), id: Object(9007199254740993n), list: [new Number(1.5)] })`) as Record<string, unknown>;
    const text = `{"amount":42,"enabled":true,"name":"n","id":9007199254740993,"list":[1.5]}`;
    for (const argv of [["count"], ["count", "--token", "zq7kx9unrelated"]]) {
      const r = await go((run) => { run.result({ event: "result", value: foreign() }, P.any); }, { argv, extra: { resolved: () => ({ command: "count", ...foreign() }) } });
      expect(r.err).toEqual([]);
      expect(r.status).toBe(0);
      expect(r.receipt[0]).toContain(`"resolved":{"command":"count",${text.slice(1)},`);
      expect(of(r.out, "result").map(valueText)).toEqual([text]);
      expect(of(r.receipt, "result").map(valueText)).toEqual([text]);
    }
    expect(emit.canonical(foreign().amount)).toBe("42");
    expect(emit.holdsExact(foreign())).toBe(true);
    expect(() => emit.canonical(runInNewContext("new Number(NaN)"))).toThrow(TypeError);
  });

  test("deciding whether a value is a boxed bigint reads nothing of the value's own: a throwing Symbol.toStringTag getter changes nothing (review of flyingrobots/parley#182)", async () => {
    const tagged = () => Object.defineProperty({ answer: 42 }, Symbol.toStringTag, { get() { throw new Error("never read by a serialiser"); } });
    for (const argv of [["count"], ["count", "--token", "zq7kx9unrelated"]]) {
      const r = await go((run) => { run.result({ event: "result", value: { t: tagged(), id: 9007199254740993n } }, P.any); }, { argv, extra: { resolved: () => ({ command: "count", t: tagged() }) } });
      expect(r.err).toEqual([]);
      expect(r.status).toBe(0);
      expect(of(r.out, "result").map(valueText)).toEqual([`{"t":{"answer":42},"id":9007199254740993}`]);
    }
  });
});

describe("PE-38 a payload is read once, and what is checked is what is written (review case 2026-11-25)", () => {
  const BIG64 = 2n ** 64n;

  test("F-1: with a toJSON on BigInt.prototype, exactJson and a whole run still write exact unquoted digits", async () => {
    const proto = BigInt.prototype as unknown as { toJSON?: () => unknown };
    for (const hook of [function (this: bigint) { return this.toString(); }, function (this: bigint) { return Number(this); }]) {
      proto.toJSON = hook;
      try {
        expect(emit.exactJson({ id: BIG, list: [BIG + 1n] })).toBe(`{"id":9007199254740993,"list":[9007199254740994]}`);
        expect(emit.canonical({ id: BIG })).toBe(`{"id":9007199254740993}`);
        const r = await go((run) => { run.result({ event: "result", value: BIG }, P.any); }, { stream: true });
        expect(r.status).toBe(0);
        for (const lines of [r.out, r.receipt, r.stream]) expect(of(lines, "result").map(valueText)).toEqual([BIG_TEXT]);
      } finally { delete proto.toJSON; }
    }
  });

  test("F-3: a record is the same bytes with a bigint beside it as without, for a hook that returns a hooked box, a function whose hook reads its key, and a hook that returns a hooked function", async () => {
    const shapes: Record<string, () => unknown> = {
      "hooked box": () => { const n = Object.assign(new Number(5), { toJSON: () => Number.NaN }); return { toJSON: () => n }; },
      "function, keyed hook": () => Object.assign(() => 1, { toJSON: (k: string) => (k === "a" ? 1 : Number.NaN) }),
      "hooked function": () => { const f = Object.assign(() => 1, { toJSON: () => "FROM-INNER-HOOK" }); return { toJSON: () => f }; },
    };
    const want: Record<string, string> = { "hooked box": `"a":5,`, "function, keyed hook": `"a":1,`, "hooked function": "" };
    for (const [name, make] of Object.entries(shapes)) {
      for (const big of [false, true]) for (const argv of [["count"], ["count", "--token", "zq7kx9unrelated"]]) {
        const r = await go((run) => { run.result({ event: "result", value: { a: make(), ...(big ? { big: BIG64 } : {}), z: 0 } }, P.any); }, { argv, stream: true });
        expect(r.err).toEqual([]);
        expect(r.status).toBe(0);
        const text = `{${want[name]}${big ? `"big":18446744073709551616,` : ""}"z":0}`;
        for (const lines of [r.out, r.receipt, r.stream]) expect(of(lines, "result").map(valueText)).toEqual([text]);
      }
    }
  });

  test("F-3: a hook is called once for one emission, so a hook that answers differently the second time cannot put a null past the guard", async () => {
    let calls = 0;
    const r = await go((run) => { run.result({ event: "result", value: { v: { toJSON: () => (calls++ === 0 ? 1 : Number.NaN) }, big: BIG64 } }, P.any); }, { stream: true });
    expect(calls).toBe(1);
    expect(r.status).toBe(0);
    for (const lines of [r.out, r.receipt, r.stream]) expect(of(lines, "result").map(valueText)).toEqual([`{"v":1,"big":18446744073709551616}`]);
  });

  test("F-3: a function whose hook returns a bigint is written as its digits, and a record that refers to itself is refused before a seq is taken", async () => {
    const ok = await go((run) => { run.result({ event: "result", value: Object.assign(() => 1, { toJSON: () => BIG }) }, P.any); });
    expect(ok.status).toBe(0);
    expect(of(ok.out, "result").map(valueText)).toEqual([BIG_TEXT]);
    const loop: Record<string, unknown> = { event: "result", value: 1 };
    loop.self = { again: loop };
    const r = await go((run) => { expect(() => run.result(loop, P.any)).toThrow(TypeError); run.result({ event: "result", value: 2 }, P.any); });
    expect(r.status).toBe(0);
    const seqs = r.receipt.map((l) => Number(/"seq":(\d+)/.exec(l)![1]));
    expect(seqs).toEqual(seqs.map((_, i) => seqs[0]! + i));
    // The same value twice, not inside itself, is not a cycle.
    const shared = { n: 1 };
    const twice = await go((run) => { run.result({ event: "result", value: [shared, shared] }, P.any); });
    expect(of(twice.out, "result").map(valueText)).toEqual([`[{"n":1},{"n":1}]`]);
  });

  test("F-2: a transform cannot restore a declared secret that JSON escapes: a quote, a backslash, a newline, as a value or as a key", async () => {
    for (const secret of ['pa"ss-SECRET77', "pa\\ss-SECRET77", "-----BEGIN KEY-----\nMIIabc\n-----END KEY-----", "plainSECRET77"]) {
      for (const restore of [(rec: Record<string, unknown>) => ({ ...rec, note: secret }), (rec: Record<string, unknown>) => ({ ...rec, [secret]: 1 }), (rec: Record<string, unknown>) => ({ ...rec, deep: [{ inside: `x${secret}y` }] })]) {
        const r = await go((run) => { run.result({ event: "result", value: 1 }, P.any); }, { argv: ["count", "--token", secret], transform: (rec) => (rec.event === "result" ? restore(rec) : rec) });
        expect(codes(of(r.err, "warning"))).toEqual(["history.transform_unredacted"]);
        expect(of(r.stream, "result")).toEqual([]);
        expect(r.stream.join("\n")).not.toContain("SECRET77");
        expect(r.stream.join("\n")).not.toContain("MIIabc");
        expect(r.status).toBe(0);
      }
    }
  });

  test("F-4: an own member named __proto__ is written with a secret present as without", async () => {
    const payload = () => ({ event: "result", value: JSON.parse(`{"a":1,"__proto__":{"kept":"yes"},"b":2}`) as unknown });
    const text = `{"a":1,"__proto__":{"kept":"yes"},"b":2}`;
    for (const argv of [["count"], ["count", "--token", "zq7kx9unrelated"]]) {
      const r = await go((run) => { run.result(payload(), P.any); }, { argv, extra: { resolved: () => ({ command: "count", opts: JSON.parse(`{"__proto__":{"x":1}}`) as unknown }) } });
      expect(r.status).toBe(0);
      expect(of(r.out, "result").map(valueText)).toEqual([text]);
      expect(of(r.receipt, "result").map(valueText)).toEqual([text]);
      expect(r.receipt[0]).toContain(`"resolved":{"command":"count","opts":{"__proto__":{"x":1}}},`);
    }
    const inv = (r: Outcome) => /"inv":"([0-9a-f]{64})"/.exec(r.out[0]!)![1];
    const one = await go(() => {}, { argv: ["count", "--token", "zq7kx9unrelated"], extra: { resolved: () => ({ command: "count", opts: JSON.parse(`{"__proto__":{"x":1}}`) as unknown }) } });
    const two = await go(() => {}, { argv: ["count", "--token", "zq7kx9unrelated"], extra: { resolved: () => ({ command: "count", opts: JSON.parse(`{"__proto__":{"x":2}}`) as unknown }) } });
    expect(inv(one)).not.toBe(inv(two));
  });

  test("an array is read to the length it had when the read began, and a toJSON accessor on BigInt.prototype is never evaluated (review of flyingrobots/parley#183)", () => {
    const grows: unknown[] = [];
    Object.defineProperty(grows, 0, { enumerable: true, configurable: true, get() { grows.push(2); return 1; } });
    expect(emit.exactJson(grows)).toBe("[1]");
    const growsBig: unknown[] = [];
    Object.defineProperty(growsBig, 0, { enumerable: true, configurable: true, get() { growsBig.push(2); return BIG; } });
    expect(emit.exactJson(growsBig)).toBe(`[${BIG_TEXT}]`);
    let evaluated = 0;
    Object.defineProperty(BigInt.prototype, "toJSON", { configurable: true, get() { evaluated++; throw new Error("the hook this writer never asks"); } });
    try {
      expect(emit.exactJson({ value: 1 })).toBe(`{"value":1}`);
      expect(emit.exactJson({ value: BIG, boxed: Object(5n) })).toBe(`{"value":${BIG_TEXT},"boxed":5}`);
      expect(emit.canonical({ value: BIG })).toBe(`{"value":${BIG_TEXT}}`);
      expect(evaluated).toBe(0);
    } finally { delete (BigInt.prototype as unknown as { toJSON?: unknown }).toJSON; }
  });

  test("a result's event is checked on the one reading that is written, and a receipt-only __proto__ member is kept (second review of flyingrobots/parley#183)", async () => {
    let reads = 0;
    const r = await go((run) => {
      // Before, `event` was read twice to check it and a third time to write it, so this record
      // passed the check and was written with no event. It is read once: what is checked is written.
      const shifty = { get event() { return reads++ < 2 ? "result" : undefined; }, value: 1 };
      run.result(shifty as unknown as Record<string, unknown>, P.any);
      expect(reads).toBe(1);
      expect(() => run.result({ get event() { return undefined; }, value: 0 } as unknown as Record<string, unknown>, P.any)).toThrow(TypeError);
      let once = 0;
      run.result({ get event() { once++; return "result"; }, value: 2 } as unknown as Record<string, unknown>, P.any);
      expect(once).toBe(1);
      run.result({ event: "result", value: 3 }, P.any, JSON.parse(`{"__proto__":{"rows":[1]}}`) as Record<string, unknown>);
      expect(() => run.result({ event: "result", value: 4 }, P.any, JSON.parse(`{"toString":1}`) as Record<string, unknown>)).not.toThrow();
    });
    expect(r.err).toEqual([]);
    expect(r.status).toBe(0);
    expect(of(r.out, "result").map(valueText)).toEqual(["1", "2", "3", "4"]);
    expect(of(r.receipt, "result").map(valueText)).toEqual(["1", "2", `3,"__proto__":{"rows":[1]}`, `4,"toString":1`]);
  });

  test("the transform guard keeps its wider rule for numbers: a number whose digits contain a declared secret is withheld (second review of flyingrobots/parley#183)", async () => {
    const r = await go((run) => { run.result({ event: "result", value: 1 }, P.any); }, { argv: ["count", "--token", "123456789012345"], transform: (rec) => (rec.event === "result" ? { ...rec, value: 91234567890123456n } : rec) });
    expect(codes(of(r.err, "warning"))).toEqual(["history.transform_unredacted"]);
    expect(of(r.stream, "result")).toEqual([]);
  });

  test("a secret that is JSON text is not recognised in its parsed parts: ruled outside the contract, and pinned (review case 2026-11-25, F-8)", async () => {
    // Spec 5.3 replaces a declared value where it occurs. The parts of a parsed credential are
    // other values; a tool that emits them declares them. The owner ruled this on 2026-11-26.
    const blob = `{"token":"zq7kx9inner"}`;
    const whole = await go((run) => { run.result({ event: "result", value: { creds: JSON.parse(blob) as unknown, raw: blob } }, P.any); }, { argv: ["count", "--token", blob] });
    expect(of(whole.out, "result").map(valueText)).toEqual([`{"creds":{"token":"zq7kx9inner"},"raw":"[redacted]"}`]);
    const declared = await go((run) => { run.result({ event: "result", value: { creds: JSON.parse(blob) as unknown } }, P.any); }, { argv: ["count", "--token", "zq7kx9inner"] });
    expect(of(declared.out, "result").map(valueText)).toEqual([`{"creds":{"token":"[redacted]"}}`]);
  });
});

describe("PE-39 nothing a tool is handed, or hands over in parts, changes what was checked (fresh review pass, case 2026-11-25)", () => {
  test("a --human renderer that changes the record it is handed changes nothing the receipt or the stream holds, and cannot change the end status", async () => {
    const human = (line: Record<string, unknown>): string | null => {
      if (line.event === "result") { line.avg = Number.NaN; (line.rows as number[]).sort(); line.big = 10n ** 5000n; line.note = "added by the renderer"; }
      if (line.event === "end") line.status = 0;
      return null;
    };
    const body = (run: Run) => { run.result({ event: "result", value: { rows: [3, 1, 2] }, rows: [3, 1, 2] }, P.any); run.error({ code: "probe.failed", problem: "failed on purpose" }); };
    const shown = await go(body, { argv: ["count", "--human"], over: { human }, stream: true });
    const plainRun = await go(body, { stream: true });
    expect(shown.status).toBe(2);
    for (const lines of [shown.receipt, shown.stream]) {
      const result = of(lines, "result")[0]!;
      expect(result).toContain(`"value":{"rows":[3,1,2]},"rows":[3,1,2],"_schema"`);
      expect(result).not.toContain("avg");
      expect(result).not.toContain("added by the renderer");
    }
    expect(of(shown.receipt, "result").map(valueText)).toEqual(of(plainRun.receipt, "result").map(valueText));
    expect(of(shown.receipt, "end")[0]).toContain(`"status":2`);
  });

  test("a diagnostic is read once: each getter is called once, and the code that is checked is the code that is written", async () => {
    const reads = { code: 0, problem: 0, detail: 0, measured: 0 };
    let flips = 0;
    const r = await go((run) => {
      run.warning({
        get code() { reads.code++; return "probe.counted"; }, get problem() { reads.problem++; return "counted"; },
        get detail() { reads.detail++; return { n: reads.detail }; }, get measured() { reads.measured++; return reads.measured; },
      });
      expect(() => run.warning({ get code() { return flips++ === 0 ? "NOT A CODE" : "probe.ok"; }, problem: "p" })).toThrow(TypeError);
      flips = 0;
      run.warning({ get code() { return flips++ === 0 ? "probe.ok" : "NOT A CODE"; }, problem: "p" });
    });
    expect(reads).toEqual({ code: 1, problem: 1, detail: 1, measured: 1 });
    expect(codes(of(r.err, "warning"))).toEqual(["probe.counted", "probe.ok"]);
    expect(of(r.err, "warning")[0]).toContain(`"measured":1,"detail":{"n":1}`);
    expect(r.status).toBe(0);
  });

  test("a result whose event name carries a declared secret is refused before a seq is taken, and the secret is on no sink", async () => {
    const secret = "hunter2secret-zq7";
    const r = await go((run) => {
      expect(() => run.result({ event: secret, note: 1 }, P.any)).toThrow(TypeError);
      expect(() => run.result({ event: `result.${secret}.x`, note: 1 }, P.any)).toThrow(TypeError);
      run.result({ event: "result", value: 1 }, P.any);
    }, { argv: ["count", "--token", secret], stream: true });
    expect(r.status).toBe(0);
    for (const lines of [r.out, r.err, r.receipt, r.stream]) expect(lines.join("\n")).not.toContain(secret);
    const seqs = r.receipt.map((l) => Number(/"seq":(\d+)/.exec(l)![1]));
    expect(seqs).toEqual(seqs.map((_, i) => seqs[0]! + i));
  });

  test("a page's event is page: a record that carries another is refused, whatever its type", async () => {
    const secret = "hunter2secret-zq7";
    const r = await go((run) => {
      expect(() => run.page(null, false, { event: { leak: secret } })).toThrow(TypeError);
      expect(() => run.page(null, false, { event: "other" })).toThrow(TypeError);
      run.page(null, false, { rows: 1 });
    }, { argv: ["count", "--token", secret], stream: true });
    expect(r.status).toBe(0);
    for (const lines of [r.out, r.err, r.receipt, r.stream]) expect(lines.join("\n")).not.toContain(secret);
    expect(of(r.out, "page").length).toBe(1);
  });

  test("inv is the identity of resolved as the head writes it even when a declared secret is a piece of the text [redacted]", async () => {
    // Pieces of the marker that no temporary path or run id can hold, so the run starts.
    for (const secret of ["[red", "acted]", "["]) {
      const r = await go(() => {}, { argv: ["count", "--token", secret], extra: { resolved: () => ({ command: "count", note: `x-${secret}-y` }) } });
      expect(r.status).toBe(0);
      // Scrubbed once: the marker is not scrubbed again into `[[redacted]acted]`.
      const resolvedText = `{"command":"count","note":"x-[redacted]-y"}`;
      expect(r.receipt[0]).toContain(`"resolved":${resolvedText},`);
      const inv = createHash("sha256").update(`{"command":"count","inputs":[],"resolved":${resolvedText},"tool":"t","v":"0.0.1"}`).digest("hex");
      expect(r.receipt[0]).toContain(`"inv":"${inv}"`);
      expect(r.out[0]).toContain(`"inv":"${inv}"`);
    }
  });

  test("a secret that JSON escapes is replaced where the writer itself encodes a value as text: captured console output of an object, and a transform's refusal", async () => {
    for (const secret of ['pa"ss"word-9911', "-----BEGIN KEY-----\nabc123def456\n-----END KEY-----", "back\\slash-7788"]) {
      const r = await go((run) => { console.log("cfg", { token: secret, list: [secret] }); console.error({ key: secret }); run.result({ event: "result", value: 1 }, P.any); },
        { argv: ["count", "--token", secret], transform: () => ({ refuse: { code: "NOT A CODE", problem: `kept out: ${secret}` } }) as never });
      const everything = [...r.out, ...r.err, ...r.receipt, ...r.stream].join("\n");
      expect(everything).not.toContain("word-9911");
      expect(everything).not.toContain("abc123def456");
      expect(everything).not.toContain("slash-7788");
    }
  });

  test("captured console output of a number that is not finite is its name, not null; a thrown error's stack is recorded only when it is text", async () => {
    const secret = "hunter2secret-zq7";
    const r = await go(() => {
      console.log(Number.NaN); console.log(Number.POSITIVE_INFINITY, 5n);
      const e = new Error("failed on purpose");
      Object.defineProperty(e, "stack", { value: { name: secret, code: secret, frames: [secret] } });
      throw e;
    }, { argv: ["count", "--token", secret] });
    expect(r.status).toBe(2);
    const text = r.receipt.join("\n");
    expect(text).toContain(`"text":"NaN"`);
    expect(text).toContain(`"text":"Infinity 5"`);
    expect([...r.out, ...r.err, ...r.receipt].join("\n")).not.toContain(secret);
  });

  test("a history transform's name is scrubbed like any other text of the tool's, on the stream's opening line too", async () => {
    const secret = "hunter2secret-zq7";
    const r = await go((run) => { run.result({ event: "result", value: 1 }, P.any); }, { argv: ["count", "--token", secret], extra: { history: { transform: (rec) => rec, name: `proj-${secret}` } }, stream: true });
    expect(r.stream.join("\n")).not.toContain(secret);
    expect(of(r.stream, "history.transform")[0]).toContain(`"name":"proj-[redacted]"`);
    for (const lines of [r.out, r.err, r.receipt]) expect(lines.join("\n")).not.toContain(secret);
  });

  test("a bigint is its digits whatever the process has put on BigInt.prototype: toString and valueOf as well as toJSON", async () => {
    const proto = BigInt.prototype as unknown as Record<string, unknown>;
    const realToString = proto.toString, realValueOf = proto.valueOf;
    for (const patch of [
      () => { proto.toString = function (this: bigint) { return `"${String(this)}"`; }; },
      () => { proto.toString = function (this: bigint) { return String(Number(this)); }; },
      () => { proto.valueOf = function () { return { toJSON: () => "FROM-VALUEOF" }; }; },
    ]) {
      patch();
      try {
        expect(emit.exactJson({ n: BIG, boxed: Object(BIG) })).toBe(`{"n":${BIG_TEXT},"boxed":${BIG_TEXT}}`);
        expect(emit.canonical({ n: BIG })).toBe(`{"n":${BIG_TEXT}}`);
        const r = await go((run) => { run.result({ event: "result", value: [BIG, Object(BIG)] }, P.any); }, { stream: true, extra: { resolved: () => ({ command: "count", id: BIG }) } });
        expect(r.status).toBe(0);
        for (const lines of [r.out, r.receipt, r.stream]) expect(of(lines, "result").map(valueText)).toEqual([`[${BIG_TEXT},${BIG_TEXT}]`]);
        expect(r.receipt[0]).toContain(`"resolved":{"command":"count","id":${BIG_TEXT}}`);
      } finally { proto.toString = realToString; proto.valueOf = realValueOf; }
    }
  });

  test("a clock that answers with something that is not a time does not put a null where t belongs", async () => {
    let calls = 0;
    const r = await go((run) => { run.result({ event: "result", value: 1 }, P.any); }, { extra: { now: () => (calls++ < 2 ? 1795326412346 : Number.NaN) } });
    for (const line of [...r.out, ...r.receipt]) expect(line).toMatch(/"t":\d+,/);
  });

  test("exactText writes plain data with no hook asked: a toJSON on Array.prototype or Object.prototype changes nothing", () => {
    const value = { id: BIG, list: [1, { n: 2 }], s: "x" };
    const text = `{"id":${BIG_TEXT},"list":[1,{"n":2}],"s":"x"}`;
    expect(emit.exactText(value)).toBe(text);
    expect(emit.exactText({ list: [1, 2] })).toBe(`{"list":[1,2]}`);
    for (const proto of [Array.prototype, Object.prototype] as unknown as { toJSON?: unknown }[]) {
      Object.defineProperty(proto, "toJSON", { configurable: true, enumerable: false, value() { return "COLLAPSED"; } });
      let got: string, plainGot: string;
      try { got = emit.exactText(value); plainGot = emit.exactText({ list: [1, 2] }); } finally { delete proto.toJSON; }
      expect(got).toBe(text);
      expect(plainGot).toBe(`{"list":[1,2]}`);
    }
  });

  test("a clock that is never a time gives a real run id and a real t, at startup too", async () => {
    const started = await go((run) => { run.result({ event: "result", value: 1 }, P.any); }, { extra: { now: () => Number.NaN } });
    expect(started.status).toBe(0);
    for (const line of [...started.out, ...started.receipt]) { expect(line).toMatch(/"t":\d+,/); expect(line).toMatch(/"run":"[0-9A-HJKMNP-TV-Z]{26}"/); }
    const failed = await go(() => {}, { extra: { now: () => Number.NaN, resolved: () => { throw new Error("arguments refused on purpose"); } } });
    expect(failed.status).toBe(3);
    expect(failed.err[0]).toMatch(/"t":\d+,/);
    expect(failed.err[0]).toMatch(/"run":"[0-9A-HJKMNP-TV-Z]{26}"/);
  });
});
