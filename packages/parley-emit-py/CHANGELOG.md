# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This file is versioned on
its own (`__version__` in `parley_emit.py`); the spec and each message schema move separately
(spec §4.4).

This file is released as a vendorable copy and is not published to a package registry: a tool
copies `parley_emit.py` into its own tree and pins it by the SHA-256 `--vendor-info` prints. Each
release's digest is recorded on its GitHub release (tag `parley-emit-py-vX.Y.Z`).

## [Unreleased]

## [0.3.0] — 2026-11-24

The writer no longer publishes a record that redaction made invalid under its declared schema
(flyingrobots/parley#131, spec §5.3), by the same rule as `@flyingrobots/parley-emit` 0.4.0. **A
run that used to end with status 0 and an invalid line now ends with status 4 and a structured
error.** The file's digest moves with the file, so a tool that vendors it copies the new file and
pins the new digest.

The schemas it ships are released: `parley.query` and `parley.lens` are the 1.1.0 that spec
`0.2.1` released (the root `CHANGELOG.md`), in place of 1.0.0, pinned to the commit of that release.
The writer stamps neither message, so no emitted line changes. `--vendor-info` reports spec `0.2.1`.

### Fixed

- **A record redaction made invalid is never published.** An integer field equal to a declared
  secret became the string `[redacted]` under the original schema, in a run that ended with
  status 0; a string with a `pattern`, an `enum`, a `format` or a length bound broke the same
  way, as did a tool's own `error` whose `code` or typed field the secret landed in. A tool's
  record in which the scrub replaced something is now validated, as stdout or stderr and the
  receipt would each receive it (`receipt_extra` included), against the schema document for its
  declared pair, before any copy is written and before a `seq` is taken. When the redaction made
  it invalid, nothing of the record is written and the counter has no gap. The writer emits one
  `error` with the code `redaction.schema_conflict`, whose `problem` and `detail` (`{schema: {id,
  version}, at, redacted}`) name each field by JSON Pointer and the schema pair, with no value,
  no text from the checker and no part of the schema. The call raises
  `ParleyRedactionConflict`, which `main` does not report a second time, and the run ends with
  status 4 whatever the handler passes to `end`, as after a sink failure.
- Scope, stated: only a failure the redaction caused is refused. A record already invalid in the
  same way, a record of a type declared with no `schema` document, and a schema outside the
  checker's subset are written as before. Writer-built records are never checked.
- `run.error` marks the run as having reported an error once the line is out, not before.

### Added

- `ParleyRedactionConflict` (with `schema` and `pointers`), `REDACTION_CONFLICT_CODE` and
  `run.redaction_refused`.
- `CheckResult.pointers`: the JSON Pointer of each error, in the same order as `errors`, and for a
  missing or disallowed property, that property. A key containing `/` or `~` is now escaped in
  the path an error names (RFC 6901).

### Changed

- The embedded schemas hold `parley.query` 1.1.0 and `parley.lens` 1.1.0
  (flyingrobots/parley#133), as released with spec `0.2.1`, in place of 1.0.0. The writer stamps
  neither message, so no emitted line changes; the file's digest moves.

## [0.2.0] — 2026-11-24

A declared file input can be read through the run, so the receipt records the bytes the tool read
(flyingrobots/parley#132), and a `receipt_extra` field can no longer contradict the record
(flyingrobots/parley#130). The schemas it embeds and the `--vendor-info` line's shape are
unchanged. **The file's digest moves with the file, so a tool that vendors it copies the new file
and re-pins the copy by the SHA-256 that `--vendor-info` prints.**

### Added

- **`run.read_input(path)`**. It reads a declared file input, returns its `bytes`, and records
  those bytes for the input. `receipt.inputs` and `inv` then describe what the tool consumed,
  whatever the file holds when the run ends. The path is resolved as the declaration is, against
  the run's `cwd` when relative. A file that cannot be read is recorded as `run.input_unreadable`
  records it, and the `OSError` is raised. It raises `ValueError` for a path that is not a
  declared input, for a `stdin` or `tree` input, and after the inputs are settled.

### Changed

- The README and the living reference present `run.read_input` as the way to read a declared file
  input, with a captured run of a tool that edits its input in place.

### Fixed

- A tool that reads a declared file and then rewrites it had no single step that recorded the
  bytes it read: the writer digested the file when the handler finished, so the receipt and `inv`
  described the rewritten file. `run.read_input` is that step. **The default path is unchanged**:
  a declared file the tool does not read through the writer, and does not supply with `run.input`,
  is still digested when the inputs are finalised, and can describe bytes the tool did not read.
  The documentation now says so. A tool gets the fix by calling `run.read_input`.
- **A `receipt_extra` field can no longer contradict the record** (flyingrobots/parley#130).
  `run.result({"value": 1}, schema, {"value": 2})` used to put `1` on stdout and `2` in the
  receipt under one `seq`, against spec §1.3. The call now raises `ValueError` before either copy
  is written. Equal shared values are accepted and written from the record; receipt-only fields
  are unchanged. **BREAKING for a tool that relied on the overwrite**, which was already
  non-conforming.

## [0.1.2] — 2026-11-22

Retention's rule for a receipt that may still be being written is now the spec's (spec section
5.1, flyingrobots/parley#112). The behaviour, the schemas it embeds and the `--vendor-info` line's
shape are unchanged; its digest moves with the file.

### Changed

- **No lock protocol: an incomplete receipt is exempt from retention until it has gone unmodified
  for 24 hours.** This is the decision on flyingrobots/parley#112. A receipt whose last line is not
  `end` is kept, and a complete receipt is deleted in its place. Past 24 hours with no write, its
  run is treated as crashed. A complete receipt cannot be appended to (spec section 3.3), so
  deleting it races no writer. The window that remains is accepted: a run silent for over a day
  that appends while retention deletes its receipt loses it. New injected-clock tests pin each case
  (PY-13h to PY-13j).

## [0.1.1] — 2026-11-22

Fixes for the findings raised on the vendored copy in flyingrobots/taskalisk#71 (copied at parley
`e158c51`). The schemas it embeds are unchanged, and so is the `--vendor-info` line's shape; its
digest moves with the file.

### Added

- **`run.input_unreadable(path, code="input.unreadable")`** (flyingrobots/parley#110). It records
  that the program could not read a declared input, with an `error` and no digest, so `inv` is
  omitted as spec §2.2 requires. Before this, the writer opened the path itself at finalisation,
  so a file that appeared after the program failed to read it got a digest and an `inv` for bytes
  the program never saw. It raises `ValueError` for a path that is not a declared input and after
  the inputs are settled; `run.input` after it supplies bytes again.

### Fixed

- **A `.parley/.gitignore` negation that can re-include `receipts/` sends the receipt to the state
  directory** (flyingrobots/parley#109, spec §5.2). A file of `*`, `!receipts/` and `!receipts/**`
  used to be accepted, and its receipts were left where `git add` stages them. The
  `receipt.relocated` warning names the negation. A pattern the check cannot evaluate is taken to
  match, and `!keep` still stores in the repository.
- **`--schema` and `--help` publish schema documents as declared** (flyingrobots/parley#111, spec
  §5.3). A declared secret whose value occurred in a document, such as `object`, used to rewrite it
  under the original `id` and `version`.
- **Retention re-reads a receipt's age at the decision** (flyingrobots/parley#112), and skips the
  unlink when the receipt's size or mtime moved since. This narrows the window; the issue stays
  open for a lock.
- **Retention deletes a bundle together or not at all** (flyingrobots/parley#113). A receipt that
  could not be unlinked used to lose its sidecars anyway, leaving a receipt that names missing
  records. Now the sidecars go only once the receipt is gone, and a bundle whose receipt survives
  is not reported as deleted.

## [0.1.0] — 2026-11-22

The first released, vendorable version. The schemas it embeds are the released versions of the
repository's first schema release, spec `0.2.0` in the root `CHANGELOG.md`, byte for byte.

### Added

- **`parley_emit.py`, a conforming writer in one vendorable Python file** (flyingrobots/parley#84).
  Standard library only, Python 3.9 or later. `define_tool`, `main` and `Run` mirror the
  TypeScript writer: the bootstrap line before work and the receipt created before it, one `seq`
  across stdout, stderr and the receipt, `inv` derived exactly as the TypeScript writer derives it,
  declared-secret redaction with the head's `redacted` and `redaction` events, sidecars over 65,536
  bytes, `.parley/.gitignore` create-if-absent with the state-directory fallback, `--help` and
  `--schema` as runs, `--human` through a renderer, `--dry-run`, a top-level handler that turns
  every exception into a schema'd line with the right exit status, whole-line descriptor writes
  that wait on `EAGAIN` and report `EPIPE` as status 4, and capture of `sys.stdout` and
  `sys.stderr` into the receipt while the writer runs.
- **Retention per tool from the start**: only bundles whose head names this tool are counted and
  deleted, as decided on flyingrobots/parley#75.
- **The seventeen draft schemas embedded byte for byte**, pinned by commit and digest by
  `scripts/sync_schemas.py` (`bun run sync-schemas`); a stale copy fails the suite. A bounded
  checker, `validate_line` and `check_record`, lets a tool validate its own output line by line
  without a dependency, and reports a keyword it does not implement.
- **`python3 parley_emit.py --vendor-info`**: one `parley.tooling.vendor_info` 1.0.0 line with the
  file's SHA-256, for pinning a vendored copy (`vendor-info.schema.json`).
- `examples/count.py`, the Python twin of the TypeScript example, which checks its arguments in its
  `resolved` callback, before the bootstrap line, so a usage error is `startup.arguments_invalid`,
  exit 3, with no receipt (flyingrobots/parley#91); a `unittest` suite and a Bun
  test that runs it with the TypeScript oracles, so `bun test` covers this writer.

### Fixed

- **`--` ends the writer's flags** (flyingrobots/parley#103). `main` used to remove every argument
  equal to one of its own flags wherever it stood, so a tool flag whose value was `-h`, `--help`,
  `--schema`, `--dry-run`, `--human` or `--humanize` lost it and switched the writer's behaviour.
  Now those flags are recognised only before the first `--`; that `--` is removed and every
  argument after it reaches `resolved`, `inputs` and the handler untouched (`edit -- --note -h`
  gives the tool `["--note", "-h"]`; `edit -- a -- b` gives `["a", "--", "b"]`), and nothing after
  it is ever the command. The TypeScript writer follows the same rule. A vendored copy carries the
  defect until it is re-vendored; `--vendor-info` names the new digest.
- **The command is chosen by position, and only that one argument is removed**
  (flyingrobots/parley#101). `main` used to remove every argument equal to the command's name and
  take the first argument anywhere that named a command, so a flag value equal to a command name
  was lost (`edit --reason edit` gave the tool `["--reason"]`, and its parser then failed) or chosen
  as the command (`--reason plan edit` ran `plan`). Now, once the writer's flags are set aside, the
  first remaining argument is the command; in a tool with more than one, a first argument that
  names none is `startup.unknown_command`, exit 3. The TypeScript writer follows the same rule.
  A vendored copy carries the defect until it is re-vendored; `--vendor-info` names the new digest.
