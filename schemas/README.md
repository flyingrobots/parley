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
| `parley.warning` | 1.0.0 (draft) | A recovered condition, on stderr and in the receipt | §6.1 |
| `parley.startup.failed` | 1.0.0 (draft) | The single stderr line of a run that could not bootstrap; exit 3 | §3.2 |
| `parley.end` | 1.0.0 (draft) | The terminal event, on stdout and in the receipt | §3.3 |
| `parley.sidecar` | 1.0.0 (draft) | A receipt line standing in for a record stored beside the receipt | §5 |
| `parley.redaction` | 1.0.0 (draft) | A receipt line recording a redaction the head's `redacted` field does not cover | §5.3 |
| `parley.receipt.step` | 1.0.0 (draft) | One decision and its reason; receipt only | §5 |
| `parley.receipt.inputs` | 1.0.0 (draft) | Late input digests and `inv` once settled | §2.2 |
| `parley.cache.hit` | 1.0.0 (draft) | The program answered from a prior receipt | §2.3 |
| `parley.page` | 1.0.0 (draft) | One page of unbounded output | §7.2 |
| `parley.command` | 1.0.0 (draft) | A command's description, effects, secrets and emitted types | §4.1 to §4.3 |
| `parley.schema` | 1.0.0 (draft) | One message schema, carried by discovery | §4.1, §4.2 |
| `parley.query` | 1.0.0 (draft) | A read against the history, recorded as an event: asker, view, budget, window | §9 |
| `parley.lens` | 1.0.0 (draft) | The lens a result carries: view, asker, budget, window, loss bound, the runs it names, records | §9 |
| `parley.history.transform` | 1.0.0 (draft) | The opening line of a projected copy of a run on the shared stream: the projection's name and the digest of its source | §8 |

Every message type the spec requires has a draft schema here and a validated example in the
spec. `parley.query` and `parley.lens` are for the reader §9 describes, which is designed and not
built; `parley.history.transform` belongs to the history stream of §8, which is informative and
whose writer side exists, and its example lives in
[docs/topics/parley-emit](../docs/topics/parley-emit/README.md). The first two's
examples live in [docs/topics/reader](../docs/topics/reader/README.md) and the representation they
encode was decided in
[flyingrobots/parley#46](https://github.com/flyingrobots/parley/issues/46).

`scripts/schemas.test.ts` holds the invariants every file here must satisfy, and
`bun run check` validates every example in the repository against these files.
