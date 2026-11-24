// REL-2 to REL-4 (flyingrobots/parley#85): what a release of this repository needs to hold on every
// pull request, so a tag never finds out first. The release workflows' sanity jobs check the tag.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface Manifest {
  name: string; version: string; private?: boolean; description?: string; license?: string;
  repository?: unknown; files?: string[]; engines?: unknown; publishConfig?: { access?: string };
  dependencies?: Record<string, string>; devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>; optionalDependencies?: Record<string, string>;
}
const PACKAGES = readdirSync("packages").filter((d) => { try { readFileSync(join("packages", d, "package.json")); return true; } catch { return false; } });
const manifest = (d: string) => JSON.parse(readFileSync(join("packages", d, "package.json"), "utf8")) as Manifest;
const byName = new Map(PACKAGES.map((d) => [manifest(d).name, manifest(d)]));

describe("REL-2 publishable manifests", () => {
  test("a publishable manifest has its fields and no workspace range", () => {
    const publishable = PACKAGES.filter((d) => !manifest(d).private);
    expect(publishable.sort()).toEqual(["parley-emit", "parley-read"]);
    for (const d of publishable) {
      const m = manifest(d);
      for (const f of ["name", "version", "description", "license", "repository", "files", "engines", "publishConfig"] as const) expect(m[f], `${d}: ${f}`).toBeTruthy();
      expect(m.files!.length, `${d}: files`).toBeGreaterThan(0);
      expect(m.publishConfig!.access, `${d}: publishConfig.access`).toBe("public");
      for (const map of [m.dependencies, m.peerDependencies, m.optionalDependencies]) {
        for (const [dep, range] of Object.entries(map ?? {})) expect(range.startsWith("workspace:"), `${d}: ${dep}@${range} would be published verbatim`).toBe(false);
      }
    }
  });

  test("a dependency on a package here admits its own version", () => {
    let seen = 0;
    for (const d of PACKAGES) {
      for (const [dep, range] of Object.entries(manifest(d).dependencies ?? {})) {
        const local = byName.get(dep);
        if (!local) continue;
        seen++;
        expect(Bun.semver.satisfies(local.version, range), `${d}: ${dep}@${range} does not admit ${local.version}`).toBe(true);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });
});

describe("REL-3 versions and changelogs", () => {
  test("every package version has a dated changelog heading", () => {
    for (const d of PACKAGES) {
      const { version } = manifest(d);
      const log = readFileSync(join("packages", d, "CHANGELOG.md"), "utf8");
      expect(new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\] — \\d{4}-\\d{2}-\\d{2}$`, "m").test(log), `${d}: no dated heading for ${version}`).toBe(true);
    }
    const py = /^__version__ = "([^"]+)"$/m.exec(readFileSync("packages/parley-emit-py/parley_emit.py", "utf8"))?.[1];
    expect(py).toBe(manifest("parley-emit-py").version);
  });
});

describe("REL-4 RELEASE.md", () => {
  test("RELEASE.md declares steps footprint can read and names real tags", () => {
    const text = readFileSync("RELEASE.md", "utf8");
    // footprint's rule (its docs/topics/landing): a step is a top-level list item inside a landing
    // section, outside fenced code; the first top-level heading is the title, not a section.
    const lines = text.split("\n");
    let fenced = false, inLanding = false, level = 0;
    const steps: string[] = [];
    lines.forEach((line, i) => {
      if (/^\s{0,3}(```|~~~)/.test(line)) { fenced = !fenced; return; }
      if (fenced) return;
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        const l = h[1]!.length;
        if (i === lines.findIndex((x) => /^#\s/.test(x)) && l === 1) return;
        if (inLanding && l > level) return;
        inLanding = /after merge/i.test(h[2]!); level = l;
        return;
      }
      if (inLanding && /^ {0,3}([-*+]|\d+[.)])\s+/.test(line)) steps.push(line);
    });
    expect(steps.length).toBeGreaterThan(0);
    const workflows = readdirSync(".github/workflows").map((f) => readFileSync(join(".github/workflows", f), "utf8"));
    const tags = [...new Set(text.match(/parley-[a-z-]+-v\d+\.\d+\.\d+/g) ?? [])];
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      const prefix = tag.replace(/v\d+\.\d+\.\d+$/, "v");
      const triggered = workflows.some((w) => w.includes(`"${prefix}[0-9]+.[0-9]+.[0-9]+"`));
      expect(triggered, `${tag}: no release workflow is triggered by ${prefix}X.Y.Z`).toBe(true);
    }
  });
});

// REL-8 (flyingrobots/parley#147): a workflow cannot be run from a pull request, so what can be
// held here is its shape: the gate is a job, and nothing public is made by a job that does not
// need it. What the gate itself decides is scripts/release-gate.test.ts.
interface Step { name?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown> }
interface Job { needs?: string | string[]; if?: string; environment?: string; permissions?: Record<string, string>; steps: Step[]; outputs?: Record<string, string> }
interface Workflow { on: { push?: { tags?: string[] }; workflow_dispatch?: unknown }; jobs: Record<string, Job> }
const RELEASES = [
  { file: "release-parley-emit.yml", pkg: "parley-emit", npm: true },
  { file: "release-parley-read.yml", pkg: "parley-read", npm: true },
  { file: "release-parley-emit-py.yml", pkg: "parley-emit-py", npm: false },
] as const;
const workflow = (file: string) => Bun.YAML.parse(readFileSync(join(".github/workflows", file), "utf8")) as Workflow;
const needs = (j: Job) => (j.needs === undefined ? [] : Array.isArray(j.needs) ? j.needs : [j.needs]);
/** Every job a job waits for, directly or not. */
function upstream(w: Workflow, name: string, seen = new Set<string>()): Set<string> {
  for (const n of needs(w.jobs[name]!)) if (!seen.has(n)) { seen.add(n); upstream(w, n, seen); }
  return seen;
}
/** A step that makes something public: a GitHub release, or anything sent to npm that is not a dry run. */
const PUBLIC = /\bgh release (create|upload)\b|\bnpm@?\S* (stage )?publish\b(?![^\n]*--dry-run)/;
const runs = (j: Job) => j.steps.map((s) => s.run ?? "");

describe("REL-8 the release workflows", () => {
  test("each release workflow is triggered by its tag and runs the gate as a job before any job that makes something public", () => {
    for (const { file, pkg } of RELEASES) {
      const w = workflow(file);
      expect(w.on.push?.tags, file).toEqual([`${pkg}-v[0-9]+.[0-9]+.[0-9]+`]);
      const gate = w.jobs.gate;
      expect(gate, `${file}: no gate job`).toBeDefined();
      const at = gate!.steps.findIndex((s) => new RegExp(`\\bbun run release-gate -- ${pkg} `).test(s.run ?? ""));
      expect(at, `${file}: the gate job does not run release-gate for ${pkg}`).toBeGreaterThanOrEqual(0);
      const step = gate!.steps[at]!;
      expect(step.run, file).toContain('--tag "$GITHUB_REF_NAME"');
      expect(step.run, file).toContain("--out ");
      // The gate needs the history: the baseline, the pins and the previous release tag.
      expect(gate!.steps.find((s) => s.uses?.startsWith("actions/checkout@"))?.with?.["fetch-depth"], file).toBe(0);
      // Nothing leaves the gate job before the gate has passed, the workflow artifact included,
      // and no step there is allowed to run after a failure except the summary.
      gate!.steps.forEach((s, i) => {
        expect(PUBLIC.test(s.run ?? ""), `${file}: gate step ${i} makes something public`).toBe(false);
        if (s.uses?.startsWith("actions/upload-artifact@")) expect(i, `${file}: the artifact is uploaded before the gate ran`).toBeGreaterThan(at);
        if (s.if !== undefined) { expect(s.if, file).toBe("always()"); expect(s.run, file).toContain("GITHUB_STEP_SUMMARY"); }
      });
      expect(gate!.steps.some((s) => s.uses?.startsWith("actions/upload-artifact@")), file).toBe(true);
      expect(gate!.steps.some((s) => (s.run ?? "").includes("release-report.json") && (s.run ?? "").includes("GITHUB_STEP_SUMMARY")), `${file}: the report is not printed in the job summary`).toBe(true);
      const makers = Object.entries(w.jobs).filter(([, j]) => runs(j).some((r) => PUBLIC.test(r))).map(([name]) => name);
      expect(makers.length, `${file}: no job releases anything`).toBeGreaterThan(0);
      for (const name of makers) {
        expect(upstream(w, name).has("gate"), `${file}: job ${name} makes something public and does not need the gate`).toBe(true);
        const j = w.jobs[name]!;
        // It releases the file the gate judged: downloaded, and its digest compared with the gate's output.
        expect(j.steps.some((s) => s.uses?.startsWith("actions/download-artifact@")), `${file}: ${name} does not take the gate's artifact`).toBe(true);
        const verify = j.steps.findIndex((s) => (s.run ?? "").includes("needs.gate.outputs.sha256") && (s.run ?? "").includes("sha256sum"));
        const first = j.steps.findIndex((s) => PUBLIC.test(s.run ?? ""));
        expect(verify, `${file}: ${name} does not compare the artifact's digest with the gate's`).toBeGreaterThanOrEqual(0);
        expect(verify, `${file}: ${name} verifies the digest after using the artifact`).toBeLessThan(first);
        // No job that releases builds: the tarball is packed once, by the gate.
        for (const r of runs(j)) expect(/\b(npm|bun pm) pack\b/.test(r), `${file}: ${name} packs again`).toBe(false);
      }
      expect(gate!.outputs?.sha256, file).toBeDefined();
      // The GitHub release carries the artifact, its digest and the report.
      const release = runs(w.jobs.release!).find((r) => /gh release create/.test(r)) ?? "";
      expect(release, file).toContain("release-report.json");
      expect(release, file).toContain("SHA256SUMS");
      expect(release, file).toContain("--verify-tag");
    }
  });

  // flyingrobots/parley#156: a tag cannot be taken back, so each workflow can be started by hand
  // as a dry run. It packs, runs the gate with no tag, hands the artifact to a second job that
  // checks its digest, and makes nothing public; the tag-triggered jobs do not run.
  test("each release workflow has a dry run that reaches the artifact hand-off and makes nothing public", () => {
    for (const { file, pkg, npm } of RELEASES) {
      const w = workflow(file);
      expect("workflow_dispatch" in w.on, `${file}: cannot be started by hand`).toBe(true);
      const dry = w.jobs["dry-run"], receive = w.jobs["dry-run-receive"];
      expect(dry, `${file}: no dry-run job`).toBeDefined();
      expect(receive, `${file}: no dry-run-receive job`).toBeDefined();
      expect(dry!.if, file).toBe("github.event_name == 'workflow_dispatch'");
      expect(needs(receive!), file).toEqual(["dry-run"]);
      // The gate runs as it does for a tagger before the tag exists: no --tag.
      const gate = runs(dry!).find((r) => new RegExp(`\\bbun run release-gate -- ${pkg} `).test(r)) ?? "";
      expect(gate, `${file}: the dry run does not run the gate`).toContain("--out ");
      expect(gate, file).not.toContain("--tag");
      expect(dry!.steps.find((s) => s.uses?.startsWith("actions/checkout@"))?.with?.["fetch-depth"], file).toBe(0);
      expect(dry!.steps.some((s) => s.uses?.startsWith("actions/upload-artifact@")), file).toBe(true);
      expect(receive!.steps.some((s) => s.uses?.startsWith("actions/download-artifact@")), file).toBe(true);
      expect(runs(receive!).some((r) => r.includes("needs.dry-run.outputs.sha256") && r.includes("sha256sum")), `${file}: the receiving job does not compare the digest`).toBe(true);
      // An npm workflow also proves npm takes the tarball by path, as a dry run that stages nothing.
      if (npm) expect(runs(receive!).some((r) => /npm@latest stage publish "\$TARBALL" --dry-run/.test(r)), `${file}: the dry run does not offer npm the tarball`).toBe(true);
      for (const j of [dry!, receive!]) {
        for (const r of runs(j)) expect(PUBLIC.test(r), `${file}: a dry-run job makes something public`).toBe(false);
        expect(j.environment, `${file}: a dry-run job uses a protected environment`).toBeUndefined();
        expect(Object.values(j.permissions ?? {}).every((v) => v === "read" || v === "none"), `${file}: a dry-run job may write`).toBe(true);
      }
      // Started by hand, nothing but the dry run runs: every other job is the tag's, directly or through what it needs.
      const roots = Object.entries(w.jobs).filter(([name, j]) => !name.startsWith("dry-run") && needs(j).length === 0);
      expect(roots.length, file).toBeGreaterThan(0);
      for (const [name, j] of roots) expect(j.if, `${file}: ${name} would run on a dry run`).toBe("github.event_name == 'push'");
    }
  });

  test("the npm workflows pack nowhere but in the gate, stage the gate's tarball by path, and the reader's gate proves a clean consumer", () => {
    for (const { file } of RELEASES.filter((r) => r.npm)) {
      const w = workflow(file);
      for (const [name, j] of Object.entries(w.jobs)) for (const r of runs(j)) for (const line of r.split("\n")) {
        if (/\b(npm|bun pm) pack\b/.test(line)) expect(line, `${file}: ${name} packs a tarball outside the gate`).toContain("--dry-run");
      }
      const publish = w.jobs.publish!;
      expect(publish.environment, file).toBe("npm");
      expect([...upstream(w, "publish")].sort(), file).toEqual(["gate", "release", "sanity"]);
      const stage = runs(publish).filter((r) => /stage publish/.test(r));
      expect(stage, file).toHaveLength(1);
      // A tarball path, not a directory: npm stages the bytes it is given and repacks nothing.
      expect(stage[0], file).toMatch(/npm@latest stage publish "\$TARBALL" --access public --provenance/);
      expect(stage[0], file).toContain("${{ needs.gate.outputs.tarball }}");
      // The job stages a file; it has no checkout to pack from, and it never publishes.
      expect(publish.steps.some((s) => s.uses?.startsWith("actions/checkout@")), `${file}: publish checks the repository out`).toBe(false);
      for (const r of runs(publish)) expect(/npm@?\S* publish\b/.test(r.replace(/stage publish/g, "")), `${file}: publish runs npm publish`).toBe(false);
    }
    const gateOf = (file: string) => runs(workflow(file).jobs.gate!).find((r) => /release-gate/.test(r)) ?? "";
    expect(gateOf("release-parley-read.yml")).toContain("--consumer");
    expect(gateOf("release-parley-emit.yml")).not.toContain("--consumer");
    // The Python file goes to no registry: beside its dry run, its only jobs are the gate and the release.
    expect(Object.keys(workflow("release-parley-emit-py.yml").jobs).filter((n) => !n.startsWith("dry-run")).sort()).toEqual(["gate", "release"]);
  });

  test("RELEASE.md and the release pages say the tag is pushed only after the gate exits 0", () => {
    const release = readFileSync("RELEASE.md", "utf8");
    for (const { pkg } of RELEASES) {
      expect(release, pkg).toContain(`bun run release-gate -- ${pkg}`);
      const page = readFileSync(join("docs/workflows", `release-${pkg}`, "README.md"), "utf8");
      expect(page, pkg).toContain(`bun run release-gate -- ${pkg}`);
      expect(page, pkg).toMatch(/only (after|once) it exits (with )?`?0`?/);
      expect(page, pkg).toContain("cannot verify");
    }
    expect(JSON.parse(readFileSync("package.json", "utf8")).scripts["release-gate"]).toBe("bun run scripts/release-gate.ts");
  });
});
