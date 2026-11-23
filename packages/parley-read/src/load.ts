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
//   §8    a copy of a run on the shared history stream may be a projection of the receipt copy, and
//         a reader that finds the same record in more than one copy prefers the least-projected one,
//         because the receipt copy is the record and a projection is a view of it.
//
// What this module does not do: query, rank, or recompute `inv`. It hands back what the receipts
// say, with each claim labelled by how well it is established (§1.2a).
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { sha256 } from "@flyingrobots/parley-emit";
import { readFileLines } from "./lines.ts";
import { isFile, receiptLocations, type LocateOptions, type ReceiptLocation, type Where } from "./locate.ts";
import { ENVELOPE, validator, type Validation, type Validator } from "./validate.ts";

// ---- what a load reports ------------------------------------------------------------------

export type DefectCode =
  | "line.quarantined" | "line.blank" | "line.no_envelope" | "line.unterminated"
  | "record.invalid" | "record.unknown_pair" | "copies.disagree" | "copies.projected_disagree"
  | "sidecar.missing" | "sidecar.unreadable" | "sidecar.digest_mismatch"
  | "sidecar.bytes_mismatch" | "sidecar.escapes_bundle" | "sidecar.unparseable"
  | "receipt.unreadable" | "history.unreadable";

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
  | "escapes_bundle" | "unparseable"
  /** Resolution was switched off, so nothing about the stored bytes was established either way. */
  | "unchecked";

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

/**
 * A copy of this run that says it is a **projection** of the receipt copy (§8): the source it came
 * from opened that run with a `parley.history.transform` line naming the transform that wrote it.
 * One note per source, whether or not any body differed — that a copy you read is a view of the
 * record is worth knowing either way.
 */
export interface Projection {
  /** The file whose copy of this run is a projection. */
  readonly file: string;
  readonly where: Where;
  /** What the transform is called, as its `parley.history.transform` line states it. */
  readonly name: string;
  /** SHA-256 of the transform's source text, as that line states it. */
  readonly sha256: string;
  /** The `seq` the transform line itself took; it reaches no other sink, so no other copy has it (§8). */
  readonly seq: number;
  /** The `seq` values where this copy's body differed from the record and the record was returned instead. */
  readonly superseded: readonly number[];
  /**
   * The `seq` values a copy of this run read elsewhere carries and this copy does not: lines this
   * transform withheld, rather than a gap of unknown cause. A `seq` the copy accounted for with a
   * `sidecar` event is carried, not withheld (§5).
   */
  readonly withheld: readonly number[];
  /** True when no unprojected copy of this run was read, so the records returned are this projection's. */
  readonly sole: boolean;
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
  /**
   * True when every copy of this event came from a source carrying a `parley.history.transform`
   * line for this run, so the body is a projection's and no whole copy was read (§8).
   */
  readonly projected: boolean;
  /** The transforms whose copies this body came from, named; empty when the body is an unprojected copy's. */
  readonly projectedBy: readonly string[];
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
  /** The copies of this run that said they were projections, one note per source (§8). */
  readonly projections: readonly Projection[];
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
  /** Defects that belong to no bundle, such as a receipt file that could not be read at all. */
  readonly defects: readonly Defect[];
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

export interface LoadOptions extends LocateOptions, ReadOptions {
  /**
   * Segments of the shared history stream to read beside the receipts (§8). The stream is opt-in
   * and this reader never goes looking for it: a caller that has one names it, and a segment it
   * names but cannot open is a `history.unreadable` defect rather than a throw.
   */
  readonly history?: readonly string[];
}

// ---- scanning one file --------------------------------------------------------------------

interface Raw {
  readonly file: string;
  readonly line: number;
  readonly run: string;
  readonly seq: number;
  readonly obj: Record<string, unknown>;
  /** Set when the source this line came from is a projection of this line's run (§8). */
  readonly projection?: Transform;
}

/** What a source's `parley.history.transform` line says about one run's copy in it (§8). */
type Transform = Pick<Projection, "file" | "where" | "name" | "sha256" | "seq">;

interface Note extends Transform { superseded: number[]; withheld: number[]; sole: boolean }

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

const text = (v: unknown): string => (typeof v === "string" ? v : "");
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Mark the lines of every run this source opened with a `parley.history.transform` line (§8).
 *
 * The line is **per run**, so one segment can hold a projected copy of one run beside a whole copy
 * of another, and the mark is read out of the source's own content rather than from where the file
 * is, so the preference below never depends on which file was read first. A second such line for
 * one run in one source is not a second projection: the first names the copy, and the second is a
 * copy of a `(run, seq)` like any other line.
 */
function markProjections(raw: readonly Raw[], file: string, where: Where): readonly Raw[] {
  const found = new Map<string, Transform>();
  for (const r of raw) {
    if (r.obj.event !== "history.transform" || found.has(r.run)) continue;
    found.set(r.run, { file, where, name: text(r.obj.name), sha256: text(r.obj.sha256), seq: r.seq });
  }
  if (found.size === 0) return raw;
  return raw.map((r) => {
    const projection = found.get(r.run);
    return projection === undefined ? r : { ...r, projection };
  });
}

/** The run a receipt's file name names (§5: `<run>.jsonl`). A stream segment's name names a date, not a run. */
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
  /** The transforms whose copies this body came from; empty while a copy from an unprojected source is held. */
  projectedBy: string[];
}

/**
 * Fold a line into the event at its `seq` (§1.3): the first copy is the record, a later copy
 * contributes the fields it alone carries, and a disagreement on a shared field is a defect in the
 * writer rather than a second event.
 */
function fold(held: Map<number, Held>, seq: number, obj: Record<string, unknown>, file: string, line: number, run: string, defects: Defect[], fromSidecar: boolean, projectedBy: readonly string[] = []): void {
  const seen = held.get(seq);
  if (!seen) {
    held.set(seq, { base: { ...obj }, file, line, copies: 1, fromSidecar, projectedBy: [...projectedBy] });
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

/**
 * Two copies are the same record when they carry the same keys with the same values. Key order is
 * not part of a record, and a projection is rebuilt key by key before the writer reattaches the
 * envelope, so a difference in order must not be read as a difference in the record (§1.3).
 */
function same(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => k in b && stable(a[k]) === stable(b[k]));
}

/** JSON with every object's keys in order, so two values compare by what they hold. */
function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>).sort(([x], [y]) => cmp(x, y));
  return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`).join(",")}}`;
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
  // Resolution off: say nothing was established, rather than calling an unread sidecar intact.
  // §1.2a — a reader must not take one kind of evidence for another.
  if (!read) return { resolution: { source, seq, path, resolved: target, state: "unchecked", declared } };

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

const ENVELOPE_KEYS: ReadonlySet<string> = new Set<string>(ENVELOPE);

function envelopeDefect(key: string, r: Raw, run: string): Defect {
  return defect("copies.disagree", "§1.3", r.file, r.line, `seq ${r.seq}: a projected copy disagrees with the record on ${key}, which a projection never changes`, { run });
}

/**
 * Fold the projected copies over the records already held, and return one note per source (§8).
 *
 * The preference: where a copy from an unprojected source is already held, that body is the record
 * and a projected copy that differs from it is **superseded** — recorded as the projection it is,
 * by the transform that wrote it, rather than reported as a writer's disagreement under §1.3. A
 * `seq` no unprojected copy carries is taken from the projected copies and marked as theirs, so a
 * reader that can see only a projection still gets the record and is told what it is.
 *
 * Two projected copies of one `(run, seq)` are the edge the rule cannot settle: neither is the
 * less projected one. They are folded under §1.3 as copies, in an order stated by the transform's
 * name, its digest and the file — never the order the files were read in, which is the failure
 * mode this rule exists to remove — and a disagreement between them on a body field is reported
 * under its own code, because two views of one record were never required to agree.
 *
 * §8 lets a projection narrow the **body**. It never changes the envelope, so a projected copy
 * that disagrees on `event`, `t` or `_schema` is §1.3's defect in whatever wrote it and is
 * reported as one, whichever copy the preference returned.
 */
function foldProjections(run: string, raw: readonly Raw[], held: Map<number, Held>, defects: Defect[], sole: boolean): Note[] {
  const projected = raw
    .filter((r): r is Raw & { projection: Transform } => r.projection !== undefined)
    .sort((a, b) =>
      cmp(a.projection.name, b.projection.name) || cmp(a.projection.sha256, b.projection.sha256) ||
      cmp(a.projection.file, b.projection.file) || a.line - b.line);
  const notes = new Map<string, Note>();
  for (const r of projected) {
    let note = notes.get(r.projection.file);
    if (note === undefined) {
      note = { ...r.projection, superseded: [], withheld: [], sole };
      notes.set(r.projection.file, note);
    }
    const seen = held.get(r.seq);
    if (seen === undefined) {
      held.set(r.seq, { base: { ...r.obj }, file: r.file, line: r.line, copies: 1, fromSidecar: false, projectedBy: [r.projection.name] });
      continue;
    }
    seen.copies += 1;
    if (seen.projectedBy.length === 0) {
      for (const key of ENVELOPE) {
        if (!(key in r.obj) || !(key in seen.base) || stable(seen.base[key]) === stable(r.obj[key])) continue;
        defects.push(envelopeDefect(key, r, run));
      }
      if (!same(seen.base, r.obj) && !note.superseded.includes(r.seq)) note.superseded.push(r.seq);
      continue;
    }
    if (!seen.projectedBy.includes(r.projection.name)) seen.projectedBy.push(r.projection.name);
    for (const [key, value] of Object.entries(r.obj)) {
      if (!(key in seen.base)) { seen.base[key] = value; continue; }
      if (stable(seen.base[key]) === stable(value)) continue;
      defects.push(ENVELOPE_KEYS.has(key)
        ? envelopeDefect(key, r, run)
        : defect("copies.projected_disagree", "§8", r.file, r.line, `seq ${r.seq}: two projections of one event disagree on ${key}, and neither copy is the less projected one, so neither is preferred`, { run }));
    }
  }
  return [...notes.values()];
}

function buildBundle(run: string, raw: readonly Raw[], sources: readonly BundleSource[], quarantined: readonly Defect[], opts: Required<Pick<ReadOptions, "sidecars" | "validate">>): Bundle {
  const defects: Defect[] = [...quarantined];
  const held = new Map<number, Held>();

  // §8: the receipt copy is the record and a projection is a view of it. So the copies from the
  // sources that say nothing about a transform are folded first and alone, under §1.3 as before,
  // and a projected copy never contributes a field to them — a view of a record cannot add to it.
  const whole = raw.filter((r) => r.projection === undefined);
  for (const r of whole) fold(held, r.seq, r.obj, r.file, r.line, run, defects, false);

  const notes = foldProjections(run, raw, held, defects, whole.length === 0);

  // Sidecars stand in a record's place: resolve them, then fold the record each one holds back in
  // at the `seq` it names, so a caller reading the records does not have to know where a record
  // was stored (§5).
  const sidecars: SidecarResolution[] = [];
  for (const [seq, entry] of [...held.entries()].sort((a, b) => a[0] - b[0])) {
    if (entry.base.event !== "sidecar") continue;
    const { resolution, stored } = resolveSidecar(seq, entry, opts.sidecars);
    sidecars.push(resolution);
    if (resolution.state === "unchecked") continue; // nothing was looked at, so nothing is a defect
    if (resolution.state !== "intact") {
      defects.push(defect(`sidecar.${resolution.state}` as DefectCode, SIDECAR_SECTION, entry.file, entry.line, sidecarProblem(resolution), { run, source: resolution.source >= 0 ? resolution.source : undefined }));
      continue;
    }
    if (stored) fold(held, resolution.source, stored, entry.file, entry.line, run, defects, true, entry.projectedBy);
  }

  // Which `seq` values this run is known by at all, the projections' own opening lines aside: a
  // line that reaches the stream alone is not one any other copy could be withholding (§8).
  const known = [...held.entries()]
    .filter(([, e]) => e.base.event !== "history.transform")
    .map(([seq]) => seq);
  for (const note of notes) {
    const own = raw.filter((r) => r.projection?.file === note.file);
    const carried = new Set(own.map((r) => r.seq));
    const stored = new Set(own.filter((r) => r.obj.event === "sidecar" && Number.isInteger(r.obj.source)).map((r) => r.obj.source as number));
    note.withheld = known.filter((seq) => !carried.has(seq) && !stored.has(seq)).sort((a, b) => a - b);
    note.superseded.sort((a, b) => a - b);
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
        projected: entry.projectedBy.length > 0, projectedBy: [...entry.projectedBy],
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
    run, sources, records, sidecars, projections: notes,
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
    case "unchecked": return `the sidecar at ${s.path} was not resolved, so nothing about its stored bytes is established`;
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
  const raw = markProjections(scanned.raw, path, where);
  const fileRun = where === "history" ? null : runOfFileName(path);
  const runs = [...new Set(raw.map((r) => r.run))].sort();
  const quarantined = attribute(scanned.quarantined, runs, fileRun);
  const bundles = runs.map((run) =>
    buildBundle(
      run,
      raw.filter((r) => r.run === run),
      [{ where, receipt: path }],
      quarantined.filter((q) => q.run === run),
      settled,
    ),
  );
  return { file: path, where, run: fileRun, lines: scanned.lines, runs, quarantined, bundles };
}

/**
 * Read one segment of the shared history stream (§8): a file holding whole runs from every tool
 * that wrote to it, so it yields one bundle per run, and a copy in it may be a projection of the
 * receipt copy. It is `readReceiptFile` under the `history` label, because a segment is the same
 * bytes under the same reader rules; what differs is that its name names a date rather than a run.
 */
export function readHistorySegment(file: string, opts: ReadOptions = {}): FileRead {
  return readReceiptFile(file, { ...opts, where: "history" });
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
  const loose: Defect[] = [];

  // One file that cannot be opened is reported, not thrown: a load over a repository's history
  // should not lose the other bundles to it.
  const take = (file: string, where: Where): void => {
    const fileRun = where === "history" ? null : runOfFileName(file);
    let scanned: Scan;
    try { scanned = scan(file); } catch (e) {
      const what = where === "history" ? "the history segment" : "the receipt";
      const code: DefectCode = where === "history" ? "history.unreadable" : "receipt.unreadable";
      const problem = `${what} could not be read: ${e instanceof Error ? e.message : String(e)}`;
      loose.push(defect(code, where === "history" ? "§8" : "§5", file, 0, problem, { run: fileRun }));
      files.push({ file, where, run: fileRun, lines: 0, runs: [], quarantined: [] });
      return;
    }
    const raw = markProjections(scanned.raw, file, where);
    const runs = [...new Set(raw.map((r) => r.run))].sort();
    const attributed = attribute(scanned.quarantined, runs, fileRun);
    files.push({ file, where, run: fileRun, lines: scanned.lines, runs, quarantined: attributed });
    quarantined.push(...attributed);
    for (const run of runs) {
      push(rawByRun, run, raw.filter((r) => r.run === run));
      push(sourcesByRun, run, [{ where, receipt: file }]);
      push(quarantinedByRun, run, attributed.filter((q) => q.run === run));
    }
  };

  for (const location of locations) {
    if (!location.present) continue;
    for (const name of readdirSync(location.dir).sort()) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(location.dir, name);
      if (!isFile(file)) continue;
      take(file, location.where);
    }
  }

  // The shared stream is opt-in and this reader never goes looking for it (§8): a caller that has
  // a segment names it, and it is read after the receipts, so a projected copy is folded over the
  // record rather than the other way round. Which copy wins does not depend on that order — the
  // preference is by the transform line — but the order is stated rather than incidental.
  for (const named of opts.history ?? []) take(resolve(named), "history");

  const bundles = [...rawByRun.keys()].sort().map((run) =>
    buildBundle(run, rawByRun.get(run)!, sourcesByRun.get(run)!, quarantinedByRun.get(run) ?? [], settled),
  );

  const records = bundles.flatMap((b) => b.records);
  const state = (s: Validation["state"]) => records.filter((r) => r.validation.state === s).length;
  return {
    locations, files, bundles, quarantined, defects: loose,
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
