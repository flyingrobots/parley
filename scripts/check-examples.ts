#!/usr/bin/env bun
// Validates every fenced JSON example in the repository's markdown against the schema its
// `_schema` names. Output is JSON Lines on stdout; `--human` switches to prose. Exit 0 when
// every example is valid, 1 when any is not, 2 when the check itself could not run.

import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const OUTPUT_SCHEMA = { id: "parley.tooling.check_examples", version: "1.0.0" } as const;

export type Verdict =
  | { event: "example.ok"; file: string; line: number; schema: string; version: string }
  | { event: "example.skipped"; file: string; line: number; reason: "abridged" | "illustrative" | "tool_owned"; schema?: string }
  | { event: "example.invalid"; file: string; line: number; reason: "parse" | "no_schema" | "unknown_schema" | "invalid"; detail: string }
  | { event: "summary"; files: number; examples: number; ok: number; skipped: number; invalid: number; passed: boolean }
  | { event: "error"; code: string; problem: string };

type Stamped = Verdict & { _schema: typeof OUTPUT_SCHEMA };

const DEFAULT_ROOTS = ["README.md", "spec", "docs"];
const PROTOCOL_PREFIX = "parley.";

function walkMarkdown(root: string): string[] {
  const st = statSync(root);
  if (st.isFile()) return root.endsWith(".md") ? [root] : [];
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      out.push(...walkMarkdown(p));
    } else if (name.endsWith(".md")) out.push(p);
  }
  return out.sort();
}

interface Block { file: string; line: number; kind: "json" | "jsonl"; labels: Set<string>; body: string[] }

function fencedBlocks(file: string, text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let open: Block | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (open) {
      if (/^```\s*$/.test(l)) { blocks.push(open); open = null; } else open.body.push(l);
      continue;
    }
    const m = /^```(jsonl?)(?:\s+(.*))?\s*$/.exec(l);
    if (m) {
      const labels = new Set((m[2] ?? "").split(/\s+/).filter(Boolean));
      open = { file, line: i + 2, kind: m[1] as "json" | "jsonl", labels, body: [] };
    }
  }
  return blocks;
}

interface SchemaIndex { byKey: Map<string, object> }

export function schemaFiles(dir: string): string[] {
  // Drafts at the top level; released snapshots under released/<id>/<version>.schema.json (spec §4.6).
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name === "released") for (const idDir of readdirSync(p)) { const q = join(p, idDir); if (statSync(q).isDirectory()) out.push(...readdirSync(q).filter((f) => f.endsWith(".schema.json")).map((f) => join(q, f))); } }
    else if (name.endsWith(".schema.json")) out.push(p);
  }
  return out.sort();
}

export function loadSchemas(dir: string): SchemaIndex {
  const byKey = new Map<string, object>();
  for (const file of schemaFiles(dir)) {
    const schema = JSON.parse(readFileSync(file, "utf8"));
    const id = String(schema.$id ?? "");
    const m = /\/schemas\/([^/]+)\/([^/]+)$/.exec(id);
    if (!m) throw new Error(`${file}: $id does not end in /schemas/<id>/<version>: ${id}`);
    const key = `${m[1]}@${m[2]}`;
    if (byKey.has(key)) throw new Error(`${file}: a draft and a released snapshot both claim ${key}; a released version is immutable and the draft must move on (spec §4.5)`);
    byKey.set(key, schema);
  }
  return { byKey };
}

function describe(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim()).join("; ");
}

export function check(roots: string[], schemasDir: string): Verdict[] {
  const index = loadSchemas(schemasDir);
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const compiled = new Map<string, ReturnType<typeof ajv.compile>>();
  const out: Verdict[] = [];
  const files = roots.flatMap(walkMarkdown);
  let examples = 0, ok = 0, skipped = 0, invalid = 0;

  for (const file of files) {
    const rel = relative(process.cwd(), resolve(file));
    for (const block of fencedBlocks(rel, readFileSync(file, "utf8"))) {
      const docs: { line: number; text: string }[] =
        block.kind === "json"
          ? [{ line: block.line, text: block.body.join("\n") }]
          : block.body.map((text, i) => ({ line: block.line + i, text })).filter((d) => d.text.trim() !== "");
      for (const doc of docs) {
        examples++;
        const at = { file: rel, line: doc.line };
        if (block.labels.has("abridged")) { skipped++; out.push({ event: "example.skipped", ...at, reason: "abridged" }); continue; }
        let value: unknown;
        try { value = JSON.parse(doc.text); } catch (e) {
          invalid++; out.push({ event: "example.invalid", ...at, reason: "parse", detail: (e as Error).message }); continue;
        }
        if (block.labels.has("illustrative")) { skipped++; out.push({ event: "example.skipped", ...at, reason: "illustrative" }); continue; }
        const s = (value as { _schema?: { id?: unknown; version?: unknown } })?._schema;
        if (typeof s?.id !== "string" || typeof s?.version !== "string") {
          invalid++; out.push({ event: "example.invalid", ...at, reason: "no_schema", detail: "no _schema.id and _schema.version; label the block illustrative or abridged if that is intended" }); continue;
        }
        if (!s.id.startsWith(PROTOCOL_PREFIX)) { skipped++; out.push({ event: "example.skipped", ...at, reason: "tool_owned", schema: s.id }); continue; }
        const key = `${s.id}@${s.version}`;
        const schema = index.byKey.get(key);
        if (!schema) { invalid++; out.push({ event: "example.invalid", ...at, reason: "unknown_schema", detail: `no schema for ${key} under ${schemasDir}` }); continue; }
        let validate = compiled.get(key);
        if (!validate) { validate = ajv.compile(schema); compiled.set(key, validate); }
        if (validate(value)) { ok++; out.push({ event: "example.ok", ...at, schema: s.id, version: s.version }); }
        else { invalid++; out.push({ event: "example.invalid", ...at, reason: "invalid", detail: describe(validate.errors) }); }
      }
    }
  }
  out.push({ event: "summary", files: files.length, examples, ok, skipped, invalid, passed: invalid === 0 && examples > 0 });
  return out;
}

export function stamp(v: Verdict): Stamped { return { ...v, _schema: OUTPUT_SCHEMA }; }

function human(v: Verdict): string {
  switch (v.event) {
    case "example.ok": return `ok       ${v.file}:${v.line}  ${v.schema}@${v.version}`;
    case "example.skipped": return `skipped  ${v.file}:${v.line}  ${v.reason}${v.schema ? ` (${v.schema})` : ""}`;
    case "example.invalid": return `INVALID  ${v.file}:${v.line}  ${v.reason}: ${v.detail}`;
    case "summary": return `${v.passed ? "PASS" : "FAIL"}  ${v.examples} examples in ${v.files} files: ${v.ok} ok, ${v.skipped} skipped, ${v.invalid} invalid`;
    case "error": return `ERROR  ${v.code}: ${v.problem}`;
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const prose = args.includes("--human") || args.includes("--humanize");
  const roots = args.filter((a) => !a.startsWith("--"));
  const write = (v: Verdict, stream: NodeJS.WriteStream) => stream.write((prose ? human(v) : JSON.stringify(stamp(v))) + "\n");
  try {
    const verdicts = check(roots.length ? roots : DEFAULT_ROOTS, "schemas");
    for (const v of verdicts) write(v, process.stdout);
    const summary = verdicts[verdicts.length - 1];
    if (summary.event === "summary" && summary.examples === 0) {
      write({ event: "error", code: "check.no_examples", problem: "no fenced json or jsonl blocks found; refusing to report success over nothing" }, process.stderr);
      process.exit(2);
    }
    process.exit(summary.event === "summary" && summary.passed ? 0 : 1);
  } catch (e) {
    write({ event: "error", code: "check.crashed", problem: (e as Error).message }, process.stderr);
    process.exit(2);
  }
}
