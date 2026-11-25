#!/usr/bin/env bun
// Prints the pinned `inv` fixture, `inv-pinned.jsonl`, from the writer source in the directory
// named by the first argument:
//
//   bun packages/parley-emit/test/fixtures/pin-inv.ts <checkout>/packages/parley-emit/src
//
// One JSON object per line: a case's name, how it was computed (`canonical`, `computeInv` or a
// whole run through `main`), its input, and what the writer at that source made of it. The
// committed file was printed from origin/main at 5a3bfeb, before a `bigint` was accepted
// (flyingrobots/parley#171); `test/exact.test.ts` recomputes every line with the source beside it
// and requires the same text. No input here holds a `bigint`: these are the values the writer
// supported before, whose identities must not move.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const VALUES: Record<string, unknown> = {
  "null": null,
  "true": true,
  "false": false,
  "empty string": "",
  "string with escapes": "a\"b\\c\n\t\u0001   é 日本 😀",
  "zero": 0,
  "negative zero": -0,
  "safe integers": [1, -1, 42, 9007199254740991, -9007199254740991],
  "integers a double holds beyond the safe range": [9007199254740992, -9007199254740992, 1e16, 1e20, 1e21, 1.2345678901234567e30, Number.MAX_VALUE],
  "decimals": [0.1, 0.5, -2.5, 0.30000000000000004, 1e-7, 5e-324, 123456789012345.5, 1.5e-10],
  "not finite": [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
  "empty containers": [{}, []],
  "keys are sorted": { b: 1, a: 2, "": 3, "é": 4, A: 5, "10": 6, "9": 7 },
  "undefined members are left out": { kept: 1, gone: undefined, list: [undefined, 1] },
  "nested": { command: "count", args: ["--depth", "3"], options: { depth: 3, follow: false, roots: ["a", "b"], limit: null } },
  "the default resolved": { command: "count", args: [] },
  "a redacted resolved": { command: "count", args: ["--token", "[redacted]"], token: "[redacted]" },
};

export const PREIMAGES: Record<string, { tool: string; v: string; command: string; resolved: unknown; inputs: { path: string; role?: string; sha256?: string; error?: string }[] }> = {
  "no inputs": { tool: "t", v: "0.0.1", command: "count", resolved: { command: "count", args: [] }, inputs: [] },
  "one file": { tool: "t", v: "0.0.1", command: "count", resolved: { command: "count", args: ["a.txt"] }, inputs: [{ path: "a.txt", sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" }] },
  "a role and a tree": { tool: "footprint", v: "1.2.3", command: "report", resolved: { command: "report", range: "main..HEAD", depth: 2, ratio: 0.25 }, inputs: [{ path: "-", role: "stdin", sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }, { path: "src", role: "tree", sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" }] },
  "numbers in resolved": { tool: "t", v: "0.0.1", command: "count", resolved: { command: "count", n: 9007199254740992, big: 1e21, small: 1e-7, neg: -0 }, inputs: [] },
  "an unread input has no inv": { tool: "t", v: "0.0.1", command: "count", resolved: {}, inputs: [{ path: "a.txt", error: "input.unreadable" }] },
};

/** `undefined`, `NaN` and the infinities have no JSON form; they are named in the fixture's `input` so a line stays JSON. */
function shown(v: unknown): unknown {
  if (v === undefined) return "(undefined)";
  if (typeof v === "number" && !Number.isFinite(v)) return `(${String(v)})`;
  if (Object.is(v, -0)) return "(-0)";
  if (Array.isArray(v)) return v.map(shown);
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shown(x)]));
  return v;
}

export async function pinned(src: string): Promise<string[]> {
  const index = await import(resolve(src, "index.ts"));
  const lines: string[] = [];
  for (const [name, value] of Object.entries(VALUES)) {
    // A value the source refuses has no canonical text: the line says so (flyingrobots/parley#177).
    let text: string | null = null, refused: string | undefined;
    try { text = index.canonical(value); } catch (e) { refused = e instanceof Error ? e.name : "thrown"; }
    lines.push(JSON.stringify(refused === undefined ? { name, how: "canonical", input: shown(value), text } : { name, how: "canonical", input: shown(value), refused }));
  }
  for (const [name, pre] of Object.entries(PREIMAGES)) lines.push(JSON.stringify({ name, how: "computeInv", input: shown(pre), inv: index.computeInv(pre) ?? null }));
  // Whole runs: the `inv` on the bootstrap line (no inputs) and on `receipt.inputs` (one file).
  const tool = index.defineTool({ name: "t", version: "0.0.1", commands: { count: { intent: "Count things", effects: { reads: [], writes: [], network: false, idempotent: true }, secrets: ["--token"], emits: [{ id: "t.count", version: "1.0.0" }] } }, retention: { count: 100 } });
  const runs: Record<string, { argv: string[]; resolved: unknown; file?: string }> = {
    "a run with no inputs": { argv: ["count"], resolved: { command: "count", depth: 3, ratio: 0.25, roots: ["a", "b"] } },
    "a run with a redacted argument": { argv: ["count", "--token", "hunter2-hunter2"], resolved: { command: "count", token: "hunter2-hunter2", note: "uses hunter2-hunter2" } },
    "a run with one file input": { argv: ["count", "a.txt"], resolved: { command: "count", args: ["a.txt"], big: 1e21 }, file: "hello" },
  };
  for (const [name, r] of Object.entries(runs)) {
    const cwd = mkdtempSync(join(tmpdir(), "parley-pin-"));
    const state = mkdtempSync(join(tmpdir(), "parley-pin-state-"));
    if (r.file !== undefined) writeFileSync(join(cwd, "a.txt"), r.file);
    const out: string[] = [];
    let receipt = "";
    const status = await index.main(tool, ["t", ...r.argv], async (run: { receiptPath: string }) => { receipt = run.receiptPath; }, {
      cwd, env: { XDG_STATE_HOME: state }, home: state, history: null, resolved: () => r.resolved, inputs: () => (r.file === undefined ? [] : [{ path: "a.txt" }]),
      stdout: { write: (l: string) => { out.push(l); } }, stderr: { write: () => {} },
    });
    const text = out.join("") + (await Bun.file(receipt).text());
    const invs = [...new Set([...text.matchAll(/"inv":"([0-9a-f]{64})"/g)].map((m) => m[1]))];
    lines.push(JSON.stringify({ name, how: "main", input: shown({ argv: r.argv, resolved: r.resolved, file: r.file ?? null }), status, inv: invs }));
  }
  return lines;
}

if (import.meta.main) {
  const src = process.argv[2];
  if (src === undefined) { process.stderr.write(JSON.stringify({ event: "error", code: "pin_inv.usage", problem: "name the writer's src directory" }) + "\n"); process.exit(2); }
  for (const line of await pinned(src)) process.stdout.write(line + "\n");
}
