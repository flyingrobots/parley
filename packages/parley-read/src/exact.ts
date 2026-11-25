// Numbers, loaded with the value their text states (flyingrobots/parley#159).
//
// A receipt is JSON text, and a JSON number is a decimal of any size. `JSON.parse` holds every
// number as a double, so `9007199254740993` comes back as `9007199254740992` and `1e400` as
// `Infinity`, before anything can validate, compare, rank or fold the record. Until 0.2.0 that is
// what the reader did: a returned record could state a value its receipt does not hold, and two
// runs that differed only in such a number could fold. Converting afterwards is too late, so the
// rule is applied where the text is parsed, to a receipt line and to a sidecar's contents alike.
//
// **The rule.** A number token is *faithful* when its exact decimal value equals the value of the
// double it parses to, as JavaScript prints that double (the shortest decimal that parses back to
// it, which is what every mainstream writer emits). `0.1`, `1e3`, `-0`, `9007199254740992` and
// `1e21` are faithful; `9007199254740993`, `1e400` and `0.1000000000000000055` are not. Then:
//
//   - every token faithful: the value is `JSON.parse`'s, exactly as before. This is every line an
//     ordinary writer produces, and the only added cost is the scan that establishes it;
//   - an unfaithful token that is an **integer**, written in digits or with an exponent: the
//     value is a `bigint` holding that integer. Every integer of magnitude up to 2^53 is faithful,
//     so a `bigint` is always beyond that, and a value is one or the other by what it is, never
//     by how it was written: `9007199254740993` and `9.007199254740993e15` are the same `bigint`;
//   - an unfaithful token that is not an integer, or an integer of more than `MAX_EXACT_DIGITS`
//     digits: the reader cannot hold it. It says so (`ok: false`, with the tokens) and the caller
//     holds the whole text back rather than return a rounded value.
//
// **A `bigint` is not JSON to `JSON.stringify`**, which throws on one. `exactJson` is the
// serialiser that writes it as the JSON number it is, and everything in this package that
// compares, measures or serialises a record goes through it.

/** The most decimal digits an integer may have and still be held exactly; `1e400` has 401. */
export const MAX_EXACT_DIGITS = 4096;

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

interface Decimal { readonly negative: boolean; readonly digits: string; readonly exponent: number }

/** A decimal as sign, significant digits with no zero at either end, and a power of ten. Zero has no digits. */
function decimal(token: string): Decimal {
  const m = NUMBER.exec(token);
  if (m === null) return { negative: false, digits: token, exponent: Number.NaN }; // equal to nothing, itself included
  const fraction = m[3] ?? "";
  let digits = (m[2]! + fraction).replace(/^0+/, "");
  let exponent = (m[4] === undefined ? 0 : Number(m[4])) - fraction.length;
  const kept = digits.replace(/0+$/, "");
  exponent += digits.length - kept.length;
  digits = kept;
  return { negative: m[1] === "-", digits, exponent: digits === "" ? 0 : exponent };
}

/** True when the token's exact decimal value is the value of the double it parses to, as that double prints. */
function faithful(token: string, at: Decimal): boolean {
  const double = Number(token);
  if (!Number.isFinite(double)) return false;
  const printed = decimal(String(double));
  if (at.digits === "" || printed.digits === "") return at.digits === printed.digits;
  return at.digits === printed.digits && at.exponent === printed.exponent && at.negative === printed.negative;
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
 * Whether every number in a JSON text is faithful. One pass over the text: strings are skipped by
 * their closing quote, and a number of at most fifteen digits, which is nearly every number a
 * receipt holds, is faithful without being looked at further.
 */
function everyNumberFaithful(text: string): boolean {
  const length = text.length;
  for (let i = 0; i < length; i++) {
    const c = text.charCodeAt(i);
    if (c === QUOTE) { i = closing(text, i); continue; }
    if (c !== MINUS && !(c >= ZERO && c <= NINE)) continue;
    // Fifteen significant digits survive a double and come back as written (a double carries at
    // least fifteen), so a token of at most fifteen digits before any exponent, with an exponent
    // of at most two digits, is faithful without parsing it. Leading zeros are counted, which
    // only sends a few more tokens to the full check.
    let end = i + 1;
    let digits = c === MINUS ? 0 : 1;
    let exponentDigits = 0;
    let inExponent = false;
    for (;; end++) {
      const d = text.charCodeAt(end);
      if (d >= ZERO && d <= NINE) { if (inExponent) exponentDigits++; else digits++; }
      else if (d === 69 || d === 101) inExponent = true; // E, e
      else if (d !== 46 && d !== 43 && d !== MINUS) break; // not `.`, `+` or `-`: the token is over
    }
    if (digits > 15 || exponentDigits > 2) {
      const token = text.slice(i, end);
      if (!faithful(token, decimal(token))) return false;
    }
    i = end - 1;
  }
  return true;
}

/** A number token as the value the reader holds for it. */
function numberValue(token: string, tokens: string[]): unknown {
  const at = decimal(token);
  if (faithful(token, at)) return Number(token);
  if (at.exponent >= 0 && at.digits.length + at.exponent <= MAX_EXACT_DIGITS) {
    return BigInt((at.negative ? "-" : "") + at.digits + "0".repeat(at.exponent));
  }
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
 * Throws exactly when `JSON.parse` throws. A text whose numbers are all faithful returns
 * `JSON.parse`'s own value.
 */
export function parseExact(text: string): ExactParse {
  const plain: unknown = JSON.parse(text);
  if (everyNumberFaithful(text)) return { ok: true, value: plain };
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
 * JSON number it is, digit for digit. `JSON.stringify` throws on one, so a record this reader
 * returns that holds an integer beyond a double must be serialised with this instead. For a value
 * holding none it returns `JSON.stringify`'s own text; a value with no JSON form at all
 * (`undefined`, a function) is `"null"`.
 */
export function exactJson(value: unknown): string {
  try { return JSON.stringify(value) ?? "null"; } catch (e) {
    if (!(e instanceof TypeError)) throw e;
    return write(value) ?? "null";
  }
}
