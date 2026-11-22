// A tool: its commands, their declarations, and the entry point that turns argv and a handler
// into a conforming run (spec §3, §4, §6).
import { readdirSync, rmSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { computeInv } from "./inv.ts";
import { bookkeepingFor, chooseLocation, type Bookkeeping } from "./location.ts";
import { classifySecrets, collectSecretValues, redactArgv, scrub } from "./redact.ts";
import { Run, SCHEMA_IDS, type Record_, type SchemaRef, type Sink } from "./run.ts";
import { SCHEMAS } from "./schemas.ts";
import { ulid } from "./ulid.ts";

export interface Effects { reads: string[]; writes: string[]; network: boolean; idempotent: boolean }
export interface EmittedType extends SchemaRef { readonly schema?: Record<string, unknown> }
export interface CommandSpec {
  readonly intent: string;
  readonly effects: Effects;
  /** Flags (`--token`), environment variables (`APP_TOKEN`) and logical credential sources (`netrc`). */
  readonly secrets?: readonly string[];
  /** The result types the command can emit; a tool-owned type carries its JSON Schema for discovery. */
  readonly emits: readonly EmittedType[];
  /** The error types the command can produce; defaults to `parley.error`. */
  readonly errors?: readonly EmittedType[];
}
export interface ToolSpec {
  readonly name: string;
  readonly version: string;
  readonly commands: Readonly<Record<string, CommandSpec>>;
  /** §5.1: a stated policy. Receipts beyond `count` in a location are deleted, oldest first. */
  readonly retention: { readonly count: number };
  /** Resolvers for declared credential sources, called before the head is written (§5.3). */
  readonly sources?: Readonly<Record<string, () => boolean | Promise<boolean>>>;
  /** Prose for `--human`: return a string for a line, or null for the default rendering. */
  readonly human?: (line: Record_) => string | null;
}

export function defineTool(spec: ToolSpec): ToolSpec {
  if (!spec.name) throw new TypeError("tool name is never empty");
  if (!spec.version) throw new TypeError("tool version is never empty");
  if (!Object.keys(spec.commands).length) throw new TypeError("a tool has at least one command");
  if (!Number.isInteger(spec.retention?.count) || spec.retention.count < 1) throw new TypeError("retention.count must be a positive integer (spec §5.1)");
  for (const [name, c] of Object.entries(spec.commands)) {
    if (!c.intent) throw new TypeError(`command ${name} needs an intent`);
    for (const e of c.emits) if (!e.id || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(e.version)) throw new TypeError(`command ${name} emits an invalid type ${e.id}@${e.version}`);
  }
  return spec;
}

export interface InputDecl { path: string; role?: string }
export interface MainOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  home?: string;
  stdout?: Sink;
  stderr?: Sink;
  session?: string;
  now?: () => number;
  /** The declared inputs of this invocation, from the command's arguments. */
  inputs?: (args: string[], command: string) => InputDecl[];
  /** The resolved interpretation after defaults (§5); the default records the command and its arguments. */
  resolved?: (args: string[], command: string) => Record<string, unknown>;
}

const fdSink = (fd: number): Sink => ({ write(line) { writeSync(fd, line); } });
const OWN_FLAGS = new Set(["--human", "--humanize", "--dry-run"]);
const WRITER_SCHEMAS: SchemaRef[] = Object.values(SCHEMA_IDS);

export type Handler = (run: Run, args: string[]) => void | Promise<void>;

/**
 * Run a tool: parse the writer-owned flags, bootstrap, write the receipt, run the handler under
 * the top-level handler of §6, and close with `end`. Returns the exit status (§3.4).
 */
export async function main(spec: ToolSpec, argv: readonly string[], handler: Handler, opts: MainOptions = {}): Promise<number> {
  const env = opts.env ?? process.env;
  const cwd = resolve(opts.cwd ?? process.cwd());
  const stdout = opts.stdout ?? fdSink(1), stderr = opts.stderr ?? fdSink(2);
  const now = opts.now ?? Date.now;
  const id = ulid(now());
  const rawArgs = argv.slice(1);
  const human = rawArgs.some((a) => a === "--human" || a === "--humanize");
  const dryRun = rawArgs.includes("--dry-run");
  const discovery = rawArgs.includes("--schema") ? "schema" : rawArgs.includes("--help") || rawArgs.includes("-h") ? "help" : null;
  const args = rawArgs.filter((a) => !OWN_FLAGS.has(a) && a !== "--schema" && a !== "--help" && a !== "-h");
  const names = Object.keys(spec.commands);
  const commandName = args.find((a) => !a.startsWith("-") && a in spec.commands) ?? (names.length === 1 ? names[0]! : undefined);

  const startupFailed = (code: string, problem: string, remedy: string): number => {
    const line = { event: "startup.failed", t: now(), seq: 0, run: id, tool: spec.name, v: spec.version, code, problem, remedy, _schema: SCHEMA_IDS.startupFailed };
    try { stderr.write(human ? `startup failed ${code}: ${problem} (${remedy})\n` : JSON.stringify(line) + "\n"); } catch { /* nothing else can be said */ }
    return 3;
  };

  if (!commandName && discovery !== "schema" && discovery !== "help") return startupFailed("startup.unknown_command", `no command named in ${JSON.stringify(args)}; commands are ${names.join(", ")}`, `name one of: ${names.join(", ")}`);
  const command = commandName ? spec.commands[commandName]! : undefined;

  // Declared secrets and sources, resolved before the head (§5.3).
  const secretNames = classifySecrets(command?.secrets ?? []);
  const secretValues = collectSecretValues(argv, secretNames, env);
  const presentSources: string[] = [];
  for (const s of secretNames.sources) { try { if (await spec.sources?.[s]?.()) presentSources.push(s); } catch { /* an unresolvable source is not present */ } }
  const presentEnv = secretNames.env.filter((n) => env[n] !== undefined);

  const location = chooseLocation({ cwd, run: id, env, home: opts.home ?? homedir() });
  if (!location) return startupFailed("startup.receipt_unwritable", `No writable receipt location: ${join(cwd, ".parley")} is not usable and the state directory is not writable`, "make .parley writable or set XDG_STATE_HOME to a writable absolute path");

  const sessionRaw = opts.session ?? env.PARLEY_SESSION;
  const session = sessionRaw ? sessionRaw : undefined;
  const resolvedRaw = discovery ? { discovery, command: commandName } : (opts.resolved ?? ((a, c) => ({ command: c, args: a })))(args.filter((a) => a !== commandName), commandName!);
  const resolvedPointers: string[] = [];
  const resolved = scrub(resolvedRaw, secretValues, "", resolvedPointers);
  const { argv: argvRedacted, indexes: argvIndexes } = redactArgv(argv, secretValues);
  const inputs = discovery || !command ? [] : (opts.inputs ?? (() => []))(args.filter((a) => a !== commandName), commandName!);
  const inputPointers: string[] = [];
  const inputDescriptors = scrub(inputs.map((i) => ({ path: i.path, ...(i.role ? { role: i.role } : {}) })), secretValues, "", inputPointers) as { path: string; role?: string }[];
  const inputIndexes = inputPointers.map((p) => Number(p.split("/")[1]));
  const redacted: Record<string, unknown> = {};
  if (argvIndexes.length) redacted.argv = argvIndexes;
  if (resolvedPointers.length) redacted.resolved = resolvedPointers;
  if (inputIndexes.length) redacted.inputs = [...new Set(inputIndexes)];
  if (presentEnv.length) redacted.env = presentEnv;
  if (presentSources.length) redacted.sources = presentSources;
  const headRedacted = Object.keys(redacted).length > 0;
  const inv = inputs.length === 0 && command ? computeInv({ tool: spec.name, v: spec.version, command: commandName!, resolved, inputs: [] }) : undefined;

  const run = new Run({
    tool: spec.name, v: spec.version, id, session, dryRun, stdout, stderr, receiptFd: location.fd, receiptPath: location.receiptPath, receiptDir: location.receiptDir,
    secretValues, now, cwd, command: commandName ?? discovery!, resolved, inputs, headRedacted, human: human ? spec.human ?? (() => null) : undefined,
  });

  run.bootstrap(inv);
  const bookkeeping = bookkeepingFor(cwd, env, opts.home);
  run.head({
    tool: spec.name, v: spec.version, ...(inv ? { inv } : {}), ...(session ? { session } : {}),
    argv: argvRedacted, resolved, ...(headRedacted ? { redacted } : {}), inputs: inputDescriptors,
    effects: command ? { ...command.effects, bookkeeping } : { reads: [], writes: [], network: false, idempotent: true, bookkeeping },
    ...(dryRun ? { dry_run: true } : {}),
  });
  if (run.sinkFailed) return run.end();
  if (location.warning) run.warning(location.warning);

  retain(run, location.receiptDir, spec.retention.count, dryRun);

  if (discovery) {
    const which = discovery === "help" && commandName ? [commandName] : names;
    for (const name of which) {
      const c = spec.commands[name]!;
      run.result({ event: "command", name, intent: c.intent, effects: { ...c.effects, bookkeeping }, secrets: [...(c.secrets ?? [])], emits: [...c.emits, ...(c.errors ?? [SCHEMA_IDS.error])].map(({ id, version }) => ({ id, version })) }, SCHEMA_IDS.command);
    }
    const types = new Map<string, EmittedType>();
    const add = (t: EmittedType) => { const k = `${t.id}@${t.version}`; if (!types.has(k)) types.set(k, t); };
    for (const name of which) { const c = spec.commands[name]!; c.emits.forEach(add); (c.errors ?? [SCHEMA_IDS.error]).forEach(add); }
    if (discovery === "schema") WRITER_SCHEMAS.forEach(add);
    for (const t of types.values()) {
      const doc = t.schema ?? SCHEMAS.find((s) => s.id === t.id && s.version === t.version)?.schema;
      if (!doc) { run.warning({ code: "schema.unavailable", problem: `no schema document for ${t.id}@${t.version}`, remedy: "declare the schema on the emitted type" }); continue; }
      run.result({ event: "schema", id: t.id, version: t.version, schema: doc }, SCHEMA_IDS.schema);
    }
    return run.end(0);
  }

  const restore = captureConsole(run);
  try {
    await handler(run, args.filter((a) => a !== commandName));
  } catch (e) {
    if (run.ended) { restore(); return 4; }
    const err = e instanceof Error ? e : new Error(String(e));
    run.error({ code: "uncaught.exception", problem: `uncaught ${err.name}: ${err.message || "(no message)"}`, remedy: "this is a defect in the tool; report it with the receipt", detail: { stack: err.stack } });
  } finally {
    restore();
  }
  return run.ended ? run.status ?? 4 : run.end();
}

/** §5.1: delete the oldest bundles beyond `count` in this location; never on a dry run; recorded as a decision. */
function retain(run: Run, receiptDir: string, count: number, dryRun: boolean): void {
  let files: { name: string; mtime: number }[];
  try { files = readdirSync(receiptDir).filter((f) => f.endsWith(".jsonl")).map((name) => ({ name, mtime: statSync(join(receiptDir, name)).mtimeMs })); } catch { return; }
  const excess = files.length - count;
  if (excess <= 0) return;
  const victims = files.filter((f) => f.name !== `${run.id}.jsonl`).sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name)).slice(0, excess);
  if (dryRun) { run.step(`retention: would delete ${victims.length} receipt bundle(s)`, `${files.length} receipts exceed the retention count of ${count}; a dry run performs no retention deletion (§4.3)`, { receipts: victims.map((v) => v.name) }); return; }
  const deleted: string[] = [];
  for (const v of victims) {
    const base = v.name.slice(0, -".jsonl".length);
    try { rmSync(join(receiptDir, v.name), { force: true }); rmSync(join(receiptDir, base), { recursive: true, force: true }); deleted.push(v.name); } catch { /* a bundle another run is deleting */ }
  }
  run.step(`retention: deleted ${deleted.length} receipt bundle(s)`, `${files.length} receipts exceeded the retention count of ${count}; the oldest are deleted with their sidecars (§5.1)`, { receipts: deleted });
}

/** §1.2: a library writing to the console must not reach a stream; route it into the receipt. */
function captureConsole(run: Run): () => void {
  const methods = ["log", "info", "warn", "error", "debug", "trace"] as const;
  const saved = Object.fromEntries(methods.map((m) => [m, console[m]])) as Record<(typeof methods)[number], (...a: unknown[]) => void>;
  for (const m of methods) {
    console[m] = (...a: unknown[]) => {
      const text = a.map((x) => (typeof x === "string" ? x : safeJson(x))).join(" ");
      if (!run.ended) run.step("captured console output", `a library called console.${m}; stdout and stderr carry only protocol lines (§1.2), so the text is kept here`, { method: m, text });
    };
  }
  return () => { for (const m of methods) console[m] = saved[m]; };
}

function safeJson(x: unknown): string { try { return JSON.stringify(x) ?? String(x); } catch { return String(x); } }

export type { Bookkeeping };
