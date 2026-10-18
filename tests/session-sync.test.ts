import assert from "node:assert/strict";
import test from "node:test";
import { applySessionPatches, canonicalizeJson, diffSessionSnapshots, type SessionPatch, type JsonValue } from "../web/session-sync.js";

test("diff reconstructs array append, truncation, nested deletion and structural resets", () => {
  const before: { history: JsonValue[]; state: JsonValue } = { history: [{ text: "start", detail: { old: 1, keep: true } }, { text: "second" }], state: { busy: true } };
  const appended: { history: JsonValue[]; state: JsonValue } = { history: [{ text: "start plus", detail: { keep: true } }, { text: "edited" }, { text: "third" }], state: null };
  const patches = diffSessionSnapshots(before, appended);
  assert.ok(patches.some((patch) => patch.op === "append"));
  assert.ok(patches.some((patch) => patch.op === "delete"));
  assert.deepEqual(applySessionPatches(before, patches), appended);
  const truncated = { history: [appended.history[0]], state: ["reset"] };
  const truncation = diffSessionSnapshots(appended, truncated);
  assert.ok(truncation.some((patch) => patch.op === "truncate"));
  assert.deepEqual(applySessionPatches(appended, truncation), truncated);
  assert.deepEqual(applySessionPatches(before, diffSessionSnapshots(before, [])), []);
});

test("nonappend tool changes use field replacements and share unchanged branches", () => {
  const before = { history: [{ tool: { output: "old result", status: "running" } }], untouched: { text: "stable" } };
  const next = { history: [{ tool: { output: "replacement", status: "done" } }], untouched: before.untouched };
  const patches = diffSessionSnapshots(before, next);
  assert.deepEqual(patches, [
    { op: "set", path: ["history", 0, "tool", "output"], value: "replacement" },
    { op: "set", path: ["history", 0, "tool", "status"], value: "done" },
  ]);
  const rebuilt = applySessionPatches(before, patches);
  assert.deepEqual(rebuilt, next);
  assert.equal(rebuilt.untouched, before.untouched);
  assert.notEqual(rebuilt.history, before.history);
  assert.equal(before.history[0].tool.output, "old result");
  assert.equal(applySessionPatches(before, []), before);
});

test("JSON normalization detaches inputs and ignores undefined object keys", () => {
  const input = { nested: { value: 1, missing: undefined }, array: [undefined, NaN, Infinity], date: new Date("2020-01-01T00:00:00.000Z") };
  const normalized = canonicalizeJson(input)!;
  assert.deepEqual(normalized, { nested: { value: 1 }, array: [null, null, null], date: "2020-01-01T00:00:00.000Z" });
  input.nested.value = 2;
  assert.deepEqual(diffSessionSnapshots(normalized, canonicalizeJson({ nested: { value: 1 }, array: [null, null, null], date: "2020-01-01T00:00:00.000Z" })!), []);
  const shared = { value: 1 };
  assert.deepEqual(canonicalizeJson([shared, shared]), [{ value: 1 }, { value: 1 }]);
  const circular: { self?: unknown } = {};
  circular.self = circular;
  assert.throws(() => canonicalizeJson(circular), /Circular/);
});

test("patch application detaches replacement values", () => {
  const value = { items: [1] };
  const rebuilt = applySessionPatches({}, [{ op: "set", path: ["new"], value }]);
  value.items.push(2);
  assert.deepEqual(rebuilt, { new: { items: [1] } });
});

test("ordinary JSON property names survive normalization and patches without modifying prototypes", () => {
  const data = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":"data"}}');
  const normalized = canonicalizeJson(data)!;
  assert.deepEqual(normalized, data);
  assert.equal(Object.getPrototypeOf(normalized), Object.prototype);
  const next = JSON.parse('{"__proto__":{"polluted":false},"constructor":{"prototype":"updated"}}');
  const rebuilt = applySessionPatches(normalized, diffSessionSnapshots(normalized, next));
  assert.deepEqual(rebuilt, next);
  const inserted = applySessionPatches({}, [{ op: "set", path: ["__proto__"], value: { polluted: true } }]);
  assert.deepEqual(inserted, JSON.parse('{"__proto__":{"polluted":true}}'));
  assert.equal(Object.getPrototypeOf(inserted), Object.prototype);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("invalid operations, paths and prototype pollution are rejected without mutation", () => {
  const snapshot = { nested: { value: "text" }, items: [1, 2] };
  const invalid: unknown[] = [
    { op: "unknown", path: [] },
    { op: "set", path: ["__proto__", "polluted"], value: true },
    { op: "set", path: ["nested", "constructor", "prototype"], value: true },
    { op: "set", path: ["items", -1], value: 0 },
    { op: "set", path: ["items", "0"], value: 0 },
    { op: "set", path: ["items", 4], value: 0 },
    { op: "set", path: ["missing", "value"], value: 0 },
    { op: "set", path: [] },
    { op: "delete", path: ["items", 0] },
    { op: "delete", path: ["missing"] },
    { op: "delete", path: [] },
    { op: "append", path: ["items"], value: "suffix" },
    { op: "truncate", path: ["items"], length: 3 },
    { op: "truncate", path: ["nested"], length: 0 },
  ];
  for (const patch of invalid) assert.throws(() => applySessionPatches(snapshot, [patch] as SessionPatch[]), TypeError);
  assert.deepEqual(snapshot, { nested: { value: "text" }, items: [1, 2] });
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});
