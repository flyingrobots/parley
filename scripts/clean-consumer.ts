#!/usr/bin/env bun
// The clean consumer (flyingrobots/parley#147). A packed reader is proved against the writer a
// consumer will install: the tarball is installed with npm into a new directory outside the
// workspace, its writer dependency must have come from the npm registry (not a link, not a file,
// not a directory of this repository), and a smoke read runs there. Inside the repository Bun links
// the workspace copy of the writer, so a test in the workspace proves nothing about the published
// one. The result records the writer's exact version and integrity for the release report.
//
// Repository tooling (see AGENTS.md): JSON Lines stamped `parley.tooling.clean_consumer`, schema
// beside the script. `--human` prints prose. Exit: 0 passed, 1 refused, 2 the check could not run.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

export const CONSUMER_SCHEMA = { id: "parley.tooling.clean_consumer", version: "1.0.0" } as const;
const REGISTRY = "https://registry.npmjs.org/";

export type ConsumerCode =
  | "consumer.unreadable" | "consumer.inside_workspace" | "consumer.install_failed"
  | "consumer.reader_differs"
  | "consumer.dependency_missing" | "consumer.dependency_linked" | "consumer.dependency_not_from_registry" | "consumer.dependency_differs"
  | "consumer.smoke_failed";

export interface ConsumerResult {
  event: "consumer.result"; passed: boolean;
  /** The directory the reader was installed into. */
  dir: string;
  /** Whether this run installed into it, or judged a directory as it was found (`--no-install`). */
  installed: boolean;
  /** The reader as the lockfile records it; `integrity` is the packed tarball's when the check passes. */
  reader: { name: string; version: string | null; integrity: string | null } | null;
  /** The writer as it was resolved: the exact version a consumer gets today, and the registry's integrity for it. */
  dependency: { name: string; version: string | null; resolved: string | null; integrity: string | null } | null;
  /** The read that ran in the directory, and where the reader's own import of the writer resolved. */
  smoke: { ran: boolean; bundles: number; records: number; validated: number; invalid: number; writer_path: string } | null;
  refusals: { code: ConsumerCode; problem: string }[];
}
export interface ConsumerHelp { event: "consumer.help"; usage: string; intent: string; exit: Record<"0" | "1" | "2", string> }
export interface ConsumerFailure { event: "error"; code: string; problem: string }

export interface ConsumerOptions {
  /** The packed reader. */
  tarball: string;
  /** The dependency that must come from the registry, by package name. */
  dependency: string;
  /** The repository whose workspace must not supply it. */
  workspace: string;
  /** Where to install. Default: a new directory under the system's temporary directory. */
  dir?: string;
  /** `false` judges `dir` as it is, installing nothing. */
  install?: boolean;
}

export class ConsumerError extends Error {
  constructor(readonly code: string, problem: string) { super(problem); }
}

const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
const within = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
const json = (file: string): unknown => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; } };

/**
 * The read a consumer would make first: one bundle of two records, loaded from a repository's
 * receipt directory. It prints what it loaded and where the reader's import of the writer resolved.
 */
const smokeSource = (reader: string, dependency: string) => `import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadReceipts } from ${JSON.stringify(reader)};
const root = process.argv[2];
const run = "01M87N8BQ48B1W8EGNWJQ1JNFB";
const dir = join(root, ".parley", "receipts");
mkdirSync(dir, { recursive: true });
const lines = [
  { event: "receipt.step", t: 1795553506068, seq: 1, run, decision: "smoke", because: "a clean consumer reads one bundle", _schema: { id: "parley.receipt.step", version: "1.0.0" } },
  { event: "end", t: 1795553507050, seq: 2, run, status: 0, receipt: join(dir, run + ".jsonl"), redacted: false, _schema: { id: "parley.end", version: "1.0.0" } },
];
writeFileSync(join(dir, run + ".jsonl"), lines.map((l) => JSON.stringify(l)).join("\\n") + "\\n");
const load = loadReceipts({ cwd: root, env: {}, home: root });
const readerEntry = Bun.resolveSync(${JSON.stringify(reader)}, import.meta.dir);
const writer = realpathSync(Bun.resolveSync(${JSON.stringify(dependency)}, dirname(readerEntry)));
console.log(JSON.stringify({ bundles: load.counts.bundles, records: load.counts.records, validated: load.counts.validated, invalid: load.counts.invalid, writer_path: writer }));
`;

export function checkConsumer(o: ConsumerOptions): ConsumerResult {
  const install = o.install !== false;
  const tarball = resolve(o.tarball), workspace = real(o.workspace);
  const refusals: ConsumerResult["refusals"] = [];
  const refuse = (code: ConsumerCode, problem: string) => { refusals.push({ code, problem }); };
  let dir = o.dir === undefined ? mkdtempSync(join(tmpdir(), "parley-clean-consumer-")) : resolve(o.dir);
  if (install) mkdirSync(dir, { recursive: true });
  const done = (rest: Partial<ConsumerResult> = {}): ConsumerResult => ({ event: "consumer.result", passed: refusals.length === 0, dir, installed: install, reader: null, dependency: null, smoke: null, ...rest, refusals });
  if (!existsSync(dir)) { refuse("consumer.unreadable", `${dir} does not exist, so there is no consumer to judge`); return done(); }
  dir = real(dir);
  if (!existsSync(tarball)) { refuse("consumer.unreadable", `the packed reader ${tarball} does not exist`); return done(); }
  // A directory under the repository resolves through the repository's own node_modules and
  // workspace links whatever is installed into it, so nothing there is a clean consumer.
  if (within(dir, workspace)) { refuse("consumer.inside_workspace", `${dir} is inside the workspace ${workspace}: a package resolved there can come from the workspace, so it is not a clean consumer`); return done(); }

  if (install) {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "parley-clean-consumer", private: true }, null, 2) + "\n");
    const r = spawnSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--registry", REGISTRY, tarball], { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) { refuse("consumer.install_failed", `npm install of ${tarball} in ${dir} exited ${String(r.status)}: ${(r.stderr || r.stdout || r.error?.message || "").trim().split("\n").slice(-6).join(" | ")}`); return done(); }
  }

  const lock = json(join(dir, "package-lock.json")) as { packages?: Record<string, { version?: unknown; resolved?: unknown; integrity?: unknown; link?: unknown }> } | undefined;
  if (!lock?.packages || typeof lock.packages !== "object") { refuse("consumer.unreadable", `${join(dir, "package-lock.json")} is missing or is not an npm lockfile, so what was installed cannot be read`); return done(); }
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const depKey = `node_modules/${o.dependency}`;

  // The reader: the one package the lockfile resolves from a file, and that file is the tarball.
  const want = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
  const fromFile = Object.entries(lock.packages).filter(([k, e]) => k !== depKey && k.startsWith("node_modules/") && typeof e.resolved === "string" && e.resolved.startsWith("file:"));
  let reader: ConsumerResult["reader"] = null;
  if (fromFile.length !== 1) refuse("consumer.reader_differs", `the lockfile resolves ${fromFile.length} packages from a file, and exactly one, the packed reader, was expected`);
  else {
    const [k, e] = fromFile[0]!;
    reader = { name: k.slice("node_modules/".length), version: str(e.version), integrity: str(e.integrity) };
    if (reader.integrity !== want) refuse("consumer.reader_differs", `the installed ${reader.name} has integrity ${reader.integrity ?? "none"}, and the packed tarball's is ${want}: what was installed is not the artifact`);
  }

  // The writer: from the registry, as a consumer gets it.
  const entry = lock.packages[depKey];
  const installedAt = join(dir, "node_modules", o.dependency);
  let dependency: ConsumerResult["dependency"] = null;
  if (!entry || !existsSync(installedAt)) refuse("consumer.dependency_missing", `${o.dependency} is not installed in ${dir}: the lockfile ${entry ? "names it and node_modules does not hold it" : "has no entry for it"}`);
  else {
    dependency = { name: o.dependency, version: str(entry.version), resolved: str(entry.resolved), integrity: str(entry.integrity) };
    const target = real(installedAt);
    const linked = entry.link === true || lstatSync(installedAt).isSymbolicLink() || within(target, workspace);
    if (linked) refuse("consumer.dependency_linked", `${o.dependency} in ${dir} is a link${target !== installedAt ? ` to ${target}` : ""}${entry.link === true ? ` (the lockfile records link: true, resolved ${String(entry.resolved)})` : ""}: it resolved from a workspace or a link, not from npm, so this proves nothing about the published writer`);
    else if (!dependency.resolved?.startsWith(REGISTRY) || !dependency.integrity) refuse("consumer.dependency_not_from_registry", `${o.dependency} resolved from ${dependency.resolved ?? "nowhere the lockfile records"} with integrity ${dependency.integrity ?? "none"}: it must come from ${REGISTRY} with the registry's integrity`);
    else {
      const manifest = json(join(installedAt, "package.json")) as { name?: unknown; version?: unknown } | undefined;
      if (manifest?.name !== o.dependency || manifest.version !== dependency.version) refuse("consumer.dependency_differs", `the lockfile records ${o.dependency}@${dependency.version ?? "?"}, and ${installedAt} holds ${String(manifest?.name)}@${String(manifest?.version)}`);
    }
  }
  if (refusals.length > 0 || !reader) return done({ reader, dependency });

  // The smoke read, in the consumer's directory, with Bun: the packages ship TypeScript for Bun.
  writeFileSync(join(dir, "parley-smoke.ts"), smokeSource(reader.name, o.dependency));
  const r = spawnSync("bun", ["parley-smoke.ts", join(dir, "smoke-repo")], { cwd: dir, encoding: "utf8" });
  const out = (() => { try { return JSON.parse((r.stdout ?? "").trim().split("\n").pop() ?? "") as Record<string, unknown>; } catch { return undefined; } })();
  const n = (k: string) => (typeof out?.[k] === "number" ? (out[k] as number) : -1);
  if (r.status !== 0 || !out) { refuse("consumer.smoke_failed", `the smoke read in ${dir} exited ${String(r.status)}: ${(r.stderr || r.stdout || r.error?.message || "").trim().split("\n").slice(-6).join(" | ")}`); return done({ reader, dependency }); }
  const smoke = { ran: true, bundles: n("bundles"), records: n("records"), validated: n("validated"), invalid: n("invalid"), writer_path: typeof out.writer_path === "string" ? out.writer_path : "" };
  if (smoke.bundles !== 1 || smoke.records !== 2 || smoke.validated !== 2 || smoke.invalid !== 0)
    refuse("consumer.smoke_failed", `the smoke read loaded ${smoke.bundles} bundle(s), ${smoke.records} record(s), ${smoke.validated} validated and ${smoke.invalid} invalid; one bundle of two validated records was written`);
  else if (!within(smoke.writer_path, join(dir, "node_modules", o.dependency)))
    refuse("consumer.smoke_failed", `the reader's import of ${o.dependency} resolved to ${smoke.writer_path}, which is not the copy installed in ${dir}`);
  return done({ reader, dependency, smoke });
}

export const stampConsumer = <T extends object>(l: T) => ({ ...l, _schema: CONSUMER_SCHEMA });

export function humanConsumer(l: ConsumerResult | ConsumerHelp | ConsumerFailure): string {
  if (l.event === "error") return `ERROR  ${l.code}: ${l.problem}`;
  if (l.event === "consumer.help") return `${l.usage}\n  ${l.intent}`;
  const head = `${l.passed ? "PASS" : "FAIL"}  clean consumer in ${l.dir}: ${l.reader ? `${l.reader.name} ${l.reader.version ?? "-"}` : "no reader"} with ${l.dependency ? `${l.dependency.name} ${l.dependency.version ?? "-"} (${l.dependency.integrity ?? "no integrity"})` : "no writer"}${l.smoke ? `; read ${l.smoke.records} record(s)` : ""}`;
  return [head, ...l.refusals.map((r) => `REFUSED   ${r.code}  ${r.problem}`)].join("\n");
}

const USAGE = "clean-consumer --tarball FILE --dependency NAME [--workspace DIR] [--dir DIR] [--no-install] [--human]";
export const CONSUMER_HELP: ConsumerHelp = {
  event: "consumer.help",
  usage: USAGE,
  intent: "Install a packed package into a directory outside the workspace, require that the named dependency came from the npm registry, and run a smoke read there",
  exit: { "0": "passed", "1": "refused", "2": "the check could not run" },
};

function parseArgs(argv: string[]): { help: boolean; prose: boolean; options: ConsumerOptions | null } {
  let tarball: string | undefined, dependency: string | undefined, workspace: string | undefined, dir: string | undefined, install = true, help = false, prose = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    const value = () => { const v = argv[++i]; if (v === undefined) throw new ConsumerError("clean_consumer.usage", `${a} needs a value; usage: ${USAGE}`); return v; };
    if (a === "--") continue;
    else if (a === "--human" || a === "--humanize") prose = true;
    else if (a === "--help" || a === "-h") help = true;
    else if (a === "--tarball") tarball = value();
    else if (a === "--dependency") dependency = value();
    else if (a === "--workspace") workspace = value();
    else if (a === "--dir") dir = value();
    else if (a === "--no-install") install = false;
    else throw new ConsumerError("clean_consumer.usage", `unrecognised argument ${JSON.stringify(a)}; usage: ${USAGE}`);
  }
  if (help) return { help, prose, options: null };
  if (tarball === undefined || dependency === undefined) throw new ConsumerError("clean_consumer.usage", `--tarball and --dependency are required; usage: ${USAGE}`);
  if (!install && dir === undefined) throw new ConsumerError("clean_consumer.usage", `--no-install judges an existing directory, so it needs --dir; usage: ${USAGE}`);
  return { help, prose, options: { tarball, dependency, workspace: workspace ?? ".", ...(dir === undefined ? {} : { dir }), install } };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let prose = argv.includes("--human") || argv.includes("--humanize");
  const write = (l: ConsumerResult | ConsumerHelp | ConsumerFailure, s: NodeJS.WriteStream) => s.write((prose ? humanConsumer(l) : JSON.stringify(stampConsumer(l))) + "\n");
  try {
    const parsed = parseArgs(argv);
    prose = parsed.prose;
    if (!parsed.options) { write(CONSUMER_HELP, process.stdout); process.exit(0); }
    const result = checkConsumer(parsed.options);
    write(result, process.stdout);
    process.exit(result.passed ? 0 : 1);
  } catch (e) {
    write({ event: "error", code: e instanceof ConsumerError ? e.code : "clean_consumer.crashed", problem: (e as Error).message }, process.stderr);
    process.exit(2);
  }
}
