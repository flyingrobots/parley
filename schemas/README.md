# Schemas

One JSON Schema (draft 2020-12) per message type the protocol defines, versioned separately from
the spec and from any package (spec §4.4). The `$id` of each file ends in `/<id>/<version>`, and
the same exact id and version are pinned inside the schema's `_schema` constraint, because full
validation is against the schema for the exact advertised pair (spec §4.5). The files here are
the current drafts; a version whose changelog entry is under `Unreleased` may change in place.
Released versions are snapshotted, immutable, under `released/<id>/<version>.schema.json`
(spec §4.6). Nothing is released yet.

| Schema | Current version | Message | Spec |
| --- | --- | --- | --- |
| `parley.run.bootstrap` | 1.1.1 (draft) | First line of stdout, before work begins | §3 |
| `parley.receipt.head` | 2.0.0 (draft) | First line of the receipt file | §5 |
| `parley.error` | 2.0.0 (draft) | An error, on stderr and in the receipt | §6 |
| `parley.startup.failed` | 1.0.0 (draft) | The single stderr line of a run that could not bootstrap; exit 3 | §3.2 |
| `parley.end` | 1.0.0 (draft) | The terminal event, on stdout and in the receipt | §3.3 |
| `parley.sidecar` | 1.0.0 (draft) | A receipt line standing in for a record stored beside the receipt | §5 |
| `parley.redaction` | 1.0.0 (draft) | A receipt line recording a redaction decided after the head | §5.3 |

Message types the spec requires that have no schema yet are tracked in
[flyingrobots/parley#10](https://github.com/flyingrobots/parley/issues/10).

`scripts/schemas.test.ts` holds the invariants every file here must satisfy, and
`bun run check` validates every example in the repository against these files.
