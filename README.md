# parley

**A protocol for programs that talk to agents.**

Most command-line tools render output for a person reading a terminal. When the primary caller is
an agent, that rendering is a surface to be scraped — and scraping is guessing.

parley says: output is a **contract**. Every line is JSON, carries a versioned schema id, and
validates. Every run announces itself, says where its receipt went, and leaves that receipt on
disk whether anyone asked for it or not. Reading history is itself an act that gets recorded,
and it carries who is asking and why.

> **Status: proposal.** The [specification](spec/) is written; the libraries are not. See the
> [open issues](https://github.com/flyingrobots/parley/issues).

## Two layers, and the dependency runs one way

| Layer | What it is | Requires |
| --- | --- | --- |
| **The output contract** | How a program speaks: JSON Lines, published schemas, a bootstrap line, a durable receipt | **Nothing.** A conforming tool is useful on its own |
| **The history stream** | An optional shared sink where receipts from every tool, agent and session collect into one timeline | Opt in by configuring a path |

This order matters. A tool that conforms is fully useful with zero infrastructure — no daemon, no
database, no setup. The stream is a *consumer* of the format, never a prerequisite for it. Invert
that and nobody can use these tools without adopting the whole system.

## What a conforming run looks like

```jsonl
{"event":"run","t":1763790412345,"seq":0,"tool":"theme-book","v":"0.2.1","inv":"inv_7f3a…","run":"01JD3K…","session":"ses_9c…","paths":{"receipt":".parley/receipts/01JD3K….jsonl"},"_schema":{"id":"parley.run.bootstrap","version":"1.1.0"}}
{"event":"result","t":1763790412380,"seq":2,"run":"01JD3K…","value":5,"_schema":{"id":"theme-book.count","version":"1.0.0"}}
```

Two small lines for a one-number answer. The bulk — the argv echo, the resolved interpretation,
the input hashes — goes in the receipt, because **stdout carries what you need to act and the
receipt carries what you need to verify**.

## Why the receipt lives on disk

The moment you want a receipt is *after* something went wrong, which is exactly the moment a
stream is gone. A receipt on disk can be read by a session that did not run the command, tomorrow,
by a different agent. Streams are only available to whoever knew in advance to capture them.

## Reading is an act

A query against history declares **who is asking and why**, and the answer is shaped by that.
There is no view-from-nowhere: purpose is what makes relevance computable, and a reading carries
the lens it came through so a later reader knows what it was.

## Where this sits

parley is the same idea as [`echo`](https://github.com/flyingrobots/echo),
[`graft`](https://github.com/flyingrobots/graft) and `jedit` — record what happened, carry the
provenance, read it as history — applied to the narrowest surface there is: what a program prints.

That narrowness is deliberate. Conforming means changing how you write to stdout. No substrate,
no daemon, no graph. And nothing you emit has to change later if the same records flow into
something richer, because the shape is already causal: identified, ordered, provenanced,
replayable.

A doorway, sized so you can walk through it without agreeing to anything larger.

## Documents

- [The specification](spec/) — normative, versioned independently of any implementation
- [Schemas](schemas/) — JSON Schema for every message type
- [`AGENTS.md`](AGENTS.md) — working agreement

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE).
