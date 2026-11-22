# The output contract

Why the [specification](../../../spec/parley-v0.2.md) takes the shape it does. Each rule here came
from something that actually went wrong.

## Why JSON Lines rather than one JSON document

A document must be complete before it parses. Lines parse as they arrive, so a caller can follow
a long run, and a crashed run still yields everything up to the crash. Interleaved output stays
attributable because every line carries its own `run` identity, which §1.3 requires for exactly
that reason.

## Why stdout stays small

A caller pays context for every byte it reads. A payload that is mostly provenance costs the
caller to read the program's reasoning in order to use its answer. Splitting result from record
means the reasoning is always recorded and never forced on a reader who does not need it.

## Why the receipt is a file rather than a stream

The moment anyone wants a receipt is *after* something looked wrong — and by then a stream is
gone. Only whoever knew in advance to capture it has a copy. A file can be read tomorrow, by a
different process, that did not run the command.

## Why `seq` is one counter across every stream

An error goes to stderr and into the receipt. If each stream numbered its own lines, a reader
merging them could not tell the two copies were one event, and could not order a receipt line
against a stdout line at all. One counter per run makes `(run, seq)` the event's identity wherever
it was written.

## Why `run` and `inv` are both needed

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

## Why a run closes with an `end` event

A stream that only opens cannot tell a reader whether it finished. Bazel's build event protocol
and Terraform's JSON output both close explicitly for this reason. `end` carries the exit status
the process is about to use, so a captured stream or a receipt file read tomorrow says whether the
run completed and whether it succeeded, which are different facts. Its absence says only that the
run did not finalise; EOF is not success.

## Why the receipt keeps the result

A receipt that holds the reasoning but not the answer sends tomorrow's reader back to a stdout
capture that no longer exists. Keeping the result, error and warning lines in the receipt makes it
self-sufficient, and the 64 KiB sidecar threshold keeps a large answer from bloating the file
that every reader opens first.

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

## Why a reader buffers to the newline and quarantines the rest

Node, Python, OpenSSL and glibc all write to the process's descriptors directly on occasion, and
§6 admits a native crash cannot be constrained. A reader that aborts on the first non-JSON line is
broken by the one case the spec says will happen. Buffering to the newline means a line split
across two reads is still a line; quarantining a stray complete line keeps it as evidence without
letting it masquerade as a result.

## Why no TTY detection

An agent's invocation is never a TTY, so TTY-sensitive output means the agent receives a contract
nobody tested. Output must not depend on how it was called.
