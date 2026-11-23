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
      const manual = /parley-emit-py-v/.test(tag);
      expect(triggered || manual, `${tag}: no release workflow is triggered by ${prefix}X.Y.Z`).toBe(true);
    }
  });
});
