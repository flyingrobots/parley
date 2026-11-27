# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This package is versioned
on its own; the spec and each message schema move separately (spec §4.4).

## [Unreleased]

## [0.5.0] — 2026-11-24

This version is in the repository only: it is not tagged and not published. The heading is dated
because the repository's checks require a dated heading for the manifest's version.

The writer accepts a `bigint` in a payload and writes it as a JSON number of exact unquoted
digits, everywhere a record travels (flyingrobots/parley#171). Before, a record holding one threw
`TypeError: JSON.stringify cannot serialize BigInt.` and the run ended with `uncaught.exception`
and status 2, so a TypeScript tool had no exact numeric form for an integer beyond the safe range
(a 64-bit id) and had to round it or write a string. (In a process that had installed a `toJSON`
on `BigInt.prototype` it did not throw: the `bigint` was written as whatever that hook returned.
See the second breaking change below.)

**What does not change.** A record of plain JSON data (objects, arrays, strings, booleans, `null`
and finite numbers) is written with the bytes it had, and a `resolved` of plain JSON data keeps
its `inv`. `test/fixtures/inv-pinned.jsonl` holds 25 identities printed from the 0.4.0 source,
and a test requires this source to reproduce 24 of them. The twenty-fifth is withdrawn: a number
that is not finite, which is now refused.

**What breaks.** Seven things, each described under Changed or Fixed below:

1. **`NaN`, `Infinity` and `-Infinity` are refused** (flyingrobots/parley#177). A tool that emits
   one today gets a `TypeError` where it got a `null`.
2. **A `toJSON` on `BigInt.prototype` is never asked.** A process with the common polyfill
   (`BigInt.prototype.toJSON = function () { return this.toString(); }`) had its `bigint`s
   written as quoted strings by 0.4.0, with status 0. They are now written as numbers:
   `"id":"9007199254740993"` becomes `"id":9007199254740993`. Pass `String(id)` to keep a string.
3. **The `inv` moves for a `resolved` that is not plain data**: one holding a `Date` or another
   value with a `toJSON` hook, a boxed primitive, or a function or symbol as a member's value.
4. **A history transform is handed a `bigint`** for any integer the receipt writes beyond the
   safe range, including one the tool passed as a `number` (`2 ** 53`, `1e21`). A transform that
   does number arithmetic on such a field throws, and its line is withheld from the stream as
   `history.transform_failed`; the exit status does not change.
5. **A result whose event name carries a declared secret, and a page record that carries an
   `event`, are refused** with a `TypeError`.
6. **A `--human` renderer receives a copy**: one that relied on changing the record it was handed
   to change the receipt no longer does.
7. **A record with a secret present is written as the same record without one.** 0.4.0 wrote a
   `Date` or a boxed primitive as `{}` beside any secret, and dropped a member named `__proto__`.

### Added

- **A `bigint` is written exactly**, on stdout, on stderr, in the receipt, in a sidecar and on the
  shared history stream: `9007199254740993n` is `9007199254740993`, never a quoted string and
  never with an `n`. Every sink's copy comes from one serialiser, and stdout and the receipt hold
  the same digits. A `bigint` inside the safe range is the same JSON number a number is: `5n` is
  `5`. It is accepted anywhere a record carries a value: a result, a page, a step's `detail`, a
  diagnostic's `detail`, `receiptExtra`, and `resolved`.
- **`exactText`**: the JSON text of plain data (what `parseExact` returned, or `plain` data built
  by hand), written with no `toJSON` hook asked, so nothing a process has installed on
  `Object.prototype` or `Array.prototype` changes it. `exactJson` takes a value as
  `JSON.stringify` would, hooks applied, and writes that.
- **`parseExact`, `exactJson`, `holdsExact`, `MAX_EXACT_DIGITS`, `UNREPRESENTABLE`** and the types
  `ExactParse` and `ExactValue` are exported. `exactJson(value)` is `JSON.stringify` with a
  `bigint` written as its digits. `parseExact(text)` reads JSON text with every number's value
  kept: an integer-valued number from -9007199254740991 to 9007199254740991 is a `number` however
  it is spelt (`5`, `5.0`, `5e0`, `1e3`), and outside that range it is a `bigint`, decided from
  the text (`9007199254740993.0`, `9.007199254740993e15`, `1e400`). A number that is not an
  integer is a `number` only when its decimal value equals that of the number's standard JSON
  serialisation (flyingrobots/parley#173): `0.1`, `0.10` and `1e-1` are accepted,
  `0.10000000000000001` is not. For a text holding a number it cannot hold, `parseExact` returns
  `ok: false` with the numbers as written, and never a rounded value. An integer of more than
  4,096 digits (`MAX_EXACT_DIGITS`, an implementation limit) is one of those. The reader
  imports these and has no copy of its own.
- **`inv` and `canonical`** write a `bigint` as its digits, so two questions that differ by one
  beyond the safe range have two identities. `resolved` may hold a `bigint`.
- **Redaction.** A `bigint` whose digits are a declared secret is replaced with `[redacted]`, as
  a number already was; one beside another redacted field is written exactly.
- **The post-redaction check and `checkRecord`.** A `bigint` is a JSON number and an integer.
  `type`, `const`, `enum`, `minimum`, `maximum`, `exclusiveMinimum` and `exclusiveMaximum` are
  decided for it by exact comparison, never on a converted double. One case cannot be decided: an
  integer beyond the safe range against a schema number that is itself beyond the safe range,
  which may be a rounded reading of the schema's text (`maximum: 18446744073709551615` loads as
  18446744073709551616). There `checkRecord` answers `unsupported`, and a record redaction
  changed is withheld as `redaction.schema_unchecked`, which means not checked and does not say
  the record was invalid.
- A shared numeric corpus, `conformance/numbers/` at the repository root: 50 JSON texts with the
  exact value and the emitted text of each. This package's suite runs every case through a real
  run, and the Python writer's suite runs the same file.

### Changed

- **BREAKING: a number that is not finite is refused, never written as `null`**
  (flyingrobots/parley#177). Before, `NaN`, `Infinity` and `-Infinity` were written as `null` on
  stdout, in the receipt and in the canonical form `inv` is computed over, with no warning and
  status 0: `JSON.stringify`'s behaviour, inherited since 0.1.0. A receipt then stated a `null`
  the tool never handed over, and two questions whose `resolved` differed only in `NaN` against
  `null` shared one `inv`. Now, at any depth, behind a `toJSON` hook or boxed:
  - an emitting call throws `TypeError` before a `seq` is taken, so nothing is written and no
    gap is left; uncaught in the handler it is `uncaught.exception` and status 2, as in
    `parley_emit.py`, which has always refused these;
  - `resolved` holding one is `startup.arguments_invalid`, status 3;
  - a history transform's body holding one is withheld as `history.transform_invalid`;
  - `canonical` and `computeInv` throw `TypeError`.

  The refusal is of what the serialiser would write and nothing else: a hook is called with its
  key, a field a hook leaves out is not read, and properties hung on a boxed primitive or a
  function are not read. A value whose own `toJSON` returns `null`, such as an invalid `Date`,
  is still `null`: that is what the value says of itself. A boxed primitive is recognised by
  what it holds, so one made in another realm (a `vm` context) is its primitive too, here and in
  redaction; before, redaction with a secret present wrote such a box as `{}`. This holds on Bun
  1.2.0 as well, where `node:util`'s `types.isBigIntObject` does not recognise a boxed `bigint`
  from another realm and the writer asks the value directly. To migrate, decide what the tool means: leave the field out,
  write `null` yourself, or carry the value as a string.
- **BREAKING for an `inv`: `resolved` is identified as it is written** (review of
  flyingrobots/parley#181). `resolved` is taken once as the serialiser would write it (`toJSON`
  applied, a boxed primitive as its primitive, no member for a function), and the head, the scrub
  and `inv` all use that one form; `canonical` does the same for any value. Before, `inv` was
  computed over the object's own keys while the head wrote the hook's result, so a `Date` in
  `resolved` was `{}` to `inv`: two questions with different dates shared one identity, and a
  reader could not recompute the `inv` from the head. The `inv` moves for a `resolved` that holds
  a value with a `toJSON` hook, a boxed primitive, or a function or symbol as a member's value.
  It does not move for plain JSON data: the 24 pinned identities are unchanged. A `resolved` that
  is not an object once written (a resolver that returns a `Date`) is `startup.arguments_invalid`;
  the head's schema never allowed it.
- A startup refusal over `resolved` closes the history stream the run had opened; before, the
  descriptor stayed open for the life of the process.
- **A history transform is handed exact values.** The receipt line is parsed with `parseExact`
  before the transform runs, and its result is written with `exactJson`. A transform therefore
  receives a `bigint` for any integer the receipt writes beyond the safe range, including one the
  tool passed as a number: `2 ** 53` and `1e21` arrive as `9007199254740992n` and `10n ** 21n`,
  where 0.4.0 handed over numbers. A transform that does arithmetic on such a field with a number
  now throws, and the line is withheld as `history.transform_failed`. The stream copy of `1e21`
  after a transform is `1000000000000000000000`, the same value as the receipt's `1e+21`. A
  transform may return a `bigint`; 0.4.0 withheld such a line as `history.transform_failed`.
- **A `bigint` of more than 4,096 digits is refused**: the emitting call throws `TypeError`
  before a `seq` is taken and nothing is written, `resolved` holding one is
  `startup.arguments_invalid` (exit 3), and a transform's body holding one is withheld as
  `history.transform_invalid`. The writer does not write a number its own parser could not read
  back. Carry such a value as a string.
- `run.end` refuses a `bigint` status with a `TypeError` that says so. `seq`, `t` and `status`
  stay numbers.
- Captured console output of an object holding a `bigint` keeps its JSON form with exact digits,
  where it was `[object Object]`.
- A new warning code, `history.number_unrepresentable`: receipt text holding a number the writer
  cannot hold exactly is not handed to a transform and not appended past it. No emission writes
  such text; the code exists so that a rounded value cannot reach a transform by a path nobody
  has found.

### Fixed

- **A declared secret that only a `toJSON` hook returns is now replaced** (flyingrobots/parley#178).
  PRIVACY. With a secret present, the scrub copied each object from its own keys. An object's own
  `toJSON` was copied across with them and called by the serialiser after the scrub, and an
  inherited one was lost, so the secret a hook returned was never looked at: `{ url: new URL(...) }`
  with the secret in the URL, or `{ token: { toJSON: () => secret } }`, was written to stdout and
  the receipt with status 0. Measured on the published 0.4.0 from npm, and present by inspection
  in every earlier version. What is scrubbed is now what is written: a hooked value is scrubbed
  as what its hook returns, once, and a boxed primitive as its primitive.
- **A `Date`, or another value whose JSON form is inherited, is no longer written as `{}` when a
  secret is present** (flyingrobots/parley#178). The same copy dropped an inherited `toJSON` and
  unboxed nothing, so with any secret supplied `new Date(0)` was written as `{}` and
  `new Number(5)` as `{}`, where a run with no secret wrote `"1970-01-01T00:00:00.000Z"` and `5`.
  A record now says the same thing with a secret present as without.
- **PRIVACY: a history transform could put a declared secret on the shared stream when the
  secret holds a character JSON escapes** (review case 2026-11-25): a quote, a backslash, a
  newline or another control character, so a PEM key or a password with `"` in it. The guard
  behind `history.transform_unredacted` searched the body's JSON text for the secret, and there
  those characters are escaped, so it was never found; the line was appended with no warning and
  status 0. Present in 0.4.0 and earlier. The guard now looks where the scrub looks, in the
  body's values and keys, and in the text as well. The receipt, stdout and stderr were not
  affected. The text search is wider than the scrub for numbers: a number the transform changed
  or added whose digits contain a declared secret is withheld here, though in a record the scrub
  replaces a number only when its whole decimal form is the secret. Since flyingrobots/parley#186
  (below) an occurrence inside a leaf or member name the transform left as the receipt line had
  it, at the same place, is the line's own and does not withhold the line; everything else in the
  body's text is still searched.
- **A payload is read once** (review case 2026-11-25). The writer takes one snapshot of a payload
  as it would be written (`plain`: hooks applied, boxes opened, functions gone) before it is
  refused, scrubbed, checked or given a `seq`, and every sink is written from that snapshot by a
  serialiser that asks no hook. Before, the guard, the scrub and two serialisers each read the
  payload by their own rules, and with no secret present each sink read it again. So a `NaN`
  behind some hook shapes was written as `null` when a `bigint` sat beside it, a hook that
  answered differently the second time defeated the refusal, and a serialiser's throw came after
  a `seq` was taken and left a gap. Now a `toJSON` hook or a getter is called once per emission
  whatever the sinks, the same bytes are written with a `bigint` or a secret beside a value as
  without, and a record that contains itself is a `TypeError` before a `seq` is taken.
- **A `toJSON` on `BigInt.prototype` is never asked**, by the serialiser, the scrub or `inv`
  (review case 2026-11-25). A `bigint` is its exact digits whatever the process has installed.
  This removes the limit recorded on 2026-11-25 as flyingrobots/parley#180, where a `bigint` a
  payload hook returned was written through that prototype hook after the scrub. A boxed
  `bigint` is asked only for a `toJSON` of its own.
- **PRIVACY: three more ways a declared secret could be written, each present in 0.4.0 and
  earlier** (fresh review pass, case 2026-11-25):
  - *A secret that JSON escapes, in text the writer itself encodes.* Captured console output of
    an object (`console.log({ key })`) and a transform's refusal quoted in a warning are encoded
    as JSON text by the writer and then scrubbed as text, where a quote, a backslash or a newline
    in the secret is escaped and the secret was not found. The escaped spelling of each declared
    value is now a declared value too.
  - *A result's event name.* The event name is envelope and is never scrubbed, so
    `run.result({ event: secret })` wrote it. A tool's record whose event name carries a declared
    value is now refused with a `TypeError` before a `seq` is taken, as a session id is refused.
    `run.page` refuses a record that carries an `event` of its own; before, that `event`, of any
    type, replaced `page` on a line stamped `parley.page`.
  - *A history transform's name, and a thrown error's `stack` that is not text.* The name was
    written unscrubbed on the stream's opening line; it is scrubbed like any other text of the
    tool's. An error whose `stack` is an object was recorded under `detail.stack`, where
    members named `name`, `code` or `id` are not scrubbed; a `stack` is now recorded only when
    it is a string.
- **`inv` is the identity of `resolved` as the head writes it when a secret is a piece of the
  text `[redacted]`.** The head scrubbed `resolved` a second time, which rewrote the marker
  itself (`x-[[redacted]acted]-y`), so the head stated a `resolved` that was not the preimage of
  its `inv`. Present in 0.4.0. `resolved` is scrubbed once.
- **A `--human` renderer is handed a copy of the record.** It was handed the object the receipt
  and the stream were then written from, so a renderer that sorted an array in place, or
  assigned to its argument, changed what they held after every check, and one that set `status`
  on the `end` line changed the recorded status. Present in 0.4.0.
- A diagnostic passed to `warning` or `error` is read once, so the `code` that is checked is the
  `code` that is written; its getters were read twice.
- A `bigint` is its digits whatever the process has put on `BigInt.prototype`: `toString` and
  `valueOf` there are not asked either. (A `valueOf` installed before this package is loaded
  still opens a boxed `bigint`; a primitive is unaffected.)
- A clock that answers with something that is not a time (an injected `now` returning `NaN`) no
  longer puts `"t":null` on a line: the system clock's reading is used.
- Captured console output of a number that is not finite is its name (`NaN`, `Infinity`), as the
  console prints it; it was `null`. Inside a logged object it is still `null`: that text is the
  object's JSON form.
- **A history transform's line is no longer withheld as unredacted for a declared value the
  receipt line holds where the transform left it** (flyingrobots/parley#186, flyingrobots/parley#164). The
  guard withheld any line whose body matched a declared value, including one the writer's own line
  holds: with a secret equal to `false`, or to a field name such as `network`, an identity
  transform lost the head from the stream, and the warning said the writer "had already
  replaced" a value it had not. The guard now compares each member of the body with the receipt
  line's member at the same place: object members by name, array elements by index. A leaf with
  the same JSON text as the line's leaf at that place, and a member name the line's object there
  also has, is unchanged: the line's own. The body's whole JSON text is still searched, as
  before, for every declared value in every spelling the writer recognises (JSON-escaped
  included), structure included; an occurrence is excused only when it lies wholly inside the
  text of one unchanged leaf or member name. So a place that held a declared value may hold only
  that value afterwards, and no occurrence elsewhere in the line covers a new one. Any other
  occurrence withholds the line: in a changed or added leaf, member or element; across several of
  them and the structure between them; across a changed piece and the unchanged text beside it;
  or at a joint between unchanged members that a dropped member or a new order brought together.
  Changed strings, added member names and added subtrees are also searched as the scrub looks, by
  their raw values and keys. A declared value holding JSON punctuation (`","`) that spans
  structure in the receipt line itself is not inside one leaf or name, so that line is withheld
  even by an identity transform, as it was before. A value moved to another place is withheld. An array element that
  an earlier element's removal shifted to another index counts as changed, so it is withheld when
  it carries a declared value, the line's own included (flyingrobots/parley#205). The warning says
  the body carries a declared value outside the leaves and member names the transform left as the
  receipt line had them.
- **A member named `__proto__` is no longer dropped when a secret is present.** The scrub's copy
  assigned it, which set the copy's prototype instead of a member; so a record relayed from
  parsed JSON lost it beside any secret, and two `resolved` values differing only there shared
  an `inv`. Present in 0.4.0 and earlier.
- A function in a payload is scrubbed as the serialiser would write it: one with a `toJSON` hook
  as what the hook returns, and one without, or one a hook returned, as nothing. Nothing callable
  is left in the scrubbed copy for the serialiser to call afterwards.

### Not changed, and stated

- `retain`'s reads of another receipt's first and last line use `JSON.parse`: they read `event`
  and `tool`, which are strings, and no number.
- A schema document that itself holds a `bigint` bound is outside the checker's subset
  (`maximum that is not a number`), so a redacted record under it is `redaction.schema_unchecked`.

## [0.4.0] — 2026-11-24

The writer no longer publishes a record that redaction made invalid under its declared schema
(flyingrobots/parley#131, spec §5.3). **A run that used to end with status 0 and an invalid line
now ends with status 4 and a structured error**, which is the point of the change. **BREAKING for a tool whose declared schema uses a keyword outside the writer's checker:** any
redaction in a record of that type now withholds the record, with status 4, even when the
redacted record would still have been valid (flyingrobots/parley#144; the second entry under
Fixed).

An upgrade from 0.2.4, the last version npm serves, also takes the 0.3.0 changes, one of which is
marked BREAKING there.

The schemas it ships are released: `parley.query` and `parley.lens` are the 1.1.0 that spec
`0.2.1` released (the root `CHANGELOG.md`), in place of 1.0.0, pinned to the commit of that release.
The writer stamps neither message, so no emitted line changes.

### Fixed

- **A record redaction made invalid is never published.** When a result's integer field equalled
  a declared secret, the writer replaced it with the string `[redacted]`, published the record
  under its original schema and ended with status 0; a string field with a `pattern`, an `enum`,
  a `format` or a length bound broke the same way, and so did a tool's own `error` whose `code` or
  typed field the secret landed in. A tool's record in which the scrub replaced something is now
  validated, as stdout or stderr and the receipt would each receive it (`receiptExtra` included),
  against the schema document for its declared pair, before any copy is written and before a
  `seq` is taken. When the redaction made it invalid, nothing of the record is written anywhere
  and the counter has no gap. The writer emits one `error` with the code
  `redaction.schema_conflict`, whose `problem` and `detail` (`{schema: {id, version}, at,
  redacted}`) name each field by JSON Pointer and the schema pair. It carries no value, no text
  from the checker and no part of the schema. The call throws `ParleyRedactionConflict`, which
  `main` does not report a second time, and the run ends with status 4 whatever the handler
  passes to `end`, by the mechanism a sink failure uses.
- **BREAKING for a tool whose declared schema uses a keyword outside the writer's checker: any
  redaction in a record of that type now withholds the record** (spec §5.3, decided on
  flyingrobots/parley#144). The trigger, exactly: the scrub replaced
  something in a record the tool emitted, and the schema document declared for its pair uses any
  keyword the checker does not evaluate (`format: "date-time"`, `multipleOf`, `uniqueItems`, a
  `$ref`, even an empty `$defs`). The record is withheld even when the redacted record would
  still have been valid, for example a token inside an unconstrained string. Before, the writer
  skipped the check and published such a record with status 0, which is how
  `"value":"[redacted]"` went out under a schema requiring an integer. Now nothing of it is
  written, no `seq` is taken, one `error` with the code `redaction.schema_unchecked` and `detail`
  `{schema: {id, version}, redacted}` is reported, the call throws `ParleyRedactionUnchecked` and
  the run ends with status 4. The code means **not checked**: it does not say the record was
  invalid, and no secret was exposed, since the value was replaced first. The construct the
  checker could not evaluate is part of the schema, so it is on the exception (`construct`) and
  never on the line.
- The two remedies: keep the declared schema within the keywords the checker evaluates, which
  [the README lists](README.md#a-record-redaction-made-invalid), or keep declared secrets out of emitted records. Deleting
  the `schema` document from the declaration removes the refusal **and** the check together (the
  spec's exemption for a program that holds no schema document), so it is not a fix.
- Scope, stated: only a record the scrub changed is checked. A record that was already
  invalid in the same way and a record of a type declared with no `schema` document, which spec
  §5.3 exempts, are written as before. Writer-built records (the head, `end`,
  `redaction`, `sidecar`, `receipt.inputs`, discovery lines, the writer's own warnings and its
  redaction errors) are never checked. They stay valid because their scrub is narrower, and this
  is exactly what it leaves alone: the envelope; field names; numbers and booleans; the strings
  under `sha256`, `inv`, `tool`, `v`, `name`, `id`, `version`, `code`, `op` and `error`; the
  head's `redacted` object, written as built; and a `schema` line's document. Every other string
  in a writer-built record is scrubbed (the next entry).
- `run.error` marks the run as having reported an error once the line is out, not before, so an
  error the writer refused does not count as reported.
- **A schema the checker cannot evaluate is `redaction.schema_unchecked`, whatever makes it
  unevaluable** (spec §5.3). The rule above held for a keyword outside the subset. A `pattern`
  the engine could not compile, or a keyword whose value had the wrong shape (`enum: 5`), threw
  out of `checkRecord` instead, and the run ended with `uncaught.exception` and status 2. Now
  each is the checker's `unsupported` result: a keyword whose value has the wrong shape; a
  `pattern` the runtime rejects as ECMAScript with the `u` flag; and a `pattern` with an
  inline-flag group (`(?i)`, `(?i:…)`), which engines differ on. A redacted record under such a
  schema is withheld with status 4, a record the scrub did not change is written as before, and
  a history projection under one is `history.transform_uncheckable`. `checkRecord` no longer
  throws for any schema document. **Changed with it:** a pattern is compiled with the `u` flag
  only, as JSON Schema reads it; one that compiled only without it, such as `\-` outside a
  class, used to be evaluated and is now unevaluable.
- The two writers can differ on which schemas they can evaluate, and each refuses what it cannot.
  This writer evaluates `\p{Lu}`, a named group, a back-reference and a lookbehind of any width,
  which the Python writer reports as `redaction.schema_unchecked`. Where both evaluate a schema
  they give the same verdict; a test compares them over 96 patterns and 51 malformed or
  well-formed keywords.
- **The protocol's own words in a writer-built record are never scrubbed** (spec §5.3). With
  a declared secret whose value was `create` or `delete`, `--help` and `--schema` published a
  `parley.command` line whose `effects.bookkeeping[].op` had become `[redacted]`, which the
  released schema rejects, with exit status 0. The same coincidence reached further: a secret
  equal to a field name (`paths`, `tool`, `status`, `op`, `inputs`) renamed that field in the
  bootstrap line, the head, `end` or a discovery line; `input` or `unreadable` broke the `error`
  token of `receipt.inputs`; and a secret equal to a recorded JSON Pointer broke the head's
  `redacted.resolved`. Now a writer-built record keeps its field names, a bookkeeping `op`, an
  input's `error` token and the head's `redacted` pointers whatever the secret is. They are
  public words of the protocol, so nothing a tool supplied is exposed; a secret's value is
  still replaced wherever it is the tool's data, in those same records. Every line of every run
  under 46 such secrets, with `--help`, `--schema` and an ordinary command, validates against
  its released snapshot.
- `run.inputUnreadable(path, code)` records `input.unreadable` in place of a `code` that carries a
  declared secret value, since a code is never scrubbed. The `schema.unavailable` warning of
  discovery is writer-built, as the writer's other warnings are.
- Not changed, and stated: an input's `role` is the tool's declaration and is scrubbed, so the
  secret `stdin` gives a `role` of `[redacted]`, which its schema accepts.
- **A record the writer raises on its own account is writer-built, and `main` always ends the
  run** (flyingrobots/parley#161, spec §3.3, §5.3). `uncaught.exception`, the retention and
  history-retention steps, the projection step and the captured-console step travelled as a
  tool's records do, so a declared secret equal to one of their field names renamed the field
  and the redaction check refused the record. With `--token decision` or `because` a run that
  captured a console line lost the step and ended with status 4, and a run that triggered
  retention rejected with no `end`, since that call was outside any handler; with `remedy`,
  `detail` or `stack` the record was published with that key renamed to `[redacted]`. With
  `--token code`, `problem` or `uncaught.exception` and a handler that threw, the report threw
  `ParleyRedactionConflict` from inside `main`'s own catch block: `main` rejected, and the last
  line on stdout was the bootstrap line. Now those records are emitted through `writerError`
  and `writerStep`: their field names and the writer's own `code` stay, and every string in
  them is still scrubbed, the exception's name, message and stack, a captured line and a file
  name included. A step or error the tool emits is unchanged: it is the tool's record, scrubbed
  in full and checked, so `run.step` under `--token decision` is still withheld with status 4.
- **`main` never rejects once the receipt is reserved.** Everything after that point runs
  under one handler. A failure of the writer's own is a new `error`, code
  `uncaught.writer_failure`, with status 2, as the Python writer already reports it; before, it
  was a rejected promise and no `end`. When the report of a failure cannot itself be built or
  written (a thrown value that throws when it is described), the run still ends, with status 4:
  the run failed and the error that says why could not be written, which spec §3.4 gives to 4,
  not to the 2 of a failure that was reported.
- **The redaction exceptions carry what the published line carries, never the secret.** When a
  declared secret was the name of a required property, the scrub renamed the key, the checker
  reported the property it then missed by its JSON Pointer, and `ParleyRedactionConflict` carried
  that pointer, which is the secret, in `pointers` and in its message, while the error line
  showed `/[redacted]`. The READMEs called both safe to log. With a secret holding `/` or `~`
  the line itself carried the pointer's escaped form of it (`a~1b` for `a/b`). Now each pointer
  is scrubbed token by token, as the key it stands for, before it goes anywhere, and the
  exception's message and `pointers` (and `ParleyRedactionUnchecked`'s `redacted`) are the
  line's `problem` and `detail`, scrubbed as the line is. The receipt records the replacement in
  the error line with `redaction` events, as before.
- **A `.parley/.gitignore` negation the writer cannot evaluate exactly counts as one that
  matches** (spec §5.2). The check for a negation that can re-include `receipts/` read a bracket
  expression holding a POSIX class, such as `![[:alpha:]]eceipts`, as a different pattern, read
  `![^]]eceipts` as one that cannot match, and compared a line holding a NUL byte whole where git
  stops at the NUL. With `*` and `!*.jsonl` beside any of those, the receipt stayed under
  `.parley/receipts/` and `git add` staged it. The rule now, the same in the TypeScript and the
  Python writer: a line holding a NUL byte, and a negation holding an inner `/`, a backslash, any
  character outside printable ASCII, or a bracket expression that is unterminated or holds `[:`,
  `[=` or `[.`, is not evaluated and sends the receipt to the state directory with the
  `receipt.relocated` warning. Everything else is matched as git's wildmatch reads one path
  component, ignoring case. This relocates for a few lines git would not match (`!receipts`
  followed by a tab, `!receiptſ`), which is the direction the spec asks for. The cases run real
  git as the oracle.

### Added

- `ParleyRedactionConflict` (with `schema` and `pointers`), `REDACTION_CONFLICT_CODE` and
  `run.redactionRefused`.
- `ParleyRedactionUnchecked`, a `ParleyRedactionConflict` with empty `pointers`, `redacted` and
  `construct`, and `REDACTION_UNCHECKED_CODE`.
- `checkRecord` returns `pointers` beside `errors` when a record fails: the JSON Pointer of each
  error, in the same order, and for a missing or disallowed property, that property. A key
  containing `/` or `~` is now escaped in the path an error names (RFC 6901).

### Changed

- `src/schemas.ts` holds `parley.query` 1.1.0 and `parley.lens` 1.1.0 (flyingrobots/parley#133),
  as released with spec `0.2.1`, in place of 1.0.0. The writer stamps neither message, so no
  emitted line changes.

## [0.3.0] — 2026-11-24

A declared file input can be read through the run, so the receipt records the bytes the tool read
(flyingrobots/parley#132), and a `receiptExtra` field can no longer contradict the record
(flyingrobots/parley#130). No change to the spec or to the schemas the package ships.

This version was tagged (`parley-emit-v0.3.0`) and has a GitHub release carrying its tarball. Its
npm version was staged by the release workflow; npm does not list it. 0.4.0 supersedes it.

### Added

- **`run.readInput(path)`**. It reads a declared file input, returns the bytes as a `Buffer`, and
  records the SHA-256 of exactly those bytes, taken at the read. `receipt.inputs` and `inv` then
  describe what the tool consumed, whatever the file holds when the run ends. The path is resolved
  as the declaration is, against the run's `cwd` when relative. A file that cannot be read is
  recorded as `run.inputUnreadable` records it, and the file system's error is thrown. It throws
  `TypeError` for a path that is not a declared input, for a `stdin` or `tree` input, and after
  the inputs are settled.

### Changed

- The README and the living reference present `run.readInput` as the way to read a declared file
  input, with a captured run of a tool that edits its input in place.

### Fixed

- A tool that reads a declared file and then rewrites it had no single step that recorded the
  bytes it read: the writer digested the file when the handler finished, so the receipt and `inv`
  described the rewritten file. `run.readInput` is that step. **The default path is unchanged**: a
  declared file the tool does not read through the writer, and does not supply with `run.input`,
  is still digested when the inputs are finalised, and can describe bytes the tool did not read.
  The documentation now says so. A tool gets the fix by calling `run.readInput`.
- **A `receiptExtra` field can no longer contradict the record** (flyingrobots/parley#130).
  `run.result({ value: 1 }, schema, { value: 2 })` used to put `1` on stdout and `2` in the
  receipt under one `seq`, against spec §1.3 (copies agree on every field they share). The call now
  throws `TypeError` before either copy is written. Equal shared values are accepted and written
  from the record; receipt-only fields are unchanged. **BREAKING for a tool that relied on the
  overwrite**, which was already non-conforming.

## [0.2.4] — 2026-11-23

No change to the library or the schemas it ships.

### Fixed

- The release workflow's `sanity` job installs the pinned Wesley, as the checks workflow does. The
  suite fails under CI without it (flyingrobots/parley#118), so the `parley-emit-v0.2.3` tag
  stopped at `sanity` and nothing was released or staged. This is the first version staged on npm.

## [0.2.3] — 2026-11-23

No change to the library or the schemas it ships. This version exists so that a tag carries the
new release workflow.

### Changed

- **Releases are staged, then approved by the owner** (flyingrobots/parley#85). The release
  workflow runs `npm stage publish` in place of `npm publish`: the npm trusted publisher is allowed
  to stage and nothing else, and a version becomes installable only when the owner approves it with
  two-factor authentication. 0.2.0, 0.2.1 and 0.2.2 never reached npm for that reason.

## [0.2.2] — 2026-11-22

Retention's rule for a receipt that may still be being written is now the spec's (§5.1,
flyingrobots/parley#112). The behaviour and the schemas it ships are unchanged.

### Changed

- **No lock protocol: an incomplete receipt is exempt from retention until it has gone unmodified
  for 24 hours.** This is the decision on flyingrobots/parley#112. A receipt whose last line is not
  `end` is kept, and a complete receipt is deleted in its place. Past 24 hours with no write, its
  run is treated as crashed. A complete receipt cannot be appended to (§3.3), so deleting it races
  no writer. The window that remains is accepted: a run silent for over a day that appends while
  retention deletes its receipt loses it. New injected-clock tests pin each case (PE-16d to PE-16f).

## [0.2.1] — 2026-11-22

Fixes for findings raised on the vendored Python writer in flyingrobots/taskalisk#71 that hold for
this writer too. The schemas it ships are unchanged.

### Added

- **`run.inputUnreadable(path, code?)`** (flyingrobots/parley#110). It records that the program
  could not read a declared input, as `{"path", "error": "input.unreadable"}` with no digest, so
  `inv` is omitted as spec §2.2 requires. Before this, the writer read the path itself at
  finalisation, so a file that appeared after the program failed to read it got a digest and an
  `inv` for bytes the program never saw. It throws for a path that is not a declared input and
  after the inputs are settled; `run.input` after it supplies bytes again.

### Fixed

- **A `.parley/.gitignore` negation that can re-include `receipts/` sends the receipt to the state
  directory** (flyingrobots/parley#109, spec §5.2). A file of `*`, `!receipts/` and `!receipts/**`
  used to be accepted, and its receipts were left where `git add` stages them. The
  `receipt.relocated` warning names the negation. A pattern the check cannot evaluate (an inner
  `/`, a backslash) is taken to match, and a negation that cannot match, such as `!keep`, still
  stores in the repository.
- **`--schema` and `--help` publish schema documents as declared** (flyingrobots/parley#111, spec
  §5.3). A declared secret whose value occurred in a document, such as `object`, used to rewrite it
  (`"type": "[redacted]"`) under the original `id` and `version`. Every other discovery field is
  still scrubbed.
- **Retention re-reads a receipt's age at the decision** (flyingrobots/parley#112). It used the
  mtime from the directory scan, so a receipt silent for over a day whose run appended after the
  scan could be deleted. The writer now skips the unlink when the receipt's size or mtime moved
  since the decision. This narrows the window without closing it; the issue stays open for a lock.

## [0.2.0] — 2026-11-22

The schemas this version ships are the released versions of the repository's first schema release,
spec `0.2.0` in the root `CHANGELOG.md`, byte for byte (`src/schemas.ts` records the commit and
each digest); no schema version is released by this package release (spec §4.5).

**Upgrading from 0.1.0**, the three changes marked BREAKING below, in brief: the command is now
the first argument once the writer's flags are set aside, so a flag before the command is
`startup.unknown_command`; `--` now ends the writer's flags and is removed; and `<command> --help`
now lists `parley.startup.failed@1.0.0` beside `parley.error@2.0.0`.

### Changed

- **BREAKING for a caller that puts a writer flag after `--`: `--` now ends the writer's flags**
  (flyingrobots/parley#103). The writer used to remove every argument equal to one of its own
  flags (`--human`, `--humanize`, `--dry-run`, `--schema`, `--help`, `-h`) wherever it stood, so a
  tool flag whose value had one of those texts lost it and switched the writer's behaviour
  (`edit --note -h` became `--help` discovery and the tool never saw `-h`). Now the writer's flags
  are recognised only before the first `--`; that `--` is removed and every argument after it
  reaches `resolved`, `inputs` and the handler untouched, so `edit -- --note -h` gives the tool
  `["--note", "-h"]`. Before a `--` nothing changes: `edit --note -h` is still discovery, by a
  stated rule. A `--` used to reach the tool; the first one no longer does, and `edit -- --dry-run`
  is no longer a dry run. Nothing after `--` is ever the command. The Python writer follows the
  same rule.
- **BREAKING for a caller that names a flag before the command: the command is now the first
  argument once the writer's flags are set aside, and only that one argument is removed**
  (flyingrobots/parley#101). The writer used to take the first argument anywhere that named a
  command and remove every argument with the command's text, so a flag value equal to a command
  name was lost (`edit --reason edit` gave the tool `["--reason"]`) or chosen as the command
  (`--reason plan edit` ran `plan`). Now `edit --reason edit` gives `["--reason", "edit"]`, and in
  a tool with more than one command a first argument that names none is
  `startup.unknown_command`, exit 3, so `--verbose edit` must be written `edit --verbose`. The
  writer's own flags are still recognised anywhere before the first `--` (flyingrobots/parley#103).
  A tool with one command may still omit its name. The Python writer follows the same rule.
- **BREAKING for a consumer that pins its discovery output: `<command> --help` now lists
  `parley.startup.failed@1.0.0` beside `parley.error@2.0.0`** (flyingrobots/parley#92, spec §4.2).
  A command that declares no `errors` now has the default `[parley.error, parley.startup.failed]`,
  so its `command` line's `emits` and its `schema` lines gain one entry each, after
  `parley.error`. Every command can produce a startup failure, and §4.2 asks `--help` for every
  error type a call can produce. The Python writer already did this. `--schema` already listed the
  type and is unchanged. A command that declares `errors` still replaces the default, so name both
  types in that list. No line shape and no schema version moved, but a test that pins the exact
  list of `--help` schemas, as `flyingrobots/footprint`'s OUT-10b does, fails on upgrade until its
  expectation gains the new entry.
- `examples/count.ts` checks its arguments in `resolved`, before the bootstrap line, so an argument
  it does not take is `startup.arguments_invalid`, exit 3, with no receipt. This is the spec's
  preferred side of the boundary decided on flyingrobots/parley#91 (§3.2), and it is what
  `count.py` does. A call with no arguments resolves exactly as before, so its `inv` is unchanged.
- `src/schemas.ts` re-synced for a change to the draft `parley.lens` 1.0.0: an optional `runs`
  section, and `code` in place of `outcome` on each named record (flyingrobots/parley#83). The
  writer's behaviour is unchanged and no version moved; discovery serves the updated draft.
- `src/schemas.ts` re-synced for a change to the draft `parley.lens` 1.0.0: optional `event`, `t`
  and `outcome` on each named record (flyingrobots/parley#77). The writer's behaviour is unchanged
  and no version moved; discovery serves the updated draft.
- `src/schemas.ts` re-synced for a change to the draft `parley.query` 1.0.0: an optional `records`
  field for a drill-down (flyingrobots/parley#51). The writer's behaviour is unchanged and no
  version moved; discovery serves the updated draft.

- The `code` of a diagnostic **the writer itself raises** is no longer scrubbed. It is the
  writer's own stable identifier, like a schema id or a command's name, and replacing part of it
  put a line on the stream that no longer validated against `parley.warning` or `parley.error` —
  which is the one thing redaction must not do. `receipt.relocated`, `human.renderer_failed`,
  `sink.write_failed`, `sink.sidecar_failed` and the two `history.*` warnings are affected; a
  tool's own `run.warning` and `run.error` are not writer-built and their `code` is scrubbed
  exactly as before. `startup.failed` already behaved this way, scrubbing only its `problem`.
  Found by review of flyingrobots/parley#3, where a secret that is a substring of `history`
  reached it. (flyingrobots/parley#3)

- `src/schemas.ts` re-synced from the repository drafts: the package now ships sixteen, adding
  `parley.query` 1.0.0 and `parley.lens` 1.0.0 for the reader's query record and result lens
  (flyingrobots/parley#46). `--schema` serves the drafts at the newly pinned commit; this moves no
  schema version and no package version of its own (spec §4.5).

### Fixed

- Retention counts and expires only this tool's receipts (flyingrobots/parley#75): a bundle is
  this tool's when its first line is a `receipt.head` naming it. Other tools' receipts, a
  reader's included, are never counted or deleted, and an unreadable or headless file is left
  alone. Behaviour change for a directory shared with a reader: the tool now keeps `count` of its
  own receipts rather than `count` in all. The decision's text says "of this tool's receipts".

### Added

- **A built-in that refuses a suspected secret** (flyingrobots/parley#60). `refuseSuspectedSecrets(patterns?)`
  is a history transform that withholds any line whose body matches one of ten documented token
  shapes, and raises one `history.suspected_secret` warning naming the withheld `seq`, the shape
  and a JSON Pointer — never the matched text.

  ```ts
  await main(tool, argv, handler, { history: { transform: refuseSuspectedSecrets() } });
  ```

  It refuses; it never rewrites. A false positive costs one withheld stream line and never a
  changed value in the receipt. The shapes ship as data in `src/transforms/secret-patterns.ts`,
  each with a name, a regex source and one line of rationale: AWS access key ids, GitHub tokens of
  six prefixes, GitHub fine-grained PATs, Slack tokens, Google API keys, PEM private-key headers,
  JWTs, `Bearer` values, npm tokens and Stripe live keys. Every one is anchored and length-bounded,
  every one has a positive and a negative sample, and the test walks the shipped list, so a new
  entry without samples fails. String values are scanned recursively; the five envelope fields are
  not, and neither are object keys. The limits are stated in the README: an unlisted shape passes,
  a token split across two values passes, a token used as a key passes, and a legitimate value that
  matches is withheld. The head is not exempt and is the likeliest line to match, because it echoes
  `argv` and `resolved` (§5): an undeclared token on the command line withholds the whole head, so
  that stream copy has no head and the gap is reported like any other. The warning names a JSON
  Pointer only when the pointer does not itself match a shape, since a pointer is built from the
  record's keys and a key can be a token too. The exit status never moves (§6.1).

  New exports: `refuseSuspectedSecrets`, `findSuspectedSecret`, `SUSPECTED_SECRET_CODE`,
  `SECRET_PATTERNS`, the types `SecretPattern` and `SuspectedSecret`.

- **A transform may refuse, not only withhold** (flyingrobots/parley#60). `refuse(code, problem, remedy?)`
  returns a typed refusal: the writer withholds the line and raises one warning carrying that
  `code`, `problem` and `remedy`, on stderr and in the receipt, leaving the exit status alone. The
  four enforcement rules of flyingrobots/parley#57 are unchanged, and the writer still owns the
  namespace: a `code` that is not spec §6's shape, or an empty `problem`, is
  `history.transform_failed`, and a `code` carrying a declared secret value is
  `history.transform_unredacted`, because a diagnostic's `code` is the one string §5.3 does not
  scrub. `HistoryTransform` widens to allow a `HistoryRefusal` return; returning a record or
  nothing behaves exactly as before. New exports: `refuse`, `isHistoryRefusal` and the type
  `HistoryRefusal`.

- **A user-defined transform on the history sink** (flyingrobots/parley#57). The stream copy of a
  run can be a projection of the receipt copy rather than the whole of it. Configure it in code:

  ```ts
  await main(tool, argv, handler, { history: { transform, name: "drop-step-detail" } });
  ```

  `MainOptions.history` now takes a sink, `null`, or `{ sink?, transform?, name? }`; the two older
  forms behave exactly as before. The transform is handed the parsed record the receipt already
  holds — redacted, as §5.3 left it — and returns a record to put on the stream or nothing to
  withhold the line. There is no environment variable naming a module to execute, deliberately.

  The writer enforces the contract around it, so nothing the transform does can put an invalid
  line or a changed envelope on the shared timeline: `event`, `t`, `seq`, `run` and `_schema` are
  taken off whatever it returns and the receipt line's are put back (§1.3); the returned body is
  re-validated against the schema for its exact advertised pair (§4.5), this package's drafts plus
  the schema the tool declared on the emitted or error type (§4.2); and four conditions withhold
  the line and raise one warning naming the withheld `seq`, on stderr and in the receipt, without
  touching the exit status (§6.1): `history.transform_failed` (it threw),
  `history.transform_invalid` (the body no longer validates), `history.transform_unredacted` (the
  body carries a declared secret value the writer had already replaced) and
  `history.transform_uncheckable` (no schema document for the exact pair, or one outside the
  subset the checker implements).

  The stream copy of a projected run opens with a **`parley.history.transform` 1.0.0** line naming
  the transform and the SHA-256 of its source text as the runtime renders it. It reaches the
  stream alone, so it takes a `seq` the receipt has no line at, and the receipt accounts for that
  gap as a `receipt.step`. A run with no transform configured has no opening line, no step and no
  difference in any byte; a transform with no stream configured is equally inert.

  New: `src/check.ts` with `checkRecord` and `schemaSubsetGap`, a bounded JSON Schema checker — this package has no
  runtime dependencies, so re-validation is implemented here for the constructs the protocol's own
  schemas use, and it reports a keyword it does not implement instead of ignoring it. The subset
  check walks the whole schema document before any record is checked, so a construct nested under
  a property that record happens not to carry cannot slip past; a test asserts every shipped draft
  is inside the subset. New exports from `src/history.ts`:
  `historyProjection`, `transformDigest`, `transformName`, `isHistorySink`, and the types
  `HistoryTransform`, `HistoryConfig`, `HistoryProjection`. `Run` grows `declareProjection`,
  `noteProjection` and `withheldFromHistory`.

  Three decisions the README states under its own heading so the owner can overrule each: a line
  the writer cannot re-validate is withheld rather than passed through; the receipt records the
  `seq` the opening line took; and a transform may withhold `end`, so a copy on the stream can
  end without one.

- `src/schemas.ts` re-synced from the repository drafts: the package now ships seventeen, adding
  `parley.history.transform` 1.0.0, so `--schema` serves it like any other writer-owned type.

- **`declaredProjection(values)`, a built-in history transform** (flyingrobots/parley#59): the
  same §5.3 scrubber the receipt's own redaction uses, applied to the stream copy's body with a
  second declared set — longest value first, keys renamed, the envelope never touched, nor the
  writer's own identity scalars (`DIGEST_KEYS`, now exported from `src/run.ts`) on a writer-built
  record it might also be handed — found in self-review: without it, a declared value that
  coincided with the tool's own name would silently rename `tool` on the stream's head, since that
  field carries no pattern a validator would reject a corrupted value by. An empty declared set
  returns `undefined` rather than an identity function, so no `parley.history.transform` line is
  ever written for it; the transform's name on the stream is always the literal
  `declaredProjection` and its digest never discloses what was declared, since the digest is of
  the function's source text and the values only ever reach it as a closed-over variable. New
  export from `src/transforms/declared.ts`, re-exported from `src/index.ts`.

- The shared history stream (spec §8, informative): an opt-in second sink that receives the bytes
  of the local receipt, so one timeline spans tools, repositories, agents and people. Opt in with
  `PARLEY_HISTORY` naming a directory, or by creating `$XDG_STATE_HOME/parley/history` once;
  `PARLEY_HISTORY=off` switches it off even then. A run with no stream configured is unchanged in
  every byte: no `paths.history` on the bootstrap line, no history bookkeeping on the head, no
  file, no warning, no difference in exit status. New exports in `src/history.ts`:
  `resolveHistory`, `openHistory`, `isHistoryFailure`, `writeWholeLine`, `retainHistory`,
  `historyBookkeeping`, `segmentName`, `historyDays`, `HISTORY_ENV`, `HISTORY_DAYS_ENV`,
  `HISTORY_DEFAULT_DAYS`; `MainOptions.history` takes a sink or `null` beside `stdout` and
  `stderr`. No message schema moves and no message type is added: `paths` is already open and
  documents that a program may add paths of its own, and segment retention is recorded with
  `parley.receipt.step`. (flyingrobots/parley#3)

  The two decisions flyingrobots/parley#3 left open, implemented behind a recommendation the
  package README states under its own heading so the owner can overrule either:

  - **Scope and expiry.** One stream per user per machine, written as dated daily segments
    (`2026-11-22.jsonl`, UTC), keeping `PARLEY_HISTORY_DAYS` of them, today's included, default
    14. Expiry unlinks whole segments and never rewrites, because an append-only file with
    concurrent writers cannot be rewritten safely; with `days` at least 1 today's segment is
    never a candidate. Recorded as a `receipt.step`, skipped on `--dry-run`.
  - **Redaction.** None of the stream's own. The sink is handed the same string the receipt was
    handed, after §5.3 has replaced every declared secret, so a credential cannot reach the
    stream unless it reached the receipt first. Reach is protected instead of content: the
    directory is `0700`, segments are `0600`, a record stored as a sidecar reaches the stream as
    its `sidecar` event and never as its stored bytes, and nothing is sent anywhere. An
    undeclared secret is as exposed in the stream as in the receipt, for longer, which the README
    says plainly.

  Appending is `O_APPEND` with one whole line per write, so concurrent writers cannot split each
  other's lines; a write that reports fewer bytes is abandoned rather than continued, since
  continuing would interleave. A stream that cannot be opened is one `history.unavailable`
  warning and a failed append is one `history.write_failed` warning: never an error, never a sink
  failure, never a different exit status, because the dependency runs one way.

  The stream's own path gets the rule the receipt's path already had: one carrying a declared
  secret value is never chosen, since the bootstrap line prints it. The receipt has nowhere else
  to go and fails startup; the stream yields with one `history.unavailable` warning and the run
  carries on without it. The literal field name `history` is checked the same way, because a
  secret that is a substring of it would rename the key the line prints.

  `PARLEY_HISTORY_DAYS` is an integer from 1 to `HISTORY_MAX_DAYS` (36,500); anything else falls
  back to 14. A window wide enough that its own start date is not a date would have thrown out of
  `main` after the head was written, where nothing could catch it, and a retention window is not
  worth failing a run over.

## [0.1.0] — 2026-11-22

The schemas this version ships are the repository drafts at the commit recorded in
`src/schemas.ts`; no schema version is released by this package release (spec §4.5).

### Added

- `defineTool` and `main`: a tool declares its commands, effects, secrets, emitted types and
  retention; `main` turns argv and a handler into a conforming run and returns the exit status.
- `Run`: `result`, `page`, `step`, `warning`, `error`, `input`, `finaliseInputs`, `end`; one
  sequence across stdout, stderr and the receipt; sidecars over 65,536 bytes; redaction of declared
  secrets with `redaction` events; `ParleyClosed` after `end`.
- Receipt location with repository hygiene and the state-directory fallback; retention by count;
  `--dry-run`; `--schema` and `--help` as runs; `--human`; console capture; the top-level handler.
- `inv` as documented in the README; `ulid` run ids.
- The fourteen draft schemas at the pinned commit, with a test that they match the repository.

### Changed

- After the review of the first candidate: declared secrets of every command count on every path,
  the `end` record is scrubbed, the envelope and digests never are, and a run id or receipt path
  that would carry a secret is never chosen; the `inv` preimage takes redacted input descriptors;
  a throw before the bootstrap line is `startup.arguments_invalid`; the head is never a sidecar
  and a bootstrap sink failure is reported after it; a sidecar failure keeps the receipt usable;
  envelope keys from the tool are refused; `end(0)` after an error is refused; retention deletes
  only completed bundles; every `console` function is captured; tree inputs skip `.parley` and
  honour `exclude`; absolute input paths resolve; the ignore file is linked into place whole; the
  state directory's retention is declared; console capture starts before the tool's resolvers run;
  a failing renderer is one warning; a throw during discovery is an error line; an uncaught
  throw's stack stays in the receipt; a failed `end` in `--human` mode names the receipt. From the
  blind pass over the repaired head: the default descriptor sinks retry a full pipe and continue a
  partial write; numbers, booleans and object keys are redacted; the longest secret is replaced
  first, and the writer's own scalars and the public identity in writer-built records (tool, command and schema names and versions, discovery lines included) are never scrubbed; a secret in the
  session is `startup.secret_in_identity`; a sidecar that cannot be written is kept inline.
