#!/usr/bin/env python3
"""Embed the repository's draft schemas in parley_emit.py, byte for byte, pinned by commit and
digest (spec section 4.5: a draft's version string does not identify exact bytes). The Python twin
of the other packages' `scripts/sync-schemas.ts`. Run from anywhere; `bun run sync-schemas` in the
package directory runs it. A test fails when the embedded copy is stale.

Output is one JSON line, `{"event": "sync-schemas", "commit": ..., "files": N}`, as the TypeScript
packages' sync scripts print.
"""

import hashlib
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PACKAGE = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(PACKAGE))
SCHEMAS = os.path.join(ROOT, "schemas")
TARGET = os.path.join(PACKAGE, "parley_emit.py")
BEGIN, END = "# BEGIN SCHEMAS\n", "# END SCHEMAS\n"


def main() -> int:
    files = sorted(f for f in os.listdir(SCHEMAS) if f.endswith(".schema.json"))
    commit = subprocess.run(["git", "-C", ROOT, "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    digests = {}
    texts = {}
    for f in files:
        with open(os.path.join(SCHEMAS, f), "rb") as fh:
            data = fh.read()
        digests[f] = hashlib.sha256(data).hexdigest()
        texts[f] = data.decode("utf-8")
    lines = [BEGIN]
    lines.append("SCHEMA_SOURCE: Dict[str, Any] = {\"commit\": %s, \"files\": {\n" % json.dumps(commit))
    for f in files:
        lines.append("    %s: %s,\n" % (json.dumps(f), json.dumps(digests[f])))
    lines.append("}}\n")
    lines.append("_SCHEMA_TEXT: Dict[str, str] = {\n")
    for f in files:
        # json.dumps with ensure_ascii is a valid Python string literal for any text.
        lines.append("    %s: %s,\n" % (json.dumps(f), json.dumps(texts[f])))
    lines.append("}\n")
    lines.append(END)
    with open(TARGET, "r", encoding="utf-8") as fh:
        source = fh.read()
    start, stop = source.index(BEGIN), source.index(END) + len(END)
    updated = source[:start] + "".join(lines) + source[stop:]
    with open(TARGET, "w", encoding="utf-8") as fh:
        fh.write(updated)
    sys.stdout.write(json.dumps({"event": "sync-schemas", "commit": commit, "files": len(files)}) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
