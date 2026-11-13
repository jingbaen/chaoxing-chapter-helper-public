"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { deflateRawSync } = require("node:zlib");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
execFileSync(process.execPath, [path.join(__dirname, "check.cjs")], { stdio: "inherit" });
const version = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"))).version;
const files = ["manifest.json", "background.js", "engine.js", "page-agent.js", "bridge.js", "popup.html", "popup.css", "popup.js", "diagnostics.js", "LICENSE"];
const dist = path.join(root, "dist");
fs.mkdirSync(dist, { recursive: true });
const output = path.join(dist, `chaoxing-chapter-helper-${version}.zip`);
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
// Small deterministic ZIP32 writer: no dependencies, shell or file timestamps.
const local = [], central = [];
let offset = 0;
for (const file of files) {
  const name = Buffer.from(file, "utf8");
  const data = fs.readFileSync(path.join(root, file));
  const compressed = deflateRawSync(data);
  const crc = crc32(data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x800, 6);
  header.writeUInt16LE(8, 8);
  header.writeUInt16LE(0x21, 12); // 1980-01-01, no private filesystem timestamps.
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(name.length, 26);
  local.push(header, name, compressed);
  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt16LE(20, 4);
  entry.writeUInt16LE(20, 6);
  entry.writeUInt16LE(0x800, 8);
  entry.writeUInt16LE(8, 10);
  entry.writeUInt16LE(0x21, 14);
  entry.writeUInt32LE(crc, 16);
  entry.writeUInt32LE(compressed.length, 20);
  entry.writeUInt32LE(data.length, 24);
  entry.writeUInt16LE(name.length, 28);
  entry.writeUInt32LE(offset, 42);
  central.push(entry, name);
  offset += header.length + name.length + compressed.length;
}
const directory = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);
fs.writeFileSync(output, Buffer.concat([...local, directory, end]));
console.log(`Created dist/${path.basename(output)} (${files.length} allowlisted files)`);
