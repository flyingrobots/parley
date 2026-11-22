# Working agreement

General rules live in `~/.agents/AGENTS.md`. This records what is specific to `parley`.

## What this repository is

A **specification first**, libraries second. The spec in `spec/` is the product; any reader or
writer we ship is a conforming implementation of it, not the definition of it.

## The two versions, kept apart

- **The spec version** (`spec/parley-vX.Y.md`) moves when the protocol changes.
- **Each message schema version** (`schemas/*.schema.json`) moves when that message changes.
- **The package version** moves when the code changes.

None of them are the same number. Coupling any two forces false breaking changes and hides real
ones. This is the rule the spec asks of conforming programs, so this repository must hold to it
first.

## Checks

`bun test` runs everything, including the example checker (`bun run check`). See
[docs/workflows/check-examples](docs/workflows/check-examples/README.md) for how to label an
example that is deliberately incomplete.

## Hard don'ts

- Do not let the libraries define the protocol. If an implementation cannot do what the spec says,
  change the spec deliberately and version it, or fix the implementation.
- Do not add a field to a message without versioning its schema.
- Do not claim a section is settled that has not been tested against a real program.
