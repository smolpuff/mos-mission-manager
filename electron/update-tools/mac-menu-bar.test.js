"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createMacMenuBar } = require("../mac-menu-bar");
const { createWindowsTray } = require("../windows-tray");
const { flushConfig } = require("../../src/config");

function fixture(platform = "darwin", factory = createMacMenuBar) {
  const calls = [];
  const instances = [];
  let quitting = false;
  let minimized = false;
  let start = async () => { calls.push("start"); };
  let imagePath;
  const template = { setTemplateImage(value) { this.isTemplate = value; } };
  const win = {
    isDestroyed: () => false, isMinimized: () => minimized,
    restore() { calls.push("restore"); minimized = false; },
    show() { calls.push("show"); }, hide() { calls.push("hide"); }, focus() { calls.push("focus"); },
    setSkipTaskbar(value) { calls.push(["skip-taskbar", value]); },
  };
  const controller = factory({
    platform, icon: "app.png",
    app: { dock: { show() { calls.push("dock.show"); }, hide() { calls.push("dock.hide"); } } },
    nativeImage: { createFromPath(value) { imagePath = value; return template; } },
    Tray: class {
      constructor(icon) { this.icon = icon; this.events = {}; instances.push(this); }
      on(event, handler) { this.events[event] = handler; }
      setToolTip(value) { this.tooltip = value; }
      setContextMenu(menu) { this.menu = menu; this.menuAttachments = (this.menuAttachments || 0) + 1; }
      destroy() { calls.push("destroy"); }
    },
    Menu: { buildFromTemplate: items => ({ items, getMenuItemById: id => items.find(item => item.id === id) }) },
    getWindow: () => win, isQuitting: () => quitting,
    start: () => start(), stop: async () => { calls.push("stop"); },
    quit() { quitting = true; calls.push("quit"); },
    onError(error) { calls.push(["error", error.message]); },
  });
  return { controller, calls, instances, template, win, imagePath: () => imagePath,
    item: id => instances.at(-1).menu.items.find(item => item.id === id),
    minimize: () => { minimized = true; }, setStart: action => { start = action; } };
}

test("Mac menu bar is off by default and only available on macOS", () => {
  for (const platform of ["darwin", "win32", "linux"]) {
    const f = fixture(platform);
    f.controller.sync(false);
    assert.equal(f.instances.length, 0);
    assert.equal(f.controller.closeWindow({ preventDefault() { assert.fail("disabled close intercepted"); } }), false);
    f.controller.sync(true);
    assert.equal(f.controller.isEnabled(), platform === "darwin");
    if (platform === "darwin") {
      assert.equal(f.template.isTemplate, true);
      assert.ok(f.imagePath().endsWith("menuBarTemplate.png"));
    }
  }
});

test("Mac menus match Windows controls, stats and four mission summaries", () => {
  const mac = fixture();
  const win = fixture("win32", createWindowsTray);
  mac.controller.sync(true);
  win.controller.sync(true);
  const statuses = [
    {},
    { running: true },
    { running: true, watcherRunning: true, currentMissionStats: { active: 4, nftsAvailable: 7, claimable: 2, claimed: 9 },
      guiMissionSlots: [{ slot: 1, missionName: "A & B", missionLevel: 15, missionActive: true, assignedNft: "NFT", progress: 3, goal: 10 }] },
    { running: true, watchLoopEnabled: false },
    { running: false, slotUnlockSummary: { canUnlockMore: true, nextUnlockSlot: 4 } },
  ];
  const presentation = f => f.instances[0].menu.items.filter(item => item.visible !== false).map(({ id, label, enabled, type, icon }) => ({
    id: id?.startsWith("stats-") ? undefined : id, label: label?.replace(/&&/g, "&").replace(/^(?:⏹|🪟|❌) /u, ""), enabled: id === "runner-action" ? enabled : undefined, type, icon,
  }));
  for (const status of statuses) {
    mac.controller.updateStatus(status);
    win.controller.updateStatus(status);
    assert.deepEqual(presentation(mac), presentation(win));
    for (const item of mac.instances[0].menu.items) {
      if (item.type === "separator" || item.id === "runner-action") continue;
      assert.notEqual(item.enabled, false, "Mac informational text must retain normal contrast");
    }
    assert.equal(mac.instances[0].tooltip, win.instances[0].tooltip);
    assert.equal(mac.instances[0].menu.items.filter(item => item.id?.startsWith("mission-")).length, 4);
  }
  mac.controller.updateStatus(statuses[2]);
  assert.ok(mac.item("mission-1").label.includes("A & B"));
  assert.equal(mac.item("mission-1").icon, undefined);
});

test("Mac status icon leaves native menu tracking alone; Show restores the Dock and app", () => {
  const f = fixture();
  f.controller.sync(true);
  f.controller.closeWindow({ preventDefault() { f.calls.push("prevent-close"); } });
  assert.deepEqual(f.calls, ["prevent-close", "hide", "dock.hide"]);
  f.calls.length = 0;
  f.minimize();
  assert.equal(f.instances[0].events["mouse-down"], undefined);
  assert.equal(f.instances[0].events["right-click"], undefined);
  assert.deepEqual(f.calls, []);
  assert.equal(f.instances[0].events["double-click"], undefined);
  f.calls.length = 0;
  f.item("open").click();
  assert.deepEqual(f.calls, ["dock.show", "restore", "show", "focus"]);
});

test("disabling Mac menu bar mode restores app access before removing the icon", () => {
  const f = fixture();
  f.controller.sync(true);
  f.controller.closeWindow({ preventDefault() {} });
  f.calls.length = 0;
  f.controller.sync(false);
  assert.deepEqual(f.calls, ["dock.show", "show", "focus", "destroy"]);
  assert.equal(f.controller.isEnabled(), false);
});

test("Mac menu Start and Stop call the existing runner actions; Quit bypasses close interception", async () => {
  const f = fixture();
  f.controller.sync(true);
  await f.item("runner-action").click();
  assert.deepEqual(f.calls, ["start"]);
  f.controller.updateStatus({ running: true });
  await f.item("runner-action").click();
  assert.deepEqual(f.calls, ["start", "stop"]);
  f.item("quit").click();
  assert.equal(f.calls.at(-1), "quit");
  assert.equal(f.controller.closeWindow({ preventDefault() { assert.fail("quit intercepted"); } }), false);
});

test("Mac runner controls reject duplicate actions and recover from a failed start", async () => {
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

test("unchanged Mac status does not recreate the menu or icon", () => {
  const f = fixture();
  f.controller.sync(true);
  const menu = f.instances[0].menu;
  f.controller.sync(true);
  f.controller.updateStatus({ unrelated: true });
  assert.equal(f.instances.length, 1);
  assert.equal(f.instances[0].menu, menu);
});

test("changed status retains the attached native menu and updates its existing items", () => {
  const f = fixture();
  f.controller.sync(true);
  const menu = f.instances[0].menu;
  f.controller.updateStatus({ running: true, currentMissionStats: { active: 3 } });
  assert.equal(f.instances[0].menu, menu);
  assert.equal(f.instances[0].menuAttachments, 1);
  assert.equal(f.item("stats-0").label, "🎯 Active: 3");
  assert.equal(f.item("stats-3").visible, true);
  assert.equal(f.item("runner-action").label, "Stop");
  f.controller.updateStatus({ running: false });
  assert.equal(f.item("stats-0").label, "Start Missions to see live stats.");
  assert.equal(f.item("stats-3").visible, false);
  assert.equal(f.instances[0].menuAttachments, 1);
});

test("runner config writes preserve the Mac setting changed in Settings", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mac-menu-bar-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "config.json");
  for (const enabled of [true, false]) {
    fs.writeFileSync(configPath, JSON.stringify({ macMenuBarEnabled: enabled }));
    flushConfig({ configPath, config: { macMenuBarEnabled: !enabled } }, () => {});
    assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).macMenuBarEnabled, enabled);
  }
});
