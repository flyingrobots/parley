#!/usr/bin/env bun
// A tool whose output holds integers beyond the safe range, run as a real process by the reader's
// tests (RD-125). The id comes from the environment and is stated only in the result, so it is
// no part of `inv` (spec §2.2): two runs with different ids are one invocation with different
// results. The head's `resolved` holds two such integers of its own. `--token` is a declared
// secret; when it is given, its value also appears in the result as a number, and is redacted.
import { defineTool, main } from "@flyingrobots/parley-emit";

const IDS = {
  type: "object",
  required: ["event", "id", "next"],
  properties: { event: { const: "result" }, id: { type: "integer" }, next: { type: "integer" }, token: {}, ids: { type: "array", items: { type: "integer" } } },
};

const tool = defineTool({
  name: "big",
  version: "0.1.0",
  commands: {
    ids: {
      intent: "State an id from the environment and the one after it",
      effects: { reads: [], writes: [], network: false, idempotent: true },
      secrets: ["--token"],
      emits: [{ id: "big.ids", version: "1.0.0", schema: IDS }],
    },
  },
  retention: { count: 50 },
});

const id = BigInt(process.env.BIG_ID ?? "0");
const args = process.argv.slice(2);
const token = args.includes("--token") ? args[args.indexOf("--token") + 1] : undefined;

const status = await main(tool, ["big", ...args], (run) => {
  run.result({ event: "result", id, next: id + 1n, ids: [id, 18446744073709551615n], ...(token === undefined ? {} : { token: BigInt(token) }) }, { id: "big.ids", version: "1.0.0" });
}, { resolved: (_rest: string[], command: string) => ({ command, limit: 18446744073709551615n, floor: -9007199254740993n }) });
process.exit(status);
