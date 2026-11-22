// A built-in history transform (flyingrobots/parley#59): keep a declared set of strings off the
// shared timeline that are fine in a local receipt and wrong on a stream other people and tools
// read — a username in a path, a hostname, a private repository name. Without a built-in, every
// caller writes the same scrubbing function, and most get longest-first replacement or key
// renaming subtly wrong (spec §5.3). This is the same code path the receipt's own redaction uses,
// applied to the body alone with a second declared set, so its behaviour on nested keys,
// longest-first order and key renaming is already specified and tested in redact.ts.
import { DIGEST_KEYS } from "../run.ts";
import type { HistoryTransform } from "../history.ts";
import { scrub } from "../redact.ts";

/**
 * A projection that scrubs `values` out of the stream copy's body, exactly as spec §5.3 scrubs a
 * declared secret: longest value first, so one value that contains another is replaced whole, and
 * a key that carries a declared value is renamed. The envelope — `event`, `t`, `seq`, `run` and
 * `_schema` — is never its to touch; it is read off the record and put back untouched, before the
 * writer reattaches its own anyway (§1.3).
 *
 * This runs on whatever record the receipt holds, which may be a writer-built one (`receipt.head`,
 * `end`) and not only a tool's own. A writer-built record's own identity scalars — `tool`, `v`,
 * `inv`, `sha256`, `name`, `id`, `version`, `code` — carry no pattern a validator would reject a
 * corrupted one by, so a declared value that happens to coincide with, say, the tool's own name
 * would otherwise silently rename `tool` on the stream's head with nothing to catch it (the same
 * reason `src/run.ts` exempts these keys, `DIGEST_KEYS`, from the receipt's own redaction of a
 * writer-built record). This exempts them here too, at any depth, the same way.
 *
 * An empty declared set is the identity transform, and this returns `undefined` for it rather
 * than a function that merely behaves like one: `MainOptions.history.transform` is then itself
 * `undefined`, the writer never builds a projection for it, and the stream copy carries no
 * `parley.history.transform` opening line at all — the run that existed before the transform did
 * (§8, informative). The alternative, an identity function, would still open the stream with a
 * transform line; this package chooses no line over an inert one.
 *
 * The transform's name on that opening line is always `declaredProjection`, whatever `values`
 * holds, because the returned function is declared with that name rather than built by string
 * assembly. The digest the line also carries is a SHA-256 of the function's *source text*
 * (`fn.toString()`), and `values` reaches this function only as a closed-over variable — never
 * interpolated into the source — so the digest, the name and the line itself disclose nothing
 * about what was declared.
 */
export function declaredProjection(values: readonly string[]): HistoryTransform | undefined {
  const declared = new Set(values);
  if (declared.size === 0) return undefined;
  return function declaredProjection(record: Record<string, unknown>): Record<string, unknown> {
    const { event, t, seq, run, _schema, ...body } = record;
    const scrubbed = scrub(body, declared, "", [], { skipKeys: DIGEST_KEYS }) as Record<string, unknown>;
    return { event, t, seq, run, ...scrubbed, _schema };
  };
}
