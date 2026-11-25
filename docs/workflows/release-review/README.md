# Review findings and release exceptions

What a confirmed review finding does to a release, and what must be written down when a release
goes ahead despite one. This is a contributor operation, applied by the people who review and cut a
release; no script decides it. The mechanical checks a release also has to pass are in
[Releasing the spec and its schemas](../release-spec/README.md).

## The rule

> **Every confirmed finding that violates evidence fidelity, privacy, identity, or a published
> contract blocks a release by default, whether this change introduced it or it was found in older
> code.**

The four kinds, as they apply here:

| Kind | A finding of this kind |
| --- | --- |
| Evidence fidelity | a reader states something its receipts do not hold, or a writer records something that did not happen |
| Privacy | a declared secret, or anything redaction should have replaced, leaves the process |
| Identity | a run, a record or an artifact can be taken for another: a run id, a `(run, seq)`, an `inv`, a pin, a digest |
| A published contract | behaviour differs from the released spec, a released schema, or a package's published reference |

"Confirmed" means the review reproduced it or showed it in the source, and did not withdraw it.

Two facts inform the decision and settle nothing on their own:

- **The defect predates the change.** That says who introduced it. It does not make the release's
  artifact behave any better.
- **No acceptance criterion of the release names it.** The criteria say what the change set out
  to do. They do not list everything the artifact must not do.

A finding of this kind is resolved in one of two ways: it is fixed before the release, or the
owner accepts an exception and the exception is recorded.

## Recording an exception

Only the repository's owner accepts an exception. An agent acting under a delegation does not: it
stops and asks. The record goes in the table below, in the same pull request as the release, and
states all six of:

1. **The artifact and the promise.** The exact package and version, and the sentence of the spec,
   schema or reference it falls short of.
2. **The reproduction and the known impact.** What was run and what it showed. Say plainly when
   how often it happens was not measured.
3. **The containment.** What consumers are told, and where: the limitation as it is written in the
   changelog and the reference.
4. **Who accepted it**, and on what date.
5. **The follow-up issue.**
6. **The release or date by which it is resolved.** An exception with no deadline is a decision
   not to fix.

The release's changelog entry states the limitation as well; the table is where its terms are.

When the follow-up is fixed and released, delete the row. Git history keeps it.

## Exceptions on record

| Artifact | Falls short of | Reproduction and impact | Containment | Accepted | Follow-up | Resolved by |
| --- | --- | --- | --- | --- | --- | --- |
| `@flyingrobots/parley-read` 0.2.0 | The `parley.lens` 1.1.0 description of a fold: runs fold only when their result records are equal. And the reader's own purpose: a returned record is the record the receipt holds. | Run against 0.2.0 installed from npm into a clean directory: two receipts in `.parley/receipts`, each a `receipt.head` with the same `inv`, one `result` record and an `end` of status 0, the results written as literal text `"value":9007199254740992` and `"value":9007199254740993`; then `queryReceipts` with `view: "everything"` over a window holding both. It returned one folded section and the value `9007199254740992` for the run whose receipt says `9007199254740993`. With `fold: false` in the query it returned two sections, both saying `9007199254740992`. The cause is that the reader parses numbers as doubles. Two integers outside −(2^53)+1 to (2^53)−1 collide only when they parse to the same double. How many tools emit such integers was not measured. | Stated as a known exception in the 0.2.1 changelog entry, the reader's changelog and its README. | Shipped on 2026-11-24 by an agent under the owner's delegation, which ruled the finding a follow-up without asking. The owner recorded it as a disclosed exception the same day (flyingrobots/parley#148). The rule above exists because of this row. | flyingrobots/parley#159 | The next release of `@flyingrobots/parley-read`, which it blocks. |
