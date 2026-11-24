#!/usr/bin/env bun
// Release eligibility (flyingrobots/parley#145). The rule this enforces, stated in
// docs/workflows/release-spec/README.md:
//
//   A stable Parley distribution MUST NOT embed, advertise, or emit a repository-owned protocol
//   schema identity unless that exact (id, version) has been released and resolves to its frozen
//   definition. Release checks MUST inspect the distributable artifact, and publication MUST be
//   bound to the checked candidate.
//
// Three phases. `development` reports each package's eligibility and refuses only an inconsistent
// source; `candidate` judges a release pull request, admitting the snapshots and the dated heading
// it adds; `publication` requires them at the baseline. The baseline is a git ref the candidate did
// not choose (`--base`, default the merge base with origin/main): released snapshots are compared
// with it, never only with the tree under test.
//
// This is repository tooling (see AGENTS.md): JSON Lines stamped `parley.tooling.release_check`,
// schema beside the script, no run identity and no claim to the protocol. `--human` prints prose.
// Exit: 0 passed, 1 refused, 2 the check could not run.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

export const OUTPUT_SCHEMA = { id: "parley.tooling.release_check", version: "1.0.0" } as const;

export type Phase = "development" | "candidate" | "publication";
export const PHASES: readonly Phase[] = ["development", "candidate", "publication"];

export type Code =
  | "artifact.unreadable" | "inventory.unreadable" | "inventory.empty" | "inventory.declared_not_bundled"
  | "copy.stale" | "toplevel.differs"
  | "schema.unreleased" | "release.heading_missing" | "release.not_accepted" | "definition.differs"
  | "snapshot.modified" | "snapshot.deleted" | "snapshot.mismatched" | "baseline.unresolved"
  | "pin.malformed" | "pin.commit_missing" | "pin.unreachable" | "pin.content_differs" | "pin.bundle_differs";

/** What `development` refuses: an inconsistent source. Everything else it reports as a blocker. */
const INCONSISTENT: ReadonlySet<Code> = new Set<Code>([
  "artifact.unreadable", "inventory.unreadable", "inventory.empty", "inventory.declared_not_bundled",
  "copy.stale", "toplevel.differs", "snapshot.modified", "snapshot.deleted", "snapshot.mismatched", "pin.malformed",
]);

export interface Baseline { event: "release.baseline"; phase: Phase; base: string; commit: string | null; resolved: boolean; snapshots: number }
export interface Refusal { event: "release.refusal"; phase: Phase; package: string | null; code: Code; problem: string; id?: string; version?: string; path?: string }
export interface PackageLine {
  event: "release.package"; phase: Phase; package: string; version: string | null; source: "tree" | "artifact"; path: string;
  /** The SHA-256 of the artifact's bytes; null for a source tree, which is not one file. */
  sha256: string | null;
  /** The commit the bundled schemas are pinned to. */
  pin: string | null;
  bundled: number; declared: number;
  /** No refusal names this package in this phase. */
  passed: boolean;
  /** `publication` would pass for it against this baseline. */
  eligible: boolean;
  /** The schema identities that stand between this package and a stable release, and why. */
  blocking: { id: string; version: string; code: Code }[];
  /** Whatever else does, by code. */
  blockers: Code[];
}
export interface Summary { event: "release.summary"; phase: Phase; passed: boolean; packages: number; eligible: string[]; not_eligible: string[]; refusals: number }
export interface Help { event: "release.help"; usage: string; intent: string; phases: Record<Phase, string>; exit: Record<"0" | "1" | "2", string> }
export interface Failure { event: "error"; code: string; problem: string }
export type Line = Baseline | Refusal | PackageLine | Summary | Help | Failure;

export interface Options {
  phase: Phase;
  /** The repository: where the snapshots, the changelog and the git history are. Default: the working directory. */
  repo?: string;
  /** The trusted baseline, a git ref. Default: the merge base of HEAD and origin/main. */
  base?: string;
  /** Packed artifacts to inspect in place of the source tree: npm tarballs and vendorable `.py` files. */
  artifacts?: string[];
}

/** The check could not run at all: a usage error, or a repository that is not one. */
export class CheckError extends Error {
  constructor(readonly code: string, problem: string) { super(problem); }
}

// ---- shared with scripts/schemas.test.ts: what the changelog and the snapshot tree say ----------

/** The `## [Unreleased]` entry, and every dated release entry joined, of a root `CHANGELOG.md`. */
export function changelogEntries(changelog: string): { unreleased: string; dated: string } {
  const unreleased = /^## \[Unreleased\]\n([\s\S]*?)(?=^## \[|(?![\s\S]))/m.exec(changelog)?.[1] ?? "";
  const dated = changelog.split(/^(?=## \[)/m).filter((e) => /^## \[\d+\.\d+\.\d+\] — \d{4}-\d{2}-\d{2}/.test(e)).join("\n");
  return { unreleased, dated };
}
/** Whether a changelog entry names a schema version, in the form every entry uses: `` `id` version ``. */
export function names(entry: string, id: string, version: string): boolean {
  return new RegExp("`" + id.replace(/\./g, "\\.") + "` " + version.replace(/\./g, "\\.") + "\\b").test(entry);
}
/** Where a released version's snapshot lives (spec §4.6), relative to the repository root. */
export const snapshotPath = (id: string, version: string) => `schemas/released/${id}/${version}.schema.json`;
const SNAPSHOT = /^schemas\/released\/([^/]+)\/(\d+\.\d+\.\d+)\.schema\.json$/;

// ---- small tools ----------------------------------------------------------------------------

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
/** A JSON value with every object's keys sorted: two schemas are one definition when these are equal (flyingrobots/parley#116). */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => `${JSON.stringify(k)}:${canon(x)}`).join(",")}}`;
  return JSON.stringify(v);
}
function parseJson(text: string | Uint8Array): unknown {
  try { return JSON.parse(typeof text === "string" ? text : Buffer.from(text).toString("utf8")); } catch { return undefined; }
}
interface Pair { id: string; version: string }
const key = (p: Pair) => `${p.id}@${p.version}`;
/** The pair a schema document pins by `const` (spec §4.5), or null when it pins none. */
function pairOf(doc: unknown): Pair | null {
  const pin = (doc as { properties?: { _schema?: { properties?: { id?: { const?: unknown }; version?: { const?: unknown } } } } } | undefined)?.properties?._schema?.properties;
  return typeof pin?.id?.const === "string" && typeof pin.version?.const === "string" ? { id: pin.id.const, version: pin.version.const } : null;
}

class Git {
  private shown = new Map<string, Buffer | null>();
  constructor(readonly repo: string) {}
  run(...args: string[]): { ok: boolean; out: Buffer } {
    const r = spawnSync("git", ["-C", this.repo, ...args], { maxBuffer: 256 * 1024 * 1024 });
    return { ok: r.status === 0, out: r.stdout ?? Buffer.alloc(0) };
  }
  /** The commit a ref names, or null. A ref is data here, so one that looks like an option names nothing. */
  commit(ref: string): string | null {
    if (ref === "" || ref.startsWith("-")) return null;
    const r = this.run("rev-parse", "--quiet", "--verify", `${ref}^{commit}`);
    return r.ok ? r.out.toString("utf8").trim() : null;
  }
  isAncestor(commit: string, of: string): boolean { return this.run("merge-base", "--is-ancestor", commit, of).ok; }
  /** A file's bytes at a commit, or null when the commit holds no such file. */
  show(commit: string, path: string): Buffer | null {
    const k = `${commit}:${path}`;
    if (!this.shown.has(k)) { const r = this.run("show", k); this.shown.set(k, r.ok ? r.out : null); }
    return this.shown.get(k) ?? null;
  }
  list(commit: string, dir: string): string[] {
    const r = this.run("ls-tree", "-r", "--name-only", "-z", commit, "--", dir);
    return r.ok ? r.out.toString("utf8").split("\0").filter(Boolean) : [];
  }
}

/** One state of the repository: the working tree, or a commit. */
interface State { changelog(): { unreleased: string; dated: string }; snapshot(id: string, version: string): Buffer | null; snapshots(): string[]; read(path: string): Buffer | null }

function workingTree(repo: string): State {
  const read = (path: string) => { try { return readFileSync(join(repo, path)); } catch { return null; } };
  let entries: { unreleased: string; dated: string } | undefined;
  return {
    read,
    changelog: () => (entries ??= changelogEntries(read("CHANGELOG.md")?.toString("utf8") ?? "")),
    snapshot: (id, version) => read(snapshotPath(id, version)),
    snapshots: () => {
      const dir = join(repo, "schemas/released");
      if (!existsSync(dir)) return [];
      return readdirSync(dir).filter((id) => statSync(join(dir, id)).isDirectory())
        .flatMap((id) => readdirSync(join(dir, id)).map((f) => `schemas/released/${id}/${f}`)).filter((p) => SNAPSHOT.test(p)).sort();
    },
  };
}
function atCommit(git: Git, commit: string): State {
  let entries: { unreleased: string; dated: string } | undefined;
  let paths: string[] | undefined;
  return {
    read: (path) => git.show(commit, path),
    changelog: () => (entries ??= changelogEntries(git.show(commit, "CHANGELOG.md")?.toString("utf8") ?? "")),
    snapshot: (id, version) => ((paths ??= git.list(commit, "schemas/released")).includes(snapshotPath(id, version)) ? git.show(commit, snapshotPath(id, version)) : null),
    snapshots: () => (paths ??= git.list(commit, "schemas/released")).filter((p) => SNAPSHOT.test(p)).sort(),
  };
}

// ---- the inventory: what a package bundles and what it declares -------------------------------

interface Bundled extends Pair { schema: unknown; /** The pinned file it was copied from, when the bundle says. */ file: string | null; /** Its exact text, when the bundle keeps it. */ text: string | null }
interface Inventory {
  name: string; version: string | null; source: "tree" | "artifact"; path: string; sha256: string | null;
  pin: { commit: string; files: Record<string, string> } | null;
  bundled: Bundled[]; declared: Pair[];
  /** Set when there is no inventory to judge. */
  unreadable?: { code: "artifact.unreadable" | "inventory.unreadable"; problem: string };
}

/**
 * The identities a source file stamps: every literal `{ id: "parley.…", version: "X.Y.Z" }`, in
 * TypeScript or Python spelling. A `parley.tooling.*` id is a tool-owned schema, which the rule
 * does not govern.
 */
const DECLARED = /\{\s*"?id"?\s*:\s*"(parley\.[a-z0-9_.]+)"\s*,\s*"?version"?\s*:\s*"(\d+\.\d+\.\d+)"\s*\}/g;
function declaredIn(source: string): Pair[] {
  const out = new Map<string, Pair>();
  for (const m of source.matchAll(DECLARED)) {
    const p = { id: m[1] ?? "", version: m[2] ?? "" };
    if (!p.id.startsWith("parley.tooling.")) out.set(key(p), p);
  }
  return [...out.values()];
}
const CODE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
function codeFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  if (statSync(root).isFile()) return CODE.test(root) ? [root] : [];
  return readdirSync(root).filter((n) => n !== "node_modules").flatMap((n) => codeFiles(join(root, n))).sort();
}

/** `src/schemas.ts` as `scripts/sync-schemas.ts` writes it. Read as text: nothing from a candidate is executed. */
function parseTsBundle(source: string): Pick<Inventory, "pin" | "bundled"> | null {
  const pin = /^export const SCHEMA_SOURCE = \{ commit: ("(?:[^"\\]|\\.)*"), files: (\{[\s\S]*?\}) \} as const;$/m.exec(source);
  const all = /^export const SCHEMAS: ReadonlyArray<[^\n]*> = (\[[\s\S]*\]);$/m.exec(source);
  if (!pin || !all) return null;
  const commit = parseJson(pin[1] ?? ""), files = parseJson(pin[2] ?? ""), schemas = parseJson(all[1] ?? "");
  if (typeof commit !== "string" || !files || typeof files !== "object" || Array.isArray(files) || !Array.isArray(schemas)) return null;
  if (Object.values(files).some((d) => typeof d !== "string")) return null;
  const bundled: Bundled[] = [];
  for (const s of schemas as { id?: unknown; version?: unknown; schema?: unknown }[]) {
    if (typeof s?.id !== "string" || typeof s.version !== "string" || !s.schema || typeof s.schema !== "object") return null;
    bundled.push({ id: s.id, version: s.version, schema: s.schema, file: null, text: null });
  }
  return { pin: { commit, files: files as Record<string, string> }, bundled };
}

const PY_BEGIN = "# BEGIN SCHEMAS\n", PY_END = "# END SCHEMAS\n";
/** The block `scripts/sync_schemas.py` embeds in `parley_emit.py`, and the file without it. Read as text. */
function parsePyBundle(source: string): (Pick<Inventory, "pin" | "bundled"> & { rest: string }) | null {
  const start = source.indexOf(PY_BEGIN), stop = source.indexOf(PY_END);
  if (start < 0 || stop < start) return null;
  const block = source.slice(start + PY_BEGIN.length, stop).split("\n");
  const head = /^SCHEMA_SOURCE: Dict\[str, Any\] = \{"commit": ("(?:[^"\\]|\\.)*"), "files": \{$/.exec(block[0] ?? "");
  const commit = head ? parseJson(head[1] ?? "") : undefined;
  if (typeof commit !== "string") return null;
  const files: Record<string, string> = {}, texts: Record<string, string> = {};
  let into: Record<string, string> | null = files;
  for (const line of block.slice(1)) {
    if (line === "}}") { into = null; continue; }
    if (line === "_SCHEMA_TEXT: Dict[str, str] = {") { into = texts; continue; }
    if (line === "}" || line === "") { if (line === "}") into = null; continue; }
    const entry = parseJson(`{${line.trim().replace(/,$/, "")}}`);
    if (into === null || !entry || typeof entry !== "object") return null;
    for (const [k, v] of Object.entries(entry)) { if (typeof v !== "string") return null; into[k] = v; }
  }
  const bundled: Bundled[] = [];
  for (const [file, text] of Object.entries(texts)) {
    const doc = parseJson(text), pair = pairOf(doc);
    if (!pair) return null;
    bundled.push({ ...pair, schema: doc, file, text });
  }
  return { pin: { commit, files }, bundled, rest: source.slice(0, start) + source.slice(stop + PY_END.length) };
}

function readPyFile(file: string, as: Pick<Inventory, "name" | "source" | "path" | "sha256">): Inventory {
  const source = readFileSync(file, "utf8");
  const version = /^__version__\s*=\s*"([^"]+)"/m.exec(source)?.[1] ?? null;
  const parsed = parsePyBundle(source);
  if (!parsed) return { ...as, version, pin: null, bundled: [], declared: [], unreadable: { code: "inventory.unreadable", problem: `${basename(file)} holds no schema block in the form scripts/sync_schemas.py writes, between "# BEGIN SCHEMAS" and "# END SCHEMAS"` } };
  return { ...as, version, pin: parsed.pin, bundled: parsed.bundled, declared: declaredIn(parsed.rest) };
}

/**
 * A package directory: a source package, or the `package/` directory of an unpacked npm tarball.
 * `shipped` names what a consumer receives. In a tarball that is everything; in a source package
 * it is the manifest's `files`, so a test that stamps a wrong pair on purpose is not a declaration.
 */
function readPackageDir(dir: string, as: Pick<Inventory, "source" | "path" | "sha256">, everything: boolean): Inventory {
  const manifest = parseJson(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown; version?: unknown; files?: unknown } | undefined;
  const name = typeof manifest?.name === "string" ? manifest.name : basename(as.path);
  const version = typeof manifest?.version === "string" ? manifest.version : null;
  const bundle = join(dir, "src/schemas.ts");
  if (existsSync(bundle)) {
    const parsed = parseTsBundle(readFileSync(bundle, "utf8"));
    if (!parsed) return { ...as, name, version, pin: null, bundled: [], declared: [], unreadable: { code: "inventory.unreadable", problem: "src/schemas.ts is not in the form scripts/sync-schemas.ts writes: no SCHEMA_SOURCE pin and SCHEMAS list could be read from it" } };
    const roots = everything || !Array.isArray(manifest?.files) ? [dir] : manifest.files.filter((f): f is string => typeof f === "string").map((f) => join(dir, f));
    const declared = new Map<string, Pair>();
    for (const f of roots.flatMap(codeFiles)) if (resolve(f) !== resolve(bundle)) for (const p of declaredIn(readFileSync(f, "utf8"))) declared.set(key(p), p);
    return { ...as, name, version, ...parsed, declared: [...declared.values()] };
  }
  const py = readdirSync(dir).filter((f) => f.endsWith(".py")).sort();
  for (const f of py) {
    const inv = readPyFile(join(dir, f), { ...as, name });
    if (!inv.unreadable) return inv;
  }
  return { ...as, name, version, pin: null, bundled: [], declared: [], unreadable: { code: "inventory.unreadable", problem: "the package holds neither src/schemas.ts nor a .py file with an embedded schema block, so it has no schema inventory to read" } };
}

function readArtifact(path: string): Inventory {
  const as = { name: basename(path), version: null, source: "artifact" as const, path, sha256: null, pin: null, bundled: [], declared: [] };
  const unreadable = (problem: string): Inventory => ({ ...as, unreadable: { code: "artifact.unreadable", problem } });
  let bytes: Buffer;
  try { bytes = readFileSync(path); } catch (e) { return unreadable(`the artifact could not be read: ${(e as Error).message}`); }
  const digest = sha256(bytes);
  if (path.endsWith(".py")) return readPyFile(path, { name: basename(path), source: "artifact", path, sha256: digest });
  if (!/\.(tgz|tar\.gz)$/.test(path)) return { ...unreadable("the artifact is neither an npm tarball (.tgz) nor a vendorable .py file"), sha256: digest };
  const dir = mkdtempSync(join(tmpdir(), "parley-release-check-"));
  try {
    const r = spawnSync("tar", ["-xzf", path, "-C", dir], { encoding: "utf8" });
    if (r.status !== 0) return { ...unreadable(`the tarball could not be unpacked: ${(r.stderr || "tar failed").trim().split("\n")[0]}`), sha256: digest };
    if (!existsSync(join(dir, "package/package.json"))) return { ...unreadable("the tarball holds no package/package.json, so it is not an npm package"), sha256: digest };
    return readPackageDir(join(dir, "package"), { source: "artifact", path, sha256: digest }, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---- the rules --------------------------------------------------------------------------------

interface Finding { code: Code; problem: string; id?: string; version?: string; path?: string }
interface World { git: Git; head: string | null; tree: State; base: State | null; baseCommit: string | null; treeIndex: Map<string, { path: string; value: unknown }> }

/** Every schema the working tree holds, by pair: the top-level file where there is one, else the snapshot. */
function indexTree(repo: string, tree: State): World["treeIndex"] {
  const out = new Map<string, { path: string; value: unknown }>();
  const dir = join(repo, "schemas");
  const top = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".schema.json")).sort().map((f) => `schemas/${f}`) : [];
  for (const path of [...top, ...tree.snapshots()]) {
    const value = parseJson(tree.read(path) ?? ""), pair = pairOf(value);
    if (pair && !out.has(key(pair))) out.set(key(pair), { path, value });
  }
  return out;
}

/** What is wrong with the repository itself, whichever package is asked about. */
function repositoryFindings(w: World, repo: string, baseLabel: string): Finding[] {
  const out: Finding[] = [];
  if (!w.base) out.push({ code: "baseline.unresolved", problem: `the baseline ${baseLabel} names no commit in this repository, so released snapshots cannot be compared with anything the candidate did not choose` });
  for (const path of w.base?.snapshots() ?? []) {
    const was = w.base?.read(path), now = w.tree.read(path);
    if (!was) continue;
    if (!now) out.push({ code: "snapshot.deleted", path, problem: `${path} is a released snapshot at the baseline and is gone; a released version is immutable (spec §4.5)` });
    else if (!was.equals(now)) out.push({ code: "snapshot.modified", path, problem: `${path} is a released snapshot whose bytes differ from the baseline's; a released version is immutable, so a change needs a new version (spec §4.5)` });
  }
  for (const path of w.tree.snapshots()) {
    const m = SNAPSHOT.exec(path), doc = parseJson(w.tree.read(path) ?? "") as { $id?: unknown } | undefined, pair = pairOf(doc);
    const want = `${m?.[1]}@${m?.[2]}`;
    if (!pair || key(pair) !== want || !String(doc?.$id ?? "").endsWith(`/schemas/${m?.[1]}/${m?.[2]}`))
      out.push({ code: "snapshot.mismatched", path, problem: `${path} does not hold the definition of ${want}: its $id and _schema name ${pair ? key(pair) : "no pair"}` });
  }
  const dir = join(repo, "schemas");
  for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith(".schema.json")).sort() : []) {
    const path = `schemas/${f}`, value = parseJson(w.tree.read(path) ?? ""), pair = pairOf(value);
    const snap = pair ? w.tree.snapshot(pair.id, pair.version) : null;
    if (pair && snap && canon(parseJson(snap)) !== canon(value))
      out.push({ code: "toplevel.differs", ...pair, path, problem: `${path} claims ${key(pair)}, which is released, and is not its snapshot's definition as a JSON value; the first change after a release moves to a new version (spec §4.5)` });
  }
  return out;
}

/** Whether one identity is released, by the working tree's own account (`tree`) or the baseline's (`base`). */
function releaseStatus(w: World, rules: "tree" | "base", pair: Pair, bundled: Bundled | undefined): Finding[] {
  const authority = rules === "base" && w.base ? w.base : w.tree;
  const proposed = authority !== w.tree;
  const k = key(pair);
  const bytes = authority.snapshot(pair.id, pair.version);
  if (!bytes) {
    if (proposed && w.tree.snapshot(pair.id, pair.version)) return [{ code: "release.not_accepted", ...pair, problem: `${k} has a snapshot in this tree and none at the baseline: its release is proposed, not accepted on the default branch` }];
    return [{ code: "schema.unreleased", ...pair, problem: `${k} has no snapshot at ${snapshotPath(pair.id, pair.version)}: it is a draft, and a stable release may not carry it` }];
  }
  const out: Finding[] = [];
  if (!names(authority.changelog().dated, pair.id, pair.version)) {
    if (proposed && names(w.tree.changelog().dated, pair.id, pair.version)) out.push({ code: "release.not_accepted", ...pair, problem: `${k} is named by a dated release heading in this tree and by none at the baseline: its release is proposed, not accepted on the default branch` });
    else out.push({ code: "release.heading_missing", ...pair, problem: `${k} has a snapshot, and no dated release heading in CHANGELOG.md names it; a release is a version heading that names the schema versions it publishes (spec §4.5)` });
  }
  if (bundled && canon(parseJson(bytes)) !== canon(bundled.schema)) out.push({ code: "definition.differs", ...pair, problem: `the definition bundled for ${k} is not its released snapshot's, as a JSON value` });
  return out;
}

/** A pin verified by content: a commit-shaped string is not enough. */
function pinFindings(w: World, rules: "tree" | "base", inv: Inventory): Finding[] {
  const pin = inv.pin;
  if (!pin) return [];
  if (!/^[0-9a-f]{40}$/.test(pin.commit)) return [{ code: "pin.malformed", problem: `the source pin's commit is ${JSON.stringify(pin.commit)}, which is not a full commit id` }];
  const out: Finding[] = [];
  const byFile = inv.bundled.every((b) => b.file !== null);
  if (byFile) {
    for (const b of inv.bundled) if (!(b.file! in pin.files)) out.push({ code: "pin.malformed", id: b.id, version: b.version, problem: `the source pin records no digest for ${b.file}, which the package bundles as ${key(b)}` });
    for (const f of Object.keys(pin.files)) if (!inv.bundled.some((b) => b.file === f)) out.push({ code: "pin.malformed", path: `schemas/${f}`, problem: `the source pin records a digest for ${f}, which the package does not bundle` });
    for (const b of inv.bundled) if (b.file! in pin.files && sha256(b.text ?? "") !== pin.files[b.file!]) out.push({ code: "pin.bundle_differs", id: b.id, version: b.version, path: `schemas/${b.file}`, problem: `the text bundled for ${key(b)} does not have the digest the source pin records for ${b.file}` });
  }
  if (!w.git.commit(pin.commit)) return [...out, { code: "pin.commit_missing", problem: `the source pin names commit ${pin.commit}, which does not exist in this repository` }];
  const target = rules === "base" && w.baseCommit ? w.baseCommit : w.head;
  if (target && !w.git.isAncestor(pin.commit, target))
    out.push({ code: "pin.unreachable", problem: `the source pin's commit ${pin.commit} is not an ancestor of ${rules === "base" && w.baseCommit ? "the baseline" : "HEAD"} (${target}): the history being released does not contain the commit the schemas were copied from` });
  const covered = new Set<Bundled>();
  let resolvedAll = true;
  for (const [file, digest] of Object.entries(pin.files)) {
    const path = `schemas/${file}`, bytes = w.git.show(pin.commit, path);
    if (!bytes) { resolvedAll = false; out.push({ code: "pin.content_differs", path, problem: `${path} does not exist at the pinned commit ${pin.commit}` }); continue; }
    if (sha256(bytes) !== digest) out.push({ code: "pin.content_differs", path, problem: `${path} at the pinned commit ${pin.commit} has digest ${sha256(bytes)}, and the pin records ${digest}` });
    if (byFile) continue;
    const value = parseJson(bytes), pair = pairOf(value);
    const b = pair ? inv.bundled.find((x) => key(x) === key(pair)) : undefined;
    if (!b) { out.push({ code: "pin.malformed", path, problem: `the source pin records ${file}, which at the pinned commit defines ${pair ? key(pair) : "no pair"}; the package bundles no such schema` }); continue; }
    covered.add(b);
    if (canon(value) !== canon(b.schema)) out.push({ code: "pin.bundle_differs", id: b.id, version: b.version, path, problem: `the definition bundled for ${key(b)} is not ${path} at the pinned commit ${pin.commit}, as a JSON value` });
  }
  if (!byFile && resolvedAll) for (const b of inv.bundled) if (!covered.has(b)) out.push({ code: "pin.malformed", id: b.id, version: b.version, problem: `the source pin records no file that defines ${key(b)}, which the package bundles` });
  return out;
}

function packageFindings(w: World, rules: "tree" | "base", inv: Inventory): Finding[] {
  if (inv.unreadable) return [inv.unreadable];
  // Never a pass over nothing: a package with no bundled schema has no inventory to be eligible by.
  if (inv.bundled.length === 0) return [{ code: "inventory.empty", problem: "the package bundles no schema, so there is no inventory to judge; an empty inventory is a failure, never a pass" }];
  const out: Finding[] = [];
  const bundled = new Map(inv.bundled.map((b) => [key(b), b]));
  for (const d of inv.declared) if (!bundled.has(key(d))) out.push({ code: "inventory.declared_not_bundled", ...d, problem: `the package's source stamps ${key(d)} and its bundle holds no schema for that pair` });
  if (inv.source === "tree") for (const b of inv.bundled) {
    const held = w.treeIndex.get(key(b));
    if (!held) out.push({ code: "copy.stale", id: b.id, version: b.version, problem: `the package bundles ${key(b)}, which no schema file in this tree defines; re-sync the package` });
    else if (canon(held.value) !== canon(b.schema)) out.push({ code: "copy.stale", id: b.id, version: b.version, path: held.path, problem: `the definition bundled for ${key(b)} is not ${held.path}'s, as a JSON value; re-sync the package` });
  }
  const identities = new Map<string, Pair>([...inv.bundled, ...inv.declared].map((p) => [key(p), { id: p.id, version: p.version }]));
  for (const [k, pair] of identities) out.push(...releaseStatus(w, rules, pair, bundled.get(k)));
  out.push(...pinFindings(w, rules, inv));
  return out;
}

// ---- the check --------------------------------------------------------------------------------

export function checkRelease(o: Options): Line[] {
  const repo = resolve(o.repo ?? ".");
  const git = new Git(repo);
  if (!existsSync(repo) || !git.run("rev-parse", "--git-dir").ok) throw new CheckError("release_check.not_a_repository", `${repo} is not a git repository; the snapshots, the changelog and the baseline are read from one`);
  const head = git.commit("HEAD");
  const baseLabel = o.base ?? "merge-base(HEAD, origin/main)";
  let baseCommit: string | null;
  if (o.base !== undefined) baseCommit = git.commit(o.base);
  else {
    const r = head && git.commit("origin/main") ? git.run("merge-base", "HEAD", "origin/main") : null;
    baseCommit = r?.ok ? r.out.toString("utf8").trim() : null;
  }
  const tree = workingTree(repo);
  const base = baseCommit ? atCommit(git, baseCommit) : null;
  const w: World = { git, head, tree, base, baseCommit, treeIndex: indexTree(repo, tree) };
  const { phase } = o;

  const inventories: Inventory[] = o.artifacts?.length
    ? o.artifacts.map((a) => readArtifact(resolve(a)))
    : (existsSync(join(repo, "packages")) ? readdirSync(join(repo, "packages")).sort() : [])
      .filter((d) => existsSync(join(repo, "packages", d, "package.json")))
      .map((d) => readPackageDir(join(repo, "packages", d), { source: "tree", path: relative(repo, join(repo, "packages", d)), sha256: null }, false));

  const refuses = (f: Finding) => phase !== "development" || INCONSISTENT.has(f.code);
  const lines: Line[] = [{ event: "release.baseline", phase, base: baseLabel, commit: baseCommit, resolved: baseCommit !== null, snapshots: base?.snapshots().length ?? 0 }];
  const refusal = (pkg: string | null, f: Finding): Refusal => ({ event: "release.refusal", phase, package: pkg, code: f.code, problem: f.problem, ...(f.id ? { id: f.id } : {}), ...(f.version ? { version: f.version } : {}), ...(f.path ? { path: f.path } : {}) });

  const shared = repositoryFindings(w, repo, baseLabel);
  for (const f of shared.filter(refuses)) lines.push(refusal(null, f));
  const eligible: string[] = [], notEligible: string[] = [];
  for (const inv of inventories) {
    // Eligibility is always the publication question; what this phase refuses may be less.
    const strict = packageFindings(w, "base", inv);
    const judged = phase === "candidate" ? packageFindings(w, "tree", inv) : strict;
    const mine = judged.filter(refuses);
    for (const f of mine) lines.push(refusal(inv.name, f));
    const blocking = new Map<string, { id: string; version: string; code: Code }>();
    const blockers = new Set<Code>(shared.map((f) => f.code));
    for (const f of strict) {
      if (f.id && f.version) blocking.set(`${f.id}@${f.version} ${f.code}`, { id: f.id, version: f.version, code: f.code });
      else blockers.add(f.code);
    }
    const ok = blocking.size === 0 && blockers.size === 0;
    (ok ? eligible : notEligible).push(inv.name);
    lines.push({
      event: "release.package", phase, package: inv.name, version: inv.version, source: inv.source, path: inv.path, sha256: inv.sha256,
      pin: inv.pin?.commit ?? null, bundled: inv.bundled.length, declared: inv.declared.length,
      passed: mine.length === 0, eligible: ok, blocking: [...blocking.values()], blockers: [...blockers].sort(),
    });
  }
  const refusals = lines.filter((l) => l.event === "release.refusal").length;
  // A check that looked at no package established nothing, so it is not a pass.
  lines.push({ event: "release.summary", phase, passed: refusals === 0 && inventories.length > 0, packages: inventories.length, eligible, not_eligible: notEligible, refusals });
  return lines;
}

export function stamp(l: Line) { return { ...l, _schema: OUTPUT_SCHEMA }; }

export function human(l: Line): string {
  switch (l.event) {
    case "release.baseline": return `BASELINE  ${l.base} ${l.resolved ? `= ${l.commit}, ${l.snapshots} released snapshot(s)` : "names no commit"}`;
    case "release.refusal": return `REFUSED   ${l.package ?? "(repository)"}  ${l.code}${l.id ? `  ${l.id}@${l.version}` : ""}${l.path ? `  ${l.path}` : ""}  ${l.problem}`;
    case "release.package": {
      const why = [...l.blocking.map((b) => `${b.id}@${b.version} (${b.code})`), ...l.blockers];
      return `${l.passed ? "ok     " : "REFUSED"}   ${l.package} ${l.version ?? "-"}  ${l.source} ${l.path}  ${l.bundled} bundled, ${l.declared} declared; ${l.eligible ? "eligible for a stable release" : `not eligible: ${why.join(", ")}`}`;
    }
    case "release.summary": return `${l.passed ? "PASS" : "FAIL"}  ${l.phase}: ${l.packages} package(s), ${l.refusals} refusal(s); eligible: ${l.eligible.join(", ") || "none"}; not eligible: ${l.not_eligible.join(", ") || "none"}`;
    case "release.help": return `${l.usage}\n  ${l.intent}\n${PHASES.map((p) => `  ${p.padEnd(12)} ${l.phases[p]}`).join("\n")}`;
    case "error": return `ERROR  ${l.code}: ${l.problem}`;
  }
}

const USAGE = "release-check --phase development|candidate|publication [--base REF] [--repo DIR] [--artifact FILE]... [--human]";
export const HELP: Help = {
  event: "release.help",
  usage: USAGE,
  intent: "Say whether each package may be released as stable: every protocol schema it bundles or declares is released and frozen",
  phases: {
    development: "refuses an inconsistent source only; reports each package's eligibility and the schema identities that block it",
    candidate: "judges a release pull request: admits the snapshots and the dated heading it adds relative to the baseline",
    publication: "requires every schema release at the baseline already; nothing proposed counts",
  },
  exit: { "0": "passed", "1": "refused", "2": "the check could not run" },
};

function parseArgs(argv: string[]): { help: boolean; prose: boolean; options: Options } {
  let phase: string | undefined, base: string | undefined, repo: string | undefined, help = false, prose = false;
  const artifacts: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    const value = () => { const v = argv[++i]; if (v === undefined) throw new CheckError("release_check.usage", `${a} needs a value; usage: ${USAGE}`); return v; };
    if (a === "--human" || a === "--humanize") prose = true;
    else if (a === "--help" || a === "-h") help = true;
    else if (a === "--phase") phase = value();
    else if (a === "--base") base = value();
    else if (a === "--repo") repo = value();
    else if (a === "--artifact") artifacts.push(value());
    else throw new CheckError("release_check.usage", `unrecognised argument ${JSON.stringify(a)}; usage: ${USAGE}`);
  }
  if (help) return { help, prose, options: { phase: "development" } };
  if (!PHASES.includes(phase as Phase)) throw new CheckError("release_check.usage", `--phase must be one of ${PHASES.join(", ")}${phase === undefined ? "" : `, not ${JSON.stringify(phase)}`}; usage: ${USAGE}`);
  return { help, prose, options: { phase: phase as Phase, ...(base === undefined ? {} : { base }), ...(repo === undefined ? {} : { repo }), ...(artifacts.length ? { artifacts } : {}) } };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let prose = argv.includes("--human") || argv.includes("--humanize");
  const write = (l: Line, s: NodeJS.WriteStream) => s.write((prose ? human(l) : JSON.stringify(stamp(l))) + "\n");
  try {
    const parsed = parseArgs(argv);
    prose = parsed.prose;
    if (parsed.help) { write(HELP, process.stdout); process.exit(0); }
    const lines = checkRelease(parsed.options);
    for (const l of lines) write(l, process.stdout);
    const last = lines[lines.length - 1];
    process.exit(last?.event === "release.summary" && last.passed ? 0 : 1);
  } catch (e) {
    write({ event: "error", code: e instanceof CheckError ? e.code : "release_check.crashed", problem: (e as Error).message }, process.stderr);
    process.exit(2);
  }
}
