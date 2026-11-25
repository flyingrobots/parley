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
import { holdsUnreadable } from "../src/exact.ts";

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

  test("exactJson reads a value at most twice: a getter is read again when a bigint sends it to the exact writer (review of flyingrobots/parley#175)", () => {
    // Pinned, not endorsed: JSON.stringify runs first so that a value with no bigint is its own
    // text byte for byte, and a bigint is found by that pass failing. Pass plain data.
    let reads = 0;
    const text = emit.exactJson({ get id() { reads++; return BIG; } });
    expect(text).toBe(`{"id":${BIG_TEXT}}`);
    expect(reads).toBe(2);
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
    expect(now).toEqual(before);
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
