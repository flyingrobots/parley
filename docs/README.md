# parley documentation

| Page | Job |
| --- | --- |
| [The specification](../spec/parley-v0.2.md) | Normative. What a conforming program must do. |
| [Schemas](../schemas/README.md) | JSON Schema per message type, versioned independently; the table lists each schema and its current version |
| [Output contract](topics/output-contract/README.md) | Why the rules are what they are |
| [Related work](topics/related-work/README.md) | The neighbouring specifications and formats, what parley borrows from each, and what is its own |
| [parley-emit](topics/parley-emit/README.md) | The writer library: what it does for a tool, lifecycle by lifecycle; its [test plan](topics/parley-emit/test-plan.md) is the contract ledger |
| [Conformance checking](topics/conformance/README.md) | The doctor: what it checks in a captured run, rule by rule, and what a pass does and does not establish |
| [Releasing parley-emit](workflows/release-parley-emit/README.md) | The order of a package release and what the tag-triggered workflow checks, publishes and needs set up once |
| [Checking the examples](workflows/check-examples/README.md) | How every JSON example is validated against its schema, and how to label one that is not complete |

Living references describe what is true on `main`. Nothing is archived; git history is the archive.
