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

export type CheckResult =
  /** The record satisfies the schema. */
  | { readonly ok: true }
  /** The record does not satisfy it; `errors` names where, shortest path first. */
  | { readonly ok: false; readonly errors: readonly string[] }
  /** The schema uses a construct this checker does not implement, so nothing was established. */
  | { readonly ok: false; readonly errors: readonly string[]; readonly unsupported: string };

class Unsupported extends Error {
  constructor(readonly keyword: string) { super(`the schema uses ${keyword}, which this checker does not implement`); }
}

/**
 * Check `value` against `schema`. Returns `ok` when it satisfies it, an error list when it does
 * not, and an `unsupported` keyword when the schema is outside the subset — in which case the
 * result establishes nothing either way, and a caller that must not guess should refuse.
 */
export function checkRecord(value: unknown, schema: unknown): CheckResult {
  const errors: string[] = [];
  try { validate(schema, value, "", errors); }
  catch (e) {
    if (e instanceof Unsupported) return { ok: false, errors: [e.message], unsupported: e.keyword };
    throw e;
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function at(path: string): string { return path === "" ? "/" : path; }

function kindOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  return t === "number" ? (Number.isInteger(v as number) ? "integer" : "number") : t;
}

function isType(v: unknown, t: string): boolean {
  if (t === "number") return typeof v === "number" && Number.isFinite(v);
  if (t === "integer") return typeof v === "number" && Number.isInteger(v);
  return kindOf(v) === t;
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a as object), kb = Object.keys(b as object);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b as object, k) && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

function satisfies(schema: unknown, value: unknown): boolean {
  const scratch: string[] = [];
  validate(schema, value, "", scratch);
  return scratch.length === 0;
}

function regex(pattern: string): RegExp {
  try { return new RegExp(pattern, "u"); } catch { return new RegExp(pattern); }
}

function validate(schema: unknown, value: unknown, path: string, errors: string[]): void {
  if (schema === true || schema === undefined) return;
  if (schema === false) { errors.push(`${at(path)} is not allowed here`); return; }
  if (typeof schema !== "object" || Array.isArray(schema)) throw new Unsupported("a schema that is not an object or a boolean");
  const s = schema as Record<string, unknown>;
  for (const k of Object.keys(s)) if (!SUPPORTED.has(k)) throw new Unsupported(k);

  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
    if (!types.some((t) => isType(value, t))) errors.push(`${at(path)} is ${kindOf(value)}, not ${types.join(" or ")}`);
  }
  if (s.const !== undefined && !same(value, s.const)) errors.push(`${at(path)} must be ${JSON.stringify(s.const)}`);
  if (s.enum !== undefined) {
    const options = s.enum as unknown[];
    if (!options.some((o) => same(value, o))) errors.push(`${at(path)} must be one of ${JSON.stringify(options)}`);
  }
  if (s.not !== undefined && satisfies(s.not, value)) errors.push(`${at(path)} must not match the excluded shape`);
  if (s.allOf !== undefined) for (const sub of s.allOf as unknown[]) validate(sub, value, path, errors);
  if (s.anyOf !== undefined && !(s.anyOf as unknown[]).some((sub) => satisfies(sub, value))) errors.push(`${at(path)} matches none of the allowed shapes`);
  if (s.oneOf !== undefined && (s.oneOf as unknown[]).filter((sub) => satisfies(sub, value)).length !== 1) errors.push(`${at(path)} must match exactly one of the allowed shapes`);
  if (s.if !== undefined) {
    const branch = satisfies(s.if, value) ? s.then : s.else;
    if (branch !== undefined) validate(branch, value, path, errors);
  }

  if (typeof value === "string") {
    if (typeof s.minLength === "number" && [...value].length < s.minLength) errors.push(`${at(path)} is shorter than ${s.minLength}`);
    if (typeof s.maxLength === "number" && [...value].length > s.maxLength) errors.push(`${at(path)} is longer than ${s.maxLength}`);
    if (typeof s.pattern === "string" && !regex(s.pattern).test(value)) errors.push(`${at(path)} does not match ${s.pattern}`);
    if (typeof s.format === "string") {
      const f = FORMATS[s.format];
      if (f === undefined) throw new Unsupported(`format ${s.format}`);
      if (!f.test(value)) errors.push(`${at(path)} is not a ${s.format}`);
    }
  }

  if (typeof value === "number") {
    if (typeof s.minimum === "number" && value < s.minimum) errors.push(`${at(path)} is below ${s.minimum}`);
    if (typeof s.maximum === "number" && value > s.maximum) errors.push(`${at(path)} is above ${s.maximum}`);
    if (typeof s.exclusiveMinimum === "number" && value <= s.exclusiveMinimum) errors.push(`${at(path)} is not above ${s.exclusiveMinimum}`);
    if (typeof s.exclusiveMaximum === "number" && value >= s.exclusiveMaximum) errors.push(`${at(path)} is not below ${s.exclusiveMaximum}`);
  }

  if (Array.isArray(value)) {
    if (typeof s.minItems === "number" && value.length < s.minItems) errors.push(`${at(path)} has fewer than ${s.minItems} items`);
    if (typeof s.maxItems === "number" && value.length > s.maxItems) errors.push(`${at(path)} has more than ${s.maxItems} items`);
    if (s.items !== undefined) {
      if (Array.isArray(s.items)) throw new Unsupported("items as a tuple");
      value.forEach((item, i) => validate(s.items, item, `${path}/${i}`, errors));
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (Array.isArray(s.required)) for (const k of s.required as string[]) if (!Object.hasOwn(obj, k)) errors.push(`${at(path)} is missing ${k}`);
    if (typeof s.minProperties === "number" && keys.length < s.minProperties) errors.push(`${at(path)} has fewer than ${s.minProperties} properties`);
    if (typeof s.maxProperties === "number" && keys.length > s.maxProperties) errors.push(`${at(path)} has more than ${s.maxProperties} properties`);
    const properties = (s.properties ?? {}) as Record<string, unknown>;
    for (const k of keys) {
      if (Object.hasOwn(properties, k)) { validate(properties[k], obj[k], `${path}/${k}`, errors); continue; }
      if (s.additionalProperties === false) errors.push(`${at(path)} must not carry ${k}`);
      else if (s.additionalProperties !== undefined && s.additionalProperties !== true) validate(s.additionalProperties, obj[k], `${path}/${k}`, errors);
    }
  }
}
