"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { transformSync } = require("esbuild");

// Transform individual modules in memory; do not build or launch the app.
function loadRendererModule(relativePath, dependencies, globals = {}) {
  const filename = path.resolve(__dirname, "../..", relativePath);
  const { code } = transformSync(fs.readFileSync(filename, "utf8"), {
    loader: filename.endsWith(".jsx") ? "jsx" : "js",
    format: "cjs",
  });
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, Blob,
    require(name) {
      assert.ok(name in dependencies, `Unexpected eager dependency: ${name}`);
      return dependencies[name];
    },
    ...globals,
  }, { filename });
  return module.exports;
}

function mountBackendState(options) {
  const effects = [];
  const states = [];
  const timers = new Map();
  const subscriptions = new Map();
  const requests = [];
  const unsubscribed = [];
  let resolveSnapshot;
  const snapshot = new Promise((resolve) => { resolveSnapshot = resolve; });
  const bridge = {
    getState(request) { requests.push({ ...request }); return snapshot; },
  };
  for (const channel of ["Output", "Command", "Status", "Event"]) {
    bridge[`onBackend${channel}`] = (callback) => {
      subscriptions.set(channel, callback);
      return () => { unsubscribed.push(channel); subscriptions.delete(channel); };
    };
  }
  const react = {
    useState(initial) {
      const index = states.push(initial) - 1;
      return [initial, (update) => {
        states[index] = typeof update === "function" ? update(states[index]) : update;
      }];
    },
    useRef: (current) => ({ current }),
    useEffect: (callback) => effects.push(callback),
  };
  const { default: useBackendState } = loadRendererModule(
    "renderer/src/components/useBackendState/app.js",
    { react, "../useDesktopBridge": { default: () => bridge, __esModule: true } },
    {
      setTimeout(callback) { const id = {}; timers.set(id, callback); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
  );
  useBackendState(options);
  const cleanups = effects.map((effect) => effect());
  return {
    states, requests, subscriptions, unsubscribed, timers, resolveSnapshot,
    flush() { for (const [id, callback] of timers) { timers.delete(id); callback(); } },
    unmount() { for (const cleanup of cleanups) cleanup?.(); },
  };
}

test("CLI subscribes only to logs and requests no dashboard snapshots", async () => {
  const mounted = mountBackendState({ includeLogs: true, includeCommands: false, includeStatus: false });
  assert.deepEqual([...mounted.subscriptions.keys()], ["Output"]);
  assert.deepEqual(mounted.requests, [{ includeLogs: true, includeStatus: false }]);
  const entry = { id: 1, text: "Claimed reward", byteLength: 80 };
  mounted.subscriptions.get("Output")(entry);
  mounted.flush();
  // Snapshot delivery can race with streamed entries: retain the entry once.
  mounted.resolveSnapshot({ logs: [entry] });
  await Promise.resolve();
  assert.equal(mounted.states[1].entries.length, 1);
  assert.equal(mounted.states[1].entries[0].text, entry.text);
  mounted.subscriptions.get("Output")({ id: 2, text: "Assigned NFT", byteLength: 80 });
  mounted.unmount();
  assert.equal(mounted.timers.size, 0);
  assert.deepEqual(mounted.unsubscribed, ["Output"]);
});

test("dashboard keeps its status, command and event subscriptions", async () => {
  const mounted = mountBackendState();
  assert.deepEqual([...mounted.subscriptions.keys()], ["Command", "Status", "Event"]);
  mounted.resolveSnapshot({ status: { running: true }, logs: [] });
  await Promise.resolve();
  assert.equal(mounted.states[0].running, true);
  mounted.subscriptions.get("Status")({ running: false });
  assert.equal(mounted.states[0].running, false);
  mounted.unmount();
});

test("CLI keeps the existing bounded log history during sustained output", async () => {
  const mounted = mountBackendState({ includeLogs: true, includeCommands: false, includeStatus: false });
  mounted.resolveSnapshot({ logs: [] });
  await Promise.resolve();
  const output = mounted.subscriptions.get("Output");
  for (let id = 1; id <= 1400; id += 1) {
    output({ id, text: `Line ${id}`, byteLength: 80 });
  }
  mounted.flush();
  assert.equal(mounted.states[1].entries.length, 1200);
  assert.equal(mounted.states[1].entries[0].id, 201);
  assert.equal(mounted.states[1].entries.at(-1).id, 1400);
  assert.equal(mounted.states[1].totalBytes, 1200 * 80);
  output({ id: 1401, text: "Large diagnostic entry", byteLength: 4 * 1024 * 1024 });
  mounted.flush();
  assert.equal(mounted.states[1].entries.length, 1);
  assert.equal(mounted.states[1].entries[0].id, 1401);
  mounted.unmount();
});

test("opening the CLI does not eagerly import the dashboard", () => {
  const CliPage = () => {};
  const react = {
    Component: class {},
    lazy: () => function DeferredControlPage() {},
    createElement: (type, props, ...children) => ({ type, props, children }),
  };
  const { App } = loadRendererModule("renderer/src/App.jsx", {
    react,
    "./pages/CliPage": { default: CliPage, __esModule: true },
  }, { window: { location: { hash: "#/cli" } } });
  assert.equal(App().children[0].type, CliPage);
});

