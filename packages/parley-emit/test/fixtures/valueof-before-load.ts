#!/usr/bin/env bun
// A process that replaces BigInt.prototype.valueOf before the writer is loaded, so the method the
// writer takes when it loads is the replacement (flyingrobots/parley#190, PR #196's review). The
// replacement is the one named by the first argument:
//
//   none      no replacement: the control every other mode is compared with
//   hooked    answers with an object holding a toJSON hook (the issue's replacement)
//   str       answers with a string
//   constbig  answers with 7n for any receiver
//   throws    throws a RangeError for any receiver
//   delegate  calls the original: a faithful wrapper
//
// Then it does two real writer runs, each read on every sink as text: stdout, the receipt and the
// history stream. The first emits one result for each value below, each followed by nothing, and
// records what each call threw; the second hands `resolved` a value. It prints one JSON object.
// Run by test/exact.test.ts, as a separate process because the replacement must precede the import.
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const mode = process.argv[2] ?? "none";
const original = BigInt.prototype.valueOf;
let calls = 0;
const replacements: Record<string, (this: unknown) => unknown> = {
  hooked() { calls++; return { toJSON: () => `call-${calls}` }; },
  str() { return "zz"; },
  constbig() { return 7n; },
  throws() { throw new RangeError("replaced valueOf"); },
  delegate() { return original.call(this as bigint); },
};
if (mode !== "none") {
  const replacement = replacements[mode];
  if (replacement === undefined) throw new Error(`unknown mode ${mode}`);
  (BigInt.prototype as unknown as { valueOf: unknown }).valueOf = replacement;
}

const { defineTool, exactJson, main } = await import("../../src/index.ts");

class Point { x = 1; y = 2; }
/** Each value a tool might hand over, by name. A fresh one on every call. */
const values: Record<string, () => unknown> = {
  box: () => Object(5n),
  foreignBox: () => runInNewContext("Object(5n)"),
  primitive: () => 9007199254740993n,
  date: () => new Date(0),
  url: () => new URL("https://example.com/a?b=1"),
  map: () => new Map([[1, 2]]),
  regexp: () => /x/g,
  error: () => new Error("e"),
  instance: () => new Point(),
  number: () => new Number(42),
  string: () => new String("s"),
  foreignPlain: () => runInNewContext("({ a: 1 })"),
  foreignDate: () => runInNewContext("new Date(0)"),
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

console.log(JSON.stringify({ mode, exact, threw, results, resolvedDate, resolvedBox }));
