# parley documentation

| Page | Job |
| --- | --- |
| [The specification](../spec/parley-v0.2.md) | Normative. What a conforming program must do. |
| [Schemas](../schemas/README.md) | JSON Schema per message type, versioned independently; the table lists each schema and its current version |
| [Output contract](topics/output-contract/README.md) | Why the rules are what they are |
| [Related work](topics/related-work/README.md) | The neighbouring specifications and formats, what parley borrows from each, and what is its own |
| [Observer geometry and spec §9](topics/related-work/observer-geometry.md) | What §9 takes from the observer-geometry treatment it cites, where it departs, and a proposed revision of its bullet list |
| [The reader: asker, view and budget](topics/reader/README.md) | How a read states what it wants and what a result says about itself: the `parley.query` and `parley.lens` messages |
| [parley-emit](topics/parley-emit/README.md) | The writer library: what it does for a tool, lifecycle by lifecycle; its [test plan](topics/parley-emit/test-plan.md) is the contract ledger |
| [parley-read](topics/parley-read/README.md) | The reader library: how a repository's receipt bundles are located, parsed, deduplicated, validated and ruled in or out for replay; its [test plan](topics/parley-read/test-plan.md) is the contract ledger |
| [Conformance checking](topics/conformance/README.md) | The doctor: what it checks in a captured run, rule by rule, and what a pass does and does not establish |
| [Releasing parley-emit](workflows/release-parley-emit/README.md) | The order of a package release and what the tag-triggered workflow checks, publishes and needs set up once |
| [Checking the examples](workflows/check-examples/README.md) | How every JSON example is validated against its schema, and how to label one that is not complete |

Living references describe what is true on `main`. Nothing is archived; git history is the archive.
