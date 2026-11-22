// The token shapes `refuseSuspectedSecrets` refuses, as data (flyingrobots/parley#60).
//
// This list is the reviewable part of the built-in. It is data so that reviewing it is reading a
// table rather than reading code, so that a caller can replace it wholesale, and so that a new
// entry is one row plus the two samples the test walk demands.
//
// Three rules every entry holds to:
//
//   1. **Conservative and anchored.** A word boundary or a literal prefix at the start, and a
//      fixed length or a floor long enough that prose does not reach it. The cost of a false
//      positive is one withheld stream line, which is cheap but not free, and a shape that fires
//      on ordinary text would make the whole built-in something people switch off.
//   2. **A published shape, not a guess.** Each is a prefix a vendor assigns and documents, so
//      the match is evidence about the string's provenance rather than about its entropy. There
//      is deliberately no "40 hex characters" entry: it would refuse every SHA-1.
//   3. **Case-sensitive, matched against one string value at a time.** No flags are applied when
//      these sources are compiled, so there is no `g` and no `lastIndex` to carry between lines.
//
// What this list is not is complete. An unlisted shape passes, and that is stated rather than
// implied: this refuses what it recognises, and recognition is a floor, not a guarantee.

/** One reviewable token shape. */
export interface SecretPattern {
  /** The shape's name, as the warning reports it. Dot-separated, vendor first. */
  readonly name: string;
  /** The source of a `RegExp`, compiled with no flags. */
  readonly regex: string;
  /** One line: what it is, and why this shape can be refused on sight. */
  readonly why: string;
}

/** The shapes the built-in refuses when the caller names none of their own. */
export const SECRET_PATTERNS: readonly SecretPattern[] = Object.freeze([
  {
    name: "aws.access_key_id",
    regex: "\\bAKIA[0-9A-Z]{16}\\b",
    why: "An AWS access key id: the fixed AKIA prefix and exactly sixteen more upper-case base32 characters, a shape nothing else assigns.",
  },
  {
    name: "github.token",
    regex: "\\bgh[opsur]_[A-Za-z0-9]{36}\\b",
    why: "A GitHub personal access, OAuth, app, server or refresh token: one of six documented prefixes and exactly thirty-six more characters.",
  },
  {
    name: "github.fine_grained_pat",
    regex: "\\bgithub_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}\\b",
    why: "A GitHub fine-grained personal access token, whose two fixed-length segments make the whole string eighty-two characters after the prefix.",
  },
  {
    name: "slack.token",
    regex: "\\bxox[abpr]-[0-9A-Za-z]{8,}(?:-[0-9A-Za-z]{8,}){0,3}\\b",
    why: "A Slack bot, app, user or refresh token: the xox prefix, a type letter, and dash-separated segments no shorter than eight characters.",
  },
  {
    name: "google.api_key",
    regex: "\\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])",
    why: "A Google API key: the AIza prefix and exactly thirty-five more URL-safe characters, thirty-nine in all.",
  },
  {
    name: "pem.private_key",
    regex: "-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----",
    why: "A PEM private key header, in any of its labelled forms; the header alone means the body is in the same string or the next one.",
  },
  {
    name: "jwt",
    regex: "\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9_-])",
    why: "A JWT: three base64url segments, the first beginning eyJ because a JSON header always starts with an opening brace and a quote.",
  },
  {
    name: "http.bearer_token",
    regex: "\\bBearer\\s+[A-Za-z0-9._~+/=-]{20,}",
    why: "An Authorization header's value: the literal Bearer and at least twenty token characters, which is the generic case no vendor prefix catches.",
  },
  {
    name: "npm.token",
    regex: "\\bnpm_[A-Za-z0-9]{36}\\b",
    why: "An npm access token: the npm_ prefix and exactly thirty-six more characters.",
  },
  {
    name: "stripe.live_key",
    regex: "\\b(?:sk|rk)_live_[0-9A-Za-z]{10,}\\b",
    why: "A Stripe live secret or restricted key; the test-mode prefixes are deliberately not listed, because a test key is not a credential worth a gap.",
  },
] as const satisfies readonly SecretPattern[]);
