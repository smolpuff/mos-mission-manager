// Mac menu bar temporarily disabled; retained for later work.
// "use strict";
//
// const path = require("path");
// const { runnerLabel, missionCards } = require("./menu-bar-state");
//
// function createMacMenuBar({ platform, app, Tray, Menu, nativeImage, getWindow, isQuitting, quit, start, stop, loadImage, onError = console.error }) {
//   let tray = null;
//   let menu = null;
//   let status = {};
//   let busy = false;
//   const artwork = new Map();
//
//   function openWindow() {
//     const win = getWindow();
//     if (!win || win.isDestroyed()) return;
//     app.dock.show();
//     if (win.isMinimized()) win.restore();
//     win.show();
//     win.focus();
//   }
//
//   async function toggleRunner() {
//     if (busy) return;
//     busy = true;
//     updateStatus(status);
//     try {
//       if (status.running) await stop();
//       else await start();
//     } catch (error) {
//       onError(error);
//     } finally {
//       busy = false;
//       updateStatus(status);
//     }
//   }
//
//   function loadArtwork(cards) {
//     const activeUrls = new Set(cards.map((card) => card.imageSrc).filter(Boolean));
//     for (const url of artwork.keys()) {
//       if (!activeUrls.has(url)) artwork.delete(url);
//     }
//     for (const url of activeUrls) {
//       const previous = artwork.get(url);
//       if (previous && (previous.image || previous.pending || Date.now() < previous.retryAt)) continue;
//       const entry = { pending: true, image: null, retryAt: 0 };
//       artwork.set(url, entry);
//       Promise.resolve().then(() => loadImage(url)).then((image) => {
//         if (!tray || artwork.get(url) !== entry) return;
//         entry.pending = false;
//         entry.image = image;
//         updateStatus(status);
//       }).catch(() => {
//         entry.pending = false;
//         entry.retryAt = Date.now() + 60000;
//       });
//     }
//   }
//
//   function updateStatus(next) {
//     status = next;
//     if (!tray || !menu) return;
//     tray.setToolTip(`Missions — ${runnerLabel(status)}`);
//     menu.getMenuItemById("runner-status").label = runnerLabel(status);
//     const action = menu.getMenuItemById("runner-action");
//     action.label = busy ? "Please wait…" : status.running ? "Stop" : "Start";
//     action.enabled = !busy;
//     const stats = status.currentMissionStats || {};
//     for (const [key, label, icon] of [
//       ["active", "Active", "🎯"], ["nftsAvailable", "NFTs ready", "💎"],
//       ["claimable", "Claimable", "🥞"], ["claimed", "Claimed", "🤑"],
//     ]) {
//       menu.getMenuItemById(`stats-${key}`).label = `${icon} ${Number(stats[key] || 0).toLocaleString()} ${label}`;
//     }
//     const cards = missionCards(status);
//     for (const card of cards) {
//       const item = menu.getMenuItemById(`mission-${card.slot}`);
//       item.label = card.name;
//       const detail = card.locked ? "" : `Level ${card.missionLevel ?? "—"} · ${card.progressText} · ${Math.round(card.percent)}%`;
//       item.sublabel = detail;
//       item.toolTip = card.locked ? "Locked" : `${card.name}\n${detail}`;
//       item.enabled = !card.locked;
//       item.icon = artwork.get(card.imageSrc)?.image || nativeImage.createEmpty();
//     }
//     loadArtwork(cards);
//   }
//
//   function sync(enabled) {
//     if (platform !== "darwin") return;
//     if (enabled === true) {
//       if (tray) return;
//       const icon = nativeImage.createFromPath(path.join(__dirname, "icons", "menuBarTemplate.png"));
//       icon.setTemplateImage(true);
//       tray = new Tray(icon);
//       menu = Menu.buildFromTemplate([
//         { id: "runner-status", label: "Stopped", enabled: false },
//         { id: "runner-action", label: "Start", click: () => { void toggleRunner(); } },
//         { type: "separator" },
//         ...["active", "nftsAvailable", "claimable", "claimed"].map((key) => ({ id: `stats-${key}`, label: "…", enabled: false })),
//         { type: "separator" },
//         ...[1, 2, 3, 4].map((slot) => ({ id: `mission-${slot}`, label: "No mission" })),
//         { type: "separator" },
//         { label: "Open Missions", click: openWindow },
//         { label: "Quit Missions", click: quit },
//       ]);
//       updateStatus(status);
//       // Let AppKit track the menu and highlight its status item for its entire lifetime.
//       tray.setContextMenu(menu);
//     } else if (tray) {
//       openWindow();
//       tray.destroy();
//       tray = null;
//       menu = null;
//       artwork.clear();
//     }
//   }
//
//   function closeWindow(event) {
//     if (!tray || isQuitting()) return false;
//     event.preventDefault();
//     getWindow().hide();
//     app.dock.hide();
//     return true;
//   }
//
//   return { sync, closeWindow, openWindow, updateStatus, isEnabled: () => tray !== null };
// }
//
// module.exports = { createMacMenuBar };
