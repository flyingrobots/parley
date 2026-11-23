#!/usr/bin/env bun
// parley doctor: checks a captured run (stdout, stderr, receipt) against the specification and
// names the violated rule and the offending line. Output is JSON Lines; --human switches to prose.
// This is repository tooling (see AGENTS.md): it reads parley output and does not itself claim to
// be a conforming parley program until the writer library (flyingrobots/parley#1) exists.
//
// Exit: 0 conforming, 1 violations found, 2 the check could not run.

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync, existsSync } from "node:fs";
import { loadSchemas } from "./check-examples.ts";

export const OUTPUT_SCHEMA = { id: "parley.tooling.doctor", version: "1.1.0" } as const;
export type Stream = "stdout" | "stderr" | "receipt";
/** A segment of the shared history stream (spec §8) is a fourth thing a line can come from. */
export type Source = Stream | "history";
export interface Violation { event: "doctor.violation"; rule: string; section: string; stream: Source; line: number; problem: string }
export interface Summary { event: "doctor.summary"; passed: boolean; violations: number; lines: Record<Stream, number>; run: string | null; status: number | null; partial: number }
/** A run whose copy in a segment is a projection, and what projected it (spec §8, informative). */
export interface Projection { event: "doctor.projection"; run: string; name: string; sha256: string; line: number }
/** A seq a run's copy in a segment does not carry: a withheld line, or one stored as a sidecar. */
export interface Gap { event: "doctor.gap"; run: string; seq: number }
export interface SegmentSummary { event: "doctor.segment"; passed: boolean; lines: number; runs: number; projected: number; gaps: number; torn: number; incomplete: number }
export type Verdict = Violation | Summary;
export type SegmentVerdict = Violation | Projection | Gap | SegmentSummary;

interface Line { stream: Source; n: number; raw: string; obj?: Record<string, unknown>; }
const ENVELOPE = ["event", "t", "seq", "run", "_schema"] as const;

export function splitLines(stream: Source, text: string): { lines: Line[]; unterminated: Line | null } {
  // §1.4 and §5.4: a line is newline-terminated; a trailing fragment is not a line.
  const parts = text.split("\n");
  const last = parts.pop() ?? "";
  const lines = parts.map((raw, i) => ({ stream, n: i + 1, raw }));
  const unterminated = last.length ? { stream, n: parts.length + 1, raw: last } : null;
  return { lines, unterminated };
}

function parse(l: Line): Record<string, unknown> | null {
  try { const v = JSON.parse(l.raw); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; }
}

export function doctor(input: { stdout?: string; stderr?: string; receipt?: string; receiptPresent?: boolean }, schemasDir = "schemas"): Verdict[] {
  const out: Violation[] = [];
  const V = (rule: string, section: string, stream: Source, line: number, problem: string) => out.push({ event: "doctor.violation", rule, section, stream, line, problem });
  const index = loadSchemas(schemasDir);
  const ajv = new Ajv2020({ strict: false, allErrors: true }); addFormats(ajv);
  const compiled = new Map<string, ReturnType<typeof ajv.compile>>();
  const validateExact = (key: string, obj: unknown) => { let v = compiled.get(key); if (!v) { v = ajv.compile(index.byKey.get(key)!); compiled.set(key, v); } return v(obj) ? null : (v.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; "); };

  const streams: Stream[] = ["stdout", "stderr", "receipt"];
  const all: Line[] = []; const counts: Record<Stream, number> = { stdout: 0, stderr: 0, receipt: 0 };
  let partial = 0;
  for (const s of streams) {
    const text = input[s]; if (text === undefined) continue;
    const { lines, unterminated } = splitLines(s, text);
    counts[s] = lines.length;
    if (unterminated) V("R1.unterminated", "§5.4", s, unterminated.n, `final line has no newline; ignored as not written`);
    for (const l of lines) {
      if (l.raw.trim() === "") { V("R1.blank", "§1.1", s, l.n, "blank line"); continue; }
      const obj = parse(l);
      if (!obj) { V(s === "stdout" ? "R1.stdout_not_json" : "R1.quarantined", s === "stdout" ? "§1" : "§1.4", s, l.n, s === "stdout" ? "not a JSON object on stdout: contract failure" : "not a JSON object; quarantined, not a protocol line"); continue; }
      l.obj = obj; all.push(l);
    }
  }

  // R2 envelope on every protocol line
  for (const l of all) {
    const o = l.obj!;
    for (const k of ENVELOPE) if (!(k in o)) V("R2.envelope", "§1.3", l.stream, l.n, `missing ${k}`);
    if ("t" in o && !(Number.isInteger(o.t) && (o.t as number) >= 0)) V("R2.t", "§1.3", l.stream, l.n, "t is not a non-negative integer");
    if ("seq" in o && !(Number.isInteger(o.seq) && (o.seq as number) >= 0)) V("R2.seq", "§1.3", l.stream, l.n, "seq is not a non-negative integer");
    const sch = o._schema as Record<string, unknown> | undefined;
    if (sch && (typeof sch.id !== "string" || typeof sch.version !== "string")) V("R2.schema_shape", "§1.3", l.stream, l.n, "_schema needs string id and version");
  }

  // R3 exact-pair validation for parley.* ids; tool-owned ids are partial
  for (const l of all) {
    const o = l.obj!; const sch = o._schema as { id?: string; version?: string } | undefined;
    if (!sch || typeof sch.id !== "string" || typeof sch.version !== "string") continue;
    if (!sch.id.startsWith("parley.")) { partial++; continue; }
    const key = `${sch.id}@${sch.version}`;
    if (!index.byKey.has(key)) { V("R3.unknown_pair", "§4.5", l.stream, l.n, `no schema for ${key}; reported as unvalidated, never as validated`); partial++; continue; }
    const err = validateExact(key, o); if (err) V("R3.invalid", "§4.5", l.stream, l.n, `${key}: ${err}`);
  }

  // R4 bootstrap or startup failure
  const stdout = all.filter((l) => l.stream === "stdout"); const stderr = all.filter((l) => l.stream === "stderr"); const receipt = all.filter((l) => l.stream === "receipt");
  let run: string | null = null; let boot: Record<string, unknown> | null = null;
  // A receipt read alone: the record of a run whose streams were prose under --human (§1.1), or one
  // whose streams were not kept. The rules that need stdout are not applicable and are not run.
  const receiptOnly = input.stdout === undefined && input.stderr === undefined && (input.receipt !== undefined || input.receiptPresent === false);
  if (receiptOnly) {
    if (input.receipt === undefined) V("R5.receipt_missing", "§3.1", "receipt", 0, "the receipt to check does not exist");
    const alone = input.receipt === undefined ? { run: null, status: null } : receiptAlone(receipt, V);
    return [...out, { event: "doctor.summary", passed: out.length === 0, violations: out.length, lines: counts, run: alone.run, status: alone.status, partial }];
  }
  const startup = stderr.find((l) => l.obj!.event === "startup.failed");
  if (startup) {
    run = String(startup.obj!.run ?? "");
    if (stdout.length || receipt.length || stderr.length > 1) V("R4.startup_alone", "§3.2", "stderr", startup.n, "startup.failed must be the only line the run emits");
    if (startup.obj!.seq !== 0) V("R4.startup_seq", "§3.2", "stderr", startup.n, "startup.failed is seq 0");
  } else {
    const first = stdout[0];
    if (!first) V("R4.no_bootstrap", "§3.1", "stdout", 0, "no stdout lines; a run that bootstrapped has at least the bootstrap line and end");
    else {
      boot = first.obj!;
      if (boot.event !== "run") V("R4.first_not_bootstrap", "§3.1", "stdout", first.n, `first stdout line is ${String(boot.event)}, not the bootstrap line`);
      if (boot.seq !== 0) V("R4.bootstrap_seq", "§1.3", "stdout", first.n, "bootstrap line is seq 0");
      run = typeof boot.run === "string" ? boot.run : null;
      if (receipt.some((l) => l.obj!.event === "run")) V("R4.bootstrap_mirrored", "§3.1", "receipt", receipt.find((l) => l.obj!.event === "run")!.n, "bootstrap line is stdout only");
    }
  }

  // R5 receipt head
  if (boot && input.receipt !== undefined) {
    const headLine = receipt[0]; const head = headLine?.obj;
    if (!headLine || !head || head.event !== "receipt.head") V("R5.head_first", "§5", "receipt", headLine?.n ?? 0, "first receipt line is not receipt.head");
    else {
      if (head.run !== boot.run) V("R5.head_run", "§5", "receipt", headLine.n, "receipt head run differs from bootstrap");
      if (head.tool !== boot.tool || head.v !== boot.v) V("R5.head_tool", "§5", "receipt", headLine.n, "receipt head tool/v differ from bootstrap");
      if (head.seq !== 1 && head.seq !== undefined && !(Number.isInteger(head.seq) && (head.seq as number) >= 1)) V("R5.head_seq", "§1.3", "receipt", headLine.n, "receipt head seq is at least 1");
    }
  } else if (boot && input.receiptPresent === false) V("R5.receipt_missing", "§3.1", "receipt", 0, `receipt announced at ${String((boot.paths as Record<string, unknown> | undefined)?.receipt)} does not exist`);

  // R6 one run, one counter; mirrored copies agree
  if (run !== null) {
    const bySeq = new Map<number, Line[]>();
    for (const l of all) {
      const o = l.obj!;
      if (o.run !== run) V("R6.run", "§1.3", l.stream, l.n, `run ${String(o.run)} is not this run's ${run}`);
      if (Number.isInteger(o.seq)) { const k = o.seq as number; bySeq.set(k, [...(bySeq.get(k) ?? []), l]); }
    }
    for (const [seq, ls] of bySeq) {
      if (ls.length < 2) continue;
      const firstLine = ls[0];
      if (!firstLine) continue;
      const first = firstLine.obj!;
      for (const l of ls.slice(1)) {
        const o = l.obj!;
        if (o.event !== first.event || o.t !== first.t) { V("R6.copies_disagree", "§1.3", l.stream, l.n, `seq ${seq} appears with different event or t on ${firstLine.stream}:${firstLine.n}`); continue; }
        for (const k of Object.keys(o)) if (k in first && JSON.stringify(o[k]) !== JSON.stringify(first[k])) V("R6.copies_disagree", "§1.3", l.stream, l.n, `seq ${seq}: copies disagree on ${k}`);
        if (ls.some((x) => x.stream === l.stream && x !== l)) V("R6.duplicate", "§1.3", l.stream, l.n, `seq ${seq} appears twice on ${l.stream}`);
      }
    }
  }

  // R7 terminal event
  let status: number | null = null;
  if (boot) {
    const lastOutN = stdout[stdout.length - 1]?.n ?? 0; const lastRecN = receipt[receipt.length - 1]?.n ?? 0;
    const lastOut = stdout[stdout.length - 1]?.obj; const lastRec = receipt[receipt.length - 1]?.obj;
    const ends = all.filter((l) => l.obj!.event === "end");
    if (!lastOut || lastOut.event !== "end") V("R7.no_end", "§3.3", "stdout", lastOutN, "last stdout line is not end: incomplete lifecycle evidence, EOF is not success");
    else {
      status = Number.isInteger(lastOut.status) ? (lastOut.status as number) : null;
      if (input.receipt !== undefined && (!lastRec || lastRec.event !== "end")) V("R7.receipt_no_end", "§3.3", "receipt", lastRecN, "last receipt line is not end");
      if (input.receipt !== undefined && lastRec?.event === "end" && lastRec.seq !== lastOut.seq) V("R7.end_seq", "§3.3", "receipt", lastRecN, "end seq differs between stdout and receipt");
      const maxSeq = Math.max(...all.map((l) => (Number.isInteger(l.obj!.seq) ? (l.obj!.seq as number) : -1)));
      if (lastOut.seq !== maxSeq) V("R7.end_not_final", "§3.3", "stdout", lastOutN, `end seq ${String(lastOut.seq)} is not the run's final seq ${maxSeq}`);
      for (const l of all) if (Number.isInteger(l.obj!.seq) && (l.obj!.seq as number) > (lastOut.seq as number)) V("R7.after_end", "§3.3", l.stream, l.n, "event after end");
      const errors = stderr.filter((l) => l.obj!.event === "error").length;
      if (status === 2 && errors === 0) V("R7.status2_no_error", "§3.4", "stdout", lastOutN, "status 2 but no structured error was emitted");
      if (status === 0 && errors > 0) V("R7.status0_with_error", "§3.4", "stdout", lastOutN, "status 0 but an error was emitted; a recovered condition is a warning");
      // R8 redacted aggregate
      const headRedacted = receipt[0]?.obj?.event === "receipt.head" && receipt[0].obj!.redacted !== undefined;
      const anyRedaction = receipt.some((l) => l.obj!.event === "redaction");
      if (input.receipt !== undefined && typeof lastOut.redacted === "boolean" && lastOut.redacted !== (headRedacted || anyRedaction)) V("R8.redacted_aggregate", "§3.3", "stdout", lastOutN, `end.redacted is ${String(lastOut.redacted)} but the receipt says ${headRedacted || anyRedaction}`);
      if (ends.length > 2) V("R7.multiple_end", "§3.3", "stdout", lastOutN, "more than one end event");
    }
    // R9 receipt copies of results, errors and warnings
    if (input.receipt !== undefined) {
      const recSeqs = new Set(receipt.map((l) => l.obj!.seq)); const sidecarFor = new Set(receipt.filter((l) => l.obj!.event === "sidecar").map((l) => l.obj!.source));
      for (const l of [...stdout.filter((x) => x.obj!.event !== "run"), ...stderr]) {
        const o = l.obj!; if (!Number.isInteger(o.seq)) continue;
        if (!recSeqs.has(o.seq) && !sidecarFor.has(o.seq)) V("R9.not_retained", "§5", l.stream, l.n, `${String(o.event)} seq ${String(o.seq)} has no copy or sidecar in the receipt`);
      }
    }
  }

  const summary: Summary = { event: "doctor.summary", passed: out.length === 0, violations: out.length, lines: counts, run, status, partial };
  return [...out, summary];
}

/**
 * R5 to R8 over a receipt with no streams beside it. The head is first; every line names its run;
 * no `seq` appears twice; `end` is last and carries the final `seq`; its status agrees with the
 * errors the receipt holds and its `redacted` with the head and the `redaction` events. R4 and R9
 * need stdout and stderr and are not run, which is why a pass here says less than a full pass.
 */
function receiptAlone(receipt: Line[], V: (rule: string, section: string, stream: Source, line: number, problem: string) => void): { run: string | null; status: number | null } {
  // Every line here parsed (the caller kept only those), so carry the record beside its line number.
  const rs = receipt.flatMap((l) => (l.obj ? [{ n: l.n, obj: l.obj }] : []));
  const seqOf = (o: Record<string, unknown>): number | null => (typeof o.seq === "number" && Number.isInteger(o.seq) ? o.seq : null);
  const head = rs[0]?.obj;
  if (!head || head.event !== "receipt.head") V("R5.head_first", "§5", "receipt", rs[0]?.n ?? 0, "first receipt line is not receipt.head");
  const first = head?.run;
  const run = typeof first === "string" ? first : null; // the head's run, or the first line's when the head is missing
  const seen = new Set<number>();
  for (const r of rs) {
    if (run !== null && r.obj.run !== run) V("R6.run", "§1.3", "receipt", r.n, `run ${String(r.obj.run)} is not this run's ${run}`);
    const seq = seqOf(r.obj);
    if (seq === null) continue;
    if (seen.has(seq)) V("R6.duplicate", "§1.3", "receipt", r.n, `seq ${seq} appears twice on receipt`);
    seen.add(seq);
  }
  const last = rs[rs.length - 1];
  if (!last || last.obj.event !== "end") V("R7.receipt_no_end", "§3.3", "receipt", last?.n ?? 0, "last receipt line is not end: incomplete lifecycle evidence, EOF is not success");
  const end = rs.find((r) => r.obj.event === "end");
  if (!end) return { run, status: null };
  const e = end.obj;
  const status = typeof e.status === "number" && Number.isInteger(e.status) ? e.status : null;
  const endSeq = seqOf(e);
  const maxSeq = Math.max(...rs.map((r) => seqOf(r.obj) ?? -1));
  if (endSeq !== maxSeq) V("R7.end_not_final", "§3.3", "receipt", end.n, `end seq ${String(e.seq)} is not the run's final seq ${maxSeq}`);
  if (endSeq !== null) for (const r of rs) { const seq = seqOf(r.obj); if (seq !== null && seq > endSeq) V("R7.after_end", "§3.3", "receipt", r.n, "event after end"); }
  const errors = rs.filter((r) => r.obj.event === "error").length;
  if (status === 2 && errors === 0) V("R7.status2_no_error", "§3.4", "receipt", end.n, "status 2 but no structured error was recorded");
  if (status === 0 && errors > 0) V("R7.status0_with_error", "§3.4", "receipt", end.n, "status 0 but an error was recorded; a recovered condition is a warning");
  const headRedacted = head?.event === "receipt.head" && head.redacted !== undefined;
  const anyRedaction = rs.some((r) => r.obj.event === "redaction");
  if (typeof e.redacted === "boolean" && e.redacted !== (headRedacted || anyRedaction)) V("R8.redacted_aggregate", "§3.3", "receipt", end.n, `end.redacted is ${String(e.redacted)} but the receipt says ${headRedacted || anyRedaction}`);
  return { run, status };
}

/**
 * Read one segment of the shared history stream (spec §8, informative) rather than one run's
 * three streams. A segment interleaves whole runs from every tool on the machine, and a copy in
 * it may be a **projection** of the receipt copy written through a history transform, so the
 * questions are different: which runs are here, which of them are projected and by what, and
 * which `seq` of each run the copy does not carry. A gap is not a violation — withholding a line
 * is what a transform is for — so this reports and does not judge. An unparseable line is the one
 * real defect, quarantined as §1.4 asks.
 */
export function inspectSegment(text: string): SegmentVerdict[] {
  const out: SegmentVerdict[] = [];
  const { lines, unterminated } = splitLines("history", text);
  if (unterminated) out.push({ event: "doctor.violation", rule: "R1.unterminated", section: "§5.4", stream: "history", line: unterminated.n, problem: "final line has no newline; ignored as not written" });
  let torn = 0;
  const order: string[] = [];
  const byRun = new Map<string, Line[]>();
  for (const l of lines) {
    if (l.raw.trim() === "") { torn++; out.push({ event: "doctor.violation", rule: "R1.blank", section: "§1.1", stream: "history", line: l.n, problem: "blank line" }); continue; }
    const obj = parse(l);
    if (!obj) { torn++; out.push({ event: "doctor.violation", rule: "R1.quarantined", section: "§1.4", stream: "history", line: l.n, problem: "not a JSON object; quarantined, not a protocol line" }); continue; }
    l.obj = obj;
    const run = typeof obj.run === "string" ? obj.run : "";
    if (!run) { out.push({ event: "doctor.violation", rule: "R2.envelope", section: "§1.3", stream: "history", line: l.n, problem: "missing run; a line in a shared segment cannot be attributed" }); continue; }
    if (!byRun.has(run)) { byRun.set(run, []); order.push(run); }
    byRun.get(run)!.push(l);
  }
  let projected = 0, gaps = 0, incomplete = 0;
  for (const run of order) {
    const ls = byRun.get(run)!;
    for (const l of ls) {
      const o = l.obj!;
      if (o.event !== "history.transform") continue;
      projected++;
      out.push({ event: "doctor.projection", run, name: String(o.name ?? ""), sha256: String(o.sha256 ?? ""), line: l.n });
    }
    const seqs = new Set(ls.map((l) => l.obj!.seq).filter((v): v is number => Number.isInteger(v)));
    // A record stored beside the receipt reaches the stream as its `sidecar` event, so the seq it
    // stood for is accounted for and is not a withheld line (§5).
    const stored = new Set(ls.filter((l) => l.obj!.event === "sidecar").map((l) => l.obj!.source).filter((v): v is number => Number.isInteger(v)));
    if (seqs.size) {
      const lo = Math.min(...seqs), hi = Math.max(...seqs);
      for (let seq = lo; seq <= hi; seq++) if (!seqs.has(seq) && !stored.has(seq)) { gaps++; out.push({ event: "doctor.gap", run, seq }); }
    }
    if (ls[ls.length - 1]!.obj!.event !== "end") incomplete++;
  }
  // A gap is not a defect — withholding a line is what a transform is for — so `passed` is about
  // the violations: a line that does not parse, or one no run can be attributed to.
  const summary: SegmentSummary = { event: "doctor.segment", passed: out.every((v) => v.event !== "doctor.violation"), lines: lines.length, runs: order.length, projected, gaps, torn, incomplete };
  return [...out, summary];
}

export function stamp(v: Verdict | SegmentVerdict) { return { ...v, _schema: OUTPUT_SCHEMA }; }
function human(v: Verdict | SegmentVerdict): string {
  if (v.event === "doctor.violation") return `${v.rule.padEnd(24)} ${v.section.padEnd(6)} ${v.stream}:${v.line}  ${v.problem}`;
  if (v.event === "doctor.projection") return `PROJECTION  ${v.run}  ${v.name}  ${v.sha256.slice(0, 12)}…  (history:${v.line})`;
  if (v.event === "doctor.gap") return `GAP         ${v.run}  seq ${v.seq} is not in this copy`;
  if (v.event === "doctor.segment") return `${v.passed ? "SEGMENT" : "TORN"}     ${v.lines} line(s); ${v.runs} run(s), ${v.projected} projected, ${v.gaps} gap(s), ${v.incomplete} without end, ${v.torn} unparseable`;
  return `${v.passed ? "CONFORMS" : "VIOLATIONS"}  ${v.violations} violation(s); stdout ${v.lines.stdout}, stderr ${v.lines.stderr}, receipt ${v.lines.receipt} lines; run ${v.run ?? "-"}; status ${v.status ?? "-"}; ${v.partial} line(s) tool-owned or unvalidated`;
}

if (import.meta.main) {
  const a = process.argv.slice(2); const prose = a.includes("--human") || a.includes("--humanize");
  const arg = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const write = (v: object, s: NodeJS.WriteStream) => s.write(JSON.stringify(v) + "\n");
  try {
    const so = arg("--stdout"), se = arg("--stderr"), rc = arg("--receipt"), hi = arg("--history");
    if (hi) {
      const vs = inspectSegment(readFileSync(hi, "utf8"));
      for (const v of vs) process.stdout.write((prose ? human(v) : JSON.stringify(stamp(v))) + "\n");
      process.exit((vs[vs.length - 1] as SegmentSummary).passed ? 0 : 1);
    }
    if (!so && !se && !rc) { write({ event: "error", code: "doctor.usage", problem: "usage: doctor --stdout FILE [--stderr FILE] [--receipt FILE] [--human], doctor --receipt FILE [--human], or doctor --history SEGMENT.jsonl [--human]", _schema: OUTPUT_SCHEMA }, process.stderr); process.exit(2); }
    const input = { stdout: so ? readFileSync(so, "utf8") : undefined, stderr: se ? readFileSync(se, "utf8") : undefined, receipt: rc && existsSync(rc) ? readFileSync(rc, "utf8") : undefined, receiptPresent: rc ? existsSync(rc) : undefined };
    const vs = doctor(input);
    for (const v of vs) process.stdout.write((prose ? human(v) : JSON.stringify(stamp(v))) + "\n");
    process.exit((vs[vs.length - 1] as Summary).passed ? 0 : 1);
  } catch (e) { write({ event: "error", code: "doctor.crashed", problem: (e as Error).message, _schema: OUTPUT_SCHEMA }, process.stderr); process.exit(2); }
}
