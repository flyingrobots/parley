// One run (spec §3): a single sequence across stdout, stderr and the receipt; the bootstrap line
// first, the head next, the `end` event last and immutable; every record scrubbed of declared
// secrets before any copy leaves the process.
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { computeInv, digestInput, sha256, type InputDescriptor } from "./inv.ts";
import { REDACTED, scrub } from "./redact.ts";

export interface Sink { write(line: string): void }
export const SIDECAR_THRESHOLD = 65_536;
export const CODE = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;

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
  command: string; resolved: unknown; inputs: { path: string; role?: string }[];
  headRedacted: boolean; human?: (line: Record_) => string | null;
}

export class Run {
  readonly id: string; readonly tool: string; readonly v: string; readonly session?: string;
  readonly dryRun: boolean; readonly receiptPath: string; readonly receiptDir: string; readonly cwd: string;
  private seq = -1;
  private closed = false;
  private receiptOpen = true;
  private errorReported = false;
  private redactedAny: boolean;
  private failedSinks = new Set<"stdout" | "stderr" | "receipt">();
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
  get sinkFailed(): boolean { return this.failedSinks.size > 0; }

  // ---- emission -------------------------------------------------------------------------

  private next(): { seq: number; t: number } { this.seq += 1; return { seq: this.seq, t: this.init.now() }; }

  private envelope(record: Record_, schema: SchemaRef, at: { seq: number; t: number }): Record_ {
    const { event, ...rest } = record;
    return { event, t: at.t, seq: at.seq, run: this.id, ...rest, _schema: { id: schema.id, version: schema.version } };
  }

  private write(sink: "stdout" | "stderr" | "receipt", text: string): boolean {
    if (this.failedSinks.has(sink)) return false;
    try {
      if (sink === "receipt") { if (!this.receiptOpen) return false; writeSync(this.init.receiptFd, text); }
      else this.init[sink].write(text);
      return true;
    } catch (e) {
      this.failedSinks.add(sink);
      if (!this.closed) this.reportSinkFailure(sink, e);
      return false;
    }
  }

  private reportSinkFailure(sink: string, e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    this.emit({ stderr: sink !== "stderr", receipt: sink !== "receipt" }, { event: "error", code: "sink.write_failed", problem: `writing to ${sink} failed: ${msg}`, remedy: "the run will close with status 4; whatever other sinks received is preserved" }, SCHEMA_IDS.error);
  }

  private line(obj: Record_): string { return JSON.stringify(obj) + "\n"; }

  private prose(obj: Record_): string {
    const custom = this.init.human?.(obj);
    if (typeof custom === "string") return custom.endsWith("\n") ? custom : custom + "\n";
    switch (obj.event) {
      case "run": return `run ${this.id}: receipt at ${String((obj.paths as { receipt: string }).receipt)}\n`;
      case "end": return `end: status ${String(obj.status)}${obj.redacted ? ", receipt redacted" : ""}\n`;
      case "error": case "warning": return `${String(obj.event)} ${String(obj.code)}: ${String(obj.problem)}${obj.remedy ? ` (${String(obj.remedy)})` : ""}\n`;
      default: return `${String(obj.event)}: ${JSON.stringify(obj)}\n`;
    }
  }

  /**
   * Emit one event to the named streams as copies sharing seq, t and event. The receipt copy may
   * carry `receiptExtra` fields the stream copy omits (§1.3). Returns the event's seq.
   */
  private emit(to: { stdout?: boolean; stderr?: boolean; receipt?: boolean }, record: Record_, schema: SchemaRef, receiptExtra?: Record_): number {
    if (this.closed) throw new ParleyClosed();
    const at = this.next();
    const found: string[] = [];
    const scrubbed = scrub(this.envelope(record, schema, at), this.init.secretValues, "", found) as Record_;
    const extraFound: string[] = [];
    const extra = receiptExtra ? (scrub(receiptExtra, this.init.secretValues, "", extraFound) as Record_) : undefined;
    const human = this.init.human !== undefined;
    if (to.stdout) this.write("stdout", human ? this.prose(scrubbed) : this.line(scrubbed));
    if (to.stderr) this.write("stderr", human ? this.prose(scrubbed) : this.line(scrubbed));
    if (to.receipt) {
      const full = extra ? { ...scrubbed, ...extra, _schema: scrubbed._schema } : scrubbed;
      const text = JSON.stringify(full);
      if (Buffer.byteLength(text, "utf8") > SIDECAR_THRESHOLD) this.sidecar(at.seq, text);
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
      this.failedSinks.add("receipt");
      if (!this.closed) this.reportSinkFailure("receipt", e);
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

  /** Internal: the bootstrap line, stdout only, seq 0 (§3.1). */
  bootstrap(inv: string | undefined): void {
    const rec: Record_ = { event: "run", tool: this.tool, v: this.v, ...(inv ? { inv } : {}), run: this.id, ...(this.session ? { session: this.session } : {}), paths: { receipt: this.receiptPath }, ...(this.dryRun ? { dry_run: true } : {}) };
    this.emit({ stdout: true }, rec, SCHEMA_IDS.bootstrap);
  }

  /** Internal: the receipt head, receipt only (§5). */
  head(fields: Record_): void { this.emit({ receipt: true }, { event: "receipt.head", ...fields }, SCHEMA_IDS.head); }

  /** A result: to stdout and the receipt. `receiptExtra` goes to the receipt copy only. */
  result(record: Record_, schema: SchemaRef, receiptExtra?: Record_): number {
    if (typeof record.event !== "string" || !record.event) throw new TypeError("a result needs an event name");
    return this.emit({ stdout: true, receipt: true }, record, schema, receiptExtra);
  }

  /** One page of unbounded output (§7.2); rows belong in `receiptExtra` or in the stream copy as the tool documents. */
  page(cursor: string | null, hasMore: boolean, record: Record_ = {}, receiptExtra?: Record_): number {
    if (hasMore && !cursor) throw new TypeError("a page with has_more needs a cursor");
    return this.emit({ stdout: true, receipt: true }, { event: "page", ...record, ...(cursor ? { cursor } : {}), has_more: hasMore }, SCHEMA_IDS.page, receiptExtra);
  }

  /** One decision and why, receipt only (§5). */
  step(decision: string, because: string, detail?: unknown): number {
    return this.emit({ receipt: true }, { event: "receipt.step", decision, because, ...(detail === undefined ? {} : { detail }) }, SCHEMA_IDS.step);
  }

  warning(d: Diagnostic): number { return this.emit({ stderr: true, receipt: true }, { event: "warning", ...this.diagnostic(d) }, SCHEMA_IDS.warning); }

  /** A structured error (§6). The run then closes with status 2 unless `end` is given another. */
  error(d: Diagnostic): number {
    this.errorReported = true;
    return this.emit({ stderr: true, receipt: true }, { event: "error", ...this.diagnostic(d) }, SCHEMA_IDS.error);
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
    const inputs = this.init.inputs.map((i) => digestInput(this.cwd, i, this.supplied.get(i.path)));
    const inv = computeInv({ tool: this.tool, v: this.v, command: this.init.command, resolved: this.init.resolved, inputs });
    this.emit({ receipt: true }, { event: "receipt.inputs", inputs, ...(inv ? { inv } : {}) }, SCHEMA_IDS.inputs);
    return inputs;
  }

  /**
   * Close the run (§3.3). Status defaults to 2 when an error was reported, else 0; a sink failure
   * forces 4. Returns the exit status the process should exit with.
   */
  end(status?: number): number {
    if (this.closed) return this.finalStatus ?? 4;
    if (status !== undefined && (!Number.isInteger(status) || status < 0 || status > 255 || status === 3)) throw new TypeError("end status is an integer 0-255 other than 3 (spec §3.4)");
    try { this.finaliseInputs(); } catch { /* an unreadable input is already recorded; nothing else can fail here */ }
    let s = status ?? (this.errorReported ? 2 : 0);
    if (this.sinkFailed) s = 4;
    const at = this.next();
    const rec = this.envelope({ event: "end", status: s, receipt: this.receiptPath, redacted: this.redactedAny }, SCHEMA_IDS.end, at);
    this.closed = true;
    const okOut = this.write("stdout", this.init.human ? this.prose(rec) : this.line(rec));
    const okRec = this.write("receipt", this.line(rec));
    this.receiptOpen = false;
    let closeOk = true;
    try { closeSync(this.init.receiptFd); } catch { closeOk = false; }
    this.finalStatus = okOut && okRec && closeOk ? s : 4;
    return this.finalStatus;
  }
}

