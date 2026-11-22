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
