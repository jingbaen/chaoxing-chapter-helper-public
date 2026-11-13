"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const read = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
test("page adapter starts on HTTP without crypto.randomUUID", () => {
  const events = new Map(), emitted = [];
  const document = {
    readyState: "loading", body: {}, documentElement: {},
    addEventListener(type, fn) { events.set(type, fn); },
    dispatchEvent(event) { emitted.push(event); events.get(event.type)?.(event); },
    querySelector() { return null; }, querySelectorAll() { return []; }
  };
  const context = { document, location: new URL("http://course.chaoxing.com/mycourse/studentstudy"),
    crypto: { getRandomValues: array => webcrypto.getRandomValues(array) },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    MutationObserver: class { observe() {} }, setInterval() {},
    setTimeout, clearTimeout, queueMicrotask, URL, Uint8Array,
    addEventListener() {}, getComputedStyle() { return {}; } };
  context.window = context; context.parent = context; context.top = context;
  vm.runInNewContext(read("page-agent.js"), context);
  events.get("DOMContentLoaded")();
  const snapshot = emitted.find(event => event.type === "cx-chapter-v1:snapshot");
  assert.ok(snapshot);
  assert.match(JSON.parse(snapshot.detail).token, uuidPattern);
});
test("isolated bridge can complete a request on HTTP without randomUUID", async () => {
  const events = new Map(); let receive, request;
  const context = { location: new URL("http://course.chaoxing.com/other"),
    crypto: { getRandomValues: array => webcrypto.getRandomValues(array) },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    setTimeout, clearTimeout, Uint8Array,
    document: { addEventListener(type, fn) { events.set(type, fn); },
      dispatchEvent(event) { if (event.type.endsWith(":command")) {
        request = JSON.parse(event.detail).request;
        events.get("cx-chapter-v1:reply")({ detail: JSON.stringify({ request, ok: true }) });
      } } },
    chrome: { runtime: { id: "fixture-extension", onMessage: { addListener(fn) { receive = fn; } } } } };
  context.window = context; context.top = context;
  vm.runInNewContext(read("bridge.js"), context);
  const response = await new Promise(resolve => {
    assert.equal(receive({ type: "CX_DISCOVER" }, { id: "fixture-extension" }, resolve), true);
  });
  assert.equal(response.ok, true);
  assert.match(request, uuidPattern);
});
