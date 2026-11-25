// A tool: its commands, their declarations, and the entry point that turns argv and a handler
// into a conforming run (spec §3, §4, §6).
import { closeSync, openSync, readSync, readdirSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { historyBookkeeping, historyDays, historyProjection, isHistoryFailure, isHistorySink, openHistory, resolveHistory, retainHistory, type HistoryConfig, type HistoryPlan, type HistoryProjection, type HistorySink } from "./history.ts";
import { exactJson, plain, unwritableClause, unwritablePlain } from "./exact.ts";
import { computeInvPlain, type InputDecl } from "./inv.ts";
import { bookkeepingFor, chooseLocation, isLocationFailure, type Bookkeeping } from "./location.ts";
import { carriesSecret, classifySecrets, collectSecretValues, redactArgv, scrub, scrubPlain } from "./redact.ts";
import { ParleyRedactionConflict, Run, SCHEMA_IDS, type Record_, type SchemaRef, type Sink } from "./run.ts";
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
  /**
   * The error types the command can produce. Defaults to `parley.error` and
   * `parley.startup.failed`, since every command can produce a startup failure (§3.2, §4.2,
   * flyingrobots/parley#92); a list given here replaces the default, so name both in it.
   */
  readonly errors?: readonly EmittedType[];
}
export interface ToolSpec {
  readonly name: string;
  readonly version: string;
  readonly commands: Readonly<Record<string, CommandSpec>>;
  /** §5.1: a stated policy. Completed receipts beyond `count` in a location are deleted, oldest first. */
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

export type { InputDecl };
export interface MainOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  home?: string;
  stdout?: Sink;
  stderr?: Sink;
  session?: string;
  now?: () => number;
  /** The declared inputs of this invocation, from the command's arguments. */
  inputs?: (args: string[], command: string) => InputDecl[] | Promise<InputDecl[]>;
  /** The resolved interpretation after defaults (§5): order-normalised and free of volatile values, since it enters inv. The default records the command and its arguments. */
  resolved?: (args: string[], command: string) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /**
   * The shared history stream (§8). The default resolves it from the environment; `null` is no
   * stream. The long form, `{ sink?, transform?, name? }`, also configures the projection applied
   * to the stream copy: `{ history: { transform } }` keeps the sink the environment chose and
   * narrows what reaches it. A transform is configured in code and never by an environment
   * variable naming a module to execute.
   */
  history?: HistorySink | null | HistoryConfig;
}

/**
 * A sink on a file descriptor that delivers the whole line: a partial write continues from where
 * it stopped, and EAGAIN (a full pipe on a descriptor the runtime left non-blocking) waits a
 * millisecond and tries again, which is what a blocking write would have done.
 */
export function fdSink(fd: number): Sink {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  return {
    write(line) {
      const buf = Buffer.from(line, "utf8");
      let off = 0;
      while (off < buf.length) {
        try { off += writeSync(fd, buf, off, buf.length - off); }
        catch (e) { if ((e as NodeJS.ErrnoException).code === "EAGAIN") { Atomics.wait(pause, 0, 0, 1); continue; } throw e; }
      }
    },
  };
}
const OWN_FLAGS = new Set(["--human", "--humanize", "--dry-run", "--schema", "--help", "-h"]);
const WRITER_SCHEMAS: SchemaRef[] = Object.values(SCHEMA_IDS);
/** A command's error types when it declares none: what the writer itself can put on stderr for it (§4.2). */
const DEFAULT_ERRORS: readonly EmittedType[] = [SCHEMA_IDS.error, SCHEMA_IDS.startupFailed];
/** Incomplete receipts (no end line) older than this are deletable by retention; younger ones may still be in flight. */
const INCOMPLETE_GRACE_MS = 24 * 60 * 60 * 1000;

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
  const rawArgs = argv.slice(1);
  // `--` ends the writer's flags (flyingrobots/parley#103): the writer's own flags are recognised
  // anywhere before the first `--`, that `--` is removed, and every argument after it is the
  // tool's, untouched, a writer flag's text or a second `--` included.
  const dash = rawArgs.indexOf("--");
  const own = dash === -1 ? rawArgs : rawArgs.slice(0, dash);
  const after = dash === -1 ? [] : rawArgs.slice(dash + 1);
  const human = own.some((a) => a === "--human" || a === "--humanize");
  const dryRun = own.includes("--dry-run");
  const discovery = own.includes("--schema") ? "schema" : own.includes("--help") || own.includes("-h") ? "help" : null;
  const args = own.filter((a) => !OWN_FLAGS.has(a));
  const names = Object.keys(spec.commands);
  // The command is chosen by position (flyingrobots/parley#101): once the writer's flags are set
  // aside, the first remaining argument before any `--` is the command, and only that one argument
  // is removed. A tool with one command may omit it. A later argument with a command's text is the
  // tool's, and nothing after `--` is ever the command.
  const named = args.length > 0 && Object.hasOwn(spec.commands, args[0]!);
  const commandName = named ? args[0]! : names.length === 1 ? names[0]! : undefined;
  const rest = [...(named ? args.slice(1) : args), ...after];
  const command = commandName ? spec.commands[commandName]! : undefined;

  // Declared secrets of every command: a value passed to the wrong command is still a secret (§5.3).
  const allNames = classifySecrets(names.flatMap((n) => spec.commands[n]!.secrets ?? []));
  const secretValues = collectSecretValues(argv, allNames, env);
  const ownNames = classifySecrets(command?.secrets ?? []);

  let id = ulid(now());
  for (let i = 0; i < 16 && carriesSecret(id, secretValues); i++) id = ulid(now());

  const startupFailed = (code: string, problem: string, remedy: string): number => {
    const line = { event: "startup.failed", t: now(), seq: 0, run: id, tool: spec.name, v: spec.version, code, problem: scrubText(problem, secretValues), remedy, _schema: SCHEMA_IDS.startupFailed };
    try { stderr.write(human ? `startup failed ${code}: ${line.problem} (${remedy})\n` : JSON.stringify(line) + "\n"); } catch { /* nothing else can be said */ }
    return 3;
  };

  if (carriesSecret(id, secretValues)) return startupFailed("startup.secret_in_path", "no run id free of a declared secret value could be chosen", "do not pass a value this short as a declared secret");
  // The bootstrap line's identity fields are never scrubbed. The tool's name and version are public
  // and printed on every startup line regardless, so a secret inside them is not protectable and
  // the run proceeds; a session is caller-supplied and can be withheld, so one carrying a secret
  // is a startup failure (the startup line omits it).
  const sessionEarly = opts.session ?? env.PARLEY_SESSION;
  if (sessionEarly && carriesSecret(sessionEarly, secretValues)) return startupFailed("startup.secret_in_identity", "the session id contains a declared secret value and cannot be printed", "supply a session id that does not contain the secret");
  if (!commandName && discovery === null) return startupFailed("startup.unknown_command", `no command named; commands are ${names.join(", ")}`, `name one of: ${names.join(", ")}`);

  // Console capture starts here, before any tool code runs; captured text is buffered until the receipt exists (§1.2).
  const capture = captureConsole();
  const release = capture.release;
  const fail = (code: string, problem: string, remedy: string): number => { release(); return startupFailed(code, problem, remedy); };

  // Declared credential sources, resolved before the head (§5.3); a throwing resolver means "not present".
  const presentSources: string[] = [];
  for (const s of ownNames.sources) { try { if (await spec.sources?.[s]?.()) presentSources.push(s); } catch { /* not present */ } }
  const presentEnv = allNames.env.filter((n) => env[n] !== undefined);

  const location = chooseLocation({ cwd, run: id, env, home: opts.home ?? homedir(), secrets: secretValues });
  if (isLocationFailure(location)) return fail(location.code, location.problem, location.remedy);

  // The shared history stream (§8): opt-in, and unable to fail the run. With none configured
  // nothing below it happens, so the run is the run that existed before the stream did.
  let history: HistorySink | undefined;
  let historyPlan: HistoryPlan | null = null;
  let historyWarning: { code: string; problem: string; remedy: string } | undefined;
  const historyConfig: HistoryConfig = opts.history === undefined ? {} : opts.history === null ? { sink: null } : isHistorySink(opts.history) ? { sink: opts.history } : opts.history;
  if (historyConfig.sink !== undefined) history = historyConfig.sink ?? undefined;
  else {
    historyPlan = resolveHistory(env, opts.home ?? homedir(), now());
    if (historyPlan) {
      const opened = openHistory(historyPlan, secretValues);
      if (isHistoryFailure(opened)) { historyWarning = opened; historyPlan = null; }
      else history = opened;
    }
  }

  // Everything the tool supplies before the bootstrap line can throw; a throw here is a startup failure (§3.2), not a stack trace.
  let resolvedRaw: Record<string, unknown>, inputs: InputDecl[];
  try {
    resolvedRaw = discovery ? { discovery, command: commandName } : await (opts.resolved ?? ((a, c) => ({ command: c, args: a })))(rest, commandName!);
    inputs = discovery || !command ? [] : await (opts.inputs ?? (() => []))(rest, commandName!);
    // `resolved` goes into the head and into `inv`. It is taken once as the serialiser would
    // write it, so the head, the scrub and the identity are of one form: a hook is applied here
    // and nowhere later. A `bigint` in it is written as exact digits; one the writer could not
    // read back, or a number that is not finite, is refused here, where it is still a startup
    // failure.
    resolvedRaw = plain(resolvedRaw, "resolved") as Record<string, unknown>;
    if (resolvedRaw === null || typeof resolvedRaw !== "object" || Array.isArray(resolvedRaw)) throw new TypeError("resolved is not an object once written as JSON");
    const why = unwritablePlain(resolvedRaw);
    if (why) throw new TypeError(`resolved carries ${unwritableClause(why)}`);
  } catch (e) {
    try { closeSync(location.fd); unlinkSync(location.receiptPath); } catch { /* the reservation is gone either way */ }
    try { history?.close(); } catch { /* the stream was already gone */ }
    const err = e instanceof Error ? e : new Error(String(e));
    return fail("startup.arguments_invalid", `the arguments could not be interpreted: ${err.message || err.name}`, "fix the arguments; see the command's --help");
  }

  const sessionRaw = opts.session ?? env.PARLEY_SESSION;
  const session = sessionRaw ? sessionRaw : undefined;
  const resolvedPointers: string[] = [];
  const resolved = scrubPlain(resolvedRaw, secretValues, "", resolvedPointers);
  const { argv: argvRedacted, indexes: argvIndexes } = redactArgv(argv, secretValues, allNames.flags);
  const inputPointers: string[] = [];
  // `path` and `role` are the writer's field names here and are never renamed; their values are the tool's and are scrubbed.
  const inputDescriptors = scrub(inputs.map((i) => ({ path: i.path, ...(i.role ? { role: i.role } : {}) })), secretValues, "", inputPointers, { keys: false }) as { path: string; role?: string }[];
  const inputIndexes = inputPointers.map((p) => Number(p.split("/")[1]));
  const redacted: Record<string, unknown> = {};
  if (argvIndexes.length) redacted.argv = argvIndexes;
  if (resolvedPointers.length) redacted.resolved = resolvedPointers;
  if (inputIndexes.length) redacted.inputs = [...new Set(inputIndexes)];
  // The head writes `redacted` as built here (Run.head), so the two lists of names are scrubbed
  // here, as the head's scrub used to scrub them; the indexes and pointers above need none.
  if (presentEnv.length) redacted.env = scrub(presentEnv, secretValues);
  if (presentSources.length) redacted.sources = scrub(presentSources, secretValues);
  const headRedacted = Object.keys(redacted).length > 0;
  const inv = inputs.length === 0 && command ? computeInvPlain({ tool: spec.name, v: spec.version, command: commandName!, resolved, inputs: [] }) : undefined;

  // The projection of §8 exists only when there is both a stream to narrow and a transform to
  // narrow it with: a transform with no stream configured changes nothing, as the stream itself
  // changes nothing when it is not configured.
  const schemas = declaredSchemas(spec);
  const projection: HistoryProjection | undefined = history !== undefined && historyConfig.transform !== undefined
    ? historyProjection({ transform: historyConfig.transform, name: historyConfig.name }, schemas)
    : undefined;

  const run = new Run({
    tool: spec.name, v: spec.version, id, session, dryRun, stdout, stderr, receiptFd: location.fd, receiptPath: location.receiptPath, receiptDir: location.receiptDir,
    secretValues, now, cwd, command: commandName ?? discovery!, resolved, inputs, headRedacted, human: human ? spec.human ?? (() => null) : undefined, history, projection, schemas,
  });

  // From here the run has a receipt and, once the next call returns, a bootstrap line, so it
  // closes with `end` whatever happens (spec §3.3): nothing below may escape `main`, and `main`
  // returns a status instead of rejecting. `conduct` is everything the run does; what it throws
  // is the writer's own failure, or the failure of its report of the tool's.
  const progress = { reporting: false };
  let writerFailed = false, unreported = false, threwAfterEnd = false;

  /**
   * The tool's throw as the writer's own `uncaught.exception` (spec §6): writer-built, so no
   * declared secret can rename its fields or have it withheld, while the exception's name, message
   * and stack are scrubbed like any other text of the tool's (flyingrobots/parley#161).
   */
  const reportUncaught = (e: unknown, where: string, whose: string): void => {
    progress.reporting = true;
    const err = e instanceof Error ? e : new Error(String(e));
    run.writerError({ code: "uncaught.exception", problem: `uncaught ${err.name}${where}: ${err.message || "(no message)"}`, remedy: `${whose}; report it with the receipt at ${run.receiptPath}` }, { detail: { stack: err.stack } });
    progress.reporting = false;
  };

  const conduct = async (): Promise<void> => {
    run.bootstrap(inv);
    run.declareProjection();
    const bookkeeping = [...bookkeepingFor(cwd, env, opts.home), ...(history ? historyBookkeeping(history) : [])];
    run.head({
      tool: spec.name, v: spec.version, ...(inv ? { inv } : {}), ...(session ? { session } : {}),
      argv: argvRedacted, resolved, ...(headRedacted ? { redacted } : {}), inputs: inputDescriptors,
      effects: command ? { ...command.effects, bookkeeping } : { reads: [], writes: [], network: false, idempotent: true, bookkeeping },
      ...(dryRun ? { dry_run: true } : {}),
    });
    run.flushDeferredFailures();
    capture.attach(run);
    if (run.sinkFailed) return;
    if (location.warning) run.writerWarning(location.warning);
    if (historyWarning) run.writerWarning(historyWarning);
    run.noteProjection();

    retain(run, location.receiptDir, spec.retention.count, dryRun, now());
    if (history) retainStream(run, history.dir, historyPlan?.days ?? historyDays(env), dryRun, now());

    if (discovery) {
      try { discover(run, spec, discovery, commandName, bookkeeping); } catch (e) {
        if (!run.ended && !(e instanceof ParleyRedactionConflict)) reportUncaught(e, " during discovery", "this is a defect in the tool's declaration");
      }
      return;
    }

    try {
      await handler(run, [...rest]);
    } catch (e) {
      if (run.ended) { threwAfterEnd = true; return; }
      // A record redaction made invalid was already reported by the writer, under its own code and
      // without the value (§5.3, flyingrobots/parley#131); an uncaught.exception beside it would
      // say the same thing twice. The run closes with 4.
      if (!(e instanceof ParleyRedactionConflict)) reportUncaught(e, "", "this is a defect in the tool");
    }
  };

  try {
    await conduct();
  } catch (e) {
    writerFailed = true;
    // The tool failed and the line that says so could not be built or written.
    unreported = progress.reporting;
    try {
      if (!run.ended) run.writerError({ code: "uncaught.writer_failure", problem: `the writer itself failed: ${describeThrown(e)}`, remedy: `this is a defect in parley-emit; report it with the receipt at ${run.receiptPath}` }, { detail: { stack: stackOf(e) } });
    } catch { unreported = true; /* nothing more can be said; the status says it */ }
  } finally {
    release();
  }
  // A handler that threw after ending the run failed after the last line that could say so.
  if (run.ended) return threwAfterEnd ? 4 : run.status ?? 4;
  // A failure that could not be reported is protocol output that could not be written: 4, not
  // the 2 of a failure that was reported (spec §3.4).
  try { return run.end(writerFailed && unreported ? 4 : undefined); } catch { return 4; }
}

/** A thrown value in a few words, for the writer's own failure line. Never throws: a value that cannot be described is said to be that. */
function describeThrown(e: unknown): string {
  try {
    if (e instanceof Error) return `${e.name}: ${e.message || "(no message)"}`;
    return String(e);
  } catch { return "a thrown value that could not be described"; }
}

function stackOf(e: unknown): string | undefined {
  try { return e instanceof Error && typeof e.stack === "string" ? e.stack : undefined; } catch { return undefined; }
}

/**
 * Every schema document this writer can validate a line against, by `id@version`, whether a
 * projected line (§8) or a record redaction changed (§5.3):
 * the drafts the package ships (spec §4.5) and the schemas the tool declared on its own emitted
 * and error types (§4.2). A pair outside this map cannot be re-validated, and the stream is not
 * where an unchecked projection goes.
 */
function declaredSchemas(spec: ToolSpec): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const s of SCHEMAS) out.set(`${s.id}@${s.version}`, s.schema);
  for (const c of Object.values(spec.commands)) {
    for (const t of [...c.emits, ...(c.errors ?? [])]) if (t.schema) out.set(`${t.id}@${t.version}`, t.schema);
  }
  return out;
}

function discover(run: Run, spec: ToolSpec, discovery: "schema" | "help", commandName: string | undefined, bookkeeping: Bookkeeping[]): void {
  const names = Object.keys(spec.commands);
  {
    const which = discovery === "help" && commandName ? [commandName] : names;
    for (const name of which) {
      const c = spec.commands[name]!;
      run.describe({ event: "command", name, intent: c.intent, effects: { ...c.effects, bookkeeping }, secrets: [...(c.secrets ?? [])], emits: [...c.emits, ...(c.errors ?? DEFAULT_ERRORS)].map(({ id, version }) => ({ id, version })) }, SCHEMA_IDS.command);
    }
    const types = new Map<string, EmittedType>();
    const add = (t: EmittedType) => { const k = `${t.id}@${t.version}`; if (!types.has(k)) types.set(k, t); };
    for (const name of which) { const c = spec.commands[name]!; c.emits.forEach(add); (c.errors ?? DEFAULT_ERRORS).forEach(add); }
    if (discovery === "schema") WRITER_SCHEMAS.forEach(add);
    for (const t of types.values()) {
      const doc = t.schema ?? SCHEMAS.find((s) => s.id === t.id && s.version === t.version)?.schema;
      // The writer's own warning, so writer-built: its code and field names are not scrubbed.
      if (!doc) { run.writerWarning({ code: "schema.unavailable", problem: `no schema document for ${t.id}@${t.version}`, remedy: "declare the schema on the emitted type" }); continue; }
      run.describe({ event: "schema", id: t.id, version: t.version, schema: doc }, SCHEMA_IDS.schema, "schema");
    }
    run.end(0);
  }
}

function scrubText(s: string, values: ReadonlySet<string>): string { return scrub(s, values) as string; }

/** A receipt's size and mtime, as a comparable key and the mtime in milliseconds, or null when it is gone. */
function observe(path: string): { key: string; mtime: number } | null {
  try { const st = statSync(path, { bigint: true }); return { key: `${st.size}:${st.mtimeNs}`, mtime: Number(st.mtimeNs / 1_000_000n) }; } catch { return null; }
}

/** True when the receipt's final line is a newline-terminated `end` (§5.4), read from its tail. */
function hasEnded(path: string): boolean {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    if (size === 0) return false;
    fd = openSync(path, "r");
    const len = Math.min(size, 8192);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const text = buf.toString("utf8");
    if (!text.endsWith("\n")) return false;
    const last = text.slice(0, -1).split("\n").pop() ?? "";
    const obj = JSON.parse(last) as { event?: string };
    return obj.event === "end";
  } catch { return false; } finally { if (fd !== null) closeSync(fd); }
}

/** The head's size past which a receipt's owner is not looked for: a head that large is read as "not readable", and the file is left alone. */
const HEAD_READ_LIMIT = 1024 * 1024;

/**
 * The `tool` a receipt's head names, from the first line alone, or null when there is no such
 * line: an empty file, a first line that is not JSON or not a `receipt.head`, a head with no
 * string `tool`, or a first line longer than the limit. Null means "not ours" to a caller that
 * deletes, so an unreadable file is never expired.
 */
function headTool(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const chunk = Buffer.alloc(8192);
    const parts: Buffer[] = [];
    let total = 0;
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, total);
      if (n <= 0) return null;
      const nl = chunk.subarray(0, n).indexOf(10);
      const take = nl === -1 ? n : nl;
      parts.push(Buffer.from(chunk.subarray(0, take)));
      total += take;
      if (total > HEAD_READ_LIMIT) return null;
      if (nl !== -1) break;
    }
    const obj = JSON.parse(Buffer.concat(parts).toString("utf8")) as { event?: unknown; tool?: unknown };
    return obj.event === "receipt.head" && typeof obj.tool === "string" ? obj.tool : null;
  } catch { return null; } finally { if (fd !== null) closeSync(fd); }
}

/**
 * §5.1: delete the oldest completed bundles of this tool beyond `count` in this location (another
 * tool's receipts are never counted or deleted); never a receipt still in flight; never on a dry
 * run; recorded as a decision. Exported for the package's own tests, not from the index:
 * `afterScan` runs between the listing and the decisions, where another run can append.
 */
export function retain(run: Run, receiptDir: string, count: number, dryRun: boolean, at: number, afterScan?: () => void): void {
  let files: { name: string; mtime: number }[];
  try {
    files = readdirSync(receiptDir).filter((f) => f.endsWith(".jsonl") && headTool(join(receiptDir, f)) === run.tool).map((name) => ({ name, mtime: statSync(join(receiptDir, name)).mtimeMs }));
  } catch { return; }
  afterScan?.();
  const excess = files.length - count;
  if (excess <= 0) return;
  const candidates = files.filter((f) => f.name !== `${run.id}.jsonl`).sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
  // The scan orders the candidates; each decision re-observes its receipt, because another run can
  // append between the scan and here (flyingrobots/parley#112). The observation is compared again
  // just before the unlink.
  const chosen: { name: string; seen: string }[] = [];
  for (const f of candidates) {
    if (chosen.length >= excess) break;
    const p = join(receiptDir, f.name);
    const seen = observe(p);
    if (seen === null) continue;
    if (hasEnded(p) || at - seen.mtime > INCOMPLETE_GRACE_MS) chosen.push({ name: f.name, seen: seen.key });
  }
  const victims = chosen.map((c) => c.name);
  if (!victims.length) { run.writerStep("retention: nothing to delete", `${files.length} of this tool's receipts exceed the retention count of ${count}, but every excess receipt is still in flight (no end line yet); only completed bundles, or incomplete ones older than a day, are deleted (§5.1)`); return; }
  if (dryRun) { run.writerStep(`retention: would delete ${victims.length} receipt bundle(s)`, `${files.length} of this tool's receipts exceed the retention count of ${count}; a dry run performs no retention deletion (§4.3)`, { receipts: victims }); return; }
  const deleted: string[] = [];
  for (const { name, seen } of chosen) {
    const p = join(receiptDir, name);
    if (observe(p)?.key !== seen) continue; // it moved since the decision: its run may be alive (flyingrobots/parley#112)
    const base = name.slice(0, -".jsonl".length);
    // One bundle (§5): rmSync with force ignores only an absent receipt, so a receipt that cannot be
    // unlinked throws here and keeps its sidecars.
    try { rmSync(p, { force: true }); rmSync(join(receiptDir, base), { recursive: true, force: true }); deleted.push(name); } catch { /* a bundle another run is deleting */ }
  }
  run.writerStep(`retention: deleted ${deleted.length} receipt bundle(s)`, `${files.length} of this tool's receipts exceeded the retention count of ${count}; the oldest completed bundles are deleted with their sidecars (§5.1)`, { receipts: deleted });
}

/**
 * §5.1 for the shared history stream (§8): keep `days` daily segments, today's included, and
 * delete the rest whole, because an append-only file with concurrent writers can be expired by
 * unlinking a segment nobody is writing to and cannot be expired by rewriting. Recorded as a
 * decision, like the receipt's retention, and skipped on a dry run.
 */
function retainStream(run: Run, dir: string, days: number, dryRun: boolean, at: number): void {
  const segments = retainHistory(dir, days, at, dryRun);
  if (!segments.length) return;
  if (dryRun) { run.writerStep(`history retention: would delete ${segments.length} segment(s)`, `the shared history stream keeps ${days} daily segment(s), today's included; a dry run performs no retention deletion (§4.3)`, { segments }); return; }
  run.writerStep(`history retention: deleted ${segments.length} segment(s)`, `the shared history stream keeps ${days} daily segment(s), today's included; older segments are deleted whole, since an append-only file with concurrent writers cannot be rewritten safely (§5.1, §8)`, { segments });
}

// ---- console capture (§1.2) --------------------------------------------------------------
// One saved copy of the real console, taken when the first capture starts; a stack of captures,
// each bound to a run once that run's receipt exists and buffering until then. Every function
// on console is routed into the receipt of the most recent capture that is still open. The real
// console returns when the last capture releases. Direct writes to a file descriptor and timers
// that fire after end are outside this net; the README names them as exceptions.

type ConsoleFn = (...a: unknown[]) => unknown;
interface Capture { run: Run | null; pending: { method: string; text: string }[]; released: boolean }
const active: Capture[] = [];
let saved: Map<string, ConsoleFn> | null = null;

function record(c: Capture, method: string, text: string): void {
  if (c.run === null) { c.pending.push({ method, text }); return; }
  if (c.run.ended) return;
  try { c.run.writerStep("captured console output", `a library called console.${method}; stdout and stderr carry only protocol lines (§1.2), so the text is kept here`, { method, text }); } catch { /* the run ended between the check and the write */ }
}

function captureConsole(): { attach: (run: Run) => void; release: () => void } {
  const c: Capture = { run: null, pending: [], released: false };
  active.push(c);
  if (saved === null) {
    saved = new Map();
    const con = console as unknown as Record<string, unknown>;
    for (const key of Object.getOwnPropertyNames(console)) {
      const fn = con[key];
      if (typeof fn !== "function") continue;
      saved.set(key, fn as ConsoleFn);
      con[key] = (...a: unknown[]) => {
        const target = [...active].reverse().find((x) => !x.released && (x.run === null || !x.run.ended));
        if (!target) return;
        record(target, key, a.map((x) => (typeof x === "string" ? x : safeJson(x))).join(" "));
      };
    }
  }
  return {
    attach(run) { c.run = run; for (const p of c.pending) record(c, p.method, p.text); c.pending = []; },
    release() {
      if (c.released) return; c.released = true;
      const i = active.indexOf(c); if (i >= 0) active.splice(i, 1);
      if (active.length === 0 && saved !== null) {
        const con = console as unknown as Record<string, unknown>;
        for (const [key, fn] of saved) con[key] = fn;
        saved = null;
      }
    },
  };
}

/** A console argument as text: its JSON where it has one, a `bigint` inside it as exact digits, and never a throw. */
function safeJson(x: unknown): string {
  if (x === undefined || typeof x === "function" || typeof x === "symbol") return String(x);
  try { return exactJson(x); } catch { return String(x); }
}

export type { Bookkeeping };
