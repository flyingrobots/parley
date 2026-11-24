// The release gate, its report and the clean-consumer check (flyingrobots/parley#147). A release
// workflow cannot be run from a pull request, and a real tag cannot be used for a negative test, so
// the workflows are thin and what they do lives in scripts/release-gate.ts and
// scripts/clean-consumer.ts, exercised here on throwaway repositories with real git history. The
// ledger is docs/topics/release/test-plan.md.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkConsumer, type ConsumerResult } from "./clean-consumer.ts";
import { runGate, stampGate, type Gate, type GateLine, type Report } from "./release-gate.ts";
import { EMIT, PY, READ, REPO, SLOW, acceptOnMain, addDrafts, buildReleased, commit, edit, get, git, put, releaseDrafts, schemaDoc, snap, sync, text, top } from "./release-fixtures.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "parley-release-gate-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let made = 0;

const PACKAGES = [
  { dir: "parley-emit", name: EMIT, version: "0.4.0", previous: "parley-emit-v0.3.0", file: "flyingrobots-parley-emit-0.4.0.tgz" },
  { dir: "parley-read", name: READ, version: "0.2.0", previous: "parley-read-v0.1.1", file: "flyingrobots-parley-read-0.2.0.tgz" },
  { dir: "parley-emit-py", name: PY, version: "0.3.0", previous: "parley-emit-py-v0.2.0", file: "parley_emit.py" },
] as const;
const BLOCKED = ["parley.lens@1.1.0", "parley.query@1.1.0"];

/**
 * `drafts` is the default branch as it is on 2026-11-24: every package carries the two drafts, each
 * has a dated changelog heading for its version and a tag for its previous release. `released` is
 * the same after the release pull request merged with a merge commit.
 */
const templates = { drafts: join(scratch, "template-drafts"), released: join(scratch, "template-released") };
beforeAll(() => {
  buildReleased(templates.drafts);
  // The reader depends on the writer by range, as the real one does: that is what --consumer proves.
  const reader = JSON.parse(get(templates.drafts, "packages/parley-read/package.json"));
  put(templates.drafts, "packages/parley-read/package.json", text({ ...reader, dependencies: { [EMIT]: "^0.4.0" } }));
  commit(templates.drafts, "the reader depends on the writer");
  acceptOnMain(templates.drafts);
  for (const p of PACKAGES) git(templates.drafts, "tag", p.previous);
  addDrafts(templates.drafts);
  for (const p of PACKAGES) put(templates.drafts, `packages/${p.dir}/CHANGELOG.md`, `# Changelog\n\n## [Unreleased]\n\n## [${p.version}] — 2026-11-24\n\n- A release.\n`);
  commit(templates.drafts, "package changelogs");
  acceptOnMain(templates.drafts);
  cpSync(templates.drafts, templates.released, { recursive: true });
  releaseDrafts(templates.released);
  git(templates.released, "checkout", "-q", "main");
  git(templates.released, "merge", "-q", "--no-ff", "-m", "Merge the 0.2.1 release", "release");
  acceptOnMain(templates.released);
}, SLOW);

function fixture(of: keyof typeof templates): string {
  const dir = join(scratch, `repo-${++made}`);
  cpSync(templates[of], dir, { recursive: true });
  return dir;
}
const outDir = () => join(scratch, `out-${++made}`);
const sha = (algorithm: string, file: string) => createHash(algorithm).update(readFileSync(file)).digest("hex");
const schemaOf = (name: string) => JSON.parse(readFileSync(join(REPO, "scripts", name), "utf8"));
const refused = (g: Gate) => g.lines.filter((l): l is Extract<GateLine, { event: "gate.refusal" }> => l.event === "gate.refusal").map((l) => l.code).sort();
const result = (g: Gate) => { const r = g.lines[g.lines.length - 1]; if (r?.event !== "gate.result") throw new Error("the last line is not gate.result"); return r; };
const blockedBy = (g: Gate) => [...new Set(result(g).blocking.map((b) => `${b.id}@${b.version}`))].sort();
const cli = (args: string[], cwd = REPO) => spawnSync("bun", ["run", join(REPO, "scripts/release-gate.ts"), ...args], { cwd, encoding: "utf8" });
const parse = (out: string) => out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

const everyLine: GateLine[] = [];
const everyReport: Report[] = [];
function gate(o: Parameters<typeof runGate>[0]): Gate {
  const g = runGate(o);
  everyLine.push(...g.lines);
  everyReport.push(g.report);
  return g;
}

describe("the release gate (flyingrobots/parley#147)", () => {
  test("GATE-1: a package bundling a draft schema is refused, for all three packages, naming the identities", () => {
    const dir = fixture("drafts");
    for (const p of PACKAGES) {
      const out = outDir();
      const g = gate({ package: p.dir, repo: dir, out });
      expect(g.passed, p.dir).toBe(false);
      expect(blockedBy(g), p.dir).toEqual(BLOCKED);
      expect(result(g)).toMatchObject({ event: "gate.result", passed: false, package: p.name, version: p.version });
      // The report says the same, and it is written whatever the verdict, for the job summary.
      expect(g.report.gate.passed).toBe(false);
      expect(JSON.parse(readFileSync(join(out, "release-report.json"), "utf8"))).toEqual(JSON.parse(JSON.stringify(g.report)));
      // By the package's published name too.
      expect(runGate({ package: p.name, repo: dir }).passed).toBe(false);
    }
    // The command the tagger runs: exit 1, and the identities are in its output.
    for (const p of PACKAGES) {
      const r = cli(["--", p.dir, "--repo", dir]);
      expect(r.status, `${p.dir}: ${r.stderr}`).toBe(1);
      expect(r.stderr).toBe("");
      const last = parse(r.stdout).pop();
      expect(last).toMatchObject({ event: "gate.result", passed: false, _schema: { id: "parley.tooling.release_gate" } });
      expect(r.stdout).toContain('"id":"parley.query","version":"1.1.0"');
      expect(r.stdout).toContain('"id":"parley.lens","version":"1.1.0"');
    }
    const prose = cli(["parley-read", "--repo", dir, "--human"]);
    expect(prose.status).toBe(1);
    expect(prose.stdout).toContain("parley.query@1.1.0");
    expect(prose.stdout).toContain("parley.lens@1.1.0");
    expect(() => JSON.parse(prose.stdout.split("\n")[0] ?? "")).toThrow();
  }, 2 * SLOW);

  test("GATE-2: once the schemas are released the gate passes, on one artifact whose digest is in every place it is named", () => {
    const dir = fixture("released");
    for (const p of PACKAGES) {
      const out = outDir();
      const g = gate({ package: p.dir, repo: dir, out, tag: `${p.dir}-v${p.version}` });
      expect(refused(g), p.dir).toEqual([]);
      expect(g.passed, p.dir).toBe(true);
      expect(blockedBy(g)).toEqual([]);
      // One artifact, built once, and nothing else beside it but its digest and its report.
      expect(readdirSync(out).sort()).toEqual(["SHA256SUMS", p.file, "release-report.json"].sort());
      const digest = sha("sha256", join(out, p.file));
      const artifact = g.lines.find((l) => l.event === "gate.artifact");
      expect(artifact).toMatchObject({ file: p.file, path: join(out, p.file), sha256: digest, packed: p.file.endsWith(".tgz") });
      // The checker judged that file, not the tree: its own line carries the same digest.
      const checked = g.lines.find((l) => l.event === "release.package");
      expect(checked).toMatchObject({ source: "artifact", path: join(out, p.file), sha256: digest, passed: true, eligible: true });
      expect(get(out, "SHA256SUMS")).toBe(`${digest}  ${p.file}\n`);
      expect(g.report.artifact).toMatchObject({ file: p.file, sha256: digest, sha1: sha("sha1", join(out, p.file)), integrity: `sha512-${createHash("sha512").update(readFileSync(join(out, p.file))).digest("base64")}` });
      expect(result(g)).toMatchObject({ passed: true, sha256: digest, report: join(out, "release-report.json") });
    }
    // The Python artifact is the file at the commit, byte for byte.
    const out = outDir();
    gate({ package: "parley-emit-py", repo: dir, out });
    expect(readFileSync(join(out, "parley_emit.py")).equals(readFileSync(join(dir, "packages/parley-emit-py/parley_emit.py")))).toBe(true);
    const ok = cli(["parley-emit-py", "--repo", dir]);
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
  }, 2 * SLOW);

  test("GATE-3: the report names the package, the commit and tree, the spec release, every bundled schema with its snapshot digest, and the gate's result", () => {
    const dir = fixture("released");
    const out = outDir();
    const g = gate({ package: "parley-read", repo: dir, out, tag: "parley-read-v0.2.0" });
    const r = g.report;
    expect(r).toMatchObject({
      package: { name: READ, version: "0.2.0", directory: "packages/parley-read" },
      tag: "parley-read-v0.2.0",
      source: { commit: git(dir, "rev-parse", "HEAD"), tree: git(dir, "rev-parse", "HEAD^{tree}"), on_default_branch: true, clean: true },
      spec_release: { version: "0.2.1", date: "2026-11-24" },
      gate: { phase: "publication", passed: true, frozen_since: "parley-read-v0.1.1", frozen_since_commit: git(dir, "rev-parse", "parley-read-v0.1.1"), refusals: [] },
      consumer: null,
    });
    expect(r.schemas.map((s) => `${s.id}@${s.version}`).sort()).toEqual(["parley.error@2.0.0", "parley.lens@1.0.0", "parley.lens@1.1.0", "parley.query@1.0.0", "parley.query@1.1.0"]);
    for (const s of r.schemas) {
      expect(s.snapshot).toBe(snap(s.id, s.version));
      expect(s.snapshot_sha256, `${s.id}@${s.version}`).toBe(sha("sha256", join(dir, snap(s.id, s.version))));
    }
    expect(r.schemas.filter((s) => s.declared).map((s) => `${s.id}@${s.version}`).sort()).toEqual(["parley.lens@1.1.0", "parley.query@1.1.0"]);
    expect(r.schemas.find((s) => s.id === "parley.query" && s.version === "1.1.0")?.released_in).toBe("0.2.1");
    expect(r.schemas.find((s) => s.id === "parley.query" && s.version === "1.0.0")?.released_in).toBe("0.2.0");
    // Each file of the tarball by digest, so a repacked tarball can be compared file by file.
    expect(r.artifact!.files.map((f) => f.path)).toContain("package.json");
    expect(r.artifact!.files.find((f) => f.path === "src/schemas.ts")?.sha256).toBe(sha("sha256", join(dir, "packages/parley-read/src/schemas.ts")));
    // The report is beside the artifact, never inside it.
    expect(r.artifact!.files.some((f) => f.path.includes("release-report"))).toBe(false);

    // A draft has no snapshot digest to report, and the report says the gate refused.
    const draft = gate({ package: "parley-read", repo: fixture("drafts") }).report;
    expect(draft.gate.passed).toBe(false);
    expect(draft.schemas.find((s) => s.id === "parley.query" && s.version === "1.1.0")).toMatchObject({ snapshot_sha256: null, released_in: null });
    expect(draft.gate.refusals.filter((x) => x.code === "schema.unreleased").map((x) => `${x.id}@${x.version}`).sort()).toEqual(BLOCKED);
  }, SLOW);

  test("GATE-4: the frozen-since reference is the package's previous release tag on this history, and a merged edit since it is refused", () => {
    const dir = fixture("released");
    const derived = (g: Gate) => g.lines.find((l) => l.event === "gate.frozen_since");
    expect(derived(gate({ package: "parley-read", repo: dir }))).toMatchObject({ ref: "parley-read-v0.1.1", commit: git(dir, "rev-parse", "parley-read-v0.1.1"), how: "derived" });
    // Not the tag of the version being released, not a later version's, not another package's,
    // not one that is no ancestor of HEAD; the highest earlier version, by number and not by name.
    git(dir, "tag", "parley-read-v0.2.0");
    git(dir, "tag", "parley-read-v0.10.0");
    git(dir, "tag", "parley-read-v0.1.10", "parley-read-v0.1.1");
    git(dir, "tag", "parley-read-v0.1.9", "parley-read-v0.1.1");
    git(dir, "tag", "parley-read-v0.1.2-rc.1");
    git(dir, "checkout", "-q", "-b", "elsewhere", "parley-read-v0.1.1");
    commit(dir, "a commit main never had");
    git(dir, "tag", "parley-read-v0.1.99");
    git(dir, "checkout", "-q", "main");
    const g = gate({ package: "parley-read", repo: dir });
    expect(derived(g)).toMatchObject({ ref: "parley-read-v0.1.10", how: "derived" });
    expect(g.passed).toBe(true);
    // Named by hand, it is used as given.
    expect(derived(gate({ package: "parley-read", repo: dir, frozenSince: "parley-emit-v0.3.0" }))).toMatchObject({ ref: "parley-emit-v0.3.0", how: "given" });
    // A package with no earlier release has none, and the gate says so rather than inventing one.
    const first = fixture("released");
    for (const t of ["parley-read-v0.1.1"]) git(first, "tag", "-d", t);
    const none = gate({ package: "parley-read", repo: first });
    expect(derived(none)).toMatchObject({ ref: null, commit: null, how: "none" });
    expect(none.passed).toBe(true);
    expect(none.report.gate.frozen_since).toBeNull();

    // The gap of flyingrobots/parley#153, closed where a release is made: a released snapshot, its
    // top-level file and every copy edited and merged after the previous release.
    const edited = fixture("released");
    const changed = text({ ...schemaDoc("parley.error", "2.0.0"), description: "a released version, edited in place" });
    put(edited, top("parley.error"), changed);
    put(edited, snap("parley.error", "2.0.0"), changed);
    commit(edited, "S': edit a released schema and its snapshot together");
    sync(edited);
    commit(edited, "P': every package copy re-synced from the edit");
    acceptOnMain(edited);
    for (const p of PACKAGES) {
      const bad = gate({ package: p.dir, repo: edited });
      expect(bad.passed, p.dir).toBe(false);
      expect(bad.report.gate.refusals.map((x) => `${x.code} ${x.path}`), p.dir).toEqual([`snapshot.modified ${snap("parley.error", "2.0.0")}`]);
    }
  }, 2 * SLOW);

  test("GATE-5: a tag that is not this version's, a version with no dated changelog heading, a commit off the default branch and a dirty tree are each refused", () => {
    const dir = fixture("released");
    expect(refused(gate({ package: "parley-emit", repo: dir, tag: "parley-emit-v0.4.1" }))).toEqual(["gate.tag_mismatch"]);
    expect(refused(gate({ package: "parley-emit", repo: dir, tag: "parley-read-v0.4.0" }))).toEqual(["gate.tag_mismatch"]);
    expect(refused(gate({ package: "parley-emit-py", repo: dir, tag: "parley-emit-py-v0.3.0" }))).toEqual([]);

    put(dir, "notes.txt", "not committed\n");
    const dirty = gate({ package: "parley-emit", repo: dir });
    expect(refused(dirty)).toEqual(["gate.dirty_tree"]);
    expect(dirty.report.gate.refusals[0]?.problem).toContain("1 path(s) (notes.txt)");
    expect(dirty.report.source.clean).toBe(false);
    rmSync(join(dir, "notes.txt"));

    edit(dir, "packages/parley-emit/CHANGELOG.md", "## [0.4.0] — 2026-11-24", "## [0.4.0]");
    commit(dir, "an undated heading");
    acceptOnMain(dir);
    expect(refused(gate({ package: "parley-emit", repo: dir }))).toEqual(["gate.changelog_heading_missing"]);
    expect(refused(gate({ package: "parley-read", repo: dir }))).toEqual([]);

    const ahead = fixture("released");
    commit(ahead, "a commit the default branch does not have");
    const off = gate({ package: "parley-read", repo: ahead });
    expect(refused(off)).toEqual(["gate.not_on_default_branch"]);
    expect(off.passed).toBe(false);
    expect(off.report.source.on_default_branch).toBe(false);
  }, 2 * SLOW);

  test("GATE-6: the gate judges the artifact it is given: another package's, a manifest npm would not publish as written, a file that is not there", () => {
    const dir = fixture("released");
    const out = outDir();
    expect(gate({ package: "parley-read", repo: dir, out }).passed).toBe(true);
    const good = join(out, "flyingrobots-parley-read-0.2.0.tgz");
    expect(gate({ package: "parley-read", repo: dir, artifact: good }).passed).toBe(true);
    // Another package's artifact is not this package's release.
    expect(refused(gate({ package: "parley-emit", repo: dir, artifact: good }))).toEqual(["gate.artifact_mismatch"]);
    expect(refused(gate({ package: "parley-read", repo: dir, artifact: join(dir, "packages/parley-emit-py/parley_emit.py") }))).toEqual(["gate.artifact_mismatch"]);
    // A tarball whose manifest is not the repository's: the tree is right and the artifact is not.
    const stage = join(scratch, `stage-${++made}`);
    mkdirSync(stage, { recursive: true });
    expect(spawnSync("tar", ["-xzf", good, "-C", stage]).status).toBe(0);
    const manifest = JSON.parse(readFileSync(join(stage, "package/package.json"), "utf8"));
    writeFileSync(join(stage, "package/package.json"), text({ ...manifest, dependencies: { "@flyingrobots/parley-emit": "workspace:*" } }));
    const altered = join(scratch, `altered-${made}.tgz`);
    expect(spawnSync("tar", ["-czf", altered, "-C", stage, "package"]).status).toBe(0);
    expect(refused(gate({ package: "parley-read", repo: dir, artifact: altered }))).toEqual(["gate.manifest_differs", "gate.workspace_range"]);
    expect(gate({ package: "parley-read", repo: dir, artifact: join(scratch, "no-such.tgz") }).passed).toBe(false);
  }, 2 * SLOW);

  test("GATE-11: --consumer runs the clean consumer on the packed tarball once the artifact is otherwise releasable, records the writer in the report, and refuses when it refuses", () => {
    const dir = fixture("released");
    const asked: Parameters<typeof checkConsumer>[0][] = [];
    const answer = (refusals: ConsumerResult["refusals"]) => (o: Parameters<typeof checkConsumer>[0]): ConsumerResult => {
      asked.push(o);
      return { event: "consumer.result", passed: refusals.length === 0, dir: join(scratch, "elsewhere"), installed: true, reader: { name: READ, version: "0.2.0", integrity: "sha512-reader" }, dependency: { name: EMIT, version: "0.4.0", resolved: "https://registry.npmjs.org/@flyingrobots/parley-emit/-/parley-emit-0.4.0.tgz", integrity: "sha512-writer" }, smoke: null, refusals };
    };
    const out = outDir();
    const ok = gate({ package: "parley-read", repo: dir, out, consumer: true, consumerCheck: answer([]) });
    expect(ok.passed).toBe(true);
    // It was asked about the one tarball, the writer the reader depends on, and this repository.
    expect(asked).toEqual([{ tarball: join(out, "flyingrobots-parley-read-0.2.0.tgz"), dependency: EMIT, workspace: dir }]);
    expect(ok.report.consumer?.dependency).toEqual({ name: EMIT, version: "0.4.0", resolved: "https://registry.npmjs.org/@flyingrobots/parley-emit/-/parley-emit-0.4.0.tgz", integrity: "sha512-writer" });
    expect(ok.lines.some((l) => l.event === "gate.consumer")).toBe(true);
    const linked = gate({ package: "parley-read", repo: dir, consumer: true, consumerCheck: answer([{ code: "consumer.dependency_linked", problem: "it resolved from the workspace" }]) });
    expect(linked.passed).toBe(false);
    expect(refused(linked)).toEqual(["consumer.dependency_linked"]);
    expect(linked.report.gate.passed).toBe(false);
    // A refused artifact is not installed anywhere: the consumer is not reached.
    asked.length = 0;
    const draft = gate({ package: "parley-read", repo: fixture("drafts"), consumer: true, consumerCheck: answer([]) });
    expect(draft.passed).toBe(false);
    expect(asked).toEqual([]);
    expect(draft.report.consumer).toBeNull();
    // A package that depends on no package here has nothing to prove that way.
    expect(() => runGate({ package: "parley-emit", repo: dir, consumer: true })).toThrow(/depends on none/);
    expect(() => runGate({ package: "parley-emit-py", repo: dir, consumer: true })).toThrow(/depends on none/);
  }, 2 * SLOW);

  test("GATE-7: a usage error is one schema'd line on stderr and exit 2; --help describes the command", () => {
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schemaOf("release-gate.schema.json"));
    for (const args of [[], ["parley-nothing"], ["parley-read", "--frobnicate"], ["parley-read", "--out"], ["parley-read", "parley-emit"]]) {
      const r = cli(args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stdout).toBe("");
      const lines = parse(r.stderr);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ event: "error", code: "release_gate.usage" });
      expect(validate(lines[0]), JSON.stringify(validate.errors)).toBe(true);
    }
    const missing = cli(["parley-read", "--repo", join(scratch, "not-a-repository")]);
    expect(missing.status).toBe(2);
    expect(parse(missing.stderr)[0]).toMatchObject({ event: "error" });
    const help = cli(["--help"]);
    expect(help.status).toBe(0);
    const h = parse(help.stdout);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ event: "gate.help" });
    expect(validate(h[0]), JSON.stringify(validate.errors)).toBe(true);
  }, SLOW);
});

describe("the workflows' own steps, run here (flyingrobots/parley#147)", () => {
  interface Step { name?: string; uses?: string; run?: string; if?: string; id?: string }
  interface Job { needs?: string | string[]; steps: Step[] }
  const WORKFLOWS = [
    { file: "release-parley-emit.yml", pkg: PACKAGES[0], output: "tarball" },
    { file: "release-parley-read.yml", pkg: PACKAGES[1], output: "tarball" },
    { file: "release-parley-emit-py.yml", pkg: PACKAGES[2], output: "file" },
  ] as const;
  const jobs = (file: string) => (Bun.YAML.parse(readFileSync(join(REPO, ".github/workflows", file), "utf8")) as { jobs: Record<string, Job> }).jobs;

  /** A fixture the workflow's `bun run release-gate` resolves in: a root manifest whose script is this tree's gate. */
  function withScript(of: keyof typeof templates): string {
    const dir = fixture(of);
    put(dir, "package.json", text({ name: "fixture", private: true, scripts: { "release-gate": `bun run ${join(REPO, "scripts/release-gate.ts")}` } }));
    commit(dir, "the root manifest, with the gate as a script");
    acceptOnMain(dir);
    return dir;
  }

  /**
   * Run a job's `run` steps from `from` on, as the runner does: in order, with `bash -e`, and after
   * a failure only the steps marked `if: always()`. Steps that `uses` an action are recorded and
   * not run. Returns which steps ran and which one failed.
   */
  function runSteps(job: Job, from: number, cwd: string, env: Record<string, string>, expressions: Record<string, string> = {}) {
    const ran: string[] = [], skipped: string[] = [];
    let failed: string | null = null;
    job.steps.slice(from).forEach((step, i) => {
      const label = step.name ?? step.uses ?? `step ${from + i}`;
      if (failed !== null && step.if !== "always()") { skipped.push(label); return; }
      if (step.run === undefined) { ran.push(label); return; }
      const script = step.run.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_m, e: string) => { if (!(e in expressions)) throw new Error(`no value for the expression ${e}`); return expressions[e]!; });
      const r = spawnSync("bash", ["-e", "-c", script], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
      ran.push(label);
      if (r.status !== 0 && failed === null) failed = label;
    });
    return { ran, skipped, failed };
  }
  function runner() {
    const temp = join(scratch, `runner-${++made}`);
    mkdirSync(temp, { recursive: true });
    const env = { RUNNER_TEMP: temp, GITHUB_STEP_SUMMARY: join(temp, "summary.md"), GITHUB_OUTPUT: join(temp, "output.txt") };
    writeFileSync(env.GITHUB_STEP_SUMMARY, "");
    writeFileSync(env.GITHUB_OUTPUT, "");
    return { temp, env };
  }
  const gateAt = (job: Job) => job.steps.findIndex((s) => /release-gate/.test(s.run ?? ""));

  test("GATE-9: with a package bundling a draft schema, each workflow's gate job stops at the gate: the report is printed, no digest is recorded and nothing is uploaded", () => {
    const dir = withScript("drafts");
    for (const { file, pkg } of WORKFLOWS) {
      const gate = jobs(file).gate!;
      const { temp, env } = runner();
      const r = runSteps(gate, gateAt(gate), dir, { ...env, GITHUB_REF_NAME: `${pkg.dir}-v${pkg.version}` });
      expect(r.failed, file).toMatch(/release gate/);
      // After the refusal only the summary ran; the digest and the artifact upload did not.
      expect(r.ran, file).toEqual([r.failed!, "Print the release report"]);
      expect(r.skipped.some((s) => s.startsWith("actions/upload-artifact@")), file).toBe(true);
      expect(readFileSync(env.GITHUB_OUTPUT, "utf8"), file).toBe("");
      const summary = readFileSync(env.GITHUB_STEP_SUMMARY, "utf8");
      expect(summary, file).toContain('"passed": false');
      expect(summary, file).toContain("parley.query@1.1.0 has no snapshot");
      expect(summary, file).toContain("parley.lens@1.1.0 has no snapshot");
      expect(JSON.parse(readFileSync(join(temp, "release/release-report.json"), "utf8")).gate.passed, file).toBe(false);
    }
  }, 2 * SLOW);

  test("GATE-10: once the schemas are released, the gate job's steps pass and hand on one digest, and the release job's check refuses any other file", () => {
    const dir = withScript("released");
    // The reader's gate also installs from npm (--consumer), which a test does not do; its steps
    // are the same as the writer's otherwise, and CONS-1 to CONS-3 hold the consumer check.
    for (const { file, pkg, output } of WORKFLOWS.filter((w) => w.pkg.dir !== "parley-read")) {
      const all = jobs(file), gate = all.gate!;
      const { temp, env } = runner();
      const r = runSteps(gate, gateAt(gate), dir, { ...env, GITHUB_REF_NAME: `${pkg.dir}-v${pkg.version}` }, { "runner.temp": temp });
      expect(r.failed, file).toBeNull();
      expect(r.skipped, file).toEqual([]);
      const digest = sha("sha256", join(temp, "release", pkg.file));
      expect(readFileSync(env.GITHUB_OUTPUT, "utf8"), file).toBe(`sha256=${digest}\nfile=${pkg.file}\n`);
      expect(readFileSync(env.GITHUB_STEP_SUMMARY, "utf8"), file).toContain(`"sha256": "${digest}"`);

      // The release job: its verification step, on what the gate left and on a file that is not it.
      const release = all.release!;
      const verify = release.steps.findIndex((s) => (s.run ?? "").includes("needs.gate.outputs.sha256"));
      const only = { ...release, steps: [release.steps[verify]!] };
      const work = join(scratch, `work-${++made}`);
      cpSync(join(temp, "release"), join(work, "release-assets"), { recursive: true });
      const outputs = { "needs.gate.outputs.sha256": digest, [`needs.gate.outputs.${output}`]: pkg.file };
      const envs = { ...env, SHA256: digest, FILE: pkg.file };
      expect(runSteps(only, 0, work, envs, outputs).failed, file).toBeNull();
      writeFileSync(join(work, "release-assets", pkg.file), "another file under the same name\n");
      expect(runSteps(only, 0, work, envs, outputs).failed, file).not.toBeNull();
    }
  }, 2 * SLOW);
});

describe("the clean consumer (flyingrobots/parley#147)", () => {
  const WRITER = "@flyingrobots/parley-emit";
  const tarball = join(scratch, "reader.tgz");
  const integrity = (file: string) => `sha512-${createHash("sha512").update(readFileSync(file)).digest("base64")}`;
  beforeAll(() => writeFileSync(tarball, "stands in for the packed reader: only its digest is read\n"));

  /**
   * A consumer directory as `npm install <tarball>` leaves it, built by hand so the case needs no
   * registry: the real reader and writer of this tree as plain directories, and a lockfile.
   * `mutate` turns it into the directory a refusal is for.
   */
  function consumer(mutate?: (dir: string, lock: { packages: Record<string, Record<string, unknown>> }) => void, under = scratch): string {
    const dir = join(under, `consumer-${++made}`);
    const scope = join(dir, "node_modules/@flyingrobots");
    mkdirSync(scope, { recursive: true });
    for (const p of ["parley-read", "parley-emit"]) {
      mkdirSync(join(scope, p));
      cpSync(join(REPO, "packages", p, "src"), join(scope, p, "src"), { recursive: true });
      cpSync(join(REPO, "packages", p, "package.json"), join(scope, p, "package.json"));
    }
    // Third-party dependencies are not what the check is about; link the ones this tree installed.
    for (const dep of ["ajv", "ajv-formats"]) symlinkSync(realpathSync(join(REPO, "node_modules", dep)), join(dir, "node_modules", dep));
    writeFileSync(join(dir, "package.json"), text({ name: "clean-consumer", private: true }));
    const writer = JSON.parse(readFileSync(join(REPO, "packages/parley-emit/package.json"), "utf8")).version as string;
    const lock = { packages: {
      "": { name: "clean-consumer" },
      "node_modules/@flyingrobots/parley-read": { version: "0.2.0", resolved: `file:${tarball}`, integrity: integrity(tarball) },
      [`node_modules/${WRITER}`]: { version: writer, resolved: `https://registry.npmjs.org/@flyingrobots/parley-emit/-/parley-emit-${writer}.tgz`, integrity: "sha512-" + "A".repeat(86) + "==" },
    } as Record<string, Record<string, unknown>> };
    mutate?.(dir, lock);
    writeFileSync(join(dir, "package-lock.json"), text({ name: "clean-consumer", lockfileVersion: 3, ...lock }));
    return dir;
  }
  const everyResult: ConsumerResult[] = [];
  const check = (dir: string) => { const r = checkConsumer({ tarball, dir, dependency: WRITER, workspace: REPO, install: false }); everyResult.push(r); return r; };
  const codes = (r: ConsumerResult) => r.refusals.map((x) => x.code).sort();

  test("CONS-1: a reader and a writer installed from the registry into a directory outside the workspace pass, and the writer's version and integrity are recorded", () => {
    const dir = consumer();
    const r = check(dir);
    expect(r.refusals).toEqual([]);
    expect(r.passed).toBe(true);
    const writer = JSON.parse(readFileSync(join(REPO, "packages/parley-emit/package.json"), "utf8")).version as string;
    expect(r.dependency).toMatchObject({ name: WRITER, version: writer, resolved: `https://registry.npmjs.org/@flyingrobots/parley-emit/-/parley-emit-${writer}.tgz`, integrity: "sha512-" + "A".repeat(86) + "==" });
    expect(r.reader).toMatchObject({ name: READ, version: "0.2.0", integrity: integrity(tarball) });
    // The smoke read ran there, with the reader's own import of the writer resolving inside it.
    expect(r.smoke).toMatchObject({ ran: true, bundles: 1, records: 2, validated: 2, invalid: 0 });
    expect(r.smoke?.writer_path.startsWith(join(dir, "node_modules/@flyingrobots/parley-emit/"))).toBe(true);
  }, SLOW);

  test("CONS-2: a writer that resolved from the workspace is refused: a link in node_modules, a link in the lockfile, a file: resolution, or no entry", () => {
    // What `bun link` or a workspace install leaves: node_modules/<dep> is a link into the repository.
    const linked = consumer((dir) => {
      rmSync(join(dir, "node_modules", WRITER), { recursive: true });
      symlinkSync(join(REPO, "packages/parley-emit"), join(dir, "node_modules", WRITER));
    });
    const r = check(linked);
    expect(r.passed).toBe(false);
    expect(codes(r)).toEqual(["consumer.dependency_linked"]);
    expect(r.refusals[0]?.problem).toContain(join(REPO, "packages/parley-emit"));
    // The same directory, by the command the workflow's script exposes: exit 1.
    const run = spawnSync("bun", ["run", join(REPO, "scripts/clean-consumer.ts"), "--tarball", tarball, "--dir", linked, "--dependency", WRITER, "--workspace", REPO, "--no-install"], { encoding: "utf8" });
    expect(run.status, run.stdout + run.stderr).toBe(1);
    expect(JSON.parse(run.stdout.trim().split("\n").pop() ?? "")).toMatchObject({ event: "consumer.result", passed: false, _schema: { id: "parley.tooling.clean_consumer" } });

    expect(codes(check(consumer((_d, lock) => { lock.packages[`node_modules/${WRITER}`] = { resolved: "../../packages/parley-emit", link: true }; })))).toEqual(["consumer.dependency_linked"]);
    expect(codes(check(consumer((_d, lock) => { lock.packages[`node_modules/${WRITER}`] = { version: "0.4.0", resolved: "file:../parley-emit-0.4.0.tgz", integrity: "sha512-" + "B".repeat(86) + "==" }; })))).toEqual(["consumer.dependency_not_from_registry"]);
    expect(codes(check(consumer((_d, lock) => { lock.packages[`node_modules/${WRITER}`] = { version: "0.4.0", resolved: "https://registry.npmjs.org/@flyingrobots/parley-emit/-/parley-emit-0.4.0.tgz" }; })))).toEqual(["consumer.dependency_not_from_registry"]);
    expect(codes(check(consumer((_d, lock) => { delete lock.packages[`node_modules/${WRITER}`]; })))).toEqual(["consumer.dependency_missing"]);
    // A lockfile that names one version over a directory holding another.
    expect(codes(check(consumer((_d, lock) => { lock.packages[`node_modules/${WRITER}`]!.version = "0.0.1"; })))).toEqual(["consumer.dependency_differs"]);
  }, SLOW);

  test("CONS-3: a directory inside the workspace, a reader that is not the packed tarball, and a failed read are each refused", () => {
    const inside = join(REPO, "node_modules", ".clean-consumer-test");
    mkdirSync(inside, { recursive: true });
    try {
      expect(codes(check(consumer(undefined, inside)))).toContain("consumer.inside_workspace");
    } finally { rmSync(inside, { recursive: true, force: true }); }
    expect(codes(check(consumer((_d, lock) => { lock.packages["node_modules/@flyingrobots/parley-read"]!.integrity = "sha512-" + "C".repeat(86) + "=="; })))).toEqual(["consumer.reader_differs"]);
    const broken = check(consumer((dir) => writeFileSync(join(dir, "node_modules/@flyingrobots/parley-read/src/index.ts"), "export const loadReceipts = () => ({ counts: { bundles: 0, records: 0, validated: 0, invalid: 0 } });\nexport const SCHEMAS = [];\n")));
    expect(codes(broken)).toEqual(["consumer.smoke_failed"]);
    expect(broken.passed).toBe(false);
    expect(checkConsumer({ tarball, dir: join(scratch, "no-such-consumer"), dependency: WRITER, workspace: REPO, install: false }).passed).toBe(false);
  }, SLOW);

  test("CONS-4: every consumer result validates against its schema, and the command's usage error is a schema'd line", () => {
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schemaOf("clean-consumer.schema.json"));
    expect(everyResult.length).toBeGreaterThan(8);
    for (const r of everyResult) expect(validate({ ...r, _schema: { id: "parley.tooling.clean_consumer", version: "1.0.0" } }), JSON.stringify(validate.errors) + " for " + JSON.stringify(r)).toBe(true);
    const usage = spawnSync("bun", ["run", join(REPO, "scripts/clean-consumer.ts"), "--frobnicate"], { encoding: "utf8" });
    expect(usage.status).toBe(2);
    const line = JSON.parse(usage.stderr.trim());
    expect(line).toMatchObject({ event: "error", code: "clean_consumer.usage" });
    expect(validate(line), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe("the gate's output (flyingrobots/parley#147)", () => {
  // These read what the cases above produced, so they are meaningful only in a whole-file run.
  test("GATE-8: every line the gate emitted validates against the gate's schema or the checker's, and every report against the report's", () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const own = ajv.compile(schemaOf("release-gate.schema.json")), checker = ajv.compile(schemaOf("release-check.schema.json")), report = ajv.compile(schemaOf("release-report.schema.json"));
    expect(everyLine.length).toBeGreaterThan(100);
    const seen = new Set<string>();
    for (const l of everyLine) {
      const line = stampGate(l);
      const validate = line._schema.id === "parley.tooling.release_check" ? checker : own;
      expect(validate(line), JSON.stringify(validate.errors) + " for " + JSON.stringify(line)).toBe(true);
      seen.add(l.event === "gate.refusal" ? `refusal:${l.code}` : l.event);
    }
    for (const event of ["gate.artifact", "gate.frozen_since", "gate.result", "release.baseline", "release.package", "release.summary", "release.refusal"]) expect(seen.has(event), event).toBe(true);
    // Every refusal code the gate's schema admits was produced by a case above, and no other.
    const declared: string[] = schemaOf("release-gate.schema.json").$defs.code.enum;
    // The consumer's codes are relayed from scripts/clean-consumer.ts, whose own cases produce them.
    const mine = (c: string) => !c.startsWith("consumer.");
    expect([...seen].filter((x) => x.startsWith("refusal:")).map((x) => x.slice(8)).filter(mine).sort()).toEqual(declared.filter(mine).sort());
    expect(declared.filter((c) => !mine(c)).sort()).toEqual([...schemaOf("clean-consumer.schema.json").oneOf[0].properties.refusals.items.properties.code.enum].sort());
    expect(everyReport.length).toBeGreaterThan(20);
    for (const r of everyReport) expect(report(JSON.parse(JSON.stringify(r))), JSON.stringify(report.errors) + " for " + JSON.stringify(r).slice(0, 400)).toBe(true);
    expect(existsSync(join(REPO, "scripts/release-report.schema.json"))).toBe(true);
  });
});

// The Python release workflow runs the file's own tests before the gate, and Python writes
// bytecode beside what it imports. Found by the first dry run on a runner (2026-11-24): the gate
// refused with gate.dirty_tree for two __pycache__ directories. The repository ignores them, so
// running the tests leaves the tree clean wherever git's own configuration does not.
describe("GATE-11 the tree stays clean after the Python tests", () => {
  test("git ignores Python bytecode under the Python writer's package, by the repository's own rules", () => {
    for (const path of ["packages/parley-emit-py/__pycache__/parley_emit.cpython-312.pyc", "packages/parley-emit-py/tests/__pycache__/x.pyc"]) {
      // -c core.excludesFile= : the answer must come from the repository, not from this machine.
      const r = Bun.spawnSync(["git", "-c", "core.excludesFile=", "check-ignore", "-q", "--no-index", path]);
      expect(r.exitCode, `${path} is not ignored by the repository's .gitignore`).toBe(0);
    }
  });
});
