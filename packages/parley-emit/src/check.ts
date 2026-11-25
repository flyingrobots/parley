// A bounded JSON Schema (draft 2020-12) checker, written for exactly one job: re-validating the
// record a history transform returned against the schema for its exact advertised pair (§4.5),
// inside a package that has no runtime dependencies. It is not a general validator and does not
// pretend to be one.
//
// The honest part is the boundary. It implements the constructs the protocol's own schemas use
// and **says so** when a schema uses one it does not, rather than ignoring the keyword and
// reporting a line as checked that was not. A caller that cannot verify a line can then refuse
// it. `test/parley-emit.test.ts` asserts every schema this package ships is inside the subset,
// so a new draft that reaches for `$ref` fails a test here rather than silently going unchecked.
//
// A `bigint` in a record is a JSON number and an integer (flyingrobots/parley#171), and is never
// converted to a double to be checked. Each numeric keyword is decided for it exactly, or the
// checker says it cannot decide: see `beside`.
import { exactJson } from "./exact.ts";

/** The keywords that carry no assertion; present for readers and ignored here. */
const ANNOTATIONS = new Set(["$schema", "$id", "$anchor", "$comment", "title", "description", "examples", "default", "deprecated", "readOnly", "writeOnly"]);
/** Everything this checker understands. A keyword outside it is reported, never ignored. */
const SUPPORTED = new Set([
  ...ANNOTATIONS,
  "type", "const", "enum", "required", "properties", "additionalProperties", "items",
  "minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum",
  "exclusiveMinimum", "exclusiveMaximum", "minProperties", "maxProperties",
  "pattern", "format", "not", "anyOf", "allOf", "oneOf", "if", "then", "else",
]);
/** The formats this checker asserts. Any other is reported as unsupported, not waved through. */
const FORMATS: Record<string, RegExp> = {
  // RFC 6901, as ajv-formats asserts it: empty, or one or more escaped segments.
  "json-pointer": /^(?:\/(?:[^~/]|~0|~1)*)*$/u,
};

/**
 * The first construct in `schema` this checker does not implement, or `null` when the whole
 * document is inside the subset. This is a property of the schema and not of any one record, so
 * it is checked **before** a value is walked: a keyword nested under a property the record does
 * not happen to carry would otherwise go unnoticed, and "we checked the parts we understood" is
 * exactly the claim this file exists not to make. Memoised per document.
 */
export function schemaSubsetGap(schema: unknown): string | null {
  if (typeof schema !== "object" || schema === null) return walkSchema(schema);
  const cached = gaps.get(schema as object);
  if (cached !== undefined) return cached;
  const gap = walkSchema(schema);
  gaps.set(schema as object, gap);
  return gap;
}
const gaps = new WeakMap<object, string | null>();

const SUBSCHEMA = ["items", "not", "if", "then", "else", "additionalProperties"] as const;
const SUBSCHEMA_LISTS = ["anyOf", "allOf", "oneOf"] as const;

const TYPE_NAMES = new Set(["null", "boolean", "object", "array", "number", "string", "integer"]);
/** Keywords whose value is a count: a non-negative integer. */
const COUNTS = ["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"] as const;
/** Keywords whose value is a bound: a finite number. */
const BOUNDS = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const;
/** What `schemaSubsetGap` reports for a `pattern` this writer will not answer for. It names no part of the pattern. */
const PATTERN_GAP = "a pattern this writer cannot evaluate as ECMAScript reads it";

/**
 * A keyword whose value has the wrong shape is a schema this checker cannot evaluate, the same as
 * a keyword it does not implement: `enum: 5` has no reading to check a record against. Each is
 * reported here, before any value is walked, so nothing below has to trust a shape it did not
 * check and no malformed document can make the walk throw. The Python writer reports the same
 * constructs in the same words.
 */
function walkSchema(node: unknown): string | null {
  if (node === true || node === false || node === undefined) return null;
  if (typeof node !== "object" || node === null || Array.isArray(node)) return "a schema that is not an object or a boolean";
  const s = node as Record<string, unknown>;
  for (const k of Object.keys(s)) if (!SUPPORTED.has(k)) return k;
  if (s.type !== undefined) {
    const names = Array.isArray(s.type) ? s.type : [s.type];
    if (!names.every((t) => typeof t === "string" && TYPE_NAMES.has(t))) return "type that is not a type name or a list of type names";
  }
  if (s.enum !== undefined && !Array.isArray(s.enum)) return "enum that is not a list";
  if (s.required !== undefined && !(Array.isArray(s.required) && s.required.every((k) => typeof k === "string"))) return "required that is not a list of strings";
  for (const k of COUNTS) if (s[k] !== undefined && !(typeof s[k] === "number" && Number.isInteger(s[k]) && (s[k] as number) >= 0)) return `${k} that is not a non-negative integer`;
  for (const k of BOUNDS) if (s[k] !== undefined && !(typeof s[k] === "number" && Number.isFinite(s[k]))) return `${k} that is not a number`;
  if (s.pattern !== undefined) {
    if (typeof s.pattern !== "string") return "pattern that is not a string";
    if (regex(s.pattern) === null) return PATTERN_GAP;
  }
  if (s.format !== undefined) {
    if (typeof s.format !== "string") return "format that is not a string";
    if (!Object.hasOwn(FORMATS, s.format)) return `format ${s.format}`;
  }
  if (Array.isArray(s.items)) return "items as a tuple";
  for (const k of SUBSCHEMA) { const gap = walkSchema(s[k]); if (gap !== null) return gap; }
  for (const k of SUBSCHEMA_LISTS) {
    if (s[k] === undefined) continue;
    if (!Array.isArray(s[k])) return `${k} that is not a list`;
    for (const sub of s[k] as unknown[]) { const gap = walkSchema(sub); if (gap !== null) return gap; }
  }
  if (s.properties !== undefined) {
    if (s.properties === null || typeof s.properties !== "object" || Array.isArray(s.properties)) return "properties that is not an object";
    for (const sub of Object.values(s.properties as Record<string, unknown>)) { const gap = walkSchema(sub); if (gap !== null) return gap; }
  }
  return null;
}

export type CheckResult =
  /** The record satisfies the schema. */
  | { readonly ok: true }
  /**
   * The record does not satisfy it; `errors` names where, shortest path first. `pointers` is the
   * JSON Pointer (RFC 6901) of each error, in the same order: the place in the record the error
   * is about, and for a missing or disallowed property, that property. A pointer is a location
   * and nothing else, so it is safe to print where an error's text, which can quote the schema,
   * is not (flyingrobots/parley#131).
   */
  | { readonly ok: false; readonly errors: readonly string[]; readonly pointers: readonly string[] }
  /** The schema uses a construct this checker does not implement, so nothing was established. */
  | { readonly ok: false; readonly errors: readonly string[]; readonly unsupported: string };

/** One failure: where in the record, and the sentence about it. */
interface Issue { readonly at: string; readonly message: string }

/** The same refusal, raised from inside the walk of a value as a guard of last resort. */
class Unsupported extends Error {
  constructor(readonly keyword: string) { super(`the schema uses ${keyword}, which this checker does not implement`); }
}

/**
 * Check `value` against `schema`. Returns `ok` when it satisfies it, an error list when it does
 * not, and an `unsupported` keyword when the schema is outside the subset — in which case the
 * result establishes nothing either way, and a caller that must not guess should refuse.
 */
export function checkRecord(value: unknown, schema: unknown): CheckResult {
  const gap = schemaSubsetGap(schema);
  if (gap !== null) return { ok: false, errors: [`the schema uses ${gap}, which this checker does not implement`], unsupported: gap };
  const issues: Issue[] = [];
  try { validate(schema, value, "", issues); }
  catch (e) {
    if (e instanceof Unsupported) return { ok: false, errors: [e.message], unsupported: e.keyword };
    // Nothing else is expected, since the walk above checked every shape the code below relies
    // on. Whatever it is, it is this checker failing to evaluate the schema, and the answer to
    // that is "nothing was established", never a throw and never the thrown text, which can
    // quote the schema (spec §5.3).
    const gap = "a construct this checker could not evaluate";
    return { ok: false, errors: [`the schema uses ${gap}, which this checker does not implement`], unsupported: gap };
  }
  return issues.length === 0 ? { ok: true } : { ok: false, errors: issues.map((i) => i.message), pointers: issues.map((i) => i.at) };
}

/** One RFC 6901 reference token: `~` and `/` inside a key are escaped, so a pointer names one place. */
function token(key: string): string { return key.replace(/~/g, "~0").replace(/\//g, "~1"); }

function at(path: string): string { return path === "" ? "/" : path; }

function kindOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  if (t === "bigint") return "integer";
  return t === "number" ? (Number.isInteger(v as number) ? "integer" : "number") : t;
}

function isType(v: unknown, t: string): boolean {
  if (typeof v === "bigint") return t === "number" || t === "integer";
  if (t === "number") return typeof v === "number" && Number.isFinite(v);
  if (t === "integer") return typeof v === "number" && Number.isInteger(v);
  return kindOf(v) === t;
}

/** Whether an exact integer is inside the safe-integer range. */
const SAFE = (value: bigint): boolean => value >= -9007199254740991n && value <= 9007199254740991n;

/** What `beside` reports when it cannot place the two values. */
const INEXACT = "a number beyond the safe-integer range to compare an integer beyond that range with, which this checker cannot do exactly";

/**
 * Where an exact integer stands beside a schema's number: -1 below it, 0 equal, 1 above. Never
 * by converting the `bigint`: JavaScript compares a `bigint` with a number by value.
 *
 * The number is what the schema document holds in memory, and a document read from JSON text
 * holds a double. Inside the safe-integer range, or with a fraction, that double is what the
 * text said closely enough to place any integer. Beyond the safe range it may be a rounded
 * reading: `maximum: 18446744073709551615` loads as 18446744073709551616, and an exact integer
 * beside it would be judged against a bound the schema never stated. The checker cannot tell, so
 * it says it cannot decide (`Unsupported`): the caller reports "unchecked", never "invalid".
 *
 * A `bigint` inside the safe range is placed against any bound: a text that loads as a double
 * beyond the safe range states a magnitude of at least 2^53 - 0.5, which is past every safe
 * integer on the side the double's sign says.
 */
function beside(value: bigint, bound: number, keyword: string): -1 | 0 | 1 {
  if (Number.isInteger(bound) && !Number.isSafeInteger(bound) && !SAFE(value)) throw new Unsupported(`${keyword} with ${INEXACT}`);
  return value < bound ? -1 : value > bound ? 1 : 0;
}

/** Whether two values are the same JSON value. A `bigint` and a number are the same when they are the same integer. */
function same(a: unknown, b: unknown, keyword = "const"): boolean {
  if (a === b) return true;
  if (typeof a === "bigint" && typeof b === "number") return Number.isFinite(b) && beside(a, b, keyword) === 0;
  if (typeof b === "bigint" && typeof a === "number") return Number.isFinite(a) && beside(b, a, keyword) === 0;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i], keyword));
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a as object), kb = Object.keys(b as object);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b as object, k) && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], keyword));
  }
  return false;
}

function satisfies(schema: unknown, value: unknown): boolean {
  const scratch: Issue[] = [];
  validate(schema, value, "", scratch);
  return scratch.length === 0;
}

const compiled = new Map<string, RegExp | null>();

/**
 * A schema's `pattern` as JSON Schema reads it: an ECMAScript regular expression with the `u`
 * flag. `null` when this engine rejects it, and for an inline-flag group (`(?i)`, `(?i:…)`,
 * `(?-i:…)`): ECMAScript had none until recently and engines differ on whether they read one, so
 * the writer does not answer differently on different runtimes. A `null` here is "cannot
 * evaluate", reported by `schemaSubsetGap`; the engine's message, which quotes the pattern, goes
 * nowhere.
 */
function regex(pattern: string): RegExp | null {
  const cached = compiled.get(pattern);
  if (cached !== undefined) return cached;
  let r: RegExp | null;
  try { r = hasInlineFlags(pattern) ? null : new RegExp(pattern, "u"); } catch { r = null; }
  compiled.set(pattern, r);
  return r;
}

/** Whether a group outside a character class opens with `(?` and a flag letter or `-`. */
function hasInlineFlags(pattern: string): boolean {
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "\\") { i += 1; continue; }
    if (inClass) { if (c === "]") inClass = false; continue; }
    if (c === "[") { inClass = true; continue; }
    if (c === "(" && pattern[i + 1] === "?" && /[A-Za-z-]/.test(pattern[i + 2] ?? "")) return true;
  }
  return false;
}

function validate(schema: unknown, value: unknown, path: string, errors: Issue[]): void {
  const fail = (message: string, where = path): void => { errors.push({ at: at(where), message: `${at(path)} ${message}` }); };
  if (schema === true || schema === undefined) return;
  if (schema === false) { fail(`is not allowed here`); return; }
  if (typeof schema !== "object" || Array.isArray(schema)) throw new Unsupported("a schema that is not an object or a boolean");
  const s = schema as Record<string, unknown>;
  for (const k of Object.keys(s)) if (!SUPPORTED.has(k)) throw new Unsupported(k);

  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
    if (!types.some((t) => isType(value, t))) fail(`is ${kindOf(value)}, not ${types.join(" or ")}`);
  }
  if (s.const !== undefined && !same(value, s.const)) fail(`must be ${exactJson(s.const)}`);
  if (s.enum !== undefined) {
    const options = s.enum as unknown[];
    if (!options.some((o) => same(value, o, "enum"))) fail(`must be one of ${exactJson(options)}`);
  }
  if (s.not !== undefined && satisfies(s.not, value)) fail(`must not match the excluded shape`);
  if (s.allOf !== undefined) for (const sub of s.allOf as unknown[]) validate(sub, value, path, errors);
  if (s.anyOf !== undefined && !(s.anyOf as unknown[]).some((sub) => satisfies(sub, value))) fail(`matches none of the allowed shapes`);
  if (s.oneOf !== undefined && (s.oneOf as unknown[]).filter((sub) => satisfies(sub, value)).length !== 1) fail(`must match exactly one of the allowed shapes`);
  if (s.if !== undefined) {
    const branch = satisfies(s.if, value) ? s.then : s.else;
    if (branch !== undefined) validate(branch, value, path, errors);
  }

  if (typeof value === "string") {
    if (typeof s.minLength === "number" && [...value].length < s.minLength) fail(`is shorter than ${s.minLength}`);
    if (typeof s.maxLength === "number" && [...value].length > s.maxLength) fail(`is longer than ${s.maxLength}`);
    if (typeof s.pattern === "string") {
      const re = regex(s.pattern);
      if (re === null) throw new Unsupported(PATTERN_GAP);
      if (!re.test(value)) fail(`does not match ${s.pattern}`);
    }
    if (typeof s.format === "string") {
      const f = FORMATS[s.format];
      if (f === undefined) throw new Unsupported(`format ${s.format}`);
      if (!f.test(value)) fail(`is not a ${s.format}`);
    }
  }

  if (typeof value === "number") {
    if (typeof s.minimum === "number" && value < s.minimum) fail(`is below ${s.minimum}`);
    if (typeof s.maximum === "number" && value > s.maximum) fail(`is above ${s.maximum}`);
    if (typeof s.exclusiveMinimum === "number" && value <= s.exclusiveMinimum) fail(`is not above ${s.exclusiveMinimum}`);
    if (typeof s.exclusiveMaximum === "number" && value >= s.exclusiveMaximum) fail(`is not below ${s.exclusiveMaximum}`);
  }

  if (typeof value === "bigint") {
    if (typeof s.minimum === "number" && beside(value, s.minimum, "minimum") < 0) fail(`is below ${s.minimum}`);
    if (typeof s.maximum === "number" && beside(value, s.maximum, "maximum") > 0) fail(`is above ${s.maximum}`);
    if (typeof s.exclusiveMinimum === "number" && beside(value, s.exclusiveMinimum, "exclusiveMinimum") <= 0) fail(`is not above ${s.exclusiveMinimum}`);
    if (typeof s.exclusiveMaximum === "number" && beside(value, s.exclusiveMaximum, "exclusiveMaximum") >= 0) fail(`is not below ${s.exclusiveMaximum}`);
  }

  if (Array.isArray(value)) {
    if (typeof s.minItems === "number" && value.length < s.minItems) fail(`has fewer than ${s.minItems} items`);
    if (typeof s.maxItems === "number" && value.length > s.maxItems) fail(`has more than ${s.maxItems} items`);
    if (s.items !== undefined) {
      if (Array.isArray(s.items)) throw new Unsupported("items as a tuple");
      value.forEach((item, i) => validate(s.items, item, `${path}/${i}`, errors));
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (Array.isArray(s.required)) for (const k of s.required as string[]) if (!Object.hasOwn(obj, k)) fail(`is missing ${k}`, `${path}/${token(k)}`);
    if (typeof s.minProperties === "number" && keys.length < s.minProperties) fail(`has fewer than ${s.minProperties} properties`);
    if (typeof s.maxProperties === "number" && keys.length > s.maxProperties) fail(`has more than ${s.maxProperties} properties`);
    const properties = (s.properties ?? {}) as Record<string, unknown>;
    for (const k of keys) {
      if (Object.hasOwn(properties, k)) { validate(properties[k], obj[k], `${path}/${token(k)}`, errors); continue; }
      if (s.additionalProperties === false) fail(`must not carry ${k}`, `${path}/${token(k)}`);
      else if (s.additionalProperties !== undefined && s.additionalProperties !== true) validate(s.additionalProperties, obj[k], `${path}/${token(k)}`, errors);
    }
  }
}
