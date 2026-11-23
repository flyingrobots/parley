# Schemas

One JSON Schema (draft 2020-12) per message type the protocol defines, versioned separately from
the spec and from any package (spec §4.4). The `$id` of each file ends in `/<id>/<version>`, and
the same exact id and version are pinned inside the schema's `_schema` constraint, because full
validation is against the schema for the exact advertised pair (spec §4.5).

Every version in the table is **released** (the `0.2.0` entry in
[`CHANGELOG.md`](../CHANGELOG.md)) and immutable: its snapshot is at
`released/<id>/<version>.schema.json` (spec §4.6), and the top-level file here holds the same bytes.
A change to a schema, a description included, moves it to a new version; that version is a draft,
which may change in place, while its changelog entry is under `Unreleased` (spec §4.5).
`scripts/schemas.test.ts` fails if a top-level file changes a released pair's bytes, or carries a
version that is neither released nor named under `Unreleased`.

| Schema | Current version | Message | Spec |
| --- | --- | --- | --- |
| `parley.run.bootstrap` | 1.1.1 | First line of stdout, before work begins | §3 |
| `parley.receipt.head` | 2.0.0 | First line of the receipt file | §5 |
| `parley.error` | 2.0.0 | An error, on stderr and in the receipt | §6 |
| `parley.warning` | 1.0.0 | A recovered condition, on stderr and in the receipt | §6.1 |
| `parley.startup.failed` | 1.0.0 | The single stderr line of a run that could not bootstrap; exit 3 | §3.2 |
| `parley.end` | 1.0.0 | The terminal event, on stdout and in the receipt | §3.3 |
| `parley.sidecar` | 1.0.0 | A receipt line standing in for a record stored beside the receipt | §5 |
| `parley.redaction` | 1.0.0 | A receipt line recording a redaction the head's `redacted` field does not cover | §5.3 |
| `parley.receipt.step` | 1.0.0 | One decision and its reason; receipt only | §5 |
| `parley.receipt.inputs` | 1.0.0 | Late input digests and `inv` once settled | §2.2 |
| `parley.cache.hit` | 1.0.0 | The program answered from a prior receipt | §2.3 |
| `parley.page` | 1.0.0 | One page of unbounded output | §7.2 |
| `parley.command` | 1.0.0 | A command's description, effects, secrets and emitted types | §4.1 to §4.3 |
| `parley.schema` | 1.0.0 | One message schema, carried by discovery | §4.1, §4.2 |
| `parley.query` | 1.0.0 | A read against the history, recorded as an event: asker, view, budget, window | §9 |
| `parley.lens` | 1.0.0 | The lens a result carries: view, asker, budget, window, loss bound, the runs it names, records | §9 |
| `parley.history.transform` | 1.0.0 | The opening line of a projected copy of a run on the shared stream: the projection's name and the digest of its source | §8 |

Every message type the spec requires has a schema here and a validated example in the spec.
`parley.query` and `parley.lens` are for the reader §9 describes, which is informative and is built
in [`@flyingrobots/parley-read`](../packages/parley-read/README.md); their examples live in
[docs/topics/reader](../docs/topics/reader/README.md), and the representation they encode was
decided in [flyingrobots/parley#46](https://github.com/flyingrobots/parley/issues/46).
`parley.history.transform` belongs to the history stream of §8, which is informative and whose
writer side exists; its example lives in [docs/topics/parley-emit](../docs/topics/parley-emit/README.md).

`scripts/schemas.test.ts` holds the invariants every file here must satisfy, and
`bun run check` validates every example in the repository against these files.
