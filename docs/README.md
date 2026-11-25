# parley documentation

| Page | Job |
| --- | --- |
| [The specification](../spec/parley-v0.2.md) | Normative. What a conforming program must do. |
| [Schemas](../schemas/README.md) | JSON Schema per message type, versioned independently; the table lists each schema and its current version |
| [Message SDL](topics/message-sdl/README.md) | The Wesley SDL that states the same 17 messages and is not yet their source: its interim directives and the Wesley issue that retires each, and what the agreement test holding it to the schemas establishes; its [test plan](topics/message-sdl/test-plan.md) is the contract ledger |
| [Output contract](topics/output-contract/README.md) | Why the rules are what they are |
| [Related work](topics/related-work/README.md) | The neighbouring specifications and formats, what parley borrows from each, and what is its own |
| [Observer geometry and spec §9](topics/related-work/observer-geometry.md) | What §9 takes from the observer-geometry treatment it cites, where it departs, and a proposed revision of its bullet list |
| [The reader: asker, view and budget](topics/reader/README.md) | How a read states what it wants and what a result says about itself: the `parley.query` and `parley.lens` messages |
| [Pre-freeze review of `parley.query` and `parley.lens` 1.1.0](topics/reader/freeze-review-1.1.0.md) | A dated review record: every difference between the two draft schemas and their released 1.0.0, classified, with the recommendation on freezing them and the compatibility statement for the release |
| [A cold resume on real history](topics/reader/cold-resume.md) | What an agent with no other context reconstructed from footprint's real receipts using the digest and the drill-down, checked against `git log`, and what it missed |
| [parley-emit](topics/parley-emit/README.md) | The writer library: what it does for a tool, lifecycle by lifecycle; its [test plan](topics/parley-emit/test-plan.md) is the contract ledger |
| [parley-emit-py](topics/parley-emit-py/README.md) | The Python writer, one vendorable file: its lifecycle, exit statuses, discovery, per-tool retention and what its stray-output capture cannot hold; its [test plan](topics/parley-emit-py/test-plan.md) is the contract ledger |
| [parley-read](topics/parley-read/README.md) | The reader library: how a repository's receipt bundles are located, parsed, deduplicated, validated and ruled in or out for replay, and how a read over them is refused, recorded, ranked by its purpose and answered; its [test plan](topics/parley-read/test-plan.md) is the contract ledger |
| [Conformance checking](topics/conformance/README.md) | The doctor: what it checks in a captured run, rule by rule, and what a pass does and does not establish |
| [Releases](topics/release/README.md) | What a release is: the spec and schemas, each package and the Python file on their own tracks, and why a released schema is immutable; its [test plan](topics/release/test-plan.md) is the contract ledger |
| [Releasing parley-emit](workflows/release-parley-emit/README.md) | The order of a package release: the gate before the tag, what the tag-triggered workflow checks and stages, what the owner compares before approving, and what the workflow cannot verify |
| [Releasing parley-read](workflows/release-parley-read/README.md) | The same for the reader: the dependency on parley-emit, the publish order, and the manual first publish with its trusted-publisher values |
| [Releasing parley-emit-py](workflows/release-parley-emit-py/README.md) | The same for the vendorable Python file: the gate before the tag, the workflow that creates its GitHub release with the digest, and what it cannot verify |
| [Releasing the spec and its schemas](workflows/release-spec/README.md) | The rule a stable release is held to, the release-eligibility checker and its three phases, the release gate and its report, and the two commits and merge commit that release schema versions; its [test plan](workflows/release-spec/test-plan.md) is the contract ledger |
| [Review findings and release exceptions](workflows/release-review/README.md) | The rule that a confirmed finding against evidence fidelity, privacy, identity or a published contract blocks a release by default, what an exception must record, and the exceptions on record |
| [Changing a message](workflows/change-a-message/README.md) | Moving the version, then making one change in both the JSON Schema and the SDL, and checking they agree |
| [Checking the examples](workflows/check-examples/README.md) | How every JSON example is validated against its schema, and how to label one that is not complete |

Living references describe what is true on `main`. Nothing is archived; git history is the archive.
