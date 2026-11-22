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
  /** A `parley.*` pair this reader ships no schema for: the core was checked, the contract was not (§4.5). */
  | { readonly state: "partial"; readonly schema: SchemaRef; readonly missing: readonly string[] }
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
  if ("t" in record && !(Number.isInteger(record.t) && (record.t as number) >= 0)) missing.push("t");
  if ("seq" in record && !(Number.isInteger(record.seq) && (record.seq as number) >= 0)) missing.push("seq");
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

  return {
    has: (id, version) => byPair.has(`${id}@${version}`),
    validate(record) {
      const schema = schemaRef(record);
      if (!schema) return { state: "unvalidated", schema: null, why: "no_schema_ref" };
      if (!schema.id.startsWith(PROTOCOL_PREFIX)) return { state: "unvalidated", schema, why: "tool_owned" };
      const pair = `${schema.id}@${schema.version}`;
      if (!byPair.has(pair)) return { state: "partial", schema, missing: envelopeGaps(record) };
      const fn = compile(pair);
      return fn(record) ? { state: "validated", schema } : { state: "invalid", schema, errors: describe(fn.errors) };
    },
  };
}
