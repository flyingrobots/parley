# Message SDL — test plan

Evidence lives in `scripts/sdl-agreement.test.ts`. The cases that need Wesley lower
`schemas/parley.graphql` with the pinned `wesley` binary; the cases that do not (the derivation's
refusals) run on hand-built IR and need nothing but Bun. This whole ledger is transitional: it
holds while the hand-written JSON Schemas are the source, and flyingrobots/parley#119 replaces it
with a freshness test once Wesley generates them.

| ID | Requirement | Spec |
| --- | --- | --- |
| SDL-1 | Every top-level message schema has a message type in the SDL, and the SDL declares no message the schemas lack | §4.4 |
| SDL-2 | For every message, the JSON Schema value derived from the SDL and its interim directives equals the hand-written top-level schema as a parsed JSON value: every keyword, every description, `$id` and `title` included | §4.4, §4.5 |
| SDL-3 | The agreement is a real oracle: a change on either side alone fails, and the failure names the message and the JSON Pointer of the field | — |
| SDL-4 | Wesley is pinned exactly in one place; the test runs only that version and fails with a clear message on any other; without the binary it skips visibly on a workstation and fails in CI | — |
| SDL-5 | Every interim directive is declared in the SDL with the Wesley issue that will replace it, the derivation knows exactly that set, and the docs list the same directives with the same issues | — |
| SDL-6 | The derivation refuses SDL it cannot translate faithfully rather than guessing: an unknown `parley_` directive, a nullable field not marked absent-when-unset, an object type that is neither open nor closed, an unknown field named by a rule | — |

| ID | Case | Oracle | Evidence | Status |
| --- | --- | --- | --- | --- |
| SDL-1a | The `@parley_message` ids in `schemas/parley.graphql` against the `schemas/*.schema.json` files | the two sets are equal (17 each) | `sdl-agreement.test.ts` `SDL-1a: the SDL declares exactly the messages schemas/ has` | implemented |
| SDL-2a | Each of the 17 messages, derived from the lowered SDL | deep-equal to the parsed top-level schema; zero differences | `sdl-agreement.test.ts` `SDL-2a: <id> derived from the SDL equals the hand-written schema` (one test per message) | implemented |
| SDL-3a | One field's `minLength` changed in the SDL only (`parley.end` `run`) | the test reports a difference naming `parley.end` and `/properties/run/minLength` | `sdl-agreement.test.ts` `SDL-3a: a minLength changed in the SDL only` | implemented |
| SDL-3b | A required field made optional in the SDL only (`parley.end` `redacted`) | a difference naming `parley.end` and `/required` | `sdl-agreement.test.ts` `SDL-3b: a required field made optional in the SDL only` | implemented |
| SDL-3c | An enum value changed in the SDL only (`parley.query` `view`) | a difference naming `parley.query` and `/properties/view/enum/0` | `sdl-agreement.test.ts` `SDL-3c: an enum value changed in the SDL only` | implemented |
| SDL-3d | A literal changed in the SDL only (`parley.end` `event`) | a difference naming `parley.end` and `/properties/event/const` | `sdl-agreement.test.ts` `SDL-3d: a literal changed in the SDL only` | implemented |
| SDL-3e | A cross-field rule's value changed in the SDL only (`parley.page` `has_more`) | a difference naming `parley.page` and `/if/properties/has_more/const` | `sdl-agreement.test.ts` `SDL-3e: a cross-field rule's value changed in the SDL only` | implemented |
| SDL-3f | A description edited in the SDL only (`parley.error` `problem`) | a difference naming `parley.error` and `/properties/problem/description` | `sdl-agreement.test.ts` `SDL-3f: a description edited in the SDL only` | implemented |
| SDL-3g | The hand-written schema changed alone (a pattern widened, a required field dropped, a keyword added) | a difference naming the message and the pointer, for each | `sdl-agreement.test.ts` `SDL-3g: the hand-written schema changed alone` | implemented |
| SDL-4a | `wesley --version` against the pin in `package.json` `config.wesley` | equal; a different version fails naming both | `sdl-agreement.test.ts` `SDL-4a: the pin is one exact version, and another version fails naming both` | implemented |
| SDL-4b | The lowered IR's `version` | the IR shape this scaffolding reads (`1.0.0`); another fails naming it | `sdl-agreement.test.ts` `SDL-4b: the IR is the shape this scaffolding reads` | implemented |
| SDL-4c | No pinned binary on a workstation, `CI` unset | the Wesley cases are skipped, and a printed line and the skipped test's name say why and how to install it | `sdl-agreement.test.ts` `SDL-4c: no binary on a workstation skips, saying why and how to install it` | implemented |
| SDL-4d | No pinned binary with `CI` set | a test fails saying the binary is missing | `sdl-agreement.test.ts` `SDL-4d: no binary in CI fails` | implemented |
| SDL-5a | The `directive @parley_*` declarations in the SDL text, the derivation's vocabulary, and the table in `docs/topics/message-sdl/README.md` | the same set of names in all three, each declaration commented with one `flyingrobots/wesley#N`, each row naming the same issue | `sdl-agreement.test.ts` `SDL-5a: the SDL declarations, the derivation's vocabulary and the docs table agree` | implemented |
| SDL-6a | Hand-built IR with an unknown `@parley_` directive | the derivation throws naming the directive | `sdl-agreement.test.ts` `SDL-6a: an unknown parley_ directive` | implemented |
| SDL-6b | Hand-built IR with a nullable field lacking `@parley_optional` | the derivation throws naming the type and field | `sdl-agreement.test.ts` `SDL-6b: a nullable field not marked @parley_optional` | implemented |
| SDL-6c | Hand-built IR with an object type carrying neither `@parley_open` nor `@parley_closed` | the derivation throws naming the type | `sdl-agreement.test.ts` `SDL-6c: an object type that is neither open nor closed` | implemented |
| SDL-6d | Hand-built IR with a rule naming a field the type does not have | the derivation throws naming the rule and the field | `sdl-agreement.test.ts` `SDL-6d: a rule naming a field the type does not have` | implemented |
