"use strict";

const path = require("path");
const { runnerLabel, missionRows } = require("./windows-tray-state");

function createMacMenuBar({ platform, app, Tray, Menu, nativeImage, getWindow, isQuitting, quit, start, stop, onError }) {
  let tray = null;
  let status = {};
  let busy = false;
  let rendered = "";

  function openWindow() {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    app.dock.show();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  async function toggleRunner() {
    if (busy) return;
    busy = true;
    updateStatus(status);
    try {
      if (status.running) await stop();
      else await start();
    } catch (error) {
      onError(error);
    } finally {
      busy = false;
      updateStatus(status);
    }
  }

  function updateStatus(next) {
    status = next;
    if (!tray) return;
    const stats = status.currentMissionStats || {};
    const snapshot = {
      runner: runnerLabel(status),
      action: busy ? "⏳ Please wait…" : status.running ? "⏹ Stop" : "▶ Start",
      busy,
      stats: status.running ? [
        ["🎯 Active", stats.active], ["💎 NFTs ready", stats.nftsAvailable],
        ["🥞 Claimable", stats.claimable], ["🤑 Claimed", stats.claimed],
      ].map(([label, value]) => `${label}: ${Number(value || 0).toLocaleString()}`)
        : ["Start Missions to see live stats."],
      missions: missionRows(status),
    };
    const signature = JSON.stringify(snapshot);
    if (signature === rendered) return;
    const menu = Menu.buildFromTemplate([
      { id: "runner-status", label: `${!status.running ? "🔴" : status.watchLoopEnabled === false ? "🟡" : "🟢"} ${snapshot.runner}`, enabled: false },
      { id: "runner-action", label: snapshot.action, enabled: !busy, click: toggleRunner },
      { type: "separator" },
      ...snapshot.stats.map((label) => ({ label, enabled: false })),
      { type: "separator" },
      ...snapshot.missions.map((label, index) => ({ id: `mission-${index + 1}`, label, enabled: false })),
      { type: "separator" },
      { id: "open", label: "🪟 Show Missions App", click: openWindow },
      { id: "quit", label: "❌ Quit Missions App", click: quit },
    ]);
    tray.setToolTip(`Missions App — ${snapshot.runner}`);
    tray.setContextMenu(menu);
    rendered = signature;
  }

  function sync(enabled) {
    if (platform !== "darwin") return;
    if (enabled === true) {
      if (tray) return;
      const icon = nativeImage.createFromPath(path.join(__dirname, "icons", "menuBarTemplate.png"));
      icon.setTemplateImage(true);
      tray = new Tray(icon);
      tray.on("mouse-down", openWindow);
      tray.on("right-click", openWindow);
      rendered = "";
      updateStatus(status);
    } else if (tray) {
      // Restore access before removing the only control for a hidden window.
      openWindow();
      destroy();
    }
  }

  function closeWindow(event) {
    if (!tray || isQuitting()) return false;
    const win = getWindow();
    if (!win || win.isDestroyed()) return false;
    event.preventDefault();
    win.hide();
    app.dock.hide();
    return true;
  }

  function destroy() {
    tray?.destroy();
    tray = null;
    rendered = "";
  }

  return { sync, updateStatus, closeWindow, openWindow, destroy, isEnabled: () => tray !== null };
}

module.exports = { createMacMenuBar };
