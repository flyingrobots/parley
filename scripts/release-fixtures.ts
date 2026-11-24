// Throwaway repositories with real git history for the release tests: scripts/release-check.test.ts
// (flyingrobots/parley#145) and scripts/release-gate.test.ts (flyingrobots/parley#147). The package
// copies in each are written by the repository's real sync scripts, so the bundle format under test
// is the one the packages ship. Not a test file: it only builds fixtures.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const REPO = resolve(import.meta.dir, "..");
export const EMIT = "@flyingrobots/parley-emit", READ = "@flyingrobots/parley-read", PY = "@flyingrobots/parley-emit-py";
// A fixture test builds commits and runs three sync scripts; the default 5 s is too little under load.
export const SLOW = 60_000;


export function run(cmd: string, args: string[], cwd: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} in ${cwd} exited ${String(r.status)}: ${r.stderr}${r.stdout}`);
  return r.stdout.trim();
}
export const git = (dir: string, ...args: string[]) =>
  run("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], dir);
export const commit = (dir: string, message: string) => { git(dir, "add", "-A"); git(dir, "commit", "-q", "--allow-empty", "-m", message); return git(dir, "rev-parse", "HEAD"); };
/** Move the fixture's remote-tracking ref for the default branch: what "merged" means here. */
export const acceptOnMain = (dir: string, ref = "HEAD") => git(dir, "update-ref", "refs/remotes/origin/main", git(dir, "rev-parse", ref));
export const put = (dir: string, path: string, text: string) => { mkdirSync(join(dir, path, ".."), { recursive: true }); writeFileSync(join(dir, path), text); };
export const get = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");
export const edit = (dir: string, path: string, from: string | RegExp, to: string) => {
  const before = get(dir, path), after = before.replace(from, to);
  if (after === before) throw new Error(`fixture edit of ${path} changed nothing`);
  put(dir, path, after);
};

export function schemaDoc(id: string, version: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
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
export const text = (doc: unknown) => JSON.stringify(doc, null, 2) + "\n";
export const top = (id: string) => `schemas/${id}.schema.json`;
export const snap = (id: string, version: string) => `schemas/released/${id}/${version}.schema.json`;

/** Re-sync every package's copy from the tree, as `bun run sync-schemas` does in each package. */
export function sync(dir: string): void {
  run("bun", ["run", "scripts/sync-schemas.ts"], join(dir, "packages/parley-emit"));
  run("bun", ["run", "scripts/sync-schemas.ts"], join(dir, "packages/parley-read"));
  run("python3", ["scripts/sync_schemas.py"], join(dir, "packages/parley-emit-py"));
}

export const CHANGELOG_RELEASED = [
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
export function buildReleased(dir: string): void {
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

export const FOLD = { fold: { type: "boolean" } };
export const CHANGELOG_DRAFTS = CHANGELOG_RELEASED.replace("## [Unreleased]\n", "## [Unreleased]\n\n### Added\n\n- `parley.query` 1.1.0, a draft.\n- `parley.lens` 1.1.0, a draft.\n");

/** On top of the released tree: `parley.query` and `parley.lens` move to draft 1.1.0, as on main on 2026-11-24. */
export function addDrafts(dir: string): void {
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
export function releaseDrafts(dir: string): { s: string; p: string } {
  git(dir, "checkout", "-q", "-b", "release");
  for (const id of ["parley.query", "parley.lens"]) put(dir, snap(id, "1.1.0"), get(dir, top(id)));
  put(dir, "CHANGELOG.md", CHANGELOG_DRAFTS.replace("## [Unreleased]\n\n### Added\n", "## [Unreleased]\n\n## [0.2.1] — 2026-11-24\n\n### Added\n"));
  const s = commit(dir, "S: release 0.2.1 of the schemas");
  sync(dir);
  const p = commit(dir, "P: package copies synced from S");
  return { s, p };
}
