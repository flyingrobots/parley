#!/usr/bin/env bun
// The smallest conforming tool: count the regular files under the working directory.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { defineTool, main } from "../src/index.ts";

const COUNT = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://flyingrobots.dev/parley-emit/schemas/count.result/1.0.0",
  type: "object",
  required: ["event", "t", "seq", "run", "files", "_schema"],
  properties: {
    event: { const: "result" },
    files: { type: "integer", minimum: 0 },
    _schema: { type: "object", required: ["id", "version"], additionalProperties: false, properties: { id: { const: "count.result" }, version: { const: "1.0.0" } } },
  },
};

const tool = defineTool({
  name: "count",
  version: "0.1.0",
  commands: {
    files: {
      intent: "Count the regular files directly under the working directory",
      effects: { reads: ["<cwd>/*"], writes: [], network: false, idempotent: true },
      secrets: [],
      emits: [{ id: "count.result", version: "1.0.0", schema: COUNT }],
    },
  },
  retention: { count: 50 },
  human: (line) => (line.event === "result" ? `${String(line.files)} file(s)` : null),
});

const status = await main(tool, ["count", ...process.argv.slice(2)], (run) => {
  const names = readdirSync(run.cwd).filter((n) => statSync(join(run.cwd, n)).isFile());
  run.step(`counted ${names.length} regular file(s)`, "directories and special files are not files; only regular files count", { names });
  run.result({ event: "result", files: names.length }, { id: "count.result", version: "1.0.0" });
});
process.exit(status);
