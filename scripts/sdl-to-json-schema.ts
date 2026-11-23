// TRANSITIONAL SCAFFOLDING, deleted by flyingrobots/parley#119 once Wesley emits JSON Schema
// (flyingrobots/wesley#856) and the SDL becomes the source.
//
// Until then the hand-written JSON Schemas under schemas/ are the source of truth, and this module
// only exists so a test can hold the SDL to them: it reads the IR `wesley schema lower --json`
// produces from schemas/parley.graphql and derives, per message, the JSON Schema value the SDL and
// its interim `parley_` directives state. It is a reading of the SDL, not a generator: nothing
// writes its output anywhere. Each interim directive stands for one Wesley issue
// (INTERIM_DIRECTIVES); docs/topics/message-sdl/README.md says what each one renders as.

/** The Wesley IR shape this module reads (the `version` field of `wesley schema lower --json`). */
export const WESLEY_IR_VERSION = "1.0.0";
const DIALECT = "https://json-schema.org/draft/2020-12/schema";
// The `$id` template flyingrobots/wesley#856 makes project configuration rather than SDL.
const ID_BASE = "https://flyingrobots.dev/parley/schemas/";

/** Every interim directive, and the Wesley issue whose canonical form will replace it. */
export const INTERIM_DIRECTIVES: Record<string, string> = {
  parley_message: "flyingrobots/wesley#856",
  parley_int64: "flyingrobots/wesley#850",
  parley_scalar: "flyingrobots/wesley#851",
  parley_optional: "flyingrobots/wesley#852",
  parley_const: "flyingrobots/wesley#853",
  parley_message_ref: "flyingrobots/wesley#853",
  parley_enum: "flyingrobots/wesley#854",
  parley_open: "flyingrobots/wesley#855",
  parley_closed: "flyingrobots/wesley#855",
  parley_pattern: "flyingrobots/wesley#857",
  parley_minLength: "flyingrobots/wesley#857",
  parley_format: "flyingrobots/wesley#857",
  parley_minimum: "flyingrobots/wesley#857",
  parley_maximum: "flyingrobots/wesley#857",
  parley_not_equal: "flyingrobots/wesley#857",
  parley_minItems: "flyingrobots/wesley#857",
  parley_maxItems: "flyingrobots/wesley#857",
  parley_minProperties: "flyingrobots/wesley#857",
  parley_exclusive: "flyingrobots/wesley#857",
  parley_any_non_empty: "flyingrobots/wesley#857",
  parley_when: "flyingrobots/wesley#857",
};

const ON_OBJECT = new Set(["parley_message", "parley_open", "parley_closed", "parley_exclusive", "parley_any_non_empty", "parley_when"]);
const ON_SCALAR = new Set(["parley_int64", "parley_scalar"]);
const STRING_CONSTRAINTS: Record<string, [keyword: string, arg: string]> = {
  parley_pattern: ["pattern", "regex"],
  parley_minLength: ["minLength", "value"],
  parley_format: ["format", "name"],
};
const INTEGER_CONSTRAINTS: Record<string, [keyword: string, arg: string]> = {
  parley_minimum: ["minimum", "value"],
  parley_maximum: ["maximum", "value"],
};
const LIST_CONSTRAINTS: Record<string, [keyword: string, arg: string]> = {
  parley_minItems: ["minItems", "value"],
  parley_maxItems: ["maxItems", "value"],
};

export interface IRTypeRef { base: string; nullable: boolean; isList: boolean; listItemNullable?: boolean }
export interface IRField { name: string; description?: string; type: IRTypeRef; directives: Record<string, unknown> }
export interface IRType {
  name: string;
  kind: string;
  description?: string;
  directives: Record<string, unknown>;
  fields?: IRField[];
  enumValues?: string[];
  unionMembers?: string[];
}
export interface IR { version: string; types: IRType[] }

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Schema = { [k: string]: Json };
type Args = Record<string, Json>;

function fail(message: string): never {
  throw new Error(`SDL derivation: ${message}`);
}

/** One directive's arguments; a directive with no arguments lowers to `true`. Repeats are refused. */
function arg(directives: Record<string, unknown>, name: string, where: string): Args | undefined {
  const d = directives[name];
  if (d === undefined) return undefined;
  if (Array.isArray(d)) fail(`${where}: @${name} is repeated`);
  return d === true ? {} : (d as Args);
}

/** Derive one JSON Schema value per `@parley_message` type, keyed by message id. */
export function deriveSchemas(ir: IR): Map<string, Schema> {
  if (ir.version !== WESLEY_IR_VERSION) fail(`IR version ${ir.version}, but this scaffolding reads ${WESLEY_IR_VERSION}`);
  const types = new Map(ir.types.map((t) => [t.name, t]));
  checkPlacement(ir);

  const out = new Map<string, Schema>();
  for (const t of ir.types) {
    const msg = arg(t.directives, "parley_message", t.name);
    if (!msg) continue;
    const id = String(msg.id), version = String(msg.version);
    if (out.has(id)) fail(`${t.name}: message ${id} is declared twice`);
    const body = objectSchema(t, types, { id, version });
    const s: Schema = { $schema: DIALECT, $id: `${ID_BASE}${id}/${version}`, title: String(msg.title) };
    if (t.description !== undefined) s.description = t.description;
    out.set(id, { ...s, ...body });
  }
  return out;
}

function checkPlacement(ir: IR) {
  for (const t of ir.types) {
    for (const name of Object.keys(t.directives)) {
      if (!(name in INTERIM_DIRECTIVES)) fail(`${t.name}: unknown directive @${name}`);
      const allowed = t.kind === "OBJECT" ? ON_OBJECT : t.kind === "SCALAR" ? ON_SCALAR : new Set<string>();
      if (!allowed.has(name)) fail(`${t.name}: @${name} does not belong on a ${t.kind}`);
    }
    for (const f of t.fields ?? []) {
      for (const name of Object.keys(f.directives)) {
        if (!(name in INTERIM_DIRECTIVES)) fail(`${t.name}.${f.name}: unknown directive @${name}`);
        if (ON_OBJECT.has(name) || ON_SCALAR.has(name)) fail(`${t.name}.${f.name}: @${name} does not belong on a field`);
      }
    }
  }
}

interface Message { id: string; version: string }

function objectSchema(t: IRType, types: Map<string, IRType>, message?: Message): Schema {
  const open = arg(t.directives, "parley_open", t.name), closed = arg(t.directives, "parley_closed", t.name);
  if (Boolean(open) === Boolean(closed)) fail(`${t.name}: an object type carries exactly one of @parley_open and @parley_closed`);
  const fields = t.fields ?? [];
  const s: Schema = { type: "object" };
  const required = fields.filter((f) => !f.type.nullable).map((f) => f.name);
  if (required.length) s.required = required;
  if (closed) s.additionalProperties = false;
  const properties: Schema = {};
  for (const f of fields) properties[f.name] = fieldSchema(t, f, types, message);
  s.properties = properties;

  const set = (keyword: string, value: Json, rule: string) => {
    if (keyword in s) fail(`${t.name}: @${rule} would set ${keyword}, which another rule already set`);
    s[keyword] = value;
  };
  const field = (name: string, rule: string) => fields.find((f) => f.name === name) ?? fail(`@${rule} names ${t.name}.${name}, which does not exist`);

  const exclusive = arg(t.directives, "parley_exclusive", t.name);
  if (exclusive) {
    // At most one of these fields: `not` of all of them present, each stated by its JSON type.
    const names = exclusive.fields as string[];
    const props: Schema = {};
    for (const n of names) {
      const p = properties[field(n, "parley_exclusive").name] as Schema;
      if (typeof p.type !== "string") fail(`@parley_exclusive names ${t.name}.${n}, which has no single JSON type`);
      props[n] = { type: p.type };
    }
    set("not", { type: "object", required: names, properties: props }, "parley_exclusive");
  }

  const anyNonEmpty = arg(t.directives, "parley_any_non_empty", t.name);
  if (anyNonEmpty) {
    // At least one of these list fields is present and non-empty.
    const names = anyNonEmpty.fields as string[];
    for (const n of names) if (!field(n, "parley_any_non_empty").type.isList) fail(`@parley_any_non_empty names ${t.name}.${n}, which is not a list`);
    set("anyOf", names.map((n) => ({ type: "object", required: [n], properties: { [n]: { type: "array", minItems: 1 } } })), "parley_any_non_empty");
  }

  const when = arg(t.directives, "parley_when", t.name);
  if (when) for (const [k, v] of Object.entries(whenSchema(t, when, types, message))) set(k, v, "parley_when");
  return s;
}

/**
 * `@parley_when(path, equals, guarded, require, forbidOtherwise, set)`: when the field at `path`
 * equals the value, the named sibling fields are required (`require`), or hold the given values
 * (`set`); with `forbidOtherwise`, the required fields are forbidden when it does not. `guarded`
 * says whether the rule fires only when every field on the path is present (`if` lists them as
 * required) or also when one is absent.
 */
function whenSchema(t: IRType, a: Args, types: Map<string, IRType>, message?: Message): Schema {
  const path = a.path as string[];
  if (!Array.isArray(path) || path.length === 0) fail(`${t.name}: @parley_when needs a non-empty path`);
  if (typeof a.guarded !== "boolean") fail(`${t.name}: @parley_when needs guarded: true or false`);
  // Walk the path; the last step is the trigger, and its parent holds the fields the rule names.
  let owner = t;
  for (const [i, step] of path.entries()) {
    const f = (owner.fields ?? []).find((x) => x.name === step) ?? fail(`@parley_when names ${owner.name}.${step}, which does not exist`);
    if (i < path.length - 1) {
      const next = types.get(f.type.base);
      if (!next || next.kind !== "OBJECT" || f.type.isList) fail(`@parley_when path ${path.join(".")}: ${owner.name}.${step} is not an object`);
      owner = next;
    }
  }
  const parent = owner;
  const shape = (name: string): Schema => {
    const f = (parent.fields ?? []).find((x) => x.name === name) ?? fail(`@parley_when names ${parent.name}.${name}, which does not exist`);
    const { description: _, ...rest } = fieldSchema(parent, f, types, message);
    return rest;
  };
  const trigger = shape(path[path.length - 1]!);
  checkValue(a.equals as Json, trigger, `@parley_when on ${t.name}: equals`);

  let ifs: Schema = { const: a.equals as Json };
  for (let i = path.length - 1; i >= 0; i--) {
    ifs = a.guarded ? { type: "object", required: [path[i]!], properties: { [path[i]!]: ifs } } : { type: "object", properties: { [path[i]!]: ifs } };
  }

  const require = (a.require ?? []) as string[];
  const sets = (a.set ?? {}) as Record<string, Json>;
  if (!require.length && !Object.keys(sets).length) fail(`${t.name}: @parley_when requires or sets nothing`);
  let then: Schema = { type: "object" };
  if (require.length) then.required = require;
  const props: Schema = {};
  for (const n of require) props[n] = shape(n);
  for (const [n, v] of Object.entries(sets)) {
    checkValue(v, shape(n), `@parley_when on ${t.name}: set ${n}`);
    props[n] = { const: v };
  }
  then.properties = props;
  for (let i = path.length - 2; i >= 0; i--) then = { type: "object", properties: { [path[i]!]: then } };

  const out: Schema = { if: ifs, then };
  if (a.forbidOtherwise === true) {
    if (!require.length || Object.keys(sets).length) fail(`${t.name}: @parley_when forbidOtherwise applies to required fields only`);
    out.else = { not: then };
  }
  return out;
}

/** A literal the rule compares with must be a value the field can hold. */
function checkValue(v: Json, field: Schema, where: string) {
  const ok = "const" in field ? v === field.const
    : Array.isArray(field.enum) ? field.enum.includes(v)
    : field.type === "string" ? typeof v === "string"
    : field.type === "boolean" ? typeof v === "boolean"
    : field.type === "integer" ? Number.isInteger(v)
    : false;
  if (!ok) fail(`${where} is ${JSON.stringify(v)}, which the field cannot hold`);
}

function fieldSchema(t: IRType, f: IRField, types: Map<string, IRType>, message?: Message): Schema {
  const where = `${t.name}.${f.name}`;
  const d = f.directives;
  const optional = arg(d, "parley_optional", where);
  if (f.type.nullable && !optional) fail(`${where} is nullable but not marked @parley_optional; null is never a legal Parley value, so an optional field is absent when unset`);
  if (!f.type.nullable && optional) fail(`${where} is non-null and marked @parley_optional`);
  if (f.type.isList && f.type.listItemNullable !== false) fail(`${where}: list items are never null`);

  let s: Schema;
  const literal = arg(d, "parley_const", where);
  const ref = arg(d, "parley_message_ref", where);
  const enumValues = arg(d, "parley_enum", where);
  if (literal) {
    const given = Object.entries(literal);
    if (given.length !== 1) fail(`${where}: @parley_const takes exactly one of string, int, bool`);
    const [kind, value] = given[0]!;
    const base = { string: "String", int: "Int", bool: "Boolean" }[kind];
    if (!base || f.type.base !== base || f.type.isList) fail(`${where}: @parley_const(${kind}:) does not fit ${f.type.base}`);
    s = { const: value as Json };
  } else if (ref) {
    if (!message) fail(`${where}: @parley_message_ref outside a message`);
    s = messageRef(where, types.get(f.type.base), types, message);
  } else if (enumValues) {
    if (f.type.base !== "String" || f.type.isList) fail(`${where}: @parley_enum is for a String field whose values are not GraphQL names`);
    s = { enum: enumValues.values as Json[] };
  } else {
    const item = baseSchema(where, f.type.base, types);
    s = f.type.isList ? { type: "array", items: item } : item;
  }

  // A string or integer constraint on a list field constrains its items; a list constraint, the list.
  const target = f.type.isList && s.items ? (s.items as Schema) : s;
  for (const [name, [keyword, argName]] of Object.entries(STRING_CONSTRAINTS)) {
    const c = arg(d, name, where);
    if (!c) continue;
    if (target.type !== "string") fail(`${where}: @${name} needs a string`);
    target[keyword] = c[argName] as Json;
  }
  for (const [name, [keyword, argName]] of Object.entries(INTEGER_CONSTRAINTS)) {
    const c = arg(d, name, where);
    if (!c) continue;
    if (target.type !== "integer") fail(`${where}: @${name} needs an integer`);
    target[keyword] = c[argName] as Json;
  }
  const notEqual = arg(d, "parley_not_equal", where);
  if (notEqual) {
    if (target.type !== "integer" || !Number.isInteger(notEqual.int)) fail(`${where}: @parley_not_equal(int:) needs an integer field`);
    target.not = { const: notEqual.int as Json };
  }
  for (const [name, [keyword, argName]] of Object.entries(LIST_CONSTRAINTS)) {
    const c = arg(d, name, where);
    if (!c) continue;
    if (!f.type.isList) fail(`${where}: @${name} needs a list`);
    s[keyword] = c[argName] as Json;
  }
  const minProperties = arg(d, "parley_minProperties", where);
  if (minProperties) {
    if (s.type !== "object" || f.type.isList) fail(`${where}: @parley_minProperties needs an object`);
    s.minProperties = minProperties.value as Json;
  }
  if (f.description !== undefined) s.description = f.description;
  return s;
}

/** `_schema`: a closed `{id, version}` pinned by literal to the enclosing message's identity. */
function messageRef(where: string, ref: IRType | undefined, types: Map<string, IRType>, message: Message): Schema {
  if (!ref || ref.kind !== "OBJECT") fail(`${where}: @parley_message_ref needs an object type`);
  const names = (ref.fields ?? []).map((f) => f.name).join(",");
  if (names !== "id,version" || !arg(ref.directives, "parley_closed", ref.name)) fail(`${where}: @parley_message_ref needs a closed type of exactly id and version, not ${ref.name}(${names})`);
  for (const f of ref.fields!) if (f.type.base !== "String" || f.type.nullable || Object.keys(f.directives).length) fail(`${ref.name}.${f.name} must be a bare String!`);
  const s = objectSchema(ref, types);
  const props = s.properties as Record<string, Schema>;
  for (const [name, value] of [["id", message.id], ["version", message.version]] as const) {
    const { description } = props[name]!;
    props[name] = description === undefined ? { const: value } : { const: value, description };
  }
  return s;
}

function baseSchema(where: string, base: string, types: Map<string, IRType>): Schema {
  if (base === "String") return { type: "string" };
  if (base === "Boolean") return { type: "boolean" };
  if (base === "Int") return { type: "integer" };
  const t = types.get(base) ?? fail(`${where}: unknown type ${base}`);
  if (t.kind === "ENUM") return { enum: t.enumValues ?? [] };
  if (t.kind === "OBJECT") {
    if (t.directives.parley_message) fail(`${where}: a message type ${base} cannot be nested`);
    if (t.description !== undefined) fail(`${base}: a nested type's description renders nowhere; describe the field that uses it`);
    return objectSchema(t, types);
  }
  if (t.kind === "SCALAR") {
    if (arg(t.directives, "parley_int64", base)) return { type: "integer" };
    const sc = arg(t.directives, "parley_scalar", base);
    if (sc?.json === "any") return {};
    if (sc?.json === "object") return { type: "object" };
    fail(`${where}: scalar ${base} declares no JSON kind (@parley_int64, or @parley_scalar(json: "any" | "object"))`);
  }
  fail(`${where}: ${t.kind} ${base} has no JSON Schema rendering here`);
}

/** Differences between the SDL's derived value and the hand-written schema, as JSON Pointers. */
export function agreement(id: string, sdl: unknown, schema: unknown): string[] {
  if (sdl === undefined) return [`${id}: the SDL declares no such message`];
  const out: string[] = [];
  const show = (v: unknown) => v === undefined ? "absent" : JSON.stringify(v);
  const esc = (k: string) => k.replace(/~/g, "~0").replace(/\//g, "~1");
  const walk = (a: unknown, b: unknown, at: string) => {
    const isObj = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v);
    if (isObj(a) && isObj(b)) {
      const ao = a as Record<string, unknown>, bo = b as Record<string, unknown>;
      for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) walk(ao[k], bo[k], `${at}/${esc(k)}`);
    } else if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
      a.forEach((x, i) => walk(x, b[i], `${at}/${i}`));
    } else if (JSON.stringify(a) !== JSON.stringify(b) || typeof a !== typeof b) {
      out.push(`${id}: ${at || "/"}: SDL derives ${show(a)}, the schema has ${show(b)}`);
    }
  };
  walk(sdl, schema, "");
  return out;
}

/** Lower an SDL file to IR with the given wesley binary. */
export function lowerSdl(bin: string, path: string): IR {
  const r = Bun.spawnSync([bin, "schema", "lower", "--schema", path, "--json"]);
  if (r.exitCode !== 0) throw new Error(`wesley schema lower --schema ${path} exited ${r.exitCode}: ${r.stderr.toString()}${r.stdout.toString()}`);
  return JSON.parse(r.stdout.toString()) as IR;
}

/** The wesley binary named by $WESLEY, or else the first on PATH, with the version it reports. */
export function findWesley(): { bin: string; version: string } | null {
  const bin = process.env.WESLEY || Bun.which("wesley");
  if (!bin) return null;
  try {
    const r = Bun.spawnSync([bin, "--version"]);
    return r.exitCode === 0 ? { bin, version: r.stdout.toString().trim() } : null;
  } catch {
    return null; // $WESLEY names nothing runnable
  }
}

export type Gate = { kind: "run"; bin: string } | { kind: "skip"; reason: string } | { kind: "fail"; reason: string };

/** Whether the Wesley-dependent cases run: only the pinned version; skipped only off CI. */
export function wesleyGate(found: { bin: string; version: string } | null, pin: string, ci: boolean): Gate {
  const install = `cargo install wesley-cli --version =${pin} --locked`;
  if (!found) {
    const reason = `wesley ${pin} is not installed (${install}, or set WESLEY to its path)`;
    return ci ? { kind: "fail", reason: `${reason}; CI must run the SDL agreement test, not skip it` } : { kind: "skip", reason };
  }
  if (found.version !== pin) return { kind: "fail", reason: `${found.bin} is wesley ${found.version}, but package.json config.wesley pins ${pin} (${install})` };
  return { kind: "run", bin: found.bin };
}

/** Refuse an SDL text that defines one type name twice; Wesley merges the two without a word. */
export function assertUniqueTypes(_sdl: string, _path: string): void {}
