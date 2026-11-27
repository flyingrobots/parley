// A ULID: 10 characters of millisecond time and 16 of randomness, Crockford base32, so run ids
// sort lexicographically by creation time (spec §2.1).
const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(time: number = Date.now()): string {
  let t = Math.max(0, Math.floor(time));
  let head = "";
  for (let i = 0; i < 10; i++) { head = ENC[t % 32] + head; t = Math.floor(t / 32); }
  const rnd = crypto.getRandomValues(new Uint8Array(16));
  let tail = "";
  for (let i = 0; i < 16; i++) tail += ENC[rnd[i]! & 31];
  return head + tail;
}

/** The latest time a ULID's 48 bits of time hold: 2^48-1 ms, in the year 10889. */
export const MAX_ULID_TIME = 2 ** 48 - 1;

/**
 * The clock's reading when it is a time a run id can hold: an integer number of milliseconds from
 * 0 to `MAX_ULID_TIME`. Anything else it returns, and a throw, is not believed, and the system's
 * reading is used instead. Each reading is judged on its own and replaced without notice. This is
 * the one rule for every reading `main` and `Run` take: the run id, every `t`, the history
 * stream's day file and both retentions.
 */
export function readClock(clock: () => number): number {
  let t: unknown;
  try { t = clock(); } catch { return Date.now(); }
  return typeof t === "number" && Number.isSafeInteger(t) && t >= 0 && t <= MAX_ULID_TIME ? t : Date.now();
}
