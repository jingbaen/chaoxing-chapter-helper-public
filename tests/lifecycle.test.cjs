"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const E = require("../engine.js");
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function harness(options = {}) {
  let receive, removed, updated, alarm;
  const data = {}, writes = [], muteChanges = [];
  let muted = true, alarmEnabled = false;
  const context = vm.createContext({
    CXEngine: E, importScripts() {}, setTimeout, clearTimeout,
    chrome: {
      runtime: { id: "fixture-extension", getURL: name => `chrome-extension://fixture-extension/${name}`,
        onMessage: { addListener(fn) { receive = fn; } } },
      storage: {
        local: { async get() { await options.localGet?.(); return {}; }, async set() {} },
        session: {
          async get() { return options.initialGet ? await options.initialGet() : {}; },
          async set(value) {
            const copy = JSON.parse(JSON.stringify(value));
            writes.push(copy);
            await options.beforeWrite?.();
            Object.assign(data, copy);
          },
          async remove(keys) { for (const key of keys) delete data[key]; }
        }
      },
      alarms: {
        async get() { return alarmEnabled ? {} : null; },
        async create() { alarmEnabled = true; }, async clear() { alarmEnabled = false; },
        onAlarm: { addListener(fn) { alarm = fn; } }
      },
      tabs: {
        onRemoved: { addListener(fn) { removed = fn; } },
        onUpdated: { addListener(fn) { updated = fn; } },
        async get() { return { mutedInfo: { muted, reason: options.muteReason || "extension", extensionId: "fixture-extension" } }; },
        async update(id, value) { muted = value.muted; muteChanges.push(value.muted); },
        async sendMessage(id, message, target) {
          if (options.respond?.(message, target) === true) return { ok: true };
          throw Error("No receiver");
        }
      }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../background.js"), "utf8"), context);
  if (!options.initialGet) await tick();
  function seed(id = 1, running = true) {
    const state = E.create();
    state.running = running;
    state.tabAudio = { originalMuted: false, applied: true };
    context.seed = { id, state };
    vm.runInContext("sessions.set(seed.id, seed.state); frames.set(seed.id, new Map([[0, { frameId: 0, token: 'synthetic-token', tasks: [] }]]));", context);
    data[`tab:${id}`] = state;
    data[`frames:${id}`] = [{ token: "synthetic-token" }];
    return state;
  }
  function message(value, id = 1) {
    return new Promise(resolve => receive(value,
      { id: "fixture-extension", frameId: 0, tab: { id } }, resolve));
  }
  async function drain() {
    for (let i = 0; i < 12; i++) await tick();
  }
  return { seed, message, drain, data, writes, muteChanges,
    close: id => removed(id), complete: id => updated(id, { status: "complete" }),
    pulse: () => alarm({ name: "cx-chapter-playback-watchdog" }),
    has: id => vm.runInContext(`sessions.has(${id}) || frames.has(${id})`, context),
    isRunning: id => vm.runInContext(`sessions.get(${id})?.running`, context) };
}
test("tab closure wins over an in-flight session write", async () => {
  const started = deferred(), resume = deferred();
  const h = await harness({ beforeWrite: async () => { started.resolve(); await resume.promise; } });
  const response = h.message({ type: "CX_REPORT", snapshot: {
    token: "synthetic-token", tasks: [], jobs: [{ name: "Synthetic private title" }] } });
  await started.promise;
  h.close(1);
  resume.resolve();
  await response;
  await h.drain();
  assert.deepEqual(Object.keys(h.data), []);
  assert.equal(h.has(1), false);
});
test("a queued request cannot recreate a closed tab", async () => {
  const h = await harness();
  const response = h.message({ type: "CX_STATUS" });
  h.close(1);
  assert.ok((await response).error);
  assert.equal(h.has(1), false);
});
test("closing while settings are loading cannot recreate a session", async () => {
  const started = deferred(), resume = deferred();
  const h = await harness({ localGet: async () => { started.resolve(); await resume.promise; } });
  const response = h.message({ type: "CX_STATUS" });
  await started.promise;
  h.close(1);
  resume.resolve();
  assert.ok((await response).error);
  assert.equal(h.has(1), false);
});
test("late service-worker restoration excludes a tab already closed", async () => {
  const resume = deferred();
  const h = await harness({ initialGet: () => resume.promise });
  h.close(1);
  resume.resolve({ "tab:1": E.create(), "frames:1": [{ token: "synthetic-token", frameId: 0 }] });
  await h.drain();
  assert.equal(h.has(1), false);
});
test("leaving supported pages restores audio and removes course state", async () => {
  const h = await harness();
  const state = h.seed();
  h.complete(1);
  await h.drain();
  assert.equal(state.running, false);
  assert.deepEqual(h.muteChanges, [false]);
  assert.deepEqual(Object.keys(h.data), []);
  assert.equal(h.has(1), false);
});
test("supported navigation keeps the session running", async () => {
  const h = await harness({ respond: () => true });
  h.seed();
  h.complete(1);
  await h.drain();
  assert.equal(h.isRunning(1), true);
  assert.deepEqual(h.muteChanges, []);
});
test("watchdog also removes a run when every page receiver disappears", async () => {
  const h = await harness();
  const state = h.seed();
  h.pulse();
  await h.drain();
  assert.equal(state.running, false);
  assert.equal(h.has(1), false);
  assert.deepEqual(h.muteChanges, [false]);
  assert.deepEqual(Object.keys(h.data), []);
});
test("one responding frame keeps the watchdog run alive", async () => {
  const h = await harness({ respond: message => message.command?.type === "WAKE" });
  h.seed();
  h.pulse();
  await h.drain();
  assert.equal(h.isRunning(1), true);
  assert.ok(h.data["tab:1"]);
});
test("navigation cleanup preserves a later user audio choice", async () => {
  const h = await harness({ muteReason: "user" });
  h.seed();
  h.complete(1);
  await h.drain();
  assert.deepEqual(h.muteChanges, []);
  assert.equal(h.has(1), false);
});
