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
 * Whether a `.gitignore` line is a negation that can match the directory `receipts` beside it, or
 * a line this writer cannot evaluate exactly, which §5.2 says counts as one that does. With `*`
 * in force nothing under `receipts/` can be staged unless the directory itself is re-included,
 * because git cannot re-include a file whose parent directory is excluded (gitignore(5)).
 *
 * The rule, the same in the Python writer:
 *
 *   - A line holding a NUL byte is not evaluated. git reads a pattern as a C string, so the
 *     pattern it sees ends at the NUL; this writer does not guess at the rest.
 *   - Otherwise only a line that starts with `!` is a negation. Trailing spaces, one trailing
 *     `/`, one leading `/` and any leading double star with its slash are taken off.
 *   - What is left is not evaluated when it holds a `/`, a backslash, or any character outside
 *     printable ASCII (a tab, a control character, any non-ASCII letter: how git folds the case
 *     of those is its own question), or a bracket expression that is unterminated or holds
 *     `[:`, `[=` or `[.`.
 *   - Anything else is matched against `receipts` as git's wildmatch reads one path component:
 *     `*` any run, `?` one character, a bracket expression a set (`!` or `^` first negates it,
 *     the first member is literal even when it is `]`, `a-z` is a range, and a `-` after a range
 *     or beside either bracket is literal), everything else itself. The match ignores case, as
 *     git does where `core.ignorecase` is set, which only ever adds matches.
 *
 * Exported for the package's own tests, not from the index.
 */
export function negationReachesReceipts(line: string): boolean {
  if (line.includes("\u0000")) return true;
  if (!line.startsWith("!")) return false;
  let pat = line.slice(1).replace(/ +$/, "");
  if (pat.endsWith("/")) pat = pat.slice(0, -1);
  if (pat.startsWith("/")) pat = pat.slice(1);
  while (pat.startsWith("**/")) pat = pat.slice(3);
  if (pat.includes("/") || pat.includes("\\")) return true;
  if (!/^[\x20-\x7e]*$/.test(pat)) return true;
  const glob = parseGlob(pat);
  return glob === null ? true : globMatches(glob, 0, "receipts", 0);
}

/** One element of a path component's glob: any run, any one character, or a set of characters given as inclusive ranges. */
type GlobToken = { readonly kind: "star" } | { readonly kind: "any" } | { readonly kind: "set"; readonly negated: boolean; readonly ranges: readonly (readonly [string, string])[] };

/** A glob of printable ASCII with no `/` and no backslash, as tokens; `null` when it holds a bracket expression this writer does not evaluate. */
function parseGlob(pat: string): GlobToken[] | null {
  const out: GlobToken[] = [];
  const special = (j: number): boolean => pat[j] === "[" && (pat[j + 1] === ":" || pat[j + 1] === "=" || pat[j + 1] === ".");
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i]!;
    if (c === "*") { if (out.at(-1)?.kind !== "star") out.push({ kind: "star" }); continue; }
    if (c === "?") { out.push({ kind: "any" }); continue; }
    if (c !== "[") { out.push({ kind: "set", negated: false, ranges: [[c, c]] }); continue; }
    let j = i + 1;
    const negated = pat[j] === "!" || pat[j] === "^";
    if (negated) j += 1;
    const ranges: [string, string][] = [];
    let prev: string | null = null;
    for (let first = true; ; first = false) {
      if (j >= pat.length) return null; // unterminated
      const m = pat[j]!;
      if (m === "]" && !first) break;
      if (special(j)) return null;
      if (m === "-" && prev !== null && j + 1 < pat.length && pat[j + 1] !== "]") {
        if (special(j + 1)) return null;
        ranges.push([prev, pat[j + 1]!]);
        prev = null;
        j += 2;
      } else { ranges.push([m, m]); prev = m; j += 1; }
    }
    out.push({ kind: "set", negated, ranges });
    i = j;
  }
  return out;
}

/** Whether the tokens from `ti` match `text` from `si` to its end, ignoring case. `text` is lower case. */
function globMatches(glob: readonly GlobToken[], ti: number, text: string, si: number): boolean {
  if (ti === glob.length) return si === text.length;
  const tok = glob[ti]!;
  if (tok.kind === "star") {
    for (let k = si; k <= text.length; k++) if (globMatches(glob, ti + 1, text, k)) return true;
    return false;
  }
  if (si >= text.length) return false;
  if (tok.kind === "set") {
    const c = text[si]!, up = c.toUpperCase();
    const inside = tok.ranges.some(([lo, hi]) => (lo <= c && c <= hi) || (lo <= up && up <= hi));
    if (inside === tok.negated) return false;
  }
  return globMatches(glob, ti + 1, text, si + 1);
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
  if (negation === undefined) return null;
  if (!negation.startsWith("!")) return `${file} has a line consisting of *, but also a line holding a NUL byte, which this writer cannot rule out as a negation that re-includes receipts/, where git add would stage a receipt`;
  return `${file} has a line consisting of *, but its negation ${negation} can re-include receipts/, or cannot be evaluated by this writer and so counts as one that can; git add would then stage a receipt`;
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
