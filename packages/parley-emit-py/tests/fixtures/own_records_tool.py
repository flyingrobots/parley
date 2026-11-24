#!/usr/bin/env python3
"""A test tool for the records the writer raises on its own account: `uncaught.exception`, the
retention step and the captured-output step (spec sections 3.3 and 5.3,
flyingrobots/parley#161). Its one argument after the command picks what the handler does:
`throw` raises, `step-throw` records a step of its own and then raises, `print` writes a line to
stdout that carries the declared secret, and `quiet` does nothing, so that a retention count of 1
makes the writer record its own retention step on the second run. The Bun oracle runs it as a real
process with a declared secret equal to each field name of those records, and validates every line
against the released snapshot of its exact pair with ajv."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))

import parley_emit as pe  # noqa: E402

tool = pe.define_tool(
    name="own-records-tool", version="0.0.1",
    commands={"count": {
        "intent": "Do what the first argument says",
        "effects": {"reads": [], "writes": [], "network": False, "idempotent": True},
        "secrets": ["--token"],
        "emits": [{"id": "own-records-tool.count", "version": "1.0.0"}],
    }},
    retention={"count": 1},
)


def count(run, args):
    mode = args[0]
    secret = args[args.index("--token") + 1] if "--token" in args else ""
    if mode == "step-throw":
        run.step("d", "b")
    if mode in ("throw", "step-throw"):
        raise RuntimeError("boom")
    if mode == "print":
        print("a library says " + secret)


if __name__ == "__main__":
    sys.exit(pe.main(tool, ["own-records-tool", *sys.argv[1:]], count, resolved=lambda args, command: {"command": command, "mode": args[0]}))
