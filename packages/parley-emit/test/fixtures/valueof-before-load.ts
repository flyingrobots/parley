#!/usr/bin/env bun
// A process that replaces BigInt.prototype.valueOf before the writer is loaded, so the method the
// writer takes when it loads is the replacement (flyingrobots/parley#190, PR #196's review). The
// replacement is the one named by the first argument. Those that fail the writer's load check:
//
//   hooked      answers with an object holding a toJSON hook (the issue's replacement)
//   str         answers with a string
//   constbig    answers with 7n for any receiver
//   onebig      answers with 1n for any receiver, which is right for a box holding 1n
//   throws      throws a RangeError for any receiver
//   datethrows  onebig, while the global Date throws when constructed until the writer has loaded
//               (round 2 of the review, F-9)
//
// Those that pass it, because they answer 1n for a box holding 1n and throw for a Date, and are
// wrong elsewhere (round 2 of the review, F-6 and F-8):
//
//   square      answers the square of the held value
//   asint64     answers the held value truncated to 64 bits, right for a box that fits
//   dateaware   throws for a Date and answers 1n for anything else
//   liarstr     answers the held value for a box, throws for a Date, and answers a string for
//               any other object
//   later7      calls the original until the writer has loaded, then answers 7n
//   laterthrows calls the original until the writer has loaded, then throws a RangeError
//   laterstr    calls the original until the writer has loaded, then answers its digits as a
//               string
//
// And the controls:
//
//   none        no replacement: the control every other mode is compared with
//   delegate    calls the original: a faithful wrapper
//   novm        no replacement, and `node:vm` cannot make a realm when the writer asks for one
//               (round 2 of the review, F-12)
//
// Then it does four real writer runs, each read on every sink as text: stdout, the receipt and the
// history stream. The first emits one result for each value below, each followed by nothing, and
// records what each call threw; the second and third hand `resolved` a value; the fourth logs an
// object holding boxes to the console. It prints one JSON object.
// Run by test/exact.test.ts, as a separate process because the replacement must precede the import.
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const mode = process.argv[2] ?? "none";
// The fixture's own realm-maker, kept before `novm` replaces the module's export.
const realm: typeof runInNewContext = runInNewContext;
const original = BigInt.prototype.valueOf;
let calls = 0;
/** Set once the writer has loaded: the `later` modes are faithful for its load check and not after. */
let loaded = false;
const replacements: Record<string, (this: unknown) => unknown> = {
  hooked() { calls++; return { toJSON: () => `call-${calls}` }; },
  str() { return "zz"; },
  constbig() { return 7n; },
  onebig() { return 1n; },
  datethrows() { return 1n; },
  throws() { throw new RangeError("replaced valueOf"); },
  delegate() { return original.call(this as bigint); },
  square() { const held = original.call(this as bigint); return held * held; },
  asint64() { return BigInt.asIntN(64, original.call(this as bigint)); },
  dateaware() { if (this instanceof Date) throw new TypeError("not a bigint"); return 1n; },
  liarstr() {
    if (this instanceof Date) throw new TypeError("not a bigint");
    try { return original.call(this as bigint); } catch { return "zz"; }
  },
  later7() { return loaded ? 7n : original.call(this as bigint); },
  laterthrows() { if (loaded) throw new RangeError("replaced valueOf"); return original.call(this as bigint); },
  laterstr() { const held = original.call(this as bigint); return loaded ? String(held) : held; },
};
if (mode !== "none" && mode !== "novm") {
  const replacement = replacements[mode];
  if (replacement === undefined) throw new Error(`unknown mode ${mode}`);
  (BigInt.prototype as unknown as { valueOf: unknown }).valueOf = replacement;
}
if (mode === "novm") {
  const { mock } = await import("bun:test");
  await mock.module("node:vm", () => ({ runInNewContext: () => { throw new Error("no realm can be made here"); } }));
}
const RealDate = globalThis.Date;
if (mode === "datethrows") {
  (globalThis as { Date: unknown }).Date = function Date() { throw new Error("no Date can be made here"); };
}

const { defineTool, exactJson, main } = await import("../../src/index.ts");
globalThis.Date = RealDate;
loaded = true;

class Point { x = 1; y = 2; }
/** Each value a tool might hand over, by name. A fresh one on every call. */
const values: Record<string, () => unknown> = {
  box: () => Object(5n),
  foreignBox: () => realm("Object(5n)"),
  bigBox: () => Object(2n ** 70n + 3n),
  foreignBigBox: () => realm("Object(-(2n ** 70n) - 3n)"),
  primitive: () => 9007199254740993n,
  date: () => new Date(0),
  url: () => new URL("https://example.com/a?b=1"),
  map: () => new Map([[1, 2]]),
  regexp: () => /x/g,
  error: () => new Error("e"),
  instance: () => new Point(),
  number: () => new Number(42),
  string: () => new String("s"),
  foreignPlain: () => realm("({ a: 1 })"),
  foreignDate: () => realm("new Date(0)"),
};

const P = { id: "t.any", version: "1.0.0" };
const tool = defineTool({
  name: "t", version: "0.0.1",
  commands: { count: { intent: "Count things", effects: { reads: [], writes: [], network: false, idempotent: true }, secrets: [], emits: [P] } },
  retention: { count: 100 },
});

const said = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : `non-error ${String(e)}`);
const lines = (text: string) => (text === "" ? [] : text.trimEnd().split("\n"));

/** One real run, with every sink read as text. */
async function run(body: Parameters<typeof main>[2], resolved?: () => Record<string, unknown>) {
  const cwd = mkdtempSync(join(tmpdir(), "parley-valueof-"));
  const state = mkdtempSync(join(tmpdir(), "parley-valueof-state-"));
  const hist = mkdtempSync(join(tmpdir(), "parley-valueof-hist-"));
  const out: string[] = [], err: string[] = [];
  let receiptPath = "";
  const status = await main(tool, ["t", "count"], async (r, args) => { receiptPath = r.receiptPath; await body(r, args); }, {
    cwd, env: { XDG_STATE_HOME: state, PARLEY_HISTORY: hist }, home: state,
    stdout: { write: (l) => { out.push(l); } }, stderr: { write: (l) => { err.push(l); } },
    ...(resolved === undefined ? {} : { resolved }),
  });
  const receipt = receiptPath === "" ? [] : lines(readFileSync(receiptPath, "utf8"));
  const stream = readdirSync(hist).sort().flatMap((n) => lines(readFileSync(join(hist, n), "utf8")));
  return { status, stdout: out.flatMap(lines), stderr: err.flatMap(lines), receipt, stream };
}

const exact: Record<string, string> = {};
for (const [name, make] of Object.entries(values)) {
  try { exact[name] = exactJson({ v: make() }); } catch (e) { exact[name] = `threw ${said(e)}`; }
}

const threw: Record<string, string> = {};
const results = await run((r) => {
  for (const [name, make] of Object.entries(values)) {
    try { r.result({ event: "result", name, value: make() }, P); } catch (e) { threw[name] = said(e); }
  }
});

const resolvedDate = await run(() => {}, () => ({ command: "count", when: new Date(0), at: new Point() }));
const resolvedBox = await run(() => {}, () => ({ command: "count", id: Object(5n) }));
const logged = await run(() => { console.log("row", { id: Object(5n), big: Object(2n ** 70n + 3n), when: new Date(0) }); });

console.log(JSON.stringify({ mode, exact, threw, results, resolvedDate, resolvedBox, logged }));
