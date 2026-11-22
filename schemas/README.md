# Schemas

One JSON Schema (draft 2020-12) per message type the protocol defines, versioned separately from
the spec and from any package (spec §4.4). The `$id` of each file ends in `/<id>/<version>`; the
major of that version is also pinned inside the schema's `_schema` constraint (spec §4.5). A version whose changelog entry
is under `Unreleased` is a draft and may change in place (spec §4.5).

| Schema | Current version | Message | Spec |
| --- | --- | --- | --- |
| `parley.run.bootstrap` | 1.1.1 (draft) | First line of stdout, before work begins | §3 |
| `parley.receipt.head` | 2.0.0 (draft) | First line of the receipt file | §5 |
| `parley.error` | 2.0.0 (draft) | An error, on stderr and in the receipt | §6 |

Message types the spec requires that have no schema yet are tracked in
[flyingrobots/parley#10](https://github.com/flyingrobots/parley/issues/10).

`scripts/schemas.test.ts` holds the invariants every file here must satisfy, and
`bun run check` validates every example in the repository against these files.
