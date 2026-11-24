#!/usr/bin/env bun
// The release gate (flyingrobots/parley#147): `bun run release-gate -- <package>`. It answers one
// question about one package at the current commit, before anything public exists: may this
// artifact be released as stable? It builds the artifact once (an npm tarball, or the vendorable
// Python file), runs the release-eligibility checker's `publication` phase on that file
// (scripts/release-check.ts), with the frozen-since reference set to the package's previous release
// tag, and writes a release report beside it.
//
// Two callers. The person tagging runs it on `main` and pushes the tag only after it exits 0, since
// a pushed tag cannot be taken back. Each release workflow runs it as its `gate` job, with `--tag`
// and `--out`, and every job that creates a GitHub release or stages on npm needs that job and
// releases the file it left in `--out`, compared by digest.
//
// Repository tooling (see AGENTS.md): JSON Lines, the gate's own lines stamped
// `parley.tooling.release_gate` and the checker's passed through under their own stamp. `--human`
// prints prose. Exit: 0 passed, 1 refused, 2 the gate could not run.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { checkConsumer, type ConsumerCode, type ConsumerResult } from "./clean-consumer.ts";
import { OUTPUT_SCHEMA as CHECK_SCHEMA, artifactInventory, changelogEntries, checkRelease, human as humanCheck, names, snapshotPath, type Line as CheckLine, type Refusal } from "./release-check.ts";

export const GATE_SCHEMA = { id: "parley.tooling.release_gate", version: "1.0.0" } as const;
export const REPORT_SCHEMA = { id: "parley.tooling.release_report", version: "1.0.0" } as const;

export type GateCode =
  | "gate.tag_mismatch" | "gate.changelog_heading_missing" | "gate.not_on_default_branch" | "gate.dirty_tree"
  | "gate.artifact_mismatch" | "gate.manifest_differs" | "gate.workspace_range"
  | ConsumerCode;

export interface GateArtifact {
  event: "gate.artifact"; package: string; version: string | null;
  /** The artifact's file name, its path, and its SHA-256; the digest is null when the file could not be read. */
  file: string; path: string; sha256: string | null;
  /** Whether this run built it (`npm pack`), or it is a file that already existed. */
  packed: boolean;
}
export interface GateFrozenSince {
  event: "gate.frozen_since";
  /** The reference released snapshots are compared with, and the commit it names; null when there is none. */
  ref: string | null; commit: string | null;
  /** `given` on the command line, `derived` from this package's release tags, or `none`. */
  how: "given" | "derived" | "none";
  note: string;
}
export interface GateRefusal { event: "gate.refusal"; package: string; code: GateCode; problem: string }
export interface GateConsumer extends Omit<ConsumerResult, "event"> { event: "gate.consumer" }
export interface GateResult {
  event: "gate.result"; package: string; version: string | null; passed: boolean;
  file: string; sha256: string | null;
  /** The schema identities that stand between this artifact and a stable release, and why. */
  blocking: { id: string; version: string; code: string }[];
  refusals: number;
  /** Where the release report was written; null without `--out`. */
  report: string | null;
}
export interface GateHelp { event: "gate.help"; usage: string; intent: string; packages: string[]; exit: Record<"0" | "1" | "2", string> }
export interface GateFailure { event: "error"; code: string; problem: string }
export type GateLine = GateArtifact | GateFrozenSince | GateRefusal | GateConsumer | GateResult | GateHelp | GateFailure | Exclude<CheckLine, { event: "error" }>;

/** What was released, for the owner who approves it. Attached to the GitHub release; never inside the artifact. */
export interface Report {
  _schema: typeof REPORT_SCHEMA;
  package: { name: string; version: string | null; directory: string };
  /** The tag the release was started by; null when the gate ran before a tag existed. */
  tag: string | null;
  source: { commit: string | null; tree: string | null; on_default_branch: boolean; clean: boolean };
  /** The latest dated heading of the root changelog at the commit: the spec release this tree is at. */
  spec_release: { version: string; date: string } | null;
  /** The commit the artifact's bundled schemas were copied from, as the artifact states it. */
  schema_source: string | null;
  /** Every schema the artifact bundles, with the digest of its released snapshot in this tree; null for a draft. */
  schemas: { id: string; version: string; declared: boolean; snapshot: string; snapshot_sha256: string | null; released_in: string | null }[];
  artifact: {
    file: string; bytes: number; sha256: string;
    /** What npm prints as `shasum`, and what a lockfile and `npm stage view` record as `integrity`. */
    sha1: string; integrity: string;
    /** Each file the artifact holds, by digest; for a tarball, relative to `package/`. */
    files: { path: string; sha256: string }[];
  } | null;
  gate: {
    phase: "publication"; passed: boolean; checker: { id: string; version: string };
    base: string; base_commit: string | null;
    frozen_since: string | null; frozen_since_commit: string | null; frozen_since_how: "given" | "derived" | "none";
    refusals: { package: string | null; code: string; problem: string; id?: string; version?: string; path?: string }[];
  };
  /** The clean-consumer result, for a package whose gate ran with `--consumer`. */
  consumer: Omit<ConsumerResult, "event"> | null;
}

export interface GateOptions {
  /** A package directory name under `packages/` (`parley-read`), or its published name. */
  package: string;
  repo?: string;
  /** Judge this file in place of building one. */
  artifact?: string;
  /** A directory to leave the artifact, `SHA256SUMS` and `release-report.json` in. */
  out?: string;
  /** The tag being released: it must be this package's tag for this version. */
  tag?: string;
  /** Override the derived frozen-since reference. */
  frozenSince?: string;
  /** Prove the packed package against its dependencies as npm serves them (scripts/clean-consumer.ts). */
  consumer?: boolean;
  /** The consumer check to run; the real one unless a test supplies another, since the real one installs from npm. */
  consumerCheck?: typeof checkConsumer;
}
export interface Gate { passed: boolean; lines: GateLine[]; report: Report }

/** The gate could not run at all: a usage error, a repository that is not one, a pack that failed. */
export class GateError extends Error {
  constructor(readonly code: string, problem: string) { super(problem); }
}

const digest = (algorithm: string, bytes: Uint8Array, encoding: "hex" | "base64" = "hex") => createHash(algorithm).update(bytes).digest(encoding);
const parse = (text: string): unknown => { try { return JSON.parse(text); } catch { return undefined; } };

interface Manifest { name?: unknown; version?: unknown; dependencies?: Record<string, unknown>; peerDependencies?: Record<string, unknown>; optionalDependencies?: Record<string, unknown> }
interface Package { dir: string; path: string; name: string; version: string | null; kind: "npm" | "py"; manifest: Manifest; manifestText: string; /** For `py`: the file that is the package. */ file: string | null }

export function packagesOf(repo: string): Package[] {
  const root = join(repo, "packages");
  if (!existsSync(root)) return [];
  return readdirSync(root).sort().filter((d) => existsSync(join(root, d, "package.json"))).map((d) => {
    const path = join(root, d), manifestText = readFileSync(join(path, "package.json"), "utf8"), manifest = (parse(manifestText) ?? {}) as Manifest;
    const npm = existsSync(join(path, "src/schemas.ts"));
    const py = npm ? [] : readdirSync(path).filter((f) => f.endsWith(".py")).sort();
    return { dir: d, path, name: typeof manifest.name === "string" ? manifest.name : d, version: typeof manifest.version === "string" ? manifest.version : null, kind: npm ? "npm" as const : "py" as const, manifest, manifestText, file: py.length === 1 ? py[0]! : null };
  });
}

const git = (repo: string, ...args: string[]) => {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
};

/**
 * The previous release of a package, from its tags: the highest `<dir>-vX.Y.Z` below the version
 * being released that is an ancestor of HEAD. Versions are compared as numbers, and a tag off this
 * history, a pre-release tag or another package's tag is not a candidate.
 */
export function previousReleaseTag(repo: string, dir: string, version: string | null): string | null {
  const num = (v: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(v)?.slice(1).map(Number) ?? null;
  const cmp = (a: number[], b: number[]) => (a[0]! - b[0]!) || (a[1]! - b[1]!) || (a[2]! - b[2]!);
  const current = version === null ? null : num(version);
  if (!current) return null;
  const merged = git(repo, "tag", "--list", `${dir}-v*`, "--merged", "HEAD");
  if (!merged.ok) return null;
  let best: { tag: string; v: number[] } | null = null;
  for (const tag of merged.out.split("\n").filter(Boolean)) {
    const v = tag.startsWith(`${dir}-v`) ? num(tag.slice(dir.length + 2)) : null;
    if (!v || cmp(v, current) >= 0) continue;
    if (!best || cmp(v, best.v) > 0) best = { tag, v };
  }
  return best?.tag ?? null;
}

/** Every regular file under a directory, relative to it, sorted. */
function filesUnder(root: string, at = ""): string[] {
  return readdirSync(join(root, at)).sort().flatMap((n) => (statSync(join(root, at, n)).isDirectory() ? filesUnder(root, join(at, n)) : [join(at, n)]));
}

export function runGate(o: GateOptions): Gate {
  const repo = resolve(o.repo ?? ".");
  if (!existsSync(repo) || !git(repo, "rev-parse", "--git-dir").ok) throw new GateError("release_gate.not_a_repository", `${repo} is not a git repository; the gate reads a package, its history and its tags from one`);
  const all = packagesOf(repo);
  const pkg = all.find((p) => p.dir === o.package || p.name === o.package);
  if (!pkg) throw new GateError("release_gate.usage", `no package ${JSON.stringify(o.package)} under ${join(repo, "packages")}; the packages are ${all.map((p) => p.dir).join(", ") || "none"}`);
  if (pkg.kind === "py" && !pkg.file) throw new GateError("release_gate.usage", `packages/${pkg.dir} holds neither src/schemas.ts nor exactly one .py file, so the gate does not know what its artifact is`);
  const local = new Set(all.map((p) => p.name));
  const proved = Object.keys(pkg.manifest.dependencies ?? {}).filter((d) => local.has(d));
  if (o.consumer && (pkg.kind !== "npm" || proved.length === 0)) throw new GateError("release_gate.usage", `--consumer proves a package against the packages here it depends on, as npm serves them; ${pkg.name} depends on none`);

  const lines: GateLine[] = [];
  const own: GateRefusal[] = [];
  const refuse = (code: GateCode, problem: string) => { own.push({ event: "gate.refusal", package: pkg.name, code, problem }); };

  // ---- the commit: what a tag would name -------------------------------------------------------
  const head = git(repo, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"), tree = git(repo, "rev-parse", "--verify", "--quiet", "HEAD^{tree}");
  // Porcelain lines are "XY path"; the helper trims, so each line is cut at its own status field.
  const dirty = git(repo, "status", "--porcelain").out.split("\n").filter(Boolean).map((l) => l.replace(/^\s*\S+\s+/, ""));
  if (dirty.length > 0) refuse("gate.dirty_tree", `the working tree differs from HEAD in ${dirty.length} path(s) (${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? ", …" : ""}): a tag names a commit, so the artifact must be built from one`);
  const onMain = head.ok && git(repo, "rev-parse", "--verify", "--quiet", "origin/main^{commit}").ok && git(repo, "merge-base", "--is-ancestor", "HEAD", "origin/main").ok;
  if (!onMain) refuse("gate.not_on_default_branch", `HEAD (${head.out || "no commit"}) is not on origin/main: a release is tagged on the default branch, after the pull request that prepared it has merged`);
  const changelog = (() => { try { return readFileSync(join(pkg.path, "CHANGELOG.md"), "utf8"); } catch { return ""; } })();
  if (pkg.version === null || !changelogEntries(changelog).releases.some((r) => r.version === pkg.version))
    refuse("gate.changelog_heading_missing", `packages/${pkg.dir}/CHANGELOG.md has no dated heading "## [${pkg.version ?? "?"}] — YYYY-MM-DD" for the version being released`);
  if (o.tag !== undefined && o.tag !== `${pkg.dir}-v${pkg.version ?? ""}`)
    refuse("gate.tag_mismatch", `the tag ${JSON.stringify(o.tag)} is not ${pkg.dir}-v${pkg.version ?? "?"}, the tag of the version packages/${pkg.dir} is at`);

  // ---- the artifact: built once ----------------------------------------------------------------
  const out = o.out === undefined ? null : resolve(o.out);
  if (out) mkdirSync(out, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "parley-release-gate-"));
  try {
    let path: string, packed = false;
    if (o.artifact !== undefined) path = resolve(o.artifact);
    else if (pkg.kind === "py") {
      path = join(pkg.path, pkg.file!);
      if (out) { copyFileSync(path, join(out, pkg.file!)); path = join(out, pkg.file!); }
    } else {
      const dest = out ?? join(scratch, "pack");
      mkdirSync(dest, { recursive: true });
      const before = new Set(readdirSync(dest));
      const r = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", dest], { cwd: pkg.path, encoding: "utf8" });
      const made = readdirSync(dest).filter((f) => f.endsWith(".tgz") && !before.has(f));
      if (r.status !== 0 || made.length !== 1) throw new GateError("release_gate.pack_failed", `npm pack in packages/${pkg.dir} ${r.status === 0 ? `left ${made.length} new tarballs in ${dest}, and one was expected (an earlier tarball of this version is already there?)` : `exited ${String(r.status)}: ${(r.stderr || r.error?.message || "").trim().split("\n").slice(-4).join(" | ")}`}`);
      path = join(dest, made[0]!);
      packed = true;
    }
    const bytes = (() => { try { return readFileSync(path); } catch { return null; } })();
    const sha256 = bytes ? digest("sha256", bytes) : null;
    const inventory = artifactInventory(path);
    lines.push({ event: "gate.artifact", package: pkg.name, version: inventory.version ?? pkg.version, file: basename(path), path, sha256, packed });

    const expected = pkg.kind === "npm" ? pkg.name : pkg.file!;
    const files: { path: string; sha256: string }[] = [];
    if (bytes && (inventory.name !== expected || inventory.version !== pkg.version)) {
      refuse("gate.artifact_mismatch", `${basename(path)} is ${inventory.name}@${inventory.version ?? "?"}, and the package being released is ${expected}@${pkg.version ?? "?"}`);
    } else if (bytes && pkg.kind === "py") files.push({ path: basename(path), sha256: sha256! });
    else if (bytes && spawnSync("tar", ["-xzf", path, "-C", scratch]).status === 0 && existsSync(join(scratch, "package/package.json"))) {
      const root = join(scratch, "package");
      for (const f of filesUnder(root)) files.push({ path: f, sha256: digest("sha256", readFileSync(join(root, f))) });
      // npm rewrites or removes manifest fields it considers invalid when it packs, and publishes a
      // `workspace:` range verbatim. The published manifest must be the repository's.
      const packedManifest = parse(readFileSync(join(root, "package.json"), "utf8")) as Manifest | undefined;
      if (JSON.stringify(packedManifest) !== JSON.stringify(pkg.manifest)) refuse("gate.manifest_differs", `the package.json inside ${basename(path)} is not packages/${pkg.dir}/package.json as a JSON value: what would be published is not the manifest in the repository`);
      for (const map of ["dependencies", "peerDependencies", "optionalDependencies"] as const)
        for (const [dep, range] of Object.entries(packedManifest?.[map] ?? {})) if (String(range).startsWith("workspace:")) refuse("gate.workspace_range", `${basename(path)} declares ${dep}@${String(range)} in ${map}; npm publishes a workspace: range verbatim, and no installer outside this repository can resolve it`);
    }

    // ---- the reference released snapshots are compared with ---------------------------------------
    const derived = o.frozenSince === undefined ? previousReleaseTag(repo, pkg.dir, pkg.version) : null;
    const frozenSince = o.frozenSince ?? derived;
    const how = o.frozenSince !== undefined ? "given" as const : derived ? "derived" as const : "none" as const;
    const frozenCommit = frozenSince && !frozenSince.startsWith("-") ? git(repo, "rev-parse", "--verify", "--quiet", `${frozenSince}^{commit}`) : null;
    lines.push({
      event: "gate.frozen_since", ref: frozenSince, commit: frozenCommit?.ok ? frozenCommit.out : null, how,
      note: how === "given" ? "named with --frozen-since"
        : how === "derived" ? `the highest ${pkg.dir}-vX.Y.Z tag below ${pkg.version ?? "?"} that is an ancestor of HEAD`
        : `no ${pkg.dir}-vX.Y.Z tag below ${pkg.version ?? "?"} is an ancestor of HEAD, so released snapshots are compared with the baseline alone`,
    });

    // ---- the check ----------------------------------------------------------------------------
    const checked = checkRelease({ phase: "publication", repo, artifacts: [path], ...(frozenSince === null ? {} : { frozenSince }) });
    for (const l of checked) if (l.event !== "error") lines.push(l);
    const baseline = checked.find((l) => l.event === "release.baseline");
    const judged = checked.find((l) => l.event === "release.package");
    const summary = checked.find((l) => l.event === "release.summary");
    const refusals = checked.filter((l): l is Refusal => l.event === "release.refusal");

    // ---- the clean consumer: only for an artifact that is otherwise releasable --------------------
    let consumer: Omit<ConsumerResult, "event"> | null = null;
    if (o.consumer && own.length === 0 && summary?.event === "release.summary" && summary.passed) {
      const { event: _event, ...result } = (o.consumerCheck ?? checkConsumer)({ tarball: path, dependency: proved[0]!, workspace: repo });
      consumer = result;
      lines.push({ event: "gate.consumer", ...result });
      for (const r of result.refusals) refuse(r.code, r.problem);
    }
    for (const r of own) lines.push(r);

    const passed = own.length === 0 && summary?.event === "release.summary" && summary.passed;
    const treeChangelog = (() => { try { return changelogEntries(readFileSync(join(repo, "CHANGELOG.md"), "utf8")); } catch { return changelogEntries(""); } })();
    const declared = new Set(inventory.declared.map((p) => `${p.id}@${p.version}`));
    const report: Report = {
      _schema: REPORT_SCHEMA,
      package: { name: pkg.name, version: pkg.version, directory: relative(repo, pkg.path) },
      tag: o.tag ?? null,
      source: { commit: head.ok ? head.out : null, tree: tree.ok ? tree.out : null, on_default_branch: onMain, clean: dirty.length === 0 },
      spec_release: treeChangelog.releases[0] ? { version: treeChangelog.releases[0].version, date: treeChangelog.releases[0].date } : null,
      schema_source: inventory.pin,
      schemas: inventory.bundled.map((p) => {
        const snapshot = snapshotPath(p.id, p.version);
        const held = (() => { try { return readFileSync(join(repo, snapshot)); } catch { return null; } })();
        const naming = treeChangelog.releases.filter((r) => names(r.entry, p.id, p.version));
        return { id: p.id, version: p.version, declared: declared.has(`${p.id}@${p.version}`), snapshot, snapshot_sha256: held ? digest("sha256", held) : null, released_in: naming[naming.length - 1]?.version ?? null };
      }),
      artifact: bytes && sha256 ? { file: basename(path), bytes: bytes.length, sha256, sha1: digest("sha1", bytes), integrity: `sha512-${digest("sha512", bytes, "base64")}`, files } : null,
      gate: {
        phase: "publication", passed, checker: { ...CHECK_SCHEMA },
        base: baseline?.event === "release.baseline" ? baseline.base : "", base_commit: baseline?.event === "release.baseline" ? baseline.commit : null,
        frozen_since: frozenSince, frozen_since_commit: frozenCommit?.ok ? frozenCommit.out : null, frozen_since_how: how,
        refusals: [
          ...refusals.map((r) => ({ package: r.package, code: r.code, problem: r.problem, ...(r.id ? { id: r.id } : {}), ...(r.version ? { version: r.version } : {}), ...(r.path ? { path: r.path } : {}) })),
          ...own.map((r) => ({ package: r.package, code: r.code, problem: r.problem })),
        ],
      },
      consumer,
    };
    let reportPath: string | null = null;
    if (out) {
      reportPath = join(out, "release-report.json");
      writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
      // `sha256sum -c` reads this; it names the artifact alone, since the report describes it.
      if (sha256 && resolve(path, "..") === out) writeFileSync(join(out, "SHA256SUMS"), `${sha256}  ${basename(path)}\n`);
    }
    lines.push({
      event: "gate.result", package: pkg.name, version: pkg.version, passed, file: basename(path), sha256,
      blocking: judged?.event === "release.package" ? judged.blocking : [], refusals: refusals.length + own.length, report: reportPath,
    });
    return { passed, lines, report };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

export function stampGate(l: GateLine) { return { ...l, _schema: l.event.startsWith("release.") ? CHECK_SCHEMA : GATE_SCHEMA }; }

export function humanGate(l: GateLine): string {
  switch (l.event) {
    case "gate.artifact": return `ARTIFACT  ${l.package} ${l.version ?? "-"}  ${l.path}  sha256 ${l.sha256 ?? "unreadable"}${l.packed ? "  (packed by this run)" : ""}`;
    case "gate.frozen_since": return `FROZEN    ${l.ref ?? "no reference"}${l.commit ? ` = ${l.commit}` : ""}  (${l.note})`;
    case "gate.refusal": return `REFUSED   ${l.package}  ${l.code}  ${l.problem}`;
    case "gate.consumer": return `CONSUMER  ${l.passed ? "ok" : "REFUSED"}  ${l.dependency ? `${l.dependency.name} ${l.dependency.version ?? "-"} ${l.dependency.integrity ?? ""}` : "no dependency resolved"}  in ${l.dir}`;
    case "gate.result": return `${l.passed ? "PASS" : "FAIL"}  release gate: ${l.package} ${l.version ?? "-"}  ${l.file}  sha256 ${l.sha256 ?? "-"}; ${l.refusals} refusal(s)${l.blocking.length ? `; blocked by ${[...new Set(l.blocking.map((b) => `${b.id}@${b.version} (${b.code})`))].join(", ")}` : ""}${l.report ? `; report ${l.report}` : ""}`;
    case "gate.help": return `${l.usage}\n  ${l.intent}\n  packages: ${l.packages.join(", ")}`;
    case "error": return `ERROR  ${l.code}: ${l.problem}`;
    default: return humanCheck(l);
  }
}

const USAGE = "release-gate -- <package> [--tag TAG] [--out DIR] [--artifact FILE] [--frozen-since REF] [--consumer] [--repo DIR] [--human]";
const help = (repo: string): GateHelp => ({
  event: "gate.help",
  usage: USAGE,
  intent: "Say whether one package may be released as stable at this commit: build its artifact once, run the publication phase of release-check on that file against the package's previous release tag, and write a release report. Run it before pushing a release tag; push the tag only after it exits 0",
  packages: (() => { try { return packagesOf(repo).map((p) => p.dir); } catch { return []; } })(),
  exit: { "0": "passed: the artifact may be released", "1": "refused", "2": "the gate could not run" },
});

function parseArgs(argv: string[]): { help: boolean; prose: boolean; repo: string; options: GateOptions | null } {
  let pkg: string | undefined, repo: string | undefined, artifact: string | undefined, out: string | undefined, tag: string | undefined, frozenSince: string | undefined, consumer = false, wantsHelp = false, prose = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    const value = () => { const v = argv[++i]; if (v === undefined) throw new GateError("release_gate.usage", `${a} needs a value; usage: ${USAGE}`); return v; };
    if (a === "--") continue;
    else if (a === "--human" || a === "--humanize") prose = true;
    else if (a === "--help" || a === "-h") wantsHelp = true;
    else if (a === "--repo") repo = value();
    else if (a === "--artifact") artifact = value();
    else if (a === "--out") out = value();
    else if (a === "--tag") tag = value();
    else if (a === "--frozen-since") frozenSince = value();
    else if (a === "--consumer") consumer = true;
    else if (a.startsWith("-")) throw new GateError("release_gate.usage", `unrecognised argument ${JSON.stringify(a)}; usage: ${USAGE}`);
    else if (pkg !== undefined) throw new GateError("release_gate.usage", `one package at a time: both ${JSON.stringify(pkg)} and ${JSON.stringify(a)} were named; usage: ${USAGE}`);
    else pkg = a;
  }
  if (wantsHelp) return { help: true, prose, repo: repo ?? ".", options: null };
  if (pkg === undefined) throw new GateError("release_gate.usage", `name the package to release; usage: ${USAGE}`);
  return { help: false, prose, repo: repo ?? ".", options: { package: pkg, ...(repo === undefined ? {} : { repo }), ...(artifact === undefined ? {} : { artifact }), ...(out === undefined ? {} : { out }), ...(tag === undefined ? {} : { tag }), ...(frozenSince === undefined ? {} : { frozenSince }), consumer } };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let prose = argv.includes("--human") || argv.includes("--humanize");
  const write = (l: GateLine, s: NodeJS.WriteStream) => s.write((prose ? humanGate(l) : JSON.stringify(stampGate(l))) + "\n");
  try {
    const parsed = parseArgs(argv);
    prose = parsed.prose;
    if (!parsed.options) { write(help(resolve(parsed.repo)), process.stdout); process.exit(0); }
    const gate = runGate(parsed.options);
    for (const l of gate.lines) write(l, process.stdout);
    process.exit(gate.passed ? 0 : 1);
  } catch (e) {
    write({ event: "error", code: e instanceof GateError ? e.code : "release_gate.crashed", problem: (e as Error).message }, process.stderr);
    process.exit(2);
  }
}
