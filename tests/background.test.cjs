"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const E = require("../engine.js");
function harness() {
  let listener;
  const context = {
    CXEngine: E, importScripts() {}, setTimeout, clearTimeout,
    chrome: {
      runtime: { id: "fixture-extension", getURL: file => `chrome-extension://fixture-extension/${file}`,
        onMessage: { addListener(fn) { listener = fn; } } },
      storage: { session: { async get() { return {}; }, async set() {}, async remove() {} },
        local: { async get() { return {}; }, async set() {} } },
      alarms: { async get() { return null; }, async clear() {}, onAlarm: { addListener() {} } },
      tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} } }
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../background.js"), "utf8"), context);
  return listener;
}
test("foreign extensions and child frames cannot inspect or control sessions", () => {
  const receive = harness();
  for (const type of ["CX_CONTROL", "CX_STATUS"]) {
    assert.equal(receive({ type, action: "start" }, { id: "other-extension", frameId: 0, tab: { id: 1 } }, () => {}), false);
    assert.equal(receive({ type, action: "start" }, { id: "fixture-extension", frameId: 2, tab: { id: 1 } }, () => {}), false);
  }
});
test("invalid control actions are rejected without changing state", () => {
  let response;
  const result = harness()({ type: "CX_CONTROL", action: "unexpected" },
    { id: "fixture-extension", frameId: 0, tab: { id: 1 } }, value => { response = value; });
  assert.equal(result, false);
  assert.equal(response.error, "unsupported action");
});
test("popup and top-level bridge can still query their intended tab", async () => {
  for (const [message, sender] of [
    [{ type: "CX_STATUS", tabId: 1 }, { id: "fixture-extension", url: "chrome-extension://fixture-extension/popup.html" }],
    [{ type: "CX_STATUS" }, { id: "fixture-extension", frameId: 0, tab: { id: 1 } }]
  ]) {
    const receive = harness();
    const response = await new Promise(resolve => { assert.equal(receive(message, sender, resolve), true); });
    assert.equal(response.running, false);
    assert.equal(response.config.rate, 2);
  }
});
