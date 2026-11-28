# Related work

What parley borrows, where it differs, and what is actually its own. Each neighbour below was
checked to exist on 2026-11-22; the descriptions are limited to what their own front pages say.
Read this before claiming novelty for any part of the [specification](../../../spec/parley-vous-v0.3.md).

## Specifications for agent-facing command lines

**[CLI Agent Spec](https://cli-agent-spec.github.io/)** documents failure modes of tools called
by agents and states requirements to remove them, with machine-readable schemas and a deterministic
conformance kit that reports pass or fail per check. It covers input (argument schemas, an
idempotency key), which parley's v0.2 does not, and exit codes and a terminal envelope, which
parley now has (§3.3, §3.4). Where parley differs: receipts on disk by default, content-addressed invocation identity, and the no-TTY rule.
Check its position on TTY detection before citing it as a contrast; one external review reported
it as the opposite of parley's.

**[ChaosRealmsAI agent-cli-spec](https://github.com/ChaosRealmsAI)** is a 98-rule design
specification whose headline stance is the same as parley §1.1: JSON by default, `--human` as the
opt-in. It adds `--agent` as an explicit override. parley is not first with that stance.

**[agent-cli/v2](https://github.com/maelys-dev/agent-cli-spec)** defines one contract for a
program driven the same way by a person and by an agent, with schemas and a conformance kit.

**[12-Factor AI-CLI](https://github.com/hop-top/spec-12fc)** is a factor list with a GitHub
Action that checks conformance and emits a JSON report.

What all four have that parley lacks at v0.2: conformance tooling that runs against a real tool
([flyingrobots/parley#23](https://github.com/flyingrobots/parley/issues/23)) and a contract for
input.

## Persistent protocols

**[Model Context Protocol](https://modelcontextprotocol.io/)** owns the stateful, authenticated
outer loop: a server process, JSON-RPC, tool discovery with input schemas. It is not a
competitor for a one-shot command on a local machine; a parley-conforming tool is a clean backend
for an MCP server to wrap. MCP's specification treats tool annotations as untrusted unless the
server is trusted, which is the same boundary parley §1.2a draws for `effects`.

## Build and run records

**[OpenLineage](https://openlineage.io/)** carries a URL to the exact schema version on every
run event and sends events to a shared backend. That is parley's `_schema` plus the optional
history stream of §8, applied to data pipelines rather than command lines.

**[Bazel's build event protocol](https://bazel.build/remote/bep)** opens a stream with a
started event and closes it with a finished event, carries an invocation id, and records the
command line and parsed options. parley has both: the bootstrap line opens a run and `end` closes
it, carrying the exit status (§3). Bazel's action
digests are the nearest prior art for `inv`: identity computed over the inputs, not their paths.

**[Terraform's machine-readable output](https://developer.hashicorp.com/terraform/internals/machine-readable-ui)**
is where the first draft of parley's §4.5 came from: minor bumps are additive and readers ignore
unknown properties; major bumps break and readers reject them. parley kept the SemVer-shaped
promise and open schemas, and found that the other half, that a newer minor accepts every older
line, does not hold for open schemas, because an older line may already carry a value under a
name the new minor types; §4.5 now validates against the exact `(id, version)` pair and treats a
line without its exact schema as partially checked at best.

**[SARIF](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html)** is a single-document batch format for analysis
results. Its invocation object (command line, arguments, exit status) and per-artifact hashes are
the same idea as parley's receipt head, in a shape that cannot stream and is bound to static
analysis.

## The source §9 cites

Spec §9 ("Reading history is an act", informative) says it rests on the observer-geometry
treatment in the AIΩN Foundations Series. That treatment has now been read against §9:
[Observer geometry and spec §9](observer-geometry.md) marks every §9 bullet kept, changed or
dropped, cites the sections it relies on, and proposes revised wording. Unlike the neighbours
above, this is a source §9 claims as its basis rather than a specification parley competes with,
so it gets its own page.

## What is parley's own

Narrower than the README's tagline suggests, and worth stating exactly:

- A receipt written to disk for every run, whether or not anyone asked, with its path announced
  on the first line of stdout so a crash still names it.
- `inv` and `run` as separate identities, with `inv` over input bytes rather than paths, for
  ordinary command-line tools.
- Raw and resolved argv side by side in the receipt.
- Errors that carry `measured`, `limit` and `remedy`.
- No TTY detection, stated as a MUST NOT.

Everything else exists elsewhere. The combination, sized for a tool that wants no server and no
database, is the proposition.

## Name

`parley` is also the name of [Linebender's Rust text-layout crate](https://github.com/linebender/parley),
so the unqualified crate name is not available. Decision
([flyingrobots/parley#20](https://github.com/flyingrobots/parley/issues/20), 2026-11-22): the
specification and this repository keep the name Parley; libraries are published under distinct
names such as `parley-emit` and `parley-read`, subject to availability, and as scoped npm packages
under `@flyingrobots`; where ambiguity matters the descriptive name is "the Parley output
protocol". The project is not renamed to solve a package-name collision.
