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
import { EMIT, PY, READ, REPO, SLOW, acceptOnMain, addDrafts, buildReleased, commit, edit, get, git, put, releaseDrafts, run, schemaDoc, snap, sync, text, top } from "./release-fixtures.ts";

const PHASES: Phase[] = ["development", "candidate", "publication"];
const scratch = mkdtempSync(join(tmpdir(), "parley-release-check-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let made = 0;

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

describe("release eligibility: a backdated heading and the frozen-since reference (flyingrobots/parley#152, flyingrobots/parley#153)", () => {
  /** A release branch that snapshots the two drafts and names them under the 0.2.0 heading, which the baseline already has. */
  function backdate(dir: string, heading = "## [0.2.0] — 2026-01-01"): void {
    git(dir, "checkout", "-q", "-b", "backdated");
    for (const id of ["parley.query", "parley.lens"]) put(dir, snap(id, "1.1.0"), get(dir, top(id)));
    put(dir, "CHANGELOG.md", [
      "# Changelog", "", "## [Unreleased]", "", heading, "", "### Added", "",
      "- `parley.error` 2.0.0, `parley.query` 1.0.0 and `parley.lens` 1.0.0.",
      "- `parley.query` 1.1.0 and `parley.lens` 1.1.0.", "",
    ].join("\n"));
    commit(dir, "S: snapshots named under a release that was already cut");
    sync(dir);
    commit(dir, "P: package copies synced from S");
  }

  test("RLC-23: a new snapshot named only under a release heading the baseline already has: candidate rejects, naming the pair", () => {
    const dir = fixture("drafts");
    backdate(dir);
    const lines = check({ phase: "candidate", repo: dir });
    expect(summary(lines).passed).toBe(false);
    expect(codes(lines)).toEqual(["release.heading_backdated"]);
    for (const name of [EMIT, READ, PY]) {
      expect(refusals(lines).filter((r) => r.package === name).map((r) => `${r.id}@${r.version}`).sort(), name).toEqual(["parley.lens@1.1.0", "parley.query@1.1.0"]);
      expect(pkg(lines, name).passed).toBe(false);
    }
    expect(refusals(lines)[0]?.problem).toContain("[0.2.0]");
  }, SLOW);

  test("RLC-24: a heading is the same heading when its date is edited: naming a new snapshot under it is still rejected", () => {
    const dir = fixture("drafts");
    backdate(dir, "## [0.2.0] — 2026-11-24");
    const lines = check({ phase: "candidate", repo: dir });
    expect(codes(lines)).toEqual(["release.heading_backdated"]);
    expect(refusals(lines).filter((r) => r.package === READ).map((r) => `${r.id}@${r.version}`).sort()).toEqual(["parley.lens@1.1.0", "parley.query@1.1.0"]);
  }, SLOW);

  test("RLC-25: a new heading releases a new snapshot whatever a pull request does to an old entry's text or date", () => {
    const dir = fixture("drafts");
    releaseDrafts(dir);
    // The positive control of RLC-13, with the old entry reworded and re-dated in the same branch:
    // entries are not compared by text, so a typo fix in a released entry is not a refusal.
    edit(dir, "CHANGELOG.md", "## [0.2.0] — 2026-01-01", "## [0.2.0] — 2026-01-02");
    edit(dir, "CHANGELOG.md", "- `parley.error` 2.0.0, `parley.query` 1.0.0 and `parley.lens` 1.0.0.", "- The first release: `parley.error` 2.0.0, `parley.query` 1.0.0, `parley.lens` 1.0.0.");
    commit(dir, "reword and re-date a released entry");
    const reworded = check({ phase: "candidate", repo: dir });
    expect(refusals(reworded)).toEqual([]);
    expect(summary(reworded).passed).toBe(true);
    // Named under the new heading and repeated under the old one, the pair is released by the new one.
    edit(dir, "CHANGELOG.md", "- The first release:", "- (`parley.query` 1.1.0 came later.) The first release:");
    const both = check({ phase: "candidate", repo: dir });
    expect(refusals(both)).toEqual([]);
    // With no new snapshot, an edited old entry is nothing the rule speaks to.
    const quiet = fixture("released");
    edit(quiet, "CHANGELOG.md", "## [0.2.0] — 2026-01-01", "## [0.2.0] — 2026-01-02");
    commit(quiet, "re-date a released entry");
    expect(refusals(check({ phase: "candidate", repo: quiet }))).toEqual([]);
  }, SLOW);

  /** The default branch after a coordinated edit of a released schema merged: `before` is the commit a release tag would name. */
  function mergedEdit(dir: string): string {
    const before = git(dir, "rev-parse", "HEAD");
    git(dir, "tag", "spec-v0.2.0", before);
    const changed = text({ ...schemaDoc("parley.error", "2.0.0"), description: "a released version, edited in place" });
    put(dir, top("parley.error"), changed);
    put(dir, snap("parley.error", "2.0.0"), changed);
    commit(dir, "S': edit a released schema and its snapshot together");
    sync(dir);
    commit(dir, "P': every package copy re-synced from the edit");
    acceptOnMain(dir);
    return before;
  }

  test("RLC-26: a coordinated edit that has merged passes publication on the default branch, and is rejected against a frozen-since reference", () => {
    const dir = fixture("released");
    const before = mergedEdit(dir);
    // The gap: on the default branch the baseline is HEAD, so the tree is compared with itself.
    const gap = check({ phase: "publication", repo: dir });
    expect(refusals(gap)).toEqual([]);
    expect(summary(gap).passed).toBe(true);
    expect(gap[0]).toMatchObject({ event: "release.baseline", commit: git(dir, "rev-parse", "HEAD"), frozen_since: null, frozen_since_commit: null, frozen_since_snapshots: null });
    // An earlier `--base` does not close it: the pins now name a commit made since that ref.
    expect(codes(check({ phase: "publication", repo: dir, base: "spec-v0.2.0" }))).toContain("pin.unreachable");
    for (const phase of PHASES) {
      const lines = check({ phase, repo: dir, frozenSince: "spec-v0.2.0" });
      expect(summary(lines).passed, phase).toBe(false);
      expect(refusals(lines).map((r) => ({ package: r.package, code: r.code, path: r.path })), phase).toEqual([{ package: null, code: "snapshot.modified", path: snap("parley.error", "2.0.0") }]);
      expect(refusals(lines)[0]?.problem).toContain("spec-v0.2.0");
      for (const p of packages(lines)) expect(p, `${phase} ${p.package}`).toMatchObject({ eligible: false, blockers: ["snapshot.modified"] });
      // Both references are reported, each with the commit it names.
      expect(lines[0]).toMatchObject({ event: "release.baseline", base: "merge-base(HEAD, origin/main)", commit: git(dir, "rev-parse", "HEAD"), snapshots: 3, frozen_since: "spec-v0.2.0", frozen_since_commit: before, frozen_since_snapshots: 3 });
    }
    // A snapshot deleted and merged is seen the same way.
    rmSync(join(dir, snap("parley.lens", "1.0.0")));
    commit(dir, "delete a released snapshot");
    acceptOnMain(dir);
    expect(refusals(check({ phase: "publication", repo: dir, frozenSince: "spec-v0.2.0" })).filter((r) => r.package === null).map((r) => `${r.code} ${r.path}`).sort())
      .toEqual([`snapshot.deleted ${snap("parley.lens", "1.0.0")}`, `snapshot.modified ${snap("parley.error", "2.0.0")}`]);
  }, SLOW);

  test("RLC-27: a frozen-since reference at which every snapshot is unchanged changes nothing, and releases made since it still pass", () => {
    const dir = fixture("drafts");
    const before = git(dir, "rev-parse", "HEAD");
    releaseDrafts(dir);
    git(dir, "checkout", "-q", "main");
    git(dir, "merge", "-q", "--no-ff", "-m", "Merge the 0.2.1 release", "release");
    acceptOnMain(dir);
    const strip = (lines: Line[]) => lines.slice(1);
    for (const phase of PHASES) {
      const without = check({ phase, repo: dir }), withRef = check({ phase, repo: dir, frozenSince: before });
      expect(strip(withRef), phase).toEqual(strip(without));
      expect(summary(withRef).passed, phase).toBe(true);
      // Five snapshots now, three at the reference: the two released since it are not its business.
      expect(withRef[0]).toMatchObject({ snapshots: 5, frozen_since: before, frozen_since_commit: before, frozen_since_snapshots: 3 });
    }
    // Naming the baseline's own commit is allowed and says so.
    expect(refusals(check({ phase: "publication", repo: dir, frozenSince: "HEAD" }))).toEqual([]);
  }, SLOW);

  test("RLC-28: a frozen-since reference that names no commit, or one that is not an ancestor of HEAD, is a refusal in every phase", () => {
    const dir = fixture("released");
    git(dir, "checkout", "-q", "-b", "elsewhere");
    commit(dir, "a commit main never had");
    git(dir, "checkout", "-q", "main");
    for (const phase of PHASES) {
      const none = check({ phase, repo: dir, frozenSince: "no-such-tag" });
      expect(refusals(none).map((r) => ({ package: r.package, code: r.code })), phase).toEqual([{ package: null, code: "frozen_since.unresolved" }]);
      expect(none[0]).toMatchObject({ frozen_since: "no-such-tag", frozen_since_commit: null, frozen_since_snapshots: null });
      expect(summary(none)).toMatchObject({ passed: false, eligible: [] });
      const aside = check({ phase, repo: dir, frozenSince: "elsewhere" });
      expect(refusals(aside).map((r) => ({ package: r.package, code: r.code })), phase).toEqual([{ package: null, code: "frozen_since.not_ancestor" }]);
      expect(aside[0]).toMatchObject({ frozen_since: "elsewhere", frozen_since_commit: git(dir, "rev-parse", "elsewhere") });
      expect(summary(aside)).toMatchObject({ passed: false, eligible: [] });
    }
    // A reference that looks like an option names nothing.
    expect(codes(check({ phase: "publication", repo: dir, frozenSince: "--all" }))).toEqual(["frozen_since.unresolved"]);
  }, SLOW);

  test("RLC-29: --frozen-since on the command line: exit 1 for the merged edit, both references in the first line and in prose", () => {
    const cli = (args: string[]) => spawnSync("bun", ["run", join(REPO, "scripts/release-check.ts"), ...args], { encoding: "utf8" });
    const dir = fixture("released");
    const before = mergedEdit(dir);
    expect(cli(["--phase", "publication", "--repo", dir]).status).toBe(0);
    const refused = cli(["--phase", "publication", "--repo", dir, "--frozen-since", "spec-v0.2.0"]);
    expect(refused.status).toBe(1);
    const lines = refused.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ event: "release.baseline", frozen_since: "spec-v0.2.0", frozen_since_commit: before, _schema: { id: "parley.tooling.release_check", version: "1.1.0" } });
    expect(lines.filter((l) => l.event === "release.refusal").map((l) => l.code)).toEqual(["snapshot.modified"]);
    const prose = cli(["--phase", "publication", "--repo", dir, "--frozen-since", "spec-v0.2.0", "--human"]);
    expect(prose.stdout.split("\n")[0]).toContain(`frozen since spec-v0.2.0 = ${before}`);
    const usage = cli(["--phase", "publication", "--frozen-since"]);
    expect(usage.status).toBe(2);
    expect(JSON.parse(usage.stderr)).toMatchObject({ event: "error", code: "release_check.usage" });
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
