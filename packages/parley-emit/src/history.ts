// The shared history stream (spec §8, informative). An opt-in second sink that receives the
// bytes of the local receipt, so a caller gets one timeline across tools, repositories, agents
// and people. The dependency runs one way: the stream consumes the format and the format never
// requires the stream, so nothing here can change what a run with no stream configured emits,
// and a stream that cannot be written is a warning rather than a failure.
//
// Scope and expiry (the decision flyingrobots/parley#3 left open): one stream per user per
// machine, written as dated daily segments, keeping `days` of them. Expiry deletes whole
// segments, because the stream is append-only with concurrent writers and rewriting a live
// append-only file to expire a record is the one operation that cannot be made safe. With
// `days >= 1` today's segment is never a candidate and the newest deletable one is already
// `days` days old, so no run is holding it open.
//
// Redaction (the other decision): none of its own. The sink is handed the same string the
// receipt was handed, after §5.3 has replaced every declared secret, so a credential cannot
// reach the stream unless it reached the receipt first. What is left to protect is reach rather
// than content, so the directory is owner-only, segments are owner-only, a record stored as a
// sidecar reaches the stream as its `sidecar` event and never as its stored bytes, and nothing
// is sent anywhere.
import { closeSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync, writeSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { stateBase } from "./location.ts";
import { carriesSecret } from "./redact.ts";

/** The directory the stream lives in, or an off switch. Absolute when it names a directory. */
export const HISTORY_ENV = "PARLEY_HISTORY";
/** How many daily segments to keep, today's included. */
export const HISTORY_DAYS_ENV = "PARLEY_HISTORY_DAYS";
export const HISTORY_DEFAULT_DAYS = 14;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const OFF = new Set(["0", "off", "false", "no", "none"]);
const SEGMENT = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const DAY_MS = 86_400_000;

export interface HistoryPlan {
  readonly dir: string;
  readonly path: string;
  readonly days: number;
  /** `env` when `PARLEY_HISTORY` named the directory, `state` when the known state path exists. */
  readonly source: "env" | "state";
}

export interface HistorySink {
  readonly dir: string;
  readonly path: string;
  /**
   * Append one whole line, newline included, in a single write. Throws the first time the append
   * does not land; the sink is then closed and every later append is a no-op, so one failure is
   * reported once and the run carries on.
   */
  append(line: string): void;
  close(): void;
}

export interface HistoryFailure { readonly code: "history.unavailable"; readonly problem: string; readonly remedy: string }

export function isHistoryFailure(h: HistorySink | HistoryFailure): h is HistoryFailure { return "code" in h; }

/** The segment a run started at `t` writes to: the UTC date, so one day is one file everywhere. */
export function segmentName(t: number): string { return `${new Date(t).toISOString().slice(0, 10)}.jsonl`; }

/** `PARLEY_HISTORY_DAYS` as a positive integer; anything else is the default. */
export function historyDays(env: Record<string, string | undefined>): number {
  const raw = env[HISTORY_DAYS_ENV];
  if (raw === undefined) return HISTORY_DEFAULT_DAYS;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 1 ? n : HISTORY_DEFAULT_DAYS;
}

/**
 * Where the stream is, or `null` when none is configured. `PARLEY_HISTORY` names the directory
 * and is created if absent; an off value (`0`, `off`, `false`, `no`, `none`, empty) switches the
 * stream off even when the state directory exists. With the variable unset, the known state path
 * `$XDG_STATE_HOME/parley/history` is used when it already exists, so the stream is opted into by
 * creating that directory once and never by surprise.
 */
export function resolveHistory(env: Record<string, string | undefined>, home: string | undefined, t: number): HistoryPlan | null {
  const days = historyDays(env);
  const raw = env[HISTORY_ENV];
  if (raw !== undefined) {
    const trimmed = raw.trim();
    if (trimmed === "" || OFF.has(trimmed.toLowerCase())) return null;
    return { dir: trimmed, path: join(trimmed, segmentName(t)), days, source: "env" };
  }
  let dir: string;
  try { dir = join(stateBase(env, home), "parley", "history"); } catch { return null; }
  try { if (!statSync(dir).isDirectory()) return null; } catch { return null; }
  return { dir, path: join(dir, segmentName(t)), days, source: "state" };
}

/**
 * Open the segment for appending, creating the directory owner-only when the environment named
 * it. A failure is described rather than thrown: the caller warns and the run proceeds without a
 * stream (§8 is informative and opt-in; nothing may depend on it).
 */
export function openHistory(plan: HistoryPlan, secrets: ReadonlySet<string> = new Set()): HistorySink | HistoryFailure {
  // §5.3, as for the receipt path: a path the bootstrap line cannot print without disclosing a
  // declared secret is never chosen. The receipt has nowhere else to go and fails startup; the
  // stream is optional, so it yields and the run carries on without one. The field name is
  // checked too, since a secret that is a substring of it would rename the key the line prints.
  if (carriesSecret(plan.path, secrets) || carriesSecret("history", secrets)) {
    return { code: "history.unavailable", problem: `the shared history stream's path or field name would carry a declared secret value, so no stream was used; the receipt is unaffected`, remedy: `point ${HISTORY_ENV} at a path that does not contain the secret, or do not pass that value as a declared secret` };
  }
  if (!isAbsolute(plan.dir)) {
    return { code: "history.unavailable", problem: `${HISTORY_ENV} is ${JSON.stringify(plan.dir)}, which is not an absolute path, so no shared history stream was written`, remedy: `set ${HISTORY_ENV} to an absolute directory path, or unset it to use $XDG_STATE_HOME/parley/history` };
  }
  let fd: number;
  try {
    if (plan.source === "env") mkdirSync(plan.dir, { recursive: true, mode: DIR_MODE });
    fd = openSync(plan.path, "a", FILE_MODE);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { code: "history.unavailable", problem: `the shared history stream at ${plan.path} could not be opened: ${msg}; this run wrote its receipt and nothing else`, remedy: `make the directory writable, point ${HISTORY_ENV} somewhere writable, or set ${HISTORY_ENV}=off` };
  }
  let open = true;
  return {
    dir: plan.dir,
    path: plan.path,
    append(line) {
      if (!open) return;
      try { writeWholeLine(fd, line); }
      catch (e) { open = false; try { closeSync(fd); } catch { /* already gone */ } throw e; }
    },
    close() { if (!open) return; open = false; try { closeSync(fd); } catch { /* already gone */ } },
  };
}

/**
 * One line, one write. The file is opened `O_APPEND`, so a single write of a whole line is
 * ordered against every other writer's whole-line write and the line cannot be split by them.
 * A write that reports fewer bytes is abandoned rather than continued: continuing would let
 * another writer's append land in the middle of this line, which is the failure mode worth
 * designing out. The caller then reports one failure and stops using the stream.
 */
export function writeWholeLine(fd: number, line: string, write: (fd: number, b: Uint8Array) => number = writeSync): number {
  const buf = Buffer.from(line, "utf8");
  const n = write(fd, buf);
  if (n !== buf.length) throw new Error(`the append was truncated at ${n} of ${buf.length} bytes and was not continued, because continuing would interleave with another writer`);
  return n;
}

/**
 * §5.1 for the stream: keep `days` daily segments, today's included, and delete the rest whole.
 * Files that are not dated segments are left alone. Returns the names deleted, or the names that
 * would be deleted when `dryRun`.
 */
export function retainHistory(dir: string, days: number, now: number, dryRun = false): string[] {
  const keepFrom = segmentName(now - (Math.max(1, days) - 1) * DAY_MS);
  let names: string[];
  try { names = readdirSync(dir).filter((n) => SEGMENT.test(n)); } catch { return []; }
  const stale = names.filter((n) => n < keepFrom).sort();
  if (dryRun) return stale;
  const gone: string[] = [];
  for (const n of stale) {
    try { unlinkSync(join(dir, n)); gone.push(n); } catch { /* another run deleted it first */ }
  }
  return gone;
}

/** The bookkeeping a run with a stream declares, beside the receipt's (§4.3). */
export function historyBookkeeping(sink: Pick<HistorySink, "dir" | "path">): { op: "create" | "append" | "delete"; scope: string }[] {
  return [
    { op: "create", scope: `${sink.dir}/` },
    { op: "append", scope: sink.path },
    { op: "delete", scope: `${sink.dir}/` },
  ];
}
