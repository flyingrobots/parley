# The numeric corpus

`cases.jsonl` is a set of JSON texts, each with the exact value it states and the text an exact
writer emits for it. It is what the writers and the reader are held to when a number does not fit
a double: the TypeScript writer's suite runs every case through a real run
(`packages/parley-emit/test/exact.test.ts`), and the Python writer's suite runs the same file
(`packages/parley-emit-py/tests/test_parley_emit.py`, `TestNumericCorpus`).

It is reference data for tests. It is not a message and no schema under `schemas/` describes it.

## The file

One JSON object per line. Every value in the file is a string or a list of strings, so reading the
corpus itself with an ordinary JSON parser loses nothing.

| Field | Meaning |
| --- | --- |
| `id` | The case's name; unique |
| `pins` | What the case holds in place, in a few words |
| `text` | A JSON text, exactly as a writer might have written it |
| `outcome` | `exact`: every number in `text` can be held with its value. `unrepresentable`: at least one cannot |
| `kinds` | For `exact`: how each number in `text` is held, in document order: `number` or `bigint` |
| `emit` | For `exact`: the text an exact serialiser writes for the value, with no whitespace |
| `tokens` | For `unrepresentable`: each number that cannot be held, as written, in document order |

## The rules it pins

1. **Integers.** An integer-valued number from -9007199254740991 to 9007199254740991 is a
   `number`, however it is spelt (`5`, `5.0`, `5e0`, `1e3`). Outside that range it is a `bigint`
   holding exactly that integer, decided from the text (`9007199254740992`,
   `9007199254740993.0`, `9.007199254740993e15`, `1e400`), and it is written back as plain digits.
2. **Decimals** (flyingrobots/parley#173). A number that is not an integer is a `number` only when
   its decimal value equals the decimal value of that number's standard JSON serialisation, which
   is what `JSON.stringify` writes. `0.1`, `0.10` and `1e-1` are one value and are written `0.1`.
   `0.10000000000000001` rounds to the same double and is a different decimal, so it is
   unrepresentable; so is `1e-400`, which underflows to zero.
3. **The cap.** An integer of more than 4,096 decimal digits is unrepresentable. This is an
   implementation limit, not a property of JSON. Such a token, or one with an enormous exponent,
   is classified without being built.

`emit` is compared as text. Where a test needs to know that two texts state one value, it
normalises both itself (sign, significant digits, power of ten); `JSON.parse` is not an oracle
here, because it rounds the expected value and the actual one alike.

## What the cases cover

| Cases | What they pin |
| --- | --- |
| `safe-max`, `unsafe-first`, `unsafe-adjacent`, `unsafe-adjacent-next`, `uint64-max`, `uint64-max-plus-one` | The boundary, and adjacent integers beyond it that share a double |
| `negative-safe-min`, `negative-unsafe-first`, `negative-unsafe-adjacent`, `negative-decimal`, `negative-decimal-longer` | The same rules below zero |
| `five`, `five-point-zero`, `five-exponent`, `negative-five-point-zero`, `zero`, `zero-point-zero`, `negative-zero`, `zero-enormous-exponent` | Equivalent spellings of one safe integer, and of zero |
| `thousand-exponent`, `thousand-exponent-upper`, `twelve-negative-exponent`, `unsafe-point-zero`, `unsafe-exponent`, `ten-to-21`, `ten-to-400` | Integral values written with a fraction or an exponent |
| `tenth`, `tenth-trailing-zero`, `tenth-exponent`, `tenth-seventeen-digits`, `tenth-nineteen-digits`, `three-tenths-sum`, `sixteen-digit-decimal`, `small-exponent`, `small-plain`, `smallest-subnormal`, `smallest-subnormal-longer`, `underflow`, `underflow-enormous`, `half-past-unsafe` | Decimals: distinct decimals that share one double, an underflowing decimal, and the forms that are a double's own |
| `cap-4096-digits`, `cap-4097-digits`, `cap-exponent-4095`, `cap-exponent-4096`, `enormous-exponent` | The digit cap on both sides, and an enormous exponent |
| `string-of-digits`, `string-holding-numbers` | A number against a string of the same digits |
| `nested`, `nested-adjacent`, `nested-unrepresentable` | Numbers inside objects and arrays, each decided in place |

50 cases: 39 `exact` and 11 `unrepresentable`.

## Changing it

A case is added when a rule gains a boundary worth holding. An existing case's `emit`, `kinds` or
`tokens` changes only when the owner changes the rule it pins; a writer or reader that disagrees
with a case is reported, and the corpus is not edited to match it.
