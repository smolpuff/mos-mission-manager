"use strict";

const { runnerLabel, missionRows } = require("./windows-tray-state");

function createWindowsTray({ platform, Tray, Menu, icon, getWindow, isQuitting, quit, start, stop, onError }) {
  let tray = null;
  let status = {};
  let busy = false;
  let rendered = "";

  function openWindow() {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    win.setSkipTaskbar(false);
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
      action: busy ? "Please wait…" : status.running ? "Stop" : "Start",
      busy,
      stats: [
        ["Active", stats.active], ["NFTs ready", stats.nftsAvailable],
        ["Claimable", stats.claimable], ["Claimed", stats.claimed],
      ].map(([label, value]) => `${label}: ${Number(value || 0).toLocaleString()}`),
      missions: missionRows(status),
    };
    const signature = JSON.stringify(snapshot);
    if (signature === rendered) return;
    const text = (value) => value.replace(/&/g, "&&");
    const menu = Menu.buildFromTemplate([
      { id: "runner-status", label: snapshot.runner, enabled: false },
      { id: "runner-action", label: snapshot.action, enabled: !busy, click: toggleRunner },
      { type: "separator" },
      ...snapshot.stats.map((label) => ({ label, enabled: false })),
      { type: "separator" },
      ...snapshot.missions.map((label, index) => ({ id: `mission-${index + 1}`, label: text(label), enabled: false })),
      { type: "separator" },
      { id: "open", label: "Open Missions", click: openWindow },
      { id: "quit", label: "Quit Missions", click: quit },
    ]);
    tray.setToolTip(`Missions — ${snapshot.runner}`);
    tray.setContextMenu(menu);
    rendered = signature;
  }

  function sync(enabled) {
    if (platform !== "win32") return;
    if (enabled === true) {
      if (tray) return;
      tray = new Tray(icon);
      tray.on("double-click", openWindow);
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
    win.setSkipTaskbar(true);
    win.hide();
    return true;
  }

  function destroy() {
    tray?.destroy();
    tray = null;
    rendered = "";
  }

  return { sync, updateStatus, closeWindow, openWindow, destroy, isEnabled: () => tray !== null };
}

module.exports = { createWindowsTray };
