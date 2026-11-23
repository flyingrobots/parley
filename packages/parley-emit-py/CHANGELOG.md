# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This file is versioned on
its own (`__version__` in `parley_emit.py`); the spec and each message schema move separately
(spec §4.4).

This file is released as a vendorable copy and is not published to a package registry: a tool
copies `parley_emit.py` into its own tree and pins it by the SHA-256 `--vendor-info` prints. Each
release's digest is recorded on its GitHub release (tag `parley-emit-py-vX.Y.Z`).

## [Unreleased]

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
