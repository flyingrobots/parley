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
 * §5.2: `.parley/.gitignore` containing `*`, create-if-absent and never overwrite. The file is
 * written whole to a temporary name and linked into place, so no process can read it empty.
 */
function hygiene(parleyDir: string, nonce: string): "ok" | "users_file" {
  mkdirSync(parleyDir, { recursive: true });
  const file = join(parleyDir, ".gitignore");
  if (!existsSync(file)) {
    const tmp = join(parleyDir, `.gitignore.${nonce}.tmp`);
    const fd = openSync(tmp, "wx");
    try { writeSync(fd, "*\n"); } finally { closeSync(fd); }
    try { linkSync(tmp, file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") { unlinkSafe(tmp); throw e; } } finally { unlinkSafe(tmp); }
  }
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  return lines.includes("*") ? "ok" : "users_file";
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
      if (hygiene(join(cwd, ".parley"), opts.run) === "ok") return { where: "repo", receiptDir: repoDir, ...reserve(repoDir, opts.run) };
      warning = { code: "receipt.relocated", problem: `${join(cwd, ".parley", ".gitignore")} exists without a line consisting of *, so it is a user's file and was left alone; the receipt went to the state directory`, remedy: "add a line consisting of * to .parley/.gitignore, or leave the receipt where it went" };
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
