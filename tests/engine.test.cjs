"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const E = require("../engine.js");
function fixture(kind = "media") {
  const state = E.create({}, 1000);
  state.running = true;
  const frame = { frameId: 0, token: "fixture-frame", course: "fixture-course", chapter: "fixture-chapter", card: "0", received: 1000,
    inventoryReady: true, inventoryAuthority: 100, visible: true,
    navigation: { kind: "study", tabs: [], chapters: [], activeTab: 0 },
    jobs: [{ id: "fixture-job", owner: "fixture-owner", order: 0, kind, name: "Synthetic task", required: true, confirmed: false }],
    tasks: [{ id: "fixture-task", jobId: "fixture-job", owner: "fixture-owner", kind, visible: true, time: 0, rate: 2, phase: "playing" }]
  };
  E.step(state, [frame], 1000);
  frame.received = 7000;
  return { state, frame };
}
test("configuration rejects unsupported rate and non-boolean flags", () => {
  assert.deepEqual(E.config({ rate: 99, documents: "false", guard: 0 }), E.defaults);
  assert.equal(E.config({ rate: 1.25, documents: false }).rate, 1.25);
  assert.equal(E.config({ documents: false }).documents, false);
});
test("an exact owner is required to start a task", () => {
  const { state, frame } = fixture();
  frame.tasks[0].owner = "other-owner";
  assert.deepEqual(E.step(state, [frame], 7000), []);
  assert.equal(state.active, null);
  frame.received = 22000;
  assert.equal(E.step(state, [frame], 22000)[0].type, "STOP_ALL");
  assert.equal(state.running, false);
});
test("media end waits for a platform badge then pauses at 20 seconds", () => {
  const { state, frame } = fixture();
  assert.equal(E.step(state, [frame], 7000)[0].type, "RUN");
  frame.tasks[0].ended = true;
  frame.received = 8000;
  E.step(state, [frame], 8000);
  frame.received = 27999;
  assert.deepEqual(E.step(state, [frame], 27999), []);
  assert.equal(state.completed, 0);
  frame.received = 28000;
  assert.equal(E.step(state, [frame], 28000)[0].type, "STOP_ALL");
  assert.equal(state.running, false);
});
test("confirmed active task increments count and stops before continuing", () => {
  const { state, frame } = fixture();
  E.step(state, [frame], 7000);
  frame.jobs[0].confirmed = true;
  frame.received = 8000;
  assert.equal(E.step(state, [frame], 8000)[0].type, "STOP_ALL");
  assert.equal(state.completed, 1);
  E.step(state, [frame], 9000);
  assert.equal(state.completed, 1);
});
test("quiz, login and verification blockers halt without confirmation", () => {
  for (const blocker of ["出现随堂题或章节测验", "出现验证码", "登录已失效", "出现人脸验证"]) {
    const { state, frame } = fixture();
    frame.blocker = blocker;
    assert.equal(E.step(state, [frame], 7000)[0].type, "STOP_ALL");
    assert.equal(state.running, false);
    assert.equal(state.completed, 0);
  }
});
test("unrecognized/manual required jobs are never silently skipped", () => {
  for (const kind of ["unknown", "manual"]) {
    const { state, frame } = fixture(kind);
    assert.equal(E.step(state, [frame], 7000)[0].type, "STOP_ALL");
    assert.equal(state.completed, 0);
  }
});
test("task order follows page order even with numeric-looking identifiers", () => {
  const { state, frame } = fixture();
  state.inventory = {}; state.order = [];
  frame.jobs = [
    { id: "20", owner: "fixture-owner", order: 0, kind: "media", name: "First synthetic", required: true },
    { id: "3", owner: "second-owner", order: 1, kind: "media", name: "Second synthetic", required: true }
  ];
  frame.tasks[0].jobId = "20";
  assert.equal(E.step(state, [frame], 7000)[0].jobId, "20");
});
test("missing inventory never authorizes navigation", () => {
  const { state, frame } = fixture();
  state.inventory = {}; state.order = [];
  frame.inventoryReady = false;
  frame.navigation.tabs = [{ id: "next", name: "Next synthetic" }];
  frame.navigation.activeTab = -1;
  assert.deepEqual(E.step(state, [frame], 7000), []);
  assert.equal(state.navigation, null);
});
test("document bottom alone does not count as completed", () => {
  const { state, frame } = fixture("document");
  E.step(state, [frame], 7000);
  frame.tasks[0].bottom = true;
  frame.received = 8000;
  E.step(state, [frame], 8000);
  assert.equal(state.completed, 0);
  assert.equal(state.running, true);
});
test("a paused scheduler ignores late page reports", () => {
  const { state, frame } = fixture();
  E.stop(state, "Pause", 7000);
  const revision = state.controlRevision;
  assert.deepEqual(E.step(state, [frame], 8000), []);
  assert.equal(state.active, null);
  assert.equal(state.controlRevision, revision);
});
