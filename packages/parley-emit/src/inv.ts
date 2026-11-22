// `inv` (spec §2.2): the identity of a question. This package's derivation, which the spec asks
// every supplier to document:
//
//   inv = SHA-256 over the canonical JSON (keys sorted, no whitespace, UTF-8) of
//     { tool, v, command, resolved, inputs: [{ path, role?, sha256 }] }
//
// `resolved` is the interpretation after defaults, with every declared secret already replaced by
// `[redacted]`, so the fact of supply enters by name and the value never does. Input digests are
// over bytes, never paths alone; a `tree` input digests its files in sorted path order. The
// working directory, the run id, the receipt path, the session and the clock are not in the
// preimage. If any declared input could not be read, there is no `inv`.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
  }
  return JSON.stringify(v) ?? "null";
}

export function sha256(bytes: Uint8Array | string): string { return createHash("sha256").update(bytes).digest("hex"); }

export interface InputDescriptor { path: string; role?: string; sha256?: string; error?: string }

export function computeInv(pre: { tool: string; v: string; command: string; resolved: unknown; inputs: InputDescriptor[] }): string | undefined {
  if (pre.inputs.some((i) => i.sha256 === undefined)) return undefined;
  return sha256(canonical({ tool: pre.tool, v: pre.v, command: pre.command, resolved: pre.resolved, inputs: pre.inputs.map((i) => ({ path: i.path, role: i.role, sha256: i.sha256 })) }));
}

/** Digest of a directory: SHA-256 over `relative-path NUL file-digest LF` for every regular file, sorted by path. */
export function digestTree(root: string): string {
  const files: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name), r = rel ? `${rel}/${name}` : name;
      const st = statSync(p);
      if (st.isDirectory()) walk(p, r); else if (st.isFile()) files.push(r);
    }
  };
  walk(root, "");
  const h = createHash("sha256");
  for (const r of files) h.update(r + "\0" + sha256(readFileSync(join(root, r))) + "\n");
  return h.digest("hex");
}

/** Digest a declared input by role; an unreadable input yields an `error` code and no digest. */
export function digestInput(cwd: string, input: { path: string; role?: string }, supplied?: Uint8Array): InputDescriptor {
  const base: InputDescriptor = { path: input.path, ...(input.role ? { role: input.role } : {}) };
  try {
    if (input.role === "stdin") return supplied ? { ...base, sha256: sha256(supplied) } : { ...base, error: "input.unread" };
    if (supplied) return { ...base, sha256: sha256(supplied) };
    const p = join(cwd, input.path);
    const st = statSync(p);
    if (st.isDirectory() || input.role === "tree") return { ...base, sha256: digestTree(p) };
    return { ...base, sha256: sha256(readFileSync(p)) };
  } catch {
    return { ...base, error: "input.unreadable" };
  }
}
