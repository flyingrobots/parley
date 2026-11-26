#!/usr/bin/env bun
// A process that replaces BigInt.prototype.valueOf before the writer is loaded, so the writer's
// own copy of that method is the replacement. Prints what exactJson does with a boxed bigint
// and with a primitive one. Run by test/exact.test.ts.
export {};
let calls = 0;
(BigInt.prototype as unknown as { valueOf: () => unknown }).valueOf = function () { calls++; return { toJSON: () => `call-${calls}` }; };
const { exactJson } = await import("../../src/index.ts");
let boxed: string;
try { boxed = exactJson({ n: Object(5n) }); } catch (e) { boxed = `threw ${e instanceof Error ? e.name : "?"}`; }
console.log(JSON.stringify({ boxed, primitive: exactJson({ n: 9007199254740993n }) }));
