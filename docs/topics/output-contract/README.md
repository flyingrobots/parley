# The output contract

Why the [specification](../../../spec/parley-v0.1.md) takes the shape it does. Each rule here came
from something that actually went wrong.

## Why JSON Lines rather than one JSON document

A document must be complete before it parses. Lines parse as they arrive, so a caller can follow
a long run, and a crashed run still yields everything up to the crash. Interleaving is safe when
each line carries its own `run` identity.

## Why stdout stays small

A caller pays context for every byte it reads. A payload that is mostly provenance costs the
caller to read the program's reasoning in order to use its answer. Splitting result from proof
means the reasoning is always recorded and never forced on a reader who does not need it.

## Why the receipt is a file rather than a stream

The moment anyone wants a receipt is *after* something looked wrong — and by then a stream is
gone. Only whoever knew in advance to capture it has a copy. A file can be read tomorrow, by a
different process, that did not run the command.

## Why two identifiers

`run` distinguishes two executions of the same question; `inv` recognises that they *were* the
same question. Both are needed. The pair is what makes change detection a string comparison and
makes an identical `inv` with a differing result a visible non-determinism defect.

## Why `inv` hashes bytes, not paths

Hashing the path makes the identity stable across an edit to the file. "Idempotent" then quietly
means "stale", and any cache built on it is wrong. The identity is over the question *and its
subject matter*.

## Why the bootstrap line comes first

A path printed at the end is a path you never receive on the failure path — which is exactly when
you want it.

## Why errors carry `measured`, `limit` and `remedy`

An error naming the constraint, the distance from it, and the lever resolves in one step.
Contrast two real ones:

```text
No opaque sRGB foreground can reach WCAG >= 7:1 on this background (max achievable 5.38:1);
adjust the background.
```

```text
make failed with exit code: 2
```

The first was acted on immediately. The second took several calls to trace to a transitive native
dependency with no prebuild for the running Node version.

## Why no TTY detection

An agent's invocation is never a TTY, so TTY-sensitive output means the agent receives a contract
nobody tested. Output must not depend on how it was called.
