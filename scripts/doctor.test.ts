import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { doctor, type Verdict } from "./doctor.ts";

const F = "scripts/fixtures/doctor";
const read = (c: string, s: string) => readFileSync(`${F}/${c}/${s}.jsonl`, "utf8");
const conforming = () => ({ stdout: read("conforming", "stdout"), stderr: read("conforming", "stderr"), receipt: read("conforming", "receipt") });
const rules = (vs: Verdict[]) => vs.filter((v) => v.event === "doctor.violation").map((v) => (v as { rule: string }).rule).sort();
const summary = (vs: Verdict[]) => vs[vs.length - 1] as Extract<Verdict, { event: "doctor.summary" }>;
const lines = (s: string) => s.split("\n").filter(Boolean);
const edit = (s: string, i: number, f: (o: Record<string, unknown>) => Record<string, unknown> | null) => {
  const ls = lines(s); const o = JSON.parse(ls[i]); const r = f(o);
  if (r === null) ls.splice(i, 1); else ls[i] = JSON.stringify(r);
  return ls.join("\n") + "\n";
};

describe("parley doctor", () => {
  test("the conforming fixture conforms", () => {
    const vs = doctor(conforming());
    expect(rules(vs)).toEqual([]);
    expect(summary(vs)).toMatchObject({ passed: true, status: 0, partial: 2, lines: { stdout: 3, stderr: 1, receipt: 7 } });
  });
  test("a startup failure alone conforms and has no end", () => {
    const vs = doctor({ stdout: read("startup-failed", "stdout"), stderr: read("startup-failed", "stderr") });
    expect(rules(vs)).toEqual([]);
    expect(summary(vs).status).toBeNull();
  });
  test("every violation and the summary validate against the doctor's output schema", async () => {
    const Ajv2020 = (await import("ajv/dist/2020.js")).default;
    const schema = JSON.parse(readFileSync("scripts/doctor.schema.json", "utf8"));
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);
    const { stamp } = await import("./doctor.ts");
    const c = conforming();
    const broken = { ...c, stdout: edit(c.stdout, 2, () => null), stderr: c.stderr + "glibc: warning\n" + '{"event":"x"}' };
    for (const v of [...doctor(c), ...doctor(broken)]) expect(validate(stamp(v)), JSON.stringify(validate.errors)).toBe(true);
  });

  const cases: [string, (c: ReturnType<typeof conforming>) => Partial<ReturnType<typeof conforming>>, string[]][] = [
    ["missing end on stdout", (c) => ({ stdout: edit(c.stdout, 2, () => null) }), ["R7.no_end"]],
    ["missing end in the receipt only", (c) => ({ receipt: edit(c.receipt, 6, () => null) }), ["R7.receipt_no_end", "R9.not_retained"]],
    ["non-JSON line on stderr is quarantined", (c) => ({ stderr: c.stderr + "node: deprecation warning\n" }), ["R1.quarantined"]],
    ["non-JSON line on stdout is a contract failure", (c) => ({ stdout: c.stdout.replace("\n{\"event\":\"end\"", "\nprogress 40/120\n{\"event\":\"end\"") }), ["R1.stdout_not_json"]],
    ["unterminated final line is ignored and reported", (c) => ({ stderr: c.stderr + '{"event":"warning"' }), ["R1.unterminated"]],
    ["bootstrap not first", (c) => ({ stdout: lines(c.stdout).slice(1, 2).concat(lines(c.stdout)[0], lines(c.stdout)[2]).join("\n") + "\n" }), ["R4.bootstrap_seq", "R4.first_not_bootstrap", "R5.head_tool"]],
    ["bootstrap mirrored into the receipt", (c) => ({ receipt: lines(c.stdout)[0] + "\n" + c.receipt }), ["R4.bootstrap_mirrored", "R5.head_first"]],
    ["seq collision with a different event", (c) => ({ receipt: edit(c.receipt, 3, (o) => ({ ...o, seq: 3 })) }), ["R6.copies_disagree", "R6.duplicate"]],
    ["copies disagree on a shared field", (c) => ({ receipt: edit(c.receipt, 1, (o) => ({ ...o, value: 6 })) }), ["R6.copies_disagree"]],
    ["a line from another run", (c) => ({ receipt: edit(c.receipt, 3, (o) => ({ ...o, run: "01JD3KS9T4U8V1W5X2Y7Z3A6B9" })) }), ["R6.run"]],
    ["result not retained in the receipt", (c) => ({ receipt: edit(c.receipt, 1, () => null) }), ["R9.not_retained"]],
    ["end.redacted disagrees with the receipt", (c) => ({ stdout: edit(c.stdout, 2, (o) => ({ ...o, redacted: false })), receipt: edit(c.receipt, 6, (o) => ({ ...o, redacted: false })) }), ["R8.redacted_aggregate"]],
    ["status 2 with no error", (c) => ({ stdout: edit(c.stdout, 2, (o) => ({ ...o, status: 2 })), receipt: edit(c.receipt, 6, (o) => ({ ...o, status: 2 })) }), ["R7.status2_no_error"]],
    ["an event after end", (c) => ({ receipt: c.receipt + '{"event":"receipt.step","t":1795326412402,"seq":8,"run":"01JD3KQ8Z6V9X2M4N7P1R3T5W8","decision":"late","because":"x","_schema":{"id":"parley.receipt.step","version":"1.0.0"}}\n' }), ["R7.after_end", "R7.end_not_final", "R7.receipt_no_end"]],
    ["unknown exact pair is reported, never validated", (c) => ({ stderr: edit(c.stderr, 0, (o) => ({ ...o, _schema: { id: "parley.warning", version: "1.4.0" } })), receipt: edit(c.receipt, 2, (o) => ({ ...o, _schema: { id: "parley.warning", version: "1.4.0" } })) }), ["R3.unknown_pair", "R3.unknown_pair"]],
    ["a line that fails its exact schema", (c) => ({ stderr: edit(c.stderr, 0, (o) => ({ ...o, code: "Bad Code" })), receipt: edit(c.receipt, 2, (o) => ({ ...o, code: "Bad Code" })) }), ["R3.invalid", "R3.invalid"]],
    ["missing envelope field", (c) => ({ receipt: edit(c.receipt, 3, (o) => { const { run, ...rest } = o; return rest; }) }), ["R2.envelope", "R3.invalid", "R6.run"]],
    ["receipt head from another tool", (c) => ({ receipt: edit(c.receipt, 0, (o) => ({ ...o, v: "0.3.0" })) }), ["R5.head_tool"]],
    ["announced receipt does not exist", (c) => ({ receipt: undefined, receiptPresent: false }), ["R5.receipt_missing"]],
  ];
  for (const [name, mutate, expected] of cases) {
    test(`detects: ${name}`, () => {
      const c = conforming(); const input = { ...c, ...mutate(c) };
      expect(rules(doctor(input))).toEqual([...expected].sort());
    });
  }
});
