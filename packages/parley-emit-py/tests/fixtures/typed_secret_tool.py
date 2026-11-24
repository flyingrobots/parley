#!/usr/bin/env python3
"""A test tool whose result has a typed field a declared secret lands in (flyingrobots/parley#131):
`--token 8675309` and a result whose integer `value` is 8675309. The Bun oracle runs it as a real
process and asserts the exit status is 4, the result reaches no stream, and the doctor passes.

With `TYPED_SECRET_SCHEMA` set to a JSON Schema document, the result is declared under that
schema in place of the built-in one: the oracle passes schemas the writer cannot evaluate
(flyingrobots/parley#144)."""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))

import parley_emit as pe  # noqa: E402

SCHEMA = {"type": "object", "required": ["value"], "properties": {"value": {"type": "integer"}}}
if os.environ.get("TYPED_SECRET_SCHEMA"):
    SCHEMA = json.loads(os.environ["TYPED_SECRET_SCHEMA"])

tool = pe.define_tool(
    name="typed-secret-tool", version="0.0.1",
    commands={"count": {
        "intent": "Echo a number that happens to be the token",
        "effects": {"reads": [], "writes": [], "network": False, "idempotent": True},
        "secrets": ["--token"],
        "emits": [{"id": "typed-secret-tool.count", "version": "1.0.0", "schema": SCHEMA}],
    }},
    retention={"count": 10},
)


def count(run, args):
    token = args[args.index("--token") + 1]
    run.result({"event": "result", "value": int(token)}, ("typed-secret-tool.count", "1.0.0"))


if __name__ == "__main__":
    sys.exit(pe.main(tool, ["typed-secret-tool", *sys.argv[1:]], count))
