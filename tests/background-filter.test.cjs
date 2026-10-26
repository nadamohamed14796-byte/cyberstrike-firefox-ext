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
const end = source.indexOf("function buildRawRequest", start);
assert.notEqual(start, -1, "extension filter declaration must exist");
assert.notEqual(end, -1, "scope helpers must exist before buildRawRequest");

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


test("retains response bodies larger than the former 500 KB capture cap", () => {
  const start = source.indexOf("function appendResponseChunk");
  const end = source.indexOf("function combineChunks", start);
  assert.notEqual(start, -1, "appendResponseChunk helper must exist");
  assert.notEqual(end, -1, "combineChunks must follow appendResponseChunk");
  const context = vm.createContext({ Uint8Array });
  vm.runInContext(source.slice(start, end), context, {
    filename: "background/response-chunk-under-test.js",
  });

  const chunk = new Uint8Array(768 * 1024);
  chunk[0] = 65;
  chunk[chunk.length - 1] = 90;
  const responseData = { chunks: [], totalSize: 0 };
  context.appendResponseChunk(responseData, chunk);

  assert.equal(responseData.totalSize, 768 * 1024);
  assert.equal(responseData.chunks.length, 1);
  assert.equal(responseData.chunks[0].byteLength, 768 * 1024);
  assert.equal(responseData.chunks[0][0], 65);
  assert.equal(responseData.chunks[0][responseData.chunks[0].length - 1], 90);
});


test("scope requires an exact host unless a wildcard is explicit", () => {
  const context = vm.createContext({ URL });
  vm.runInContext(source.slice(start, end), context, {
    filename: "background/scope-under-test.js",
  });

  context.scope = context.normalizeScope("https://example.com/path");
  assert.equal(context.matchesScope("https://example.com/api"), true);
  assert.equal(context.matchesScope("https://api.example.com/api"), false);
  assert.equal(context.matchesScope("https://example.com.attacker.invalid/"), false);

  context.scope = context.normalizeScope("*.example.com");
  assert.equal(context.matchesScope("https://api.example.com/api"), true);
  assert.equal(context.matchesScope("https://deep.api.example.com/api"), true);
  assert.equal(context.matchesScope("https://example.com/api"), false);
  assert.equal(context.matchesScope("https://example.com.attacker.invalid/"), false);
  assert.equal(context.matchesScope("not a URL"), false);
});

test("server URL normalization removes trailing slashes and rejects invalid destinations", () => {
  const context = vm.createContext({ URL });
  vm.runInContext(source.slice(start, end), context, {
    filename: "background/url-normalization-under-test.js",
  });

  assert.equal(context.normalizeServerUrl("http://127.0.0.1:4096/"), "http://127.0.0.1:4096");
  assert.equal(context.normalizeServerUrl("https://localhost:4096/api/"), "https://localhost:4096/api");
  assert.equal(context.normalizeServerUrl("javascript:alert(1)"), "");
  assert.equal(context.normalizeServerUrl("http://user:pass@localhost:4096"), "");
  assert.equal(context.normalizeServerUrl("http://localhost:4096/?token=x"), "");
});

test("captured request targets do not contain browser-only URL fragments", () => {
  const requestStart = source.indexOf("function buildRawRequest");
  const requestEnd = source.indexOf("function extractRequestBody", requestStart);
  assert.notEqual(requestStart, -1, "buildRawRequest must exist");
  assert.notEqual(requestEnd, -1, "extractRequestBody must follow buildRawRequest");

  const context = vm.createContext({ URL, pendingBodies: new Map() });
  vm.runInContext(source.slice(requestStart, requestEnd), context, {
    filename: "background/request-target-under-test.js",
  });

  const raw = context.buildRawRequest({
    method: "GET",
    url: "https://example.com/account?tab=1#access-token",
    requestId: "request-1",
  }, []);
  assert.match(raw, /^GET \/account\?tab=1 HTTP\/1\.1/m);
  assert.equal(raw.includes("#access-token"), false);
});

test("stopping capture disconnects in-flight filters and releases pending buffers", () => {
  const removed = [];
  const disconnected = [];
  const writes = [];
  const event = { removeListener: (handler) => removed.push(handler.name) };
  const filter = { disconnect: () => disconnected.push(true) };
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
  const context = vm.createContext({
    browser,
    isCapturing: true,
    sessionID: "session-1",
    sessionInitPromise: Promise.resolve("session-1"),
    requestCount: 7,
    containerCredentials: { "firefox-default": { credentialID: "cred-1" } },
    serverSupportsResponse: true,
    pendingBodies: new Map([["req-1", "body"]]),
    pendingRequests: new Map([["req-1", { filter }]]),
    pendingResponses: new Map([["req-1", { chunks: [new Uint8Array([1])], totalSize: 1 }]]),
    onBeforeRequest() {},
    onBeforeSendHeaders() {},
    onHeadersReceived() {},
    onCompleted() {},
    onErrorOccurred() {},
  });
  const stopStart = source.indexOf("function stopCapture(clearSession = true)");
  const stopEnd = source.indexOf("// --- Message Handling ---", stopStart);
  assert.notEqual(stopStart, -1, "stopCapture must exist");
  assert.notEqual(stopEnd, -1, "message handling must follow stopCapture");
  vm.runInContext(source.slice(stopStart, stopEnd), context, {
    filename: "background/stop-capture-under-test.js",
  });

  context.stopCapture();

  assert.equal(context.isCapturing, false);
  assert.equal(context.sessionID, null);
  assert.equal(context.pendingBodies.size, 0);
  assert.equal(context.pendingRequests.size, 0);
  assert.equal(context.pendingResponses.size, 0);
  assert.equal(disconnected.length, 1);
  assert.equal(removed.length, 5);
  assert.equal(writes.at(-1).isCapturing, false);
  assert.equal(Object.keys(writes.at(-1).containerCredentials).length, 0);
});

test("popup HTML escaping protects data returned from the captured target", () => {
  const popupPath = path.join(__dirname, "..", "popup", "popup.js");
  const popup = fs.readFileSync(popupPath, "utf8");
  const helperStart = popup.indexOf("function escapeHTML(value)");
  const helperEnd = popup.indexOf("\n}", helperStart) + 2;
  assert.notEqual(helperStart, -1, "popup escapeHTML helper must exist");
  assert.ok(helperEnd > helperStart, "popup escapeHTML helper must close");

  const context = vm.createContext({});
  vm.runInContext(popup.slice(helperStart, helperEnd), context, {
    filename: "popup/escape-html-under-test.js",
  });
  assert.equal(
    context.escapeHTML('<img src=x onerror="alert(1)"> & \''),
    "&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;",
  );

  for (const expression of [
    "escapeHTML(cred.label)",
    "escapeHTML(containerName)",
    "escapeHTML(cred.credentialID)",
    "escapeHTML(c.role_id)",
    "escapeHTML(headerKeys)",
    "escapeHTML(r.name)",
    "escapeHTML(r.permissions",
    "escapeHTML(o.name)",
    "escapeHTML(fields",
    "escapeHTML(f.method)",
    "escapeHTML(f.name)",
    "escapeHTML(f.endpoint",
  ]) assert.ok(popup.includes(expression), "popup must escape " + expression);
});
