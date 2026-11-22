// The loader: every run in a working directory's two receipt locations, as validated records.
//
// The rules it is held to are the ones the specification binds a *reader* to, and they exist
// because the cases §6 names as unconstrainable will happen:
//
//   §1.4  buffer to the newline; quarantine a complete line that is not a JSON object, keep it,
//         report it, and never treat it as evidence of anything but its own existence.
//   §5.4  ignore a final line that is not newline-terminated, including an otherwise parseable
//         `end`; a newline-terminated `end` establishes that the run reported termination.
//   §1.3  `(run, seq)` identifies an event. Copies are one event; a copy may carry a field another
//         omits; copies must agree on every field they share.
//   §4.5  full validation is against the schema for the exact advertised `(id, version)` pair.
//   §4.6  a line whose id this reader ships no schema for is passed through, not validated.
//   §5    a sidecar stands in a record's place; its path is relative to the receipt's directory and
//         must not leave it; `bytes` and `sha256` describe the stored bytes; a sidecar found missing
//         or mismatched makes the bundle unavailable for replay.
//
// What this module does not do: query, rank, or recompute `inv`. It hands back what the receipts
// say, with each claim labelled by how well it is established (§1.2a).
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { sha256 } from "@flyingrobots/parley-emit";
import { readFileLines } from "./lines.ts";
import { isFile, receiptLocations, type LocateOptions, type ReceiptLocation, type Where } from "./locate.ts";
import { validator, type Validation, type Validator } from "./validate.ts";

// ---- what a load reports ------------------------------------------------------------------

export type DefectCode =
  | "line.quarantined" | "line.blank" | "line.no_envelope" | "line.unterminated"
  | "record.invalid" | "record.unknown_pair" | "copies.disagree"
  | "sidecar.missing" | "sidecar.unreadable" | "sidecar.digest_mismatch"
  | "sidecar.bytes_mismatch" | "sidecar.escapes_bundle" | "sidecar.unparseable";

/** The quarantine codes: a kept line that is not a record (§1.4, §5.4). */
export const QUARANTINE_CODES: ReadonlySet<DefectCode> = new Set<DefectCode>([
  "line.quarantined", "line.blank", "line.no_envelope", "line.unterminated",
]);

export interface Defect {
  readonly code: DefectCode;
  /** The section of the specification the defect is measured against. */
  readonly section: string;
  readonly file: string;
  /** 1-based line in that file; `0` when the defect is the bundle's rather than a line's. */
  readonly line: number;
  readonly problem: string;
  /** The run the defect is attributed to, when it can be (§1.4), else null. */
  readonly run: string | null;
  /** The quarantined bytes, kept verbatim, for a quarantine code. */
  readonly raw?: string;
  /** The `seq` of the record a sidecar holds, for a sidecar code. */
  readonly source?: number;
}

export type SidecarState =
  | "intact" | "missing" | "unreadable" | "digest_mismatch" | "bytes_mismatch"
  | "escapes_bundle" | "unparseable";

export interface SidecarResolution {
  /** The `seq` of the record the sidecar holds. */
  readonly source: number;
  /** The `seq` of the `sidecar` event itself, which is a record in its own right (§5). */
  readonly seq: number;
  /** The path as declared: relative to the receipt's directory. */
  readonly path: string;
  /** The absolute path it resolved to, or null when it would leave the bundle and was never read. */
  readonly resolved: string | null;
  readonly state: SidecarState;
  readonly declared: { readonly bytes: number | null; readonly sha256: string | null };
  /** What the stored bytes actually are, when they could be read. */
  readonly actual?: { readonly bytes: number; readonly sha256: string };
}

export interface LoadedRecord {
  readonly run: string;
  readonly seq: number;
  readonly event: string | null;
  readonly t: number | null;
  /** The file the first copy of this event was read from. */
  readonly file: string;
  /** 1-based line of that copy; for a record restored from a sidecar, the line of its `sidecar` event. */
  readonly line: number;
  /** How many lines carried this `(run, seq)`. More than one is a copy, not a second event (§1.3). */
  readonly copies: number;
  /** True when the record was stored beside the receipt and restored from there (§5). */
  readonly fromSidecar: boolean;
  readonly record: Record<string, unknown>;
  readonly validation: Validation;
}

export interface BundleSource {
  readonly where: Where;
  readonly receipt: string;
}

export interface Replay {
  /**
   * True when something about this bundle rules replay out. False means only that nothing in the
   * bundle rules it out: eligibility under §2.3 and §5.3 for the invocation at hand is the
   * caller's to decide, and this reader does not know it.
   */
  readonly unavailable: boolean;
  readonly reasons: readonly string[];
}

export interface Bundle {
  readonly run: string;
  /** Every receipt file this run's records were read from, in the order the locations were read. */
  readonly sources: readonly BundleSource[];
  /** One record per `(run, seq)`, ascending by `seq`. */
  readonly records: readonly LoadedRecord[];
  readonly sidecars: readonly SidecarResolution[];
  /** The kept lines that are not records, attributed to this run (§1.4). */
  readonly quarantined: readonly Defect[];
  /** Everything wrong that was found, quarantines included. */
  readonly defects: readonly Defect[];
  /** How many extra copies of an event were seen and folded into one record. */
  readonly duplicates: number;
  /** A newline-terminated `end` was read: the run reported termination (§5.4). */
  readonly terminated: boolean;
  /** `end.status`, when there is one. */
  readonly status: number | null;
  /** The receipt is partial: the head carries `redacted`, a `redaction` event was emitted, or `end.redacted` is true (§3.3, §5.3). */
  readonly redacted: boolean;
  readonly replay: Replay;
}

export interface FileSummary {
  readonly file: string;
  readonly where: Where;
  /** The run the file name names, which is how a quarantined line is attributed (§5: `<run>.jsonl`). */
  readonly run: string | null;
  /** Complete lines; the unterminated tail is not one (§5.4). */
  readonly lines: number;
  readonly runs: readonly string[];
  readonly quarantined: readonly Defect[];
}

export interface FileRead extends FileSummary {
  readonly bundles: readonly Bundle[];
}

export interface Load {
  readonly locations: readonly ReceiptLocation[];
  readonly files: readonly FileSummary[];
  /** Every run found, ascending by run id. */
  readonly bundles: readonly Bundle[];
  /** Every kept line that is not a record, across every file. */
  readonly quarantined: readonly Defect[];
  readonly counts: {
    readonly bundles: number;
    readonly records: number;
    readonly validated: number;
    readonly invalid: number;
    readonly partial: number;
    readonly unvalidated: number;
    readonly quarantined: number;
    readonly duplicates: number;
  };
}

export interface ReadOptions {
  readonly where?: Where;
  /** Resolve and check sidecars; on by default. Off reports the `sidecar` events and restores no record. */
  readonly sidecars?: boolean;
  readonly validate?: Validator;
}

export interface LoadOptions extends LocateOptions, ReadOptions {}

// ---- scanning one file --------------------------------------------------------------------

interface Raw {
  readonly file: string;
  readonly line: number;
  readonly run: string;
  readonly seq: number;
  readonly obj: Record<string, unknown>;
}

interface Scan {
  readonly raw: Raw[];
  readonly lines: number;
  readonly quarantined: Defect[];
}

function defect(code: DefectCode, section: string, file: string, line: number, problem: string, extra: Partial<Defect> = {}): Defect {
  return { code, section, file, line, problem, run: null, ...extra };
}

/** Lines in, records and quarantine out. Nothing here interprets a record; that is §1.3's job below. */
function scan(file: string): Scan {
  const { lines, unterminated } = readFileLines(file);
  const raw: Raw[] = [];
  const quarantined: Defect[] = [];
  for (const line of lines) {
    if (line.raw.trim() === "") {
      quarantined.push(defect("line.blank", "§1.4", file, line.n, "a blank line is not a JSON object; quarantined, never a record", { raw: line.raw }));
      continue;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(line.raw); } catch {
      quarantined.push(defect("line.quarantined", "§1.4", file, line.n, "not JSON; quarantined and kept, and evidence of nothing but the fact that something wrote it", { raw: line.raw }));
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      quarantined.push(defect("line.quarantined", "§1.4", file, line.n, "JSON, but not an object; quarantined, never a record", { raw: line.raw }));
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    const run = typeof obj.run === "string" && obj.run.length > 0 ? obj.run : null;
    const seq = Number.isInteger(obj.seq) && (obj.seq as number) >= 0 ? (obj.seq as number) : null;
    if (run === null || seq === null) {
      quarantined.push(defect("line.no_envelope", "§1.3", file, line.n, "no usable run and seq, so the line cannot be placed in a run or deduplicated; quarantined", { raw: line.raw }));
      continue;
    }
    raw.push({ file, line: line.n, run, seq, obj });
  }
  if (unterminated !== null) {
    quarantined.push(defect("line.unterminated", "§5.4", file, unterminated.n, "the final line is not newline-terminated, so it is not a line and is ignored, parseable or not", { raw: unterminated.raw }));
  }
  return { raw, lines: lines.length, quarantined };
}

/** The run a receipt's file name names (§5: `<run>.jsonl`). */
function runOfFileName(file: string): string | null {
  const name = basename(file);
  return name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) || null : null;
}

/**
 * §1.4 asks that a quarantined line be "attributed to the run". A receipt file is one run's by
 * name, so that is the attribution; a file holding more than one run, with a name that names
 * neither, leaves the line unattributed rather than guessed at.
 */
function attribute(quarantined: Defect[], runs: readonly string[], fileRun: string | null): Defect[] {
  const target = fileRun !== null && runs.includes(fileRun) ? fileRun : runs.length === 1 ? runs[0]! : null;
  return target === null ? quarantined : quarantined.map((q) => ({ ...q, run: target }));
}

// ---- assembling one run -------------------------------------------------------------------

interface Held {
  base: Record<string, unknown>;
  file: string;
  line: number;
  copies: number;
  fromSidecar: boolean;
}

/**
 * Fold a line into the event at its `seq` (§1.3): the first copy is the record, a later copy
 * contributes the fields it alone carries, and a disagreement on a shared field is a defect in the
 * writer rather than a second event.
 */
function fold(held: Map<number, Held>, seq: number, obj: Record<string, unknown>, file: string, line: number, run: string, defects: Defect[], fromSidecar: boolean): void {
  const seen = held.get(seq);
  if (!seen) {
    held.set(seq, { base: { ...obj }, file, line, copies: 1, fromSidecar });
    return;
  }
  seen.copies += 1;
  seen.fromSidecar = seen.fromSidecar || fromSidecar;
  for (const [key, value] of Object.entries(obj)) {
    if (!(key in seen.base)) { seen.base[key] = value; continue; }
    if (JSON.stringify(seen.base[key]) !== JSON.stringify(value)) {
      defects.push(defect("copies.disagree", "§1.3", file, line, `seq ${seq}: copies of one event disagree on ${key}`, { run }));
    }
  }
}

function within(dir: string, path: string): string | null {
  if (isAbsolute(path)) return null;
  const base = resolve(dir);
  const target = resolve(base, path);
  const prefix = base.endsWith(sep) ? base : base + sep;
  return target !== base && target.startsWith(prefix) ? target : null;
}

/** Resolve one `sidecar` event against the bytes beside the receipt (§5). */
function resolveSidecar(seq: number, held: Held, read: boolean): { resolution: SidecarResolution; stored?: Record<string, unknown> } {
  const obj = held.base;
  const source = Number.isInteger(obj.source) ? (obj.source as number) : null;
  const path = typeof obj.path === "string" && obj.path.length > 0 ? obj.path : null;
  const declared = {
    bytes: Number.isInteger(obj.bytes) ? (obj.bytes as number) : null,
    sha256: typeof obj.sha256 === "string" ? obj.sha256 : null,
  };
  const at = (state: SidecarState, extra: Partial<SidecarResolution> = {}) =>
    ({ resolution: { source: source ?? -1, seq, path: path ?? "", resolved: null, state, declared, ...extra } satisfies SidecarResolution });

  if (source === null || path === null || declared.sha256 === null || declared.bytes === null) {
    return at("unreadable");
  }
  const target = within(dirname(held.file), path);
  if (target === null) return at("escapes_bundle");
  if (!read) return { resolution: { source, seq, path, resolved: target, state: "intact", declared } };

  let bytes: Buffer;
  try { bytes = readFileSync(target); } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
    return at(missing ? "missing" : "unreadable", { resolved: target });
  }
  const actual = { bytes: bytes.length, sha256: sha256(bytes) };
  if (actual.sha256 !== declared.sha256) return at("digest_mismatch", { resolved: target, actual });
  if (actual.bytes !== declared.bytes) return at("bytes_mismatch", { resolved: target, actual });
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch {
    return at("unparseable", { resolved: target, actual });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return at("unparseable", { resolved: target, actual });
  }
  return {
    resolution: { source, seq, path, resolved: target, state: "intact", declared, actual },
    stored: parsed as Record<string, unknown>,
  };
}

const SIDECAR_SECTION = "§5";

function buildBundle(run: string, raw: readonly Raw[], sources: readonly BundleSource[], quarantined: readonly Defect[], opts: Required<Pick<ReadOptions, "sidecars" | "validate">>): Bundle {
  const defects: Defect[] = [...quarantined];
  const held = new Map<number, Held>();
  for (const r of raw) fold(held, r.seq, r.obj, r.file, r.line, run, defects, false);

  // Sidecars stand in a record's place: resolve them, then fold the record each one holds back in
  // at the `seq` it names, so a caller reading the records does not have to know where a record
  // was stored (§5).
  const sidecars: SidecarResolution[] = [];
  for (const [seq, entry] of [...held.entries()].sort((a, b) => a[0] - b[0])) {
    if (entry.base.event !== "sidecar") continue;
    const { resolution, stored } = resolveSidecar(seq, entry, opts.sidecars);
    sidecars.push(resolution);
    if (resolution.state !== "intact") {
      defects.push(defect(`sidecar.${resolution.state}` as DefectCode, SIDECAR_SECTION, entry.file, entry.line, sidecarProblem(resolution), { run, source: resolution.source >= 0 ? resolution.source : undefined }));
      continue;
    }
    if (stored) fold(held, resolution.source, stored, entry.file, entry.line, run, defects, true);
  }

  const records: LoadedRecord[] = [...held.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([seq, entry]) => {
      const validation = opts.validate.validate(entry.base);
      if (validation.state === "invalid") {
        defects.push(defect("record.invalid", "§4.5", entry.file, entry.line, `${validation.schema.id}@${validation.schema.version}: ${validation.errors.join("; ")}`, { run }));
      } else if (validation.state === "partial") {
        defects.push(defect("record.unknown_pair", "§4.5", entry.file, entry.line, `no schema for ${validation.schema.id}@${validation.schema.version}; reported as partial, never as validated`, { run }));
      }
      return {
        run, seq,
        event: typeof entry.base.event === "string" ? entry.base.event : null,
        t: Number.isInteger(entry.base.t) ? (entry.base.t as number) : null,
        file: entry.file, line: entry.line, copies: entry.copies, fromSidecar: entry.fromSidecar,
        record: entry.base, validation,
      };
    });

  const end = records.find((r) => r.event === "end");
  const head = records.find((r) => r.event === "receipt.head");
  const terminated = end !== undefined;
  const status = end && Number.isInteger(end.record.status) ? (end.record.status as number) : null;
  const redacted =
    (end?.record.redacted === true) ||
    (head !== undefined && head.record.redacted !== undefined) ||
    records.some((r) => r.event === "redaction");

  const reasons = new Set<string>();
  for (const s of sidecars) if (s.state !== "intact") reasons.add(`sidecar.${s.state}`);
  if (!terminated) reasons.add("receipt.no_end");
  if (status !== null && status !== 0) reasons.add("end.status_nonzero");
  if (redacted) reasons.add("receipt.redacted");

  const duplicates = raw.length + sidecars.filter((s) => s.state === "intact" && opts.sidecars).length - records.length;

  return {
    run, sources, records, sidecars,
    quarantined: defects.filter((d) => QUARANTINE_CODES.has(d.code)),
    defects,
    duplicates: duplicates < 0 ? 0 : duplicates,
    terminated, status, redacted,
    replay: { unavailable: reasons.size > 0, reasons: [...reasons] },
  };
}

function sidecarProblem(s: SidecarResolution): string {
  switch (s.state) {
    case "missing": return `the sidecar holding seq ${s.source} is not at ${s.path}; the bundle is unavailable for replay`;
    case "digest_mismatch": return `the sidecar at ${s.path} does not match its declared sha256; the bundle is unavailable for replay`;
    case "bytes_mismatch": return `the sidecar at ${s.path} is ${String(s.actual?.bytes)} bytes, not the declared ${String(s.declared.bytes)}`;
    case "escapes_bundle": return `the sidecar path ${s.path} is absolute or leaves the receipt's directory and was not read`;
    case "unparseable": return `the sidecar at ${s.path} is not a JSON object, so it holds no record`;
    case "unreadable": return `the sidecar event does not name a source, path, bytes and sha256, or its file could not be read`;
    case "intact": return "intact";
  }
}

// ---- the entry points ---------------------------------------------------------------------

function settle(opts: ReadOptions): Required<Pick<ReadOptions, "sidecars" | "validate">> {
  return { sidecars: opts.sidecars !== false, validate: opts.validate ?? validator() };
}

/** Read one receipt file. A file holding the lines of more than one run yields one bundle per run. */
export function readReceiptFile(file: string, opts: ReadOptions = {}): FileRead {
  const settled = settle(opts);
  const where = opts.where ?? "other";
  const path = resolve(file);
  const scanned = scan(path);
  const fileRun = runOfFileName(path);
  const runs = [...new Set(scanned.raw.map((r) => r.run))].sort();
  const quarantined = attribute(scanned.quarantined, runs, fileRun);
  const bundles = runs.map((run) =>
    buildBundle(
      run,
      scanned.raw.filter((r) => r.run === run),
      [{ where, receipt: path }],
      quarantined.filter((q) => q.run === run),
      settled,
    ),
  );
  return { file: path, where, run: fileRun, lines: scanned.lines, runs, quarantined, bundles };
}

/**
 * Every run in both receipt locations for a working directory. A run found in more than one
 * location is one bundle naming both files, with its records deduplicated by `(run, seq)` (§1.3).
 */
export function loadReceipts(opts: LoadOptions = {}): Load {
  const settled = settle(opts);
  const locations = receiptLocations(opts);
  const files: FileSummary[] = [];
  const rawByRun = new Map<string, Raw[]>();
  const sourcesByRun = new Map<string, BundleSource[]>();
  const quarantinedByRun = new Map<string, Defect[]>();
  const quarantined: Defect[] = [];

  for (const location of locations) {
    if (!location.present) continue;
    for (const name of readdirSync(location.dir).sort()) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(location.dir, name);
      if (!isFile(file)) continue;
      const scanned = scan(file);
      const runs = [...new Set(scanned.raw.map((r) => r.run))].sort();
      const attributed = attribute(scanned.quarantined, runs, runOfFileName(file));
      files.push({ file, where: location.where, run: runOfFileName(file), lines: scanned.lines, runs, quarantined: attributed });
      quarantined.push(...attributed);
      for (const run of runs) {
        push(rawByRun, run, scanned.raw.filter((r) => r.run === run));
        push(sourcesByRun, run, [{ where: location.where, receipt: file }]);
        push(quarantinedByRun, run, attributed.filter((q) => q.run === run));
      }
    }
  }

  const bundles = [...rawByRun.keys()].sort().map((run) =>
    buildBundle(run, rawByRun.get(run)!, sourcesByRun.get(run)!, quarantinedByRun.get(run) ?? [], settled),
  );

  const records = bundles.flatMap((b) => b.records);
  const state = (s: Validation["state"]) => records.filter((r) => r.validation.state === s).length;
  return {
    locations, files, bundles, quarantined,
    counts: {
      bundles: bundles.length,
      records: records.length,
      validated: state("validated"),
      invalid: state("invalid"),
      partial: state("partial"),
      unvalidated: state("unvalidated"),
      quarantined: quarantined.length,
      duplicates: bundles.reduce((n, b) => n + b.duplicates, 0),
    },
  };
}

function push<T>(map: Map<string, T[]>, key: string, values: T[]): void {
  const held = map.get(key);
  if (held) held.push(...values); else map.set(key, [...values]);
}
