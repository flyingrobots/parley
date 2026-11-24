// Release eligibility (flyingrobots/parley#145). Every row of the issue's acceptance table and every
// positive control is a named case here, run on a throwaway repository with real git history: the
// checker's subject is what a commit, a baseline and an artifact say about each other, so a fixture
// without history would test nothing. The package copies in each fixture are written by the
// repository's real sync scripts, so the bundle format under test is the one the packages ship.
// The ledger is docs/workflows/release-spec/test-plan.md.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkRelease, human, stamp, type Line, type PackageLine, type Phase, type Refusal } from "./release-check.ts";

const REPO = resolve(import.meta.dir, "..");
const PHASES: Phase[] = ["development", "candidate", "publication"];
const EMIT = "@flyingrobots/parley-emit", READ = "@flyingrobots/parley-read", PY = "@flyingrobots/parley-emit-py";
// A fixture test builds commits and runs three sync scripts; the default 5 s is too little under load.
const SLOW = 60_000;

const scratch = mkdtempSync(join(tmpdir(), "parley-release-check-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let made = 0;

function run(cmd: string, args: string[], cwd: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} in ${cwd} exited ${String(r.status)}: ${r.stderr}${r.stdout}`);
  return r.stdout.trim();
}
const git = (dir: string, ...args: string[]) =>
  run("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], dir);
const commit = (dir: string, message: string) => { git(dir, "add", "-A"); git(dir, "commit", "-q", "--allow-empty", "-m", message); return git(dir, "rev-parse", "HEAD"); };
/** Move the fixture's remote-tracking ref for the default branch: what "merged" means here. */
const acceptOnMain = (dir: string, ref = "HEAD") => git(dir, "update-ref", "refs/remotes/origin/main", git(dir, "rev-parse", ref));
const put = (dir: string, path: string, text: string) => { mkdirSync(join(dir, path, ".."), { recursive: true }); writeFileSync(join(dir, path), text); };
const get = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");
const edit = (dir: string, path: string, from: string | RegExp, to: string) => {
  const before = get(dir, path), after = before.replace(from, to);
  if (after === before) throw new Error(`fixture edit of ${path} changed nothing`);
  put(dir, path, after);
};

function schemaDoc(id: string, version: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://flyingrobots.dev/parley/schemas/${id}/${version}`,
    title: id,
    type: "object",
    required: ["event", "_schema"],
    properties: {
      event: { type: "string" },
      ...extra,
      _schema: { type: "object", required: ["id", "version"], additionalProperties: false, properties: { id: { const: id }, version: { const: version } } },
    },
  };
}
const text = (doc: unknown) => JSON.stringify(doc, null, 2) + "\n";
const top = (id: string) => `schemas/${id}.schema.json`;
const snap = (id: string, version: string) => `schemas/released/${id}/${version}.schema.json`;

/** Re-sync every package's copy from the tree, as `bun run sync-schemas` does in each package. */
function sync(dir: string): void {
  run("bun", ["run", "scripts/sync-schemas.ts"], join(dir, "packages/parley-emit"));
  run("bun", ["run", "scripts/sync-schemas.ts"], join(dir, "packages/parley-read"));
  run("python3", ["scripts/sync_schemas.py"], join(dir, "packages/parley-emit-py"));
}

const CHANGELOG_RELEASED = [
  "# Changelog", "",
  "## [Unreleased]", "",
  "## [0.2.0] — 2026-01-01", "",
  "### Added", "",
  "- `parley.error` 2.0.0, `parley.query` 1.0.0 and `parley.lens` 1.0.0.", "",
].join("\n");

/**
 * A repository in which everything is released: three schemas, each with its snapshot and a dated
 * heading (commit S), then the three packages synced from S (commit P). `origin/main` is P.
 */
function buildReleased(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  for (const [id, version] of [["parley.error", "2.0.0"], ["parley.query", "1.0.0"], ["parley.lens", "1.0.0"]] as const) {
    put(dir, top(id), text(schemaDoc(id, version)));
    put(dir, snap(id, version), text(schemaDoc(id, version)));
  }
  put(dir, "CHANGELOG.md", CHANGELOG_RELEASED);
  const manifest = (name: string, version: string) => text({ name, version, type: "module", files: ["src"] });
  put(dir, "packages/parley-emit/package.json", manifest(EMIT, "0.4.0"));
  put(dir, "packages/parley-emit/src/run.ts", 'export const SCHEMA_IDS = {\n  error: { id: "parley.error", version: "2.0.0" },\n} as const;\n');
  put(dir, "packages/parley-emit/scripts/sync-schemas.ts", readFileSync(join(REPO, "packages/parley-emit/scripts/sync-schemas.ts"), "utf8"));
  put(dir, "packages/parley-read/package.json", manifest(READ, "0.2.0"));
  put(dir, "packages/parley-read/src/query.ts", 'export const QUERY_SCHEMA = { id: "parley.query", version: "1.0.0" } as const;\n');
  put(dir, "packages/parley-read/src/digest.ts", 'export const LENS_SCHEMA = { id: "parley.lens", version: "1.0.0" } as const;\n');
  put(dir, "packages/parley-read/scripts/sync-schemas.ts", readFileSync(join(REPO, "packages/parley-read/scripts/sync-schemas.ts"), "utf8"));
  put(dir, "packages/parley-emit-py/package.json", text({ name: PY, version: "0.3.0", private: true }));
  put(dir, "packages/parley-emit-py/parley_emit.py", [
    '"""A stand-in for parley_emit.py: the embedded block and the identities it stamps."""',
    "from typing import Any, Dict", "",
    '__version__ = "0.3.0"', "",
    "SCHEMA_IDS: Dict[str, Dict[str, str]] = {",
    '    "error": {"id": "parley.error", "version": "2.0.0"},',
    "}",
    '# A tool-owned identity, which the rule does not govern.',
    'VENDOR_SCHEMA = {"id": "parley.tooling.vendor_info", "version": "1.0.0"}',
    "# BEGIN SCHEMAS", "# END SCHEMAS", "",
  ].join("\n"));
  put(dir, "packages/parley-emit-py/scripts/sync_schemas.py", readFileSync(join(REPO, "packages/parley-emit-py/scripts/sync_schemas.py"), "utf8"));
  commit(dir, "S: release 0.2.0 of the schemas");
  sync(dir);
  commit(dir, "P: package copies synced from S");
  acceptOnMain(dir);
}

const FOLD = { fold: { type: "boolean" } };
const CHANGELOG_DRAFTS = CHANGELOG_RELEASED.replace("## [Unreleased]\n", "## [Unreleased]\n\n### Added\n\n- `parley.query` 1.1.0, a draft.\n- `parley.lens` 1.1.0, a draft.\n");

/** On top of the released tree: `parley.query` and `parley.lens` move to draft 1.1.0, as on main on 2026-11-24. */
function addDrafts(dir: string): void {
  put(dir, top("parley.query"), text(schemaDoc("parley.query", "1.1.0", FOLD)));
  put(dir, top("parley.lens"), text(schemaDoc("parley.lens", "1.1.0", FOLD)));
  put(dir, "CHANGELOG.md", CHANGELOG_DRAFTS);
  edit(dir, "packages/parley-read/src/query.ts", '"1.0.0"', '"1.1.0"');
  edit(dir, "packages/parley-read/src/digest.ts", '"1.0.0"', '"1.1.0"');
  commit(dir, "drafts: parley.query 1.1.0 and parley.lens 1.1.0");
  sync(dir);
  commit(dir, "package copies synced from the drafts");
  acceptOnMain(dir);
}

/** The release pull request for those drafts, on a branch: commit S snapshots and dates them, commit P re-syncs from S. */
function releaseDrafts(dir: string): { s: string; p: string } {
  git(dir, "checkout", "-q", "-b", "release");
  for (const id of ["parley.query", "parley.lens"]) put(dir, snap(id, "1.1.0"), get(dir, top(id)));
  put(dir, "CHANGELOG.md", CHANGELOG_DRAFTS.replace("## [Unreleased]\n\n### Added\n", "## [Unreleased]\n\n## [0.2.1] — 2026-11-24\n\n### Added\n"));
  const s = commit(dir, "S: release 0.2.1 of the schemas");
  sync(dir);
  const p = commit(dir, "P: package copies synced from S");
  return { s, p };
}

const templates = { released: join(scratch, "template-released"), drafts: join(scratch, "template-drafts") };
beforeAll(() => {
  buildReleased(templates.released);
  cpSync(templates.released, templates.drafts, { recursive: true });
  addDrafts(templates.drafts);
}, SLOW);

/** A private copy of a template, history included. */
function fixture(of: keyof typeof templates): string {
  const dir = join(scratch, `repo-${++made}`);
  cpSync(templates[of], dir, { recursive: true });
  return dir;
}

/** Pack a package directory the way npm lays a tarball out: every file under `package/`. */
function pack(dir: string, pkg: string, mutate?: (staged: string) => void): string {
  const stage = join(scratch, `stage-${++made}`);
  cpSync(join(dir, "packages", pkg), join(stage, "package"), { recursive: true });
  mutate?.(join(stage, "package"));
  const out = join(scratch, `${pkg}-${made}.tgz`);
  run("tar", ["-czf", out, "-C", stage, "package"], scratch);
  return out;
}

const refusals = (lines: Line[]) => lines.filter((l): l is Refusal => l.event === "release.refusal");
const codes = (lines: Line[]) => [...new Set(refusals(lines).map((r) => r.code))].sort();
const packages = (lines: Line[]) => lines.filter((l): l is PackageLine => l.event === "release.package");
const pkg = (lines: Line[], name: string) => { const p = packages(lines).find((x) => x.package === name); if (!p) throw new Error(`no release.package line for ${name}`); return p; };
const summary = (lines: Line[]) => { const s = lines[lines.length - 1]; if (s?.event !== "release.summary") throw new Error("the last line is not release.summary"); return s; };
const pairs = (p: PackageLine) => p.blocking.map((b) => `${b.id}@${b.version}`).sort();

const everyLine: Line[] = [];
/** Run the checker in-process and keep its lines for the schema case at the end. */
function check(o: Parameters<typeof checkRelease>[0]): Line[] {
  const lines = checkRelease(o);
  everyLine.push(...lines);
  return lines;
}

describe("release eligibility: refusals (flyingrobots/parley#145)", () => {
  test("RLC-1: all copies agree on a draft schema: candidate and publication reject, naming the identity", () => {
    const dir = fixture("drafts");
    for (const phase of ["candidate", "publication"] as const) {
      const lines = check({ phase, repo: dir });
      expect(summary(lines).passed).toBe(false);
      const named = refusals(lines).filter((r) => r.code === "schema.unreleased");
      for (const name of [EMIT, READ, PY]) {
        expect(named.filter((r) => r.package === name).map((r) => `${r.id}@${r.version}`).sort(), `${phase} ${name}`).toEqual(["parley.lens@1.1.0", "parley.query@1.1.0"]);
        expect(pkg(lines, name).passed).toBe(false);
      }
    }
  }, SLOW);

  test("RLC-2: a snapshot exists but no release heading names it: rejected", () => {
    const dir = fixture("drafts");
    for (const id of ["parley.query", "parley.lens"]) put(dir, snap(id, "1.1.0"), get(dir, top(id)));
    commit(dir, "snapshots with no dated heading");
    const candidate = check({ phase: "candidate", repo: dir });
    expect(codes(candidate)).toEqual(["release.heading_missing"]);
    expect(refusals(candidate).filter((r) => r.package === READ).map((r) => `${r.id}@${r.version}`).sort()).toEqual(["parley.lens@1.1.0", "parley.query@1.1.0"]);
    // Accepted on the default branch in that state, it is still not a release.
    acceptOnMain(dir);
    expect(codes(check({ phase: "publication", repo: dir }))).toEqual(["release.heading_missing"]);
  }, SLOW);

  test("RLC-3: a released snapshot, its top-level file and every bundled copy changed together: rejected against the baseline", () => {
    const dir = fixture("released");
    git(dir, "checkout", "-q", "-b", "coordinated");
    const changed = text({ ...schemaDoc("parley.error", "2.0.0"), description: "a released version, edited in place" });
    put(dir, top("parley.error"), changed);
    put(dir, snap("parley.error", "2.0.0"), changed);
    commit(dir, "S': edit a released schema and its snapshot together");
    sync(dir);
    commit(dir, "P': every package copy re-synced from the edit");
    // The known failure mode: compared with itself, the candidate is flawless.
    for (const phase of PHASES) expect(refusals(check({ phase, repo: dir, base: "HEAD" })), `${phase} against itself`).toEqual([]);
    // Against a baseline it did not choose, every phase refuses it.
    for (const phase of PHASES) {
      const lines = check({ phase, repo: dir });
      expect(summary(lines).passed, phase).toBe(false);
      const r = refusals(lines).find((x) => x.code === "snapshot.modified");
      expect(r?.path, phase).toBe(snap("parley.error", "2.0.0"));
      for (const p of packages(lines)) expect(p.eligible, `${phase} ${p.package}`).toBe(false);
    }
  }, SLOW);

  test("RLC-4: a previously released snapshot is deleted: rejected", () => {
    const dir = fixture("released");
    rmSync(join(dir, snap("parley.lens", "1.0.0")));
    commit(dir, "delete a released snapshot");
    for (const phase of PHASES) {
      const lines = check({ phase, repo: dir, base: "origin/main" });
      expect(summary(lines).passed, phase).toBe(false);
      expect(refusals(lines).find((x) => x.code === "snapshot.deleted")?.path, phase).toBe(snap("parley.lens", "1.0.0"));
    }
  }, SLOW);

  test("RLC-5a: a source pin with valid syntax whose commit holds different content: rejected", () => {
    const dir = fixture("released");
    // A well-formed digest that is not the digest of that file at the pinned commit.
    edit(dir, "packages/parley-emit/src/schemas.ts", /("parley\.error\.schema\.json": ")[0-9a-f]{64}/, `$1${"ab".repeat(32)}`);
    edit(dir, "packages/parley-emit-py/parley_emit.py", /("parley\.error\.schema\.json": ")[0-9a-f]{64}/, `$1${"ab".repeat(32)}`);
    for (const phase of ["candidate", "publication"] as const) {
      const lines = check({ phase, repo: dir });
      for (const name of [EMIT, PY]) {
        const r = refusals(lines).filter((x) => x.package === name);
        expect(r.map((x) => x.code), `${phase} ${name}`).toContain("pin.content_differs");
        expect(r.find((x) => x.code === "pin.content_differs")?.path).toBe("schemas/parley.error.schema.json");
      }
      expect(pkg(lines, READ).passed).toBe(true);
    }
  }, SLOW);

  test("RLC-5b: a source pin that is a commit-shaped string naming no commit: rejected", () => {
    const dir = fixture("released");
    edit(dir, "packages/parley-read/src/schemas.ts", /commit: "[0-9a-f]{40}"/, `commit: "${"0123456789".repeat(4)}"`);
    for (const phase of ["candidate", "publication"] as const) {
      const lines = check({ phase, repo: dir });
      expect(refusals(lines).filter((x) => x.package === READ).map((x) => x.code), phase).toEqual(["pin.commit_missing"]);
      expect(pkg(lines, EMIT).passed).toBe(true);
    }
  }, SLOW);

  test("RLC-5c: a source pin naming a real commit whose schema is not the bundled one: rejected", () => {
    const dir = fixture("drafts");
    const { p } = releaseDrafts(dir);
    acceptOnMain(dir, p);
    // The pin still names S, and S's digests are still recorded, but the bundled definition is another.
    edit(dir, "packages/parley-emit/src/schemas.ts", '"title": "parley.error"', '"title": "parley.error, as nobody released it"');
    const lines = check({ phase: "publication", repo: dir });
    expect(refusals(lines).filter((x) => x.package === EMIT).map((x) => x.code).sort()).toEqual(["copy.stale", "definition.differs", "pin.bundle_differs"]);
  }, SLOW);

  test("RLC-5d: a source pin that is not a commit id, or that covers other files than the bundle holds: rejected", () => {
    const dir = fixture("released");
    edit(dir, "packages/parley-read/src/schemas.ts", /commit: "[0-9a-f]{40}"/, 'commit: "main"');
    // A pin that vouches for two of the three schemas the package bundles.
    edit(dir, "packages/parley-emit/src/schemas.ts", /\n  "parley\.error\.schema\.json": "[0-9a-f]{64}",/, "");
    for (const phase of ["candidate", "publication"] as const) {
      const lines = check({ phase, repo: dir });
      expect(refusals(lines).filter((x) => x.package === READ).map((x) => x.code), phase).toEqual(["pin.malformed"]);
      expect(refusals(lines).filter((x) => x.package === EMIT).map((x) => `${x.code} ${x.id}@${x.version}`), phase).toEqual(["pin.malformed parley.error@2.0.0"]);
    }
    // A malformed pin is an inconsistency of the source, so development refuses it too.
    expect(codes(check({ phase: "development", repo: dir }))).toEqual(["pin.malformed"]);
  }, SLOW);

  test("RLC-6: the checkout is correct but the packed artifact is stale: rejected when given the artifact", () => {
    const dir = fixture("released");
    expect(summary(check({ phase: "publication", repo: dir })).passed).toBe(true);
    const tarball = pack(dir, "parley-read", (staged) => {
      const p = join(staged, "src/schemas.ts");
      writeFileSync(p, readFileSync(p, "utf8").replace('"title": "parley.query"', '"title": "parley.query, packed before the release"'));
    });
    const lines = check({ phase: "publication", repo: dir, artifacts: [tarball] });
    expect(summary(lines).passed).toBe(false);
    const r = refusals(lines).filter((x) => x.code === "definition.differs");
    expect(r.map((x) => `${x.package} ${x.id}@${x.version}`)).toEqual([`${READ} parley.query@1.0.0`]);
    expect(pkg(lines, READ).source).toBe("artifact");
    // The same for the vendorable file: a stale copy beside a correct checkout.
    const stale = join(scratch, "stale_parley_emit.py");
    writeFileSync(stale, get(dir, "packages/parley-emit-py/parley_emit.py").replace('\\"title\\": \\"parley.error\\"', '\\"title\\": \\"parley.error, vendored long ago\\"'));
    const py = check({ phase: "publication", repo: dir, artifacts: [stale] });
    expect(codes(py)).toContain("definition.differs");
    expect(summary(py).passed).toBe(false);
  }, SLOW);

  test("RLC-7: a built-in identity a package advertises is absent from its bundled inventory: rejected", () => {
    const dir = fixture("released");
    edit(dir, "packages/parley-read/src/query.ts", '"1.0.0"', '"1.4.0"');
    for (const phase of PHASES) {
      const lines = check({ phase, repo: dir });
      const r = refusals(lines).filter((x) => x.code === "inventory.declared_not_bundled");
      expect(r.map((x) => `${x.package} ${x.id}@${x.version}`), phase).toEqual([`${READ} parley.query@1.4.0`]);
      expect(pkg(lines, READ).passed).toBe(false);
      expect(pkg(lines, READ).eligible).toBe(false);
    }
  }, SLOW);

  test("RLC-8a: an empty inventory is a failure with a code that says so, never a pass", () => {
    const dir = fixture("released");
    put(dir, "packages/parley-emit/src/schemas.ts", [
      "// Generated by scripts/sync-schemas.ts. Do not edit; edit schemas/ at the repository root.",
      `export const SCHEMA_SOURCE = { commit: "${git(dir, "rev-parse", "HEAD")}", files: {} } as const;`,
      "export const SCHEMAS: ReadonlyArray<{ id: string; version: string; schema: Record<string, unknown> }> = [];",
      "",
    ].join("\n"));
    put(dir, "packages/parley-emit/src/run.ts", "export const SCHEMA_IDS = {} as const;\n");
    for (const phase of PHASES) {
      const lines = check({ phase, repo: dir });
      expect(refusals(lines).filter((x) => x.package === EMIT).map((x) => x.code), phase).toEqual(["inventory.empty"]);
      expect(pkg(lines, EMIT).passed).toBe(false);
      expect(pkg(lines, EMIT).eligible).toBe(false);
      expect(summary(lines).passed).toBe(false);
    }
  }, SLOW);

  test("RLC-8b: an inventory that cannot be read is a failure with a code that says so", () => {
    const dir = fixture("released");
    rmSync(join(dir, "packages/parley-read/src/schemas.ts"));
    edit(dir, "packages/parley-emit-py/parley_emit.py", "# BEGIN SCHEMAS", "# START SCHEMAS");
    edit(dir, "packages/parley-emit/src/schemas.ts", "export const SCHEMAS:", "export const SCHEMATA:");
    for (const phase of PHASES) {
      const lines = check({ phase, repo: dir });
      for (const name of [EMIT, READ, PY]) expect(refusals(lines).filter((x) => x.package === name).map((x) => x.code), `${phase} ${name}`).toEqual(["inventory.unreadable"]);
      expect(summary(lines).passed).toBe(false);
    }
  }, SLOW);

  test("RLC-8c: an artifact that cannot be read is a failure with a code that says so", () => {
    const dir = fixture("released");
    const garbage = join(scratch, "garbage.tgz");
    writeFileSync(garbage, "this is not a gzip stream\n");
    const empty = join(scratch, "no-package-inside.tgz");
    mkdirSync(join(scratch, "elsewhere/other"), { recursive: true });
    writeFileSync(join(scratch, "elsewhere/other/readme.txt"), "no package directory\n");
    run("tar", ["-czf", empty, "-C", join(scratch, "elsewhere"), "other"], scratch);
    const unknown = join(scratch, "artifact.zip");
    writeFileSync(unknown, "PK");
    for (const artifact of [join(scratch, "absent.tgz"), garbage, empty, unknown, join(scratch, "absent.py")]) {
      for (const phase of PHASES) {
        const lines = check({ phase, repo: dir, artifacts: [artifact] });
        expect(codes(lines), `${phase} ${artifact}`).toEqual(["artifact.unreadable"]);
        expect(summary(lines).passed).toBe(false);
        expect(summary(lines).eligible).toEqual([]);
      }
    }
  }, SLOW);

  test("RLC-9: with no baseline to compare with, candidate and publication refuse and development says so", () => {
    const dir = fixture("released");
    git(dir, "update-ref", "-d", "refs/remotes/origin/main");
    for (const phase of ["candidate", "publication"] as const) {
      const lines = check({ phase, repo: dir });
      expect(codes(lines), phase).toEqual(["baseline.unresolved"]);
      expect(summary(lines).passed).toBe(false);
    }
    const unknown = check({ phase: "publication", repo: dir, base: "no-such-ref" });
    expect(codes(unknown)).toEqual(["baseline.unresolved"]);
    const dev = check({ phase: "development", repo: dir });
    expect(summary(dev).passed).toBe(true);
    expect(dev[0]).toMatchObject({ event: "release.baseline", resolved: false, commit: null });
    // Nothing was compared with a baseline, so nothing is reported as eligible.
    for (const p of packages(dev)) { expect(p.eligible).toBe(false); expect(p.blockers).toContain("baseline.unresolved"); }
  }, SLOW);

  test("RLC-10: a release whose schema commit was squashed away is rejected: the pin's commit is not on the default branch", () => {
    const dir = fixture("drafts");
    releaseDrafts(dir);
    git(dir, "checkout", "-q", "main");
    git(dir, "merge", "-q", "--squash", "release");
    commit(dir, "the release, squash-merged");
    acceptOnMain(dir);
    const lines = check({ phase: "publication", repo: dir });
    expect(codes(lines)).toEqual(["pin.unreachable"]);
    expect(summary(lines).not_eligible.sort()).toEqual([EMIT, PY, READ].sort());
  }, SLOW);
});

describe("release eligibility: positive controls and edges (flyingrobots/parley#145)", () => {
  test("RLC-11: a tree with honestly declared drafts passes development and reports which packages are not eligible and why", () => {
    const dir = fixture("drafts");
    const lines = check({ phase: "development", repo: dir });
    expect(refusals(lines)).toEqual([]);
    expect(summary(lines)).toMatchObject({ phase: "development", passed: true, packages: 3, eligible: [], refusals: 0 });
    expect(summary(lines).not_eligible.sort()).toEqual([EMIT, PY, READ].sort());
    for (const name of [EMIT, READ, PY]) {
      const p = pkg(lines, name);
      expect(p.passed).toBe(true);
      expect(p.eligible).toBe(false);
      expect(pairs(p)).toEqual(["parley.lens@1.1.0", "parley.query@1.1.0"]);
      expect(p.blocking.every((b) => b.code === "schema.unreleased")).toBe(true);
      expect(p.blockers).toEqual([]);
    }
    expect(pkg(lines, READ)).toMatchObject({ source: "tree", version: "0.2.0", bundled: 5, declared: 2 });
    expect(pkg(lines, EMIT)).toMatchObject({ bundled: 3, declared: 1 });
    expect(pkg(lines, PY)).toMatchObject({ bundled: 3, declared: 1 });
  }, SLOW);

  test("RLC-12: a tree and an artifact bundling only released schemas pass publication", () => {
    const dir = fixture("released");
    const tree = check({ phase: "publication", repo: dir });
    expect(refusals(tree)).toEqual([]);
    expect(summary(tree)).toMatchObject({ passed: true, refusals: 0, not_eligible: [] });
    expect(summary(tree).eligible.sort()).toEqual([EMIT, PY, READ].sort());
    const tarballs = [pack(dir, "parley-emit"), pack(dir, "parley-read")];
    const file = join(dir, "packages/parley-emit-py/parley_emit.py");
    const lines = check({ phase: "publication", repo: dir, artifacts: [...tarballs, file] });
    expect(refusals(lines)).toEqual([]);
    expect(summary(lines)).toMatchObject({ passed: true, packages: 3, not_eligible: [] });
    for (const p of packages(lines)) {
      expect(p).toMatchObject({ source: "artifact", passed: true, eligible: true, blocking: [], blockers: [] });
      expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(p.pin).toBe(git(dir, "rev-parse", "HEAD~1"));
    }
    expect(packages(lines).map((p) => p.package)).toEqual([EMIT, READ, "parley_emit.py"]);
    expect(pkg(lines, "parley_emit.py").version).toBe("0.3.0");
  }, SLOW);

  test("RLC-13: a release PR that adds snapshots and their heading passes candidate and fails publication until merged", () => {
    const dir = fixture("drafts");
    const { s } = releaseDrafts(dir);
    const candidate = check({ phase: "candidate", repo: dir });
    expect(refusals(candidate)).toEqual([]);
    expect(summary(candidate).passed).toBe(true);
    for (const p of packages(candidate)) {
      expect(p.pin).toBe(s);
      // Reviewable, and still not a release: the default branch has not accepted it.
      expect(p.eligible).toBe(false);
      expect(p.blocking.map((b) => b.code)).toEqual(["release.not_accepted", "release.not_accepted"]);
    }
    const before = check({ phase: "publication", repo: dir });
    expect(summary(before).passed).toBe(false);
    expect(codes(before)).toEqual(["pin.unreachable", "release.not_accepted"]);
    expect(refusals(before).filter((r) => r.package === READ && r.code === "release.not_accepted").map((r) => `${r.id}@${r.version}`).sort()).toEqual(["parley.lens@1.1.0", "parley.query@1.1.0"]);
    // Merged with a merge commit, S stays reachable and the same tree is a release.
    git(dir, "checkout", "-q", "main");
    git(dir, "merge", "-q", "--no-ff", "-m", "Merge the 0.2.1 release", "release");
    acceptOnMain(dir);
    const after = check({ phase: "publication", repo: dir });
    expect(refusals(after)).toEqual([]);
    expect(summary(after).eligible.sort()).toEqual([EMIT, PY, READ].sort());
    // Development on the merged tree now reports every package eligible.
    expect(summary(check({ phase: "development", repo: dir })).not_eligible).toEqual([]);
  }, SLOW);

  test("RLC-14: a package that declares no built-in identity is judged by what it bundles", () => {
    const dir = fixture("released");
    put(dir, "packages/parley-read/src/query.ts", "export const VIEWS = [] as const;\n");
    put(dir, "packages/parley-read/src/digest.ts", "export const NOTHING = 0;\n");
    const lines = check({ phase: "publication", repo: dir });
    expect(refusals(lines)).toEqual([]);
    expect(pkg(lines, READ)).toMatchObject({ declared: 0, bundled: 3, passed: true, eligible: true });
  }, SLOW);

  test("RLC-15: a top-level file that differs from its snapshot only in key order passes; the snapshot is byte-frozen", () => {
    const dir = fixture("released");
    git(dir, "checkout", "-q", "-b", "reorder");
    const doc = schemaDoc("parley.error", "2.0.0");
    const reordered = text(Object.fromEntries(Object.entries(doc).reverse()));
    expect(reordered).not.toBe(get(dir, top("parley.error")));
    expect(JSON.parse(reordered)).toEqual(JSON.parse(get(dir, top("parley.error"))));
    put(dir, top("parley.error"), reordered);
    commit(dir, "the top-level file re-serialised, the value unchanged");
    sync(dir);
    commit(dir, "package copies synced from it");
    const lines = check({ phase: "candidate", repo: dir });
    expect(refusals(lines)).toEqual([]);
    expect(summary(lines).passed).toBe(true);
    // The same re-serialisation of the snapshot is a change to a released version.
    put(dir, snap("parley.error", "2.0.0"), reordered);
    commit(dir, "the snapshot re-serialised");
    expect(codes(check({ phase: "candidate", repo: dir }))).toEqual(["snapshot.modified"]);
    // And a top-level file that differs in value is refused whatever its bytes.
    git(dir, "checkout", "-q", "HEAD~1", "--", snap("parley.error", "2.0.0"));
    put(dir, top("parley.error"), text({ ...doc, description: "changed" }));
    const differs = check({ phase: "development", repo: dir });
    expect(refusals(differs).find((r) => r.code === "toplevel.differs")).toMatchObject({ id: "parley.error", version: "2.0.0", path: top("parley.error") });
  }, SLOW);

  test("RLC-16: a snapshot whose content names another identity than its path is rejected", () => {
    const dir = fixture("drafts");
    releaseDrafts(dir);
    // The 1.1.0 path re-pointed at the 1.0.0 definition.
    put(dir, snap("parley.query", "1.1.0"), get(dir, snap("parley.query", "1.0.0")));
    const lines = check({ phase: "candidate", repo: dir });
    expect(refusals(lines).find((r) => r.code === "snapshot.mismatched")?.path).toBe(snap("parley.query", "1.1.0"));
    expect(summary(lines).passed).toBe(false);
  }, SLOW);

  test("RLC-17: the default baseline is the merge base with origin/main, and --base names another", () => {
    const dir = fixture("drafts");
    const main = git(dir, "rev-parse", "origin/main");
    releaseDrafts(dir);
    const lines = check({ phase: "candidate", repo: dir });
    expect(lines[0]).toMatchObject({ event: "release.baseline", phase: "candidate", base: "merge-base(HEAD, origin/main)", commit: main, resolved: true, snapshots: 3 });
    const first = git(dir, "rev-list", "--max-parents=0", "HEAD");
    expect(check({ phase: "candidate", repo: dir, base: first })[0]).toMatchObject({ base: first, commit: first, resolved: true });
  }, SLOW);
});

describe("release eligibility: output and the real tree (flyingrobots/parley#145)", () => {
  const cli = (args: string[], cwd = REPO) => spawnSync("bun", ["run", join(REPO, "scripts/release-check.ts"), ...args], { cwd, encoding: "utf8" });
  const parse = (out: string) => out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  const schema = () => JSON.parse(readFileSync(join(REPO, "scripts/release-check.schema.json"), "utf8"));

  test("RLC-18: development on this repository passes, and its report is well-formed", () => {
    const lines = check({ phase: "development", repo: REPO });
    expect(refusals(lines).map((r) => `${r.package} ${r.code} ${r.problem}`)).toEqual([]);
    const s = summary(lines);
    expect(s.passed).toBe(true);
    const names = readdirSync(join(REPO, "packages")).filter((d) => existsSync(join(REPO, "packages", d, "package.json")))
      .map((d) => JSON.parse(readFileSync(join(REPO, "packages", d, "package.json"), "utf8")).name as string).sort();
    expect(packages(lines).map((p) => p.package).sort()).toEqual(names);
    expect(names.length).toBeGreaterThanOrEqual(3);
    expect([...s.eligible, ...s.not_eligible].sort()).toEqual(names);
    for (const p of packages(lines)) {
      expect(p.passed).toBe(true);
      expect(p.bundled).toBeGreaterThan(0);
      expect(p.pin).toMatch(/^[0-9a-f]{40}$/);
      // The report states its own reason: a package is eligible exactly when nothing blocks it.
      expect(p.eligible).toBe(p.blocking.length === 0 && p.blockers.length === 0);
      // A blocking draft is a draft: no snapshot of that pair exists in this tree.
      for (const b of p.blocking.filter((x) => x.code === "schema.unreleased")) expect(existsSync(join(REPO, snap(b.id, b.version))), `${b.id}@${b.version}`).toBe(false);
    }
  }, SLOW);

  test("RLC-19: the command prints JSON Lines, exits 0 for a pass and 1 for a refusal, and --human switches to prose", () => {
    const dev = cli(["--phase", "development"]);
    expect(dev.status).toBe(0);
    expect(dev.stderr).toBe("");
    const lines = parse(dev.stdout);
    expect(lines[0]?.event).toBe("release.baseline");
    expect(lines[lines.length - 1]).toMatchObject({ event: "release.summary", phase: "development", passed: true });
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema());
    for (const l of lines) expect(validate(l), JSON.stringify(validate.errors) + " for " + JSON.stringify(l)).toBe(true);

    const dir = fixture("drafts");
    const refused = cli(["--phase", "publication", "--repo", dir, "--base", "origin/main"]);
    expect(refused.status).toBe(1);
    expect(parse(refused.stdout).filter((l) => l.event === "release.refusal" && l.code === "schema.unreleased").length).toBe(6);
    const tarball = pack(dir, "parley-read");
    const artifact = cli(["--phase", "development", "--repo", dir, "--artifact", tarball]);
    expect(artifact.status).toBe(0);
    expect(parse(artifact.stdout).filter((l) => l.event === "release.package")).toMatchObject([{ package: READ, source: "artifact", path: tarball, eligible: false }]);

    const prose = cli(["--phase", "publication", "--repo", dir, "--human"]);
    expect(prose.status).toBe(1);
    expect(() => JSON.parse(prose.stdout.split("\n")[0] ?? "")).toThrow();
    expect(prose.stdout).toContain("parley.query@1.1.0");
  }, SLOW);

  test("RLC-20: a usage error is one schema'd line on stderr and exit 2; --help describes the command", () => {
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema());
    for (const args of [[], ["--phase", "stable"], ["--phase", "candidate", "--frobnicate"], ["--phase", "candidate", "--base"]]) {
      const r = cli(args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stdout).toBe("");
      const lines = parse(r.stderr);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ event: "error", code: "release_check.usage" });
      expect(validate(lines[0])).toBe(true);
    }
    const missing = cli(["--phase", "candidate", "--repo", join(scratch, "not-a-repository")]);
    expect(missing.status).toBe(2);
    expect(parse(missing.stderr)[0]).toMatchObject({ event: "error", code: "release_check.not_a_repository" });
    const help = cli(["--help"]);
    expect(help.status).toBe(0);
    const h = parse(help.stdout);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ event: "release.help" });
    expect(validate(h[0])).toBe(true);
  }, SLOW);

  test("RLC-21: a tarball packed from a real package here is read as that package's source tree is", () => {
    const out = mkdtempSync(join(scratch, "packed-"));
    run("bun", ["pm", "pack", "--destination", out, "--quiet"], join(REPO, "packages/parley-read"));
    const tarball = join(out, readdirSync(out).find((f) => f.endsWith(".tgz")) ?? "missing.tgz");
    const lines = check({ phase: "development", repo: REPO, artifacts: [tarball, join(REPO, "packages/parley-emit-py/parley_emit.py")] });
    expect(refusals(lines)).toEqual([]);
    const tree = check({ phase: "development", repo: REPO });
    for (const [artifact, source] of [[READ, READ], ["parley_emit.py", PY]] as const) {
      const a = pkg(lines, artifact), t = pkg(tree, source);
      expect(a.source).toBe("artifact");
      expect({ version: a.version, pin: a.pin, bundled: a.bundled, declared: a.declared, blocking: a.blocking }).toEqual({ version: t.version, pin: t.pin, bundled: t.bundled, declared: t.declared, blocking: t.blocking });
    }
  }, SLOW);

  // This case reads the lines the cases above produced, so it is meaningful only in a whole-file
  // run: building every refusal a second time here would double the file's cost.
  test("RLC-22: every line the checker emitted in these cases validates against its own schema", () => {
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema());
    expect(everyLine.length).toBeGreaterThan(100);
    const seen = new Set<string>();
    for (const l of everyLine) {
      const line = stamp(l);
      seen.add(l.event === "release.refusal" ? `refusal:${l.code}` : l.event);
      expect(validate(line), JSON.stringify(validate.errors) + " for " + JSON.stringify(line)).toBe(true);
      expect(human(l).length).toBeGreaterThan(0);
    }
    // Every refusal code the schema admits was produced by a case above, and no other.
    const declared: string[] = schema().$defs.code.enum;
    expect([...seen].filter((x) => x.startsWith("refusal:")).map((x) => x.slice(8)).sort()).toEqual([...declared].sort());
    for (const event of ["release.baseline", "release.package", "release.summary"]) expect(seen.has(event)).toBe(true);
  });
});
