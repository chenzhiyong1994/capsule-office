const { app, BrowserWindow, clipboard, dialog, ipcMain, shell } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

let pty;
try {
  pty = require("node-pty");
} catch (error) {
  pty = null;
}

const MAX_EMPLOYEES = 5;
const TERMINAL_CHAR_LIMIT = 140000;
const ACTIVITY_LIMIT = 40;
const RESULT_FEED_LIMIT = 80;
const EMPLOYEE_ACCENTS = ["mint", "amber", "blue", "rose", "violet"];
const DEFAULT_PERMISSION_MODE = "high-risk-auto";
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200000;
const PIXEL_OFFICE_STATUSLINE_PREFIX = "powershell -NoProfile -ExecutionPolicy Bypass -File";
const RESULT_FLUSH_DEBOUNCE_MS = 1100;
const STOP_FALLBACK_MS = 2500;
const AGENT_WAITING_DEBOUNCE_MS = 10000;
const EMPLOYEE_NAME_LIMIT = 15;
const SCENE_TAG_LIMIT = 15;

const PERMISSION_MODE_DEFINITIONS = {
  standard: {
    id: "standard",
    label: "标准确认",
    description: "保留 CLI 默认确认流程。"
  },
  "high-risk-auto": {
    id: "high-risk-auto",
    label: "高风险自动确认",
    description: "默认启用高风险自动执行，并自动放行常见确认提示。"
  }
};

const AGENT_DEFINITIONS = {
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    command: "claude",
    color: "#48f2ad",
    permissionArgs: {
      standard: [],
      "high-risk-auto": ["--dangerously-skip-permissions"]
    }
  },
  "codex-cli": {
    id: "codex-cli",
    label: "Codex CLI",
    command: "codex",
    color: "#ffb454",
    permissionArgs: {
      standard: [],
      "high-risk-auto": ["--dangerously-bypass-approvals-and-sandbox"]
    }
  }
};

const AUTO_CONFIRM_RULES = [
  {
    id: "claude-trust-folder",
    matcher: (text) => text.includes("quick safety check") && text.includes("yes, i trust this folder"),
    response: "\r",
    message: "已自动确认 Claude Code 的工作区信任提示。"
  },
  {
    id: "generic-enter-confirm",
    matcher: (text) =>
      text.includes("enter to confirm") &&
      (text.includes("1. yes") ||
        text.includes("yes, i trust") ||
        text.includes("continue") ||
        text.includes("allow")),
    response: "\r",
    message: "已自动确认当前风险提示。"
  },
  {
    id: "generic-yes-no",
    matcher: (text) =>
      (text.includes("[y/n]") ||
        text.includes("[y/n") ||
        text.includes("yes/no") ||
        text.includes("type yes to continue")) &&
      (text.includes("confirm") || text.includes("proceed") || text.includes("continue") || text.includes("allow")),
    response: "y\r",
    message: "已自动回复 yes 放行当前确认。"
  }
];

const ACTIVITY_SKIP_PATTERNS = [
  /^tip:/i,
  /^model:/i,
  /^directory:/i,
  /^permissions:/i,
  /^security guide$/i,
  /^enter to confirm/i,
  /^1\.\s*yes/i,
  /^2\.\s*no/i,
  /^>_\s*openai codex/i,
  /^gpt-\d/i,
  /^accessing workspace/i,
  /^quick safety check/i
];

let mainWindow = null;
let storeFile = null;
let claudeStatuslineScriptPath = null;
let claudeStatusPoller = null;
let appShuttingDown = false;
let state = {
  employees: [],
  sessions: {}
};
const runtimes = new Map();

function getDayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizePricing(pricing) {
  return {
    inputPricePer1M: Number(pricing?.inputPricePer1M) || 0,
    outputPricePer1M: Number(pricing?.outputPricePer1M) || 0,
    cacheReadPricePer1M: Number(pricing?.cacheReadPricePer1M) || 0,
    cacheWritePricePer1M: Number(pricing?.cacheWritePricePer1M) || 0
  };
}

function normalizeProjectKey(projectPath) {
  return path.resolve(String(projectPath || "")).replace(/\\/g, "/").toLowerCase();
}

function getClaudeStatuslineDir() {
  return path.join(app.getPath("userData"), "claude-statusline");
}

function getClaudeStatuslineSnapshotPath(projectPath) {
  const hash = crypto.createHash("sha1").update(normalizeProjectKey(projectPath)).digest("hex");
  return path.join(getClaudeStatuslineDir(), `${hash}.json`);
}

function getClaudeStatuslineCommand() {
  const safeScriptPath = claudeStatuslineScriptPath.replace(/\\/g, "/");
  return `${PIXEL_OFFICE_STATUSLINE_PREFIX} "${safeScriptPath}"`;
}

function readJsonFileSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return null;
  }
}

function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function ensureClaudeStatuslineAssets() {
  const sourcePath = path.join(__dirname, "claude-statusline.ps1");
  const targetDir = getClaudeStatuslineDir();
  const targetPath = path.join(targetDir, "statusline.ps1");
  fs.mkdirSync(targetDir, { recursive: true });
  const source = fs.readFileSync(sourcePath, "utf8");

  if (!fs.existsSync(targetPath) || fs.readFileSync(targetPath, "utf8") !== source) {
    fs.writeFileSync(targetPath, source, "utf8");
  }

  claudeStatuslineScriptPath = targetPath;
}

function ensureClaudeProjectStatusline(projectPath) {
  ensureClaudeStatuslineAssets();

  const claudeDir = path.join(projectPath, ".claude");
  const settingsFile = path.join(claudeDir, "settings.local.json");
  fs.mkdirSync(claudeDir, { recursive: true });

  const settings = readJsonFileSafe(settingsFile) ?? {};
  const existingStatusLine = settings.statusLine ?? null;

  if (existingStatusLine && typeof existingStatusLine.command === "string") {
    const isManaged = existingStatusLine.command.includes("pixel-office/claude-statusline/statusline.ps1");
    if (!isManaged) {
      return false;
    }
  }

  settings.statusLine = {
    type: "command",
    command: getClaudeStatuslineCommand(),
    padding: 0
  };

  writeJsonFile(settingsFile, settings);
  return true;
}

function isDevMode() {
  return process.env.PIXEL_OFFICE_MODE !== "production" && process.argv.includes("--dev");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: "胶囊办公室 / Capsule Office",
    width: 1600,
    height: 980,
    minWidth: 1320,
    minHeight: 820,
    backgroundColor: "#120d07",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (isDevMode()) {
    mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(path.join(app.getAppPath(), "dist", "index.html"));
  }
}

function ensureStoreReady() {
  const userDataPath = app.getPath("userData");
  storeFile = path.join(userDataPath, "pixel-office-state.json");

  if (!fs.existsSync(storeFile)) {
    fs.writeFileSync(storeFile, JSON.stringify(state, null, 2), "utf8");
    return;
  }

  try {
    const loaded = JSON.parse(fs.readFileSync(storeFile, "utf8"));
    const employees = Array.isArray(loaded.employees) ? loaded.employees.map(normalizeEmployee) : [];
    const sessions = typeof loaded.sessions === "object" && loaded.sessions ? loaded.sessions : {};

    state = {
      employees,
      sessions: {}
    };

    let normalizedSessionState = false;
    for (const employee of employees) {
      const loadedSession = sessions[employee.id] ?? null;
      const session = ensureSession(employee.id, loadedSession);

      if (session.status === "running" || session.status === "starting" || session.status === "stopping") {
        session.status = "stopped";
        session.lastSummary = "应用重启后会话已停止。";
        session.errorMessage = "";
        normalizedSessionState = true;
      }

      employee.status = session.status;
    }

    if (normalizedSessionState) {
      persistState();
    }
  } catch (error) {
    fs.writeFileSync(storeFile, JSON.stringify(state, null, 2), "utf8");
  }
}

function persistState() {
  if (!storeFile) {
    return;
  }

  const serializableSessions = {};
  for (const [employeeId, session] of Object.entries(state.sessions)) {
    serializableSessions[employeeId] = serializeSessionForStore(session);
  }

  fs.writeFileSync(
    storeFile,
    JSON.stringify(
      {
        employees: state.employees,
        sessions: serializableSessions
      },
      null,
      2
    ),
    "utf8"
  );
}

function emitState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("state:updated", getSnapshot());
  }
}

function emitTerminalData(employeeId, chunk) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("session:terminal-data", {
      employeeId,
      chunk
    });
  }
}

function getSnapshot() {
  const sessions = {};
  const employees = state.employees.map((employee) => ensureEmployeeRuntimeDay(employee));

  for (const employee of employees) {
    maybeApplyClaudeStatuslineSnapshot(employee.id);
  }

  for (const [employeeId, session] of Object.entries(state.sessions)) {
    sessions[employeeId] = serializeSessionForRenderer(session);
  }

  return {
    config: {
      maxEmployees: MAX_EMPLOYEES,
      agentDefinitions: Object.values(AGENT_DEFINITIONS).map(({ permissionArgs, ...agent }) => agent),
      permissionModes: Object.values(PERMISSION_MODE_DEFINITIONS)
    },
    employees,
    sessions
  };
}

function normalizeEmployee(employee) {
  const normalized = {
    id: employee.id,
    name: sanitizeName(employee.name) || "员工",
    sceneTag: deriveSceneTag(employee),
    agentType: AGENT_DEFINITIONS[employee.agentType] ? employee.agentType : "codex-cli",
    projectPath: employee.projectPath ?? "",
    accent: employee.accent || EMPLOYEE_ACCENTS[0],
    permissionMode: PERMISSION_MODE_DEFINITIONS[employee.permissionMode] ? employee.permissionMode : DEFAULT_PERMISSION_MODE,
    status: employee.status || "idle",
    createdAt: employee.createdAt || new Date().toISOString(),
    lastActiveAt: employee.lastActiveAt ?? null,
    pricing: normalizePricing(employee.pricing),
    runtimeTodayMs: Number(employee.runtimeTodayMs) || 0,
    runtimeTotalMs: Number(employee.runtimeTotalMs) || 0,
    runtimeDayKey: employee.runtimeDayKey || getDayKey(),
    wageTodayUsd: Number(employee.wageTodayUsd) || 0,
    wageTotalUsd: Number(employee.wageTotalUsd) || 0,
    wageDayKey: employee.wageDayKey || getDayKey(),
    wageSource: employee.wageSource || "estimated"
  };

  ensureEmployeeRuntimeDay(normalized);
  ensureEmployeeWageDay(normalized);
  return normalized;
}

function ensureEmployeeRuntimeDay(employee) {
  const todayKey = getDayKey();
  if (employee.runtimeDayKey !== todayKey) {
    employee.runtimeDayKey = todayKey;
    employee.runtimeTodayMs = 0;
  }

  return employee;
}

function ensureEmployeeWageDay(employee) {
  const todayKey = getDayKey();
  if (employee.wageDayKey !== todayKey) {
    employee.wageDayKey = todayKey;
    employee.wageTodayUsd = 0;
  }

  return employee;
}

function getEmployee(employeeId) {
  const employee = state.employees.find((item) => item.id === employeeId);
  if (employee) {
    ensureEmployeeRuntimeDay(employee);
    ensureEmployeeWageDay(employee);
  }

  return employee;
}

function createDefaultSession() {
  return {
    status: "idle",
    activityState: "waiting",
    activityStateUpdatedAt: null,
    startedAt: null,
    lastOutputAt: null,
    lastSummary: "",
    errorMessage: "",
    cliPath: null,
    exitCode: null,
    cliDetected: false,
    activityFeed: [],
    resultFeed: [],
    terminalHistory: [],
    inputCharCount: 0,
    outputCharCount: 0,
    visibleOutputCharCount: 0,
    estimatedTokenCount: 0,
    lastSubmittedAt: null,
    outputStylePrimed: false,
    metrics: {
      contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
      contextUsagePercent: null,
      contextUsageSource: "none",
      tokenCount: null,
      tokenCountSource: "none",
      tokenUsageSource: "none",
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costBaselineInputTokens: null,
      costBaselineOutputTokens: null,
      costBaselineCacheReadTokens: null,
      costBaselineCacheWriteTokens: null,
      durationSec: null,
      durationSource: "none",
      lastUpdatedAt: null
    },
    _activityCarry: "",
    _resultBuffer: [],
    _claudeStatusVersion: null
  };
}

function normalizeTokenMetric(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const tokenCount = Number(value);
  return Number.isFinite(tokenCount) ? Math.max(0, Math.round(tokenCount)) : null;
}

function cloneMetrics(metrics) {
  return {
    contextWindowTokens: metrics?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
    contextUsagePercent: metrics?.contextUsagePercent ?? null,
    contextUsageSource: metrics?.contextUsageSource ?? "none",
    tokenCount: metrics?.tokenCount ?? null,
    tokenCountSource: metrics?.tokenCountSource ?? "none",
    tokenUsageSource: metrics?.tokenUsageSource ?? "none",
    inputTokens: normalizeTokenMetric(metrics?.inputTokens),
    outputTokens: normalizeTokenMetric(metrics?.outputTokens),
    cacheReadTokens: normalizeTokenMetric(metrics?.cacheReadTokens),
    cacheWriteTokens: normalizeTokenMetric(metrics?.cacheWriteTokens),
    costBaselineInputTokens: normalizeTokenMetric(metrics?.costBaselineInputTokens),
    costBaselineOutputTokens: normalizeTokenMetric(metrics?.costBaselineOutputTokens),
    costBaselineCacheReadTokens: normalizeTokenMetric(metrics?.costBaselineCacheReadTokens),
    costBaselineCacheWriteTokens: normalizeTokenMetric(metrics?.costBaselineCacheWriteTokens),
    durationSec: metrics?.durationSec ?? null,
    durationSource: metrics?.durationSource ?? "none",
    lastUpdatedAt: metrics?.lastUpdatedAt ?? null
  };
}

function trimResultFeed(feed) {
  const events = Array.isArray(feed) ? feed.slice() : [];
  return events.slice(-RESULT_FEED_LIMIT);
}

function createResultEvent(type, text, extras = {}) {
  return {
    id: `evt-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    type,
    text: String(text || "").trim(),
    createdAt: new Date().toISOString(),
    ...extras
  };
}

function pushResultEvent(session, type, text, extras = {}) {
  const message = String(text || "").trim();
  if (!message) {
    return null;
  }

  const event = createResultEvent(type, message, extras);
  session.resultFeed = trimResultFeed([...(session.resultFeed ?? []), event]);
  return event;
}

function estimateTokensFromChars(charCount) {
  return Math.max(0, Math.round(Number(charCount || 0) / 4));
}

function getRealUsageFromMetrics(metrics) {
  const inputTokens = normalizeTokenMetric(metrics?.inputTokens);
  const outputTokens = normalizeTokenMetric(metrics?.outputTokens);
  const cacheReadTokens = normalizeTokenMetric(metrics?.cacheReadTokens);
  const cacheWriteTokens = normalizeTokenMetric(metrics?.cacheWriteTokens);

  if (inputTokens === null && outputTokens === null && cacheReadTokens === null && cacheWriteTokens === null) {
    return null;
  }

  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheWriteTokens: cacheWriteTokens ?? 0
  };
}

function getSessionUsageBaseline(metrics) {
  return {
    inputTokens: normalizeTokenMetric(metrics?.costBaselineInputTokens) ?? 0,
    outputTokens: normalizeTokenMetric(metrics?.costBaselineOutputTokens) ?? 0,
    cacheReadTokens: normalizeTokenMetric(metrics?.costBaselineCacheReadTokens) ?? 0,
    cacheWriteTokens: normalizeTokenMetric(metrics?.costBaselineCacheWriteTokens) ?? 0
  };
}

function setSessionUsageBaseline(session, usage) {
  if (!session?.metrics || !usage) {
    return;
  }

  session.metrics.costBaselineInputTokens = usage.inputTokens ?? 0;
  session.metrics.costBaselineOutputTokens = usage.outputTokens ?? 0;
  session.metrics.costBaselineCacheReadTokens = usage.cacheReadTokens ?? 0;
  session.metrics.costBaselineCacheWriteTokens = usage.cacheWriteTokens ?? 0;
}

function computeSessionCost(employee, session) {
  const pricing = normalizePricing(employee?.pricing);
  const realUsage = getRealUsageFromMetrics(session?.metrics);
  const baseline = getSessionUsageBaseline(session?.metrics);
  const inputTokens = realUsage ? Math.max(0, realUsage.inputTokens - baseline.inputTokens) : estimateTokensFromChars(session?.inputCharCount ?? 0);
  const outputTokens = realUsage ? Math.max(0, realUsage.outputTokens - baseline.outputTokens) : estimateTokensFromChars(session?.visibleOutputCharCount ?? 0);
  const cacheReadTokens = realUsage ? Math.max(0, realUsage.cacheReadTokens - baseline.cacheReadTokens) : 0;
  const cacheWriteTokens = realUsage ? Math.max(0, realUsage.cacheWriteTokens - baseline.cacheWriteTokens) : 0;

  const totalUsd =
    (inputTokens / 1000000) * pricing.inputPricePer1M +
    (outputTokens / 1000000) * pricing.outputPricePer1M +
    (cacheReadTokens / 1000000) * pricing.cacheReadPricePer1M +
    (cacheWriteTokens / 1000000) * pricing.cacheWritePricePer1M;

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalUsd,
    source: realUsage ? "real" : "estimated"
  };
}

function updateEstimatedMetrics(session) {
  if (session.metrics.contextUsageSource === "real") {
    return;
  }

  session.estimatedTokenCount = estimateTokensFromChars(session.inputCharCount + session.visibleOutputCharCount);

  if (session.metrics.contextUsageSource !== "real") {
    const percent = session.metrics.contextWindowTokens
      ? Math.min(100, Math.round((session.estimatedTokenCount / session.metrics.contextWindowTokens) * 100))
      : null;
    session.metrics.contextUsagePercent = percent;
    session.metrics.contextUsageSource = percent === null ? "none" : "estimated";
  }

  if (session.metrics.tokenCountSource !== "real") {
    session.metrics.tokenCount = session.estimatedTokenCount || null;
    session.metrics.tokenCountSource = session.estimatedTokenCount > 0 ? "estimated" : "none";
  }
}

function maybeApplyClaudeStatuslineSnapshot(employeeId, options = {}) {
  const employee = getEmployee(employeeId);
  const session = ensureSession(employeeId);
  if (!employee || employee.agentType !== "claude-code") {
    return false;
  }

  const snapshotFile = getClaudeStatuslineSnapshotPath(employee.projectPath);
  if (!fs.existsSync(snapshotFile)) {
    return false;
  }

  const snapshot = readJsonFileSafe(snapshotFile);
  if (!snapshot?.context) {
    return false;
  }

  const version = snapshot.capturedAt ?? null;
  if (!version || (!options.force && session._claudeStatusVersion === version)) {
    return false;
  }

  const totalTokens =
    Number(snapshot.context.totalInputTokens || 0) +
    Number(snapshot.context.totalOutputTokens || 0) +
    Number(snapshot.context.totalCacheCreationInputTokens || 0) +
    Number(snapshot.context.totalCacheReadInputTokens || 0);

  session._claudeStatusVersion = version;
  session.metrics.contextWindowTokens = Number(snapshot.context.contextWindowSize) || session.metrics.contextWindowTokens;
  session.metrics.contextUsagePercent = Number(snapshot.context.usedPercentage) || 0;
  session.metrics.contextUsageSource = "real";
  session.metrics.tokenCount = totalTokens || session.metrics.tokenCount;
  session.metrics.tokenCountSource = totalTokens > 0 ? "real" : session.metrics.tokenCountSource;
  session.metrics.tokenUsageSource = totalTokens > 0 ? "real" : session.metrics.tokenUsageSource;
  session.metrics.inputTokens = Number(snapshot.context.totalInputTokens || 0);
  session.metrics.outputTokens = Number(snapshot.context.totalOutputTokens || 0);
  session.metrics.cacheWriteTokens = Number(snapshot.context.totalCacheCreationInputTokens || 0);
  session.metrics.cacheReadTokens = Number(snapshot.context.totalCacheReadInputTokens || 0);
  session.metrics.lastUpdatedAt = version;
  return true;
}

function startClaudeStatusPoller() {
  if (claudeStatusPoller) {
    return;
  }

  claudeStatusPoller = setInterval(() => {
    let changed = false;
    for (const employee of state.employees) {
      changed = maybeApplyClaudeStatuslineSnapshot(employee.id) || changed;
    }

    if (changed) {
      persistState();
      emitState();
    }
  }, 1500);
}

function markMetricsUpdated(session) {
  session.metrics.lastUpdatedAt = new Date().toISOString();
}

function parseRealMetricsFromChunk(rawChunk) {
  const plain = flattenTerminalText(rawChunk).replace(/\s+/g, " ").trim();
  if (!plain) {
    return null;
  }

  const metrics = {};
  const remainingMatch =
    plain.match(/(?:remaining|left|available|balance|余额|剩余)(?: context)?[^0-9]{0,16}(\d{1,3})%/i) ||
    plain.match(/context(?: window)?\s*(?:remaining|left|available|balance|余额|剩余)[^0-9]{0,16}(\d{1,3})%/i) ||
    plain.match(/(\d{1,3})%\s*(?:remaining|left|available|balance|余额|剩余)(?: context)?/i);

  if (remainingMatch) {
    metrics.contextUsagePercent = Math.max(0, Math.min(100, 100 - Number(remainingMatch[1])));
  }

  const contextMatch =
    metrics.contextUsagePercent === undefined
      ? plain.match(/context(?: window)?(?: usage| used| consumed|消耗|已用)[^0-9]{0,12}(\d{1,3})%/i) ||
        plain.match(/(\d{1,3})%\s*context(?: used| usage| consumed|消耗|已用)?/i)
      : null;

  if (contextMatch) {
    metrics.contextUsagePercent = Math.max(0, Math.min(100, Number(contextMatch[1])));
  }

  const contextWindowMatch =
    plain.match(/context window[^0-9]{0,16}([\d,]{4,})/i) ||
    plain.match(/window size[^0-9]{0,16}([\d,]{4,})/i);
  if (contextWindowMatch) {
    metrics.contextWindowTokens = Number(String(contextWindowMatch[1]).replace(/,/g, "")) || undefined;
  }

  const durationTokenMatch = [...plain.matchAll(/(\d+(?:\.\d+)?)s[^0-9]{0,12}(?:[↓↑]\s*)?(\d{1,7})\s*tokens?\b/gi)].pop();
  if (durationTokenMatch) {
    metrics.durationSec = Number(durationTokenMatch[1]);
    metrics.tokenCount = Number(durationTokenMatch[2]);
  } else {
    const tokenMatch = [...plain.matchAll(/(?:[↓↑]\s*)?(\d{1,7})\s*tokens?\b/gi)].pop();
    if (tokenMatch) {
      metrics.tokenCount = Number(tokenMatch[1]);
    }

    const durationMatch = [...plain.matchAll(/(\d+(?:\.\d+)?)s\b/gi)].pop();
    if (durationMatch) {
      metrics.durationSec = Number(durationMatch[1]);
    }
  }

  return Object.keys(metrics).length > 0 ? metrics : null;
}

function applyRealMetrics(session, parsedMetrics) {
  if (!parsedMetrics) {
    return;
  }

  if (parsedMetrics.contextWindowTokens !== undefined) {
    session.metrics.contextWindowTokens = parsedMetrics.contextWindowTokens;
  }

  if (parsedMetrics.contextUsagePercent !== undefined) {
    session.metrics.contextUsagePercent = parsedMetrics.contextUsagePercent;
    session.metrics.contextUsageSource = "real";
  }

  if (parsedMetrics.tokenCount !== undefined) {
    session.metrics.tokenCount = parsedMetrics.tokenCount;
    session.metrics.tokenCountSource = "real";
  }

  if (parsedMetrics.durationSec !== undefined) {
    session.metrics.durationSec = parsedMetrics.durationSec;
    session.metrics.durationSource = "real";
  }

  markMetricsUpdated(session);
}

function ensureSession(employeeId, existing) {
  if (!state.sessions[employeeId]) {
    const seed = existing ?? {};
    const session = createDefaultSession();
    session.status = seed.status || session.status;
    session.activityState = seed.activityState === "working" ? "working" : "waiting";
    session.activityStateUpdatedAt = seed.activityStateUpdatedAt ?? null;
    session.startedAt = seed.startedAt ?? session.startedAt;
    session.lastOutputAt = seed.lastOutputAt ?? session.lastOutputAt;
    session.lastSummary = seed.lastSummary ?? session.lastSummary;
    session.errorMessage = seed.errorMessage ?? session.errorMessage;
    session.cliPath = seed.cliPath ?? session.cliPath;
    session.exitCode = seed.exitCode ?? session.exitCode;
    session.cliDetected = seed.cliDetected ?? session.cliDetected;
    session.activityFeed = Array.isArray(seed.activityFeed) ? seed.activityFeed.slice(-ACTIVITY_LIMIT) : [];
    session.resultFeed = trimResultFeed(Array.isArray(seed.resultFeed) ? seed.resultFeed : []);
    session.terminalHistory = trimTerminalHistory(Array.isArray(seed.terminalHistory) ? seed.terminalHistory : []);
    session.inputCharCount = Number(seed.inputCharCount) || 0;
    session.outputCharCount = Number(seed.outputCharCount) || 0;
    session.visibleOutputCharCount = Number(seed.visibleOutputCharCount) || 0;
    session.estimatedTokenCount = Number(seed.estimatedTokenCount) || 0;
    session.lastSubmittedAt = seed.lastSubmittedAt ?? null;
    session.outputStylePrimed = seed.outputStylePrimed ?? false;
    session._claudeStatusVersion = seed._claudeStatusVersion ?? null;
    session.metrics = cloneMetrics(seed.metrics);
    updateEstimatedMetrics(session);
    state.sessions[employeeId] = session;
  }

  return state.sessions[employeeId];
}

function serializeSessionForStore(session) {
  return {
    status: session.status,
    activityState: session.activityState === "working" ? "working" : "waiting",
    activityStateUpdatedAt: session.activityStateUpdatedAt ?? null,
    startedAt: session.startedAt ?? null,
    lastOutputAt: session.lastOutputAt ?? null,
    lastSummary: session.lastSummary ?? "",
    errorMessage: session.errorMessage ?? "",
    cliPath: session.cliPath ?? null,
    exitCode: session.exitCode ?? null,
    cliDetected: session.cliDetected ?? false,
    activityFeed: Array.isArray(session.activityFeed) ? session.activityFeed.slice(-ACTIVITY_LIMIT) : [],
    resultFeed: trimResultFeed(Array.isArray(session.resultFeed) ? session.resultFeed : []),
    terminalHistory: trimTerminalHistory(Array.isArray(session.terminalHistory) ? session.terminalHistory : []),
    inputCharCount: session.inputCharCount ?? 0,
    outputCharCount: session.outputCharCount ?? 0,
    visibleOutputCharCount: session.visibleOutputCharCount ?? 0,
    estimatedTokenCount: session.estimatedTokenCount ?? 0,
    lastSubmittedAt: session.lastSubmittedAt ?? null,
    outputStylePrimed: session.outputStylePrimed ?? false,
    metrics: cloneMetrics(session.metrics)
  };
}

function serializeSessionForRenderer(session) {
  return {
    status: session.status,
    activityState: session.activityState === "working" ? "working" : "waiting",
    activityStateUpdatedAt: session.activityStateUpdatedAt ?? null,
    startedAt: session.startedAt ?? null,
    lastOutputAt: session.lastOutputAt ?? null,
    lastSummary: session.lastSummary ?? "",
    errorMessage: session.errorMessage ?? "",
    cliPath: session.cliPath ?? null,
    exitCode: session.exitCode ?? null,
    cliDetected: session.cliDetected ?? false,
    resultFeed: trimResultFeed(Array.isArray(session.resultFeed) ? session.resultFeed : []),
    inputCharCount: session.inputCharCount ?? 0,
    outputCharCount: session.outputCharCount ?? 0,
    visibleOutputCharCount: session.visibleOutputCharCount ?? 0,
    estimatedTokenCount: session.estimatedTokenCount ?? 0,
    lastSubmittedAt: session.lastSubmittedAt ?? null,
    outputStylePrimed: session.outputStylePrimed ?? false,
    metrics: cloneMetrics(session.metrics)
  };
}

function trimTerminalHistory(history) {
  const chunks = Array.isArray(history) ? history.slice() : [];
  let totalChars = chunks.reduce((sum, chunk) => sum + String(chunk).length, 0);

  while (chunks.length > 1 && totalChars > TERMINAL_CHAR_LIMIT) {
    totalChars -= String(chunks.shift()).length;
  }

  return chunks;
}

function sanitizeShortText(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "");
}

function countTextChars(value) {
  return Array.from(String(value || "")).length;
}

function assertMaxChars(value, maxLength, label) {
  if (countTextChars(value) > maxLength) {
    throw new Error(`${label}不能超过 ${maxLength} 个字符。`);
  }
}

function sanitizeName(value) {
  return sanitizeShortText(value);
}

function sanitizeSceneTag(value) {
  return sanitizeShortText(value);
}

function projectNameFromPath(projectPath) {
  return String(projectPath || "")
    .trim()
    .split(/[\\/]/)
    .filter(Boolean)
    .at(-1);
}

function deriveSceneTag(employee) {
  const sceneTag = sanitizeSceneTag(employee?.sceneTag);
  if (sceneTag) {
    return sceneTag;
  }

  return sanitizeSceneTag(projectNameFromPath(employee?.projectPath)) || sanitizeName(employee?.name) || "场景";
}

function normalizePermissionMode(permissionMode) {
  return PERMISSION_MODE_DEFINITIONS[permissionMode] ? permissionMode : DEFAULT_PERMISSION_MODE;
}

function createEmployee(payload) {
  if (state.employees.length >= MAX_EMPLOYEES) {
    throw new Error("Office is full. Expansion is not available in v1.");
  }

  const agent = AGENT_DEFINITIONS[payload.agentType];
  if (!agent) {
    throw new Error("Unsupported agent type.");
  }

  if (!payload.projectPath || !fs.existsSync(payload.projectPath)) {
    throw new Error("Project folder does not exist.");
  }

  const sceneTag = sanitizeSceneTag(payload.sceneTag);
  if (!sceneTag) {
    throw new Error("场景标签必填。");
  }
  const name = sanitizeName(payload.name);
  assertMaxChars(name, EMPLOYEE_NAME_LIMIT, "员工名称");
  assertMaxChars(sceneTag, SCENE_TAG_LIMIT, "场景标签");

  const employee = {
    id: `emp-${Date.now()}-${Math.floor(Math.random() * 9999)}`,
    name: name || "员工",
    sceneTag,
    agentType: payload.agentType,
    projectPath: payload.projectPath,
    accent: payload.accent || EMPLOYEE_ACCENTS[state.employees.length % EMPLOYEE_ACCENTS.length],
    permissionMode: normalizePermissionMode(payload.permissionMode),
    status: "idle",
    createdAt: new Date().toISOString(),
    lastActiveAt: null,
    pricing: normalizePricing(payload.pricing),
    runtimeTodayMs: 0,
    runtimeTotalMs: 0,
    runtimeDayKey: getDayKey(),
    wageTodayUsd: 0,
    wageTotalUsd: 0,
    wageDayKey: getDayKey(),
    wageSource: "estimated"
  };

  state.employees.push(employee);
  ensureSession(employee.id);
  persistState();
  emitState();

  return employee;
}

function updateEmployee(payload) {
  const employee = getEmployee(payload.id);
  if (!employee) {
    throw new Error("Employee not found.");
  }

  if (payload.name !== undefined) {
    const name = sanitizeName(payload.name);
    assertMaxChars(name, EMPLOYEE_NAME_LIMIT, "员工名称");
    employee.name = name || employee.name;
  }

  if (payload.sceneTag !== undefined) {
    const sceneTag = sanitizeSceneTag(payload.sceneTag);
    if (!sceneTag) {
      throw new Error("场景标签必填。");
    }
    assertMaxChars(sceneTag, SCENE_TAG_LIMIT, "场景标签");
    employee.sceneTag = sceneTag;
  }

  if (payload.agentType !== undefined) {
    if (!AGENT_DEFINITIONS[payload.agentType]) {
      throw new Error("Unsupported agent type.");
    }
    employee.agentType = payload.agentType;
  }

  if (payload.projectPath !== undefined) {
    if (!fs.existsSync(payload.projectPath)) {
      throw new Error("Project folder does not exist.");
    }
    employee.projectPath = payload.projectPath;
  }

  if (payload.permissionMode !== undefined) {
    employee.permissionMode = normalizePermissionMode(payload.permissionMode);
  }

  if (payload.pricing !== undefined) {
    employee.pricing = normalizePricing(payload.pricing);
  }

  persistState();
  emitState();
  return employee;
}

function removeEmployee(employeeId) {
  const employee = getEmployee(employeeId);
  if (!employee) {
    throw new Error("Employee not found.");
  }

  const session = ensureSession(employeeId);
  if (runtimes.has(employeeId) || session.status === "running" || session.status === "starting") {
    throw new Error("This employee is still running. Stop the session manually before firing.");
  }

  state.employees = state.employees.filter((item) => item.id !== employeeId);
  delete state.sessions[employeeId];
  persistState();
  emitState();
}

function validateProjectPath(employee) {
  if (!employee.projectPath || !fs.existsSync(employee.projectPath)) {
    throw new Error("Project folder does not exist. Please rebind this employee.");
  }

  const stats = fs.statSync(employee.projectPath);
  if (!stats.isDirectory()) {
    throw new Error("Bound project path is not a folder. Please rebind this employee.");
  }
}

async function detectCli(command) {
  return new Promise((resolve) => {
    const child = spawn("where", [command], {
      shell: true,
      windowsHide: true
    });

    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", () => resolve({ available: false, path: null }));
    child.on("close", (code) => {
      const location = stdout
        .split(/\r?\n/)
        .map((item) => item.trim())
        .find(Boolean);

      resolve({
        available: code === 0 && Boolean(location),
        path: location || null
      });
    });
  });
}

function buildLaunchArgs(employee) {
  const agent = AGENT_DEFINITIONS[employee.agentType];
  return agent.permissionArgs[normalizePermissionMode(employee.permissionMode)] ?? [];
}

function quoteForCmd(value) {
  const text = String(value);
  if (!/[\s"]/u.test(text)) {
    return text;
  }

  return `"${text.replace(/"/g, '""')}"`;
}

function recordEmployeeRuntime(employeeId, elapsedMs) {
  const employee = getEmployee(employeeId);
  if (!employee) {
    return;
  }

  const safeElapsedMs = Math.max(0, Math.round(Number(elapsedMs) || 0));
  employee.runtimeTodayMs += safeElapsedMs;
  employee.runtimeTotalMs += safeElapsedMs;
}

function recordEmployeeWage(employeeId) {
  const employee = getEmployee(employeeId);
  const session = ensureSession(employeeId);
  if (!employee || !session) {
    return;
  }

  const cost = computeSessionCost(employee, session);
  employee.wageTodayUsd += cost.totalUsd;
  employee.wageTotalUsd += cost.totalUsd;
  employee.wageSource = cost.source;
}

function clearRuntimeTimers(runtime) {
  if (!runtime) {
    return;
  }

  if (runtime.styleTimer) {
    clearTimeout(runtime.styleTimer);
    runtime.styleTimer = null;
  }
  if (runtime.resultFlushTimer) {
    clearTimeout(runtime.resultFlushTimer);
    runtime.resultFlushTimer = null;
  }
  if (runtime.activityIdleTimer) {
    clearTimeout(runtime.activityIdleTimer);
    runtime.activityIdleTimer = null;
  }
  if (runtime.stopFallbackTimer) {
    clearTimeout(runtime.stopFallbackTimer);
    runtime.stopFallbackTimer = null;
  }
}

function finalizeStoppedRuntime(employeeId, runtime, details = {}) {
  if (!runtime) {
    return;
  }

  clearRuntimeTimers(runtime);
  if (runtime.startedAtMs) {
    recordEmployeeRuntime(employeeId, Date.now() - runtime.startedAtMs);
    runtime.startedAtMs = null;
  }

  flushAssistantResult(employeeId);
  recordEmployeeWage(employeeId);
  runtimes.delete(employeeId);

  const message = details.message || "会话已停止。";
  pushResultEvent(ensureSession(employeeId), "system_status", message);
  updateEmployeeStatus(employeeId, "stopped", {
    exitCode: details.exitCode ?? null,
    errorMessage: "",
    lastSummary: details.lastSummary || "Session stopped."
  });
}

function shutdownAllRuntimes({ quitting = false } = {}) {
  if (quitting) {
    appShuttingDown = true;
  }

  for (const [employeeId, runtime] of [...runtimes.entries()]) {
    runtime.stopping = true;
    killRuntimeProcessTree(runtime);
    finalizeStoppedRuntime(employeeId, runtime, {
      message: "应用关闭，会话已停止。",
      lastSummary: "Application closed. Session stopped."
    });
  }
}

function resetSessionBuffers(session) {
  session.activityFeed = [];
  session.resultFeed = [];
  session.terminalHistory = [];
  session.activityState = "waiting";
  session.activityStateUpdatedAt = null;
  session.lastSummary = "";
  session.lastOutputAt = null;
  session.exitCode = null;
  session.errorMessage = "";
  session.inputCharCount = 0;
  session.outputCharCount = 0;
  session.visibleOutputCharCount = 0;
  session.estimatedTokenCount = 0;
  session.lastSubmittedAt = null;
  session.outputStylePrimed = false;
  session.metrics = cloneMetrics({
    contextWindowTokens: session.metrics?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS
  });
  session._activityCarry = "";
  session._resultBuffer = [];
  session._claudeStatusVersion = null;
}

function recordTerminalChunk(employeeId, rawChunk) {
  const session = ensureSession(employeeId);
  session.terminalHistory = trimTerminalHistory([...(session.terminalHistory ?? []), rawChunk]);
  session.lastOutputAt = new Date().toISOString();
  session.outputCharCount += String(rawChunk).length;
  emitTerminalData(employeeId, rawChunk);
}

function flushAssistantResult(employeeId) {
  const session = ensureSession(employeeId);
  const accepted = Array.isArray(session._resultBuffer) ? session._resultBuffer.slice() : [];
  session._resultBuffer = [];

  if (accepted.length === 0) {
    return false;
  }

  const runtime = runtimes.get(employeeId);
  if (runtime?.resultFlushTimer) {
    clearTimeout(runtime.resultFlushTimer);
    runtime.resultFlushTimer = null;
  }

  const lastEvent = session.resultFeed?.[session.resultFeed.length - 1] ?? null;
  if (lastEvent?.type === "assistant_result") {
    const existing = new Set(String(lastEvent.text || "").split("\n").map((line) => line.trim()).filter(Boolean));
    const nextLines = accepted.filter((line) => !existing.has(line));
    if (nextLines.length === 0) {
      return false;
    }

    lastEvent.text = `${lastEvent.text}\n${nextLines.join("\n")}`.slice(-5000);
    lastEvent.createdAt = new Date().toISOString();
  } else {
    pushResultEvent(session, "assistant_result", accepted.join("\n"));
  }

  persistState();
  emitState();
  return true;
}

function queueAssistantResult(employeeId, lines) {
  const session = ensureSession(employeeId);
  const accepted = lines
    .map(normalizeResultLine)
    .filter(
      (line) =>
        line &&
        !shouldSkipResultLine(line) &&
        !line.startsWith("[system]") &&
        !isEchoOfRecentInput(session, line)
    );

  if (accepted.length === 0) {
    return false;
  }

  const buffered = new Set((session._resultBuffer ?? []).map((line) => line.trim()).filter(Boolean));
  const nextLines = accepted.filter((line) => !buffered.has(line));
  if (nextLines.length === 0) {
    return false;
  }

  session._resultBuffer = [...(session._resultBuffer ?? []), ...nextLines].slice(-60);

  const runtime = runtimes.get(employeeId);
  if (!runtime) {
    return flushAssistantResult(employeeId);
  }

  if (runtime.resultFlushTimer) {
    clearTimeout(runtime.resultFlushTimer);
  }

  runtime.resultFlushTimer = setTimeout(() => {
    const liveRuntime = runtimes.get(employeeId);
    if (liveRuntime) {
      liveRuntime.resultFlushTimer = null;
    }
    flushAssistantResult(employeeId);
  }, RESULT_FLUSH_DEBOUNCE_MS);

  return true;
}

function normalizeResultLine(line) {
  return cleanActivityLine(line)
    .replace(/^[|│]\s*/g, "")
    .replace(/^[•·▪◦]+\s*/g, "")
    .replace(/^›\s*/g, "")
    .trim();
}

function appendActivityLines(employeeId, lines) {
  const session = ensureSession(employeeId);
  const nextLines = [];
  let nextVisibleChars = 0;

  for (const rawLine of lines) {
    const line = cleanActivityLine(rawLine);
    if (!line || shouldSkipActivityLine(line)) {
      continue;
    }

    const previousLine = session.activityFeed[session.activityFeed.length - 1];
    if (previousLine === line) {
      continue;
    }

    nextLines.push(line);
    nextVisibleChars += line.length;
  }

  if (nextLines.length === 0) {
    return [];
  }

  session.activityFeed = [...session.activityFeed, ...nextLines].slice(-ACTIVITY_LIMIT);
  session.visibleOutputCharCount += nextVisibleChars;
  session.lastSummary = session.activityFeed[session.activityFeed.length - 1] ?? session.lastSummary;
  updateEstimatedMetrics(session);
  markMetricsUpdated(session);
  return nextLines;
}

function appendSystemActivity(employeeId, message) {
  const session = ensureSession(employeeId);
  flushAssistantResult(employeeId);
  const acceptedLines = appendActivityLines(employeeId, [`[system] ${message}`]);
  const event = pushResultEvent(session, "system_status", message);
  if (acceptedLines.length > 0 || event) {
    persistState();
    emitState();
  }
}

function cleanActivityLine(line) {
  return String(line || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

function shouldSkipActivityLine(line) {
  if (!line || line.length < 2) {
    return true;
  }

  if (/^[\u2500-\u257f\u2580-\u259f|_>.\-:\s]+$/u.test(line)) {
    return true;
  }

  return ACTIVITY_SKIP_PATTERNS.some((pattern) => pattern.test(line));
}

function isFragmentedProgressLine(line) {
  const stripped = String(line || "")
    .replace(/[•·▪◦]/g, " ")
    .trim();

  if (/^[A-Za-z0-9](?:\s+[A-Za-z0-9]){1,}$/u.test(stripped)) {
    return true;
  }

  const compact = stripped.replace(/\s+/g, "");
  return compact.length <= 8 && /^[A-Za-z0-9]+$/u.test(compact) && /\s/.test(stripped);
}

function shouldSkipResultLine(line) {
  if (!line) {
    return true;
  }

  if (line.startsWith("> ") || line.startsWith("/")) {
    return true;
  }

  if (shouldSkipActivityLine(line)) {
    return true;
  }

  if (/working\s*\(.*interrupt/i.test(line)) {
    return true;
  }

  if (/using terse style for subsequent responses/i.test(line)) {
    return true;
  }

  if (/^(model|directory|permissions):/i.test(line)) {
    return true;
  }

  if (/^(openai codex|claude code)/i.test(line)) {
    return true;
  }

  if (isFragmentedProgressLine(line)) {
    return true;
  }

  return false;
}

function isEchoOfRecentInput(session, line) {
  const recentInputs = (session.resultFeed ?? [])
    .filter((event) => event.type === "user_prompt" || event.type === "command")
    .slice(-4)
    .map((event) => cleanActivityLine(event.text).toLowerCase());

  return recentInputs.includes(cleanActivityLine(line).toLowerCase());
}

function flattenTerminalText(value) {
  return String(value)
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, " ")
    .replace(/\u001bP[\s\S]*?\u001b\\/g, " ")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, " ")
    .replace(/\u001b[@-_]/g, " ")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ");
}

function isRunningLikeStatus(status) {
  return status === "starting" || status === "running";
}

function setSessionActivityState(employeeId, activityState) {
  const session = ensureSession(employeeId);
  const nextActivityState = activityState === "working" ? "working" : "waiting";
  if (session.activityState === nextActivityState) {
    return false;
  }

  session.activityState = nextActivityState;
  session.activityStateUpdatedAt = new Date().toISOString();
  return true;
}

function getTerminalTextTail(session) {
  return flattenTerminalText((session.terminalHistory ?? []).slice(-10).join(""))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .slice(-240);
}

function terminalTailLooksWaiting(session) {
  const tail = getTerminalTextTail(session).trimEnd();
  if (!tail) {
    return false;
  }

  const lastLine = tail.split(/\n+/).pop()?.trim() ?? "";
  return (
    /(?:^|\s)(?:yes|no|y\/n|y\/N|\[y\/n\]|\(y\/n\)|continue\?|proceed\?|confirm\?|press enter|do you want|are you sure)\s*$/i.test(tail) ||
    /(?:确认|继续|是否|要继续|按\s*enter|按回车|等待输入|请输入)[^。！\n]*[？?：:]?\s*$/.test(tail) ||
    /^(?:>|❯|›|»|\$)\s*$/.test(lastLine) ||
    /^PS\s+.+>\s*$/.test(lastLine) ||
    /^[A-Za-z]:\\.*>\s*$/.test(lastLine)
  );
}

function scheduleActivityIdleTransition(employeeId) {
  const runtime = runtimes.get(employeeId);
  if (!runtime) {
    return;
  }

  if (runtime.activityIdleTimer) {
    clearTimeout(runtime.activityIdleTimer);
  }

  runtime.activityIdleTimer = setTimeout(() => {
    runtime.activityIdleTimer = null;
    if (runtimes.get(employeeId) !== runtime) {
      return;
    }

    const session = ensureSession(employeeId);
    if (session.status !== "running" || session.activityState !== "working") {
      return;
    }

    setSessionActivityState(employeeId, "waiting");
    persistState();
    emitState();
  }, AGENT_WAITING_DEBOUNCE_MS);
}

function extractActivityLines(session, rawChunk) {
  const flattened = flattenTerminalText(rawChunk);
  if (!flattened.trim()) {
    return [];
  }

  const combined = `${session._activityCarry ?? ""}${flattened}`;
  const parts = combined.split(/\n+/);
  session._activityCarry = parts.pop() ?? "";
  return parts;
}

function normalizePromptText(rawChunk) {
  return flattenTerminalText(rawChunk)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function writeToRuntime(employeeId, input) {
  const runtime = runtimes.get(employeeId);
  if (!runtime) {
    return false;
  }

  if (runtime.type === "pty") {
    runtime.process.write(input);
    return true;
  }

  runtime.process.stdin.write(input.replace(/\r/g, "\n"));
  return true;
}

function killRuntimeProcessTree(runtime) {
  const pid = runtime?.process?.pid;
  let requestedTreeKill = false;
  let killRequested = false;

  if (process.platform === "win32" && pid) {
    requestedTreeKill = true;
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore"
    });
    killer.on("error", () => undefined);
    killRequested = true;
  }

  try {
    runtime.process.kill();
    killRequested = true;
  } catch (error) {
    return requestedTreeKill;
  }

  return killRequested;
}

function resizeSession(employeeId, cols, rows) {
  const runtime = runtimes.get(employeeId);
  if (!runtime || runtime.type !== "pty") {
    return false;
  }

  const safeCols = Math.max(40, Math.floor(Number(cols) || 0));
  const safeRows = Math.max(12, Math.floor(Number(rows) || 0));

  try {
    runtime.process.resize(safeCols, safeRows);
    runtime.cols = safeCols;
    runtime.rows = safeRows;
    return true;
  } catch (error) {
    return false;
  }
}

function maybeAutoConfirm(employeeId, rawChunk) {
  const employee = getEmployee(employeeId);
  const runtime = runtimes.get(employeeId);
  if (!employee || !runtime || employee.permissionMode !== "high-risk-auto") {
    return false;
  }

  const promptText = normalizePromptText(rawChunk);
  if (!promptText) {
    return false;
  }

  for (const rule of AUTO_CONFIRM_RULES) {
    if (!rule.matcher(promptText)) {
      continue;
    }

    const signature = `${rule.id}:${promptText.slice(0, 240)}`;
    const now = Date.now();
    if (runtime.lastAutoConfirm?.signature === signature && now - runtime.lastAutoConfirm.at < 3000) {
      return false;
    }

    runtime.lastAutoConfirm = {
      signature,
      at: now
    };

    writeToRuntime(employeeId, rule.response);
    appendSystemActivity(employeeId, rule.message);
    return true;
  }

  return false;
}

function updateEmployeeStatus(employeeId, nextStatus, extras = {}) {
  const employee = getEmployee(employeeId);
  if (employee) {
    employee.status = nextStatus;
    employee.lastActiveAt = new Date().toISOString();
  }

  const session = ensureSession(employeeId);
  const nextActivityState =
    extras.activityState ?? (isRunningLikeStatus(nextStatus) ? session.activityState ?? "working" : "waiting");
  state.sessions[employeeId] = {
    ...session,
    ...extras,
    status: nextStatus,
    activityState: nextActivityState,
    activityStateUpdatedAt:
      nextActivityState !== session.activityState ? new Date().toISOString() : session.activityStateUpdatedAt ?? null
  };

  persistState();
  emitState();
}

function ingestSessionOutput(employeeId, rawChunk) {
  const session = ensureSession(employeeId);
  recordTerminalChunk(employeeId, rawChunk);
  const parsedMetrics = parseRealMetricsFromChunk(rawChunk);
  applyRealMetrics(session, parsedMetrics);
  const autoConfirmed = maybeAutoConfirm(employeeId, rawChunk);
  const acceptedLines = appendActivityLines(employeeId, extractActivityLines(session, rawChunk));
  const resultChanged = queueAssistantResult(employeeId, acceptedLines);
  updateEstimatedMetrics(session);
  const waitingForInput = terminalTailLooksWaiting(session);
  const activityChanged = setSessionActivityState(employeeId, waitingForInput ? "waiting" : "working");
  if (waitingForInput) {
    const runtime = runtimes.get(employeeId);
    if (runtime?.activityIdleTimer) {
      clearTimeout(runtime.activityIdleTimer);
      runtime.activityIdleTimer = null;
    }
  } else {
    scheduleActivityIdleTransition(employeeId);
  }

  persistState();
  if (autoConfirmed || acceptedLines.length > 0 || parsedMetrics || resultChanged || activityChanged) {
    emitState();
  }
}

async function startSession(employeeId) {
  const employee = getEmployee(employeeId);
  if (!employee) {
    throw new Error("Employee not found.");
  }

  if (runtimes.has(employeeId)) {
    appendSystemActivity(employeeId, "会话已在运行中。");
    return state.sessions[employeeId];
  }

  try {
    validateProjectPath(employee);
    if (employee.agentType === "claude-code") {
      ensureClaudeProjectStatusline(employee.projectPath);
    }
  } catch (error) {
    pushResultEvent(ensureSession(employeeId), "error", error.message);
    updateEmployeeStatus(employeeId, "error", {
      errorMessage: error.message,
      lastSummary: error.message
    });
    throw error;
  }

  const agent = AGENT_DEFINITIONS[employee.agentType];
  const cliStatus = await detectCli(agent.command);
  if (!cliStatus.available) {
    pushResultEvent(ensureSession(employeeId), "error", `${agent.label} CLI not found. Please install '${agent.command}' first.`);
    updateEmployeeStatus(employeeId, "error", {
      cliDetected: false,
      cliPath: null,
      errorMessage: `${agent.label} CLI not found in PATH`,
      lastSummary: `${agent.label} CLI not found in PATH`
    });
    throw new Error(`${agent.label} CLI not found. Please install '${agent.command}' first.`);
  }

  const session = ensureSession(employeeId);
  resetSessionBuffers(session);
  if (employee.agentType === "claude-code") {
    maybeApplyClaudeStatuslineSnapshot(employeeId, { force: true });
    setSessionUsageBaseline(session, getRealUsageFromMetrics(session.metrics));
  }

  updateEmployeeStatus(employeeId, "starting", {
    activityState: "working",
    cliDetected: true,
    cliPath: cliStatus.path,
    errorMessage: "",
    exitCode: null,
    startedAt: new Date().toISOString(),
    lastSummary: `Launching ${agent.label} in ${employee.projectPath}`
  });

  const launchArgs = buildLaunchArgs(employee);
  const commandLine = [agent.command, ...launchArgs].map(quoteForCmd).join(" ");

  appendSystemActivity(employeeId, `正在启动 ${agent.label} · 权限模式：${PERMISSION_MODE_DEFINITIONS[employee.permissionMode].label}`);

  if (pty) {
    const shell = process.env.COMSPEC || "C:\\Windows\\System32\\cmd.exe";
    const ptyProcess = pty.spawn(shell, ["/d", "/c", commandLine], {
      name: "xterm-256color",
      cwd: employee.projectPath,
      cols: 120,
      rows: 34,
      env: process.env,
      // The bundled ConPTY DLL avoids the console-list teardown path that is
      // crashing under Electron on Windows during stop/quit.
      useConpty: true,
      useConptyDll: true
    });

    runtimes.set(employeeId, {
      type: "pty",
      process: ptyProcess,
      stopping: false,
      lastAutoConfirm: null,
      startedAtMs: Date.now(),
      resultFlushTimer: null,
      activityIdleTimer: null,
      stopFallbackTimer: null
    });

    ptyProcess.onData((data) => {
      if (runtimes.get(employeeId)?.stopping) {
        recordTerminalChunk(employeeId, data);
        return;
      }

      ingestSessionOutput(employeeId, data);
      if (state.sessions[employeeId]?.status !== "running") {
        pushResultEvent(ensureSession(employeeId), "system_status", `${agent.label} 已接入，正在接收输出。`);
        updateEmployeeStatus(employeeId, "running", { cliDetected: true });
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      const runtime = runtimes.get(employeeId);
      if (!runtime || appShuttingDown) {
        return;
      }
      clearRuntimeTimers(runtime);
      const wasStoppedByUser = runtime?.stopping;
      if (runtime?.startedAtMs) {
        recordEmployeeRuntime(employeeId, Date.now() - runtime.startedAtMs);
      }
      flushAssistantResult(employeeId);
      recordEmployeeWage(employeeId);
      runtimes.delete(employeeId);
      const nextStatus = wasStoppedByUser || exitCode === 0 ? "stopped" : "error";
      pushResultEvent(
        ensureSession(employeeId),
        nextStatus === "error" ? "error" : "system_status",
        wasStoppedByUser ? "会话已由用户停止。" : exitCode === 0 ? "会话已结束。" : `会话异常退出，退出码 ${exitCode}。`
      );
      updateEmployeeStatus(employeeId, nextStatus, {
        exitCode,
        errorMessage: nextStatus === "error" ? `Session exited with code ${exitCode}` : "",
        lastSummary: wasStoppedByUser ? "Session stopped by user." : exitCode === 0 ? "Session ended." : `Session exited with code ${exitCode}`
      });
    });

    emitState();
    return state.sessions[employeeId];
  }

  const child = spawn(agent.command, launchArgs, {
    cwd: employee.projectPath,
    shell: true,
    windowsHide: true,
    stdio: "pipe"
  });

  runtimes.set(employeeId, {
    type: "spawn",
    process: child,
    stopping: false,
    lastAutoConfirm: null,
    startedAtMs: Date.now(),
    resultFlushTimer: null,
    activityIdleTimer: null,
    stopFallbackTimer: null
  });

  child.stdout.on("data", (chunk) => {
    if (runtimes.get(employeeId)?.stopping) {
      recordTerminalChunk(employeeId, chunk.toString());
      return;
    }

    ingestSessionOutput(employeeId, chunk.toString());
    if (state.sessions[employeeId]?.status !== "running") {
      pushResultEvent(ensureSession(employeeId), "system_status", `${agent.label} 已接入，正在接收输出。`);
      updateEmployeeStatus(employeeId, "running", { cliDetected: true });
    }
  });

  child.stderr.on("data", (chunk) => {
    if (runtimes.get(employeeId)?.stopping) {
      recordTerminalChunk(employeeId, chunk.toString());
      return;
    }

    ingestSessionOutput(employeeId, chunk.toString());
    if (state.sessions[employeeId]?.status !== "running") {
      pushResultEvent(ensureSession(employeeId), "system_status", `${agent.label} 已接入，正在接收输出。`);
      updateEmployeeStatus(employeeId, "running", { cliDetected: true });
    }
  });

  child.on("error", (error) => {
    const runtime = runtimes.get(employeeId);
    if (!runtime || appShuttingDown) {
      return;
    }
    clearRuntimeTimers(runtime);
    runtimes.delete(employeeId);
    pushResultEvent(ensureSession(employeeId), "error", error.message);
    updateEmployeeStatus(employeeId, "error", {
      errorMessage: error.message,
      lastSummary: error.message
    });
  });

  child.on("close", (code) => {
    const runtime = runtimes.get(employeeId);
    if (!runtime || appShuttingDown) {
      return;
    }
    clearRuntimeTimers(runtime);
    const wasStoppedByUser = runtime?.stopping;
    if (runtime?.startedAtMs) {
      recordEmployeeRuntime(employeeId, Date.now() - runtime.startedAtMs);
    }
    flushAssistantResult(employeeId);
    recordEmployeeWage(employeeId);
    runtimes.delete(employeeId);
    const nextStatus = wasStoppedByUser || code === 0 ? "stopped" : "error";
    pushResultEvent(
      ensureSession(employeeId),
      nextStatus === "error" ? "error" : "system_status",
      wasStoppedByUser ? "会话已由用户停止。" : code === 0 ? "会话已结束。" : `会话异常退出，退出码 ${code}。`
    );
    updateEmployeeStatus(employeeId, nextStatus, {
      exitCode: code,
      errorMessage: nextStatus === "error" ? `Session exited with code ${code}` : "",
      lastSummary: wasStoppedByUser ? "Session stopped by user." : code === 0 ? "Session ended." : `Session exited with code ${code}`
    });
  });

  emitState();
  return state.sessions[employeeId];
}

function stopSession(employeeId) {
  const runtime = runtimes.get(employeeId);
  if (!runtime) {
    updateEmployeeStatus(employeeId, "stopped", {
      errorMessage: "",
      lastSummary: "No active runtime."
    });
    return state.sessions[employeeId];
  }

  runtime.stopping = true;
  clearRuntimeTimers(runtime);

  appendSystemActivity(employeeId, "会话已由用户停止。");
  updateEmployeeStatus(employeeId, "stopping", {
    errorMessage: "",
    lastSummary: "Stopping session..."
  });

  killRuntimeProcessTree(runtime);
  runtime.stopFallbackTimer = setTimeout(() => {
    const liveRuntime = runtimes.get(employeeId);
    if (!liveRuntime || !liveRuntime.stopping) {
      return;
    }

    finalizeStoppedRuntime(employeeId, liveRuntime, {
      message: "会话已强制停止。",
      lastSummary: "Session force-stopped."
    });
  }, STOP_FALLBACK_MS);

  return state.sessions[employeeId];
}

function sendInput(employeeId, input) {
  const runtime = runtimes.get(employeeId);
  if (!runtime) {
    throw new Error("Session is not running.");
  }

  const session = ensureSession(employeeId);
  if (session.status !== "running" && session.status !== "starting") {
    throw new Error(`Session is ${session.status}. Start it before sending input.`);
  }

  const text = String(input ?? "");
  if (!text.trim()) {
    return;
  }

  flushAssistantResult(employeeId);

  try {
    writeToRuntime(employeeId, text.endsWith("\r") || text.endsWith("\n") ? text : `${text}\r`);
  } catch (error) {
    pushResultEvent(session, "error", error.message);
    updateEmployeeStatus(employeeId, "error", {
      errorMessage: error.message,
      lastSummary: error.message
    });
    throw error;
  }

  const submitted = text.trim();
  if (submitted.startsWith("/")) {
    pushResultEvent(session, "command", submitted, { command: submitted });
  } else {
    pushResultEvent(session, "user_prompt", submitted);
  }

  session.inputCharCount += submitted.length;
  session.lastSubmittedAt = new Date().toISOString();
  setSessionActivityState(employeeId, "working");
  scheduleActivityIdleTransition(employeeId);
  updateEstimatedMetrics(session);
  markMetricsUpdated(session);

  appendActivityLines(employeeId, [`> ${submitted}`]);
  persistState();
  emitState();
}

function sendRawInput(employeeId, input) {
  const runtime = runtimes.get(employeeId);
  if (!runtime) {
    throw new Error("Session is not running.");
  }

  const session = ensureSession(employeeId);
  if (session.status !== "running" && session.status !== "starting") {
    throw new Error(`Session is ${session.status}. Start it before sending input.`);
  }

  const text = String(input ?? "");
  if (!text) {
    return;
  }

  try {
    writeToRuntime(employeeId, text);
  } catch (error) {
    pushResultEvent(session, "error", error.message);
    updateEmployeeStatus(employeeId, "error", {
      errorMessage: error.message,
      lastSummary: error.message
    });
    throw error;
  }

  session.inputCharCount += flattenTerminalText(text).replace(/\s+/g, " ").trim().length;
  if (/[\r\n]/.test(text)) {
    session.lastSubmittedAt = new Date().toISOString();
    setSessionActivityState(employeeId, "working");
    scheduleActivityIdleTransition(employeeId);
  }
  updateEstimatedMetrics(session);
  markMetricsUpdated(session);

  if (/[\r\n]/.test(text) || text.length > 20) {
    persistState();
    emitState();
  }
}

function sendEscape(employeeId) {
  sendRawInput(employeeId, "\u001b");
}

function clearResultFeed(employeeId) {
  const employee = getEmployee(employeeId);
  const session = ensureSession(employeeId);
  if (!employee || !session) {
    throw new Error("Employee not found.");
  }

  session.resultFeed = [];
  persistState();
  emitState();
  return session.resultFeed;
}

async function chooseDirectory() {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
}

async function openProjectDirectory(projectPath) {
  const target = String(projectPath ?? "");
  if (!target || !fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    throw new Error("Project folder does not exist.");
  }

  const errorMessage = await shell.openPath(target);
  if (errorMessage) {
    throw new Error(errorMessage);
  }

  return true;
}

function getTerminalHistory(employeeId) {
  return ensureSession(employeeId).terminalHistory ?? [];
}

function refreshSessionMetrics(employeeId) {
  const employee = getEmployee(employeeId);
  if (!employee) {
    throw new Error("Employee not found.");
  }

  const session = ensureSession(employeeId);
  let contextUpdated = false;
  let usageUpdated = false;

  if (employee.agentType === "claude-code") {
    ensureClaudeProjectStatusline(employee.projectPath);
    contextUpdated = maybeApplyClaudeStatuslineSnapshot(employeeId, { force: true });
    usageUpdated = Boolean(getRealUsageFromMetrics(session.metrics));
  } else {
    const parsed = parseRealMetricsFromChunk((session.terminalHistory ?? []).slice(-20).join(""));
    if (parsed) {
      applyRealMetrics(session, parsed);
      contextUpdated = parsed.contextUsagePercent !== undefined || parsed.contextWindowTokens !== undefined;
      usageUpdated = Boolean(getRealUsageFromMetrics(session.metrics));
    }
  }

  updateEstimatedMetrics(session);
  persistState();
  emitState();

  return {
    snapshot: getSnapshot(),
    contextUpdated,
    usageUpdated,
    source: getRealUsageFromMetrics(session.metrics) ? "real" : "estimated"
  };
}

function readClipboardPayload() {
  let formats = [];
  try {
    formats = typeof clipboard.availableFormats === "function" ? clipboard.availableFormats() : [];
  } catch {
    formats = [];
  }

  const filePath = readClipboardImageFilePath(formats);
  if (filePath) {
    return { text: "", imagePath: filePath, formats };
  }

  let text = "";
  try {
    text = clipboard.readText();
  } catch {
    text = "";
  }

  if (text) {
    return { text, imagePath: "", formats };
  }

  let image = null;
  try {
    image = clipboard.readImage();
  } catch {
    image = null;
  }

  if (!image || image.isEmpty()) {
    return { text: "", imagePath: "", formats };
  }

  const outputDir = path.join(os.tmpdir(), "pixel-office-clipboard");
  fs.mkdirSync(outputDir, { recursive: true });
  const imagePath = path.join(outputDir, `clipboard-${Date.now()}.png`);
  fs.writeFileSync(imagePath, image.toPNG());
  return { text, imagePath, formats };
}

function readClipboardImageFilePath(formats = []) {
  const fileFormat = formats.find((format) => /^FileNameW$/i.test(format)) || formats.find((format) => /^FileName$/i.test(format));
  if (!fileFormat) {
    return "";
  }

  let buffer = null;
  try {
    buffer = clipboard.readBuffer(fileFormat);
  } catch {
    buffer = null;
  }

  if (!buffer || buffer.length === 0) {
    return "";
  }

  const raw = fileFormat.toLowerCase() === "filenamew" ? buffer.toString("utf16le") : buffer.toString("utf8");
  const filePath = raw.split("\0").map((item) => item.trim()).find(Boolean) ?? "";
  if (!/\.(?:png|jpe?g|webp|gif|bmp)$/i.test(filePath)) {
    return "";
  }

  return filePath;
}

function registerIpc() {
  ipcMain.handle("app:get-state", async () => getSnapshot());
  ipcMain.handle("clipboard:read-payload", async () => readClipboardPayload());
  ipcMain.handle("session:refresh-metrics", async (_event, employeeId) => refreshSessionMetrics(employeeId));
  ipcMain.handle("project:choose-directory", async () => chooseDirectory());
  ipcMain.handle("project:open-directory", async (_event, projectPath) => openProjectDirectory(projectPath));
  ipcMain.handle("employee:create", async (_event, payload) => createEmployee(payload));
  ipcMain.handle("employee:update", async (_event, payload) => updateEmployee(payload));
  ipcMain.handle("employee:remove", async (_event, employeeId) => removeEmployee(employeeId));
  ipcMain.handle("session:start", async (_event, employeeId) => startSession(employeeId));
  ipcMain.handle("session:stop", async (_event, employeeId) => stopSession(employeeId));
  ipcMain.handle("session:send-input", async (_event, payload) => sendInput(payload.employeeId, payload.input));
  ipcMain.handle("session:send-raw-input", async (_event, payload) => sendRawInput(payload.employeeId, payload.input));
  ipcMain.handle("session:send-escape", async (_event, employeeId) => sendEscape(employeeId));
  ipcMain.handle("session:clear-result-feed", async (_event, employeeId) => clearResultFeed(employeeId));
  ipcMain.handle("session:get-terminal-history", async (_event, employeeId) => getTerminalHistory(employeeId));
  ipcMain.handle("session:resize", async (_event, payload) => resizeSession(payload.employeeId, payload.cols, payload.rows));
}

app.whenReady().then(() => {
  ensureStoreReady();
  ensureClaudeStatuslineAssets();
  for (const employee of state.employees) {
    if (employee.agentType === "claude-code" && employee.projectPath && fs.existsSync(employee.projectPath)) {
      ensureClaudeProjectStatusline(employee.projectPath);
    }
  }
  startClaudeStatusPoller();
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  shutdownAllRuntimes({ quitting: process.platform !== "darwin" });

  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  shutdownAllRuntimes({ quitting: true });
  if (claudeStatusPoller) {
    clearInterval(claudeStatusPoller);
    claudeStatusPoller = null;
  }
});
