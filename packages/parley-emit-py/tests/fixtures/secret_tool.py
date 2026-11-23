#!/usr/bin/env python3
"""A test tool that declares a secret and lets it surface everywhere a tool might leak it: a step,
a result, a warning and an error. The Bun oracle runs it and asserts the value reaches none of the
three streams, and that the doctor passes on the run."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))

import parley_emit as pe  # noqa: E402

tool = pe.define_tool(
    name="secret-tool", version="0.0.1",
    commands={"fetch": {
        "intent": "Pretend to fetch something with a token",
        "effects": {"reads": [], "writes": [], "network": False, "idempotent": True},
        "secrets": ["--token", "SECRET_TOOL_TOKEN"],
        "emits": [{"id": "secret-tool.fetched", "version": "1.0.0"}],
    }},
    retention={"count": 10},
)


def fetch(run, args):
    token = args[args.index("--token") + 1] if "--token" in args else os.environ.get("SECRET_TOOL_TOKEN", "")
    run.step("fetched with the token", "the token came from the command line", {"url": "https://example.invalid/?t=" + token})
    print("a library logged the token " + token)
    run.warning("fetch.slow", "the fetch with " + token + " was slow")
    run.result({"event": "result", "token_was": token, "nested": {token: [token]}}, ("secret-tool.fetched", "1.0.0"))
    run.error("fetch.partial", "the fetch with " + token + " returned part of the answer")


if __name__ == "__main__":
    sys.exit(pe.main(tool, ["secret-tool", *sys.argv[1:]], fetch))
