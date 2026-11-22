// Where receipts are, for a given working directory (spec §5, §5.2).
//
// A writer resolves its receipt location once at startup: `.parley/receipts/<run>.jsonl` under the
// invocation's **initial** working directory when hygiene can be established there, and otherwise
// `$XDG_STATE_HOME/parley/<repo-hash>/receipts/<run>.jsonl`, where `<repo-hash>` is a digest of
// the canonical path of the git worktree root. Either location may hold runs, so a reader looks in
// both.
//
// The repo-hash derivation and the state-directory base come from the writer
// (`@flyingrobots/parley-emit`) rather than being written out a second time here: a reader that
// derives the key differently by a byte looks in an empty directory and reports, honestly and
// uselessly, that there are no receipts.
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { repoRoot, sha256, stateBase } from "@flyingrobots/parley-emit";

/** Which of the spec's two locations a bundle came from; `other` is a path a caller named itself. */
export type Where = "repo" | "state" | "other";

export interface ReceiptLocation {
  readonly where: "repo" | "state";
  readonly dir: string;
  /** Whether the directory exists. A location that does not exist is not an error: the writer never needed it. */
  readonly present: boolean;
}

export interface LocateOptions {
  /** The working directory whose receipts to find; defaults to the process's. */
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly home?: string;
}

/** `<cwd>/.parley/receipts` — the writer's default, under the working directory it was invoked in. */
export function repoReceiptDir(cwd: string): string {
  return join(resolve(cwd), ".parley", "receipts");
}

/** The state-directory fallback for this working directory's repository (§5). */
export function stateReceiptDir(opts: LocateOptions = {}): string {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const key = sha256(canonicalPath(repoRoot(cwd))).slice(0, 16);
  return join(stateBase(opts.env ?? process.env, opts.home ?? homedir()), "parley", key, "receipts");
}

/** Both locations the writer could have chosen for this working directory, repo first. Creates nothing. */
export function receiptLocations(opts: LocateOptions = {}): ReceiptLocation[] {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const dirs: { where: "repo" | "state"; dir: string }[] = [
    { where: "repo", dir: repoReceiptDir(cwd) },
    { where: "state", dir: stateReceiptDir({ ...opts, cwd }) },
  ];
  return dirs.map(({ where, dir }) => ({ where, dir, present: isDirectory(dir) }));
}

export function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

export function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

function canonicalPath(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}
