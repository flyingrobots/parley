// Redaction (spec §5.3). Declared secrets are named in the command description: an argument by
// its flag, a variable by its name, a credential source by a logical name. Their values are
// replaced with the literal `[redacted]` in a record's payload before any copy leaves the
// process, and the head records where. The envelope and the writer's own identifiers are never
// scrubbed: the writer refuses, at startup, to choose a run id or receipt path that carries a
// secret (location.ts, tool.ts), so there is nothing in them to replace.
export const REDACTED = "[redacted]";

export interface SecretNames { readonly flags: string[]; readonly env: string[]; readonly sources: string[] }

/** A name starting with `-` is a flag; an upper-case identifier is an environment variable; anything else is a logical source. */
export function classifySecrets(secrets: readonly string[]): SecretNames {
  const flags: string[] = [], env: string[] = [], sources: string[] = [];
  for (const s of new Set(secrets)) {
    if (s.startsWith("-")) flags.push(s);
    else if (/^[A-Z_][A-Z0-9_]*$/.test(s)) env.push(s);
    else sources.push(s);
  }
  return { flags, env, sources };
}

/** The secret values an invocation carries: declared flag values from argv and declared variables from the environment. Empty values are supplied but carry nothing to replace. */
export function collectSecretValues(argv: readonly string[], names: SecretNames, env: Record<string, string | undefined>): Set<string> {
  const values = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    for (const flag of names.flags) {
      if (a === flag && i + 1 < argv.length) values.add(argv[i + 1]!);
      else if (a.startsWith(flag + "=")) values.add(a.slice(flag.length + 1));
    }
  }
  for (const name of names.env) { const v = env[name]; if (v !== undefined) values.add(v); }
  values.delete("");
  return values;
}

export function replaceSecrets(s: string, values: ReadonlySet<string>): string {
  let out = s;
  for (const v of values) if (out.includes(v)) out = out.split(v).join(REDACTED);
  return out;
}

/** True when any secret value occurs inside `s`, which disqualifies `s` as a writer-chosen identifier. */
export function carriesSecret(s: string, values: ReadonlySet<string>): boolean {
  for (const v of values) if (s.includes(v)) return true;
  return false;
}

/**
 * The raw argv after §5.3: the element after a declared flag becomes `[redacted]` even when
 * empty (it was supplied), `--name=value` keeps its flag, and a secret inside any other element
 * is replaced within it.
 */
export function redactArgv(argv: readonly string[], values: ReadonlySet<string>, flags: readonly string[] = []): { argv: string[]; indexes: number[] } {
  const out = argv.map((a) => replaceSecrets(a, values));
  const changed = new Set<number>();
  out.forEach((a, i) => { if (a !== argv[i]) changed.add(i); });
  for (let i = 0; i < argv.length; i++) {
    for (const flag of flags) {
      if (argv[i] === flag && i + 1 < argv.length) { out[i + 1] = REDACTED; changed.add(i + 1); }
      else if (argv[i]!.startsWith(flag + "=")) { out[i] = flag + "=" + REDACTED; changed.add(i); }
    }
  }
  return { argv: out, indexes: [...changed].sort((a, b) => a - b) };
}

function escapePointer(key: string): string { return key.replace(/~/g, "~0").replace(/\//g, "~1"); }

export interface ScrubOptions {
  /** Keys whose string values are never scrubbed: writer digests, which a secret cannot occur in except by coincidence of hex. */
  readonly skipKeys?: ReadonlySet<string>;
}

/** A deep copy of `value` with every secret replaced, and the RFC 6901 pointer of each string that changed. */
export function scrub(value: unknown, values: ReadonlySet<string>, pointer = "", found: string[] = [], opts: ScrubOptions = {}): unknown {
  if (values.size === 0) return value;
  if (typeof value === "string") {
    const r = replaceSecrets(value, values);
    if (r !== value) found.push(pointer || "/");
    return r;
  }
  if (Array.isArray(value)) return value.map((v, i) => scrub(v, values, `${pointer}/${i}`, found, opts));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = opts.skipKeys?.has(k) && typeof v === "string" ? v : scrub(v, values, `${pointer}/${escapePointer(k)}`, found, opts);
    }
    return out;
  }
  return value;
}
