# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This file is versioned on
its own (`__version__` in `parley_emit.py`); the spec and each message schema move separately
(spec §4.4).

Nothing is released yet: no version heading below names a release, and nothing is published to a
package registry. A copy is pinned by the SHA-256 `--vendor-info` prints.

## [Unreleased]

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
