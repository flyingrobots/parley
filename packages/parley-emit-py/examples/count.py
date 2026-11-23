#!/usr/bin/env python3
"""The smallest conforming tool: count the regular files directly under the working directory.

The Python twin of packages/parley-emit/examples/count.ts. Run it as
`python3 examples/count.py files` from any directory; it imports the writer from the directory
above, where a tool that vendors parley_emit.py would keep it beside itself instead.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import parley_emit as pe  # noqa: E402

COUNT = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://flyingrobots.dev/parley-emit/schemas/count.result/1.0.0",
    "type": "object",
    "required": ["event", "t", "seq", "run", "files", "_schema"],
    "properties": {
        "event": {"const": "result"},
        "files": {"type": "integer", "minimum": 0},
        "_schema": {"type": "object", "required": ["id", "version"], "additionalProperties": False,
                    "properties": {"id": {"const": "count.result"}, "version": {"const": "1.0.0"}}},
    },
}

tool = pe.define_tool(
    name="count",
    version="0.1.0",
    commands={
        "files": {
            "intent": "Count the regular files directly under the working directory",
            "effects": {"reads": ["<cwd>/*"], "writes": [], "network": False, "idempotent": True},
            "secrets": [],
            "emits": [{"id": "count.result", "version": "1.0.0", "schema": COUNT}],
        },
    },
    retention={"count": 50},
    human=lambda line: f"{line['files']} file(s)" if line.get("event") == "result" else None,
)


def files(run: pe.Run, args: list) -> None:
    if args:
        run.error("usage.unknown_argument", f"files takes no arguments, and was given {len(args)}",
                  remedy="run count files, or count files --help to see the command", detail={"arguments": args})
        return
    names = sorted(n for n in os.listdir(run.cwd) if os.path.isfile(os.path.join(run.cwd, n)))
    run.step(f"counted {len(names)} regular file(s)", "directories and special files are not files; only regular files count", {"names": names})
    run.result({"event": "result", "files": len(names)}, ("count.result", "1.0.0"))


if __name__ == "__main__":
    sys.exit(pe.main(tool, ["count", *sys.argv[1:]], files))
