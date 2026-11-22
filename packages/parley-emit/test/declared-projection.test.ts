// PE-24: the built-in `declaredProjection` (flyingrobots/parley#59) — the writer's own §5.3
// scrubber, applied to the stream copy's body with a second declared set. Same longest-first
// replacement and key renaming as a declared secret; the envelope untouched; an empty set
// configures no transform at all; the name and digest on the opening line disclose nothing about
// what was declared.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { declaredProjection, defineTool, main, transformDigest, type HistoryTransform, type MainOptions, type Run, type Sink, type ToolSpec } from "../src/index.ts";

class Capture implements Sink {
  lines: string[] = [];
  write(line: string) { this.lines.push(line); }
  get text() { return this.lines.join(""); }
  get objs() { return this.lines.map((l) => JSON.parse(l) as Record<string, unknown>); }
}

const RESULT = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://example.invalid/t/schemas/t.count/1.0.0",
  type: "object",
  required: ["event", "t", "seq", "run", "value", "_schema"],
  properties: {
    event: { const: "result" },
    value: { type: "integer", minimum: 0 },
    _schema: { type: "object", required: ["id", "version"], additionalProperties: false, properties: { id: { const: "t.count" }, version: { const: "1.0.0" } } },
  },
};

function tool(): ToolSpec {
  return defineTool({
    name: "t", version: "0.0.1",
    commands: {
      count: {
        intent: "Count the things",
        effects: { reads: [], writes: [], network: false, idempotent: true },
        secrets: [],
        emits: [{ id: "t.count", version: "1.0.0", schema: RESULT }],
      },
    },
    retention: { count: 10 },
  });
}

function historyScratch() {
  const dir = mkdtempSync(join(tmpdir(), "parley-dp-"));
  const state = mkdtempSync(join(tmpdir(), "parley-dp-state-"));
  const hist = mkdtempSync(join(tmpdir(), "parley-dp-hist-"));
  return { dir, env: { XDG_STATE_HOME: state, PARLEY_HISTORY: hist } as Record<string, string>, hist };
}

function segmentPath(hist: string): string {
  const names = readdirSync(hist).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  expect(names.length).toBe(1);
  return join(hist, names[0]!);
}
function segmentText(hist: string): string { return readFileSync(segmentPath(hist), "utf8"); }
function segmentObjs(hist: string): Record<string, unknown>[] {
  return segmentText(hist).trimEnd().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function runWithTransform(transform: HistoryTransform | undefined, body: (run: Run) => void) {
  const { dir, env, hist } = historyScratch();
  const stdout = new Capture(), stderr = new Capture();
  const extra: Partial<MainOptions> = transform === undefined ? {} : { history: { transform } };
  const status = await main(tool(), ["t", "count"], async (run) => { await body(run); }, {
    cwd: dir, env, stdout, stderr, resolved: (args) => ({ command: "count", args }), ...extra,
  });
  const boot = stdout.objs[0] as { paths?: { receipt?: string } };
  const receipt = boot.paths?.receipt ? readFileSync(boot.paths.receipt, "utf8") : "";
  return { status, stdout, stderr, receipt, hist };
}

describe("PE-24 the built-in declaredProjection", () => {
  test("the longer of two overlapping declared values wins, and both are gone from the stream", async () => {
    const transform = declaredProjection(["token", "token-abcdef"]);
    const r = await runWithTransform(transform, (run) => {
      run.step("connected", "uses a credential", { url: "https://x.invalid/token-abcdef/path" });
      run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" });
    });
    expect(r.status).toBe(0);
    const streamText = segmentText(r.hist);
    expect(streamText.includes("token-abcdef")).toBe(false);
    expect(streamText.includes("token")).toBe(false);
    // The declared set is this projection's own, not a writer-recognised secret, so the receipt
    // (which the stream is a projection of) carries the value in full.
    expect(r.receipt.includes("token-abcdef")).toBe(true);
  });

  test("a declared value inside a key is renamed on the stream and left alone in the receipt", async () => {
    const transform = declaredProjection(["my-host-prod"]);
    const r = await runWithTransform(transform, (run) => {
      run.step("resolved a target", "the hostname is fine locally, not on the shared timeline", { "my-host-prod": "reachable" });
      run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" });
    });
    expect(r.status).toBe(0);
    // The writer's own step explaining the projection (`noteProjection`) is also a `receipt.step`
    // and is mirrored through the same transform, so it is matched out by its own decision text.
    const step = segmentObjs(r.hist).find((o) => o.event === "receipt.step" && o.decision === "resolved a target") as { detail: Record<string, unknown> };
    expect(Object.keys(step.detail)).toEqual(["[redacted]"]);
    expect(step.detail).not.toHaveProperty("my-host-prod");

    const receiptStep = r.receipt.split("\n").map((l) => l && (JSON.parse(l) as Record<string, unknown>)).find((o) => o && o.event === "receipt.step" && o.decision === "resolved a target") as { detail: Record<string, unknown> };
    expect(receiptStep.detail).toHaveProperty("my-host-prod");
  });

  test("an empty declared set configures no transform at all", async () => {
    const transform = declaredProjection([]);
    expect(transform).toBeUndefined();
    const r = await runWithTransform(transform, (run) => {
      run.step("did a thing", "because reasons");
      run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" });
    });
    expect(r.status).toBe(0);
    expect(segmentText(r.hist)).toBe(r.receipt);
    expect(segmentObjs(r.hist).some((o) => o.event === "history.transform")).toBe(false);
    expect(r.stderr.lines).toEqual([]);
  });

  test("the envelope is never scrubbed, even when a declared value matches one of its fields", async () => {
    const transform = declaredProjection(["result"]);
    const r = await runWithTransform(transform, (run) => {
      run.step("logged the result", "the word also appears in the body, which is fair game");
      run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" });
    });
    expect(r.status).toBe(0);
    const objs = segmentObjs(r.hist);
    const resultLine = objs.find((o) => o._schema && (o._schema as { id?: string }).id === "t.count") as { event: string };
    expect(resultLine.event).toBe("result");
    // Matched by `because`, which carries no declared value, so it is untouched by the scrub and
    // distinguishes this step from the writer's own projection-explaining step.
    const step = objs.find((o) => o.event === "receipt.step" && String(o.because).startsWith("the word also appears")) as { decision: string };
    expect(step.decision).toBe("logged the [redacted]");
  });

  test("declaredProjection's name and digest never disclose what it declared", async () => {
    const t1 = declaredProjection(["alpha-secret"]);
    const t2 = declaredProjection(["totally-different-value"]);
    expect(t1).toBeDefined();
    expect(t2).toBeDefined();
    expect(t1!.name).toBe("declaredProjection");
    expect(t2!.name).toBe("declaredProjection");
    expect(transformDigest(t1!)).toBe(transformDigest(t2!));
    expect(t1!.toString().includes("alpha-secret")).toBe(false);
    expect(t2!.toString().includes("totally-different-value")).toBe(false);

    const r = await runWithTransform(t1, (run) => {
      run.step("noted", "because reasons", { note: "alpha-secret appears here" });
      run.result({ event: "result", value: 1 }, { id: "t.count", version: "1.0.0" });
    });
    const opening = segmentObjs(r.hist)[0] as { event: string; name: string };
    expect(opening.event).toBe("history.transform");
    expect(opening.name).toBe("declaredProjection");
    expect(JSON.stringify(opening).includes("alpha-secret")).toBe(false);
  });
});
