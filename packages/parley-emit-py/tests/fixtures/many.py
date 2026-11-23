#!/usr/bin/env python3
"""A test tool that emits N results, a warning in the middle and a step for each hundred, so the
Bun oracle can check one gapless seq counter across stdout, stderr and the receipt."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))

import parley_emit as pe  # noqa: E402

tool = pe.define_tool(
    name="many", version="0.0.1",
    commands={"emit": {
        "intent": "Emit N results",
        "effects": {"reads": [], "writes": [], "network": False, "idempotent": True},
        "secrets": [],
        "emits": [{"id": "many.result", "version": "1.0.0"}],
    }},
    retention={"count": 10},
)


def emit(run, args):
    n = int(args[0])
    for i in range(n):
        if i % 100 == 0:
            run.step(f"reached {i}", "a step every hundred results")
        if i == n // 2:
            run.warning("many.halfway", "half of the results are out")
        run.result({"event": "result", "i": i}, ("many.result", "1.0.0"))


if __name__ == "__main__":
    sys.exit(pe.main(tool, ["many", *sys.argv[1:]], emit))
