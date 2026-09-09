const { clipboard, contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pixelOffice", {
  getState: () => ipcRenderer.invoke("app:get-state"),
  chooseDirectory: () => ipcRenderer.invoke("project:choose-directory"),
  openProjectDirectory: (projectPath) => ipcRenderer.invoke("project:open-directory", projectPath),
  createEmployee: (payload) => ipcRenderer.invoke("employee:create", payload),
  updateEmployee: (payload) => ipcRenderer.invoke("employee:update", payload),
  removeEmployee: (employeeId) => ipcRenderer.invoke("employee:remove", employeeId),
  startSession: (employeeId) => ipcRenderer.invoke("session:start", employeeId),
  stopSession: (employeeId) => ipcRenderer.invoke("session:stop", employeeId),
  sendInput: (payload) => ipcRenderer.invoke("session:send-input", payload),
  sendRawInput: (payload) => ipcRenderer.invoke("session:send-raw-input", payload),
  sendEscape: (employeeId) => ipcRenderer.invoke("session:send-escape", employeeId),
  clearResultFeed: (employeeId) => ipcRenderer.invoke("session:clear-result-feed", employeeId),
  getTerminalHistory: (employeeId) => ipcRenderer.invoke("session:get-terminal-history", employeeId),
  resizeSession: (payload) => ipcRenderer.invoke("session:resize", payload),
  refreshSessionMetrics: (employeeId) => ipcRenderer.invoke("session:refresh-metrics", employeeId),
  readClipboardText: () => clipboard.readText(),
  readClipboardPayload: () => ipcRenderer.invoke("clipboard:read-payload"),
  writeClipboardText: (text) => clipboard.writeText(String(text ?? "")),
  onStateUpdated: (handler) => {
    const listener = (_event, snapshot) => handler(snapshot);
    ipcRenderer.on("state:updated", listener);
    return () => ipcRenderer.removeListener("state:updated", listener);
  },
  onTerminalData: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("session:terminal-data", listener);
    return () => ipcRenderer.removeListener("session:terminal-data", listener);
  }
});
