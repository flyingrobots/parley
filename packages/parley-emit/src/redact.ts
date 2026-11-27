// Redaction (spec §5.3). Declared secrets are named in the command description: an argument by
// its flag, a variable by its name, a credential source by a logical name. Their values are
// replaced with the literal `[redacted]` in a record's payload before any copy leaves the
// process, and the head records where. The envelope and the writer's own identifiers are never
// scrubbed: the writer refuses, at startup, to choose a run id or receipt path that carries a
// secret (location.ts, tool.ts), so there is nothing in them to replace.
import { exactText, plain } from "./exact.ts";

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
  // A secret holding a character JSON escapes (a quote, a backslash, a newline) has a second
  // spelling: the one it takes inside JSON text. The writer itself encodes some values as text
  // before they are scrubbed as text (captured console output of an object, a refusal quoted in
  // a warning), so that spelling is a declared value too.
  for (const v of [...values]) { const escaped = JSON.stringify(v).slice(1, -1); if (escaped !== v) values.add(escaped); }
  return values;
}

/** Longest value first, so a secret that contains another is replaced whole rather than leaving its tail behind. */
function ordered(values: ReadonlySet<string>): string[] { return [...values].sort((a, b) => b.length - a.length); }

export function replaceSecrets(s: string, values: ReadonlySet<string>): string {
  let out = s;
  for (const v of ordered(values)) if (out.includes(v)) out = out.split(v).join(REDACTED);
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
function unescapePointer(token: string): string { return token.replace(/~1/g, "/").replace(/~0/g, "~"); }

/**
 * A JSON Pointer (RFC 6901) with every secret replaced inside each reference token, read as the
 * key it stands for: a pointer escapes `/` and `~`, so a key that is a secret holding either
 * would otherwise pass a search of the pointer's text. A pointer a validator reports can name a
 * key the record no longer has (the one a scrub renamed), and that key can be the secret.
 */
export function scrubPointer(pointer: string, values: ReadonlySet<string>): string {
  if (values.size === 0 || !pointer.startsWith("/")) return replaceSecrets(pointer, values);
  return pointer.split("/").map((t, i) => (i === 0 ? t : escapePointer(replaceSecrets(unescapePointer(t), values)))).join("/");
}

export interface ScrubOptions {
  /** Keys whose string values are never scrubbed: writer digests, which a secret cannot occur in except by coincidence of hex. */
  readonly skipKeys?: ReadonlySet<string>;
  /** Scrub numbers, booleans and bigints whose decimal form is a secret (default true). A writer-built record passes false: its scalars (`status`, `dry_run`, `network`, `in`) are the writer's own and never a secret. */
  readonly scalars?: boolean;
  /**
   * Rename an object key that carries a secret (default true). A writer-built record passes
   * false: its field names (`paths`, `status`, `op`) are the protocol's, named by the released
   * schema, and renaming one would publish a line that schema rejects. A tool's object that
   * reaches a writer-built record (`resolved`) was scrubbed in full, keys included, before the
   * record was built.
   */
  readonly keys?: boolean;
}

/**
 * A deep copy of `value` with every secret replaced, and the RFC 6901 pointer of each place that
 * changed. Strings are replaced within; a number, boolean or bigint whose decimal form is a
 * secret becomes the string `[redacted]` (a PIN parsed to a number is still the PIN); an object
 * key that carries a secret is renamed, and the pointer recorded is the renamed key's. `opts`
 * narrows this for a writer-built record.
 *
 * **What is scrubbed is what is written** (flyingrobots/parley#178). The serialiser writes a
 * value with a `toJSON` hook as what the hook returns and a boxed primitive as its primitive, so
 * that is what is scrubbed, and the copy holds the plain result: a `Date` is its string, a `URL`
 * its href, and a secret only a hook returns is replaced like any other. The hook is applied
 * once per value, as `JSON.stringify` applies it, to an object or a function alike. A function
 * with no hook, or one a hook returned, has no JSON form and is absent from the copy, so nothing
 * callable is left for the serialiser to call afterwards.
 * Before this, the copy was built from own keys alone: a `Date` became `{}`, and an object's own
 * `toJSON` was copied across and called by the serialiser after the scrub, unscrubbed.
 */
export function scrub(value: unknown, values: ReadonlySet<string>, pointer = "", found: string[] = [], opts: ScrubOptions = {}): unknown {
  if (values.size === 0) return value;
  return scrubPlain(plain(value), values, pointer, found, opts);
}

/**
 * `scrub` for a value that is plain data already (`plain`'s result): no hook is called and no
 * box is opened, because none is left. The writer scrubs the one snapshot it took of a payload
 * with this, so the scrub and the serialiser cannot read the payload differently.
 */
export function scrubPlain(value: unknown, values: ReadonlySet<string>, pointer = "", found: string[] = [], opts: ScrubOptions = {}): unknown {
  if (values.size === 0) return value;
  if (typeof value === "string") {
    const r = replaceSecrets(value, values);
    if (r !== value) found.push(pointer || "/");
    return r;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    if (opts.scalars !== false && values.has(String(value))) { found.push(pointer || "/"); return REDACTED; }
    return value;
  }
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (let i = 0; i < value.length; i++) items.push(scrubPlain(value[i], values, `${pointer}/${i}`, found, opts));
    return items;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value)) {
      const v = (value as Record<string, unknown>)[k];
      const renamed = opts.keys === false ? k : replaceSecrets(k, values);
      const p = `${pointer}/${escapePointer(renamed)}`;
      const member = opts.skipKeys?.has(k) && typeof v === "string" ? v : scrubPlain(v, values, p, found, opts);
      if (renamed !== k) found.push(p);
      // Defined, never assigned: a member named `__proto__` is data, not the copy's prototype.
      Object.defineProperty(out, renamed, { value: member, enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return value;
}

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const isLeaf = (v: unknown): boolean => v === null || typeof v !== "object";

/** The base search, over material that is wholly the transform's: every value and key as the scrub looks, and the JSON text as written, structure included. */
function addedCarries(value: unknown, text: string, values: ReadonlySet<string>): boolean {
  const found: string[] = [];
  scrubPlain(value, values, "", found);
  return found.length > 0 || carriesSecret(text, values);
}

/**
 * Whether a history transform's `body` carries a declared value in what it changed or added,
 * against `line`, the receipt line's body it was handed, read before the transform ran (spec
 * §5.3, §8; flyingrobots/parley#186, flyingrobots/parley#164, and the Baker Street review of
 * flyingrobots/parley#199). Both are plain data with no envelope.
 *
 * The two are walked together by real path: object members by name, array elements by index.
 *
 * - A leaf (a string, number, boolean or null) is **unchanged** when the line has a leaf at the
 *   same path with the same JSON text. Unchanged material is the line's own, which the stream
 *   gets verbatim when no transform is configured, so it is never searched: a field name or a
 *   writer scalar equal to a secret, a `[redacted]`, or digits that happen to hold one.
 * - Anything else is changed. A changed leaf is searched as itself and as its JSON text (quotes
 *   and escapes included). A member whose name the line's object at that path does not have, an
 *   array element past the line's length, and a value whose kind differs from the line's (an
 *   object where the line had a leaf) is added, and is searched whole: its name, every value and
 *   key under it, and its JSON text, structure included.
 *
 * So a place that held a declared value may hold only that value afterwards, and no occurrence
 * elsewhere in the line can cover a new one. The search is the writer's own: every declared
 * value, each in every spelling `collectSecretValues` recognises (JSON-escaped included), as a
 * substring of a string or key, and a number or other scalar by its text. A declared value that
 * spans JSON structure is matched only within changed or added material: one that runs across a
 * changed leaf and the unchanged text beside it is not found.
 */
export function changedCarriesSecret(body: unknown, line: unknown, values: ReadonlySet<string>): boolean {
  if (values.size === 0) return false;
  return changed(body, line, values);
}

function changed(value: unknown, was: unknown, values: ReadonlySet<string>): boolean {
  if (isLeaf(value)) {
    const text = exactText(value);
    if (isLeaf(was) && text === exactText(was)) return false;
    return (typeof value === "string" && carriesSecret(value, values)) || carriesSecret(text, values);
  }
  if (isLeaf(was) || Array.isArray(value) !== Array.isArray(was)) return addedCarries(value, exactText(value), values);
  if (Array.isArray(value)) {
    const prior = was as unknown[];
    for (let i = 0; i < value.length; i++) {
      if (i >= prior.length ? addedCarries(value[i], exactText(value[i]), values) : changed(value[i], prior[i], values)) return true;
    }
    return false;
  }
  const prior = was as Record<string, unknown>;
  for (const k of Object.keys(value as object)) {
    const v = (value as Record<string, unknown>)[k];
    if (own(prior, k) ? changed(v, prior[k], values) : carriesSecret(k, values) || addedCarries(v, `${exactText(k)}:${exactText(v)}`, values)) return true;
  }
  return false;
}
