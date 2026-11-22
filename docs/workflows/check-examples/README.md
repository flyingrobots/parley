# Checking the examples

How every JSON example in this repository is kept valid against the schema it names. This is a
contributor operation; the protocol itself is in the [specification](../../../spec/parley-v0.2.md).

## Why

Spec §4.4: a schema nothing checks drifts from what it describes, and is then worse than no
schema because it is believed. The README's front-door example was invalid against the bootstrap
schema for the first commit of this repository. This check exists so that cannot happen again.

## What runs

```text
bun test        # the checker's own tests, plus a test that runs it over the whole repository
bun run check   # the checker alone; add --human for prose
```

CI runs both on every push to `main` and every pull request (`.github/workflows/checks.yml`).

The checker is `scripts/check-examples.ts`. It walks `README.md`, `spec/` and `docs/`, finds every
fenced block whose info string starts with `json` or `jsonl`, and for each document:

1. parses it;
2. reads `_schema.id` and `_schema.version`;
3. finds the schema file under `schemas/` (drafts at the top level, released snapshots under
   `released/<id>/`) whose `$id` ends in `/schemas/<id>/<version>`;
4. validates against it with a JSON Schema draft 2020-12 validator.

A `json` block is one document, which may span lines. A `jsonl` block is one document per line.

## Labels

An example that is deliberately not a complete, valid message says so in the fence info string.
An unlabeled example that does not validate is a failure, so forgetting a label fails CI rather
than silently passing.

| Fence | Meaning | Checked |
| --- | --- | --- |
| ```` ```json ```` | A complete message | Parsed and validated |
| ```` ```json abridged ```` | Contains `…` placeholders for brevity | Skipped entirely |
| ```` ```json illustrative ```` | Shows a shape with no schema yet, or a fragment | Parsed only |

A document whose `_schema.id` does not start with `parley.` is tool-owned (for example
`theme-book.count`) and is parsed but not validated, since its schema lives with that tool.

The checker resolves `_schema.version` by exact match against the version in each schema's `$id`.
That is the same rule a reader follows under spec §4.5 and §4.6: full validation is against the
schema for the exact advertised `(id, version)` pair, so an example stamped `2.1.0` while the
only schema is `2.0.0` is reported as `unknown_schema`. The loader reads `schemas/` and `schemas/released/<id>/`,
so a released snapshot at `schemas/released/<id>/<version>.schema.json` resolves by the same exact
pair once one exists; a draft and a snapshot that claim the same pair are a configuration error
and fail the invariant test.

The checker's own output lines carry a `parley.tooling.*` schema id but no `t`, `seq` or `run`.
It is repository tooling, not a parley program, and does not claim to conform; `AGENTS.md` says
which programs in this repository are conforming implementations.

## Output

The checker emits JSON Lines, one verdict per example and one summary, each stamped with
`_schema: {id: "parley.tooling.check_examples", version: "1.0.0"}`. The schema is
`scripts/check-examples.schema.json`, and a test asserts every line the checker can emit validates
against it. Exit status is `0` when every example passes, `1` when any fails, `2` when the check
could not run (including finding no examples at all, which is never reported as success).

Example of a failure line, from the fixture that reproduces the original README defect:

```jsonl illustrative
{"event":"example.invalid","file":"scripts/fixtures/readme-shape.md","line":4,"reason":"invalid","detail":"/ must have required property 'paths'","_schema":{"id":"parley.tooling.check_examples","version":"1.0.0"}}
```
