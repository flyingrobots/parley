// Validation, under spec §4.5 and §4.6. Three rules do all the work here:
//
//   1. Full validation is against the schema for the **exact** advertised `(id, version)` pair.
//      Another version's schema, even the latest of the same major, is not validation.
//   2. With no schema for the exact pair, a reader MAY check the version-independent core — the
//      §1.3 envelope and the shape of `_schema` — and MUST report that as *partial*.
//   3. A line whose `_schema.id` is not ours at all, such as a tool's own result type, is parsed
//      and passed through, and the reader says it did not validate it.
//
// `_schema.id` and `_schema.version` are identifiers, not fetch instructions: the pair resolves
// against the schemas this package ships (`src/schemas.ts`, pinned by commit and digest) and
// nothing is fetched.
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { holdsExact } from "./exact.ts";
import { SCHEMAS } from "./schemas.ts";

export interface SchemaRef { readonly id: string; readonly version: string }

/** The fields §1.3 puts on every line. */
export const ENVELOPE = ["event", "t", "seq", "run", "_schema"] as const;
/** A `_schema.id` outside this prefix belongs to a tool, not to the protocol (§4.6). */
export const PROTOCOL_PREFIX = "parley.";

export type Validation =
  /** Validated against the schema for this exact pair. */
  | { readonly state: "validated"; readonly schema: SchemaRef }
  /** The exact pair's schema rejected the line. */
  | { readonly state: "invalid"; readonly schema: SchemaRef; readonly errors: readonly string[] }
  /**
   * The core was checked and the contract was not (§4.5). Without `why`: a `parley.*` pair this
   * reader ships no schema for. With `why: "number_undecided"`: the schema is shipped, the record
   * holds an integer beyond what a double holds, and the schema constrains numbers in a way the
   * reader cannot decide exactly for that integer (flyingrobots/parley#159).
   */
  | { readonly state: "partial"; readonly schema: SchemaRef; readonly missing: readonly string[]; readonly why?: "number_undecided" }
  /** Not validated at all: a tool's own type, or a line that advertises no pair. */
  | { readonly state: "unvalidated"; readonly schema: SchemaRef | null; readonly why: "tool_owned" | "no_schema_ref" };

export interface Validator {
  /** True when this reader ships the schema for exactly this pair. */
  has(id: string, version: string): boolean;
  validate(record: Record<string, unknown>): Validation;
}

function describe(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim());
}

/** The §1.3 envelope fields a line is missing or has malformed; `[]` when the core is sound. */
export function envelopeGaps(record: Record<string, unknown>): string[] {
  const missing: string[] = [];
  for (const key of ENVELOPE) if (!(key in record)) missing.push(key);
  // An integer beyond a double (a `bigint`, flyingrobots/parley#159) is still a non-negative integer.
  const count = (v: unknown) => (typeof v === "bigint" ? v >= 0n : Number.isInteger(v) && (v as number) >= 0);
  if ("t" in record && !count(record.t)) missing.push("t");
  if ("seq" in record && !count(record.seq)) missing.push("seq");
  if ("run" in record && !(typeof record.run === "string" && record.run.length > 0)) missing.push("run");
  if ("event" in record && typeof record.event !== "string") missing.push("event");
  const stamp = record._schema as Record<string, unknown> | undefined;
  if (stamp !== undefined && !(typeof stamp.id === "string" && typeof stamp.version === "string")) missing.push("_schema");
  return [...new Set(missing)];
}

/** Read a line's advertised pair, or null when it advertises none. */
export function schemaRef(record: Record<string, unknown>): SchemaRef | null {
  const stamp = record._schema as { id?: unknown; version?: unknown } | undefined;
  if (!stamp || typeof stamp.id !== "string" || typeof stamp.version !== "string") return null;
  if (!stamp.id || !stamp.version) return null;
  return { id: stamp.id, version: stamp.version };
}

// ---- an integer beyond a double, against a schema -------------------------------------------
//
// The validator underneath holds every number as a double, so a `bigint` is handed to it as the
// nearest double: an integer, on the same side of every bound as the `bigint` except a bound it
// lands on exactly. So the verdict on the stand-in is the verdict on the integer unless the
// schema holds that very double as a bound or a constant, or uses a keyword that depends on more
// than which side of a constant the number is on. Those cases are not decided: the record is
// `partial`, never `validated` on a rounded value.

/** The numeric formats `ajv-formats` checks a number's range by. */
const NUMBER_FORMATS: ReadonlySet<string> = new Set(["int32", "int64", "float", "double"]);
const BOUNDS: ReadonlySet<string> = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]);

interface Hazards {
  /** Every number the schema bounds or matches a value against. */
  readonly constants: ReadonlySet<number>;
  /** The schema uses a keyword no stand-in decides: `multipleOf`, `uniqueItems`, a numeric `format`, a `$ref` outside itself. */
  readonly undecidable: boolean;
}

function numbersIn(value: unknown, into: Set<number>): void {
  if (typeof value === "number") into.add(value);
  else if (Array.isArray(value)) for (const v of value) numbersIn(v, into);
  else if (value !== null && typeof value === "object") for (const v of Object.values(value)) numbersIn(v, into);
}

/** What in a schema document could make a stand-in's verdict differ from the integer's. Over-collects, never under. */
function hazardsOf(schema: unknown): Hazards {
  const constants = new Set<number>();
  let undecidable = false;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { for (const n of node) walk(n); return; }
    if (node === null || typeof node !== "object") return;
    for (const [key, v] of Object.entries(node)) {
      if (BOUNDS.has(key) && typeof v === "number") constants.add(v);
      else if (key === "const" || key === "enum") numbersIn(v, constants);
      else if (key === "multipleOf" && typeof v === "number") undecidable = true;
      else if (key === "uniqueItems" && v === true) undecidable = true;
      else if (key === "format" && typeof v === "string" && NUMBER_FORMATS.has(v)) undecidable = true;
      else if ((key === "$ref" || key === "$dynamicRef") && typeof v === "string" && !v.startsWith("#")) undecidable = true;
      walk(v);
    }
  };
  walk(schema);
  return { constants, undecidable };
}

/** A copy of a value with each `bigint` replaced by the nearest finite double, and those doubles collected. */
function standIn(value: unknown, used: Set<number>): unknown {
  if (typeof value === "bigint") {
    const nearest = Number(value);
    const double = Number.isFinite(nearest) ? nearest : nearest > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
    used.add(double);
    return double;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => standIn(v, used));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, standIn(v, used)]));
}

/**
 * A validator over the schemas this package ships. Compilation is lazy and cached, so a load of a
 * thousand receipts compiles each schema once.
 */
export function validator(schemas: ReadonlyArray<{ id: string; version: string; schema: Record<string, unknown> }> = SCHEMAS): Validator {
  const byPair = new Map<string, Record<string, unknown>>();
  for (const s of schemas) byPair.set(`${s.id}@${s.version}`, s.schema);
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const compiled = new Map<string, ValidateFunction>();

  const compile = (pair: string): ValidateFunction => {
    let fn = compiled.get(pair);
    if (!fn) { fn = ajv.compile(byPair.get(pair)!); compiled.set(pair, fn); }
    return fn;
  };
  const hazards = new Map<string, Hazards>();
  const hazardsFor = (pair: string): Hazards => {
    let found = hazards.get(pair);
    if (!found) { found = hazardsOf(byPair.get(pair)); hazards.set(pair, found); }
    return found;
  };

  return {
    has: (id, version) => byPair.has(`${id}@${version}`),
    validate(record) {
      const schema = schemaRef(record);
      if (!schema) return { state: "unvalidated", schema: null, why: "no_schema_ref" };
      if (!schema.id.startsWith(PROTOCOL_PREFIX)) return { state: "unvalidated", schema, why: "tool_owned" };
      const pair = `${schema.id}@${schema.version}`;
      if (!byPair.has(pair)) return { state: "partial", schema, missing: envelopeGaps(record) };
      const fn = compile(pair);
      if (holdsExact(record)) {
        const used = new Set<number>();
        const stood = standIn(record, used);
        const { constants, undecidable } = hazardsFor(pair);
        if (undecidable || [...used].some((n) => constants.has(n))) {
          return { state: "partial", schema, missing: envelopeGaps(record), why: "number_undecided" };
        }
        return fn(stood) ? { state: "validated", schema } : { state: "invalid", schema, errors: describe(fn.errors) };
      }
      return fn(record) ? { state: "validated", schema } : { state: "invalid", schema, errors: describe(fn.errors) };
    },
  };
}
