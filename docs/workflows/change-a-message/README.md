# Changing a message

How to change the shape of a Parley message: add a field, tighten a constraint, edit a
description. This is a contributor operation. What a message must say is in the
[specification](../../../spec/parley-v0.2.md), and the rules for its version are in spec §4.5.

## Today: two files, one commit

The hand-written JSON Schema `schemas/<id>.schema.json` is the source of truth. The Wesley SDL in
`schemas/parley.graphql` states the same shape and is held to it
([Message SDL](../../topics/message-sdl/README.md)). Until flyingrobots/parley#119 makes the SDL
the source, every change is made in both, in the same commit.

1. **Move the version first, if the message is released.** Every version in the
   [schemas table](../../../schemas/README.md) is released and immutable. The first change after a
   release moves the top-level file to a new draft version and names it under `## [Unreleased]`
   in `CHANGELOG.md`. A description-only change is a patch, an optional field added is a minor
   version, and a required field added, a field removed or a constraint narrowed is a major
   version (spec §4.5). Change the version everywhere it is held: the schema's `$id`, its
   `_schema.version` `const`, the `version:` of the message's `@parley_message` in the SDL, and
   the pair each writer stamps on emitted lines, which is a hand-kept table in
   `packages/parley-emit/src/run.ts` and another in `packages/parley-emit-py/parley_emit.py`
   (search for the message id).
2. **Edit the JSON Schema.**
3. **Make the same edit in the SDL**, using the directive the page above lists for the keyword. A
   required field has `!`, and an optional one has no `!` and carries `@parley_optional`.
4. **Run the agreement test** with the pinned Wesley installed:

   ```text
   bun test scripts/sdl-agreement.test.ts
   ```

   If the two files disagree, it names the message and the JSON Pointer that differs.
5. **Sync the packages**, because they ship copies of the schemas: `bun run sync-schemas` in
   `packages/parley-emit`, `packages/parley-read` and `packages/parley-emit-py`. A test in each
   fails while its copy is stale.
6. **Run the gate**: `bun test`, `bun run check` and `bun run typecheck`.

If the change needs a construct that neither the SDL nor the interim directives can state, the
directives are not extended with a raw JSON Schema fragment. Add a named directive that stands for
a Wesley issue: file the issue in flyingrobots/wesley with the Parley example, add it to
flyingrobots/parley#119's `.blocked_by`, and record the directive in the Message SDL page's table.
The agreement test fails until the SDL declaration, the derivation's vocabulary and that table all
name it.
