# Working agreement

General rules live in `~/.agents/AGENTS.md`. This records what is specific to `parley`.

## What this repository is

A **specification first**, libraries second. The spec in `spec/` is the product; any reader or
writer we ship is a conforming implementation of it, not the definition of it.

## The three versions, kept apart

- **The spec version** (`spec/parley-vX.Y.md`) moves when the protocol changes.
- **Each message schema version** (`schemas/*.schema.json`) moves when that message changes.
- **The package version** moves when the code changes.

None of them are the same number. Coupling any two forces false breaking changes and hides real
ones. This is the rule the spec asks of conforming programs, so this repository must hold to it
first.

## What conforms and what does not

The writer and reader libraries, once they exist, are conforming implementations of the spec. The
repository's own tooling under `scripts/` is not: the example checker emits JSON Lines with a
`parley.tooling.*` schema so it is parseable, but it carries no run identity and makes no claim
to the protocol.

## Checks

`bun test` runs everything, including the example checker (`bun run check`). See
[docs/workflows/check-examples](docs/workflows/check-examples/README.md) for how to label an
example that is deliberately incomplete.

## Hard don'ts

- Do not let the libraries define the protocol. If an implementation cannot do what the spec says,
  change the spec deliberately and version it, or fix the implementation.
- Do not add a field to a message without versioning its schema, unless that schema version is
  still a draft under `Unreleased` in the changelog (spec §4.5), in which case record the change
  in that entry.
- Do not claim a section is settled that has not been tested against a real program.
