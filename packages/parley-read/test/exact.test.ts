// A read preserves a number's value, or says it cannot (flyingrobots/parley#159; RD-120 to RD-123).
//
// Every fixture here is literal JSON text. The number under test is spliced into a line as
// characters and never passes through a JavaScript number on its way to disk, because a number
// built in JavaScript has already been rounded and would prove nothing about the reader.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  RUN_SECTION_BYTES, digestBytes, digestFor, digestLine, exactJson, foldRuns, loadReceipts, openRecords, planQuery, queryReceipts, rankRecords, readReceiptFile, recordBytes, runSection, validator,
  type Bundle, type Defect, type LoadedRecord, type OpenAnswer, type QueryAnswer,
} from "../src/index.ts";
import { UNREPRESENTABLE, parseExact } from "@flyingrobots/parley-emit";
import { MAX_EXACT_DIGITS } from "../src/index.ts";

const T0 = 1795326412346;
const DAY = 86_400_000;
const WINDOW = { from: 0, to: T0 + 1000 };
const runId = (n: number) => `01M81NYC9E28S33150VJB${String(n).padStart(5, "0")}`;
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "parley-exact-"));
  const state = mkdtempSync(join(tmpdir(), "parley-exact-state-"));
  return { dir, receipts: join(dir, ".parley", "receipts"), env: { XDG_STATE_HOME: state } as Record<string, string> };
}

const headLine = (run: string, at: number, resolved = `{"command":"count"}`) =>
  `{"event":"receipt.head","t":${at},"seq":1,"run":"${run}","tool":"t","v":"0.0.1","argv":["t","count"],"resolved":${resolved},"inputs":[],"inv":"inv_same","_schema":{"id":"parley.receipt.head","version":"2.0.0"}}`;
const resultLine = (run: string, at: number, valueText: string, seq: number | string = 2) =>
  `{"event":"result","t":${at},"seq":${seq},"run":"${run}","value":${valueText},"_schema":{"id":"t.count","version":"1.0.0"}}`;
const endLine = (run: string, at: number, path: string, seq = 3, status = "0") =>
  `{"event":"end","t":${at},"seq":${seq},"run":"${run}","status":${status},"receipt":${JSON.stringify(path)},"redacted":false,"_schema":{"id":"parley.end","version":"1.0.0"}}`;

function writeLines(receipts: string, run: string, lines: readonly string[]): string {
  mkdirSync(receipts, { recursive: true });
  const path = join(receipts, `${run}.jsonl`);
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

/** One run of one invocation: a head, one result whose `value` is the given text, an `end`. */
function receipt(receipts: string, n: number, valueText: string, resolved?: string): string {
  const run = runId(n);
  const at = T0 - (10 - n) * DAY;
  const path = join(receipts, `${run}.jsonl`);
  return writeLines(receipts, run, [headLine(run, at, resolved), resultLine(run, at + 2, valueText), endLine(run, at + 3, path)]);
}

function answered(outcome: Awaited<ReturnType<typeof queryReceipts>>): QueryAnswer {
  if (outcome.refused || outcome.declined) throw new Error(`the read did not answer: ${JSON.stringify(outcome)}`);
  return outcome;
}

async function ask(valueA: string, valueB: string, fold?: boolean) {
  const { dir, receipts, env } = scratch();
  receipt(receipts, 1, valueA);
  receipt(receipts, 2, valueB);
  const answer = answered(await queryReceipts(
    { asker: { tool: "t" }, view: "everything", window: WINDOW, budget: { records: 1000 }, ...(fold === undefined ? {} : { fold }) },
    { cwd: dir, env },
  ));
  const value = (n: number) => answer.records.find((r) => r.run === runId(n) && r.event === "result")?.record.value;
  return { dir, env, answer, sections: answer.digest.runs.length, folded: answer.digest.runs.filter((s) => s.folded !== undefined).length, a: value(1), b: value(2) };
}

const only = (dir: string, env: Record<string, string>): Bundle => {
  const { bundles } = loadReceipts({ cwd: dir, env });
  expect(bundles.length).toBe(1);
  return bundles[0]!;
};
const coded = (defects: readonly Defect[], code: string) => defects.filter((d) => (d.code as string) === code);

// ---- RD-120 an integer a double cannot hold is loaded exactly --------------------------------

describe("RD-120 an integer beyond a double's range is loaded exactly and compared exactly", () => {
  test("two runs whose results are 9007199254740992 and 9007199254740993 are two sections, each value exact", async () => {
    const r = await ask("9007199254740992", "9007199254740993");
    expect(r.sections).toBe(2);
    expect(r.folded).toBe(0);
    expect(r.answer.digest.loss).toEqual({ bound: "none", excluded: 0, folded: 0 });
    expect(r.a).toBe(9007199254740992n);
    expect(r.b).toBe(9007199254740993n);
    expect(String(r.b)).toBe("9007199254740993");
  });

  test("with fold false each value comes back exactly", async () => {
    const r = await ask("9007199254740992", "9007199254740993", false);
    expect(r.sections).toBe(2);
    expect(String(r.a)).toBe("9007199254740992");
    expect(String(r.b)).toBe("9007199254740993");
  });

  test("the negative pair, a nested pair, and a pair that never shared a double", async () => {
    const negative = await ask("-9007199254740992", "-9007199254740993");
    expect(negative.sections).toBe(2);
    expect(negative.b).toBe(-9007199254740993n);

    const nested = await ask(`{"n":[1,9007199254740992]}`, `{"n":[1,9007199254740993]}`);
    expect(nested.sections).toBe(2);
    expect((nested.b as { n: unknown[] }).n).toEqual([1, 9007199254740993n]);
    expect((nested.a as { n: unknown[] }).n).toEqual([1, 9007199254740992n]);

    const apart = await ask("9007199254740993", "9007199254740994");
    expect(apart.sections).toBe(2);
    expect(String(apart.a)).toBe("9007199254740993");
    expect(apart.b).toBe(9007199254740994n);
  });

  test("two runs that both answered 9007199254740993 still fold, and the representative's value is exact", async () => {
    const r = await ask("9007199254740993", "9007199254740993");
    expect(r.sections).toBe(1);
    expect(r.folded).toBe(1);
    expect(r.b).toBe(9007199254740993n);
  });

  test("integral exponent notation is the integer it writes: equal to the same digits, different from the neighbour", async () => {
    const equal = await ask("9007199254740993", "9.007199254740993e15");
    expect(equal.sections).toBe(1);
    expect(equal.b).toBe(9007199254740993n);

    const differs = await ask("9007199254740992", "9.007199254740993e15");
    expect(differs.sections).toBe(2);
    expect(differs.a).toBe(9007199254740992n);
    expect(differs.b).toBe(9007199254740993n);

    // A trailing ".0" is the same integer too, and so is an exponent form of one a double could hold.
    const pointed = await ask("9007199254740993", "9007199254740993.0");
    expect(pointed.sections).toBe(1);
    expect(pointed.b).toBe(9007199254740993n);
    const plain = await ask("9007199254740992", "9.007199254740992e15");
    expect(plain.sections).toBe(1);
    expect(plain.b).toBe(9007199254740992n);
  });

  test("a number and a string of the same digits are different values", async () => {
    const r = await ask("9007199254740993", `"9007199254740993"`);
    expect(r.sections).toBe(2);
    expect(r.a).toBe(9007199254740993n);
    expect(r.b).toBe("9007199254740993");
  });

  test("1e400 and 2e400 are two integers, not one Infinity", async () => {
    const r = await ask("1e400", "2e400");
    expect(r.sections).toBe(2);
    expect(r.a).toBe(10n ** 400n);
    expect(r.b).toBe(2n * 10n ** 400n);
    const same = await ask("1e400", "1e400");
    expect(same.sections).toBe(1);
  });

  test("the boundary is the safe-integer range, decided from the token: inside it a number, outside it a bigint, always", () => {
    // The token as written, the JavaScript type it loads as, and the text `exactJson` writes for it.
    const TABLE: readonly (readonly [string, "number" | "bigint" | "string", string])[] = [
      ["9007199254740991", "number", "9007199254740991"],
      ["9007199254740992", "bigint", "9007199254740992"],
      ["9007199254740993", "bigint", "9007199254740993"],
      ["9007199254740994", "bigint", "9007199254740994"],
      [`"9007199254740993"`, "string", `"9007199254740993"`],
      ["1.5", "number", "1.5"],
      ["-9007199254740991", "number", "-9007199254740991"],
      ["-9007199254740992", "bigint", "-9007199254740992"],
      ["9007199254740993.0", "bigint", "9007199254740993"],
      ["9007199254740991.0", "number", "9007199254740991"],
      ["9.007199254740993e15", "bigint", "9007199254740993"],
      ["9.007199254740991e15", "number", "9007199254740991"],
      ["900719925474099.3e1", "bigint", "9007199254740993"],
      ["1e400", "bigint", `1${"0".repeat(400)}`],
      ["1e21", "bigint", "1000000000000000000000"],
      ["1e3", "number", "1000"],
      ["5.0", "number", "5"],
      ["120e-1", "number", "12"],
      ["0", "number", "0"],
      ["-0.0", "number", "0"],
      ["0e400", "number", "0"],
      ["18446744073709551615", "bigint", "18446744073709551615"],
    ];
    const { dir, receipts, env } = scratch();
    const run = runId(1);
    const path = join(receipts, `${run}.jsonl`);
    writeLines(receipts, run, [headLine(run, T0), ...TABLE.map(([text], i) => resultLine(run, T0 + 2, text, i + 2)), endLine(run, T0 + 3, path, TABLE.length + 2)]);
    const bundle = only(dir, env);
    expect(bundle.defects).toEqual([]);
    TABLE.forEach(([text, type, emitted], i) => {
      const value = bundle.records.find((r) => r.seq === i + 2)!.record.value;
      expect(`${text} loads as ${typeof value} and is written ${exactJson(value)}`).toBe(`${text} loads as ${type} and is written ${emitted}`);
    });
  });

  test("load, then exactJson: the digits that went in are the digits that come out, as a JSON number", () => {
    const DIGITS = ["9007199254740992", "9007199254740993", "-9007199254740993", "18446744073709551615", "170141183460469231731687303715884105727", `1${"0".repeat(400)}`, "9007199254740991", "-1", "0"];
    const { dir, receipts, env } = scratch();
    const run = runId(1);
    const path = join(receipts, `${run}.jsonl`);
    const lines = DIGITS.map((text, i) => resultLine(run, T0 + 2, `{"id":${text},"ids":[${text}]}`, i + 2));
    writeLines(receipts, run, [headLine(run, T0), ...lines, endLine(run, T0 + 3, path, DIGITS.length + 2)]);
    const bundle = only(dir, env);
    DIGITS.forEach((text, i) => {
      const record = bundle.records.find((r) => r.seq === i + 2)!;
      // The whole line comes back byte for byte: these lines hold no other number a serialiser would respell.
      expect(exactJson(record.record)).toBe(lines[i]!);
      expect(exactJson(record.record.value)).toBe(`{"id":${text},"ids":[${text}]}`);
      // And what was written loads again to the same values.
      expect(exactJson(parseExact(exactJson(record.record)))).toBe(exactJson({ ok: true, value: record.record }));
    });
    expect(exactJson({ value: 9007199254740993n })).toBe(`{"value":9007199254740993}`);
  });

  test("materialisation is bounded: an integer past the cap, an enormous exponent or a very long token is held back, not built", () => {
    expect(MAX_EXACT_DIGITS).toBe(4096);
    expect((parseExact("[1e4095]") as { value: [bigint] }).value[0]).toBe(10n ** 4095n);
    expect((parseExact(`[${"9".repeat(4096)}]`) as { value: [bigint] }).value[0].toString().length).toBe(4096);
    const started = Date.now();
    for (const token of ["1e4096", `${"9".repeat(4097)}`, "1e1000000000", "-1e1000000000", `1e${"9".repeat(400)}`, `${"1".repeat(2_000_000)}`, `1${"0".repeat(2_000_000)}.5`, "1e-1000000000"]) {
      const parsed = parseExact(`{"run":"r","seq":2,"value":${token}}`);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.tokens).toEqual([token]);
    }
    expect(Date.now() - started).toBeLessThan(5_000);
    // In a receipt it is the held-back line, with its bytes, like any other number the reader cannot hold.
    const { dir, receipts, env } = scratch();
    const run = runId(1);
    const path = join(receipts, `${run}.jsonl`);
    const raw = resultLine(run, T0 + 2, "1e1000000000");
    writeLines(receipts, run, [headLine(run, T0), raw, endLine(run, T0 + 3, path)]);
    expect(coded(only(dir, env).defects, "line.number_unrepresentable").map((d) => d.raw)).toEqual([raw]);
  });

  test("two copies of one (run, seq) that differ only in such an integer disagree", () => {
    const { dir, receipts, env } = scratch();
    const run = runId(1);
    const path = join(receipts, `${run}.jsonl`);
    writeLines(receipts, run, [
      headLine(run, T0), resultLine(run, T0 + 2, "9007199254740992"), resultLine(run, T0 + 2, "9007199254740993"), endLine(run, T0 + 3, path),
    ]);
    const bundle = only(dir, env);
    const disagreements = coded(bundle.defects, "copies.disagree");
    expect(disagreements.length).toBe(1);
    expect(disagreements[0]!.problem).toContain("value");
    // The first copy is the record (§1.3), and it is the value its line holds.
    expect(bundle.records.find((r) => r.seq === 2)!.record.value).toBe(9007199254740992n);

    const again = scratch();
    writeLines(again.receipts, run, [
      headLine(run, T0), resultLine(run, T0 + 2, "9007199254740993"), resultLine(run, T0 + 2, "9.007199254740993e15"), endLine(run, T0 + 3, join(again.receipts, `${run}.jsonl`)),
    ]);
    const agreeing = only(again.dir, again.env);
    expect(coded(agreeing.defects, "copies.disagree")).toEqual([]);
    expect(agreeing.records.find((r) => r.seq === 2)!.copies).toBe(2);
  });

  test("a record stored in a sidecar is loaded under the same rule", () => {
    const { dir, receipts, env } = scratch();
    const run = runId(1);
    const stored = resultLine(run, T0 + 2, `{"big":9007199254740993,"neg":-9007199254740993,"ok":9007199254740991}`);
    mkdirSync(join(receipts, run), { recursive: true });
    writeFileSync(join(receipts, run, "2.json"), stored);
    const path = join(receipts, `${run}.jsonl`);
    writeLines(receipts, run, [
      headLine(run, T0),
      `{"event":"sidecar","t":${T0 + 2},"seq":3,"run":"${run}","source":2,"path":"${run}/2.json","bytes":${Buffer.byteLength(stored)},"sha256":"${sha(stored)}","_schema":{"id":"parley.sidecar","version":"1.0.0"}}`,
      endLine(run, T0 + 3, path, 4),
    ]);
    const bundle = only(dir, env);
    expect(bundle.sidecars[0]!.state).toBe("intact");
    const restored = bundle.records.find((r) => r.seq === 2)!;
    expect(restored.fromSidecar).toBe(true);
    expect(restored.record.value).toEqual({ big: 9007199254740993n, neg: -9007199254740993n, ok: 9007199254740991 });
  });

  test("the receipt copy and the sidecar copy of one record disagree when they differ only in such an integer", () => {
    const { dir, receipts, env } = scratch();
    const run = runId(1);
    const stored = resultLine(run, T0 + 2, "9007199254740993");
    mkdirSync(join(receipts, run), { recursive: true });
    writeFileSync(join(receipts, run, "2.json"), stored);
    const path = join(receipts, `${run}.jsonl`);
    writeLines(receipts, run, [
      headLine(run, T0),
      resultLine(run, T0 + 2, "9007199254740992"),
      `{"event":"sidecar","t":${T0 + 2},"seq":3,"run":"${run}","source":2,"path":"${run}/2.json","bytes":${Buffer.byteLength(stored)},"sha256":"${sha(stored)}","_schema":{"id":"parley.sidecar","version":"1.0.0"}}`,
      endLine(run, T0 + 3, path, 4),
    ]);
    expect(coded(only(dir, env).defects, "copies.disagree").length).toBe(1);
  });

  test("ordinary numbers load as they always did, whichever path parsed the line", () => {
    const ordinary = `{"a":0,"b":-0,"c":0.1,"d":1e3,"e":1.5e-7,"f":9007199254740991,"g":-9007199254740991,"h":1e15,"i":123456789012345,"j":0.30000000000000004,"k":1.0,"l":[1,2.5,{"m":-3e2}],"n":"9007199254740993","o":"a \\"quoted\\" 1e400 \\\\","p":true,"q":null,"r":5e-324,"s":2.2250738585072014e-308,"t":5.0,"__proto__":{"u":1},"dup":1,"dup":2,"v":{},"w":[]}`;
    // What a JSON serialiser writes for those values, written out here by hand: the oracle is this
    // text, never a second parse of the input, which would round the expected value with the actual.
    const emitted = `{"a":0,"b":0,"c":0.1,"d":1000,"e":1.5e-7,"f":9007199254740991,"g":-9007199254740991,"h":1000000000000000,"i":123456789012345,"j":0.30000000000000004,"k":1,"l":[1,2.5,{"m":-300}],"n":"9007199254740993","o":"a \\"quoted\\" 1e400 \\\\","p":true,"q":null,"r":5e-324,"s":2.2250738585072014e-308,"t":5,"__proto__":{"u":1},"dup":2,"v":{},"w":[]}`;
    const { dir, receipts, env } = scratch();
    const run = runId(1);
    const path = join(receipts, `${run}.jsonl`);
    // The same payload twice: once on a line of ordinary numbers only, once beside an integer that
    // sends the line down the exact path.
    writeLines(receipts, run, [
      headLine(run, T0), resultLine(run, T0 + 2, ordinary), resultLine(run, T0 + 2, `[${ordinary},9007199254740993]`, 3), endLine(run, T0 + 3, path, 4),
    ]);
    const bundle = only(dir, env);
    expect(bundle.defects).toEqual([]);
    const fast = bundle.records.find((r) => r.seq === 2)!.record.value as Record<string, unknown>;
    const [exact, big] = bundle.records.find((r) => r.seq === 3)!.record.value as [Record<string, unknown>, unknown];
    expect(exactJson(big)).toBe("9007199254740993");
    for (const loaded of [fast, exact]) {
      expect(exactJson(loaded)).toBe(emitted);
      expect(JSON.stringify(loaded)).toBe(emitted);
      expect(Object.is(loaded.b, -0)).toBe(true);
      // A member named __proto__ is data, as JSON.parse makes it, and never the object's prototype.
      expect(Object.getPrototypeOf(loaded)).toBe(Object.prototype);
      expect(exactJson(Object.getOwnPropertyDescriptor(loaded, "__proto__")?.value)).toBe(`{"u":1}`);
    }
  });

  test("a number of at most fifteen digits is the double it parses to, which is what lets the scan pass it unparsed", () => {
    // The scan accepts such a token without parsing it. This is the claim it relies on, checked
    // against a normaliser written here rather than the module's own.
    const normal = (token: string) => {
      const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token)!;
      const digits = (m[2]! + (m[3] ?? "")).replace(/^0+/, "");
      const kept = digits.replace(/0+$/, "");
      if (kept === "") return "0";
      return `${m[1]}${kept}e${Number(m[4] ?? 0) - (m[3] ?? "").length + digits.length - kept.length}`;
    };
    let seed = 159;
    const next = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const digits = (n: number) => Array.from({ length: n }, () => String(next(10))).join("");
    for (let i = 0; i < 20_000; i++) {
      const whole = 1 + next(15);
      const fraction = next(16 - whole);
      const int = digits(whole).replace(/^0+(?=\d)/, "");
      const token = `${next(2) === 0 ? "-" : ""}${int}${fraction === 0 ? "" : `.${digits(fraction)}`}`;
      const parsed = parseExact(`[${token}]`);
      if (!parsed.ok) throw new Error(`${token} was not held`);
      const [value] = parsed.value as [unknown];
      expect(typeof value).toBe("number");
      expect(`${token} is ${normal(String(value))}`).toBe(`${token} is ${normal(token)}`);
    }
    // Past fifteen digits, or with an exponent, a number is parsed and compared with its double.
    const held = (text: string) => { const parsed = parseExact(text); if (!parsed.ok) throw new Error(`${text} was not held`); return exactJson(parsed.value); };
    expect(held("[0.1000000000000001,0.30000000000000004,1.5e-7,2.5E+3,12345678901234567]")).toBe("[0.1000000000000001,0.30000000000000004,1.5e-7,2500,12345678901234567]");
  });

  test("a non-integral number is held only when writing it back states the decimal it stated", () => {
    // flyingrobots/parley#173: the token's decimal value must be the decimal value of the number's
    // own JSON serialisation. Spellings of one decimal are one value.
    const parsed = parseExact("[0.1,0.10,1e-1,1.0e-1,0.1000,-2.50,25e-1]");
    if (!parsed.ok) throw new Error("not held");
    expect(exactJson(parsed.value)).toBe("[0.1,0.1,0.1,0.1,0.1,-2.5,2.5]");
    // Two decimals that round to one double are not the same evidence: the longer one is not held,
    // however a formatter might have come to write it.
    for (const token of ["0.10000000000000001", "0.1000000000000000055", "0.1000000000000000055511151231257827", "0.30000000000000004441", "1.00000000000000000001", "1e-400", "4.9e-324", `0.${"1".repeat(200)}`, `${"9".repeat(400)}.5`]) {
      expect(parseExact(`[${token}]`)).toEqual({ ok: false, tokens: [token], partial: [UNREPRESENTABLE] });
    }
  });

  test("two runs whose results are one decimal spelt two ways fold; a longer spelling of the same double is held back", async () => {
    for (const other of ["0.10", "1e-1"]) {
      const same = await ask("0.1", other);
      expect(same.sections).toBe(1);
      expect(exactJson(same.b)).toBe("0.1");
      expect(same.answer.counts.unrepresentable).toBe(0);
    }
    const longer = await ask("0.1", "0.10000000000000001");
    expect(longer.sections).toBe(2);
    expect(longer.folded).toBe(0);
    expect(exactJson(longer.a)).toBe("0.1");
    expect(longer.b).toBeUndefined();
    expect(longer.answer.counts.unrepresentable).toBe(1);
    const held = coded(longer.answer.load.quarantined, "line.number_unrepresentable");
    expect(held.map((d) => d.raw)).toEqual([resultLine(runId(2), T0 - 8 * DAY + 2, "0.10000000000000001")]);
  });

  test("a line that is not JSON is quarantined as before, whatever numbers it holds", () => {
    const { dir, receipts, env } = scratch();
    const run = runId(1);
    const path = join(receipts, `${run}.jsonl`);
    writeLines(receipts, run, [headLine(run, T0), `{"value":9007199254740993,}`, `{"value":01}`, `[9007199254740993]`, endLine(run, T0 + 3, path)]);
    const bundle = only(dir, env);
    expect(bundle.quarantined.map((q) => q.code)).toEqual(["line.quarantined", "line.quarantined", "line.quarantined"]);
    expect(bundle.quarantined.map((q) => q.raw)).toEqual([`{"value":9007199254740993,}`, `{"value":01}`, `[9007199254740993]`]);
  });
});

// ---- RD-121 validation: every conclusion the record supports, none from a rounded value ------

describe("RD-121 a record holding such an integer is validated exactly: invalid on one conclusive failure, partial only when undecided", () => {
  const SIDE = `"note":{"id":9007199254740993}`; // an unrelated integer beyond the range, in a member the schemas leave open
  /** One receipt whose `end` is the given text; returns the loaded `end` record and its bundle. */
  function ended(endText: (run: string, path: string) => string) {
    const { dir, receipts, env } = scratch();
    const run = runId(1);
    const path = join(receipts, `${run}.jsonl`);
    writeLines(receipts, run, [headLine(run, T0), resultLine(run, T0 + 2, "1"), endText(run, path)]);
    const load = loadReceipts({ cwd: dir, env });
    const bundle = load.bundles[0]!;
    return { dir, env, run, load, bundle, end: bundle.records.find((r) => r.seq === 3)! };
  }
  const errors = (r: LoadedRecord) => (r.validation.state === "invalid" ? r.validation.errors.join("; ") : `(${r.validation.state})`);

  test("a known parley.* schema: an end whose status is beyond the range is invalid under the shipped maximum, and the run still failed", async () => {
    const { dir, env, run, load, bundle, end } = ended((r, p) => endLine(r, T0 + 3, p, 3, "9007199254740993"));
    expect(exactJson(end.record.status)).toBe("9007199254740993");
    expect(end.validation.state).toBe("invalid");
    expect(errors(end)).toBe("/status must be <= 255");
    expect(coded(bundle.defects, "record.invalid").map((d) => d.line)).toEqual([3]);
    expect(coded(bundle.defects, "record.number_undecided")).toEqual([]);
    expect(load.counts).toMatchObject({ validated: 1, invalid: 1, partial: 0 });
    // Schema validity and the run's outcome are separate findings, and both stand.
    expect(bundle.status).toBeNull();
    expect(bundle.terminated).toBe(true);
    expect(bundle.replay.unavailable).toBe(true);
    expect(bundle.replay.reasons).toContain("end.status_nonzero");
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "everything", window: WINDOW }, { cwd: dir, env }));
    expect(answer.ranking.outcomes[run]).toBe("failed");
  });

  test("an unrelated integer beyond the range never erases an ordinary failure beside it", () => {
    const line = (run: string, path: string, body: string) => `{"event":"end","t":${T0 + 3},"seq":3,"run":"${run}",${body}"redacted":false,${SIDE},"_schema":{"id":"parley.end","version":"1.0.0"}}`.replace("PATH", JSON.stringify(path));
    // An ordinary status over the maximum.
    expect(errors(ended((r, p) => line(r, p, `"status":256,"receipt":PATH,`)).end)).toBe("/status must be <= 255");
    // A missing required member.
    expect(errors(ended((r, p) => line(r, p, `"status":0,`)).end)).toBe("/ must have required property 'receipt'");
    // A wrong type.
    expect(errors(ended((r, p) => line(r, p, `"status":"0","receipt":PATH,`)).end)).toBe("/status must be integer");
    // The status the schema forbids by `not`.
    expect(ended((r, p) => line(r, p, `"status":3,"receipt":PATH,`)).end.validation.state).toBe("invalid");
    // Two failures at once are both reported.
    expect(errors(ended((r, p) => line(r, p, `"status":256,`)).end)).toBe("/ must have required property 'receipt'; /status must be <= 255");
    // And with nothing wrong beside it, the record is validated: every constraint that applies was decided.
    const sound = ended((r, p) => line(r, p, `"status":0,"receipt":PATH,`));
    expect(sound.end.validation).toEqual({ state: "validated", schema: { id: "parley.end", version: "1.0.0" } });
    expect(exactJson(sound.end.record.note)).toBe(`{"id":9007199254740993}`);
    expect(sound.bundle.defects).toEqual([]);
  });

  test("a head whose t is beyond the range: the schema's two constraints on t are decided, so the record is validated, and the reader still cannot date it", () => {
    const { dir, receipts, env } = scratch();
    const run = runId(1);
    const path = join(receipts, `${run}.jsonl`);
    writeLines(receipts, run, [headLine(run, "9007199254740993" as unknown as number), resultLine(run, T0 + 2, "1"), endLine(run, T0 + 3, path)]);
    const bundle = only(dir, env);
    const head = bundle.records.find((r) => r.event === "receipt.head")!;
    expect(exactJson(head.record.t)).toBe("9007199254740993");
    // parley.receipt.head says of t: an integer, at least 0. Both are decided exactly for this value.
    expect(head.validation.state).toBe("validated");
    // What validation does not conclude: that the reader can use it. It cannot place the record in time.
    expect(head.t).toBeNull();
    expect(bundle.defects).toEqual([]);
    // A negative one is under the minimum, exactly.
    const below = scratch();
    writeLines(below.receipts, run, [headLine(run, "-9007199254740993" as unknown as number)]);
    const negative = only(below.dir, below.env).records[0]!;
    expect(negative.validation.state === "invalid" ? negative.validation.errors : []).toEqual(["/t must be >= 0"]);
  });

  /** The state of one record whose `value` is the given text, under a caller's schema for `value`. */
  function state(valueText: string, value: unknown): string {
    const check = validator([{ id: "parley.test.big", version: "1.0.0", schema: { type: "object", required: ["value"], properties: { value } } }]);
    const { receipts } = scratch();
    const run = runId(1);
    const path = writeLines(receipts, run, [`{"event":"result","t":${T0},"seq":2,"run":"${run}","value":${valueText},"_schema":{"id":"parley.test.big","version":"1.0.0"}}`]);
    const read = readReceiptFile(path, { validate: check });
    const record = read.bundles[0]!.records[0]!;
    const defects = read.bundles[0]!.defects.map((d) => d.code).join(",");
    const v = record.validation;
    if (v.state === "partial") { expect(defects).toBe("record.number_undecided"); return `partial:${String(v.why)}`; }
    if (v.state === "invalid") { expect(defects).toBe("record.invalid"); return `invalid: ${v.errors.join("; ")}`; }
    expect(defects).toBe("");
    return v.state;
  }
  const BIG = "9007199254740993", EVEN = "9007199254740992";

  test("the numeric keywords are decided with the integer's exact value", () => {
    expect(state(BIG, { type: "integer", minimum: 0 })).toBe("validated");
    expect(state(BIG, { type: "number", exclusiveMinimum: 1 })).toBe("validated");
    expect(state("1e400", { type: "integer", minimum: 0 })).toBe("validated");
    expect(state(BIG, { type: "integer", maximum: 255 })).toBe("invalid: /value must be <= 255");
    expect(state(`-${BIG}`, { type: "integer", minimum: 0 })).toBe("invalid: /value must be >= 0");
    expect(state(BIG, { exclusiveMaximum: 10 })).toBe("invalid: /value must be < 10");
    expect(state(BIG, { type: "string" })).toBe("invalid: /value must be string");
    expect(state(BIG, { type: ["string", "null"] })).toBe("invalid: /value must be string,null");
    expect(state(BIG, { type: ["string", "integer"] })).toBe("validated");
    expect(state(BIG, { const: 7 })).toBe("invalid: /value must be equal to constant");
    expect(state(BIG, { enum: [1, BIG] })).toBe("invalid: /value must be equal to one of the allowed values");
    expect(state(BIG, { multipleOf: 2 })).toBe("invalid: /value must be multiple of 2");
    expect(state(EVEN, { multipleOf: 2 })).toBe("validated");
    // Keywords for other kinds of value do not apply to a number, and say nothing against it.
    expect(state(BIG, { minLength: 3, pattern: "^x", minItems: 2, required: ["a"] })).toBe("validated");
  });

  test("structure around the integer is decided as it always was: members, items and counts", () => {
    const nested = { type: "object", required: ["id", "name"], additionalProperties: false, properties: { id: { type: "integer" }, name: { type: "string", minLength: 1 }, tags: { type: "array", minItems: 1, maxItems: 2, items: { type: "integer", minimum: 0 } } } };
    expect(state(`{"id":${BIG},"name":"a"}`, nested)).toBe("validated");
    expect(state(`{"id":${BIG},"name":"a","tags":[1,${BIG}]}`, nested)).toBe("validated");
    expect(state(`{"id":${BIG}}`, nested)).toBe("invalid: /value must have required property 'name'");
    expect(state(`{"id":${BIG},"name":""}`, nested)).toBe("invalid: /value/name must NOT have fewer than 1 characters");
    expect(state(`{"id":${BIG},"name":"a","more":1}`, nested)).toBe("invalid: /value must NOT have additional properties");
    expect(state(`{"id":${BIG},"name":"a","tags":[]}`, nested)).toBe("invalid: /value/tags must NOT have fewer than 1 items");
    expect(state(`{"id":1,"name":"a","tags":[1,-${BIG}]}`, nested)).toBe("invalid: /value/tags/1 must be >= 0");
    expect(state(`{"id":1,"name":"a","tags":[${BIG},${BIG},${BIG}]}`, nested)).toBe("invalid: /value/tags must NOT have more than 2 items");
    expect(state(`[${EVEN},${BIG}]`, { type: "array", uniqueItems: true })).toBe("validated");
    expect(state(`[${BIG},${BIG}.0]`, { type: "array", uniqueItems: true })).toBe("invalid: /value must NOT have duplicate items");
    expect(state(`{"a":${BIG}}`, { minProperties: 2 })).toBe("invalid: /value must NOT have fewer than 2 properties");
  });

  test("the combining keywords are sound: a failing branch proves nothing by itself", () => {
    const undecided = { format: "int64" }; // a keyword the reader does not decide for such an integer
    // anyOf: invalid only when every branch is; one failing branch beside an undecided one decides nothing.
    expect(state(BIG, { anyOf: [{ type: "string" }, { maximum: 255 }] })).toBe("invalid: /value must match a schema in anyOf");
    expect(state(BIG, { anyOf: [{ type: "string" }, { minimum: 0 }] })).toBe("validated");
    expect(state(BIG, { anyOf: [{ type: "string" }, undecided] })).toBe("partial:number_undecided");
    // not: a failure under it is the keyword succeeding, and an undecided schema under it stays undecided.
    expect(state(BIG, { not: { maximum: 255 } })).toBe("validated");
    expect(state(BIG, { not: { minimum: 0 } })).toBe("invalid: /value must NOT be valid");
    expect(state(BIG, { not: undecided })).toBe("partial:number_undecided");
    // oneOf: exactly one.
    expect(state(BIG, { oneOf: [{ minimum: 0 }, { type: "string" }] })).toBe("validated");
    expect(state(BIG, { oneOf: [{ minimum: 0 }, { type: "integer" }] })).toBe("invalid: /value must match exactly one schema in oneOf");
    expect(state(BIG, { oneOf: [{ minimum: 0 }, undecided] })).toBe("partial:number_undecided");
    // if: the branch taken is the one the condition's exact verdict selects.
    expect(state(BIG, { if: { minimum: 0 }, then: { maximum: 255 }, else: { type: "string" } })).toBe("invalid: /value must be <= 255");
    expect(state(BIG, { if: { maximum: 255 }, then: { type: "string" }, else: { type: "integer" } })).toBe("validated");
    expect(state(BIG, { if: undecided, then: { type: "string" }, else: { type: "integer" } })).toBe("partial:number_undecided");
    expect(state(BIG, { if: undecided, then: { type: "string" }, else: { type: "null" } })).toBe("invalid: /value fails both \"then\" and \"else\"");
    // allOf is every schema: one conclusive failure is enough, whatever else is undecided.
    expect(state(BIG, { allOf: [undecided, { maximum: 255 }] })).toBe("invalid: /value must be <= 255");
  });

  test("what cannot be decided stays partial, and never hides a failure that can", () => {
    for (const value of [
      { type: "integer", format: "int64" },
      { multipleOf: 0.5 },
      { const: 9007199254740992 },           // a schema constant that is itself beyond the range
      { enum: [1, 9007199254740992] },
      { maximum: 9007199254740992 },
      { $ref: "#/properties/value/$defs/x", $defs: { x: { type: "integer" } } },
      { type: "integer", "x-unknown-keyword": true },
      { type: "array", contains: { type: "integer" }, minContains: 2 },
    ]) {
      expect(state("contains" in value ? `[${BIG}]` : BIG, value)).toBe("partial:number_undecided");
    }
    // A reference is written against the whole schema, so a part that holds one is not decided
    // alone, even for a member that holds no such integer.
    expect(state(`{"id":${BIG},"name":7}`, { type: "object", properties: { name: { $ref: "#/properties/value/properties/id" }, id: { type: "integer" } } })).toBe("partial:number_undecided");
    // The same undecided keyword beside a conclusive failure: the failure stands.
    expect(state(BIG, { type: "string", format: "int64" })).toBe("invalid: /value must be string");
    expect(state(`{"id":${BIG}}`, { type: "object", required: ["name"], properties: { id: { format: "int64" } } })).toBe("invalid: /value must have required property 'name'");
  });

  test("a record that holds no such integer goes to the schema validator, as before", () => {
    expect(state("255", { type: "integer", minimum: 0, maximum: 255 })).toBe("validated");
    expect(state("256", { type: "integer", minimum: 0, maximum: 255 })).toBe("invalid: /value must be <= 255");
    expect(state("9007199254740991", { type: "integer" })).toBe("validated");
    expect(state("5.0", { type: "integer" })).toBe("validated");
    expect(state(`"${BIG}"`, { type: "integer" })).toBe("invalid: /value must be integer");
    expect(state("4", { type: "integer", format: "int64", multipleOf: 2 })).toBe("validated");
  });
});

// ---- RD-122 a number the reader cannot hold at all ------------------------------------------

describe("RD-122 a number the reader cannot hold exactly is held back whole and said so", () => {
  const INEXACT = ["0.1000000000000000055", "0.10000000000000001", "1e-400", "-0.30000000000000004999", `1e5000`, `{"deep":[0.1,{"x":1.00000000000000000001}]}`];

  test("the line is kept verbatim under its own code, attributed, and is not a record", () => {
    for (const text of INEXACT) {
      const { dir, receipts, env } = scratch();
      const run = runId(1);
      const path = join(receipts, `${run}.jsonl`);
      const raw = resultLine(run, T0 + 2, text);
      writeLines(receipts, run, [headLine(run, T0), raw, endLine(run, T0 + 3, path)]);
      const load = loadReceipts({ cwd: dir, env });
      const bundle = load.bundles[0]!;
      expect(bundle.records.map((r) => r.seq)).toEqual([1, 3]);
      const held = coded(bundle.defects, "line.number_unrepresentable");
      expect(held.length).toBe(1);
      expect(held[0]!.raw).toBe(raw);
      expect(held[0]!.run).toBe(run);
      expect(held[0]!.seq).toBe(2);
      expect(held[0]!.line).toBe(2);
      expect(bundle.quarantined).toEqual(held);
      expect(load.counts.quarantined).toBe(1);
      expect(bundle.records.some((r) => r.event === "result")).toBe(false);
    }
  });

  test("a held-back line names its own run, even in a file that holds two runs", () => {
    const { dir, receipts, env } = scratch();
    const a = runId(1), b = runId(2);
    const path = join(receipts, `${a}.jsonl`);
    writeLines(receipts, a, [headLine(a, T0), headLine(b, T0), resultLine(b, T0 + 2, "0.1000000000000000055"), endLine(a, T0 + 3, path), endLine(b, T0 + 3, path)]);
    const load = loadReceipts({ cwd: dir, env });
    const of = (run: string) => coded(load.bundles.find((x) => x.run === run)!.defects, "line.number_unrepresentable").length;
    expect(of(a)).toBe(0);
    expect(of(b)).toBe(1);
  });

  test("its run never folds, the answer counts it, and the read warns", async () => {
    for (const [x, y] of [["0.1000000000000000055", "0.1000000000000000054"], ["0.1000000000000000055", "0.1000000000000000055"], ["0.1000000000000000055", "0.1"]] as const) {
      const r = await ask(x, y);
      expect(r.sections).toBe(2);
      expect(r.folded).toBe(0);
      const heldBack = y === "0.1" ? 1 : 2;
      expect(r.answer.counts.unrepresentable).toBe(heldBack);
      expect(r.a).toBeUndefined();
      if (y === "0.1") expect(exactJson(r.b)).toBe("0.1");
      expect(r.answer.status).toBe(0);
      // The read's own receipt holds one warning saying so, and its lens still validates.
      const own = loadReceipts({ cwd: r.dir, env: r.env }).bundles.find((b) => b.run === r.answer.run)!;
      const warnings = own.records.filter((rec) => rec.event === "warning");
      expect(warnings.length).toBe(1);
      expect(warnings[0]!.record.code).toBe("read.number_unrepresentable");
      expect(warnings[0]!.validation.state).toBe("validated");
      expect(String(warnings[0]!.record.problem)).toContain(`${heldBack} line`);
      expect(own.records.find((rec) => rec.event === "lens")!.validation.state).toBe("validated");
    }
  });

  test("a read over receipts that hold no such number warns of nothing and counts none", async () => {
    const r = await ask("1", "9007199254740993");
    expect(r.answer.counts.unrepresentable).toBe(0);
    const own = loadReceipts({ cwd: r.dir, env: r.env }).bundles.find((b) => b.run === r.answer.run)!;
    expect(own.records.filter((rec) => rec.event === "warning")).toEqual([]);
  });

  test("foldRuns and digestFor fold nothing into or out of a run they are told holds such a line", () => {
    const rec = (run: string, seq: number, event: string, t: number, over: Record<string, unknown> = {}): LoadedRecord => ({
      run, seq, event, t, file: "f", line: seq, copies: 1, fromSidecar: false, projected: false, projectedBy: [],
      record: { event, t, seq, run, ...over }, validation: { state: "unvalidated", schema: null, why: "no_schema_ref" },
    });
    const runs = [1, 2, 3].map(runId);
    const ranked = runs.flatMap((run, i) => [
      rec(run, 1, "receipt.head", T0 + i, { inv: "inv_same", resolved: {} }), rec(run, 2, "result", T0 + i, { value: 1 }), rec(run, 3, "end", T0 + i, { status: 0, redacted: false }),
    ]);
    const outcomes = Object.fromEntries(runs.map((r) => [r, "succeeded" as const]));
    expect(foldRuns(ranked, outcomes, "everything").folds.get(runs[2]!)!.others).toBe(2);
    const fold = foldRuns(ranked, outcomes, "everything", new Set([runs[2]!]));
    expect([...fold.folds.keys()]).toEqual([runs[1]!]);
    expect(fold.folds.get(runs[1]!)!.stands_for).toEqual([runs[0]!]);
    const plan = planQuery({ asker: { tool: "t" }, view: "everything", window: WINDOW, budget: { records: 100 } });
    if (plan.refused) throw new Error("refused");
    const digested = digestFor(plan.query, { run: runId(9), seq: 1 }, ranked, { run: runId(9), seq: 9, t: T0 }, outcomes, new Set(runs));
    expect(digested.digest.runs.length).toBe(3);
    expect(digested.folded).toBe(0);
  });

  test("opening the held-back line's id says why it does not open, and does not throw", async () => {
    const { dir, receipts, env } = scratch();
    receipt(receipts, 1, "0.1000000000000000055");
    const opened = await openRecords({ asker: { tool: "t" }, view: "everything", window: WINDOW, records: [{ run: runId(1), seq: 2 }, { run: runId(1), seq: 7 }] }, { cwd: dir, env }) as OpenAnswer;
    expect(opened.opened.map((o) => o.outcome)).toEqual(["seq_not_found", "seq_not_found"]);
    expect(opened.opened[0]!.problem).toContain("cannot represent");
    expect(opened.opened[0]!.record).toBeUndefined();
    expect(opened.opened[1]!.problem).not.toContain("cannot represent");
  });

  test("a sidecar whose contents hold such a number is not restored, and the bundle says so", async () => {
    const { dir, receipts, env } = scratch();
    const run = runId(1);
    const stored = resultLine(run, T0 + 2, "0.1000000000000000055");
    mkdirSync(join(receipts, run), { recursive: true });
    writeFileSync(join(receipts, run, "2.json"), stored);
    const path = join(receipts, `${run}.jsonl`);
    writeLines(receipts, run, [
      headLine(run, T0),
      `{"event":"sidecar","t":${T0 + 2},"seq":3,"run":"${run}","source":2,"path":"${run}/2.json","bytes":${Buffer.byteLength(stored)},"sha256":"${sha(stored)}","_schema":{"id":"parley.sidecar","version":"1.0.0"}}`,
      endLine(run, T0 + 3, path, 4),
    ]);
    const bundle = only(dir, env);
    expect(bundle.records.map((r) => r.seq)).toEqual([1, 3, 4]);
    expect(bundle.sidecars[0]!.state).toBe("number_unrepresentable");
    expect(bundle.sidecars[0]!.actual).toEqual({ bytes: Buffer.byteLength(stored), sha256: sha(stored) });
    const defects = coded(bundle.defects, "sidecar.number_unrepresentable");
    expect(defects.length).toBe(1);
    expect(defects[0]!.source).toBe(2);
    expect(bundle.replay).toEqual({ unavailable: true, reasons: ["sidecar.number_unrepresentable"] });
    const opened = await openRecords({ asker: { tool: "t" }, view: "everything", window: WINDOW, records: [{ run, seq: 2 }] }, { cwd: dir, env }) as OpenAnswer;
    expect(opened.opened[0]!.outcome).toBe("sidecar_unavailable");
    expect(opened.opened[0]!.problem).toContain("cannot represent");
    expect(opened.opened[0]!.remedy).not.toContain("restore the bundle");
  });

  test("a seq no double holds does not place the line at another seq: the line is held back", () => {
    const { dir, receipts, env } = scratch();
    const run = runId(1);
    const path = join(receipts, `${run}.jsonl`);
    const raw = resultLine(run, T0 + 2, "1", "9007199254740993");
    const edge = resultLine(run, T0 + 2, "1", "9007199254740992");
    const last = resultLine(run, T0 + 2, "1", "9007199254740991");
    writeLines(receipts, run, [headLine(run, T0), raw, endLine(run, T0 + 3, path), edge, last]);
    const bundle = only(dir, env);
    // The largest seq the reader places is the largest safe integer; one more is rejected, not rounded.
    expect(bundle.records.map((r) => r.seq)).toEqual([1, 3, 9007199254740991]);
    const held = coded(bundle.defects, "line.number_unrepresentable");
    expect(held.map((d) => d.raw)).toEqual([raw, edge]);
    expect(held[0]!.run).toBe(run);
    expect(held[0]!.seq).toBeUndefined();
    expect(held[0]!.problem).toContain("seq");
  });

  test("a t no double holds stays exact in the record, and the record is undated", async () => {
    const { dir, receipts, env } = scratch();
    const run = runId(1);
    const path = join(receipts, `${run}.jsonl`);
    writeLines(receipts, run, [headLine(run, T0), resultLine(run, "9007199254740993" as unknown as number, "1"), endLine(run, T0 + 3, path)]);
    const bundle = only(dir, env);
    const result = bundle.records.find((r) => r.seq === 2)!;
    expect(result.record.t).toBe(9007199254740993n);
    expect(result.t).toBeNull();
    expect(bundle.defects).toEqual([]);
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "everything", window: WINDOW }, { cwd: dir, env }));
    expect(answer.counts.undated).toBe(1);
    expect(answer.records.map((r) => r.seq)).toEqual([1, 3]);
  });
});

// ---- RD-123 nothing the reader writes or measures throws on, or rounds, such an integer ------

describe("RD-123 no emitting or measuring path throws on such an integer, and none rounds it", () => {
  test("exactJson writes the integer's digits as a JSON number, where JSON.stringify throws", async () => {
    const r = await ask("9007199254740991", `{"n":[9007199254740993,-9007199254740993,1e400],"s":"9007199254740993"}`);
    const record = r.answer.records.find((x) => x.run === runId(2) && x.event === "result")!;
    expect(() => JSON.stringify(record)).toThrow(TypeError);
    const text = exactJson(record.record);
    expect(text).toContain(`"value":{"n":[9007199254740993,-9007199254740993,1${"0".repeat(400)}],"s":"9007199254740993"}`);
    // For a value that holds no such integer it is JSON.stringify, byte for byte.
    const ordinary = r.answer.records.find((x) => x.run === runId(1) && x.event === "result")!;
    expect(exactJson(ordinary)).toBe(JSON.stringify(ordinary));
    for (const v of [null, 1.5, -0, "x", [undefined, () => 1, 1], { a: undefined, b: [1n, { c: 2n }], d: Number.NaN }]) {
      const expected = JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? `@@${x}@@` : x)).replace(/"@@(-?\d+)@@"/g, "$1");
      expect(exactJson(v)).toBe(expected);
    }
  });

  /** The `parley.lens` line a read wrote, as text, from the read's own receipt. */
  const lensLine = (answer: QueryAnswer) => readFileSync(answer.receipt, "utf8").split("\n").find((l) => l.includes(`"event":"lens"`))!;

  test("a head whose resolved holds such an integer: the lens line that was written carries it, digit for digit", async () => {
    const { dir, receipts, env } = scratch();
    receipt(receipts, 1, "1", `{"command":"count","limit":9007199254740993}`);
    receipt(receipts, 2, "1", `{"command":"count","limit":9007199254740992}`);
    receipt(receipts, 3, "1", `{"command":"count","limit":9007199254740993}`);
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "everything", window: WINDOW, budget: { records: 1000, bytes: 100_000 } }, { cwd: dir, env }));
    // Runs 1 and 3 share every value and fold; run 2 differs only in that integer and does not.
    expect(answer.digest.runs.map((s) => s.run)).toEqual([runId(2), runId(3)]);
    expect(answer.digest.runs.map((s) => s.dropped)).toEqual([undefined, undefined]);
    expect(answer.digest.runs[1]!.folded).toEqual({ others: 1, records: 3, stands_for: [runId(1)] });
    // The text that went out, not an object in memory.
    const written = lensLine(answer);
    expect(written).toContain(`{"run":"${runId(2)}","tool":"t","v":"0.0.1","argv":["t","count"],"resolved":{"command":"count","limit":9007199254740992},"inv":"inv_same","outcome":"succeeded"}`);
    expect(written).toContain(`{"run":"${runId(3)}","tool":"t","v":"0.0.1","argv":["t","count"],"resolved":{"command":"count","limit":9007199254740993},"inv":"inv_same","outcome":"succeeded","folded":`);
    expect(written).not.toContain(`"dropped"`);
    // The same line reached the read's stdout.
    expect(exactJson(answer.lines.find((l) => l.event === "lens"))).toBe(written);
    // The bytes the answer states, and the bytes the bound was measured with, are the bytes written.
    expect(answer.digestBytes).toBe(Buffer.byteLength(written + "\n", "utf8"));
    const env0 = /^\{"event":"lens","t":(\d+),"seq":(\d+),"run":"([^"]+)"/.exec(written)!;
    const envelope = { t: Number(env0[1]), seq: Number(env0[2]), run: env0[3]! };
    expect(digestLine(answer.digest, envelope)).toBe(written + "\n");
    expect(digestBytes(answer.digest, envelope)).toBe(answer.digestBytes);
  });

  test("the byte budget is right for a section holding such an integer: the exact size holds every record and one byte less does not", async () => {
    const { dir, receipts, env } = scratch();
    receipt(receipts, 1, "1", `{"command":"count","limit":18446744073709551615,"ids":[9007199254740993,-9007199254740993]}`);
    const ask1 = (bytes: number) => queryReceipts({ asker: { tool: "t" }, view: "everything", window: { from: 0, to: T0 - DAY }, budget: { records: 1000, bytes } }, { cwd: dir, env });
    const roomy = answered(await ask1(100_000));
    expect(roomy.counts).toMatchObject({ answered: 3, excluded: 0 });
    const written = lensLine(roomy);
    expect(written).toContain(`"resolved":{"command":"count","limit":18446744073709551615,"ids":[9007199254740993,-9007199254740993]}`);
    // Every bound around the line's own size: the line written is never over its bound, and the
    // smallest bound that names all three records is the line's size plus the one byte the read
    // keeps in hand for its own seq gaining a digit (`query.ts`). A size measured on a rounded or
    // differently serialised section would miss that by the integer's digits.
    const natural = Buffer.byteLength(written + "\n", "utf8");
    let smallest: { bound: number; line: number } | undefined;
    for (let bound = natural - 12; bound <= natural + 2; bound++) {
      const answer = answered(await ask1(bound));
      const line = Buffer.byteLength(lensLine(answer) + "\n", "utf8");
      expect(line).toBeLessThanOrEqual(bound);
      expect(line).toBe(answer.digestBytes);
      if (answer.counts.answered === 3 && smallest === undefined) smallest = { bound, line };
      if (answer.counts.answered === 3) expect(lensLine(answer)).toContain(`"limit":18446744073709551615,"ids":[9007199254740993,-9007199254740993]`);
    }
    expect(smallest).toBeDefined();
    expect(smallest!.bound - smallest!.line).toBe(1);
  });

  test("a section is measured by the text written: a resolved holding such an integer is kept at the bound and dropped one byte past it, for size", () => {
    const head = (pad: number): LoadedRecord => ({
      run: runId(1), seq: 1, event: "receipt.head", t: T0, file: "f", line: 1, copies: 1, fromSidecar: false, projected: false, projectedBy: [],
      record: { event: "receipt.head", tool: "t", v: "1", argv: ["t"], inv: "i", resolved: { deep: [{ limit: 9007199254740993n }], pad: "x".repeat(pad) } },
      validation: { state: "unvalidated", schema: null, why: "no_schema_ref" },
    });
    const base = Buffer.byteLength(exactJson(runSection(runId(1), [head(0)])), "utf8");
    const fits = runSection(runId(1), [head(RUN_SECTION_BYTES - base)]);
    expect(Buffer.byteLength(exactJson(fits), "utf8")).toBe(RUN_SECTION_BYTES);
    expect(fits.dropped).toBeUndefined();
    expect(exactJson(fits)).toContain(`"resolved":{"deep":[{"limit":9007199254740993}],"pad":"x`);
    const over = runSection(runId(1), [head(RUN_SECTION_BYTES - base + 1)]);
    expect(exactJson(over)).toBe(`{"run":"${runId(1)}","tool":"t","v":"1","argv":["t"],"inv":"i","dropped":["resolved"]}`);
  });

  test("an oversized resolved holding such an integer is left out for size and named, in the line that was written", async () => {
    const { dir, receipts, env } = scratch();
    receipt(receipts, 1, "1", `{"command":"count","limit":9007199254740993,"pad":"${"x".repeat(10_000)}"}`);
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "everything", window: WINDOW }, { cwd: dir, env }));
    const written = lensLine(answer);
    expect(written).toContain(`{"run":"${runId(1)}","tool":"t","v":"0.0.1","argv":["t","count"],"inv":"inv_same","outcome":"succeeded","dropped":["resolved"]}`);
    expect(written).not.toContain("9007199254740993");
    // The head it was read off still holds it, exactly.
    const head = answer.records.find((x) => x.event === "receipt.head")!;
    expect(exactJson((head.record.resolved as { limit: unknown }).limit)).toBe("9007199254740993");
  });

  test("the lens line that holds such an integer is validated against parley.lens 1.1.0, by exact evaluation", async () => {
    const { dir, receipts, env } = scratch();
    receipt(receipts, 1, "1", `{"command":"count","limit":9007199254740993}`);
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "everything", window: WINDOW }, { cwd: dir, env }));
    const own = loadReceipts({ cwd: dir, env }).bundles.find((b) => b.run === answer.run)!;
    const lens = own.records.find((x) => x.event === "lens")!;
    // The loaded lens holds the integer as a bigint, so this verdict is the exact evaluator's:
    // parley.lens says of runs[].resolved only that it is an object, and that was decided.
    expect(exactJson((lens.record.runs as { resolved: unknown }[])[0]!.resolved)).toBe(`{"command":"count","limit":9007199254740993}`);
    expect(lens.validation).toEqual({ state: "validated", schema: { id: "parley.lens", version: "1.1.0" } });
    expect(own.defects).toEqual([]);
    // The same line with a section the schema refuses is still refused, integer or not.
    const line = lensLine(answer);
    const broken = scratch();
    writeLines(broken.receipts, answer.run, [line.replace(`"outcome":"succeeded"`, `"outcome":"perhaps"`)]);
    const refused = only(broken.dir, broken.env).records[0]!;
    expect(refused.validation.state).toBe("invalid");
  });

  test("the drill-down opens the record exactly, and sizes it by its exact text", async () => {
    const r = await ask("9007199254740993", "-9007199254740993");
    const ids = [{ run: runId(1), seq: 2 }, { run: runId(2), seq: 2 }];
    const loaded = loadReceipts({ cwd: r.dir, env: r.env }).bundles.find((b) => b.run === runId(1))!.records.find((x) => x.seq === 2)!;
    const size = recordBytes(loaded);
    expect(size).toBe(Buffer.byteLength(exactJson(loaded), "utf8"));
    expect(exactJson(loaded)).toContain(`"value":9007199254740993,`);
    const opened = await openRecords({ asker: { tool: "t" }, view: "everything", window: WINDOW, records: ids, budget: { bytes: size } }, { cwd: r.dir, env: r.env }) as OpenAnswer;
    expect(opened.opened.map((o) => o.outcome)).toEqual(["opened", "over_budget"]);
    expect(opened.opened[0]!.record!.record.value).toBe(9007199254740993n);
    // The second record's text is one byte longer, for its sign.
    expect(opened.opened[1]!.bytes).toBe(size + 1);
    const all = await openRecords({ asker: { tool: "t" }, view: "everything", window: WINDOW, records: ids }, { cwd: r.dir, env: r.env }) as OpenAnswer;
    expect(all.opened.map((o) => o.record!.record.value)).toEqual([9007199254740993n, -9007199254740993n]);
    expect(all.status).toBe(0);
  });

  test("a large receipt of ordinary lines loads in bounded time with the scan in place", () => {
    const { dir, receipts, env } = scratch();
    const run = runId(1);
    const path = join(receipts, `${run}.jsonl`);
    const lines = [headLine(run, T0)];
    for (let i = 0; i < 20_000; i++) lines.push(resultLine(run, T0 + i, `{"i":${i},"ratio":0.${String(i).padStart(5, "0")}1,"sha":"${"9e".repeat(32)}","big":9007199254740991}`, i + 2));
    lines.push(endLine(run, T0 + 30_000, path, 20_002));
    writeLines(receipts, run, lines);
    const started = Date.now();
    const load = loadReceipts({ cwd: dir, env });
    expect(load.counts.records).toBe(20_002);
    expect(load.counts.quarantined).toBe(0);
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);
});

// ---- RD-124 the shared numeric corpus, through the reader ------------------------------------

interface CorpusCase { id: string; pins: string; text: string; outcome: "exact" | "unrepresentable"; kinds?: string[]; emit?: string; tokens?: string[] }
// Every value in the corpus is a string or a list of strings, so reading the corpus itself with
// an ordinary parser loses nothing (conformance/numbers/README.md).
const CORPUS: CorpusCase[] = readFileSync(resolve(import.meta.dir, "../../../conformance/numbers/cases.jsonl"), "utf8")
  .split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as CorpusCase);

/** How each number in a loaded value is held, in document order. */
function kindsOf(value: unknown, into: string[] = []): string[] {
  if (typeof value === "number" || typeof value === "bigint") into.push(typeof value);
  else if (Array.isArray(value)) for (const v of value) kindsOf(v, into);
  else if (value !== null && typeof value === "object") for (const v of Object.values(value)) kindsOf(v, into);
  return into;
}

describe("RD-124 the shared numeric corpus through the reader (conformance/numbers)", () => {
  test("the corpus is the one the writers run: 50 cases, 39 exact and 11 unrepresentable", () => {
    expect(CORPUS.length).toBe(50);
    expect(CORPUS.filter((c) => c.outcome === "exact").length).toBe(39);
    expect(CORPUS.filter((c) => c.outcome === "unrepresentable").length).toBe(11);
    expect(new Set(CORPUS.map((c) => c.id)).size).toBe(50);
  });

  for (const c of CORPUS.filter((x) => x.outcome === "exact")) {
    test(`exact: ${c.id} loads from a receipt line and from a sidecar, and is written back as the corpus says`, () => {
      const { dir, receipts, env } = scratch();
      const run = runId(1);
      const path = join(receipts, `${run}.jsonl`);
      const stored = resultLine(run, T0 + 2, c.text, 3);
      mkdirSync(join(receipts, run), { recursive: true });
      writeFileSync(join(receipts, run, "3.json"), stored);
      writeLines(receipts, run, [
        headLine(run, T0), resultLine(run, T0 + 2, c.text),
        `{"event":"sidecar","t":${T0 + 2},"seq":4,"run":"${run}","source":3,"path":"${run}/3.json","bytes":${Buffer.byteLength(stored)},"sha256":"${sha(stored)}","_schema":{"id":"parley.sidecar","version":"1.0.0"}}`,
        endLine(run, T0 + 3, path, 5),
      ]);
      const bundle = only(dir, env);
      expect(bundle.defects).toEqual([]);
      for (const seq of [2, 3]) {
        const value = bundle.records.find((r) => r.seq === seq)!.record.value;
        expect(exactJson(value)).toBe(c.emit!);
        expect(kindsOf(value)).toEqual(c.kinds!);
      }
      expect(bundle.records.find((r) => r.seq === 3)!.fromSidecar).toBe(true);
    });
  }

  for (const c of CORPUS.filter((x) => x.outcome === "unrepresentable")) {
    test(`unrepresentable: ${c.id} is held back verbatim, warned of, and its run never folds`, async () => {
      // Two runs of one invocation whose only result is this text: identical, so they would fold.
      const { dir, receipts, env } = scratch();
      receipt(receipts, 1, c.text);
      receipt(receipts, 2, c.text);
      const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "everything", window: WINDOW, budget: { records: 1000 } }, { cwd: dir, env }));
      expect(answer.digest.runs.length).toBe(2);
      expect(answer.digest.runs.some((s) => s.folded !== undefined)).toBe(false);
      expect(answer.digest.loss.folded).toBe(0);
      expect(answer.records.some((r) => r.event === "result")).toBe(false);
      expect(answer.counts.unrepresentable).toBe(2);
      const held = coded(answer.load.quarantined, "line.number_unrepresentable");
      expect(held.map((d) => d.raw)).toEqual([1, 2].map((n) => resultLine(runId(n), T0 - (10 - n) * DAY + 2, c.text)));
      expect(held.map((d) => d.run)).toEqual([runId(1), runId(2)]);
      // The numbers that could not be held are the corpus's, in order.
      const parsed = parseExact(c.text);
      expect(parsed.ok ? [] : parsed.tokens).toEqual(c.tokens!);
      const own = loadReceipts({ cwd: dir, env }).bundles.find((b) => b.run === answer.run)!;
      expect(own.records.filter((r) => r.event === "warning").map((r) => r.record.code)).toEqual(["read.number_unrepresentable"]);
      // And a sidecar holding the same text is not restored.
      const side = scratch();
      const run = runId(1);
      const stored = resultLine(run, T0 + 2, c.text);
      mkdirSync(join(side.receipts, run), { recursive: true });
      writeFileSync(join(side.receipts, run, "2.json"), stored);
      writeLines(side.receipts, run, [
        headLine(run, T0),
        `{"event":"sidecar","t":${T0 + 2},"seq":3,"run":"${run}","source":2,"path":"${run}/2.json","bytes":${Buffer.byteLength(stored)},"sha256":"${sha(stored)}","_schema":{"id":"parley.sidecar","version":"1.0.0"}}`,
        endLine(run, T0 + 3, join(side.receipts, `${run}.jsonl`), 4),
      ]);
      const bundle = only(side.dir, side.env);
      expect(bundle.sidecars[0]!.state).toBe("number_unrepresentable");
      expect(bundle.records.map((r) => r.seq)).toEqual([1, 3, 4]);
    });
  }
});

// ---- RD-125 a real writer's integers, through real processes, to the reader's own lines -------

describe("RD-125 a tool's integers beyond the safe range survive the writer, the receipt and the reader", () => {
  const TOOL = resolve(import.meta.dir, "fixtures/big-tool.ts");
  function emit(dir: string, state: string, id: string, extra: string[] = []) {
    const spawned = Bun.spawnSync({
      cmd: [process.execPath, "run", TOOL, "ids", ...extra], cwd: dir,
      env: { ...process.env, XDG_STATE_HOME: state, BIG_ID: id }, stdout: "pipe", stderr: "pipe",
    });
    const out = new TextDecoder().decode(spawned.stdout);
    const run = /"run":"([^"]+)"/.exec(out)![1]!;
    return { status: spawned.exitCode, run, out, receipt: readFileSync(join(dir, ".parley", "receipts", `${run}.jsonl`), "utf8") };
  }

  test("two runs with adjacent ids do not fold, two with one id do, and every line the reader writes holds the exact digits", async () => {
    const { dir, env } = scratch();
    const state = env.XDG_STATE_HOME!;
    const a = emit(dir, state, "9007199254740992");
    const b = emit(dir, state, "9007199254740993");
    const c = emit(dir, state, "9007199254740993");
    expect([a.status, b.status, c.status]).toEqual([0, 0, 0]);
    // What the writer put on disk, as text.
    expect(a.receipt).toContain(`"id":9007199254740992,"next":9007199254740993,"ids":[9007199254740992,18446744073709551615]`);
    expect(b.receipt).toContain(`"id":9007199254740993,"next":9007199254740994,"ids":[9007199254740993,18446744073709551615]`);
    expect(b.receipt).toContain(`"resolved":{"command":"ids","limit":18446744073709551615,"floor":-9007199254740993}`);

    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "everything", window: { from: 0, to: Date.now() + DAY }, budget: { records: 1000 } }, { cwd: dir, env }));
    // One invocation (the id is not in `inv`), three runs: the two that share an id fold, the neighbour does not.
    const sections = answer.digest.runs;
    expect(sections.map((s) => s.inv)).toEqual([sections[0]!.inv, sections[0]!.inv]);
    expect(sections.length).toBe(2);
    const alone = sections.find((s) => s.run === a.run)!;
    const folded = sections.find((s) => s.run !== a.run)!;
    expect(alone.folded).toBeUndefined();
    expect([b.run, c.run]).toContain(folded.run);
    expect(folded.folded!.stands_for).toEqual([b.run, c.run].filter((r) => r !== folded.run));
    // The lens line the reader wrote, as text from its own receipt.
    const lens = readFileSync(answer.receipt, "utf8").split("\n").find((l) => l.includes(`"event":"lens"`))!;
    expect(lens).toContain(`"run":"${a.run}","tool":"big","v":"0.1.0","argv":["big","ids"],"resolved":{"command":"ids","limit":18446744073709551615,"floor":-9007199254740993}`);
    expect(lens).toContain(`"run":"${folded.run}","tool":"big","v":"0.1.0","argv":["big","ids"],"resolved":{"command":"ids","limit":18446744073709551615,"floor":-9007199254740993}`);
    expect(lens).not.toContain(`"dropped"`);
    // The records returned, written with the exported serialiser.
    const results = answer.records.filter((r) => r.event === "result");
    expect(results.map((r) => exactJson({ id: r.record.id, next: r.record.next, ids: r.record.ids })).sort()).toEqual([
      `{"id":9007199254740992,"next":9007199254740993,"ids":[9007199254740992,18446744073709551615]}`,
      `{"id":9007199254740993,"next":9007199254740994,"ids":[9007199254740993,18446744073709551615]}`,
    ]);
    // Each returned record is the receipt's own line, read back and written again.
    for (const r of results) expect((r.run === a.run ? a : r.run === b.run ? b : c).receipt).toContain(exactJson(r.record));
    // The drill-down returns the folded run's record exactly too.
    const other = folded.folded!.stands_for[0]!;
    const opened = await openRecords({ asker: { tool: "t" }, view: "everything", window: WINDOW, records: [{ run: other, seq: results[0]!.seq }] }, { cwd: dir, env }) as OpenAnswer;
    expect(exactJson(opened.opened[0]!.record!.record.id)).toBe("9007199254740993");
  });

  test("a bigint that is a declared secret is redacted by the writer, and the integers beside it reach the reader exactly", async () => {
    const { dir, env } = scratch();
    const secret = "9007199254740997";
    const run = emit(dir, env.XDG_STATE_HOME!, "9007199254740993", ["--token", secret]);
    expect(run.status).toBe(0);
    expect(run.receipt).not.toContain(secret);
    expect(run.out).not.toContain(secret);
    const bundle = loadReceipts({ cwd: dir, env }).bundles.find((x) => x.run === run.run)!;
    expect(bundle.redacted).toBe(true);
    const result = bundle.records.find((r) => r.event === "result")!;
    expect(exactJson({ id: result.record.id, next: result.record.next, token: result.record.token })).toBe(`{"id":9007199254740993,"next":9007199254740994,"token":"[redacted]"}`);
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "everything", window: { from: 0, to: Date.now() + DAY }, budget: { records: 1000 } }, { cwd: dir, env }));
    const text = readFileSync(answer.receipt, "utf8");
    expect(text).not.toContain(secret);
    expect(text).toContain(`"resolved":{"command":"ids","limit":18446744073709551615,"floor":-9007199254740993}`);
  });
});

describe("RD-126 the review of the 0.3.0 candidate (case 2026-11-25): what the reader could not compare, it never calls the same", () => {
  test("F-1: with a toJSON on BigInt.prototype in the reading process, adjacent integers still do not fold and the lens states the exact digits", async () => {
    const proto = BigInt.prototype as unknown as { toJSON?: () => unknown };
    for (const hook of [function (this: bigint) { return Number(this); }, function (this: bigint) { return this.toString(); }]) {
      proto.toJSON = hook;
      try {
        const apart = await ask("9007199254740992", "9007199254740993");
        expect(apart.sections).toBe(2);
        expect(apart.folded).toBe(0);
        const typed = await ask(`"9007199254740993"`, "9007199254740993");
        expect(typed.sections).toBe(2);
        expect(typed.folded).toBe(0);
        const { dir, receipts, env } = scratch();
        receipt(receipts, 1, "1", `{"command":"count","limit":18446744073709551615}`);
        const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "everything", window: WINDOW, budget: { records: 1000 } }, { cwd: dir, env }));
        const text = readFileSync(answer.receipt, "utf8").split("\n").find((l) => l.includes(`"event":"lens"`))!;
        expect(text).toContain(`"limit":18446744073709551615`);
        expect(text).not.toContain(`"limit":"18446744073709551615"`);
        expect(text).not.toContain("18446744073709552000");
      } finally { delete proto.toJSON; }
    }
  });

  test("F-5: digestFor and foldRuns, called as 0.2.0 called them, never fold a run the loader held a line back from", () => {
    const { dir, receipts, env } = scratch();
    receipt(receipts, 1, "0.10000000000000001");
    receipt(receipts, 2, "0.7000000000000000001");
    receipt(receipts, 3, "1");
    receipt(receipts, 4, "1");
    const load = loadReceipts({ cwd: dir, env });
    const plan = planQuery({ asker: { tool: "t" }, view: "everything", window: WINDOW, budget: { records: 100 } });
    if (plan.refused) throw new Error("refused");
    const ranking = rankRecords(plan.query, load.bundles.flatMap((b) => b.records));
    // Five arguments: no set of held-back runs is passed. The fact travels on the records.
    const digested = digestFor(plan.query, { run: runId(9), seq: 1 }, ranking.records, { run: runId(9), seq: 9, t: T0 }, ranking.outcomes);
    // The order of sections is the ranking's and is not what this case is about.
    const sections = digested.digest.runs.map((r) => [r.run, r.folded?.stands_for ?? null] as const).sort((a, b) => a[0].localeCompare(b[0]));
    // Runs 3 and 4 hold the same result and fold; runs 1 and 2 each lost their result and stand alone.
    expect(sections).toEqual([[runId(1), null], [runId(2), null], [runId(4), [runId(3)]]]);
    const folding = foldRuns(ranking.records, ranking.outcomes, "everything");
    expect([...folding.folds.keys()]).toEqual([runId(4)]);
    for (const b of load.bundles) for (const r of b.records) expect(r.runHeldBack === true).toBe(b.run === runId(1) || b.run === runId(2));
    // The mark is the loader's and is on no line the read writes.
    expect(JSON.stringify(digested.digest)).not.toContain("runHeldBack");
  });

  test("F-6: a line held back from a receipt rules replay out, as the same record held back in a sidecar does", async () => {
    const { dir, receipts, env } = scratch();
    receipt(receipts, 1, "0.10000000000000001");
    receipt(receipts, 2, "1");
    const { bundles } = loadReceipts({ cwd: dir, env });
    const held = bundles.find((b) => b.run === runId(1))!, whole = bundles.find((b) => b.run === runId(2))!;
    expect(held.replay).toEqual({ unavailable: true, reasons: ["line.number_unrepresentable"] });
    expect(whole.replay).toEqual({ unavailable: false, reasons: [] });
    const opened = await openRecords({ asker: { tool: "t" }, view: "everything", window: WINDOW, records: [{ run: runId(1), seq: 1 }] }, { cwd: dir, env });
    expect(exactJson(opened)).toContain(`"unavailable":true`);
  });

  test("F-9: the defect for a held-back line quotes a long token in part and says its length; the line itself is kept whole", () => {
    const { dir, receipts, env } = scratch();
    const token = "1" + "0".repeat(2_000_000);
    receipt(receipts, 1, token);
    const load = loadReceipts({ cwd: dir, env });
    const d = coded(load.quarantined, "line.number_unrepresentable");
    expect(d.length).toBe(1);
    expect(d[0]!.problem.length).toBeLessThan(1000);
    expect(d[0]!.problem).toContain("2000001 characters");
    expect(d[0]!.raw!.length).toBeGreaterThan(2_000_000);
    expect(d[0]!.raw).toContain(token);
  });
});

