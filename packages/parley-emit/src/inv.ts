// `inv` (spec §2.2): the identity of a question. This package's derivation, which the spec asks
// every supplier to document:
//
//   inv = SHA-256 over the canonical JSON (keys sorted, no whitespace, UTF-8) of
//     { tool, v, command, resolved, inputs: [{ path, role?, sha256 }] }
//
// A `bigint` in `resolved` is canonical as its exact digits, the JSON number it is written as
// (flyingrobots/parley#171), so two questions that differ in an integer beyond the safe range
// have two identities. Every other value has the canonical form it always had.
//
// `resolved` is the interpretation after defaults, with every declared secret already replaced by
// `[redacted]`, so the fact of supply enters by name and the value never does; the input
// descriptors in the preimage are the redacted ones for the same reason. Input digests are over
// bytes, never paths alone; a `tree` input digests its regular files in sorted path order,
// skipping every `.parley` directory and every path under the declaration's `exclude` list. The
// working directory, the run id, the receipt path, the session and the clock are not in the
// preimage. If any declared input could not be read, there is no `inv`.
import { createHash } from "node:crypto";
import { plain } from "./exact.ts";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The canonical JSON of a value as the serialiser would write it (`plain`): a `Date` is its
 * string, a boxed number its number, and a function has no member. So the identity is of what
 * the receipt holds, and two values written differently are never one `inv`. `key` is the name
 * the value sits under, which a `toJSON` hook is called with; `""` for a whole document.
 */
export function canonical(v: unknown, key = ""): string { return canonicalPlain(plain(v, key)); }

/** `canonical` for a value that is plain data already (`plain`'s result): no hook is called. */
export function canonicalPlain(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonicalPlain).join(",") + "]";
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => JSON.stringify(k) + ":" + canonicalPlain(o[k])).join(",") + "}";
  }
  if (typeof v === "bigint") return String(v); // `String` asks no method of `BigInt.prototype`
  // `JSON.stringify` writes `null` for these, which would give `NaN` the identity of a real
  // `null` (flyingrobots/parley#177).
  if (typeof v === "number" && !Number.isFinite(v)) throw new TypeError("a number that is not finite (NaN or an infinity) has no canonical form");
  return JSON.stringify(v) ?? "null";
}

export function sha256(bytes: Uint8Array | string): string { return createHash("sha256").update(bytes).digest("hex"); }

export interface InputDecl { path: string; role?: string; /** Relative paths under a `tree` input to leave out of its digest, such as a credential file. */ exclude?: readonly string[] }
export interface InputDescriptor { path: string; role?: string; sha256?: string; error?: string }

export function computeInv(pre: { tool: string; v: string; command: string; resolved: unknown; inputs: InputDescriptor[] }): string | undefined {
  if (pre.inputs.some((i) => i.sha256 === undefined)) return undefined;
  return sha256(canonical({ tool: pre.tool, v: pre.v, command: pre.command, resolved: pre.resolved, inputs: pre.inputs.map((i) => ({ path: i.path, role: i.role, sha256: i.sha256 })) }));
}

/** `computeInv` for a preimage whose `resolved` is plain data already; the writer's own call. */
export function computeInvPlain(pre: { tool: string; v: string; command: string; resolved: unknown; inputs: InputDescriptor[] }): string | undefined {
  if (pre.inputs.some((i) => i.sha256 === undefined)) return undefined;
  return sha256(canonicalPlain({ tool: pre.tool, v: pre.v, command: pre.command, resolved: pre.resolved, inputs: pre.inputs.map((i) => ({ path: i.path, role: i.role, sha256: i.sha256 })) }));
}

function excluded(rel: string, exclude: readonly string[]): boolean {
  return exclude.some((e) => { const x = e.replace(/\/+$/, ""); return rel === x || rel.startsWith(x + "/"); });
}

/** Digest of a directory: SHA-256 over `relative-path NUL file-digest LF` for every regular file, sorted by path, skipping `.parley` directories and excluded paths. */
export function digestTree(root: string, exclude: readonly string[] = []): string {
  const files: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === ".parley") continue;
      const p = join(dir, name), r = rel ? `${rel}/${name}` : name;
      if (excluded(r, exclude)) continue;
      const st = statSync(p);
      if (st.isDirectory()) walk(p, r); else if (st.isFile()) files.push(r);
    }
  };
  walk(root, "");
  const h = createHash("sha256");
  for (const r of files) h.update(r + "\0" + sha256(readFileSync(join(root, r))) + "\n");
  return h.digest("hex");
}

/** Digest a declared input by role; an unreadable input yields an `error` code and no digest. A relative path is resolved against `cwd`; an absolute one stands. */
export function digestInput(cwd: string, input: InputDecl, supplied?: Uint8Array): InputDescriptor {
  const base: InputDescriptor = { path: input.path, ...(input.role ? { role: input.role } : {}) };
  try {
    if (input.role === "stdin") return supplied ? { ...base, sha256: sha256(supplied) } : { ...base, error: "input.unread" };
    if (supplied) return { ...base, sha256: sha256(supplied) };
    const p = resolve(cwd, input.path);
    const st = statSync(p);
    if (st.isDirectory() || input.role === "tree") return { ...base, sha256: digestTree(p, input.exclude ?? []) };
    return { ...base, sha256: sha256(readFileSync(p)) };
  } catch {
    return { ...base, error: "input.unreadable" };
  }
}
