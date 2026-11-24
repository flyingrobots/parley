// One run (spec §3): a single sequence across stdout, stderr and the receipt; the bootstrap line
// first, the head next, the `end` event last and immutable; every record's payload scrubbed of
// declared secrets before any copy leaves the process. The envelope is applied after scrubbing
// and is never scrubbed: the run id and the receipt path were chosen secret-free at startup.
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { checkRecord } from "./check.ts";
import type { HistoryProjection, HistorySink } from "./history.ts";
import { canonical, computeInv, digestInput, sha256, type InputDecl, type InputDescriptor } from "./inv.ts";
import { carriesSecret, scrub } from "./redact.ts";
import { isHistoryRefusal, type HistoryRefusal } from "./refusal.ts";

export interface Sink { write(line: string): void }
export const SIDECAR_THRESHOLD = 65_536;
export const CODE = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;
const ENVELOPE_KEYS = ["t", "seq", "run", "_schema"] as const;
/**
 * Writer-owned string fields never scrubbed in a writer-built record: digests (a secret cannot
 * occur in one except by hex coincidence, and replacing it would corrupt the digest) and public
 * identity the tool declared and every discovery line prints regardless: the tool's name and
 * version, a command's name, a schema's id and version, and the `code` of a diagnostic the
 * writer itself raises, which is the writer's own stable identifier and not a value a caller
 * supplied — replacing part of it would put a line on the stream that no longer validates
 * against its schema, which is the one thing redaction must not do. A tool's own diagnostic is
 * not writer-built and its `code` is scrubbed like anything else. Tool-supplied values that
 * reach a writer-built record (`resolved`, input descriptors) are scrubbed in full before it is
 * built.
 */
export const DIGEST_KEYS = new Set(["sha256", "inv", "tool", "v", "name", "id", "version", "code"]);

export const SCHEMA_IDS = {
  bootstrap: { id: "parley.run.bootstrap", version: "1.1.1" },
  head: { id: "parley.receipt.head", version: "2.0.0" },
  step: { id: "parley.receipt.step", version: "1.0.0" },
  inputs: { id: "parley.receipt.inputs", version: "1.0.0" },
  error: { id: "parley.error", version: "2.0.0" },
  warning: { id: "parley.warning", version: "1.0.0" },
  end: { id: "parley.end", version: "1.0.0" },
  startupFailed: { id: "parley.startup.failed", version: "1.0.0" },
  sidecar: { id: "parley.sidecar", version: "1.0.0" },
  redaction: { id: "parley.redaction", version: "1.0.0" },
  command: { id: "parley.command", version: "1.0.0" },
  schema: { id: "parley.schema", version: "1.0.0" },
  page: { id: "parley.page", version: "1.0.0" },
  historyTransform: { id: "parley.history.transform", version: "1.0.0" },
} as const;

export type SchemaRef = { readonly id: string; readonly version: string };
export type Record_ = Record<string, unknown>;

export interface Diagnostic {
  code: string; problem: string; remedy?: string; remedy_target?: string;
  measured?: number; limit?: number; retryable?: boolean; detail?: unknown;
}

export class ParleyClosed extends Error {
  constructor() { super("the run has ended; nothing may follow end (spec §3.3)"); this.name = "ParleyClosed"; }
}

export interface RunInit {
  tool: string; v: string; id: string; session?: string; dryRun: boolean;
  stdout: Sink; stderr: Sink; receiptFd: number; receiptPath: string; receiptDir: string;
  secretValues: Set<string>; now: () => number; cwd: string;
  command: string; resolved: unknown; inputs: InputDecl[];
  headRedacted: boolean; human?: (line: Record_) => string | null;
  /** The shared history stream of §8, when one is configured: it receives the receipt's bytes. */
  history?: HistorySink;
  /** The projection applied to the stream copy, when a transform is configured (§8, informative). */
  projection?: HistoryProjection;
}

type SinkName = "stdout" | "stderr" | "receipt";
interface Emit { to: { stdout?: boolean; stderr?: boolean; receipt?: boolean }; writer?: boolean; noSidecar?: boolean; deferFailures?: boolean; verbatim?: string }

export class Run {
  readonly id: string; readonly tool: string; readonly v: string; readonly session?: string;
  readonly dryRun: boolean; readonly receiptPath: string; readonly receiptDir: string; readonly cwd: string;
  private seq = -1;
  private closed = false;
  private receiptOpen = true;
  private errorReported = false;
  private redactedAny: boolean;
  private failedSinks = new Set<SinkName>();
  private sidecarFailed = false;
  private historyFailed = false;
  private projectionSeq: number | null = null;
  private projectionWarning: Diagnostic | null = null;
  private withheldWarnings: Diagnostic[] = [];
  private projecting = 0;
  private flushingWithheld = false;
  private withheld = 0;
  private deferred: { sink: SinkName; error: unknown }[] = [];
  private inputsSettled = false;
  private supplied = new Map<string, Uint8Array>();
  private unread = new Map<string, string>();
  private finalStatus: number | null = null;
  private readonly init: RunInit;

  constructor(init: RunInit) {
    this.init = init;
    this.id = init.id; this.tool = init.tool; this.v = init.v; this.session = init.session;
    this.dryRun = init.dryRun; this.receiptPath = init.receiptPath; this.receiptDir = init.receiptDir; this.cwd = init.cwd;
    this.redactedAny = init.headRedacted;
  }

  /** True once `end` has been emitted. */
  get ended(): boolean { return this.closed; }
  /** The exit status `end` carried, once ended. */
  get status(): number | null { return this.finalStatus; }
  /** True when any stream, the receipt or a sidecar could not be written: the run closes with 4. */
  get sinkFailed(): boolean { return this.failedSinks.size > 0 || this.sidecarFailed; }

  // ---- emission -------------------------------------------------------------------------

  private next(): { seq: number; t: number } { this.seq += 1; return { seq: this.seq, t: this.init.now() }; }

  private envelope(payload: Record_, schema: SchemaRef, at: { seq: number; t: number }): Record_ {
    const { event, ...rest } = payload;
    return { event, t: at.t, seq: at.seq, run: this.id, ...rest, _schema: { id: schema.id, version: schema.version } };
  }

  private refuseEnvelopeKeys(obj: Record_ | undefined, what: string): void {
    if (!obj) return;
    for (const k of ENVELOPE_KEYS) if (k in obj) throw new TypeError(`${what} must not carry ${k}; the writer owns the envelope (spec §1.3)`);
  }

  private write(sink: SinkName, text: string, defer = false): boolean {
    if (this.failedSinks.has(sink)) return false;
    try {
      if (sink === "receipt") {
        if (!this.receiptOpen) return false;
        writeSync(this.init.receiptFd, text);
        this.mirrorToHistory(text);
      }
      else this.init[sink].write(text);
      return true;
    } catch (e) {
      this.failedSinks.add(sink);
      if (defer) this.deferred.push({ sink, error: e });
      else if (!this.closed) this.reportSinkFailure(sink, e);
      return false;
    }
  }

  /** An empty prose rendering means "say nothing here"; a write of nothing is not a sink failure. */
  private writeOrSkip(sink: "stdout" | "stderr", text: string, defer = false): boolean { return text === "" ? true : this.write(sink, text, defer); }

  private reportSinkFailure(sink: string, e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    this.emit({ to: { stderr: sink !== "stderr", receipt: sink !== "receipt" }, writer: true }, { event: "error", code: sink === "sidecar" ? "sink.sidecar_failed" : "sink.write_failed", problem: `writing to ${sink} failed: ${msg}`, remedy: "the run will close with status 4; whatever other sinks received is preserved" }, SCHEMA_IDS.error);
  }

  /**
   * The shared history stream (§8) gets the receipt's bytes, after they are in the receipt: the
   * same line, so a declared secret cannot reach it that did not reach the receipt. It is an
   * opt-in extra and the dependency runs one way, so a failure is one `warning` and nothing
   * else: not an error, not a sink failure, no change to the exit status. The stream is dropped
   * at the first failure, so a broken stream is reported once and the run carries on.
   *
   * With a transform configured the stream copy is a projection of those bytes rather than the
   * bytes themselves, and the writer enforces the contract around it: see `project`. Withholding
   * leaves a `seq` gap on the stream and nowhere else.
   */
  private mirrorToHistory(text: string): void {
    const h = this.init.history;
    if (h === undefined || this.historyFailed) return;
    const p = this.init.projection;
    let line: string | null = text;
    if (p !== undefined) {
      this.projecting += 1;
      try { line = this.project(text, p); } finally { this.projecting -= 1; }
    }
    if (line !== null) this.appendToHistory(h, line);
    if (this.projecting === 0) this.flushWithheld();
  }

  private appendToHistory(h: HistorySink, line: string): void {
    try { h.append(line); } catch (e) {
      this.historyFailed = true;
      try { h.close(); } catch { /* already closed */ }
      if (this.closed) return;
      const msg = e instanceof Error ? e.message : String(e);
      try {
        this.writerWarning({ code: "history.write_failed", problem: `appending to the shared history stream at ${h.path} failed: ${msg}; the receipt is unaffected and the rest of this run is not in the stream`, remedy: `free space or fix permissions on ${h.dir}, or set PARLEY_HISTORY=off; the receipt is the record and the stream is a convenience` });
      } catch { /* the run ended between the write and the warning */ }
    }
  }

  /**
   * One receipt line through the configured transform, with the four rules the writer enforces
   * around it (flyingrobots#57). Returns the line to append, or `null` to withhold it.
   *
   *   1. The transform is handed the parsed record the receipt already holds, so it sees the
   *      redacted payload of §5.3 and never the raw one.
   *   2. Nothing is the transform's envelope to change: `event`, `t`, `seq`, `run` and `_schema`
   *      are taken off whatever it returns and the receipt line's are put back, so the two
   *      copies of one event agree on all five (§1.3).
   *   3. The returned body is re-validated against the schema for its **exact** advertised pair
   *      (§4.5) and withheld when it no longer validates. A pair no schema document is held for
   *      cannot be re-validated, so it is withheld too: an unchecked projection is never passed
   *      off as a checked one.
   *   4. Anything that goes wrong withholds the line and warns, naming the `seq`; a warning is
   *      never an error and never changes the exit status (§6.1).
   */
  private project(text: string, p: HistoryProjection): string | null {
    let rec: Record_;
    try { rec = JSON.parse(text) as Record_; } catch { return null; }
    const seq = typeof rec.seq === "number" ? rec.seq : -1;
    // Nothing from here may escape. This runs inside the receipt's own write, so a throw that got
    // out would be reported as a receipt sink failure and close the run with status 4 — the stream
    // failing the run it is an optional observer of, which §8 forbids. A record that cannot be
    // serialised (a cycle, a BigInt) is withheld like any other failure.
    try { return this.projectOne(rec, seq, p); }
    catch (e) {
      const msg = e instanceof Error ? e.message || e.name : String(e);
      this.withhold({ code: "history.transform_failed", problem: `the projection of seq ${seq} by ${p.name} could not be completed: ${msg}; that line is not on the shared stream and the receipt is unaffected`, remedy: "return a record that serialises as JSON: no cycles, no bigint, nothing the receipt line did not already carry" });
      return null;
    }
  }

  private projectOne(rec: Record_, seq: number, p: HistoryProjection): string | null {
    const stamp = rec._schema as { id?: unknown; version?: unknown } | undefined;
    const pair = `${typeof stamp?.id === "string" ? stamp.id : "?"}@${typeof stamp?.version === "string" ? stamp.version : "?"}`;
    // The envelope is taken before the transform runs, not read back off the record afterwards: a
    // transform that mutates the record it was handed and returns it would otherwise hand back its
    // own envelope, and the receipt line's is the only one that may stand (§1.3).
    const envelope = { event: rec.event, t: rec.t, seq: rec.seq, run: rec.run, _schema: { id: stamp?.id, version: stamp?.version } };
    let returned: unknown;
    try { returned = p.fn(rec); } catch (e) {
      const msg = e instanceof Error ? e.message || e.name : String(e);
      this.withhold({ code: "history.transform_failed", problem: `the history transform ${p.name} threw on seq ${seq}: ${msg}; that line is not on the shared stream and the receipt is unaffected`, remedy: "fix the transform or remove it; the stream copy has a gap at that seq and names the projection on its opening line" });
      return null;
    }
    // Nothing returned is the configured way to withhold a line: a gap, not a defect.
    if (returned === undefined || returned === null) return null;
    // A refusal is the transform withholding the line *and saying why* (flyingrobots#60). The
    // code is the transform's; the envelope, the exit status and the promise that no declared
    // secret leaves this way are still the writer's.
    if (isHistoryRefusal(returned)) { this.refused(returned, seq, p); return null; }
    if (typeof returned !== "object" || Array.isArray(returned)) {
      this.withhold({ code: "history.transform_invalid", problem: `the history transform ${p.name} returned ${Array.isArray(returned) ? "an array" : typeof returned} for seq ${seq}, which is neither a record nor nothing; that line is not on the shared stream`, remedy: "return the record, a projection of it, or nothing to withhold the line" });
      return null;
    }
    const { event: _event, t: _t, seq: _seq, run: _run, _schema: _stamp, ...body } = returned as Record_;
    if (this.init.secretValues.size > 0 && carriesSecret(JSON.stringify(body), this.init.secretValues)) {
      this.withhold({ code: "history.transform_unredacted", problem: `the history transform ${p.name} returned a body for seq ${seq} carrying a declared secret value the writer had already replaced; that line is not on the shared stream`, remedy: "a transform narrows a record; it never restores a value §5.3 replaced" });
      return null;
    }
    const doc = p.schemas.get(pair);
    if (doc === undefined) {
      this.withhold({ code: "history.transform_uncheckable", problem: `seq ${seq} advertises ${pair}, which this writer holds no schema document for, so the projection by ${p.name} could not be re-validated and that line is not on the shared stream`, remedy: "declare the schema on the command's emitted type (spec §4.2) so a projection of it can be checked, or remove the transform" });
      return null;
    }
    const out: Record_ = { event: envelope.event, t: envelope.t, seq: envelope.seq, run: envelope.run, ...body, _schema: envelope._schema };
    const verdict = checkRecord(out, doc);
    if (!verdict.ok) {
      if ("unsupported" in verdict) {
        this.withhold({ code: "history.transform_uncheckable", problem: `the schema for ${pair} uses ${verdict.unsupported}, which this writer's re-validation does not implement, so the projection of seq ${seq} by ${p.name} could not be checked and that line is not on the shared stream`, remedy: "state the type's schema within the subset the writer can check, or remove the transform" });
        return null;
      }
      this.withhold({ code: "history.transform_invalid", problem: `the body the history transform ${p.name} returned for seq ${seq} no longer validates against ${pair}: ${verdict.errors.slice(0, 3).join("; ")}; that line is not on the shared stream`, remedy: "project within the message's schema, or withhold the line by returning nothing" });
      return null;
    }
    return JSON.stringify(out) + "\n";
  }

  /**
   * A line the transform refused, reported under the transform's own `code` (flyingrobots#60).
   * Two things are checked first, because a warning's `code` is the one string the writer does
   * not scrub (§5.3) and an unusable one would be a withheld line with no warning at all:
   *
   *   - A `code` that is not spec §6's shape, a `problem` that is empty, or either of them not a
   *     string at all, is the transform being broken, which is `history.transform_failed` like
   *     any other way of being broken. A `remedy` that is not a string is dropped rather than
   *     emitted, because a `warning` whose `remedy` is a number does not validate (§4.5) and the
   *     stream is not the only copy: stderr and the receipt have no re-validation behind them.
   *   - A `code` carrying a declared secret value would disclose it on stderr and in the
   *     receipt, so the refusal is itself refused: `history.transform_unredacted`, the same code
   *     a body that restored a replaced value gets. The `problem` and `remedy` are scrubbed like
   *     any other tool-supplied string, so they need no check of their own.
   */
  private refused(r: HistoryRefusal, seq: number, p: HistoryProjection): void {
    if (typeof r.code !== "string" || typeof r.problem !== "string" || !CODE.test(r.code) || !r.problem) {
      this.withhold({ code: "history.transform_failed", problem: `the history transform ${p.name} refused seq ${seq} with ${JSON.stringify(r.code)} and ${JSON.stringify(r.problem)}, which are not a code of two or more dot-separated lowercase segments and a non-empty problem; that line is not on the shared stream and the refusal could not be reported under its own code`, remedy: "build the refusal with refuse(code, problem), which checks both at the point they are written (spec §6)" });
      return;
    }
    if (this.init.secretValues.size > 0 && carriesSecret(r.code, this.init.secretValues)) {
      this.withhold({ code: "history.transform_unredacted", problem: `the history transform ${p.name} refused seq ${seq} under a code carrying a declared secret value; a diagnostic's code is never scrubbed, so neither that line nor that refusal's code reaches any stream`, remedy: "refuse under a code the transform chose, not one built from a value it was handed (spec §5.3)" });
      return;
    }
    this.withhold({ code: r.code, problem: r.problem, ...(typeof r.remedy === "string" ? { remedy: r.remedy } : {}) });
  }

  /**
   * A withheld line, held until the current mirror is finished: the warning is itself a record,
   * and a record goes through the transform too. A projection that fails on a warning line
   * withholds it and does not warn again, so one failure cannot generate another for ever; the
   * stream's gaps, not the warning count, are the ground truth for what it is missing.
   */
  private withhold(d: Diagnostic): void {
    this.withheld += 1;
    if (this.flushingWithheld || this.closed) return;
    this.withheldWarnings.push(d);
  }

  private flushWithheld(): void {
    if (this.flushingWithheld || this.withheldWarnings.length === 0) return;
    this.flushingWithheld = true;
    try {
      while (this.withheldWarnings.length > 0 && !this.closed) {
        const d = this.withheldWarnings.shift()!;
        try { this.writerWarning(d); } catch { /* the run ended between the withhold and the warning */ }
      }
      this.withheldWarnings = [];
    } finally { this.flushingWithheld = false; }
  }

  /** How many lines the configured transform kept off the stream, warnings about them included. */
  get withheldFromHistory(): number { return this.withheld; }

  /** Internal: report sink failures held back during the bootstrap write, now that the head is in place (§5: the head is the receipt's first line). */
  flushDeferredFailures(): void {
    const held = this.deferred; this.deferred = [];
    for (const { sink, error } of held) if (!this.closed) this.reportSinkFailure(sink, error);
  }

  private line(obj: Record_): string { return JSON.stringify(obj) + "\n"; }

  private rendererFailed = false;

  private prose(obj: Record_): string {
    let custom: string | null = null;
    try { custom = this.init.human?.(obj) ?? null; } catch (e) {
      custom = null;
      if (!this.rendererFailed && !this.closed) {
        this.rendererFailed = true;
        const msg = e instanceof Error ? e.message : String(e);
        queueMicrotask(() => { try { if (!this.closed) this.writerWarning({ code: "human.renderer_failed", problem: `the tool's --human renderer threw: ${msg}; the default rendering is used for the rest of the run`, remedy: "fix the renderer; the receipt is complete regardless" }); } catch { /* the run ended first */ } });
      }
    }
    if (typeof custom === "string") return custom.endsWith("\n") ? custom : custom + "\n";
    switch (obj.event) {
      // Prose is for a person or a pipe into something like a pull-request comment; the bootstrap
      // line and a successful end say nothing there, so the tool's rendering stands alone. The
      // receipt still carries both.
      case "run": return "";
      case "end": return obj.status === 0 ? "" : `end: status ${String(obj.status)}${obj.redacted ? ", receipt redacted" : ""}; receipt at ${String(obj.receipt)}\n`;
      case "error": case "warning": return `${String(obj.event)} ${String(obj.code)}: ${String(obj.problem)}${obj.remedy ? ` (${String(obj.remedy)})` : ""}\n`;
      default: return `${String(obj.event)}: ${JSON.stringify(obj)}\n`;
    }
  }

  /**
   * Scrub a payload's values. `event` is envelope, named by the writer or the tool's schema, and is
   * never a secret. For a writer-built record, the one field named by `verbatim` is left as it is:
   * the schema document of a `schema` line, a static declaration a secret cannot reach (§5.3,
   * flyingrobots/parley#111).
   */
  private scrubPayload(payload: Record_, found: string[], writer: boolean, verbatim?: string): Record_ {
    const { event, ...all } = payload;
    const rest: Record_ = { ...all };
    if (verbatim !== undefined) delete rest[verbatim];
    let scrubbed = scrub(rest, this.init.secretValues, "", found, writer ? { skipKeys: DIGEST_KEYS, scalars: false } : {}) as Record_;
    if (verbatim !== undefined && verbatim in all) scrubbed = { ...scrubbed, [verbatim]: all[verbatim] };
    return event === undefined ? scrubbed : { event, ...scrubbed };
  }

  /**
   * Emit one event to the named streams as copies sharing seq, t and event. The receipt copy may
   * carry `receiptExtra` fields the stream copy omits (§1.3). Returns the event's seq.
   */
  private emit(how: Emit, payload: Record_, schema: SchemaRef, receiptExtra?: Record_): number {
    if (this.closed) throw new ParleyClosed();
    this.refuseEnvelopeKeys(payload, "a record"); this.refuseEnvelopeKeys(receiptExtra, "receiptExtra");
    const found: string[] = [];
    const scrubbed = this.scrubPayload(payload, found, how.writer === true, how.writer === true ? how.verbatim : undefined);
    const extraFound: string[] = [];
    const extra = receiptExtra ? this.scrubPayload(receiptExtra, extraFound, how.writer === true) : undefined;
    // The copies of one event agree on every field they share (§1.3): compared as scrubbed, since
    // that is what is written, and before a seq is taken, so a refusal leaves no gap.
    if (extra) for (const k of Object.keys(extra)) {
      if (k in scrubbed && canonical(extra[k]) !== canonical(scrubbed[k])) throw new TypeError(`receiptExtra.${k} differs from the record's ${k}; the copies of an event must agree on every field they share (spec §1.3)`);
    }
    const at = this.next();
    const rec = this.envelope(scrubbed, schema, at);
    const human = this.init.human !== undefined;
    if (how.to.stdout) this.writeOrSkip("stdout", human ? this.prose(rec) : this.line(rec), how.deferFailures);
    if (how.to.stderr) this.writeOrSkip("stderr", human ? this.prose(rec) : this.line(rec), how.deferFailures);
    if (how.to.receipt) {
      // A shared field is written from the payload, so the copies agree byte for byte on it.
      const full = extra ? this.envelope({ ...scrubbed, ...Object.fromEntries(Object.entries(extra).filter(([k]) => !(k in scrubbed))) }, schema, at) : rec;
      const text = JSON.stringify(full);
      if (!how.noSidecar && Buffer.byteLength(text, "utf8") > SIDECAR_THRESHOLD) this.sidecar(at.seq, text);
      else this.write("receipt", text + "\n");
    }
    for (const at_ of [...found, ...extraFound]) this.redaction(at.seq, at_);
    return at.seq;
  }

  private sidecar(source: number, text: string) {
    const rel = `${this.id}/${source}.json`;
    const bytes = Buffer.from(text, "utf8");
    try {
      mkdirSync(join(this.receiptDir, this.id), { recursive: true });
      const fd = openSync(join(this.receiptDir, rel), "wx");
      try { writeSync(fd, bytes); } finally { closeSync(fd); }
    } catch (e) {
      // The receipt file itself is fine: keep the record inline so the bundle stays complete (§5),
      // then say what failed; the run still closes with 4 because a write failed (§5.4).
      this.sidecarFailed = true;
      this.write("receipt", text + "\n");
      this.reportSinkFailure("sidecar", e);
      return;
    }
    const at = this.next();
    this.write("receipt", this.line(this.envelope({ event: "sidecar", source, path: rel, bytes: bytes.length, sha256: sha256(bytes) }, SCHEMA_IDS.sidecar, at)));
  }

  private redaction(inSeq: number, at: string) {
    this.redactedAny = true;
    const a = this.next();
    this.write("receipt", this.line(this.envelope({ event: "redaction", in: inSeq, at }, SCHEMA_IDS.redaction, a)));
  }

  // ---- the public surface --------------------------------------------------------------

  /** Internal: the bootstrap line, stdout only, seq 0 (§3.1). A stdout failure here is reported after the head. */
  bootstrap(inv: string | undefined): void {
    // `paths` is open and the protocol defines only `receipt`; `history` is documented by this
    // writer and is present only when a stream is configured (spec §3.1, §8).
    const paths: Record_ = { receipt: this.receiptPath, ...(this.init.history ? { history: this.init.history.path } : {}) };
    const rec: Record_ = { event: "run", tool: this.tool, v: this.v, ...(inv ? { inv } : {}), ...(this.session ? { session: this.session } : {}), paths, ...(this.dryRun ? { dry_run: true } : {}) };
    this.emit({ to: { stdout: true }, writer: true, deferFailures: true }, rec, SCHEMA_IDS.bootstrap);
  }

  /**
   * Internal: the opening line of a projected stream copy (§8), stream only and before the head,
   * so a reader of the shared timeline meets the projection before any projected line of the run.
   * It takes a `seq` of its own and reaches no other sink, which is why the receipt has no line
   * at that `seq`; `noteProjection` records that in the receipt once the head is in place. A
   * failure to append it is held back for the same reason the bootstrap line's is.
   */
  declareProjection(): void {
    const h = this.init.history, p = this.init.projection;
    if (h === undefined || p === undefined || this.historyFailed) return;
    const at = this.next();
    this.projectionSeq = at.seq;
    const rec = this.envelope(this.scrubPayload({ event: "history.transform", name: p.name, sha256: p.sha256 }, [], true), SCHEMA_IDS.historyTransform, at);
    try { h.append(JSON.stringify(rec) + "\n"); }
    catch (e) {
      this.historyFailed = true;
      this.projectionSeq = null;
      try { h.close(); } catch { /* already closed */ }
      const msg = e instanceof Error ? e.message : String(e);
      this.projectionWarning = { code: "history.write_failed", problem: `appending the projection's opening line to the shared history stream at ${h.path} failed: ${msg}; this run is not in the stream and the receipt is unaffected`, remedy: `free space or fix permissions on ${h.dir}, or set PARLEY_HISTORY=off; the receipt is the record and the stream is a convenience` };
    }
  }

  /** Internal: after the head, the warning the opening line could not raise, and the decision that accounts for the `seq` it took (§5). */
  noteProjection(): void {
    const p = this.init.projection;
    if (p === undefined) return;
    if (this.projectionWarning !== null) { const d = this.projectionWarning; this.projectionWarning = null; this.writerWarning(d); }
    if (this.projectionSeq === null) return;
    this.step(`the shared stream's copy of this run is a projection by ${p.name}`, `a history transform is configured, so the stream copy is narrowed and says so: seq ${this.projectionSeq} is its parley.history.transform line, which reaches the stream alone and is why this receipt has no line at that seq. The transform's source digests to ${p.sha256}. The receipt is never projected (§8, informative)`);
  }

  /** Internal: the receipt head, receipt only, never a sidecar (§5). */
  head(fields: Record_): void { this.emit({ to: { receipt: true }, writer: true, noSidecar: true }, { event: "receipt.head", ...fields }, SCHEMA_IDS.head); }

  /** Internal: a discovery line (§4.1), a writer-built record describing public identity. */
  describe(record: Record_, schema: SchemaRef, verbatim?: string): number { return this.emit({ to: { stdout: true, receipt: true }, writer: true, ...(verbatim !== undefined ? { verbatim } : {}) }, record, schema); }

  /** A result: to stdout and the receipt. `receiptExtra` goes to the receipt copy only. */
  result(record: Record_, schema: SchemaRef, receiptExtra?: Record_): number {
    if (typeof record.event !== "string" || !record.event) throw new TypeError("a result needs an event name");
    return this.emit({ to: { stdout: true, receipt: true } }, record, schema, receiptExtra);
  }

  /** One page of unbounded output (§7.2); rows belong in `receiptExtra` or in the stream copy as the tool documents. */
  page(cursor: string | null, hasMore: boolean, record: Record_ = {}, receiptExtra?: Record_): number {
    if (hasMore && !cursor) throw new TypeError("a page with has_more needs a cursor (spec §7.2)");
    return this.emit({ to: { stdout: true, receipt: true } }, { event: "page", ...record, ...(cursor ? { cursor } : {}), has_more: hasMore }, SCHEMA_IDS.page, receiptExtra);
  }

  /** One decision and why, receipt only (§5). */
  step(decision: string, because: string, detail?: unknown): number {
    return this.emit({ to: { receipt: true } }, { event: "receipt.step", decision, because, ...(detail === undefined ? {} : { detail }) }, SCHEMA_IDS.step);
  }

  warning(d: Diagnostic): number { return this.emit({ to: { stderr: true, receipt: true } }, { event: "warning", ...this.diagnostic(d) }, SCHEMA_IDS.warning); }

  /**
   * Internal: a warning the writer itself raises, such as a relocated receipt or an unusable
   * history stream. Its `code` is the writer's own identifier, so it is not scrubbed; the
   * `problem` and `remedy`, which carry paths, are.
   */
  writerWarning(d: Diagnostic): number { return this.emit({ to: { stderr: true, receipt: true }, writer: true }, { event: "warning", ...this.diagnostic(d) }, SCHEMA_IDS.warning); }

  /** A structured error (§6). The run then closes with status 2 unless `end` is given another non-zero status. `receiptExtra` goes to the receipt copy only. */
  error(d: Diagnostic, receiptExtra?: Record_): number {
    this.errorReported = true;
    return this.emit({ to: { stderr: true, receipt: true } }, { event: "error", ...this.diagnostic(d) }, SCHEMA_IDS.error, receiptExtra);
  }

  private diagnostic(d: Diagnostic): Record_ {
    if (!CODE.test(d.code)) throw new TypeError(`code ${JSON.stringify(d.code)} is not two or more dot-separated lowercase segments (spec §6)`);
    if (!d.problem) throw new TypeError("problem is never empty (spec §6)");
    const out: Record_ = { code: d.code, problem: d.problem };
    for (const k of ["remedy", "remedy_target", "measured", "limit", "retryable", "detail"] as const) if (d[k] !== undefined) out[k] = d[k];
    return out;
  }

  /** Supply the bytes of a declared input the writer cannot read itself, such as stdin. */
  input(path: string, bytes: Uint8Array | string): void {
    this.supplied.set(path, typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes);
    this.unread.delete(path);
  }

  /**
   * Say that the program could not read a declared input, so the writer records it with `error`
   * and no digest, and omits `inv`, rather than reading the path itself at finalisation and
   * digesting bytes the program never saw (§2.2, flyingrobots/parley#110). Refused for a path
   * that is not a declared input, and once the inputs are settled.
   */
  inputUnreadable(path: string, code = "input.unreadable"): void {
    if (this.closed) throw new ParleyClosed();
    if (this.inputsSettled) throw new TypeError("the inputs are already settled; call inputUnreadable before finaliseInputs or end (spec §2.2)");
    if (!this.init.inputs.some((i) => i.path === path)) throw new TypeError(`${JSON.stringify(path)} is not a declared input of this run`);
    if (!CODE.test(code)) throw new TypeError(`code ${JSON.stringify(code)} is not two or more dot-separated lowercase segments (spec §6)`);
    this.supplied.delete(path);
    this.unread.set(path, code);
  }

  /** Digest the declared inputs and emit `receipt.inputs` with `inv` once settled (§2.2). Idempotent; `end` calls it. */
  finaliseInputs(): InputDescriptor[] {
    if (this.inputsSettled || this.init.inputs.length === 0) { this.inputsSettled = true; return []; }
    this.inputsSettled = true;
    const raw = this.init.inputs.map((i): InputDescriptor => {
      const code = this.unread.get(i.path);
      return code === undefined ? digestInput(this.cwd, i, this.supplied.get(i.path)) : { path: i.path, ...(i.role ? { role: i.role } : {}), error: code };
    });
    // The preimage and the record both take the redacted descriptors (§2.2: no secret value in inv).
    const inputs = scrub(raw, this.init.secretValues, "", [], { skipKeys: DIGEST_KEYS, scalars: false }) as InputDescriptor[];
    const inv = computeInv({ tool: this.tool, v: this.v, command: this.init.command, resolved: this.init.resolved, inputs });
    this.emit({ to: { receipt: true }, writer: true }, { event: "receipt.inputs", inputs, ...(inv ? { inv } : {}) }, SCHEMA_IDS.inputs);
    return inputs;
  }

  /**
   * Close the run (§3.3). Status defaults to 2 when an error was reported, else 0; a sink failure
   * forces 4. Returns the exit status the process should exit with.
   */
  end(status?: number): number {
    if (this.closed) return this.finalStatus ?? 4;
    if (status !== undefined && (!Number.isInteger(status) || status < 0 || status > 255 || status === 3)) throw new TypeError("end status is an integer 0-255 other than 3 (spec §3.4)");
    if (status === 0 && this.errorReported) throw new TypeError("a run that reported an error cannot end with status 0 (spec §3.4); a recovered condition is a warning");
    try { this.finaliseInputs(); } catch { /* an unreadable input is already recorded; nothing else can fail here */ }
    let s = status ?? (this.errorReported ? 2 : 0);
    if (this.sinkFailed) s = 4;
    const at = this.next();
    const rec = this.envelope(this.scrubPayload({ event: "end", status: s, receipt: this.receiptPath, redacted: this.redactedAny }, [], true), SCHEMA_IDS.end, at);
    this.closed = true;
    const okOut = this.writeOrSkip("stdout", this.init.human ? this.prose(rec) : this.line(rec));
    const okRec = this.write("receipt", this.line(rec));
    this.receiptOpen = false;
    let closeOk = true;
    try { closeSync(this.init.receiptFd); } catch { closeOk = false; }
    // The stream is not the record: closing it cannot change the status (§8 is informative).
    try { this.init.history?.close(); } catch { /* the stream was already gone */ }
    this.finalStatus = okOut && okRec && closeOk ? s : 4;
    return this.finalStatus;
  }
}
