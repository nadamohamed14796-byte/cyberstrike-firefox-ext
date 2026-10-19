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


test("switches the active session without registering duplicate listeners", () => {
  const listenerCalls = [];
  const writes = [];
  const event = {
    addListener: (...args) => listenerCalls.push(["add", ...args]),
    removeListener: (...args) => listenerCalls.push(["remove", ...args]),
  };
  const browser = {
    webRequest: {
      onBeforeRequest: event,
      onBeforeSendHeaders: event,
      onHeadersReceived: event,
      onCompleted: event,
      onErrorOccurred: event,
    },
    storage: { local: { set: (value) => { writes.push(value); return Promise.resolve(); } } },
  };
  const start = source.indexOf("function startCapture(options = {})");
  const end = source.indexOf("function stopCapture", start);
  assert.notEqual(start, -1, "startCapture function must exist");
  assert.notEqual(end, -1, "stopCapture must follow startCapture");

  const context = vm.createContext({
    browser,
    console,
    isCapturing: false,
    sessionID: null,
    sessionInitPromise: null,
    serverUrl: "http://127.0.0.1:4096",
    scope: "first.example",
    requestCount: 0,
    containerCredentials: {},
    serverSupportsResponse: true,
    onBeforeRequest() {},
    onBeforeSendHeaders() {},
    onHeadersReceived() {},
    onCompleted() {},
    onErrorOccurred() {},
  });
  vm.runInContext(source.slice(start, end), context, {
    filename: "background/start-capture-under-test.js",
  });

  context.startCapture({ sessionID: "session-one" });
  const firstListenerCount = listenerCalls.filter(([action]) => action === "add").length;
  context.scope = "second.example";
  context.startCapture({ sessionID: "session-two" });

  assert.equal(context.sessionID, "session-two");
  assert.equal(context.scope, "second.example");
  assert.equal(context.requestCount, 0);
  assert.equal(
    listenerCalls.filter(([action]) => action === "add").length,
    firstListenerCount,
    "restarting while capturing must not add duplicate listeners",
  );
  assert.equal(writes.at(-1).activeSessionID, "session-two");
  assert.equal(writes.at(-1).scope, "second.example");
});
