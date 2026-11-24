#!/usr/bin/env python3
"""A test tool for a declared secret that coincides with a word the writer itself emits, such as
`--token create` beside the bookkeeping `op` `create` (spec section 5.3). It declares a file, a
`stdin`, a `tree` and a missing input, so every writer-built record is exercised. The Bun oracle
runs it as a real process under `--help`, `--schema` and as an ordinary command, and validates
every line it emits against the released snapshot of its exact pair with ajv."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))

import parley_emit as pe  # noqa: E402

tool = pe.define_tool(
    name="coincide-tool", version="0.0.1",
    commands={"count": {
        "intent": "Count the things under the working directory",
        "effects": {"reads": ["<cwd>/**"], "writes": [], "network": False, "idempotent": True},
        "secrets": ["--token"],
        "emits": [{"id": "coincide-tool.count", "version": "1.0.0"}],
    }},
    retention={"count": 10},
)


def count(run, args):
    run.input("-", "x")
    try:
        run.read_input("missing.txt")
    except OSError:
        pass  # recorded as input.unreadable
    run.result({"event": "result", "value": 1}, ("coincide-tool.count", "1.0.0"))


if __name__ == "__main__":
    sys.exit(pe.main(
        tool, ["coincide-tool", *sys.argv[1:]], count,
        inputs=lambda args, command: [{"path": "a.txt"}, {"path": "-", "role": "stdin"}, {"path": ".", "role": "tree"}, {"path": "missing.txt"}],
        resolved=lambda args, command: {"command": command, "zq": args[-1]},
    ))
