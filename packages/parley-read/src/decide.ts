// Validating a record that holds an integer beyond the safe range (flyingrobots/parley#159,
// flyingrobots/parley#172).
//
// The schema validator this package uses checks `integer` and `number` by JavaScript type and
// holds every number as a double, so it cannot be handed a `bigint`, and handing it a rounded
// stand-in would validate a record other than the one read. This module decides such a record
// itself, soundly and no further than it can:
//
//   - **Any part of the record that holds no `bigint` goes to the schema validator**, with the
//     subschema that applies to it, unchanged. An ordinary `status: 256` or a wrong type beside an
//     unrelated `bigint` is found exactly as it always was.
//   - **Along the path to a `bigint`, the keywords below are evaluated here**, with the integer's
//     exact value. A comparison of a `bigint` with a schema's number is JavaScript's own, which is
//     mathematically exact.
//   - **Everything else is undecided**: a keyword this module does not implement, a `$ref`, a
//     numeric `format`, a schema constant that is itself an integer beyond the safe range (the
//     schema document was parsed into doubles, so that constant may not be the one written).
//
// The three verdicts combine as the keywords do. A schema object is a conjunction, so one
// conclusive failure makes it `invalid` whatever else is undecided, and it is `valid` only when
// every keyword in it was decided. `anyOf` is `invalid` only when every branch is; a failing
// branch beside an undecided one proves nothing. `not` turns `valid` into `invalid` and back and
// leaves undecided as it is. `if` takes the branch its condition's verdict selects, and with an
// undecided condition concludes only what both branches agree on.
import type { ValidateFunction } from "ajv/dist/2020.js";
import { exactText, holdsExact } from "@flyingrobots/parley-emit";

export type Verdict = "valid" | "invalid" | "undecided";

/** The keywords that say nothing about whether an instance is valid. `then`, `else`, `minContains` and `maxContains` are read by `if` and `contains`. */
const SILENT: ReadonlySet<string> = new Set([
  "$schema", "$id", "$comment", "$anchor", "$defs", "definitions", "title", "description", "default", "examples",
  "deprecated", "readOnly", "writeOnly", "then", "else", "minContains", "maxContains",
]);
/** Keywords about strings: a value that holds a `bigint` is a number, an array or an object, so they do not apply. */
const STRING_ONLY: ReadonlySet<string> = new Set(["minLength", "maxLength", "pattern", "contentEncoding", "contentMediaType", "contentSchema"]);
/** The formats `ajv-formats` checks a number against. */
const NUMBER_FORMATS: ReadonlySet<string> = new Set(["int32", "int64", "float", "double"]);

type Schema = Record<string, unknown>;
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const at = (path: string) => path || "/";

/** A schema's number, when it can be trusted as written: not an integer beyond the safe range, which a double may have rounded. */
function trusted(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && (!Number.isInteger(n) || Number.isSafeInteger(n));
}

/** Whether an instance value equals a schema constant; null when the constant cannot be trusted. */
function equals(value: unknown, constant: unknown): boolean | null {
  if (typeof value === "bigint") {
    if (typeof constant !== "number") return false;
    if (!trusted(constant)) return null;
    return Number.isInteger(constant) && value === BigInt(constant);
  }
  if (Array.isArray(value)) {
    if (!Array.isArray(constant) || constant.length !== value.length) return false;
    return every(value.map((v, i) => equals(v, constant[i])));
  }
  if (isObject(value)) {
    if (!isObject(constant)) return false;
    const keys = Object.keys(value);
    if (keys.length !== Object.keys(constant).length || !keys.every((k) => k in constant)) return false;
    return every(keys.map((k) => equals(value[k], constant[k])));
  }
  return value === constant;
}
function every(results: readonly (boolean | null)[]): boolean | null {
  if (results.includes(false)) return false;
  return results.includes(null) ? null : true;
}

/** A value as text that two values share exactly when they are equal as JSON values, whatever their key order. */
function canonical(v: unknown): string {
  if (typeof v === "number" && Number.isInteger(v) && !Number.isSafeInteger(v)) return BigInt(v).toString();
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return exactText(v);
}

const REFERENCES: ReadonlySet<string> = new Set(["$ref", "$dynamicRef", "$recursiveRef"]);
const referring = new WeakMap<object, boolean>();
/** Whether a schema holds a reference at any depth. */
function refers(schema: unknown): boolean {
  if (schema === null || typeof schema !== "object") return false;
  const known = referring.get(schema);
  if (known !== undefined) return known;
  const found = Array.isArray(schema)
    ? schema.some(refers)
    : Object.entries(schema).some(([k, v]) => (REFERENCES.has(k) && typeof v === "string") || refers(v));
  referring.set(schema, found);
  return found;
}

function typeOf(v: unknown): string[] {
  if (typeof v === "bigint") return ["integer", "number"];
  return [Array.isArray(v) ? "array" : "object"];
}

/**
 * A decider over one schema validator. `compile` compiles a subschema for the parts of a record
 * that hold no `bigint`; it may throw for a subschema that does not stand alone, which is undecided.
 */
export function decider(compile: (schema: object) => ValidateFunction): (schema: unknown, record: unknown) => { verdict: Verdict; errors: string[] } {
  const ordinary = (schema: unknown, instance: unknown, path: string, errors: string[]): Verdict => {
    if (schema === true) return "valid";
    if (schema === false) { errors.push(`${at(path)} must NOT be present: the schema is false`); return "invalid"; }
    if (!isObject(schema)) return "undecided";
    // A reference is written against the whole document. Compiled alone, a subschema would
    // resolve it against itself, so a subschema that holds one is not decided here.
    if (refers(schema)) return "undecided";
    let fn: ValidateFunction;
    try { fn = compile(schema); } catch { return "undecided"; }
    if (fn(instance)) return "valid";
    for (const e of fn.errors ?? []) errors.push(`${at(path + e.instancePath)} ${e.message ?? ""}`.trim());
    return "invalid";
  };

  const decide = (schema: unknown, instance: unknown, path: string, errors: string[]): Verdict => {
    if (!holdsExact(instance)) return ordinary(schema, instance, path, errors);
    if (schema === true) return "valid";
    if (schema === false) { errors.push(`${at(path)} must NOT be present: the schema is false`); return "invalid"; }
    if (!isObject(schema)) return "undecided";

    let verdict: Verdict = "valid";
    const note = (v: Verdict) => { if (v === "invalid") verdict = "invalid"; else if (v === "undecided" && verdict === "valid") verdict = "undecided"; };
    const fail = (message: string) => { errors.push(`${at(path)} ${message}`); verdict = "invalid"; };
    /** A subschema's verdict with its errors kept aside: the keyword that asked decides what they mean. */
    const quiet = (sub: unknown, value: unknown = instance) => decide(sub, value, path, []);
    const big = typeof instance === "bigint" ? instance : null;
    const array = Array.isArray(instance) ? (instance as unknown[]) : null;
    const object = isObject(instance) ? instance : null;
    const s = schema as Schema;

    for (const key of ["type", "required", ...Object.keys(s).filter((k) => k !== "type" && k !== "required")]) {
      if (!(key in s) || SILENT.has(key) || STRING_ONLY.has(key)) continue;
      const k = s[key];
      switch (key) {
        case "type": {
          const wanted = Array.isArray(k) ? k : [k];
          if (!wanted.every((t) => typeof t === "string")) note("undecided");
          else if (!typeOf(instance).some((t) => wanted.includes(t))) fail(`must be ${wanted.join(",")}`);
          break;
        }
        case "const": {
          const same = equals(instance, k);
          if (same === false) fail("must be equal to constant"); else if (same === null) note("undecided");
          break;
        }
        case "enum": {
          if (!Array.isArray(k)) { note("undecided"); break; }
          const same = k.map((c) => equals(instance, c));
          if (same.includes(true)) break;
          if (same.includes(null)) note("undecided"); else fail("must be equal to one of the allowed values");
          break;
        }
        case "minimum": case "maximum": case "exclusiveMinimum": case "exclusiveMaximum": {
          if (big === null) break;
          if (!trusted(k)) { note("undecided"); break; }
          const [holds, sign] = key === "minimum" ? [big >= k, ">="] : key === "maximum" ? [big <= k, "<="] : key === "exclusiveMinimum" ? [big > k, ">"] : [big < k, "<"];
          if (!holds) fail(`must be ${sign} ${k}`);
          break;
        }
        case "multipleOf": {
          if (big === null) break;
          if (typeof k !== "number" || !Number.isSafeInteger(k) || k <= 0) { note("undecided"); break; }
          if (big % BigInt(k) !== 0n) fail(`must be multiple of ${k}`);
          break;
        }
        case "format":
          if (big !== null && typeof k === "string" && NUMBER_FORMATS.has(k)) note("undecided");
          else if (typeof k !== "string") note("undecided");
          break;
        case "required":
          if (object === null) break;
          if (!Array.isArray(k)) { note("undecided"); break; }
          for (const name of k) if (typeof name === "string" && !(name in object)) fail(`must have required property '${name}'`);
          break;
        case "properties":
          if (object === null) break;
          if (!isObject(k)) { note("undecided"); break; }
          for (const name of Object.keys(k)) if (name in object) note(decide(k[name], object[name], `${path}/${name}`, errors));
          break;
        case "patternProperties":
          if (object === null) break;
          if (!isObject(k)) { note("undecided"); break; }
          for (const pattern of Object.keys(k)) {
            let re: RegExp;
            try { re = new RegExp(pattern, "u"); } catch { note("undecided"); continue; }
            for (const name of Object.keys(object)) if (re.test(name)) note(decide(k[pattern], object[name], `${path}/${name}`, errors));
          }
          break;
        case "additionalProperties": {
          if (object === null) break;
          const named = isObject(s.properties) ? Object.keys(s.properties) : [];
          let patterns: RegExp[];
          try { patterns = isObject(s.patternProperties) ? Object.keys(s.patternProperties).map((p) => new RegExp(p, "u")) : []; } catch { note("undecided"); break; }
          for (const name of Object.keys(object)) {
            if (named.includes(name) || patterns.some((re) => re.test(name))) continue;
            if (k === false) fail("must NOT have additional properties");
            else note(decide(k, object[name], `${path}/${name}`, errors));
          }
          break;
        }
        case "propertyNames":
          if (object !== null) for (const name of Object.keys(object)) note(ordinary(k, name, `${path}/${name}`, errors));
          break;
        case "minProperties": case "maxProperties": {
          if (object === null) break;
          if (typeof k !== "number") { note("undecided"); break; }
          const n = Object.keys(object).length;
          if (key === "minProperties" ? n < k : n > k) fail(`must NOT have ${key === "minProperties" ? "fewer" : "more"} than ${k} properties`);
          break;
        }
        case "dependentRequired":
          if (object === null) break;
          if (!isObject(k)) { note("undecided"); break; }
          for (const name of Object.keys(k)) {
            const needs = k[name];
            if (!(name in object)) continue;
            if (!Array.isArray(needs)) { note("undecided"); continue; }
            for (const need of needs) if (typeof need === "string" && !(need in object)) fail(`must have property '${need}' when property '${name}' is present`);
          }
          break;
        case "dependentSchemas":
          if (object === null) break;
          if (!isObject(k)) { note("undecided"); break; }
          for (const name of Object.keys(k)) if (name in object) note(decide(k[name], instance, path, errors));
          break;
        case "prefixItems":
          if (array === null) break;
          if (!Array.isArray(k)) { note("undecided"); break; }
          k.forEach((sub, i) => { if (i < array.length) note(decide(sub, array[i], `${path}/${i}`, errors)); });
          break;
        case "items": {
          if (array === null) break;
          if (Array.isArray(k)) { note("undecided"); break; } // the older tuple form
          const from = Array.isArray(s.prefixItems) ? s.prefixItems.length : 0;
          for (let i = from; i < array.length; i++) note(decide(k, array[i], `${path}/${i}`, errors));
          break;
        }
        case "minItems": case "maxItems":
          if (array === null) break;
          if (typeof k !== "number") { note("undecided"); break; }
          if (key === "minItems" ? array.length < k : array.length > k) fail(`must NOT have ${key === "minItems" ? "fewer" : "more"} than ${k} items`);
          break;
        case "uniqueItems":
          if (array === null || k === false) break;
          if (k !== true) { note("undecided"); break; }
          if (new Set(array.map(canonical)).size !== array.length) fail("must NOT have duplicate items");
          break;
        case "contains": {
          if (array === null) break;
          if ("minContains" in s || "maxContains" in s) { note("undecided"); break; }
          const found = array.map((v) => quiet(k, v));
          if (found.includes("valid")) break;
          if (found.includes("undecided")) note("undecided"); else fail("must contain at least 1 valid item(s)");
          break;
        }
        case "allOf":
          if (!Array.isArray(k)) { note("undecided"); break; }
          for (const sub of k) note(decide(sub, instance, path, errors));
          break;
        case "anyOf": {
          if (!Array.isArray(k)) { note("undecided"); break; }
          const branches = k.map((sub) => quiet(sub));
          if (branches.includes("valid")) break;
          // Every branch failed, or the record is invalid by none of them alone.
          if (branches.includes("undecided")) note("undecided"); else fail("must match a schema in anyOf");
          break;
        }
        case "oneOf": {
          if (!Array.isArray(k)) { note("undecided"); break; }
          const branches = k.map((sub) => quiet(sub));
          const valid = branches.filter((b) => b === "valid").length;
          const open = branches.includes("undecided");
          if (valid > 1 || (valid === 0 && !open)) fail("must match exactly one schema in oneOf");
          else if (open) note("undecided");
          break;
        }
        case "not": {
          const inner = quiet(k);
          if (inner === "valid") fail("must NOT be valid"); else if (inner === "undecided") note("undecided");
          break;
        }
        case "if": {
          const condition = quiet(k);
          const branch = (name: "then" | "else", into: string[]) => (name in s ? decide(s[name], instance, path, into) : "valid");
          if (condition === "valid") note(branch("then", errors));
          else if (condition === "invalid") note(branch("else", errors));
          else {
            // The condition is undecided, so only what both branches agree on is concluded.
            const then = branch("then", []), otherwise = branch("else", []);
            if (then === "invalid" && otherwise === "invalid") fail(`fails both "then" and "else"`);
            else if (then !== "valid" || otherwise !== "valid") note("undecided");
          }
          break;
        }
        default:
          // `$ref`, `unevaluatedProperties`, a vocabulary this module does not know: not decided.
          note("undecided");
      }
    }
    return verdict;
  };

  return (schema, record) => {
    const errors: string[] = [];
    const verdict = decide(schema, record, "", errors);
    return { verdict, errors: [...new Set(errors)] };
  };
}
