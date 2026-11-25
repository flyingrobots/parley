// One run (spec §3): a single sequence across stdout, stderr and the receipt; the bootstrap line
// first, the head next, the `end` event last and immutable; every record's payload scrubbed of
// declared secrets before any copy leaves the process. The envelope is applied after scrubbing
// and is never scrubbed: the run id and the receipt path were chosen secret-free at startup.
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkRecord } from "./check.ts";
import { exactJson, holdsUnreadable, MAX_EXACT_DIGITS, parseExact } from "./exact.ts";
import type { HistoryProjection, HistorySink } from "./history.ts";
import { canonical, computeInv, digestInput, sha256, type InputDecl, type InputDescriptor } from "./inv.ts";
import { carriesSecret, replaceSecrets, scrub, scrubPointer } from "./redact.ts";
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
 *
 * `op` is the same kind of thing: a bookkeeping entry's operation is one of the protocol's own
 * tokens (`create`, `append`, `delete`), which `parley.command` enumerates. A declared secret
 * whose value is `create` is a coincidence with a public word, and replacing the word would
 * publish a line the released schema rejects.
 *
 * `error` is an input descriptor's diagnostic code, whose pattern `parley.receipt.inputs` states:
 * the writer's own `input.unreadable` or `input.unread`, or a code the tool gave
 * `inputUnreadable`, which is replaced by the writer's token there if it carries a declared
 * secret value. No other writer-built record has a field of that name.
 *
 * What a writer-built record's scrub leaves alone, in full: the string under each key here; its
 * numbers and booleans; its field names (`ScrubOptions.keys`); the head's `redacted` object and
 * a `schema` line's document (`verbatim`); and the envelope. Every other string in it is
 * scrubbed.
 */
export const DIGEST_KEYS = new Set(["sha256", "inv", "tool", "v", "name", "id", "version", "code", "op", "error"]);
/** The code recorded for a declared input the program could not read, when it gives none. */
const INPUT_UNREADABLE = "input.unreadable";

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
  /** A `bigint` is written as exact digits, for a measurement or a limit beyond the safe-integer range. */
  measured?: number | bigint; limit?: number | bigint; retryable?: boolean; detail?: unknown;
}

export class ParleyClosed extends Error {
  constructor() { super("the run has ended; nothing may follow end (spec §3.3)"); this.name = "ParleyClosed"; }
}

/** The code of the error a writer reports in place of a record redaction made invalid (spec §5.3, flyingrobots/parley#131). */
export const REDACTION_CONFLICT_CODE = "redaction.schema_conflict";

/**
 * Thrown by an emission whose record redaction made invalid under its declared schema (spec
 * §5.3, flyingrobots/parley#131). By the time it is thrown the writer has already reported the
 * structured error, written nothing of the record and taken no `seq` for it, and the run will
 * end with status 4. It is thrown, like every other refusal to emit, because the call has no
 * record to return a `seq` for and the handler should not carry on as though its answer had been
 * delivered; `main` does not report it a second time. A handler may catch it and continue: the
 * status stays 4.
 *
 * The message names the fields by JSON Pointer and the schema pair. It never carries a value, a
 * validator's message or any part of the schema, and its message and `pointers` are scrubbed
 * exactly as the published error line's `problem` and `detail.at` are, so it is safe to log: a
 * pointer can name a property the scrub renamed, and that name can be the secret.
 */
export class ParleyRedactionConflict extends Error {
  /** The schema the record was declared under. */
  readonly schema: SchemaRef;
  /** The JSON Pointer of each field that no longer validates, as scrubbed. */
  readonly pointers: readonly string[];
  constructor(schema: SchemaRef, pointers: readonly string[], message: string) {
    super(message);
    this.name = "ParleyRedactionConflict";
    this.schema = { id: schema.id, version: schema.version };
    this.pointers = [...pointers];
  }
}

/** The code of the error a writer reports in place of a record redaction changed whose schema document it holds and cannot evaluate (spec §5.3, flyingrobots/parley#144). */
export const REDACTION_UNCHECKED_CODE = "redaction.schema_unchecked";

/**
 * Thrown by an emission whose record redaction changed, under a schema document the writer holds
 * and cannot evaluate: one that uses a construct outside the bounded checker (check.ts). The
 * writer cannot show the redacted record is valid under its declared schema, so it withholds it
 * exactly as it withholds a conflict (spec §5.3, flyingrobots/parley#144): the structured error
 * `redaction.schema_unchecked` is already reported, nothing of the record was written, no `seq`
 * was taken and the run will end with status 4.
 *
 * It is a `ParleyRedactionConflict`, so a handler or a `main` that already treats the conflict
 * needs no second branch; `pointers` is empty, because no field was shown to be invalid.
 * `redacted` is the JSON Pointer of each value the scrub replaced. `construct` names the first
 * thing in the schema the checker does not implement, as `schemaSubsetGap` reports it; it is in
 * this exception and its message only, never on the error line, which carries no part of the
 * schema. It is left out (`null`, and absent from the message) if it would carry a declared
 * secret value. The message never carries a value.
 */
export class ParleyRedactionUnchecked extends ParleyRedactionConflict {
  /** The JSON Pointer of each value the scrub replaced. */
  readonly redacted: readonly string[];
  /** The first construct in the schema the writer's checker does not implement, or `null` when naming it would disclose a declared secret. */
  readonly construct: string | null;
  constructor(schema: SchemaRef, redacted: readonly string[], construct: string | null, message: string) {
    super(schema, [], message);
    this.name = "ParleyRedactionUnchecked";
    this.redacted = [...redacted];
    this.construct = construct;
  }
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
  /**
   * Every schema document the writer holds, by `id@version`: the ones the package ships and the
   * ones the tool declared (§4.2). A record redaction changed is validated against its own pair's
   * document before it is written (§5.3, flyingrobots/parley#131); a pair outside this map
   * cannot be checked and is written as before. A pair inside it whose document the checker
   * cannot evaluate is withheld (flyingrobots/parley#144).
   */
  schemas?: ReadonlyMap<string, Record<string, unknown>>;
}

type SinkName = "stdout" | "stderr" | "receipt";
interface Emit {
  to: { stdout?: boolean; stderr?: boolean; receipt?: boolean }; writer?: boolean; noSidecar?: boolean; deferFailures?: boolean; verbatim?: string;
  /** Pointers into this record where the caller replaced a secret before handing it over; each gets its `redaction` event as though the record's own scrub had found it. */
  replaced?: readonly string[];
}

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
  /** A record was withheld because redaction made it invalid, or because the writer could not show it valid: like a sink failure, the run closes with 4 (§3.4, §5.3). */
  private outputRefused = false;
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
  /** Digests of the declared files read through `readInput`, taken at the read. */
  private read = new Map<string, string>();
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
  /** True when a record redaction changed was withheld, because it was left invalid under its declared schema or because the writer could not evaluate that schema (§5.3): the run closes with 4. */
  get redactionRefused(): boolean { return this.outputRefused; }

  // ---- emission -------------------------------------------------------------------------

  private next(t?: number): { seq: number; t: number } { this.seq += 1; return { seq: this.seq, t: t ?? this.init.now() }; }

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
   *
   * The text is parsed exactly (flyingrobots/parley#171): the transform is handed the value each
   * number's text states, an integer beyond the safe range as a `bigint`, and never a rounded
   * one. Text holding a number that cannot be held that way is not handed over at all. The line
   * is withheld and warned as `history.number_unrepresentable`: handing over a rounded record
   * would let the stream state a value the receipt does not, and appending the line as it is
   * would put it on the stream past the transform configured to narrow it. No emission writes
   * such text (`emit` refuses a record it could not read back), so this is a second guard.
   */
  private project(text: string, p: HistoryProjection): string | null {
    let rec: Record_;
    try {
      const parsed = parseExact(text);
      if (!parsed.ok) {
        const at = (parsed.partial as Record_ | null)?.seq;
        const shown = parsed.tokens.slice(0, 3).map((t) => (t.length > 40 ? `${t.slice(0, 40)}… (${t.length} characters)` : t)).join(", ");
        this.withhold({ code: "history.number_unrepresentable", problem: `seq ${typeof at === "number" ? at : "?"} holds a number this writer cannot hold exactly (${shown}), so it was not handed to the history transform ${p.name} and that line is not on the shared stream; the receipt is unaffected`, remedy: `write an integer of at most ${MAX_EXACT_DIGITS} digits, or a decimal as JSON.stringify writes it; a value that is neither belongs in a string` });
        return null;
      }
      rec = parsed.value as Record_;
    } catch { return null; }
    const seq = typeof rec.seq === "number" ? rec.seq : -1;
    // Nothing from here may escape. This runs inside the receipt's own write, so a throw that got
    // out would be reported as a receipt sink failure and close the run with status 4 — the stream
    // failing the run it is an optional observer of, which §8 forbids. A record that cannot be
    // serialised (a cycle) is withheld like any other failure.
    try { return this.projectOne(rec, seq, p); }
    catch (e) {
      const msg = e instanceof Error ? e.message || e.name : String(e);
      this.withhold({ code: "history.transform_failed", problem: `the projection of seq ${seq} by ${p.name} could not be completed: ${msg}; that line is not on the shared stream and the receipt is unaffected`, remedy: "return a record that serialises as JSON: no cycles, nothing the receipt line did not already carry" });
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
    if (this.init.secretValues.size > 0 && carriesSecret(exactJson(body), this.init.secretValues)) {
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
    // A body the writer could not read back is no more the stream's than the receipt's.
    if (holdsUnreadable(body)) {
      this.withhold({ code: "history.transform_invalid", problem: `the body the history transform ${p.name} returned for seq ${seq} holds an integer of more than ${MAX_EXACT_DIGITS} digits, which this writer does not write; that line is not on the shared stream`, remedy: "project within what the receipt line carried, or withhold the line by returning nothing" });
      return null;
    }
    return exactJson(out) + "\n";
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

  /** One record as one line. Every sink's copy is written by this serialiser, so a `bigint` is the same exact digits on each. */
  private line(obj: Record_): string { return exactJson(obj) + "\n"; }

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
      default: return `${String(obj.event)}: ${exactJson(obj)}\n`;
    }
  }

  /**
   * Scrub a payload's values. `event` is envelope, named by the writer or the tool's schema, and is
   * never a secret. For a writer-built record, the one field named by `verbatim` is left as it is:
   * the schema document of a `schema` line, a static declaration a secret cannot reach (§5.3,
   * flyingrobots/parley#111), or the head's `redacted`, which holds indexes, JSON Pointers and
   * names the caller has already scrubbed. A writer-built record's field names are never renamed.
   */
  private scrubPayload(payload: Record_, found: string[], writer: boolean, verbatim?: string): Record_ {
    const { event, ...all } = payload;
    const rest: Record_ = { ...all };
    if (verbatim !== undefined) delete rest[verbatim];
    let scrubbed = scrub(rest, this.init.secretValues, "", found, writer ? { skipKeys: DIGEST_KEYS, scalars: false, keys: false } : {}) as Record_;
    // Put back in its own place, so the record's key order is the one it was built with.
    if (verbatim !== undefined && verbatim in all) scrubbed = Object.fromEntries(Object.keys(all).map((k) => [k, k === verbatim ? all[k] : scrubbed[k]]));
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
    // A `bigint` is written as its exact digits (flyingrobots/parley#171). One of more digits than
    // `parseExact` reads back is refused here, before a seq is taken: a line this writer could
    // not read exactly is one no reader of it could, and its own history projection would have
    // to withhold it.
    if (this.unreadable(scrubbed) || (extra !== undefined && this.unreadable(extra))) throw new TypeError(`a record must not carry an integer of more than ${MAX_EXACT_DIGITS} digits; a bigint is written as exact digits, and this writer does not write one it could not read back. Carry such a value as a string`);
    // The copies of one event agree on every field they share (§1.3): compared as scrubbed, since
    // that is what is written, and before a seq is taken, so a refusal leaves no gap.
    if (extra) for (const k of Object.keys(extra)) {
      if (k in scrubbed && canonical(extra[k]) !== canonical(scrubbed[k])) throw new TypeError(`receiptExtra.${k} differs from the record's ${k}; the copies of an event must agree on every field they share (spec §1.3)`);
    }
    // A tool's record the scrub changed is validated as each sink would receive it, before any
    // copy is written and before a seq is taken (§5.3, flyingrobots/parley#131). A writer-built
    // record is never checked; what its scrub leaves alone so that it stays valid is listed at
    // DIGEST_KEYS. The error this raises is itself writer-built, so it cannot raise another.
    let t: number | undefined;
    if (how.writer !== true && (found.length > 0 || extraFound.length > 0)) {
      t = this.init.now();
      this.refuseRedactionConflict(how, payload, receiptExtra, scrubbed, extra, schema, { seq: this.seq + 1, t }, [...found, ...extraFound]);
    }
    const at = this.next(t);
    const rec = this.envelope(scrubbed, schema, at);
    const human = this.init.human !== undefined;
    if (how.to.stdout) this.writeOrSkip("stdout", human ? this.prose(rec) : this.line(rec), how.deferFailures);
    if (how.to.stderr) this.writeOrSkip("stderr", human ? this.prose(rec) : this.line(rec), how.deferFailures);
    if (how.to.receipt) {
      // A shared field is written from the payload, so the copies agree byte for byte on it.
      const full = extra ? this.envelope({ ...scrubbed, ...Object.fromEntries(Object.entries(extra).filter(([k]) => !(k in scrubbed))) }, schema, at) : rec;
      const text = exactJson(full);
      if (!how.noSidecar && Buffer.byteLength(text, "utf8") > SIDECAR_THRESHOLD) this.sidecar(at.seq, text);
      else this.write("receipt", text + "\n");
    }
    for (const at_ of new Set([...found, ...extraFound, ...(how.replaced ?? [])])) this.redaction(at.seq, at_);
    return at.seq;
  }

  /** Whether a payload holds a `bigint` past the cap. A payload that refers to itself is not this check's to report: the serialiser says so, as it always has. */
  private unreadable(payload: Record_): boolean { try { return holdsUnreadable(payload); } catch { return false; } }

  /** The copies of one event as the sinks would receive them: the stream copy, and the receipt copy when it carries more. */
  private copies(how: Emit, payload: Record_, extra: Record_ | undefined, schema: SchemaRef, at: { seq: number; t: number }): Record_[] {
    const out: Record_[] = [];
    if (how.to.stdout || how.to.stderr || !extra) out.push(this.envelope(payload, schema, at));
    if (how.to.receipt && extra) out.push(this.envelope({ ...payload, ...Object.fromEntries(Object.entries(extra).filter(([k]) => !(k in payload))) }, schema, at));
    return out;
  }

  /**
   * Refuse a record that redaction made invalid under its declared schema, or that the writer
   * cannot show is valid (§5.3, flyingrobots/parley#131, flyingrobots/parley#144). Called before
   * a seq is taken, with the seq and time the record would get, and only for a tool's record the
   * scrub changed.
   *
   * A pair with no schema document here is exempt, as §5.3 says: the rule asks nothing of it. A
   * pair whose document uses a construct outside the checker's subset (check.ts) is not: the
   * writer holds the schema and cannot evaluate it, so it cannot show the redacted record is
   * valid, and it withholds the record as `redaction.schema_unchecked`. Publishing it would be
   * the silent invalid line the rule exists to prevent.
   *
   * Otherwise each copy is checked as scrubbed and as the tool handed it over; a failure the
   * scrubbed copy has and the original did not is one redaction caused, and is
   * `redaction.schema_conflict`. A record that was already invalid in the same way is not this
   * rule's business and is written as before.
   *
   * Either way nothing of the record is written. One writer-built error names the schema pair
   * and the fields by JSON Pointer, and deliberately nothing the checker said: a validator's
   * message can quote the schema or the value, and the value is the secret or sits beside it.
   * The construct the checker could not evaluate is part of the schema, so it is not on the line
   * either; it is on the exception. The run is marked to close with 4, since a record the writer
   * would not write is an output it could not write (§3.4), and the refusal is thrown to the
   * caller.
   */
  private refuseRedactionConflict(how: Emit, payload: Record_, receiptExtra: Record_ | undefined, scrubbed: Record_, extra: Record_ | undefined, schema: SchemaRef, at: { seq: number; t: number }, redacted: string[]): void {
    const doc = this.init.schemas?.get(`${schema.id}@${schema.version}`);
    if (doc === undefined) return;
    const pair = `${schema.id}@${schema.version}`;
    const after = this.copies(how, scrubbed, extra, schema, at), before = this.copies(how, payload, receiptExtra, schema, at);
    const raw: string[] = [];
    for (let i = 0; i < after.length; i++) {
      const verdict = checkRecord(after[i], doc);
      if (verdict.ok) continue;
      if ("unsupported" in verdict) this.refuseUnchecked(payload, schema, pair, redacted, verdict.unsupported);
      const was = checkRecord(before[i], doc);
      const already = new Set(was.ok || "unsupported" in was ? [] : was.errors.map((e, j) => `${was.pointers[j]}\u0000${e}`));
      verdict.errors.forEach((e, j) => {
        const p = verdict.pointers[j]!;
        if (!already.has(`${p}\u0000${e}`) && !raw.includes(p)) raw.push(p);
      });
    }
    if (raw.length === 0) return;
    // A pointer the checker reports can name a property the record no longer has, because the
    // scrub renamed it, and that name is then the secret. Each is scrubbed token by token before
    // it goes anywhere; the line's own scrub then sees the same strings the exception is given.
    const secrets = this.init.secretValues;
    const pointers = raw.map((p) => scrubPointer(p, secrets));
    // The receipt still records that a secret was replaced in the error line, and where (§5.3).
    const replaced = pointers.some((p, i) => p !== raw[i]) ? ["/problem", ...pointers.flatMap((p, i) => (p === raw[i] ? [] : [`/detail/at/${i}`]))] : [];
    const problem = `the ${String(payload.event)} record was not published: replacing a declared secret at ${redacted.join(", ")} left it invalid under ${pair} at ${pointers.join(", ")}`;
    this.outputRefused = true;
    this.emit({ to: { stderr: true, receipt: true }, writer: true, replaced }, {
      event: "error", code: REDACTION_CONFLICT_CODE, problem,
      remedy: "keep a declared secret out of any field whose schema the literal [redacted] cannot satisfy: leave the field out, or declare it as an unconstrained string; the run will close with status 4",
      detail: { schema: { id: schema.id, version: schema.version }, at: pointers, redacted },
    }, SCHEMA_IDS.error);
    throw new ParleyRedactionConflict(schema, pointers.map((p) => replaceSecrets(p, secrets)), `${replaceSecrets(problem, secrets)}; reported as ${REDACTION_CONFLICT_CODE}`);
  }

  /**
   * Withhold a record the scrub changed whose schema document the writer holds and cannot
   * evaluate (§5.3, flyingrobots/parley#144). The error line names the pair and the pointers the
   * scrub replaced and nothing of the schema; `construct` goes to the exception only, and not
   * even there when it would carry a declared secret value, since an exception's message is not
   * scrubbed.
   */
  private refuseUnchecked(payload: Record_, schema: SchemaRef, pair: string, redacted: string[], construct: string): never {
    const problem = `the ${String(payload.event)} record was not published because it could not be checked: a declared secret was replaced at ${redacted.join(", ")}, and this writer cannot evaluate the schema document it holds for ${pair}, so the redacted record was not validated against it`;
    this.outputRefused = true;
    this.emit({ to: { stderr: true, receipt: true }, writer: true }, {
      event: "error", code: REDACTION_UNCHECKED_CODE, problem,
      remedy: "keep the type's declared schema within the keywords this writer's checker evaluates (its README lists them), or keep declared secrets out of records of this type; the record was not shown to be invalid, and the value was replaced, not exposed; the run will close with status 4",
      detail: { schema: { id: schema.id, version: schema.version }, redacted },
    }, SCHEMA_IDS.error);
    // The exception's text is the published line's, scrubbed as the line is.
    const secrets = this.init.secretValues;
    const named = carriesSecret(construct, secrets) ? null : construct;
    throw new ParleyRedactionUnchecked(schema, redacted.map((p) => replaceSecrets(p, secrets)), named, `${replaceSecrets(problem, secrets)}${named === null ? "" : `: the schema uses ${named}`}; reported as ${REDACTION_UNCHECKED_CODE}`);
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
    try { h.append(exactJson(rec) + "\n"); }
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
    this.writerStep(`the shared stream's copy of this run is a projection by ${p.name}`, `a history transform is configured, so the stream copy is narrowed and says so: seq ${this.projectionSeq} is its parley.history.transform line, which reaches the stream alone and is why this receipt has no line at that seq. The transform's source digests to ${p.sha256}. The receipt is never projected (§8, informative)`);
  }

  /**
   * Internal: the receipt head, receipt only, never a sidecar (§5). `redacted` is written as the
   * caller built it: its JSON Pointers are locations in the already-scrubbed `resolved`, and a
   * second scrub of a pointer as a string could only damage it (a secret equal to `/token` would
   * turn the pointer `/token` into something that is not a pointer).
   */
  head(fields: Record_): void { this.emit({ to: { receipt: true }, writer: true, noSidecar: true, verbatim: "redacted" }, { event: "receipt.head", ...fields }, SCHEMA_IDS.head); }

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

  /**
   * Internal: a decision the writer itself records, such as retention, the projection of the
   * stream copy or captured console output (flyingrobots/parley#161). It is writer-built: its
   * field names are the protocol's and are never renamed, and it is never withheld by the
   * redaction check, so a declared secret whose value is `decision` cannot cost a run a record
   * the tool had no part in. Every string in it is still scrubbed: captured text, a file name and
   * the writer's own prose alike, except under a key in `DIGEST_KEYS`, so a `detail` built here
   * never puts the tool's text under one. Tools call `step`.
   */
  writerStep(decision: string, because: string, detail?: unknown): number {
    return this.emit({ to: { receipt: true }, writer: true }, { event: "receipt.step", decision, because, ...(detail === undefined ? {} : { detail }) }, SCHEMA_IDS.step);
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
    // Marked once the line is out: an error the writer refused to emit was not reported.
    const seq = this.emit({ to: { stderr: true, receipt: true } }, { event: "error", ...this.diagnostic(d) }, SCHEMA_IDS.error, receiptExtra);
    this.errorReported = true;
    return seq;
  }

  /**
   * Internal: an error the writer itself reports, such as `uncaught.exception` for a throw that
   * escaped the handler (flyingrobots/parley#161). It is writer-built, like `writerWarning`: the
   * `code` is the writer's own and is not scrubbed, the field names are never renamed and the
   * record is never withheld by the redaction check, so `main` can always report the failure. The
   * `problem`, the `remedy` and everything in `receiptExtra` carry the tool's text (an exception's
   * name, message and stack, a path) and are scrubbed. The run then closes with status 2, as after
   * `error`. Tools call `error`.
   */
  writerError(d: Diagnostic, receiptExtra?: Record_): number {
    const seq = this.emit({ to: { stderr: true, receipt: true }, writer: true }, { event: "error", ...this.diagnostic(d) }, SCHEMA_IDS.error, receiptExtra);
    this.errorReported = true;
    return seq;
  }

  private diagnostic(d: Diagnostic): Record_ {
    if (!CODE.test(d.code)) throw new TypeError(`code ${JSON.stringify(d.code)} is not two or more dot-separated lowercase segments (spec §6)`);
    if (!d.problem) throw new TypeError("problem is never empty (spec §6)");
    const out: Record_ = { code: d.code, problem: d.problem };
    for (const k of ["remedy", "remedy_target", "measured", "limit", "retryable", "detail"] as const) if (d[k] !== undefined) out[k] = d[k];
    return out;
  }

  /**
   * Supply the bytes of a declared input the writer cannot read itself, such as stdin. For a
   * declared file, `readInput` reads and records in one step.
   */
  input(path: string, bytes: Uint8Array | string): void {
    this.supplied.set(path, typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes);
    this.unread.delete(path);
    this.read.delete(path);
  }

  /**
   * Read a declared file input and record it: the bytes returned are the bytes whose digest the
   * receipt carries for that input, whatever happens to the file afterwards (§2.2,
   * flyingrobots/parley#132). This is the way to read a declared file. A file the program reads
   * by other means is digested when the handler finishes, and that digest describes the file as
   * it is then, which a tool that edits in place has already changed.
   *
   * `path` is the declared path, resolved as a declared input is: against the run's `cwd` when
   * relative. When the file cannot be read, the input is recorded as `inputUnreadable` records it
   * and the file system's error is thrown. Throws `TypeError` for a path that is not a declared
   * input, for a `stdin` input (supply it with `input`) or a `tree` input, and once the inputs
   * are settled. A later `readInput`, `input` or `inputUnreadable` for the same path replaces
   * the record.
   */
  readInput(path: string): Buffer {
    if (this.closed) throw new ParleyClosed();
    if (this.inputsSettled) throw new TypeError("the inputs are already settled; call readInput before finaliseInputs or end (spec §2.2)");
    const decl = this.init.inputs.find((i) => i.path === path);
    if (!decl) throw new TypeError(`${JSON.stringify(path)} is not a declared input of this run`);
    if (decl.role === "stdin" || decl.role === "tree") throw new TypeError(`${JSON.stringify(path)} is a ${decl.role} input; readInput reads a declared file`);
    let bytes: Buffer;
    try { bytes = readFileSync(resolve(this.cwd, path)); } catch (e) { this.inputUnreadable(path); throw e; }
    // The digest is taken now, so the caller may do what it likes with the buffer.
    this.read.set(path, sha256(bytes));
    this.supplied.delete(path);
    this.unread.delete(path);
    return bytes;
  }

  /**
   * Say that the program could not read a declared input, so the writer records it with `error`
   * and no digest, and omits `inv`, rather than reading the path itself at finalisation and
   * digesting bytes the program never saw (§2.2, flyingrobots/parley#110). Refused for a path
   * that is not a declared input, and once the inputs are settled.
   */
  inputUnreadable(path: string, code = INPUT_UNREADABLE): void {
    if (this.closed) throw new ParleyClosed();
    if (this.inputsSettled) throw new TypeError("the inputs are already settled; call inputUnreadable before finaliseInputs or end (spec §2.2)");
    if (!this.init.inputs.some((i) => i.path === path)) throw new TypeError(`${JSON.stringify(path)} is not a declared input of this run`);
    if (!CODE.test(code)) throw new TypeError(`code ${JSON.stringify(code)} is not two or more dot-separated lowercase segments (spec §6)`);
    this.supplied.delete(path);
    this.read.delete(path);
    // A code is never scrubbed, so one that carries a declared secret value is not recorded: the
    // writer's own token stands in for it (§5.3).
    this.unread.set(path, carriesSecret(code, this.init.secretValues) ? INPUT_UNREADABLE : code);
  }

  /** Digest the declared inputs and emit `receipt.inputs` with `inv` once settled (§2.2). Idempotent; `end` calls it. */
  finaliseInputs(): InputDescriptor[] {
    if (this.inputsSettled || this.init.inputs.length === 0) { this.inputsSettled = true; return []; }
    this.inputsSettled = true;
    const raw = this.init.inputs.map((i): InputDescriptor => {
      const code = this.unread.get(i.path), read = this.read.get(i.path);
      if (code !== undefined) return { path: i.path, ...(i.role ? { role: i.role } : {}), error: code };
      if (read !== undefined) return { path: i.path, ...(i.role ? { role: i.role } : {}), sha256: read };
      return digestInput(this.cwd, i, this.supplied.get(i.path));
    });
    // The preimage and the record both take the redacted descriptors (§2.2: no secret value in inv).
    const inputs = scrub(raw, this.init.secretValues, "", [], { skipKeys: DIGEST_KEYS, scalars: false, keys: false }) as InputDescriptor[];
    const inv = computeInv({ tool: this.tool, v: this.v, command: this.init.command, resolved: this.init.resolved, inputs });
    this.emit({ to: { receipt: true }, writer: true }, { event: "receipt.inputs", inputs, ...(inv ? { inv } : {}) }, SCHEMA_IDS.inputs);
    return inputs;
  }

  /**
   * Close the run (§3.3). Status defaults to 2 when an error was reported, else 0; a sink failure,
   * or a record withheld because redaction made it invalid (§5.3), forces 4. Returns the exit status the process should exit with.
   */
  end(status?: number): number {
    if (this.closed) return this.finalStatus ?? 4;
    // The envelope's own numbers are numbers. A status is at most 255, so a `bigint` here is a
    // mistake to refuse, not a value to convert.
    if (typeof status === "bigint") throw new TypeError("end status is an integer 0-255 other than 3 (spec §3.4), given as a number, not a bigint");
    if (status !== undefined && (!Number.isInteger(status) || status < 0 || status > 255 || status === 3)) throw new TypeError("end status is an integer 0-255 other than 3 (spec §3.4)");
    if (status === 0 && this.errorReported) throw new TypeError("a run that reported an error cannot end with status 0 (spec §3.4); a recovered condition is a warning");
    try { this.finaliseInputs(); } catch { /* an unreadable input is already recorded; nothing else can fail here */ }
    let s = status ?? (this.errorReported ? 2 : 0);
    // A record withheld because redaction made it invalid is an output the writer could not write
    // (§3.4, §5.3): it forces 4 exactly as a sink failure does, whatever the handler asked for.
    if (this.sinkFailed || this.outputRefused) s = 4;
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
