// A read preserves a number's value, or says it cannot (flyingrobots/parley#159; RD-120 to RD-123).
//
// Every fixture here is literal JSON text. The number under test is spliced into a line as
// characters and never passes through a JavaScript number on its way to disk, because a number
// built in JavaScript has already been rounded and would prove nothing about the reader.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  digestFor, exactJson, foldRuns, loadReceipts, openRecords, planQuery, queryReceipts, readReceiptFile, recordBytes, runSection, validator,
  type Bundle, type Defect, type LoadedRecord, type OpenAnswer, type QueryAnswer,
} from "../src/index.ts";
import { UNREPRESENTABLE, parseExact } from "../src/exact.ts";

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
    expect(r.a).toBe(9007199254740992);
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
    expect((nested.a as { n: unknown[] }).n).toEqual([1, 9007199254740992]);

    const apart = await ask("9007199254740993", "9007199254740994");
    expect(apart.sections).toBe(2);
    expect(String(apart.a)).toBe("9007199254740993");
    expect(apart.b).toBe(9007199254740994);
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
    expect(differs.a).toBe(9007199254740992);
    expect(differs.b).toBe(9007199254740993n);

    // An exponent form a double holds exactly stays the number it always was.
    const plain = await ask("9007199254740992", "9.007199254740992e15");
    expect(plain.sections).toBe(1);
    expect(plain.b).toBe(9007199254740992);
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
    expect(bundle.records.find((r) => r.seq === 2)!.record.value).toBe(9007199254740992);

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
    const stored = resultLine(run, T0 + 2, `{"big":9007199254740993,"neg":-9007199254740993,"ok":9007199254740992}`);
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
    expect(restored.record.value).toEqual({ big: 9007199254740993n, neg: -9007199254740993n, ok: 9007199254740992 });
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
    const ordinary = `{"a":0,"b":-0,"c":0.1,"d":1e3,"e":1.5e-7,"f":9007199254740992,"g":-9007199254740991,"h":1e21,"i":123456789012345,"j":0.30000000000000004,"k":1.0,"l":[1,2.5,{"m":-3e2}],"n":"9007199254740993","o":"a \\"quoted\\" 1e400 \\\\","p":true,"q":null,"r":5e-324,"s":1.7976931348623157e308,"t":100000000000000000000000,"__proto__":{"u":1},"dup":1,"dup":2,"v":{},"w":[]}`;
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
    const expected = JSON.parse(ordinary) as Record<string, unknown>;
    const fast = bundle.records.find((r) => r.seq === 2)!.record.value as Record<string, unknown>;
    const [exact, big] = bundle.records.find((r) => r.seq === 3)!.record.value as [Record<string, unknown>, unknown];
    expect(big).toBe(9007199254740993n);
    for (const loaded of [fast, exact]) {
      expect(loaded).toEqual(expected);
      expect(Object.keys(loaded)).toEqual(Object.keys(expected));
      expect(Object.is(loaded.b, -0)).toBe(true);
      expect(JSON.stringify(loaded)).toBe(JSON.stringify(expected));
      // A member named __proto__ is data, as JSON.parse makes it, and never the object's prototype.
      expect(Object.getPrototypeOf(loaded)).toBe(Object.prototype);
      expect(Object.getOwnPropertyDescriptor(loaded, "__proto__")?.value).toEqual({ u: 1 });
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
      const token = `${next(2) === 0 ? "-" : ""}${int}${fraction === 0 ? "" : `.${digits(fraction)}`}${next(3) === 0 ? `${next(2) === 0 ? "e" : "E"}${["", "+", "-"][next(3)]}${next(100)}` : ""}`;
      const parsed = parseExact(`[${token}]`);
      if (!parsed.ok) throw new Error(`${token} was not held`);
      const [value] = parsed.value as [unknown];
      expect(typeof value).toBe("number");
      expect(`${token} is ${normal(String(value))}`).toBe(`${token} is ${normal(token)}`);
    }
    // And one digit more is where it stops being true, so those are parsed and compared.
    expect((parseExact("[0.1000000000000001,0.30000000000000004,12345678901234567]") as { value: unknown[] }).value).toEqual([0.1000000000000001, 0.30000000000000004, 12345678901234567n]);
    // Seventeen digits where the double prints in fewer: the text states a value the double does not print as.
    expect(parseExact("[0.10000000000000001]")).toEqual({ ok: false, tokens: ["0.10000000000000001"], partial: [UNREPRESENTABLE] });
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

// ---- RD-121 validation decides such an integer exactly, or says it did not -----------------

describe("RD-121 a record holding such an integer is validated exactly or reported partial", () => {
  const schemaFor = (value: Record<string, unknown>) => validator([{
    id: "parley.test.big", version: "1.0.0",
    schema: { type: "object", required: ["value"], properties: { value } },
  }]);
  const line = (valueText: string) => `{"event":"result","t":${T0},"seq":2,"run":"${runId(1)}","value":${valueText},"_schema":{"id":"parley.test.big","version":"1.0.0"}}`;
  function validated(valueText: string, value: Record<string, unknown>) {
    const { receipts } = scratch();
    const run = runId(1);
    const path = writeLines(receipts, run, [headLine(run, T0), line(valueText), endLine(run, T0 + 3, join(receipts, `${run}.jsonl`))]);
    const read = readReceiptFile(path, { validate: schemaFor(value) });
    const bundle = read.bundles[0]!;
    // The validator under test ships this one schema, so the head and the `end` beside the
    // record are unknown pairs to it; the defects that matter are the record's own line's.
    return { record: bundle.records.find((r) => r.seq === 2)!, defects: bundle.defects.filter((d) => d.line === 2) };
  }

  test("an integer beyond a double is an integer, and is inside a lower bound it exceeds", () => {
    const { record, defects } = validated("9007199254740993", { type: "integer", minimum: 0 });
    expect(record.record.value).toBe(9007199254740993n);
    expect(record.validation.state).toBe("validated");
    expect(defects).toEqual([]);
    expect(validated("1e400", { type: "number", exclusiveMinimum: 1 }).record.validation.state).toBe("validated");
  });

  test("it is outside an upper bound it exceeds, a lower bound it is below, and a type it is not", () => {
    const over = validated("9007199254740993", { type: "integer", minimum: 0, maximum: 255 });
    expect(over.record.validation.state).toBe("invalid");
    expect((over.record.validation as unknown as { errors: string[] }).errors.join(" ")).toContain("/value must be <= 255");
    expect(coded(over.defects, "record.invalid").length).toBe(1);
    expect(validated("-9007199254740993", { type: "integer", minimum: 0 }).record.validation.state).toBe("invalid");
    expect(validated("9007199254740993", { type: "string" }).record.validation.state).toBe("invalid");
    expect(validated("9007199254740993", { const: 7 }).record.validation.state).toBe("invalid");
    expect(validated("9007199254740993", { enum: [1, "9007199254740993"] }).record.validation.state).toBe("invalid");
  });

  test("a constraint the reader cannot decide exactly for it is reported partial, never validated", () => {
    // 9007199254740993 is above this bound, and the nearest double to it is the bound itself.
    for (const value of [
      { type: "integer", maximum: 9007199254740992 },
      { const: 9007199254740992 },
      { enum: [1, 9007199254740992] },
      { type: "integer", multipleOf: 2 },
      { type: "array", uniqueItems: true },
    ]) {
      const text = "uniqueItems" in value ? "[9007199254740992,9007199254740993]" : "9007199254740993";
      const { record, defects } = validated(text, value);
      expect(record.validation.state).toBe("partial");
      expect((record.validation as { why?: string }).why).toBe("number_undecided");
      expect(coded(defects, "record.number_undecided").length).toBe(1);
      expect(coded(defects, "record.unknown_pair")).toEqual([]);
    }
  });

  test("the same schemas decide an ordinary number as they always did", () => {
    expect(validated("255", { type: "integer", minimum: 0, maximum: 255 }).record.validation.state).toBe("validated");
    expect(validated("256", { type: "integer", minimum: 0, maximum: 255 }).record.validation.state).toBe("invalid");
    expect(validated("4", { type: "integer", multipleOf: 2 }).record.validation.state).toBe("validated");
    expect(validated("9007199254740992", { const: 9007199254740992 }).record.validation.state).toBe("validated");
  });

  test("a shipped schema decides a status no double holds: it is over the maximum, and the run failed", async () => {
    const { dir, receipts, env } = scratch();
    const run = runId(1);
    const path = join(receipts, `${run}.jsonl`);
    writeLines(receipts, run, [headLine(run, T0), resultLine(run, T0 + 2, "1"), endLine(run, T0 + 3, path, 3, "9007199254740993")]);
    const bundle = only(dir, env);
    const end = bundle.records.find((r) => r.event === "end")!;
    expect(end.record.status).toBe(9007199254740993n);
    expect(end.validation.state).toBe("invalid");
    // The bundle's `status` is a number or null; a status it cannot hold as one is not stated as another.
    expect(bundle.status).toBeNull();
    expect(bundle.terminated).toBe(true);
    expect(bundle.replay.reasons).toContain("end.status_nonzero");
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "everything", window: WINDOW }, { cwd: dir, env }));
    expect(answer.ranking.outcomes[run]).toBe("failed");
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
    for (const [x, y] of [["0.1000000000000000055", "0.1000000000000000056"], ["0.1000000000000000055", "0.1000000000000000055"], ["0.1000000000000000055", "0.1"]] as const) {
      const r = await ask(x, y);
      expect(r.sections).toBe(2);
      expect(r.folded).toBe(0);
      const heldBack = y === "0.1" ? 1 : 2;
      expect(r.answer.counts.unrepresentable).toBe(heldBack);
      expect(r.a).toBeUndefined();
      if (y === "0.1") expect(r.b).toBe(0.1);
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
    writeLines(receipts, run, [headLine(run, T0), raw, endLine(run, T0 + 3, path)]);
    const bundle = only(dir, env);
    expect(bundle.records.map((r) => r.seq)).toEqual([1, 3]);
    const held = coded(bundle.defects, "line.number_unrepresentable");
    expect(held.map((d) => d.raw)).toEqual([raw]);
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
    const r = await ask("9007199254740992", `{"n":[9007199254740993,-9007199254740993,1e400],"s":"9007199254740993"}`);
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

  test("a head whose resolved holds such an integer: the read answers, the lens line is valid and states no rounded value", async () => {
    const { dir, receipts, env } = scratch();
    receipt(receipts, 1, "1", `{"command":"count","limit":9007199254740993}`);
    receipt(receipts, 2, "1", `{"command":"count","limit":9007199254740992}`);
    receipt(receipts, 3, "1", `{"command":"count","limit":9007199254740993}`);
    const answer = answered(await queryReceipts({ asker: { tool: "t" }, view: "everything", window: WINDOW, budget: { records: 1000, bytes: 100_000 } }, { cwd: dir, env }));
    // Runs 1 and 3 share every value and fold; run 2 differs only in that integer and does not.
    expect(answer.digest.runs.map((s) => s.run)).toEqual([runId(2), runId(3)]);
    const [two, three] = answer.digest.runs;
    expect(two!.resolved).toEqual({ command: "count", limit: 9007199254740992 });
    expect(two!.dropped).toBeUndefined();
    // The lens line is written by a JSON writer that cannot carry the integer, so the section
    // leaves `resolved` out whole and names it, and the head it came from holds it exactly.
    expect(three!.resolved).toBeUndefined();
    expect(three!.dropped).toEqual(["resolved"]);
    expect(three!.folded).toEqual({ others: 1, records: 3, stands_for: [runId(1)] });
    const head = answer.records.find((x) => x.run === runId(3) && x.event === "receipt.head")!;
    expect((head.record.resolved as { limit: unknown }).limit).toBe(9007199254740993n);
    const written = readFileSync(answer.receipt, "utf8").split("\n").find((l) => l.includes(`"event":"lens"`))!;
    expect(Buffer.byteLength(written + "\n", "utf8")).toBe(answer.digestBytes);
    expect(written).not.toContain("9007199254740993");
    expect(written.match(/9007199254740992/g)!.length).toBe(1);
    const own = loadReceipts({ cwd: dir, env }).bundles.find((b) => b.run === answer.run)!;
    expect(own.records.find((x) => x.event === "lens")!.validation.state).toBe("validated");
  });

  test("runSection drops a resolved it cannot carry before it measures anything", () => {
    const head: LoadedRecord = {
      run: runId(1), seq: 1, event: "receipt.head", t: T0, file: "f", line: 1, copies: 1, fromSidecar: false, projected: false, projectedBy: [],
      record: { event: "receipt.head", tool: "t", v: "1", argv: ["t"], inv: "i", resolved: { deep: [{ limit: 9007199254740993n }] } },
      validation: { state: "unvalidated", schema: null, why: "no_schema_ref" },
    };
    const section = runSection(runId(1), [head]);
    expect(section).toEqual({ run: runId(1), tool: "t", v: "1", argv: ["t"], inv: "i", dropped: ["resolved"] });
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
    for (let i = 0; i < 20_000; i++) lines.push(resultLine(run, T0 + i, `{"i":${i},"ratio":0.${String(i).padStart(5, "0")}1,"sha":"${"9e".repeat(32)}","big":9007199254740992}`, i + 2));
    lines.push(endLine(run, T0 + 30_000, path, 20_002));
    writeLines(receipts, run, lines);
    const started = Date.now();
    const load = loadReceipts({ cwd: dir, env });
    expect(load.counts.records).toBe(20_002);
    expect(load.counts.quarantined).toBe(0);
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);
});
