// Where the receipt goes (spec §5, §5.2). The default is `.parley/receipts/<run>.jsonl` under the
// initial working directory, once hygiene is established; otherwise the XDG state directory keyed
// by a digest of the repository root; otherwise nothing, which is a startup failure.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { sha256 } from "./inv.ts";

export interface Bookkeeping { op: "create" | "append" | "delete"; scope: string }
export interface Location {
  readonly where: "repo" | "state";
  readonly receiptDir: string;
  readonly receiptPath: string;
  readonly fd: number;
  readonly warning?: { code: string; problem: string; remedy: string };
}

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

/** The bookkeeping a run may perform, declared ahead of time in the command line (§4.3). */
export function bookkeepingFor(cwd: string, env: Record<string, string | undefined>, home?: string): Bookkeeping[] {
  const repo = join(resolve(cwd), ".parley");
  return [
    { op: "create", scope: `${join(repo, "receipts")}/` },
    { op: "create", scope: join(repo, ".gitignore") },
    { op: "delete", scope: `${join(repo, "receipts")}/` },
    { op: "create", scope: `${join(stateBase(env, home), "parley")}/` },
  ];
}

/** §5.2: create `.parley/.gitignore` containing `*` if absent; never overwrite; a user's file without `*` is a reason to go elsewhere. */
function hygiene(parleyDir: string): "ok" | "users_file" {
  mkdirSync(parleyDir, { recursive: true });
  const file = join(parleyDir, ".gitignore");
  try {
    const fd = openSync(file, "wx");
    try { writeSync(fd, "*\n"); } finally { closeSync(fd); }
    return "ok";
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  return lines.includes("*") ? "ok" : "users_file";
}

function reserve(receiptDir: string, run: string): { receiptPath: string; fd: number } {
  mkdirSync(receiptDir, { recursive: true });
  const receiptPath = join(receiptDir, `${run}.jsonl`);
  return { receiptPath, fd: openSync(receiptPath, "wx") };
}

export function chooseLocation(opts: { cwd: string; run: string; env: Record<string, string | undefined>; home?: string }): Location | null {
  const cwd = resolve(opts.cwd);
  let warning: Location["warning"];
  try {
    const parleyDir = join(cwd, ".parley");
    if (hygiene(parleyDir) === "ok") {
      const receiptDir = join(parleyDir, "receipts");
      return { where: "repo", receiptDir, ...reserve(receiptDir, opts.run) };
    }
    warning = { code: "receipt.relocated", problem: `${join(parleyDir, ".gitignore")} exists without a line consisting of *, so it is a user's file and was left alone; the receipt went to the state directory`, remedy: "add a line consisting of * to .parley/.gitignore, or leave the receipt where it went" };
  } catch {
    // The working directory is not usable; fall back.
  }
  try {
    const key = sha256(realpathSafe(repoRoot(cwd))).slice(0, 16);
    const receiptDir = join(stateBase(opts.env, opts.home), "parley", key, "receipts");
    return { where: "state", receiptDir, ...reserve(receiptDir, opts.run), ...(warning ? { warning } : {}) };
  } catch {
    return null;
  }
}

function realpathSafe(p: string): string { try { return realpathSync(p); } catch { return p; } }
