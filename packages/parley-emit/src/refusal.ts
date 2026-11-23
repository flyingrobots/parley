// A history transform's typed refusal (flyingrobots/parley#60).
//
// flyingrobots/parley#57 gave a transform two answers: a record to put on the stream, or nothing
// to withhold the line. "Nothing" is a gap with no reason attached, which is right when the
// configuration is "the shared timeline does not carry step detail" and wrong when the reason is
// the point — a line withheld because it looks like it carries a credential has to say so, under
// a code a reader can match on.
//
// So there is a third answer: a refusal. It is a value rather than a throw, because a throw
// already means something else in #57's contract (`history.transform_failed`: the transform is
// broken), and because a value composes — a wrapping transform can read a refusal and pass it on
// without an exception handler.
//
// The code is the transform's; everything else stays the writer's. The writer still reattaches
// the envelope it owns, still leaves the exit status alone, still refuses a code that is not a
// code (spec §6) and still refuses one carrying a declared secret value, because a diagnostic's
// `code` is the one string redaction does not touch (§5.3).

/**
 * The brand, registered globally rather than module-locally, so a refusal built by one copy of
 * this package is recognised by another. `instanceof` across two copies of a class is not.
 */
const REFUSAL = Symbol.for("parley.history.refusal");

/** Spec §6's shape for a `code`: two or more dot-separated lowercase segments, never a sentence. */
const CODE_SHAPE = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;

/**
 * What a transform returns to withhold a line *and say why*. The writer raises one `warning`
 * carrying this `code`, `problem` and `remedy`, names nothing else, and leaves the exit status
 * where it was (§6.1).
 */
export interface HistoryRefusal {
  readonly [REFUSAL]: true;
  readonly code: string;
  readonly problem: string;
  readonly remedy?: string;
}

/**
 * Withhold this line under a code of your own. `code` is spec §6's shape and `problem` is one
 * non-empty sentence; both are checked here so a transform author sees the mistake at the point
 * they made it rather than as a withheld line with no warning.
 */
export function refuse(code: string, problem: string, remedy?: string): HistoryRefusal {
  if (!CODE_SHAPE.test(code)) throw new TypeError(`a refusal's code is two or more dot-separated lowercase segments (spec §6), not ${JSON.stringify(code)}`);
  if (problem === "") throw new TypeError("a refusal's problem is never empty (spec §6)");
  return Object.freeze({ [REFUSAL]: true as const, code, problem, ...(remedy === undefined ? {} : { remedy }) });
}

/** Whether a transform's return value is a refusal rather than a record to project. */
export function isHistoryRefusal(value: unknown): value is HistoryRefusal {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[REFUSAL] === true;
}
