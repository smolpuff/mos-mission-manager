"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createWindowsTray } = require("../windows-tray");

function fixture(platform = "win32") {
  const calls = [];
  const instances = [];
  let quitting = false;
  let minimized = false;
  let startAction = async () => { calls.push("start"); };
  const win = {
    isDestroyed: () => false, isMinimized: () => minimized,
    restore() { calls.push("restore"); minimized = false; },
    show() { calls.push("show"); }, hide() { calls.push("hide"); }, focus() { calls.push("focus"); },
    setSkipTaskbar(value) { calls.push(["skip-taskbar", value]); },
  };
  const controller = createWindowsTray({
    platform,
    Tray: class {
      constructor(icon) { this.icon = icon; this.events = {}; instances.push(this); }
      on(event, handler) { this.events[event] = handler; }
      setToolTip(value) { this.tooltip = value; }
      setContextMenu(menu) { this.menu = menu; }
      destroy() { this.destroyed = true; calls.push("destroy"); }
    },
    Menu: { buildFromTemplate: (items) => ({ items }) },
    icon: "app-icon.png", getWindow: () => win, isQuitting: () => quitting,
    start: () => startAction(), stop: async () => calls.push("stop"),
    quit() { quitting = true; calls.push("quit"); },
    onError(error) { calls.push(["error", error.message]); },
  });
  const item = (id) => instances.at(-1).menu.items.find((entry) => entry.id === id);
  return { controller, calls, instances, item, minimize: () => { minimized = true; },
    setStart: (action) => { startAction = action; } };
}

test("tray is opt-in and Windows only", () => {
  for (const platform of ["win32", "darwin", "linux"]) {
    const f = fixture(platform);
    f.controller.sync(false);
    assert.equal(f.instances.length, 0);
    assert.equal(f.controller.closeWindow({ preventDefault() { assert.fail("disabled close intercepted"); } }), false);
    f.controller.sync(true);
    assert.equal(f.controller.isEnabled(), platform === "win32");
    assert.equal(f.instances.length, platform === "win32" ? 1 : 0);
  }
});

test("closing hides the retained window without stopping or quitting", () => {
  const f = fixture();
  f.controller.sync(true);
  assert.equal(f.controller.closeWindow({ preventDefault() { f.calls.push("prevent-close"); } }), true);
  assert.deepEqual(f.calls, ["prevent-close", ["skip-taskbar", true], "hide"]);
  assert.equal(f.controller.isEnabled(), true);
});

test("Open, single-click and right-click restore taskbar access and a minimized window", () => {
  const f = fixture();
  f.controller.sync(true);
  f.minimize();
  f.item("open").click();
  assert.deepEqual(f.calls, [["skip-taskbar", false], "restore", "show", "focus"]);
  f.calls.length = 0;
  f.instances[0].events["click"]();
  assert.equal(f.instances[0].events["double-click"], undefined);
  assert.deepEqual(f.calls, [["skip-taskbar", false], "show", "focus"]);
  f.calls.length = 0;
  f.minimize();
  const menu = f.instances[0].menu;
  f.instances[0].events["right-click"]();
  assert.deepEqual(f.calls, [["skip-taskbar", false], "restore", "show", "focus"]);
  assert.equal(f.instances[0].menu, menu);
});

test("disabling restores the window before destroying its tray access", () => {
  const f = fixture();
  f.controller.sync(true);
  f.controller.closeWindow({ preventDefault() {} });
  f.calls.length = 0;
  f.controller.sync(false);
  assert.deepEqual(f.calls, [["skip-taskbar", false], "show", "focus", "destroy"]);
  assert.equal(f.controller.isEnabled(), false);
  assert.equal(f.controller.closeWindow({ preventDefault() { assert.fail("disabled close intercepted"); } }), false);
});

test("menu status updates Start/Stop, four mission rows, and literal ampersands", async () => {
  const f = fixture();
  f.controller.updateStatus({ running: false });
  f.controller.sync(true);
  assert.equal(f.item("runner-action").label, "▶ Start");
  await f.item("runner-action").click();
  assert.deepEqual(f.calls, ["start"]);
  f.controller.updateStatus({ running: true, watcherRunning: true,
    guiMissionSlots: [{ slot: 1, missionName: "A & B", missionLevel: 15, missionActive: true, assignedNft: "nft", progress: 3, goal: 10 }] });
  assert.equal(f.item("runner-status").label, "🟢 Watching missions…");
  assert.equal(f.item("runner-action").label, "🛑 Stop");
  assert.match(f.item("mission-1").label, /A && B · Level 15 · Active · 3 \/ 10 \(30%\)/);
  assert.equal(f.instances[0].menu.items.filter((row) => row.id?.startsWith("mission-")).length, 4);
  await f.item("runner-action").click();
  assert.deepEqual(f.calls, ["start", "stop"]);
});

test("busy runner actions cannot be submitted twice and errors restore controls", async () => {
  const f = fixture();
  let reject;
  f.setStart(() => new Promise((_resolve, fail) => { f.calls.push("start"); reject = fail; }));
  f.controller.sync(true);
  const pending = f.item("runner-action").click();
  assert.equal(f.item("runner-action").enabled, false);
  await f.item("runner-action").click();
  assert.deepEqual(f.calls, ["start"]);
  reject(new Error("start failed"));
  await pending;
  assert.equal(f.item("runner-action").enabled, true);
  assert.deepEqual(f.calls.at(-1), ["error", "start failed"]);
});

test("Quit remains an actual quit and close interception is bypassed", () => {
  const f = fixture();
  f.controller.sync(true);
  f.item("quit").click();
  assert.deepEqual(f.calls, ["quit"]);
  assert.equal(f.controller.closeWindow({ preventDefault() { assert.fail("quit intercepted"); } }), false);
  f.controller.destroy();
  assert.equal(f.instances[0].destroyed, true);
});

test("status refresh does not recreate icons or unchanged native menus", () => {
  const f = fixture();
  f.controller.sync(true);
  const menu = f.instances[0].menu;
  f.controller.sync(true);
  f.controller.updateStatus({ unrelated: "changed" });
  assert.equal(f.instances.length, 1);
  assert.equal(f.instances[0].menu, menu);
});
