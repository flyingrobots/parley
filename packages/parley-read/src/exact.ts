// Numbers, loaded with the value their text states (flyingrobots/parley#159).
//
// A receipt is JSON text, and a JSON number is a decimal of any size. `JSON.parse` holds every
// number as a double, so `9007199254740993` comes back as `9007199254740992` and `1e400` as
// `Infinity`, before anything can validate, compare, rank or fold the record. In 0.2.0 that is
// what the reader did: a returned record could state an integer its receipt does not hold, and two
// runs that differed only in such integers could fold. Converting afterwards is too late, so the
// rule is applied where the text is parsed, to a receipt line and to a sidecar's contents alike.
//
// **The rule, decided from the token as written.**
//
//   - An **integer-valued** number inside JavaScript's safe-integer range, -9007199254740991 to
//     9007199254740991, is a `number`. However it is spelt: `5`, `5.0`, `1e3`, `120e-1`.
//   - An integer-valued number **outside** that range is a `bigint` holding exactly that integer,
//     always, even where a double could hold it: `9007199254740992`, `9007199254740993.0`,
//     `9.007199254740993e15`, `1e21`, `1e400`. One boundary, so neighbouring large ids never
//     alternate between two types.
//   - A number that is **not an integer** is a `number`, the double it parses to, when the token is
//     that double's own digits: the double rounded to the token's count of significant digits is
//     the token. That is every decimal of up to fifteen digits, a double's shortest form (`0.1`,
//     what JavaScript, Python, Go and Rust write) and a longer correct one (`0.10000000000000001`,
//     what C's `%.17g` writes).
//   - Anything else the reader **cannot hold**: a non-integral decimal that is no double's digits
//     (`0.1000000000000000055`, `1e-400`), or an integer of more than `MAX_EXACT_DIGITS` digits.
//     It says so (`ok: false`, with the tokens) and the caller holds the whole text back rather
//     than return a rounded value.
//
// This fixes **integer** precision. A `bigint` does nothing for a non-integral decimal: those are
// doubles or they are not held.
//
// **Bounded.** Nothing here allocates in proportion to a number's magnitude. `1e1000000000` is
// classified from its digits and its exponent, found to be past the cap, and never built; a token
// of two million digits is counted, not converted.
//
// **A `bigint` is not JSON to `JSON.stringify`**, which throws on one. `exactJson` is the
// serialiser that writes it as the JSON number it is, exact unquoted digits, and everything in
// this package that compares, measures or serialises a record goes through it.

/** The most decimal digits an integer may have and still be held exactly; `1e400` has 401. */
export const MAX_EXACT_DIGITS = 4096;

/** The largest magnitude an integer-valued JSON number may have and still load as a `number`. */
const SAFE = "9007199254740991";

/** A value a returned record can hold: JSON's values, with a `bigint` for an integer beyond the safe range. */
export type ExactValue = null | boolean | number | bigint | string | ExactValue[] | { [key: string]: ExactValue };

/** What stands where a number the reader cannot hold was, in the `partial` of a failed parse. Never returned in a record. */
export const UNREPRESENTABLE: unique symbol = Symbol("parley-read.unrepresentable-number");

export type ExactParse =
  | { readonly ok: true; readonly value: unknown }
  /**
   * The text is JSON and holds a number this reader cannot represent. `tokens` are those numbers
   * as written; `partial` is the value with `UNREPRESENTABLE` in their places, for reading the
   * fields beside them and nothing else.
   */
  | { readonly ok: false; readonly tokens: readonly string[]; readonly partial: unknown };

const NUMBER = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
const ZERO_CODE = 48;

interface Decimal { readonly negative: boolean; readonly digits: string; readonly exponent: number }

/**
 * A decimal as sign, significant digits with no zero at either end, and a power of ten. Zero has
 * no digits. Linear in the token: the zeros are trimmed by index, never by a pattern that retries.
 */
function decimal(token: string): Decimal {
  const m = NUMBER.exec(token);
  if (m === null) return { negative: false, digits: token, exponent: Number.NaN }; // equal to nothing, itself included
  const fraction = m[3] ?? "";
  const all = m[2]! + fraction;
  let from = 0;
  while (from < all.length && all.charCodeAt(from) === ZERO_CODE) from++;
  let to = all.length;
  while (to > from && all.charCodeAt(to - 1) === ZERO_CODE) to--;
  const digits = all.slice(from, to);
  const exponent = (m[4] === undefined ? 0 : Number(m[4])) - fraction.length + (all.length - to);
  return { negative: m[1] === "-", digits, exponent: digits === "" ? 0 : exponent };
}

/** How a token is held: as the number it parses to, as a `bigint`, or not at all. */
type Kind = "number" | "bigint" | "none";

function classify(token: string, at: Decimal): Kind {
  if (at.digits === "") return "number"; // zero, however spelt
  if (at.exponent >= 0) {
    // An integer. Its length decides almost every case without building anything.
    const length = at.digits.length + at.exponent;
    if (length < SAFE.length) return "number";
    if (length > MAX_EXACT_DIGITS) return "none";
    if (length > SAFE.length) return "bigint";
    return at.digits + "0".repeat(at.exponent) <= SAFE ? "number" : "bigint"; // sixteen digits against sixteen
  }
  // Not an integer: a double, when the token is that double's digits at the token's own length.
  if (at.digits.length > 100) return "none"; // more digits than a double can be asked to print
  const double = Number(token);
  if (!Number.isFinite(double) || double === 0) return "none";
  const printed = decimal(double.toPrecision(at.digits.length));
  return printed.digits === at.digits && printed.exponent === at.exponent ? "number" : "none";
}

const QUOTE = 34, BACKSLASH = 92, MINUS = 45, ZERO = 48, NINE = 57;

/** The index of the quote that closes the string opened at `open`. The text is known to be JSON. */
function closing(text: string, open: number): number {
  let at = open + 1;
  for (;;) {
    at = text.indexOf('"', at);
    if (at < 0) return text.length;
    let slashes = 0;
    for (let k = at - 1; text.charCodeAt(k) === BACKSLASH; k--) slashes++;
    if (slashes % 2 === 0) return at;
    at++;
  }
}

/** Where the number token starting at `start` ends. Outside a string, JSON holds these characters only in a number. */
function numberEnd(text: string, start: number): number {
  let at = start + 1;
  for (;; at++) {
    const c = text.charCodeAt(at);
    // digits, `+`, `-`, `.`, `E`, `e`
    if (!((c >= ZERO && c <= NINE) || c === 43 || c === MINUS || c === 46 || c === 69 || c === 101)) return at;
  }
}

/**
 * Whether every number in a JSON text loads as a JavaScript number. One pass over the text:
 * strings are skipped by their closing quote, and a number of at most fifteen digits with no
 * exponent, which is nearly every number a receipt holds, is settled without parsing it.
 */
function everyNumberPlain(text: string): boolean {
  const length = text.length;
  for (let i = 0; i < length; i++) {
    const c = text.charCodeAt(i);
    if (c === QUOTE) { i = closing(text, i); continue; }
    if (c !== MINUS && !(c >= ZERO && c <= NINE)) continue;
    // A token of at most fifteen digits and no exponent is below 10^15 in magnitude: inside the
    // safe range if it is an integer, and if it is not, a decimal a double returns as written (a
    // double carries at least fifteen digits). It is a number, and is not looked at further.
    let end = i + 1;
    let digits = c === MINUS ? 0 : 1;
    let exponent = false;
    for (;; end++) {
      const d = text.charCodeAt(end);
      if (d >= ZERO && d <= NINE) digits++;
      else if (d === 69 || d === 101) exponent = true; // E, e
      else if (d !== 46 && d !== 43 && d !== MINUS) break; // not `.`, `+` or `-`: the token is over
    }
    if (digits > 15 || exponent) {
      const token = text.slice(i, end);
      if (classify(token, decimal(token)) !== "number") return false;
    }
    i = end - 1;
  }
  return true;
}

/** A number token as the value the reader holds for it. */
function numberValue(token: string, tokens: string[]): unknown {
  const at = decimal(token);
  const kind = classify(token, at);
  if (kind === "number") return Number(token);
  if (kind === "bigint") return BigInt((at.negative ? "-" : "") + at.digits + "0".repeat(at.exponent));
  tokens.push(token);
  return UNREPRESENTABLE;
}

/**
 * Build the value of a text already known to be JSON, with each number as `numberValue` gives it.
 * It follows `JSON.parse` in everything else: a repeated key keeps its first position and its last
 * value, and a member named `__proto__` is an own property.
 */
function build(text: string, tokens: string[]): unknown {
  let i = 0;
  const skip = () => { while (text.charCodeAt(i) <= 32) i++; };
  const string = (): string => {
    const end = closing(text, i);
    const value = JSON.parse(text.slice(i, end + 1)) as string;
    i = end + 1;
    return value;
  };
  const value = (): unknown => {
    skip();
    const c = text.charCodeAt(i);
    if (c === 123) { // {
      const object: Record<string, unknown> = {};
      i++; skip();
      if (text.charCodeAt(i) === 125) { i++; return object; }
      for (;;) {
        skip();
        const key = string();
        skip(); i++; // :
        const member = value();
        if (key === "__proto__") Object.defineProperty(object, key, { value: member, enumerable: true, writable: true, configurable: true });
        else object[key] = member;
        skip();
        if (text.charCodeAt(i++) === 125) return object; // } ends it; otherwise a comma
      }
    }
    if (c === 91) { // [
      const array: unknown[] = [];
      i++; skip();
      if (text.charCodeAt(i) === 93) { i++; return array; }
      for (;;) {
        array.push(value());
        skip();
        if (text.charCodeAt(i++) === 93) return array;
      }
    }
    if (c === QUOTE) return string();
    if (c === 116) { i += 4; return true; }
    if (c === 102) { i += 5; return false; }
    if (c === 110) { i += 4; return null; }
    const end = numberEnd(text, i);
    const token = text.slice(i, end);
    i = end;
    return numberValue(token, tokens);
  };
  return value();
}

/**
 * Parse JSON text with every number's value preserved, or say which numbers could not be.
 *
 * Throws exactly when `JSON.parse` throws. A text whose numbers all load as JavaScript numbers
 * returns `JSON.parse`'s own value.
 */
export function parseExact(text: string): ExactParse {
  const plain: unknown = JSON.parse(text);
  if (everyNumberPlain(text)) return { ok: true, value: plain };
  const tokens: string[] = [];
  let value: unknown;
  try { value = build(text, tokens); } catch {
    // Nesting deeper than this builder's stack: the text is JSON, and it cannot be held exactly.
    return { ok: false, tokens: ["(nesting too deep to read its numbers exactly)"], partial: UNREPRESENTABLE };
  }
  return tokens.length === 0 ? { ok: true, value } : { ok: false, tokens, partial: value };
}

/** True when the value holds a `bigint` at any depth. */
export function holdsExact(value: unknown): boolean {
  if (typeof value === "bigint") return true;
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(holdsExact);
  for (const key in value) if (holdsExact((value as Record<string, unknown>)[key])) return true;
  return false;
}

function write(value: unknown): string | undefined {
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const json = (value as { toJSON?: unknown }).toJSON;
  if (typeof json === "function") return write((json as () => unknown).call(value));
  if (Array.isArray(value)) return `[${value.map((v) => write(v) ?? "null").join(",")}]`;
  const members: string[] = [];
  for (const key of Object.keys(value)) {
    const member = write((value as Record<string, unknown>)[key]);
    if (member !== undefined) members.push(`${JSON.stringify(key)}:${member}`);
  }
  return `{${members.join(",")}}`;
}

/**
 * `JSON.stringify(value)` for a value that may hold a `bigint`: the `bigint` is written as the
 * JSON number it is: exact unquoted digits, never a string and never with a suffix.
 * `JSON.stringify` throws on one, so a record this reader returns that holds an integer beyond the
 * safe range must be serialised with this instead. A consumer that parses the text again with an
 * ordinary `JSON.parse` loses the precision again. For a value
 * holding none it returns `JSON.stringify`'s own text; a value with no JSON form at all
 * (`undefined`, a function) is `"null"`.
 */
export function exactJson(value: unknown): string {
  try { return JSON.stringify(value) ?? "null"; } catch (e) {
    if (!(e instanceof TypeError)) throw e;
    return write(value) ?? "null";
  }
}
