"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { build } = require("../diagnostics.js");
test("export excludes all free text, identifiers and timestamps at every nesting level", () => {
  const marker = "SYNTHETIC_PRIVATE_MARKER";
  const result = build({
    running: true, message: marker, exported: marker, course: marker, chapter: marker,
    logs: [{ time: 123456789, message: marker }],
    config: { rate: 2, documents: true, extra: marker },
    jobs: [{ name: marker, id: marker, owner: marker, binding: marker, kind: marker, confirmed: true }],
    diagnostic: { nextTask: marker, pendingTask: marker, mediaNode: marker, kind: marker, phase: marker,
      rate: marker, hasSource: marker, candidates: [{ mediaNode: marker }],
      reader: { target: marker, state: marker, top: marker } }
  }, "1.0.5");
  assert.ok(!JSON.stringify(result).includes(marker));
  assert.ok(!Object.hasOwn(result, "message"));
  assert.ok(!Object.hasOwn(result, "logs"));
  assert.ok(!Object.hasOwn(result, "exported"));
  assert.equal(result.tasks[0].confirmed, true);
  assert.equal(result.diagnostic.hasSource, false);
});
test("known technical state survives the export", () => {
  const value = build({ connected: true, completed: 2, config: { rate: 1.5, guard: true },
    jobs: [{ kind: "document", binding: "bound", confirmed: true, active: false }],
    diagnostic: { kind: "document", reader: { state: "at-bottom", progress: 100, top: 300, height: 500, viewport: 200 } }
  }, "1.0.5");
  assert.equal(value.version, "1.0.5");
  assert.equal(value.config.rate, 1.5);
  assert.equal(value.tasks[0].kind, "document");
  assert.equal(value.diagnostic.reader.top, 300);
});
test("malformed values cannot create unbounded or non-finite exports", () => {
  const value = build({ jobs: Array(1000).fill(null), completed: Infinity,
    config: { rate: 100 }, diagnostic: { reader: { top: -3, progress: 1000, height: NaN } } }, "arbitrary text");
  assert.equal(value.version, "unknown");
  assert.equal(value.tasks.length, 500);
  assert.equal(value.completed, 0);
  assert.equal(value.config.rate, 2);
  assert.equal(value.diagnostic.reader.progress, 100);
  assert.equal(value.diagnostic.reader.top, 0);
  assert.doesNotThrow(() => build());
});
