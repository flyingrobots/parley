// `refuseSuspectedSecrets`: refuse a line that looks like it carries a credential
// (flyingrobots/parley#60).
//
// Declared redaction (spec §5.3) replaces what the program declared. It cannot catch a secret
// nobody declared, and an undeclared token in a result reaches the shared timeline silently —
// where, unlike a receipt, it lives for the retention window and is read by more observers than
// the run that produced it.
//
// This is a history transform that withholds such a line. Two things about it are deliberate:
//
//   - **It refuses; it never rewrites.** A heuristic must not claim the certainty that rewriting
//     implies. Replacing the matched span would put a record on the stream that *looks* checked
//     and differs from the receipt's copy of the same event in a way nothing records. Withholding
//     leaves a `seq` gap on the stream alone, which a reader can see and the doctor reports. So
//     the cost of a false positive is one withheld stream line, never a changed result.
//   - **It scans the body, never the envelope.** `event`, `t`, `seq`, `run` and `_schema` are the
//     writer's, chosen secret-free at startup, and identical on both copies of one event (§1.3).
//     Scanning them would let one unlucky run id withhold every line of a run.
//
// The honest limits, all three tested and documented:
//
//   - An unlisted shape passes. This refuses what it recognises; recognition is a floor.
//   - A token split across two string values passes. The scan is per value and claims nothing
//     about what concatenating two of them would spell.
//   - A token used as an object *key* passes. Keys name fields; a value is what a program carries.
//     (The writer's own §5.3 scrubber does rename keys, because there the value is declared.)

import { refuse, type HistoryRefusal } from "../refusal.ts";
import { SECRET_PATTERNS, type SecretPattern } from "./secret-patterns.ts";

/** The code of the warning a refusal by this built-in raises. */
export const SUSPECTED_SECRET_CODE = "history.suspected_secret";

/** Where in a record's body a token shape matched. */
export interface SuspectedSecret {
  /** The matching pattern's `name`, never the matched text. */
  readonly pattern: string;
  /** A JSON Pointer (RFC 6901) into the record, as a `redaction` event would name one (§5.3). */
  readonly at: string;
}

/** The envelope is the writer's and is never scanned (§1.3). */
const ENVELOPE = new Set(["event", "t", "seq", "run", "_schema"]);

interface Compiled { readonly name: string; readonly re: RegExp }

/**
 * One compile per pattern list, keyed by the list itself: the default list is compiled once for
 * the process, and a caller's list once per list. A per-call compile would be ten `RegExp`
 * constructions per line of a segment.
 */
const compiledFor = new WeakMap<readonly SecretPattern[], readonly Compiled[]>();

function compile(patterns: readonly SecretPattern[]): readonly Compiled[] {
  const had = compiledFor.get(patterns);
  if (had !== undefined) return had;
  // No flags: no `g`, so no `lastIndex` carried from one line to the next, and case-sensitive,
  // because every shape here is a prefix its vendor assigns in one case.
  const made = patterns.map((p) => ({ name: p.name, re: new RegExp(p.regex) }));
  compiledFor.set(patterns, made);
  return made;
}

/** RFC 6901: `~` is `~0` and `/` is `~1`, so a pointer is unambiguous about which key it names. */
const token = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");

/** The first shape a string matches, or `null`. */
function matchOf(value: string, patterns: readonly Compiled[]): string | null {
  for (const p of patterns) if (p.re.test(value)) return p.name;
  return null;
}

function scan(value: unknown, at: string, patterns: readonly Compiled[]): SuspectedSecret | null {
  if (typeof value === "string") {
    const hit = matchOf(value, patterns);
    return hit === null ? null : { pattern: hit, at };
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = scan(value[i], `${at}/${i}`, patterns);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      const hit = scan(v, `${at}/${token(k)}`, patterns);
      if (hit !== null) return hit;
    }
    return null;
  }
  return null;
}

/**
 * The first token shape a record's **body** matches, or `null`. Strings are walked recursively
 * through objects and arrays; the five envelope fields are skipped at the top level, and object
 * keys are not scanned. The first match wins: the result says *that* the body looks like it
 * carries a credential, which is all a refusal needs, so there is no reason to keep looking.
 *
 * `at` is built from the record's own keys, so it can itself carry a token-shaped key. It is safe
 * to inspect in the process and is **not** safe to emit as it is; `refuseSuspectedSecrets` checks
 * it before naming it in a warning.
 */
export function findSuspectedSecret(record: Record<string, unknown>, patterns: readonly SecretPattern[] = SECRET_PATTERNS): SuspectedSecret | null {
  const compiled = compile(patterns);
  if (compiled.length === 0) return null;
  for (const [k, v] of Object.entries(record)) {
    if (ENVELOPE.has(k)) continue;
    const hit = scan(v, `/${token(k)}`, compiled);
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * A transform that withholds any line whose body matches one of `patterns`, and raises one
 * `history.suspected_secret` warning naming the withheld `seq`, the shape and the pointer — never
 * the matched text, which would put the suspected credential on stderr and in the receipt copy of
 * the warning, and from there on the stream.
 *
 * ```ts
 * await main(tool, argv, handler, { history: { transform: refuseSuspectedSecrets() } });
 * ```
 *
 * `patterns` replaces the default list entirely rather than extending it, so a caller who passes
 * one is reviewing exactly what they refuse on; pass `[...SECRET_PATTERNS, ...mine]` to add. An
 * empty list is the identity transform. Pass `name` to `history` alongside it when the list is
 * customised: the digest on the stream's opening line is of this function's source text, which
 * does not change when the list it closes over does.
 */
export function refuseSuspectedSecrets(patterns: readonly SecretPattern[] = SECRET_PATTERNS): (record: Record<string, unknown>) => Record<string, unknown> | HistoryRefusal {
  // Compiled here rather than on the first record, so a pattern that will not compile is a throw
  // where the list was configured instead of one withheld line per line of the run.
  const compiled = compile(patterns);
  return function refuseSuspectedSecrets(record: Record<string, unknown>) {
    const hit = findSuspectedSecret(record, patterns);
    if (hit === null) return record;
    const seq = typeof record.seq === "number" ? String(record.seq) : "?";
    // The pointer is made of the record's keys, and a key can be a token too. Naming it would put
    // a *different* suspected secret on stderr, in the receipt and on the stream through this
    // warning's own copy — which is the one thing this transform exists to prevent.
    const inKey = matchOf(hit.at, compiled);
    const where = inKey === null
      ? `at ${hit.at}`
      : `under a key this warning will not repeat, because the key itself matches the ${inKey} shape`;
    return refuse(
      SUSPECTED_SECRET_CODE,
      `the body of seq ${seq} matches the ${hit.pattern} shape ${where}, so that line is not on the shared stream; the receipt is unaffected and still carries the value`,
      `declare the value as a secret in the command's secrets list (spec §5.3) so it is replaced in the receipt too, or keep it out of the record; an unlisted shape passes, and a legitimate value that matches costs this one stream line`,
    );
  };
}
