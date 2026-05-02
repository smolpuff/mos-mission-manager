"use strict";

const { contextBridge, ipcRenderer } = require("electron");

function isDesktopDevMode() {
  if (process.env.PBP_DESKTOP_DEV_MODE === "1") return true;
  const lifecycle = String(process.env.npm_lifecycle_event || "").trim();
  return lifecycle === "desktop:dev";
}

contextBridge.exposeInMainWorld("missionsDesktop", {
  platform: process.platform,
  desktopDevMode: isDesktopDevMode(),
  startBackend: () => ipcRenderer.invoke("backend:start"),
  stopBackend: () => ipcRenderer.invoke("backend:stop"),
  restartBackend: () => ipcRenderer.invoke("backend:restart"),
  sendCommand: (command) => ipcRenderer.invoke("backend:send-command", command),
  getState: () => ipcRenderer.invoke("backend:get-state"),
  getConfig: () => ipcRenderer.invoke("config:get"),
  updateConfig: (patch) => ipcRenderer.invoke("config:update", patch),
  refreshWalletSummary: () => ipcRenderer.invoke("wallet:refresh-summary"),
  bootstrapWalletSummary: () => ipcRenderer.invoke("wallet:bootstrap-summary"),
  revealSignerBackup: () => ipcRenderer.invoke("signer:reveal-backup"),
  prepareSlot4Unlock: () => ipcRenderer.invoke("slot:prepare-unlock4"),
  createGeneratedWallet: () => ipcRenderer.invoke("signer:create-generated-wallet"),
  fetchOnboardingAccount: () => ipcRenderer.invoke("onboarding:fetch-account"),
  applyMissionSelection: (payload) =>
    ipcRenderer.invoke("missions:apply-selection", payload),
  getRentalsPreview: () => ipcRenderer.invoke("rentals:preview"),
  getUserNfts: () => ipcRenderer.invoke("nfts:list"),
  prepareNftCooldownReset: (payload) =>
    ipcRenderer.invoke("nfts:prepare-cooldown-reset", payload),
  resetNftCooldown: (payload) =>
    ipcRenderer.invoke("nfts:reset-cooldown", payload),
  applyOnboardingSelection: (payload) =>
    ipcRenderer.invoke("onboarding:apply-selection", payload),
  copyToClipboard: (text) => ipcRenderer.invoke("clipboard:copy", text),
  openExternal: (url) => ipcRenderer.invoke("external:open", url),
  openCliWindow: () => ipcRenderer.invoke("window:open-cli"),
  isCliWindowOpen: () => ipcRenderer.invoke("window:is-cli-open"),
  getWindowPosition: () => ipcRenderer.invoke("window:get-position"),
  setWindowPosition: (x, y) => ipcRenderer.invoke("window:set-position", { x, y }),
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
  onBackendStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("backend:status", listener);
    return () => ipcRenderer.removeListener("backend:status", listener);
  },
  onBackendOutput: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("backend:output", listener);
    return () => ipcRenderer.removeListener("backend:output", listener);
  },
  onBackendEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("backend:event", listener);
    return () => ipcRenderer.removeListener("backend:event", listener);
  },
  getLatestCompetition: (opts) =>
    ipcRenderer.invoke("pbp:get-latest-competition", opts || {}),
});
