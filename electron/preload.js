"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("missionsDesktop", {
  startBackend: () => ipcRenderer.invoke("backend:start"),
  stopBackend: () => ipcRenderer.invoke("backend:stop"),
  sendCommand: (command) => ipcRenderer.invoke("backend:send-command", command),
  getState: () => ipcRenderer.invoke("backend:get-state"),
  openCliWindow: () => ipcRenderer.invoke("window:open-cli"),
  isCliWindowOpen: () => ipcRenderer.invoke("window:is-cli-open"),
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
});
