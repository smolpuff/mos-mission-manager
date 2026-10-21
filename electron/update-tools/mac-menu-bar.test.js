// Mac menu bar temporarily disabled; retained for later work.
// "use strict";
//
// const test = require("node:test");
// const assert = require("node:assert/strict");
// const { createMacMenuBar } = require("../mac-menu-bar");
//
// function setup(platform = "darwin") {
//   const calls = [];
//   let menu;
//   let quitting = false;
//   let popoverVisible = false;
//   const popover = {
//     isDestroyed: () => false,
//     isVisible: () => popoverVisible,
//     getSize: () => [380, 500],
//     setPosition: (x, y) => calls.push(["position", x, y]),
//     on() {},
//     hide: () => { popoverVisible = false; calls.push("popover.hide"); },
//     show: () => { popoverVisible = true; calls.push("popover.show"); },
//     focus: () => calls.push("popover.focus"),
//     destroy: () => calls.push("popover.destroy"),
//   };
//   const win = {
//     isDestroyed: () => false,
//     isMinimized: () => true,
//     hide: () => calls.push("hide"),
//     restore: () => calls.push("restore"),
//     show: () => calls.push("show"),
//     focus: () => calls.push("focus"),
//   };
//   const controller = createMacMenuBar({
//     platform,
//     app: { dock: { show: () => calls.push("dock.show"), hide: () => calls.push("dock.hide") } },
//     Tray: class {
//       constructor() { calls.push("tray.create"); }
//       setToolTip() {}
//       setContextMenu(value) { menu = value; }
//       on() {}
//       getBounds() { return { x: 990, y: 0, width: 20, height: 24 }; }
//       destroy() { calls.push("tray.destroy"); }
//     },
//     Menu: { buildFromTemplate: (value) => { menu = value; return value; } },
//     screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 24, width: 1024, height: 768 } }) },
//     createPopover: async (onCreated) => { onCreated(popover); return popover; },
//     nativeImage: { createFromPath: () => ({ setTemplateImage() {} }) },
//     getWindow: () => win,
//     isQuitting: () => quitting,
//     quit: () => calls.push("quit"),
//   });
//   return { controller, calls, getMenu: () => menu, setQuitting: () => { quitting = true; } };
// }
//
// test("menu bar mode is opt-in and has no effect on Windows or Linux", () => {
//   for (const platform of ["darwin", "win32", "linux"]) {
//     const { controller, calls } = setup(platform);
//     controller.sync(false);
//     assert.equal(controller.closeWindow({ preventDefault() { assert.fail("close intercepted"); } }), false);
//     if (platform !== "darwin") controller.sync(true);
//     assert.equal(controller.isEnabled(), false);
//     assert.deepEqual(calls, []);
//   }
// });
//
// test("closing to the menu bar retains the window and reopening restores it and the Dock", () => {
//   const { controller, calls, getMenu } = setup();
//   controller.sync(true);
//   controller.sync(true);
//   assert.equal(calls.filter((value) => value === "tray.create").length, 1);
//   assert.equal(controller.closeWindow({ preventDefault: () => calls.push("preventDefault") }), true);
//   assert.deepEqual(calls.slice(1), ["preventDefault", "hide", "dock.hide"]);
//   getMenu().find((item) => item.label === "Open Missions").click();
//   assert.deepEqual(calls.slice(-4), ["dock.show", "restore", "show", "focus"]);
//   assert.equal(controller.isEnabled(), true);
// });
//
// test("disabling the setting restores access before removing the menu bar item", () => {
//   const { controller, calls } = setup();
//   controller.sync(true);
//   controller.closeWindow({ preventDefault() {} });
//   controller.sync(false);
//   assert.deepEqual(calls.slice(-5), ["dock.show", "restore", "show", "focus", "tray.destroy"]);
//   assert.equal(controller.isEnabled(), false);
// });
//
// test("explicit quit uses the existing quit callback and never intercepts window closure", () => {
//   const { controller, calls, getMenu, setQuitting } = setup();
//   controller.sync(true);
//   getMenu().find((item) => item.label === "Quit Missions").click();
//   assert.equal(calls.at(-1), "quit");
//   setQuitting();
//   assert.equal(controller.closeWindow({ preventDefault() { assert.fail("quit intercepted"); } }), false);
//   assert.equal(calls.includes("hide"), false);
// });
//
// test("popover stays within the display and toggles without showing the Dock", async () => {
//   const { controller, calls } = setup();
//   controller.sync(true);
//   await controller.togglePopover();
//   assert.deepEqual(calls.slice(-3), [["position", 644, 24], "popover.show", "popover.focus"]);
//   assert.equal(calls.includes("dock.show"), false);
//   await controller.togglePopover();
//   assert.equal(calls.at(-1), "popover.hide");
//   controller.sync(false);
//   assert.ok(calls.includes("popover.destroy"));
// });
//
// test("native menu reflects running, starting, paused, and stopped states", () => {
//   const { controller, getMenu } = setup();
//   controller.sync(true);
//   for (const [status, label] of [
//     [{ running: false }, "Stopped"],
//     [{ running: true }, "Starting…"],
//     [{ running: true, watcherRunning: true }, "Watching missions..."],
//     [{ running: true, watcherRunning: true, watchLoopEnabled: false }, "Paused"],
//   ]) {
//     controller.updateStatus(status);
//     assert.equal(getMenu()[0].label, `Runner: ${label}`);
//     assert.equal(getMenu()[0].enabled, false);
//   }
// });
