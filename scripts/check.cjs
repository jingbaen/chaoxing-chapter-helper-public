"use strict";
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const read = name => fs.readFileSync(path.join(root, name), "utf8");
const manifest = JSON.parse(read("manifest.json"));
const pkg = JSON.parse(read("package.json"));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, pkg.version);
assert.equal(manifest.minimum_chrome_version, "120");
assert.deepEqual([...manifest.permissions].sort(), ["alarms", "storage"]);
assert.equal(manifest.host_permissions, undefined);
assert.equal(manifest.externally_connectable, undefined);
assert.equal(manifest.update_url, undefined);
assert.equal(manifest.key, undefined);
assert.equal(manifest.content_security_policy.extension_pages, "script-src 'self'; object-src 'none'");
assert.ok(read("popup.html").includes(manifest.version));
assert.ok(read("bridge.js").includes(manifest.version));
assert.equal(manifest.background.service_worker, "background.js");
assert.equal(manifest.action.default_popup, "popup.html");
assert.equal(manifest.content_scripts.length, 2);
assert.deepEqual(manifest.content_scripts.map(s => s.world || "ISOLATED"), ["MAIN", "ISOLATED"]);
const expectedMatches = ["*://*.chaoxing.com/*", "https://*.sslibrary.com/*", "https://*.xuexi365.com/*"];
for (const script of manifest.content_scripts) {
  assert.deepEqual(script.matches, expectedMatches);
  assert.equal(script.all_frames, true);
  for (const name of script.js) assert.ok(fs.existsSync(path.join(root, name)));
}
const runtimeFiles = ["background.js", "engine.js", "page-agent.js", "bridge.js", "diagnostics.js", "popup.js"];
for (const name of runtimeFiles) {
  execFileSync(process.execPath, ["--check", path.join(root, name)], { stdio: "pipe" });
  assert.ok(!/\b(?:eval|fetch|XMLHttpRequest|WebSocket)\s*\(|\bsendBeacon\s*\(/.test(read(name)), `Unexpected execution/network API: ${name}`);
}
const html = read("popup.html");
for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  assert.ok(!/^(?:https?:|data:|\/\/)/i.test(match[1]), "Remote popup resource");
  assert.ok(fs.existsSync(path.join(root, match[1])), `Missing popup resource: ${match[1]}`);
}
const ignoredDirs = new Set([".git", "node_modules", "dist", "coverage"]);
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? (ignoredDirs.has(entry.name) ? [] : walk(file)) : [file];
  });
}
// Construct signatures from fragments so this checker does not match its own source.
const checks = [
  ["local user path", new RegExp("[A-Za-z]:[\\\\/]" + "Users[\\\\/][^\\s]+", "i")],
  ["private key", new RegExp("-----BEGIN " + "(?:RSA |EC |OPENSSH )?PRIVATE KEY-----")],
  ["provider credential", new RegExp("\\b(?:gh[pousr]_" + "[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\\b")],
  ["JWT", new RegExp("\\beyJ" + "[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\b")],
  ["assigned credential", new RegExp("[\"']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization|cookie)[\"']?" + "\\s*[:=]\\s*[\"'][^\"'\\r\\n]{8,}[\"']", "i")],
  ["credential-bearing URL", new RegExp("https?://[^\\s\"<>]+[?&]" + "(?:token|ticket|enc|uid|userId|courseId|chapterId|knowledgeid)=[^\\s\"<>]+", "i")]
];
const legacyFiles = /(?:\.zip$|\.har$|\.pem$|\.p12$|\.key$|\.env(?:\.|$)|本地验证结果|学习通助手诊断)/i;
const files = walk(root);
for (const file of files) {
  const relative = path.relative(root, file);
  assert.ok(!legacyFiles.test(relative), `Private/generated artifact in source: ${relative}`);
  const text = fs.readFileSync(file, "utf8");
  for (const [label, regex] of checks) assert.ok(!regex.test(text), `${label} pattern: ${relative}`);
}
console.log(`Passed: manifest, versions, local resources, ${runtimeFiles.length} runtime syntax checks, ${files.length} source files scanned.`);
console.log("Static pattern checks do not guarantee absence of sensitive data.");
