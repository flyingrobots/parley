# Message SDL

Parley's 17 message shapes are also stated in Wesley SDL, in
[`schemas/parley.graphql`](../../../schemas/parley.graphql). This page is the reference for that
file: what it is today, how it is organised, the interim directives it uses and the Wesley issue
that retires each one, and what the test that holds it to the schemas does and does not
establish. Its [test plan](test-plan.md) is the contract ledger.

## The SDL is not the source yet

**The hand-written JSON Schemas under `schemas/` are the source of truth.** The SDL is checked
against them and nothing is generated from it. No emitted line, schema byte or schema version
depends on it, and no reader or writer reads it.

The owner decided in flyingrobots/parley#116 that Wesley SDL becomes the single source of
Parley's message shapes, with JSON Schema compiled from it. That switch is
flyingrobots/parley#119. It waits for Wesley to have the constructs the interim directives below
stand in for, and for a JSON Schema emitter (flyingrobots/wesley#856). Until it lands, a change to
a message is made in both files ([Changing a message](../../workflows/change-a-message/README.md)).

## How the file is organised

It is one file because Wesley 0.3.0-alpha.4 keeps only the last of several `--schema` flags
(flyingrobots/wesley#846) and silently merges two definitions of one type name
(flyingrobots/wesley#845).

- **The interim directive declarations** come first, each with a comment naming its Wesley issue.
- **Three scalars**: `Int64` (POSIX milliseconds and byte counts, which pass GraphQL's 32-bit
  `Int`), `JSON` (any value: `measured`, `limit`) and `JSONObject` (a tool-shaped object:
  `resolved`, `detail`, `schema`).
- **Shared shapes**: `SchemaRef` (the `_schema` object, the one closed type) and
  `InputDescriptor` (shared by `parley.receipt.head` and `parley.receipt.inputs`).
- **One section per message**, holding its nested types. A message type carries
  `@parley_message(id:, version:, title:)`. Where two messages nest a shape with different
  descriptions (the asker, budget and window of `parley.query` and `parley.lens`), each has its
  own type, because a field's description belongs to the type that declares it.

These conventions are enforced by the derivation, which refuses SDL that breaks them:

- `!` means required. A field without it carries `@parley_optional`: absent when unset and never
  `null`, which no Parley schema admits.
- A string or integer constraint on a list field constrains its items. `@parley_minItems` and
  `@parley_maxItems` constrain the list.
- Every object type is `@parley_open` or `@parley_closed`. Only `SchemaRef` is closed (spec §4.5).
- A nested type has no description of its own, since the JSON Schema has nowhere to put one. The
  field that uses it carries the description.
- Fields follow the schema's property order, which is the order `required` lists them in.

## Interim directives

Each directive stands for a construct Wesley does not have yet. When the issue in the last column
ships, flyingrobots/parley#119 replaces the directive with Wesley's canonical form. The column
"Renders as" is what the agreement test derives from the directive.

| Directive | On | Renders as | Wesley issue |
| --- | --- | --- | --- |
| `@parley_message(id, version, title)` | object | a message document: `$schema` 2020-12, `$id` `https://flyingrobots.dev/parley/schemas/<id>/<version>`, `title`, the type's description, `type: object` | flyingrobots/wesley#856 |
| `@parley_int64` | scalar | `type: integer`; Rust needs 64 bits | flyingrobots/wesley#850 |
| `@parley_scalar(json)` | scalar | `"any"`: no keyword at all; `"object"`: `type: object` | flyingrobots/wesley#851 |
| `@parley_optional` | field | left out of `required`, and never `null` | flyingrobots/wesley#852 |
| `@parley_const(string \| int \| bool)` | field | `const`, with no `type` | flyingrobots/wesley#853 |
| `@parley_message_ref` | field | `_schema`: the closed `{id, version}` with `const` set to the message's own id and version | flyingrobots/wesley#853 |
| `@parley_enum(values)` | field | `enum` with values that are not GraphQL names (`what-ran`, `count-only`); legal names use a GraphQL `enum` | flyingrobots/wesley#854 |
| `@parley_open` | object | no `additionalProperties` | flyingrobots/wesley#855 |
| `@parley_closed` | object | `additionalProperties: false` | flyingrobots/wesley#855 |
| `@parley_pattern(regex)` | field | `pattern` | flyingrobots/wesley#857 |
| `@parley_minLength(value)` | field | `minLength` | flyingrobots/wesley#857 |
| `@parley_format(name)` | field | `format` | flyingrobots/wesley#857 |
| `@parley_minimum(value)` | field | `minimum` | flyingrobots/wesley#857 |
| `@parley_maximum(value)` | field | `maximum` | flyingrobots/wesley#857 |
| `@parley_not_equal(int)` | field | `not: {const}` | flyingrobots/wesley#857 |
| `@parley_minItems(value)` | field | `minItems` | flyingrobots/wesley#857 |
| `@parley_maxItems(value)` | field | `maxItems` | flyingrobots/wesley#857 |
| `@parley_minProperties(value)` | field | `minProperties` | flyingrobots/wesley#857 |
| `@parley_exclusive(fields)` | object | `not: {type: object, required: fields, properties: {f: {type}}}`: at most one of exactly two is present; the derivation refuses any other number of names, because `not` of all present lets two of three through | flyingrobots/wesley#857 |
| `@parley_any_non_empty(fields)` | object | `anyOf`, one branch per field requiring it as a non-empty array | flyingrobots/wesley#857 |
| `@parley_when(path, equals, guarded, require, forbidOtherwise, set)` | object | `if` the field at `path` is `const` `equals`, `then` the named sibling fields are required with their shape, or hold the `set` values; `else: {not: then}` with `forbidOtherwise`; `guarded` lists the path's fields as required in `if` | flyingrobots/wesley#857 |

The three cross-field rules are named rules, never raw JSON Schema fragments, as
flyingrobots/wesley#857 proposes. They cover every cross-field construct the 17 schemas use:

- `@parley_exclusive`: `parley.receipt.head` and `parley.receipt.inputs` `inputs[]` carry
  `sha256` or `error`, never both.
- `@parley_any_non_empty`: `parley.receipt.head` `redacted` names at least one non-empty list.
- `@parley_when`, three times:
  - `parley.page` requires `cursor` when `has_more` is `true`.
  - `parley.lens` `runs[]` has `reason` exactly when `outcome` is `undetermined`.
  - `parley.lens` forces `loss.excluded` and `loss.folded` to `0` when `loss.bound` is `none`.

`guarded` is the one argument that only shows in the rendering. In the hand-written schemas the
`if` of `parley.page` does not list `has_more` as required, while the `if` of `parley.lens` lists
`loss` and `loss.bound` though both are required. For a document that satisfies the rest of its
schema the two forms mean the same thing, but they are different JSON values. Rule (A) of
flyingrobots/parley#116 lets a released version stay current only when the generated file parses
to the same JSON value as its snapshot, so Wesley's renderer has to be able to produce both.

## What the agreement test establishes

`scripts/sdl-agreement.test.ts` lowers the SDL with the pinned Wesley
(`wesley schema lower --json`). `scripts/sdl-to-json-schema.ts` then derives each message's JSON
Schema value from the IR and the directives, and the test compares that value with the
top-level schema as parsed JSON, key by key. Descriptions, `$id`, `title`, the order of
`required` and the order of `enum` values are all compared. Key order is not, since the schemas'
key order varies node to node (flyingrobots/parley#116).

- **All 17 messages agree in full, with no exceptions.** No keyword needed an escape hatch.
- The comparison fails when either side changes alone, and the failure names the message and the
  JSON Pointer, for example
  `parley.end: /properties/run/minLength: SDL derives 2, the schema has 1`.
- It cannot see what the JSON Schema value does not carry: GraphQL type names, the choice of
  `Int64` over `Int` (both are `type: integer`), and the scalars' descriptions. Those are read by
  the Rust, TypeScript and Python emitters to come, not by this test.
- Wesley keeps no directive definitions in its IR (flyingrobots/wesley#772) and accepts
  undeclared directives without complaint. So the test reads the `directive @parley_*`
  declarations from the file's text. It holds them to the derivation's vocabulary
  (`INTERIM_DIRECTIVES`) and to the table above, and the derivation refuses any directive outside
  that vocabulary.
- Wesley also drops directives on `schema` / `extend schema` from the IR. So the `$id` template
  is a constant in the derivation, standing for the project configuration flyingrobots/wesley#856
  proposes.

The derivation is scaffolding. flyingrobots/parley#119 deletes it, together with the test, when
`wesley emit json-schema` generates the files and a freshness test takes over.

## The Wesley pin

Wesley is pinned exactly in one place: `config.wesley` in the root `package.json`, currently
`0.3.0-alpha.4`. The test runs only that version. Any other fails, naming both versions.

```text
cargo install wesley-cli --version =0.3.0-alpha.4 --locked
```

The test uses `$WESLEY` if it is set, and otherwise the first `wesley` on `PATH`. If neither is
found on a workstation, the test prints a line giving the reason and the install command and
skips the Wesley cases, and `bun test` still runs everything else without Rust. With `CI` set, a
missing binary fails the run. CI installs the pinned version with `cargo install` and caches the
binary by version (`.github/workflows/checks.yml`), so a Wesley upgrade is a one-line change to
the pin, reviewed together with whatever the new version changes.
