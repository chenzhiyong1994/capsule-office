// Run with Electron. Use an isolated data directory and a hidden window so this
// check never opens a user's projects or launches a configured AI agent.
const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-office-smoke-"));
app.setPath("userData", temporary);
let terminal;
const timeout = setTimeout(() => finish(new Error("Desktop smoke check timed out")), 20000);

function finish(error) {
  clearTimeout(timeout);
  try { terminal?.kill(); } catch {}
  if (error) console.error(error);
  app.exit(error ? 1 : 0);
}

app.whenReady().then(async () => {
  const pty = require("node-pty");
  const marker = "capsule-office-pty-ok";
  const output = await new Promise((resolve, reject) => {
    let buffer = "";
    terminal = pty.spawn(
      process.platform === "win32" ? (process.env.COMSPEC || "cmd.exe") : "/bin/sh",
      process.platform === "win32" ? ["/d", "/c", `echo ${marker}`] : ["-c", `printf ${marker}`],
      { name: "xterm-256color", cols: 80, rows: 24, cwd: temporary, env: process.env }
    );
    terminal.onData(data => { buffer += data; });
    terminal.onExit(({ exitCode }) => {
      terminal = null;
      if (exitCode !== 0) reject(new Error(`PTY exited with ${exitCode}`));
      else resolve(buffer);
    });
  });
  assert.ok(output.includes(marker), "Native PTY must return the command output");

  ipcMain.handle("app:get-state", () => ({
    config: { maxEmployees: 5, agentDefinitions: [], permissionModes: [] },
    employees: [],
    sessions: {}
  }));
  const window = new BrowserWindow({
    show: false,
    width: 1600,
    height: 980,
    webPreferences: {
      preload: path.join(root, "electron", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  let preloadError;
  window.webContents.on("preload-error", (_event, _path, error) => { preloadError = error; });
  await window.loadFile(path.join(root, "dist", "index.html"));
  const result = await window.webContents.executeJavaScript(`
    (async () => {
      const state = await window.pixelOffice.getState();
      for (let attempt = 0; attempt < 50; attempt++) {
        if (document.querySelector('.new-operator-button')) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return {
        employees: state.employees.length,
        title: document.title,
        createButton: document.querySelector('.new-operator-button')?.textContent,
        nodeExposed: typeof require !== 'undefined'
      };
    })()
  `);
  assert.ifError(preloadError);
  assert.equal(result.employees, 0);
  assert.ok(result.title.includes("Capsule Office"));
  assert.ok(result.createButton?.includes("新增员工"));
  assert.equal(result.nodeExposed, false);
  console.log(`Electron ${process.versions.electron}: native PTY, renderer, preload IPC and context isolation passed.`);
  window.destroy();
  finish();
}).catch(finish);
