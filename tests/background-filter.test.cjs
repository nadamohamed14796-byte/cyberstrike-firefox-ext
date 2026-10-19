const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "background", "background.js"),
  "utf8",
);
const start = source.indexOf("// File extensions to filter out");
const end = source.indexOf("function normalizeScope", start);
assert.notEqual(start, -1, "extension filter declaration must exist");
assert.notEqual(end, -1, "shouldFilter function must exist after filter declaration");

const context = vm.createContext({ URL });
vm.runInContext(source.slice(start, end), context, {
  filename: "background/filter-under-test.js",
});

test("captures JavaScript, module, and source-map responses", () => {
  for (const url of [
    "https://target.example/assets/app.js",
    "https://target.example/assets/chunk.mjs",
    "https://target.example/assets/app.js?v=42",
    "https://target.example/assets/app.js.map",
    "https://target.example/assets/app.js.map?cache=1",
  ]) {
    assert.equal(context.shouldFilter(url), false, url);
  }
});

test("continues filtering non-analysis static assets", () => {
  for (const url of [
    "https://target.example/assets/logo.png",
    "https://target.example/assets/site.css",
    "https://target.example/assets/font.woff2",
    "https://target.example/media/clip.mp4",
  ]) {
    assert.equal(context.shouldFilter(url), true, url);
  }
});
