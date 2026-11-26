// Numbers, held with the value their text states (flyingrobots/parley#171, flyingrobots/parley#159).
//
// A line is JSON text, and a JSON number is a decimal of any size. `JSON.parse` holds every number
// as a double, so `9007199254740993` comes back as `9007199254740992` and `1e400` as `Infinity`;
// `JSON.stringify` throws on a `bigint`, the one JavaScript value that holds such an integer. This
// file is the pair that does neither: `parseExact` reads a text with every number's value kept or
// says which it could not keep, and `exactJson` writes a `bigint` as the JSON number it is. The
// writer owns both and exports them, and the reader imports them; nothing here imports the reader.
//
// **The rule, decided from the token as written.**
//
//   - An **integer-valued** number inside JavaScript's safe-integer range, -9007199254740991 to
//     9007199254740991, is a `number`. However it is spelt: `5`, `5.0`, `1e3`, `120e-1`.
//   - An integer-valued number **outside** that range is a `bigint` holding exactly that integer,
//     always, even where a double could hold it: `9007199254740992`, `9007199254740993.0`,
//     `9.007199254740993e15`, `1e21`, `1e400`. One boundary, so neighbouring large ids never
//     alternate between two types.
//   - A number that is **not an integer** is a `number` only when its decimal value equals the
//     decimal value of that number's standard JSON serialisation, `String(Number(token))`, which
//     is what `JSON.stringify` writes (the owner's ruling on flyingrobots/parley#173). `0.1`,
//     `0.10` and `1e-1` are one decimal value and are accepted. `0.10000000000000001` and
//     `0.1000000000000000055` round to the same double and state other decimals, so they are not.
//     Loading and writing an accepted number preserves the decimal value the text states; it does
//     not claim `0.1` has an exact binary form.
//   - Anything else **cannot be held**: such a decimal, one that underflows (`1e-400`), or an
//     integer of more than `MAX_EXACT_DIGITS` digits. `parseExact` says so (`ok: false`, with the
//     tokens) and the caller decides what to do with the text. It never returns a rounded value.
//
// This fixes **integer** precision. A `bigint` does nothing for a non-integral decimal: those are
// doubles in their own standard form, or they are not held.
//
// **Bounded.** Nothing here allocates in proportion to a number's magnitude. `1e1000000000` is
// classified from its digits and its exponent, found to be past the cap, and never built; a token
// of two million digits is counted, not converted.

import { types } from "node:util";

// Taken when this module loads, so a `valueOf` the process later puts on `BigInt.prototype` is
// not what opens a boxed bigint. A primitive's digits are taken with `String`, which asks no
// method of the prototype at all.
const bigValueOf = BigInt.prototype.valueOf;

/**
 * Whether a value is a boxed `bigint`, from any realm. `types.isBigIntObject` answers it, except
 * that Bun 1.2.0 says no for a box made in another realm (a `vm` context), which the serialiser
 * still unboxes. So an object that is not plainly an ordinary one is asked directly: `valueOf`
 * reads the held value and throws for anything that holds none. Nothing of the value's own is
 * read to decide, no tag and no property, since the serialiser reads none either.
 */
export function isBoxedBigInt(value: unknown): boolean {
  if (types.isBigIntObject(value)) return true;
  if (value === null || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) return false; // an ordinary object of this realm: the common case, decided without a throw
  try { bigValueOf.call(value); return true; } catch { return false; }
}

/** The most decimal digits an integer may have and still be held exactly; `1e400` has 401. */
export const MAX_EXACT_DIGITS = 4096;

/** The largest magnitude an integer-valued JSON number may have and still load as a `number`. */
const SAFE = "9007199254740991";

/** A value a record can hold: JSON's values, with a `bigint` for an integer beyond the safe range. */
export type ExactValue = null | boolean | number | bigint | string | ExactValue[] | { [key: string]: ExactValue };

/** What stands where a number that cannot be held was, in the `partial` of a failed parse. It is never a record's value and never written. */
export const UNREPRESENTABLE: unique symbol = Symbol("parley.unrepresentable-number");

export type ExactParse =
  | { readonly ok: true; readonly value: unknown }
  /**
   * The text is JSON and holds a number that cannot be represented. `tokens` are those numbers
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
  // Not an integer: a number only when writing that number back states the decimal the token
  // stated (flyingrobots/parley#173). `String` of a number is its JSON serialisation. An underflow
  // prints as zero, which has no digits, and so matches no token that reaches here.
  const printed = decimal(String(Number(token)));
  return printed.digits === at.digits && printed.exponent === at.exponent && printed.negative === at.negative ? "number" : "none";
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
    // safe range if it is an integer, and if it is not, a decimal of at most fifteen significant
    // digits and at least 10^-15, which a double returns as written: its standard serialisation
    // states the same decimal. It is a number, and is not looked at further.
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

/** A number token as the value held for it. */
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
  if (typeof value === "bigint" || isBoxedBigInt(value)) return true; // a boxed bigint is its primitive
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(holdsExact);
  for (const key in value) if (holdsExact((value as Record<string, unknown>)[key])) return true;
  return false;
}

/** The smallest magnitude with more than `MAX_EXACT_DIGITS` digits. Built once, on first use. */
let pastCap: bigint | undefined;

/**
 * Why the writer refuses a value, or `undefined` when it writes it. Two things at any depth:
 *
 *   - `"integer"`: a `bigint` of more than `MAX_EXACT_DIGITS` digits, one `exactJson` would write
 *     and `parseExact` could not read back. The comparison is against one constant, so no digit
 *     string is built to find out.
 *   - `"number"`: `NaN` or an infinity. JSON has no form for one, and `JSON.stringify` writes
 *     `null`, which states a value the tool did not hand over (flyingrobots/parley#177).
 *
 * It looks at what would be written and nothing else: the value is taken as `plain` takes it,
 * and that is what is scanned. `key` is the member name or array index, `""` at the top.
 */
export function unwritable(value: unknown, key = ""): "integer" | "number" | undefined {
  return unwritablePlain(plain(value, key));
}

/** `unwritable` for a value that is plain data already (`plain`'s result): no hook is called. */
export function unwritablePlain(value: unknown): "integer" | "number" | undefined {
  if (typeof value === "bigint") {
    pastCap ??= 10n ** BigInt(MAX_EXACT_DIGITS);
    return value >= pastCap || value <= -pastCap ? "integer" : undefined;
  }
  if (typeof value === "number") return Number.isFinite(value) ? undefined : "number";
  if (value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) { for (const item of value) { const why = unwritablePlain(item); if (why) return why; } return undefined; }
  for (const k of Object.keys(value)) { const why = unwritablePlain((value as Record<string, unknown>)[k]); if (why) return why; }
  return undefined;
}

/**
 * The value as it is written, as plain data: the one reading of a value that everything else
 * works from. The writer takes a payload through this once, before it is checked, scrubbed or
 * given a `seq`, so what is checked and scrubbed is what is written, and a `toJSON` hook is
 * called once however many sinks the record reaches.
 *
 * The rules are `JSON.stringify`'s, with one difference:
 *
 *   - a `toJSON` hook is applied once, with the key the value sits under, on an object or a
 *     function, and never on a hook's own result;
 *   - a boxed primitive is its primitive, recognised by what it holds, so one from another realm
 *     is too;
 *   - a function, a symbol or `undefined` is no member of an object, and `undefined` in an array,
 *     where `null` is written;
 *   - **a `bigint` is itself, whatever the process has installed.** `JSON.stringify` asks
 *     `BigInt.prototype` for a `toJSON`; this never does, so no polyfill in the process can turn
 *     an exact integer into a string or a rounded number (review case 2026-11-25). A boxed
 *     `bigint` is asked only for a `toJSON` of its own.
 *
 * A value that contains itself is a `TypeError`, as it is to `JSON.stringify`; the same value in
 * two places is not. The result shares nothing mutable with the value: objects and arrays are
 * new, with ordinary prototypes, and a member named `__proto__` is data.
 */
export function plain(value: unknown, key = ""): unknown {
  return snapshot(value, key, false, []);
}

function snapshot(value: unknown, key: string, hooked: boolean, inside: object[]): unknown {
  if (typeof value === "bigint") return value;
  const isObject = value !== null && typeof value === "object";
  if (!isObject && typeof value !== "function") return typeof value === "symbol" ? undefined : value;
  const boxedBig = isObject && isBoxedBigInt(value);
  if (!hooked) {
    // On a boxed bigint only a hook of its own counts: the one it would inherit is
    // `BigInt.prototype`'s, which is never asked.
    const json = !boxedBig || Object.prototype.hasOwnProperty.call(value, "toJSON") ? (value as { toJSON?: unknown }).toJSON : undefined;
    if (typeof json === "function") return snapshot((json as (key: string) => unknown).call(value, key), key, true, inside);
  }
  if (typeof value === "function") return undefined;
  if (boxedBig) {
    // The method this module took when it loaded is the real one unless the process replaced it
    // first. The real one answers with a bigint; anything else means the box cannot be read,
    // and it is refused, never written as what a replacement returned.
    const held: unknown = bigValueOf.call(value);
    if (typeof held !== "bigint") throw new TypeError("a boxed bigint could not be read: BigInt.prototype.valueOf was replaced before this package was loaded");
    return held;
  }
  if (types.isNumberObject(value)) return Number(value);
  if (types.isStringObject(value)) return String(value);
  if (types.isBooleanObject(value)) return Boolean.prototype.valueOf.call(value);
  const obj = value as object;
  if (inside.includes(obj)) throw new TypeError("a value that contains itself has no JSON form");
  inside.push(obj);
  let out: unknown;
  if (Array.isArray(obj)) {
    // To the length it has now, as `JSON.stringify` reads it: an element that grows the array
    // while it is read adds nothing to what is written.
    const items: unknown[] = [], length = obj.length;
    for (let i = 0; i < length; i++) items.push(snapshot(obj[i], String(i), false, inside));
    out = items;
  } else {
    const members: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) {
      const member = snapshot((obj as Record<string, unknown>)[k], k, false, inside);
      if (member === undefined) continue;
      // Defined, never assigned: a member named `__proto__` is data here.
      Object.defineProperty(members, k, { value: member, enumerable: true, writable: true, configurable: true });
    }
    out = members;
  }
  inside.pop();
  return out;
}

/** What `unwritable` found, as the clause a refusal's message uses. */
export function unwritableClause(why: "integer" | "number"): string {
  return why === "integer"
    ? `an integer of more than ${MAX_EXACT_DIGITS} digits, which this writer does not write because it could not read it back`
    : "a number that is not finite (NaN or an infinity), which JSON cannot state and this writer does not write as null";
}

/** Plain data as JSON text, with no hook asked: `write` for a value `plain` has already taken. */
function write(value: unknown): string | undefined {
  if (typeof value === "bigint") return String(value);
  if (value === null || typeof value !== "object") return typeof value === "function" || typeof value === "symbol" ? undefined : JSON.stringify(value);
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let i = 0; i < value.length; i++) items.push(write(value[i]) ?? "null");
    return `[${items.join(",")}]`;
  }
  const members: string[] = [];
  for (const k of Object.keys(value)) {
    const member = write((value as Record<string, unknown>)[k]);
    if (member !== undefined) members.push(`${JSON.stringify(k)}:${member}`);
  }
  return `{${members.join(",")}}`;
}

/**
 * Whether the process has put a `toJSON` where `JSON.stringify` would look for one on plain
 * data: on `Object.prototype`, `Array.prototype` or `BigInt.prototype`. Asked with `in`, which
 * finds the property without evaluating it, so an accessor there is never run. (`in` follows
 * the chain, and both of the others inherit from `Object.prototype`.)
 */
function hookInstalled(): boolean {
  return "toJSON" in Array.prototype || "toJSON" in BigInt.prototype;
}

/**
 * The JSON text of plain data (`plain`'s result, or what `parseExact` returned): a `bigint` as
 * its exact digits, everything else as `JSON.stringify` writes it, and **no hook asked**. Plain
 * data has no hooks of its own, so the only ones `JSON.stringify` could find are on
 * `Object.prototype`, `Array.prototype` and `BigInt.prototype`; when the process has installed
 * one there, or the data holds a `bigint`, the text is written here and not by
 * `JSON.stringify`. The text is the same either way.
 */
export function exactText(value: unknown): string {
  if (!hookInstalled()) {
    try { return JSON.stringify(value) ?? "null"; } catch (e) { if (!(e instanceof TypeError)) throw e; /* a bigint */ }
  }
  return write(value) ?? "null";
}

/**
 * A value as JSON text: `plain`'s reading of it, written by `exactText`. `JSON.stringify`'s rules
 * with a `bigint` as its exact digits, never quoted and never rounded, whatever `toJSON` the
 * process has put on `BigInt.prototype`. `"null"` where `JSON.stringify` gives none. A value that
 * contains itself is a `TypeError`.
 */
export function exactJson(value: unknown, key = ""): string {
  return exactText(plain(value, key));
}
