// One run (spec §3): a single sequence across stdout, stderr and the receipt; the bootstrap line
// first, the head next, the `end` event last and immutable; every record's payload scrubbed of
// declared secrets before any copy leaves the process. The envelope is applied after scrubbing
// and is never scrubbed: the run id and the receipt path were chosen secret-free at startup.
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { computeInv, digestInput, sha256, type InputDecl, type InputDescriptor } from "./inv.ts";
import { scrub } from "./redact.ts";

export interface Sink { write(line: string): void }
export const SIDECAR_THRESHOLD = 65_536;
export const CODE = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;
const ENVELOPE_KEYS = ["t", "seq", "run", "_schema"] as const;
/**
 * Writer-owned string fields never scrubbed in a writer-built record: digests (a secret cannot
 * occur in one except by hex coincidence, and replacing it would corrupt the digest) and public
 * identity the tool declared and every discovery line prints regardless: the tool's name and
 * version, a command's name, a schema's id and version. Tool-supplied values that reach a
 * writer-built record (`resolved`, input descriptors) are scrubbed in full before it is built.
 */
const DIGEST_KEYS = new Set(["sha256", "inv", "tool", "v", "name", "id", "version"]);

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
}

type SinkName = "stdout" | "stderr" | "receipt";
interface Emit { to: { stdout?: boolean; stderr?: boolean; receipt?: boolean }; writer?: boolean; noSidecar?: boolean; deferFailures?: boolean }

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
  private deferred: { sink: SinkName; error: unknown }[] = [];
  private inputsSettled = false;
  private supplied = new Map<string, Uint8Array>();
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
      if (sink === "receipt") { if (!this.receiptOpen) return false; writeSync(this.init.receiptFd, text); }
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
        queueMicrotask(() => { try { if (!this.closed) this.warning({ code: "human.renderer_failed", problem: `the tool's --human renderer threw: ${msg}; the default rendering is used for the rest of the run`, remedy: "fix the renderer; the receipt is complete regardless" }); } catch { /* the run ended first */ } });
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

  /** Scrub a payload's values; `event` is envelope, named by the writer or the tool's schema, and is never a secret. */
  private scrubPayload(payload: Record_, found: string[], writer: boolean): Record_ {
    const { event, ...rest } = payload;
    const scrubbed = scrub(rest, this.init.secretValues, "", found, writer ? { skipKeys: DIGEST_KEYS, scalars: false } : {}) as Record_;
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
    const scrubbed = this.scrubPayload(payload, found, how.writer === true);
    const extraFound: string[] = [];
    const extra = receiptExtra ? this.scrubPayload(receiptExtra, extraFound, how.writer === true) : undefined;
    const at = this.next();
    const rec = this.envelope(scrubbed, schema, at);
    const human = this.init.human !== undefined;
    if (how.to.stdout) this.writeOrSkip("stdout", human ? this.prose(rec) : this.line(rec), how.deferFailures);
    if (how.to.stderr) this.writeOrSkip("stderr", human ? this.prose(rec) : this.line(rec), how.deferFailures);
    if (how.to.receipt) {
      const full = extra ? this.envelope({ ...scrubbed, ...extra, event: scrubbed.event }, schema, at) : rec;
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
    const rec: Record_ = { event: "run", tool: this.tool, v: this.v, ...(inv ? { inv } : {}), ...(this.session ? { session: this.session } : {}), paths: { receipt: this.receiptPath }, ...(this.dryRun ? { dry_run: true } : {}) };
    this.emit({ to: { stdout: true }, writer: true, deferFailures: true }, rec, SCHEMA_IDS.bootstrap);
  }

  /** Internal: the receipt head, receipt only, never a sidecar (§5). */
  head(fields: Record_): void { this.emit({ to: { receipt: true }, writer: true, noSidecar: true }, { event: "receipt.head", ...fields }, SCHEMA_IDS.head); }

  /** Internal: a discovery line (§4.1), a writer-built record describing public identity. */
  describe(record: Record_, schema: SchemaRef): number { return this.emit({ to: { stdout: true, receipt: true }, writer: true }, record, schema); }

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
  }

  /** Digest the declared inputs and emit `receipt.inputs` with `inv` once settled (§2.2). Idempotent; `end` calls it. */
  finaliseInputs(): InputDescriptor[] {
    if (this.inputsSettled || this.init.inputs.length === 0) { this.inputsSettled = true; return []; }
    this.inputsSettled = true;
    const raw = this.init.inputs.map((i) => digestInput(this.cwd, i, this.supplied.get(i.path)));
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
    this.finalStatus = okOut && okRec && closeOk ? s : 4;
    return this.finalStatus;
  }
}
