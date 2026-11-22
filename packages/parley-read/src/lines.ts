// Lines, as spec §1.4 defines them for a reader: "A reader MUST buffer until a newline before
// parsing. A read chunk or a flush is not a line boundary; valid JSON that arrived across two
// reads is not garbage." So the buffer holds bytes, not characters — a multi-byte character split
// across a chunk boundary is not two broken characters either — and only `\n` ends a line. What is
// left over at EOF is not a line (§5.4) and is reported as such by the caller.
import { closeSync, openSync, readSync } from "node:fs";

const NEWLINE = 0x0a;
/** 64 KiB: large enough that a receipt of ordinary lines takes few reads, small enough to prove the buffering. */
export const CHUNK_BYTES = 64 * 1024;

export interface Line {
  /** 1-based position in the stream, counting complete lines; the unterminated tail takes the next number. */
  readonly n: number;
  readonly raw: string;
}

/**
 * Feed bytes in, take complete lines out. The remainder is held until the newline that ends it
 * arrives, and `rest()` reports whatever never got one.
 */
export class LineBuffer {
  private held: Buffer = Buffer.alloc(0);
  private n = 0;

  /** The complete lines this chunk finished, in order. A chunk that finishes none returns `[]`. */
  push(chunk: Uint8Array | string): Line[] {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    this.held = this.held.length === 0 ? bytes : Buffer.concat([this.held, bytes]);
    const out: Line[] = [];
    let start = 0;
    for (;;) {
      const at = this.held.indexOf(NEWLINE, start);
      if (at < 0) break;
      this.n += 1;
      out.push({ n: this.n, raw: this.held.subarray(start, at).toString("utf8") });
      start = at + 1;
    }
    if (start > 0) this.held = this.held.subarray(start);
    return out;
  }

  /** The unterminated fragment at EOF, or null when the last byte was a newline. */
  rest(): Line | null {
    return this.held.length === 0 ? null : { n: this.n + 1, raw: this.held.toString("utf8") };
  }

  /** How many complete lines have been taken out so far. */
  get count(): number { return this.n; }
}

export interface Split { readonly lines: Line[]; readonly unterminated: Line | null }

/** Split text, or bytes, the way a reader must: on newlines only, with the tail kept apart. */
export function splitLines(text: string | Uint8Array): Split {
  const buffer = new LineBuffer();
  const lines = buffer.push(text);
  return { lines, unterminated: buffer.rest() };
}

/** Read a file in chunks through a `LineBuffer`, so the buffering is the real thing and not a pretence. */
export function readFileLines(file: string, chunkBytes = CHUNK_BYTES): Split {
  const buffer = new LineBuffer();
  const lines: Line[] = [];
  const chunk = Buffer.allocUnsafe(chunkBytes);
  const fd = openSync(file, "r");
  try {
    for (;;) {
      const read = readSync(fd, chunk, 0, chunkBytes, null);
      if (read === 0) break;
      for (const line of buffer.push(chunk.subarray(0, read))) lines.push(line);
    }
  } finally {
    closeSync(fd);
  }
  return { lines, unterminated: buffer.rest() };
}
