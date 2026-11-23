// Where the receipt goes (spec §5, §5.2). The default is `.parley/receipts/<run>.jsonl` under the
// initial working directory, once hygiene is established; otherwise the XDG state directory keyed
// by a digest of the repository root; otherwise nothing, which is a startup failure. A location
// whose path carries a declared secret value is never chosen (§5.3: the path would print it).
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { sha256 } from "./inv.ts";
import { carriesSecret } from "./redact.ts";

export interface Bookkeeping { op: "create" | "append" | "delete"; scope: string }
export interface Location {
  readonly where: "repo" | "state";
  readonly receiptDir: string;
  readonly receiptPath: string;
  readonly fd: number;
  readonly warning?: { code: string; problem: string; remedy: string };
}
export interface LocationFailure { readonly code: "startup.receipt_unwritable" | "startup.secret_in_path"; readonly problem: string; readonly remedy: string }

export function repoRoot(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
}

export function stateBase(env: Record<string, string | undefined>, home = homedir()): string {
  const x = env.XDG_STATE_HOME;
  return x && isAbsolute(x) ? x : join(home, ".local", "state");
}

function stateReceiptDir(cwd: string, env: Record<string, string | undefined>, home?: string): string {
  const key = sha256(realpathSafe(repoRoot(cwd))).slice(0, 16);
  return join(stateBase(env, home), "parley", key, "receipts");
}

/** The bookkeeping a run may perform, declared ahead of time in the command line (§4.3). */
export function bookkeepingFor(cwd: string, env: Record<string, string | undefined>, home?: string): Bookkeeping[] {
  const repo = join(resolve(cwd), ".parley");
  const state = stateReceiptDir(cwd, env, home);
  return [
    { op: "create", scope: `${join(repo, "receipts")}/` },
    { op: "create", scope: join(repo, ".gitignore") },
    { op: "delete", scope: `${join(repo, "receipts")}/` },
    { op: "create", scope: `${state}/` },
    { op: "delete", scope: `${state}/` },
  ];
}

/**
 * Whether a `.gitignore` line is a negation that can match the directory `receipts` beside it.
 * With `*` in force nothing under `receipts/` can be staged unless the directory itself is
 * re-included, because git cannot re-include a file whose parent directory is excluded
 * (gitignore(5)). Conservative: a pattern this cannot evaluate (an inner `/`, a backslash, a
 * class no regex accepts) is taken to match, and the match ignores case, as git does where
 * `core.ignorecase` is set.
 */
function negationReachesReceipts(line: string): boolean {
  if (!line.startsWith("!")) return false;
  let pat = line.slice(1).replace(/ +$/, "");
  if (pat.endsWith("/")) pat = pat.slice(0, -1);
  if (pat.startsWith("/")) pat = pat.slice(1);
  while (pat.startsWith("**/")) pat = pat.slice(3);
  if (pat.includes("/") || pat.includes("\\")) return true;
  try { return new RegExp(`^${globRegex(pat)}$`, "i").test("receipts"); } catch { return true; }
}

/** One path component's glob as a regex source: `*` and `**` any run, `?` one character, a bracket a class (`!` or `^` negating it); everything else literal. The caller has already refused a backslash. */
function globRegex(pat: string): string {
  let out = "";
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i]!;
    if (c === "*") out += ".*";
    else if (c === "?") out += ".";
    else if (c === "[") {
      const j = pat.indexOf("]", i + 2);
      if (j === -1) { out += "\\["; continue; }
      let body = pat.slice(i + 1, j);
      const neg = body.startsWith("!") || body.startsWith("^");
      if (neg) body = body.slice(1);
      out += `[${neg ? "^" : ""}${body.replace(/[\]\\]/g, "\\$&")}]`;
      i = j;
    } else out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}

/**
 * §5.2: `.parley/.gitignore` containing `*`, create-if-absent and never overwrite. The file is
 * written whole to a temporary name and linked into place, so no process can read it empty.
 * Null when the file is ours to rely on; otherwise why it is a user's file: no line `*`, or a
 * negation that can re-include `receipts/` (flyingrobots/parley#109).
 */
function hygiene(parleyDir: string, nonce: string): string | null {
  mkdirSync(parleyDir, { recursive: true });
  const file = join(parleyDir, ".gitignore");
  if (!existsSync(file)) {
    const tmp = join(parleyDir, `.gitignore.${nonce}.tmp`);
    const fd = openSync(tmp, "wx");
    try { writeSync(fd, "*\n"); } finally { closeSync(fd); }
    try { linkSync(tmp, file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") { unlinkSafe(tmp); throw e; } } finally { unlinkSafe(tmp); }
  }
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  if (!lines.includes("*")) return `${file} exists without a line consisting of *`;
  const negation = lines.find(negationReachesReceipts);
  return negation === undefined ? null : `${file} has a line consisting of *, but its negation ${negation} can re-include receipts/, where git add would stage a receipt`;
}

function reserve(receiptDir: string, run: string): { receiptPath: string; fd: number } {
  mkdirSync(receiptDir, { recursive: true });
  const receiptPath = join(receiptDir, `${run}.jsonl`);
  return { receiptPath, fd: openSync(receiptPath, "wx") };
}

export function chooseLocation(opts: { cwd: string; run: string; env: Record<string, string | undefined>; home?: string; secrets?: ReadonlySet<string> }): Location | LocationFailure {
  const cwd = resolve(opts.cwd);
  const secrets = opts.secrets ?? new Set<string>();
  let warning: Location["warning"];
  const repoDir = join(cwd, ".parley", "receipts");
  if (carriesSecret(join(repoDir, `${opts.run}.jsonl`), secrets)) {
    warning = { code: "receipt.relocated", problem: "the receipt path under the working directory would carry a declared secret value, so the receipt went to the state directory", remedy: "run from a directory whose path does not contain the secret, or leave the receipt where it went" };
  } else {
    try {
      const why = hygiene(join(cwd, ".parley"), opts.run);
      if (why === null) return { where: "repo", receiptDir: repoDir, ...reserve(repoDir, opts.run) };
      warning = { code: "receipt.relocated", problem: `${why}, so it is a user's file and was left alone; the receipt went to the state directory`, remedy: "make .parley/.gitignore a line consisting of * with no negation that can match receipts, or leave the receipt where it went" };
    } catch {
      // The working directory is not usable; fall back silently (the bootstrap line says where).
    }
  }
  let stateDir: string;
  try { stateDir = stateReceiptDir(cwd, opts.env, opts.home); } catch { return unwritable(cwd); }
  if (carriesSecret(join(stateDir, `${opts.run}.jsonl`), secrets)) {
    return { code: "startup.secret_in_path", problem: "every receipt location this writer can choose has a path carrying a declared secret value; no receipt path can be printed without disclosing it", remedy: "set XDG_STATE_HOME to an absolute path that does not contain the secret, or do not pass that value as a declared secret" };
  }
  try {
    return { where: "state", receiptDir: stateDir, ...reserve(stateDir, opts.run), ...(warning ? { warning } : {}) };
  } catch {
    return unwritable(cwd);
  }
}

function unwritable(cwd: string): LocationFailure {
  return { code: "startup.receipt_unwritable", problem: `No writable receipt location: ${join(cwd, ".parley")} is not usable and the state directory is not writable`, remedy: "make .parley writable or set XDG_STATE_HOME to a writable absolute path" };
}

export function isLocationFailure(l: Location | LocationFailure): l is LocationFailure { return "code" in l; }

function realpathSafe(p: string): string { try { return realpathSync(p); } catch { return p; } }
function unlinkSafe(p: string): void { try { unlinkSync(p); } catch { /* already gone */ } }
