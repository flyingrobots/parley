// Redaction (spec §5.3). Declared secrets are named in the command description: an argument by
// its flag, a variable by its name, a credential source by a logical name. Their values are
// replaced with the literal `[redacted]` before any record leaves the process, and the head
// records where.
export const REDACTED = "[redacted]";

export interface SecretNames { readonly flags: string[]; readonly env: string[]; readonly sources: string[] }

/** A name starting with `-` is a flag; an upper-case identifier is an environment variable; anything else is a logical source. */
export function classifySecrets(secrets: readonly string[]): SecretNames {
  const flags: string[] = [], env: string[] = [], sources: string[] = [];
  for (const s of secrets) {
    if (s.startsWith("-")) flags.push(s);
    else if (/^[A-Z_][A-Z0-9_]*$/.test(s)) env.push(s);
    else sources.push(s);
  }
  return { flags, env, sources };
}

/** The secret values an invocation carries: declared flag values from argv and declared variables from the environment. */
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

/** The raw argv after §5.3: a value element becomes `[redacted]`, `--name=value` keeps its flag, and a secret inside a longer value is replaced within it. */
export function redactArgv(argv: readonly string[], values: ReadonlySet<string>): { argv: string[]; indexes: number[] } {
  const out = argv.map((a) => replaceSecrets(a, values));
  const indexes = out.flatMap((a, i) => (a !== argv[i] ? [i] : []));
  return { argv: out, indexes };
}

function escapePointer(key: string): string { return key.replace(/~/g, "~0").replace(/\//g, "~1"); }

/** A deep copy of `value` with every secret replaced, and the RFC 6901 pointer of each string that changed. */
export function scrub(value: unknown, values: ReadonlySet<string>, pointer = "", found: string[] = []): unknown {
  if (values.size === 0) return value;
  if (typeof value === "string") {
    const r = replaceSecrets(value, values);
    if (r !== value) found.push(pointer || "/");
    return r;
  }
  if (Array.isArray(value)) return value.map((v, i) => scrub(v, values, `${pointer}/${i}`, found));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrub(v, values, `${pointer}/${escapePointer(k)}`, found);
    return out;
  }
  return value;
}
