import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { createPreviewPlayback } from "./preview-playback.mjs";
import { createPreviewFrames, previewTranscript } from "./preview-scenarios.mjs";

const APP_NAME_ZH = "胶囊办公室";
const APP_NAME_EN = "Capsule Office";

const AGENT_COPY = {
  "claude-code": { badge: "CC", accent: "mint" },
  "codex-cli": { badge: "CX", accent: "amber" }
};

const STATUS_LABELS = {
  idle: "待命",
  starting: "启动中",
  running: "运行中",
  working: "工作中",
  waiting: "空闲",
  stopping: "停止中",
  stopped: "已停止",
  error: "异常"
};

const METRIC_SOURCE_LABELS = {
  real: "真实值",
  estimated: "估算值",
  none: "暂无",
  partial: "部分估算"
};

const DEFAULT_PERMISSION_MODE = "high-risk-auto";
const THEME_STORAGE_KEY = "pixel-office-theme";
const EMPLOYEE_TEXT_LIMIT = 15;

const THEME_DEFINITIONS = {
  wood: {
    id: "wood",
    label: "木质",
    colorScheme: "dark",
    terminalTheme: {
      background: "#07130c",
      foreground: "#89ffbc",
      cursor: "#89ffbc",
      selectionBackground: "rgba(137, 255, 188, 0.25)",
      black: "#07130c",
      brightBlack: "#355341",
      green: "#89ffbc",
      brightGreen: "#c7ffd9",
      yellow: "#ffc86a",
      brightYellow: "#ffe3a3",
      red: "#ff8a76",
      brightRed: "#ffb4a7",
      blue: "#7ab7ff",
      brightBlue: "#acd1ff"
    }
  },
  daylight: {
    id: "daylight",
    label: "白昼",
    colorScheme: "light",
    terminalTheme: {
      background: "#ffffff",
      foreground: "#303340",
      cursor: "#5b5df6",
      selectionBackground: "rgba(91, 93, 246, 0.18)",
      black: "#303340",
      brightBlack: "#8b8f9f",
      green: "#5b5df6",
      brightGreen: "#7c7cff",
      yellow: "#d89b2b",
      brightYellow: "#b7791f",
      red: "#f05d75",
      brightRed: "#d94660",
      blue: "#5b5df6",
      brightBlue: "#7c7cff",
      magenta: "#7357ff",
      brightMagenta: "#8e7cff",
      cyan: "#20a4d8",
      brightCyan: "#38bdf8",
      white: "#f7f7fb",
      brightWhite: "#ffffff"
    }
  },
  midnight: {
    id: "midnight",
    label: "黑夜",
    colorScheme: "dark",
    terminalTheme: {
      background: "#061015",
      foreground: "#9ce7d0",
      cursor: "#61e4c2",
      selectionBackground: "rgba(97, 228, 194, 0.2)",
      black: "#091219",
      brightBlack: "#2d4650",
      green: "#61e4c2",
      brightGreen: "#b7ffe9",
      yellow: "#f1c880",
      brightYellow: "#f8ddb0",
      red: "#ff8f8f",
      brightRed: "#ffb8b8",
      blue: "#86bbff",
      brightBlue: "#b9d6ff"
    }
  }
};

const THEME_ORDER = ["midnight", "daylight", "wood"];
const ACTIVE_THEME_IDS = new Set(THEME_ORDER);

function resolveThemeId(value) {
  return ACTIVE_THEME_IDS.has(value) ? value : "midnight";
}

function readStoredThemeId() {
  if (typeof window === "undefined") {
    return "midnight";
  }

  try {
    return resolveThemeId(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "midnight";
  }
}

const PREVIEW_EMPLOYEES = [
  {
    id: "preview-1",
    name: "Claude Lead",
    sceneTag: "主控",
    agentType: "claude-code",
    projectPath: "D:\\Projects\\CapsuleOffice",
    accent: "mint",
    permissionMode: DEFAULT_PERMISSION_MODE,
    status: "running",
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    pricing: normalizePricing({ inputPricePer1M: 3, outputPricePer1M: 15 }),
    runtimeTodayMs: 1000 * 60 * 38,
    wageTodayUsd: 0.0214,
    wageTotalUsd: 0.2148,
    runtimeDayKey: "",
    wageDayKey: ""
  },
  {
    id: "preview-2",
    name: "Codex Build",
    sceneTag: "构建",
    agentType: "codex-cli",
    projectPath: "D:\\Projects\\CapsuleOffice",
    accent: "amber",
    permissionMode: DEFAULT_PERMISSION_MODE,
    status: "idle",
    createdAt: new Date().toISOString(),
    lastActiveAt: null,
    pricing: normalizePricing({ inputPricePer1M: 1.25, outputPricePer1M: 10 }),
    runtimeTodayMs: 1000 * 60 * 12,
    wageTodayUsd: 0.0082,
    wageTotalUsd: 0.0916,
    runtimeDayKey: "",
    wageDayKey: ""
  }
];

const PREVIEW_SNAPSHOT = {
  config: {
    maxEmployees: 5,
    agentDefinitions: [
      { id: "claude-code", label: "Claude Code", command: "claude", color: "#48f2ad" },
      { id: "codex-cli", label: "Codex CLI", command: "codex", color: "#ffb454" }
    ],
    permissionModes: [
      { id: "standard", label: "标准确认", description: "保留 CLI 默认确认流程。" },
      { id: DEFAULT_PERMISSION_MODE, label: "高风险自动确认", description: "默认启用高风险自动执行。" }
    ]
  },
  employees: PREVIEW_EMPLOYEES,
  sessions: {
    "preview-1": {
      status: "running",
      activityState: "working",
      activityStateUpdatedAt: new Date().toISOString(),
      startedAt: new Date(Date.now() - 1000 * 60 * 16).toISOString(),
      lastOutputAt: new Date().toISOString(),
      lastSummary: "正在打磨控制台舞台的层次、灯光和状态布局。",
      errorMessage: "",
      cliPath: "claude",
      exitCode: null,
      cliDetected: true,
      resultFeed: [
        {
          id: "preview-event-1",
          type: "input",
          text: "Polish the office stage composition and verify layout.",
          createdAt: new Date(Date.now() - 1000 * 60 * 12).toISOString()
        },
        {
          id: "preview-event-2",
          type: "summary",
          text: "Added foreground platform depth, cable traces, and panel blending passes.",
          createdAt: new Date(Date.now() - 1000 * 60 * 3).toISOString()
        }
      ],
      terminalHistory: [],
      inputCharCount: 4200,
      outputCharCount: 15600,
      visibleOutputCharCount: 11200,
      estimatedTokenCount: 3850,
      lastSubmittedAt: new Date(Date.now() - 1000 * 60 * 12).toISOString(),
      outputStylePrimed: true,
      metrics: {
        contextWindowTokens: 200000,
        contextUsagePercent: 38,
        contextUsageSource: "estimated",
        tokenCount: 3850,
        tokenCountSource: "estimated",
        durationSec: 960,
        durationSource: "estimated",
        lastUpdatedAt: new Date().toISOString()
      }
    },
    "preview-2": {
      status: "idle",
      activityState: "waiting",
      activityStateUpdatedAt: null,
      startedAt: null,
      lastOutputAt: null,
      lastSummary: "等待下一个实现任务。",
      errorMessage: "",
      cliPath: "codex",
      exitCode: 0,
      cliDetected: true,
      resultFeed: [],
      terminalHistory: [],
      inputCharCount: 1200,
      outputCharCount: 4800,
      visibleOutputCharCount: 4100,
      estimatedTokenCount: 1325,
      lastSubmittedAt: null,
      outputStylePrimed: false,
      metrics: {
        contextWindowTokens: 200000,
        contextUsagePercent: 9,
        contextUsageSource: "estimated",
        tokenCount: 1325,
        tokenCountSource: "estimated",
        durationSec: null,
        durationSource: "none",
        lastUpdatedAt: null
      }
    }
  }
};

function clonePreviewSnapshot(snapshot) {
  return JSON.parse(JSON.stringify(snapshot));
}

let browserPreviewSnapshot = clonePreviewSnapshot(PREVIEW_SNAPSHOT);
for (const employee of browserPreviewSnapshot.employees) {
  browserPreviewSnapshot.sessions[employee.id].terminalHistory = [previewTranscript(employee.agentType)];
}
let browserPreviewEmployeeSequence = PREVIEW_EMPLOYEES.length + 1;
const browserPreviewStateListeners = new Set();
const browserPreviewTerminalListeners = new Set();
const browserPreviewPlayers = new Map();
const browserPreviewPlaybackListeners = new Set();

function emitBrowserPreviewState() {
  const snapshot = clonePreviewSnapshot(browserPreviewSnapshot);
  for (const handler of browserPreviewStateListeners) {
    handler(snapshot);
  }
}

function emitBrowserPreviewTerminal(employeeId, chunk) {
  const session = browserPreviewSnapshot.sessions[employeeId];
  if (session) session.terminalHistory = [...(session.terminalHistory ?? []), chunk].slice(-200);
  for (const handler of browserPreviewTerminalListeners) {
    handler({ employeeId, chunk });
  }
}

function getBrowserPreviewPlayer(employeeId) {
  if (browserPreviewPlayers.has(employeeId)) return browserPreviewPlayers.get(employeeId);
  const employee = browserPreviewSnapshot.employees.find(item => item.id === employeeId);
  if (!employee) return null;
  const player = createPreviewPlayback({
    frames: createPreviewFrames(employee.agentType),
    onFrame: frame => {
      const session = browserPreviewSnapshot.sessions[employeeId];
      if (!session) return;
      if (frame.reset) session.terminalHistory = [];
      emitBrowserPreviewTerminal(employeeId, (frame.reset ? "\x1bc" : "") + frame.text);
      if (frame.context !== undefined) {
        session.metrics = { ...session.metrics, contextUsagePercent: frame.context, contextUsageSource: "estimated" };
        setBrowserPreviewSessionStatus(employeeId, "running", { activityState: "working", lastSummary: `模拟操作：${frame.stage}` });
      }
    },
    onState: playback => {
      if (playback.completed) setBrowserPreviewSessionStatus(employeeId, "running", { activityState: "waiting" });
      for (const handler of browserPreviewPlaybackListeners) handler({ employeeId, ...playback });
    }
  });
  browserPreviewPlayers.set(employeeId, player);
  return player;
}

function setBrowserPreviewSessionStatus(employeeId, status, extras = {}) {
  const employee = browserPreviewSnapshot.employees.find((item) => item.id === employeeId);
  if (!employee) {
    return null;
  }

  employee.status = status;
  employee.lastActiveAt = new Date().toISOString();
  browserPreviewSnapshot.sessions[employeeId] = {
    ...browserPreviewSnapshot.sessions[employeeId],
    status,
    activityState: extras.activityState ?? (status === "running" ? "working" : "waiting"),
    activityStateUpdatedAt: new Date().toISOString(),
    ...extras
  };
  emitBrowserPreviewState();
  return browserPreviewSnapshot.sessions[employeeId];
}

const BROWSER_PREVIEW_API = {
  previewMode: true,
  getState: async () => clonePreviewSnapshot(browserPreviewSnapshot),
  chooseDirectory: async () => "",
  openProjectDirectory: async () => undefined,
  createEmployee: async (payload) => {
    if (browserPreviewSnapshot.employees.length >= browserPreviewSnapshot.config.maxEmployees) {
      throw new Error("预览模式员工已满。");
    }

    const employee = {
      id: `preview-${browserPreviewEmployeeSequence++}`,
      name: payload?.name || `Preview ${browserPreviewEmployeeSequence}`,
      sceneTag: payload?.sceneTag || "场景",
      agentType: payload?.agentType || "claude-code",
      projectPath: payload?.projectPath || "D:\\Projects\\CapsuleOffice",
      accent: AGENT_COPY[payload?.agentType]?.accent ?? "mint",
      permissionMode: payload?.permissionMode || DEFAULT_PERMISSION_MODE,
      status: "idle",
      createdAt: new Date().toISOString(),
      lastActiveAt: null,
      pricing: normalizePricing(payload?.pricing),
      runtimeTodayMs: 0,
      wageTodayUsd: 0,
      wageTotalUsd: 0,
      runtimeDayKey: "",
      wageDayKey: ""
    };

    browserPreviewSnapshot.employees.push(employee);
    browserPreviewSnapshot.sessions[employee.id] = {
      ...PREVIEW_SNAPSHOT.sessions["preview-2"],
      status: "idle",
      activityState: "waiting",
      activityStateUpdatedAt: null,
      startedAt: null,
      lastOutputAt: null,
      lastSummary: "浏览器预览员工，真实会话请在 Electron 窗口中启动。",
      resultFeed: [],
      terminalHistory: []
    };
    emitBrowserPreviewState();
    return clonePreviewSnapshot(employee);
  },
  updateEmployee: async (payload) => {
    const index = browserPreviewSnapshot.employees.findIndex((item) => item.id === payload?.id);
    if (index === -1) {
      throw new Error("Employee not found.");
    }

    browserPreviewSnapshot.employees[index] = {
      ...browserPreviewSnapshot.employees[index],
      ...payload,
      pricing: normalizePricing(payload?.pricing)
    };
    emitBrowserPreviewState();
    return clonePreviewSnapshot(browserPreviewSnapshot.employees[index]);
  },
  removeEmployee: async (employeeId) => {
    browserPreviewPlayers.get(employeeId)?.destroy();
    browserPreviewPlayers.delete(employeeId);
    browserPreviewSnapshot.employees = browserPreviewSnapshot.employees.filter((item) => item.id !== employeeId);
    delete browserPreviewSnapshot.sessions[employeeId];
    emitBrowserPreviewState();
  },
  startSession: async (employeeId) => {
    const session = setBrowserPreviewSessionStatus(employeeId, "running", {
      activityState: "working",
      startedAt: new Date().toISOString(),
      errorMessage: "",
      exitCode: null,
      lastSummary: "浏览器预览会话已模拟启动。真实 PTY 请打开 Electron 应用。"
    });
    getBrowserPreviewPlayer(employeeId)?.replay();
    return clonePreviewSnapshot(session);
  },
  stopSession: async (employeeId) => {
    browserPreviewPlayers.get(employeeId)?.pause();
    const session = setBrowserPreviewSessionStatus(employeeId, "stopped", {
      activityState: "waiting",
      exitCode: 0,
      errorMessage: "",
      lastSummary: "浏览器预览会话已模拟停止。"
    });
    emitBrowserPreviewTerminal(employeeId, "\r\n[preview] Browser preview session stopped.\r\n");
    return clonePreviewSnapshot(session);
  },
  sendRawInput: async () => undefined,
  sendEscape: async () => undefined,
  resizeSession: async () => undefined,
  refreshSessionMetrics: async () => ({
    snapshot: clonePreviewSnapshot(browserPreviewSnapshot),
    contextUpdated: false,
    usageUpdated: false,
    source: "estimated"
  }),
  getTerminalHistory: async (employeeId) => browserPreviewSnapshot.sessions[employeeId]?.terminalHistory ?? [],
  onStateUpdated: (handler) => {
    browserPreviewStateListeners.add(handler);
    return () => browserPreviewStateListeners.delete(handler);
  },
  onTerminalData: (handler) => {
    browserPreviewTerminalListeners.add(handler);
    return () => browserPreviewTerminalListeners.delete(handler);
  }
};

function getPixelOfficeApi() {
  if (typeof window === "undefined") {
    return BROWSER_PREVIEW_API;
  }
  return window.pixelOffice ?? BROWSER_PREVIEW_API;
}

async function readClipboardText() {
  if (typeof window !== "undefined" && typeof window.pixelOffice?.readClipboardText === "function") {
    return window.pixelOffice.readClipboardText();
  }

  if (navigator.clipboard?.readText) {
    return navigator.clipboard.readText();
  }

  return "";
}

async function readClipboardPayload() {
  if (typeof window !== "undefined" && typeof window.pixelOffice?.readClipboardPayload === "function") {
    return window.pixelOffice.readClipboardPayload();
  }

  return { text: await readClipboardText(), imagePath: "" };
}

async function writeClipboardText(text) {
  const value = String(text ?? "");
  if (typeof window !== "undefined" && typeof window.pixelOffice?.writeClipboardText === "function") {
    window.pixelOffice.writeClipboardText(value);
    return;
  }

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
  }
}

function agentLabel(definitions, agentType) {
  return definitions.find((item) => item.id === agentType)?.label ?? agentType;
}

function permissionLabel(definitions, permissionMode) {
  return definitions.find((item) => item.id === permissionMode)?.label ?? permissionMode;
}

function metricSourceLabel(source) {
  return METRIC_SOURCE_LABELS[source] ?? METRIC_SOURCE_LABELS.none;
}

function normalizeTextInput(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function countTextChars(value) {
  return Array.from(String(value ?? "")).length;
}

function limitTextInput(value, maxLength = EMPLOYEE_TEXT_LIMIT) {
  return Array.from(String(value ?? "")).slice(0, maxLength).join("");
}

function normalizePricing(pricing) {
  return {
    inputPricePer1M: Number(pricing?.inputPricePer1M) || 0,
    outputPricePer1M: Number(pricing?.outputPricePer1M) || 0,
    cacheReadPricePer1M: Number(pricing?.cacheReadPricePer1M) || 0,
    cacheWritePricePer1M: Number(pricing?.cacheWritePricePer1M) || 0
  };
}

function createEmployeeForm(permissionMode = DEFAULT_PERMISSION_MODE) {
  return {
    name: "",
    sceneTag: "",
    agentType: "claude-code",
    permissionMode,
    projectPath: "",
    pricing: normalizePricing()
  };
}

function createEmployeeFormFromRecord(employee) {
  return {
    name: employee?.name ?? "",
    sceneTag: employee?.sceneTag ?? "",
    agentType: employee?.agentType ?? "claude-code",
    permissionMode: employee?.permissionMode ?? DEFAULT_PERMISSION_MODE,
    projectPath: employee?.projectPath ?? "",
    pricing: normalizePricing(employee?.pricing)
  };
}

function estimateTokensFromChars(charCount) {
  return Math.max(0, Math.round(Number(charCount || 0) / 4));
}

function normalizeTokenMetric(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const tokenCount = Number(value);
  return Number.isFinite(tokenCount) ? Math.max(0, Math.round(tokenCount)) : null;
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

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor((ms || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function enableTerminalLineWrap(terminal) {
  terminal.write("\x1b[?7h");
}

function isLiveTerminalStatus(status) {
  return status === "starting" || status === "running" || status === "stopping";
}

function isTerminalPlaceholderStatus(status) {
  return status === "idle" || status === "stopped" || status === "error";
}

function sessionDisplayStatus(session) {
  const status = session?.status ?? "idle";
  if (status === "running") {
    return session?.activityState === "waiting" ? "waiting" : "working";
  }
  return status;
}

function clipboardPayloadToTerminalInput(payload) {
  const text = String(payload?.text ?? "");
  const imagePath = String(payload?.imagePath ?? "");
  if (!imagePath) {
    return text;
  }

  if (!text.trim()) {
    return imagePath;
  }

  return `${text}${text.endsWith("\n") ? "" : "\n"}${imagePath}`;
}

function normalizePastedTerminalText(value) {
  return String(value ?? "").replace(/\r\n|\n/g, "\r");
}

function bracketTerminalPaste(value) {
  return `\x1b[200~${normalizePastedTerminalText(value)}\x1b[201~`;
}

function shouldHandleImagePaste(event) {
  const clipboardData = event.clipboardData;
  if (!clipboardData) {
    return false;
  }

  return Array.from(clipboardData.items ?? []).some((item) => item.kind === "file" || item.type.startsWith("image/"));
}

function formatUsd(value) {
  return `$${(Number(value) || 0).toFixed(4)}`;
}

function contextRiskCopy(percent, isActive = true) {
  if (!isActive) {
    return "会话未启动，上下文压力为 0。";
  }
  if (percent === null || percent === undefined) {
    return "暂无上下文压力数据。";
  }
  if (percent >= 80) {
    return "上下文接近上限，建议尽快压缩或新开会话。";
  }
  if (percent >= 60) {
    return "上下文压力偏高，继续追加任务前建议先压缩。";
  }
  return "上下文压力可控。";
}

function MetricTile({ label, value, source }) {
  return (
    <div className="metric-tile">
      <div className="metric-tile-header">
        <span className="metric-label">{label}</span>
        <span className={`source-pill source-${source ?? "none"}`}>{metricSourceLabel(source ?? "none")}</span>
      </div>
      <strong>{value}</strong>
    </div>
  );
}

function SectionTitle({ en, zh, as = "h2", compact = false }) {
  const Tag = as;

  return (
    <Tag className={`section-title ${compact ? "compact" : ""}`}>
      <span className="title-en">{en}</span>
      <span className="title-zh">{zh}</span>
    </Tag>
  );
}

function CommandIcon({ type }) {
  return (
    <svg className="command-icon" viewBox="0 0 24 24" aria-hidden="true">
      {type === "play" ? <path d="M9 6.8v10.4L17.5 12 9 6.8Z" /> : null}
      {type === "stop" ? <path d="M8 8h8v8H8z" /> : null}
      {type === "edit" ? (
        <>
          <path d="M5 19h4l10-10-4-4L5 15v4Z" />
          <path d="M13.5 6.5 17.5 10.5" />
        </>
      ) : null}
      {type === "remove" ? (
        <>
          <path d="M7 7h10" />
          <path d="M10 7V5h4v2" />
          <path d="M9 10v7" />
          <path d="M15 10v7" />
          <path d="M6 7l1 13h10l1-13" />
        </>
      ) : null}
    </svg>
  );
}

function PanelIcon({ type }) {
  return (
    <svg className="panel-icon" viewBox="0 0 24 24" aria-hidden="true">
      {type === "session" ? (
        <>
          <path d="M4 12h4l2-5 4 10 2-5h4" />
          <path d="M5 5h14v14H5z" />
        </>
      ) : null}
      {type === "context" ? (
        <>
          <path d="M6 7h12" />
          <path d="M6 12h12" />
          <path d="M6 17h8" />
          <path d="M4 4h16v16H4z" />
        </>
      ) : null}
      {type === "runtime" ? (
        <>
          <path d="M12 7v5l3 2" />
          <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z" />
        </>
      ) : null}
      {type === "artifacts" ? (
        <>
          <path d="M4 7h6l2 2h8v9H4z" />
          <path d="M4 7v11" />
        </>
      ) : null}
    </svg>
  );
}

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 32 32" className="brand-glyph">
        <path d="M16 6c5.5 0 10 4.5 10 10" />
        <path d="M6 16c0-5.5 4.5-10 10-10" />
        <path d="M10 22v-5.5A6 6 0 0 1 16 10a6 6 0 0 1 6 6v2.2" />
        <path d="M14 25v-8.5a2 2 0 0 1 4 0V22" />
        <path d="M8 25v-4" />
        <path d="M20 25c3.2-.8 5-3 5-6.5" />
        <path d="M11 13.5c1.1-1.5 2.7-2.4 5-2.4" />
      </svg>
    </span>
  );
}

export default function App() {
  const [snapshot, setSnapshot] = useState({
    config: { maxEmployees: 5, agentDefinitions: [], permissionModes: [] },
    employees: [],
    sessions: {}
  });
  const [themeId, setThemeId] = useState(() => readStoredThemeId());
  const [selectedId, setSelectedId] = useState(null);
  const [modalState, setModalState] = useState({ open: false, mode: "create", employeeId: null });
  const [message, setMessage] = useState({ text: "", tone: "info" });
  const [now, setNow] = useState(Date.now());
  const [refreshingMetrics, setRefreshingMetrics] = useState(false);
  const [form, setForm] = useState(() => createEmployeeForm());
  const terminalHostsRef = useRef(new Map());
  const terminalsRef = useRef(new Map());
  const fitAddonsRef = useRef(new Map());
  const inputDisposablesRef = useRef(new Map());
  const terminalDomDisposablesRef = useRef(new Map());
  const selectionPendingChunksRef = useRef(new Map());
  const lastTerminalSelectionRef = useRef(new Map());
  const terminalSelectionGuardsRef = useRef(new Map());
  const resizeObserverRef = useRef(null);
  const modalNameInputRef = useRef(null);
  const lastViewportRef = useRef(new Map());
  const placeholderStateRef = useRef(new Map());
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const pixelOffice = useMemo(() => getPixelOfficeApi(), []);
  const isPreviewMode = pixelOffice.previewMode === true;
  const isShowcaseMode = isPreviewMode && new URLSearchParams(window.location.search).get("showcase") === "1";
  const activeTheme = THEME_DEFINITIONS[themeId] ?? THEME_DEFINITIONS.wood;

  const selectedEmployee = useMemo(
    () => snapshot.employees.find((item) => item.id === selectedId) ?? null,
    [snapshot.employees, selectedId]
  );
  const pricingCopySources = useMemo(
    () => snapshot.employees.filter((employee) => employee.id !== modalState.employeeId),
    [modalState.employeeId, snapshot.employees]
  );
  const selectedSession = selectedEmployee ? snapshot.sessions[selectedEmployee.id] : null;
  const isSessionActive = selectedSession?.status === "running" || selectedSession?.status === "starting" || selectedSession?.status === "stopping";
  const canStartSession = Boolean(selectedEmployee) && !isSessionActive;
  const canStopSession = Boolean(selectedEmployee) && (selectedSession?.status === "running" || selectedSession?.status === "starting");
  const canEditEmployee = Boolean(selectedEmployee) && !isSessionActive;
  const canRemoveEmployee = Boolean(selectedEmployee) && !isSessionActive;

  const currentSessionMs =
    selectedSession?.startedAt && isSessionActive ? now - new Date(selectedSession.startedAt).getTime() : 0;
  const todayRuntimeMs = (selectedEmployee?.runtimeTodayMs ?? 0) + currentSessionMs;
  const totalRuntimeMs = (selectedEmployee?.runtimeTotalMs ?? 0) + currentSessionMs;
  const managementDisabledReason = isSessionActive ? "运行中的员工请先手动停止会话" : "";
  const hasLiveContext = isLiveTerminalStatus(selectedSession?.status);
  const contextUsage = hasLiveContext ? selectedSession?.metrics?.contextUsagePercent ?? null : 0;
  const contextUsageSource = hasLiveContext ? selectedSession?.metrics?.contextUsageSource ?? "none" : "none";
  const contextMeterWidth = contextUsage ? Math.max(6, contextUsage) : 0;
  const liveSessionCost = isSessionActive && selectedEmployee && selectedSession ? computeSessionCost(selectedEmployee, selectedSession) : null;
  const todayWage = (selectedEmployee?.wageTodayUsd ?? 0) + (liveSessionCost?.totalUsd ?? 0);
  const totalWage = (selectedEmployee?.wageTotalUsd ?? 0) + (liveSessionCost?.totalUsd ?? 0);
  const todayLabel = new Date(now).toLocaleDateString("zh-CN");

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    document.documentElement.dataset.theme = themeId;
    document.body.dataset.theme = themeId;
    document.documentElement.style.colorScheme = activeTheme.colorScheme;

    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, themeId);
    } catch {}
  }, [activeTheme.colorScheme, themeId]);

  useEffect(() => {
    if (!isPreviewMode) return undefined;
    return () => {
      for (const player of browserPreviewPlayers.values()) player.destroy();
      browserPreviewPlayers.clear();
    };
  }, [isPreviewMode]);

  useEffect(() => {
    if (!isShowcaseMode || !selectedId || window.parent === window) return undefined;
    const player = getBrowserPreviewPlayer(selectedId);
    if (!player) return undefined;
    const post = (type, data = {}) => window.parent.postMessage({ type, ...data }, window.location.origin);
    const onPlayback = playback => {
      if (playback.employeeId === selectedId) post("capsule:playback", playback);
    };
    const onCommand = event => {
      if (event.source !== window.parent || event.origin !== window.location.origin || event.data?.type !== "capsule:command") return;
      const { theme, action, playing } = event.data;
      if (ACTIVE_THEME_IDS.has(theme)) setThemeId(theme);
      if (action === "replay") player.replay();
      else if (typeof playing === "boolean") playing ? player.play() : player.pause();
    };
    browserPreviewPlaybackListeners.add(onPlayback);
    window.addEventListener("message", onCommand);
    post("capsule:ready");
    onPlayback({ employeeId: selectedId, ...player.getState() });
    return () => {
      browserPreviewPlaybackListeners.delete(onPlayback);
      window.removeEventListener("message", onCommand);
      player.pause();
    };
  }, [isShowcaseMode, selectedId]);

  useEffect(() => {
    if (isShowcaseMode && window.parent !== window) {
      window.parent.postMessage({ type: "capsule:theme", theme: themeId }, window.location.origin);
    }
  }, [isShowcaseMode, themeId]);

  useEffect(() => {
    if (!message.text) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      setMessage((current) => (current.text === message.text ? { text: "", tone: "info" } : current));
    }, 5000);

    return () => window.clearTimeout(timer);
  }, [message.text]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!modalState.open) {
      return undefined;
    }

    if (selectedEmployee) {
      terminalsRef.current.get(selectedEmployee.id)?.blur?.();
    }

    const frame = window.requestAnimationFrame(() => {
      modalNameInputRef.current?.focus();
      modalNameInputRef.current?.select?.();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [modalState.open, selectedEmployee?.id]);

  useEffect(() => {
    let detachState = null;
    let detachTerminal = null;

    pixelOffice.getState().then((data) => {
      startTransition(() => {
        setSnapshot(data);
        setSelectedId((current) => (current && data.employees.some((item) => item.id === current) ? current : data.employees[0]?.id ?? null));
      });
    });

    detachState = pixelOffice.onStateUpdated((data) => {
      startTransition(() => {
        setSnapshot(data);
        setSelectedId((current) => (current && data.employees.some((item) => item.id === current) ? current : data.employees[0]?.id ?? null));
      });
    });

    detachTerminal = pixelOffice.onTerminalData(({ employeeId, chunk }) => {
      const terminal = terminalsRef.current.get(employeeId);
      if (!terminal) {
        return;
      }

      if (placeholderStateRef.current.get(employeeId)) {
        terminal.reset();
        enableTerminalLineWrap(terminal);
        placeholderStateRef.current.set(employeeId, false);
      }

      if (isTerminalOutputHeld(employeeId, terminal)) {
        queuePendingTerminalChunk(employeeId, chunk);
        return;
      }

      terminal.write(chunk);
    });

    return () => {
      detachState?.();
      detachTerminal?.();
    };
  }, [pixelOffice]);

  useEffect(() => {
    if (selectedId && snapshot.employees.some((item) => item.id === selectedId)) {
      return;
    }
    setSelectedId(snapshot.employees[0]?.id ?? null);
  }, [snapshot.employees, selectedId]);

  useEffect(() => {
    const liveEmployeeIds = new Set(snapshot.employees.map((employee) => employee.id));

    for (const [employeeId, terminal] of terminalsRef.current.entries()) {
      if (liveEmployeeIds.has(employeeId)) {
        continue;
      }

      inputDisposablesRef.current.get(employeeId)?.dispose();
      inputDisposablesRef.current.delete(employeeId);
      terminalDomDisposablesRef.current.get(employeeId)?.dispose();
      terminalDomDisposablesRef.current.delete(employeeId);
      selectionPendingChunksRef.current.delete(employeeId);
      lastTerminalSelectionRef.current.delete(employeeId);
      clearTerminalSelectionGuard(employeeId);
      fitAddonsRef.current.delete(employeeId);
      terminal.dispose();
      terminalsRef.current.delete(employeeId);
      terminalHostsRef.current.delete(employeeId);
      placeholderStateRef.current.delete(employeeId);
      lastViewportRef.current.delete(employeeId);
    }
  }, [snapshot.employees]);

  useEffect(() => {
    for (const employee of snapshot.employees) {
      const status = snapshot.sessions[employee.id]?.status ?? "idle";
      if (!isTerminalPlaceholderStatus(status)) {
        continue;
      }

      if (!terminalsRef.current.has(employee.id) || placeholderStateRef.current.get(employee.id)) {
        continue;
      }

      writeTerminalPlaceholder(employee.id);
    }
  }, [snapshot.employees, snapshot.sessions]);

  useEffect(() => {
    return () => {
      resizeObserverRef.current?.disconnect();

      for (const disposable of inputDisposablesRef.current.values()) {
        disposable.dispose();
      }

      for (const disposable of terminalDomDisposablesRef.current.values()) {
        disposable.dispose();
      }

      for (const terminal of terminalsRef.current.values()) {
        terminal.dispose();
      }

      inputDisposablesRef.current.clear();
      terminalDomDisposablesRef.current.clear();
      selectionPendingChunksRef.current.clear();
      lastTerminalSelectionRef.current.clear();
      for (const guard of terminalSelectionGuardsRef.current.values()) {
        if (guard.flushTimer) {
          window.clearTimeout(guard.flushTimer);
        }
      }
      terminalSelectionGuardsRef.current.clear();
      terminalsRef.current.clear();
      fitAddonsRef.current.clear();
      terminalHostsRef.current.clear();
      placeholderStateRef.current.clear();
      lastViewportRef.current.clear();
    };
  }, []);

  useEffect(() => {
    for (const terminal of terminalsRef.current.values()) {
      terminal.options.theme = activeTheme.terminalTheme;
      terminal.refresh(0, terminal.rows - 1);
    }
  }, [activeTheme]);

  function writeTerminalPlaceholder(employeeId) {
    const terminal = terminalsRef.current.get(employeeId);
    const employee = snapshotRef.current.employees.find((item) => item.id === employeeId);
    if (!terminal) {
      return;
    }

    terminal.reset();
    enableTerminalLineWrap(terminal);
    const previewHistory = snapshotRef.current.sessions[employeeId]?.terminalHistory;
    if (isPreviewMode && previewHistory?.length) {
      placeholderStateRef.current.set(employeeId, false);
      terminal.write(previewHistory.join(""));
      return;
    }
    placeholderStateRef.current.set(employeeId, true);

    if (!employee) {
      terminal.writeln("\u001b[2m请选择一个员工，左侧会显示对应的真实终端会话。\u001b[0m");
      return;
    }

    terminal.writeln(`\u001b[2m当前 Agent「${employee.name}」未启动，请先启动。\u001b[0m`);
    terminal.writeln("\u001b[2m启动后这里会接管对应真实终端，可直接输入命令、粘贴内容，或按 Esc 中断当前等待。\u001b[0m");
  }

  function initializeTerminalSurface(employeeId) {
    const terminal = terminalsRef.current.get(employeeId);
    const employee = snapshotRef.current.employees.find((item) => item.id === employeeId);
    const session = snapshotRef.current.sessions[employeeId];
    if (!terminal) {
      return;
    }

    terminal.reset();
    enableTerminalLineWrap(terminal);
    placeholderStateRef.current.set(employeeId, false);

    if (isPreviewMode && session?.terminalHistory?.length) {
      terminal.write(session.terminalHistory.join(""));
      return;
    }

    if (!employee || !isLiveTerminalStatus(session?.status)) {
      writeTerminalPlaceholder(employeeId);
      return;
    }

    if (isLiveTerminalStatus(session?.status)) {
      placeholderStateRef.current.set(employeeId, true);
      terminal.writeln("\u001b[2m正在同步这个员工的真实终端画面...\u001b[0m");
    }
  }

  function syncTerminalViewport(employeeId) {
    const host = terminalHostsRef.current.get(employeeId);
    const terminal = terminalsRef.current.get(employeeId);
    const fitAddon = fitAddonsRef.current.get(employeeId);
    if (!host || !terminal || !fitAddon) {
      return;
    }

    if (host.clientWidth <= 0 || host.clientHeight <= 0) {
      return;
    }

    fitAddon.fit();
    if (terminal.cols > 40) {
      terminal.resize(terminal.cols - 1, terminal.rows);
    }

    const cols = terminal.cols;
    const rows = terminal.rows;
    if (!cols || !rows) {
      return;
    }

    const lastViewport = lastViewportRef.current.get(employeeId);
    if (lastViewport?.cols === cols && lastViewport?.rows === rows) {
      return;
    }

    lastViewportRef.current.set(employeeId, { cols, rows });
    pixelOffice.resizeSession({ employeeId, cols, rows });
  }

  function getTerminalSelectionGuard(employeeId) {
    let guard = terminalSelectionGuardsRef.current.get(employeeId);
    if (!guard) {
      guard = {
        pointerDown: false,
        selecting: false,
        startX: 0,
        startY: 0,
        holdUntil: 0,
        flushTimer: 0
      };
      terminalSelectionGuardsRef.current.set(employeeId, guard);
    }
    return guard;
  }

  function clearTerminalSelectionGuard(employeeId) {
    const guard = terminalSelectionGuardsRef.current.get(employeeId);
    if (guard?.flushTimer) {
      window.clearTimeout(guard.flushTimer);
    }
    terminalSelectionGuardsRef.current.delete(employeeId);
  }

  function isTerminalOutputHeld(employeeId, terminal) {
    if (terminal?.hasSelection?.()) {
      return true;
    }

    const guard = terminalSelectionGuardsRef.current.get(employeeId);
    return Boolean(guard?.selecting || guard?.holdUntil > Date.now());
  }

  function schedulePendingTerminalFlush(employeeId, delay = 700) {
    const guard = getTerminalSelectionGuard(employeeId);
    if (guard.flushTimer) {
      window.clearTimeout(guard.flushTimer);
    }

    guard.flushTimer = window.setTimeout(() => {
      guard.flushTimer = 0;
      const terminal = terminalsRef.current.get(employeeId);
      if (terminal && isTerminalOutputHeld(employeeId, terminal)) {
        schedulePendingTerminalFlush(employeeId, 700);
        return;
      }

      flushPendingTerminalChunks(employeeId);
    }, delay);
  }

  function flushPendingTerminalChunks(employeeId) {
    const terminal = terminalsRef.current.get(employeeId);
    const pending = selectionPendingChunksRef.current.get(employeeId);
    if (!terminal || !pending?.length || isTerminalOutputHeld(employeeId, terminal)) {
      return;
    }

    selectionPendingChunksRef.current.delete(employeeId);
    terminal.write(pending.join(""));
  }

  function queuePendingTerminalChunk(employeeId, chunk) {
    const pending = selectionPendingChunksRef.current.get(employeeId) ?? [];
    pending.push(chunk);
    while (pending.join("").length > 120000 && pending.length > 1) {
      pending.shift();
    }
    selectionPendingChunksRef.current.set(employeeId, pending);
  }

  function ensureTerminal(employeeId) {
    const host = terminalHostsRef.current.get(employeeId);
    if (!host) {
      return;
    }

    const currentTerminal = terminalsRef.current.get(employeeId);
    if (currentTerminal) {
      const currentHost = currentTerminal.element?.parentElement;
      if (currentHost === host) {
        return;
      }

      inputDisposablesRef.current.get(employeeId)?.dispose();
      inputDisposablesRef.current.delete(employeeId);
      terminalDomDisposablesRef.current.get(employeeId)?.dispose();
      terminalDomDisposablesRef.current.delete(employeeId);
      fitAddonsRef.current.delete(employeeId);
      currentTerminal.dispose();
      terminalsRef.current.delete(employeeId);
      placeholderStateRef.current.delete(employeeId);
      lastViewportRef.current.delete(employeeId);
    }

    const terminal = new Terminal({
      fontFamily: '"Cascadia Mono", "Cascadia Code", "Consolas", monospace',
      fontSize: isShowcaseMode ? 15 : 12,
      fontWeight: "500",
      lineHeight: isShowcaseMode ? 1.35 : 1.12,
      cursorBlink: false,
      allowTransparency: true,
      convertEol: false,
      scrollback: 5000,
      scrollOnUserInput: true,
      windowsPty: { backend: "conpty", buildNumber: 19045 },
      theme: activeTheme.terminalTheme
    });
    const fitAddon = new FitAddon();

    terminal.loadAddon(fitAddon);
    const isTerminalWritable = () => {
      const liveSession = snapshotRef.current.sessions[employeeId];
      const status = liveSession?.status;
      return status === "running" || status === "starting";
    };
    const sendPastedTerminalInput = (value) => {
      const input = String(value ?? "");
      if (!input || !isTerminalWritable()) {
        return;
      }

      pixelOffice.sendRawInput({ employeeId, input: bracketTerminalPaste(input) });
    };
    const pasteClipboardPayload = (payload) => {
      const input = clipboardPayloadToTerminalInput(payload);
      if (!input) {
        return;
      }

      sendPastedTerminalInput(input);
      terminal.focus();
    };
    terminal.attachCustomKeyEventHandler((event) => {
      const commandKey = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      const isMultilineShortcut = event.type === "keydown" && event.shiftKey && !commandKey && !event.altKey && key === "enter";
      const isPasteShortcut =
        event.type === "keydown" &&
        ((commandKey && key === "v") || (!event.metaKey && event.shiftKey && key === "insert"));
      const isCopyShortcut =
        event.type === "keydown" &&
        ((commandKey && key === "c") || (!event.metaKey && event.ctrlKey && key === "insert"));

      if (isMultilineShortcut) {
        if (isTerminalWritable()) {
          pixelOffice.sendRawInput({ employeeId, input: "\\\r" });
        }
        return false;
      }

      if (isPasteShortcut) {
        readClipboardPayload()
          .then(pasteClipboardPayload)
          .catch((error) => setMessage({ text: error.message, tone: "error" }));
        return false;
      }

      if (isCopyShortcut) {
        const cachedSelection = lastTerminalSelectionRef.current.get(employeeId);
        const selection = terminal.getSelection() || cachedSelection?.text || "";
        if (selection) {
          writeClipboardText(selection).catch(() => {});
          setMessage({ text: "已复制终端选区。", tone: "success" });
        } else {
          setMessage({ text: "未检测到选区，已阻止 Ctrl+C 中断会话。需要中断时请点 ESC 或停止。", tone: "info" });
        }
        return false;
      }

      return true;
    });
    terminal.open(host);
    enableTerminalLineWrap(terminal);

    const selectionDisposable = terminal.onSelectionChange(() => {
      const selection = terminal.getSelection();
      if (selection) {
        lastTerminalSelectionRef.current.set(employeeId, { text: selection, updatedAt: Date.now() });
        const guard = getTerminalSelectionGuard(employeeId);
        guard.holdUntil = Date.now() + 1200;
        return;
      }

      if (!terminal.hasSelection()) {
        schedulePendingTerminalFlush(employeeId, 700);
      }
    });
    const selectionGuard = getTerminalSelectionGuard(employeeId);
    const handleSelectionPointerDown = (event) => {
      if (event.button !== 0) {
        return;
      }

      if (selectionGuard.flushTimer) {
        window.clearTimeout(selectionGuard.flushTimer);
        selectionGuard.flushTimer = 0;
      }

      selectionGuard.pointerDown = true;
      selectionGuard.selecting = false;
      selectionGuard.startX = event.clientX;
      selectionGuard.startY = event.clientY;
      selectionGuard.holdUntil = 0;

      if (!terminal.hasSelection()) {
        terminal.focus();
      }
    };
    const handleSelectionPointerMove = (event) => {
      if (!selectionGuard.pointerDown) {
        return;
      }

      const movedX = Math.abs(event.clientX - selectionGuard.startX);
      const movedY = Math.abs(event.clientY - selectionGuard.startY);
      if (movedX < 4 && movedY < 4) {
        return;
      }

      selectionGuard.selecting = true;
      selectionGuard.holdUntil = Date.now() + 1000;
    };
    const finishSelectionGesture = () => {
      if (!selectionGuard.pointerDown && !selectionGuard.selecting) {
        return;
      }

      const wasSelecting = selectionGuard.selecting;
      selectionGuard.pointerDown = false;
      selectionGuard.selecting = false;
      selectionGuard.holdUntil = wasSelecting ? Date.now() + 900 : 0;
      schedulePendingTerminalFlush(employeeId, wasSelecting ? 900 : 0);
    };

    host.addEventListener("pointerdown", handleSelectionPointerDown, { passive: true });
    window.addEventListener("pointermove", handleSelectionPointerMove, { passive: true });
    window.addEventListener("pointerup", finishSelectionGesture, { passive: true });
    window.addEventListener("pointercancel", finishSelectionGesture, { passive: true });
    terminalDomDisposablesRef.current.set(employeeId, {
      dispose: () => {
        selectionDisposable.dispose();
        host.removeEventListener("pointerdown", handleSelectionPointerDown);
        window.removeEventListener("pointermove", handleSelectionPointerMove);
        window.removeEventListener("pointerup", finishSelectionGesture);
        window.removeEventListener("pointercancel", finishSelectionGesture);
        clearTerminalSelectionGuard(employeeId);
      }
    });

    const inputDisposable = terminal.onData((data) => {
      if (!isTerminalWritable()) {
        return;
      }

      pixelOffice.sendRawInput({ employeeId, input: data });
    });

    terminalsRef.current.set(employeeId, terminal);
    fitAddonsRef.current.set(employeeId, fitAddon);
    inputDisposablesRef.current.set(employeeId, inputDisposable);

    initializeTerminalSurface(employeeId);
    requestAnimationFrame(() => syncTerminalViewport(employeeId));
  }

  function registerTerminalHost(employeeId, node) {
    if (!node) {
      return;
    }

    const existingHost = terminalHostsRef.current.get(employeeId);
    const existingTerminal = terminalsRef.current.get(employeeId);
    if (existingHost === node && existingTerminal?.element?.parentElement === node) {
      return;
    }

    terminalHostsRef.current.set(employeeId, node);
    ensureTerminal(employeeId);

    if (selectedEmployee?.id === employeeId) {
      requestAnimationFrame(() => {
        syncTerminalViewport(employeeId);
      });
    }
  }

  useEffect(() => {
    if (!selectedEmployee) {
      resizeObserverRef.current?.disconnect();
      return undefined;
    }

    ensureTerminal(selectedEmployee.id);

    const selectedTerminal = terminalsRef.current.get(selectedEmployee.id);
    if (selectedTerminal && selectedSession?.status === "starting") {
      selectedTerminal.reset();
      enableTerminalLineWrap(selectedTerminal);
      placeholderStateRef.current.set(selectedEmployee.id, false);
    }

    if (
      selectedTerminal &&
      isTerminalPlaceholderStatus(selectedSession?.status ?? "idle") &&
      !placeholderStateRef.current.get(selectedEmployee.id)
    ) {
      writeTerminalPlaceholder(selectedEmployee.id);
    }

    let frame = 0;
    const syncSelectedViewport = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => syncTerminalViewport(selectedEmployee.id));
    };

    resizeObserverRef.current?.disconnect();
    const host = terminalHostsRef.current.get(selectedEmployee.id);
    if (host) {
      resizeObserverRef.current = new ResizeObserver(syncSelectedViewport);
      resizeObserverRef.current.observe(host);
    }

    const handleResize = () => syncSelectedViewport();
    window.addEventListener("resize", handleResize, { passive: true });
    document.fonts?.ready?.then(syncSelectedViewport);
    syncSelectedViewport();

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", handleResize);
      resizeObserverRef.current?.disconnect();
    };
  }, [selectedEmployee?.id, selectedSession?.status, selectedSession?.startedAt]);

  function resetFormForCreate() {
    const defaultPermissionMode = snapshot.config.permissionModes[0]?.id ?? DEFAULT_PERMISSION_MODE;
    setForm(createEmployeeForm(defaultPermissionMode));
  }

  function openCreateModal() {
    resetFormForCreate();
    setModalState({ open: true, mode: "create", employeeId: null });
  }

  function openEditModal() {
    if (!selectedEmployee) {
      return;
    }

    setForm(createEmployeeFormFromRecord(selectedEmployee));
    setModalState({ open: true, mode: "edit", employeeId: selectedEmployee.id });
  }

  function closeModal() {
    setModalState((current) => ({ ...current, open: false, employeeId: null }));
  }

  function applyPricing(nextPricing) {
    setForm((current) => ({ ...current, pricing: normalizePricing(nextPricing) }));
  }

  function handleClearPricing() {
    applyPricing();
  }

  function handleCopyPricing(event) {
    const employee = snapshot.employees.find((item) => item.id === event.target.value);
    event.target.value = "";
    if (!employee) {
      return;
    }

    applyPricing(employee.pricing);
  }

  async function handleChooseExistingFolder() {
    const result = await pixelOffice.chooseDirectory();
    if (result) {
      setForm((current) => ({ ...current, projectPath: result }));
    }
  }

  async function handleOpenProjectDirectory() {
    if (!selectedEmployee?.projectPath) {
      return;
    }

    try {
      await pixelOffice.openProjectDirectory(selectedEmployee.projectPath);
      setMessage({ text: `已打开项目目录：${selectedEmployee.projectPath}`, tone: "info" });
    } catch (error) {
      setMessage({ text: error.message, tone: "error" });
    }
  }

  async function handleRefreshMetrics() {
    if (!selectedEmployee || refreshingMetrics) {
      return;
    }

    setRefreshingMetrics(true);
    try {
      const result = await pixelOffice.refreshSessionMetrics(selectedEmployee.id);
      if (result?.snapshot) {
        startTransition(() => {
          setSnapshot(result.snapshot);
        });
      }

      const contextState = result?.contextUpdated ? "真实" : "缓存";
      const wageState = result?.usageUpdated ? "真实" : "估算";
      setMessage({
        text:
          result?.usageUpdated || result?.contextUpdated
            ? `已更新 ${selectedEmployee.name} 的上下文与工资数据（上下文:${contextState}，计费:${wageState}）。`
            : "没有读到可用的真实值，已保留当前估算。",
        tone: result?.usageUpdated || result?.contextUpdated ? "success" : "info"
      });
    } catch (error) {
      setMessage({ text: error.message, tone: "error" });
    } finally {
      setRefreshingMetrics(false);
    }
  }

  async function handleSubmitEmployee(event) {
    event.preventDefault();
    setMessage({ text: "", tone: "info" });

    const normalizedName = normalizeTextInput(form.name);
    const normalizedSceneTag = normalizeTextInput(form.sceneTag);

    if (!normalizedSceneTag) {
      setMessage({ text: "场景标签必填。", tone: "error" });
      return;
    }

    if (countTextChars(normalizedName) > EMPLOYEE_TEXT_LIMIT || countTextChars(normalizedSceneTag) > EMPLOYEE_TEXT_LIMIT) {
      setMessage({ text: `员工名称和场景标签不能超过 ${EMPLOYEE_TEXT_LIMIT} 个字符。`, tone: "error" });
      return;
    }

    try {
      if (modalState.mode === "edit" && modalState.employeeId) {
        const employee = await pixelOffice.updateEmployee({
          id: modalState.employeeId,
          name: normalizedName,
          sceneTag: normalizedSceneTag,
          agentType: form.agentType,
          permissionMode: form.permissionMode,
          projectPath: form.projectPath,
          pricing: form.pricing
        });
        setSelectedId(employee.id);
        setMessage({ text: `${employee.name} 的资料已更新，历史统计已保留。`, tone: "success" });
      } else {
        const employee = await pixelOffice.createEmployee({
          name: normalizedName,
          sceneTag: normalizedSceneTag,
          agentType: form.agentType,
          permissionMode: form.permissionMode,
          projectPath: form.projectPath,
          pricing: form.pricing
        });
        setSelectedId(employee.id);
        setMessage({ text: `员工 ${employee.name} 已入驻。`, tone: "success" });
      }

      closeModal();
      resetFormForCreate();
    } catch (error) {
      setMessage({ text: error.message, tone: "error" });
    }
  }

  async function handleStartSession() {
    if (!selectedEmployee) {
      return;
    }

    setMessage({ text: "", tone: "info" });
    try {
      await pixelOffice.startSession(selectedEmployee.id);
      setMessage({ text: `${selectedEmployee.name} 会话已发起启动。`, tone: "success" });
    } catch (error) {
      setMessage({ text: error.message, tone: "error" });
    }
  }

  async function handleStopSession() {
    if (!selectedEmployee) {
      return;
    }

    setMessage({ text: "", tone: "info" });
    try {
      await pixelOffice.stopSession(selectedEmployee.id);
      setMessage({ text: `${selectedEmployee.name} 会话已停止。`, tone: "info" });
    } catch (error) {
      setMessage({ text: error.message, tone: "error" });
    }
  }

  async function handleSendEscape() {
    if (!selectedEmployee || !isSessionActive) {
      return;
    }

    try {
      await pixelOffice.sendEscape(selectedEmployee.id);
      setMessage({ text: `已向 ${selectedEmployee.name} 发送 Esc。`, tone: "info" });
    } catch (error) {
      setMessage({ text: error.message, tone: "error" });
    }
  }

  async function handleClearTerminalInput() {
    if (!selectedEmployee || !isSessionActive) {
      return;
    }

    try {
      await pixelOffice.sendRawInput({ employeeId: selectedEmployee.id, input: "\x15" });
      terminalsRef.current.get(selectedEmployee.id)?.focus?.();
      setMessage({ text: "已清空当前终端输入行。", tone: "info" });
    } catch (error) {
      setMessage({ text: error.message, tone: "error" });
    }
  }

  async function handleCopyTerminalSelection() {
    if (!selectedEmployee) {
      return;
    }

    const terminal = terminalsRef.current.get(selectedEmployee.id);
    const selection = terminal?.getSelection?.() || lastTerminalSelectionRef.current.get(selectedEmployee.id)?.text || "";
    if (!selection) {
      setMessage({ text: "当前终端没有选中的内容。", tone: "info" });
      return;
    }

    try {
      await writeClipboardText(selection);
      setMessage({ text: "已复制终端选区。", tone: "success" });
    } catch (error) {
      setMessage({ text: error.message, tone: "error" });
    }
  }

  async function handleRemoveEmployee() {
    if (!selectedEmployee || !canRemoveEmployee) {
      return;
    }

    const confirmed = window.confirm(`确认辞退 ${selectedEmployee.name}？这会清空该员工的历史统计数据。`);
    if (!confirmed) {
      return;
    }

    try {
      await pixelOffice.removeEmployee(selectedEmployee.id);
      setMessage({ text: `${selectedEmployee.name} 已辞退，相关数据已清空。`, tone: "info" });
    } catch (error) {
      setMessage({ text: error.message, tone: "error" });
    }
  }

  return (
    <div className={`app-shell control-console${isShowcaseMode ? " showcase-mode" : ""}`} data-theme={themeId}>
      <header className="control-topbar">
        <div className="control-brand">
          <BrandMark />
          <div className="brand-wordmark" title={APP_NAME_ZH}>
            <strong>CAPSULE <em>OFFICE</em></strong>
            <span>{APP_NAME_ZH} · MULTI-AGENT TERMINAL CONTROL</span>
          </div>
          {isPreviewMode ? <span className="preview-pill">浏览器预览</span> : null}
        </div>

        <div className="control-topbar-actions">
          <div className="theme-switcher" role="group" aria-label="切换界面主题">
            {THEME_ORDER.map((id) => (
              <button
                key={id}
                type="button"
                className={`theme-switch-button ${themeId === id ? "active" : ""}`}
                onClick={() => setThemeId(id)}
                aria-pressed={themeId === id}
              >
                {THEME_DEFINITIONS[id].label}
              </button>
            ))}
          </div>
          <div className="system-clock" aria-label="系统时间">
            <strong>{new Date(now).toLocaleTimeString("zh-CN", { hour12: false })}</strong>
            <span>{todayLabel}</span>
          </div>
        </div>
      </header>

      <main className="control-layout">
        <aside className="operator-sidebar">
          <div className="sidebar-head">
            <span>OPERATOR BAY</span>
            <strong>
              {snapshot.employees.length}/{snapshot.config.maxEmployees} 激活
            </strong>
          </div>

          <div className="operator-list">
            {snapshot.employees.map((employee, index) => {
              const session = snapshot.sessions[employee.id] ?? {};
              const status = session.status ?? "idle";
              const displayStatus = sessionDisplayStatus(session);
              const selected = employee.id === selectedId;
              const visual = AGENT_COPY[employee.agentType] ?? AGENT_COPY["claude-code"];

              return (
                <button
                  key={employee.id}
                  type="button"
                  className={`operator-card ${selected ? "selected" : ""} status-${displayStatus} occupied`}
                  onClick={() => setSelectedId(employee.id)}
                >
                  <span className="operator-accent" aria-hidden="true" />
                  <span className="operator-mainline">
                    <span className="operator-title">
                      <span className="operator-index">{String(index + 1).padStart(2, "0")}</span>
                      <strong>{employee.name}</strong>
                    </span>
                    <i className={`operator-status-dot tone-${visual.accent}`} aria-hidden="true" />
                  </span>
                  <span className="operator-subline">
                    <span>{employee.sceneTag || "未命名"}</span>
                    <em>{STATUS_LABELS[displayStatus] ?? STATUS_LABELS[status] ?? status}</em>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="sidebar-foot">
            <button type="button" className="new-operator-button" onClick={openCreateModal}>
              <span aria-hidden="true">⊞</span>
              新增员工
            </button>
          </div>
        </aside>

        <section className="terminal-workspace">
          <div className="terminal-topline">
            <div className="terminal-title">
              <span aria-hidden="true">›_</span>
              <strong>LIVE TERMINAL</strong>
              <em>/ {selectedEmployee?.name ?? "未选择"}</em>
              <i>PTY</i>
            </div>
            <div className="terminal-actions">
              <button type="button" onClick={handleStopSession} disabled={!canStopSession}>
                停止
              </button>
              <button type="button" onClick={handleSendEscape} disabled={!isSessionActive}>
                ESC
              </button>
              <button type="button" onClick={handleClearTerminalInput} disabled={!isSessionActive}>
                清空输入
              </button>
            </div>
          </div>

          <div className="terminal-stage-frame">
            {!selectedEmployee ? (
              <div className="terminal-stage-empty">
                <strong>先选择一个员工。</strong>
                <span>左侧 Operator Bay 选中员工后，这里会接管对应真实终端。</span>
              </div>
            ) : (
              <div className="terminal-stack">
                {snapshot.employees.map((employee) => (
                  <div key={employee.id} className={`terminal-pane ${employee.id === selectedId ? "active" : ""}`}>
                    <div ref={(node) => registerTerminalHost(employee.id, node)} className="terminal-canvas" />
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <aside className="intel-sidebar">
          <section className="intel-section session-intel">
            <div className="intel-title-row">
              <h2>
                <PanelIcon type="session" />
                SESSION INTEL
              </h2>
              {selectedEmployee ? (
                <span className={`status-pill status-${sessionDisplayStatus(selectedSession)}`}>
                  {STATUS_LABELS[sessionDisplayStatus(selectedSession)] ?? "未知"}
                </span>
              ) : null}
            </div>

            {selectedEmployee ? (
              <>
                <div className="intel-card dossier-card">
                  <div>
                    <span>当前员工</span>
                    <strong>{selectedEmployee.name}</strong>
                  </div>
                  <div>
                    <span>AGENT 类型</span>
                    <strong>{agentLabel(snapshot.config.agentDefinitions, selectedEmployee.agentType)}</strong>
                  </div>
                  <div>
                    <span>权限模式</span>
                    <strong>{permissionLabel(snapshot.config.permissionModes, selectedEmployee.permissionMode)}</strong>
                  </div>
                </div>

                <div className="session-command-grid">
                  <button type="button" className="action-button" onClick={handleStartSession} disabled={!canStartSession}>
                    <CommandIcon type="play" />
                    <span>启动</span>
                  </button>
                  <button type="button" className="ghost-button" onClick={handleStopSession} disabled={!canStopSession}>
                    <CommandIcon type="stop" />
                    <span>停止</span>
                  </button>
                  <button type="button" className="ghost-button" onClick={openEditModal} disabled={!canEditEmployee} title={managementDisabledReason}>
                    <CommandIcon type="edit" />
                    <span>编辑</span>
                  </button>
                  <button
                    type="button"
                    className="ghost-button danger-button"
                    onClick={handleRemoveEmployee}
                    disabled={!canRemoveEmployee}
                    title={managementDisabledReason || "辞退后将清空该员工的历史统计数据"}
                  >
                    <CommandIcon type="remove" />
                    <span>辞退</span>
                  </button>
                </div>

                {selectedSession?.errorMessage ? (
                  <div className="session-alert" role="alert">
                    {selectedSession.errorMessage}
                  </div>
                ) : null}
              </>
            ) : (
              <p className="empty-state-copy">先从左侧选择一个员工。</p>
            )}
          </section>

          <section className="intel-section">
            <div className="intel-title-row">
              <h2>
                <PanelIcon type="context" />
                CONTEXT PRESSURE
              </h2>
              <div className="metric-title-actions">
                <span className={`source-pill source-${contextUsageSource}`}>
                  {metricSourceLabel(contextUsageSource)}
                </span>
                <button
                  type="button"
                  className="metric-refresh-button"
                  onClick={handleRefreshMetrics}
                  disabled={!selectedEmployee || refreshingMetrics}
                  title="只读取本地状态快照，不会把命令写进当前会话"
                >
                  {refreshingMetrics ? "更新中" : "更新"}
                </button>
              </div>
            </div>
            <div className="intel-card context-card">
              <div className="context-pressure-readout">
                <strong>{contextUsage !== null ? `${contextUsage}%` : "暂无数据"}</strong>
                <span>{contextRiskCopy(contextUsage, hasLiveContext)}</span>
              </div>
              <div className="meter-track">
                <div className="meter-fill" style={{ width: `${contextMeterWidth}%` }} />
              </div>
            </div>
          </section>

          <section className="intel-section">
            <div className="intel-title-row">
              <h2>
                <PanelIcon type="runtime" />
                RUNTIME & COSTS
              </h2>
              <button
                type="button"
                className="metric-refresh-button"
                onClick={handleRefreshMetrics}
                disabled={!selectedEmployee || refreshingMetrics}
                title="只读取本地状态快照，不会把命令写进当前会话"
              >
                {refreshingMetrics ? "更新中" : "更新"}
              </button>
            </div>
            <div className="metric-tile-grid">
              <MetricTile label="今日工时" value={formatDuration(todayRuntimeMs)} source="real" />
              <MetricTile label="今日工资" value={formatUsd(todayWage)} source={liveSessionCost?.source ?? selectedEmployee?.wageSource ?? "none"} />
              <MetricTile label="历史工时" value={formatDuration(totalRuntimeMs)} source="real" />
              <MetricTile label="历史工资" value={formatUsd(totalWage)} source={selectedEmployee?.wageSource ?? "estimated"} />
            </div>
          </section>

          <section className="intel-section artifacts-section">
            <div className="intel-title-row">
              <h2>
                <PanelIcon type="artifacts" />
                PROJECT ARTIFACTS
              </h2>
              <button type="button" className="inline-link-button" onClick={handleOpenProjectDirectory} disabled={!selectedEmployee?.projectPath}>
                打开
              </button>
            </div>
            <div className="path-stack">
              <div>
                <span>项目目录</span>
                <strong title={selectedEmployee?.projectPath || "暂无"}>{selectedEmployee?.projectPath || "暂无"}</strong>
              </div>
              <div>
                <span>CLI 路径</span>
                <strong title={selectedSession?.cliPath || "尚未检测"}>{selectedSession?.cliPath || "尚未检测"}</strong>
              </div>
            </div>
          </section>
        </aside>
      </main>

      {modalState.open ? (
        <div className="modal-backdrop" role="presentation">
          <section className="modal-card panel-shell" role="dialog" aria-modal="true">
            <div className="panel-title-row">
              <div>
                <SectionTitle
                  en={modalState.mode === "edit" ? "EMPLOYEE EDITOR" : "RECRUITMENT"}
                  zh={modalState.mode === "edit" ? "编辑员工" : "新增员工"}
                  as="h3"
                  compact
                />
              </div>
              <button type="button" className="ghost-button compact" onClick={closeModal}>
                关闭
              </button>
            </div>

            <form className="stack-form" onSubmit={handleSubmitEmployee}>
              <label>
                <span>员工名称</span>
                <input
                  ref={modalNameInputRef}
                  value={form.name}
                  maxLength={EMPLOYEE_TEXT_LIMIT}
                  onChange={(event) => setForm((current) => ({ ...current, name: limitTextInput(event.target.value) }))}
                  placeholder="例如：卡东、内容中台、AIGC 助手"
                />
                <em className="field-hint">{countTextChars(form.name)}/{EMPLOYEE_TEXT_LIMIT}</em>
              </label>

              <label>
                <span>场景标签</span>
                <input
                  value={form.sceneTag}
                  maxLength={EMPLOYEE_TEXT_LIMIT}
                  onChange={(event) => setForm((current) => ({ ...current, sceneTag: limitTextInput(event.target.value) }))}
                  placeholder="必填，例如：推文创作、产品经理、每日热点"
                />
                <em className="field-hint">{countTextChars(form.sceneTag)}/{EMPLOYEE_TEXT_LIMIT}</em>
              </label>

              <label>
                <span>Agent 类型</span>
                <select
                  value={form.agentType}
                  onChange={(event) => setForm((current) => ({ ...current, agentType: event.target.value }))}
                >
                  <option value="claude-code">Claude Code</option>
                  <option value="codex-cli">Codex CLI</option>
                </select>
              </label>

              <label>
                <span>权限模式</span>
                <select
                  value={form.permissionMode}
                  onChange={(event) => setForm((current) => ({ ...current, permissionMode: event.target.value }))}
                >
                  {snapshot.config.permissionModes.map((mode) => (
                    <option key={mode.id} value={mode.id}>
                      {mode.label}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span>绑定项目目录</span>
                <div className="inline-row">
                  <input value={form.projectPath} readOnly placeholder="选择项目目录" />
                  <button type="button" className="ghost-button compact" onClick={handleChooseExistingFolder}>
                    选择
                  </button>
                </div>
              </label>

              <details className="pricing-disclosure" open={modalState.mode === "create"}>
                <summary>价格配置</summary>
                <div className="pricing-toolbar">
                  <select value="" onChange={handleCopyPricing} aria-label="复制员工价格配置" disabled={!pricingCopySources.length}>
                    <option value="">复制员工</option>
                    {pricingCopySources.map((employee) => (
                      <option key={employee.id} value={employee.id}>
                        {employee.name} · {agentLabel(snapshot.config.agentDefinitions, employee.agentType)}
                      </option>
                    ))}
                  </select>
                  <div className="pricing-toolbar-actions">
                    <button type="button" className="ghost-button compact" onClick={handleClearPricing}>
                      清空
                    </button>
                  </div>
                </div>
                <div className="pricing-grid">
                  <label>
                    <span>输入 / 1M tokens</span>
                    <input
                      type="number"
                      step="0.0001"
                      value={form.pricing.inputPricePer1M}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          pricing: { ...current.pricing, inputPricePer1M: event.target.value }
                        }))
                      }
                    />
                  </label>
                  <label>
                    <span>补全 / 1M tokens</span>
                    <input
                      type="number"
                      step="0.0001"
                      value={form.pricing.outputPricePer1M}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          pricing: { ...current.pricing, outputPricePer1M: event.target.value }
                        }))
                      }
                    />
                  </label>
                  <label>
                    <span>缓存读取 / 1M</span>
                    <input
                      type="number"
                      step="0.0001"
                      value={form.pricing.cacheReadPricePer1M}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          pricing: { ...current.pricing, cacheReadPricePer1M: event.target.value }
                        }))
                      }
                    />
                  </label>
                  <label>
                    <span>缓存创建 / 1M</span>
                    <input
                      type="number"
                      step="0.0001"
                      value={form.pricing.cacheWritePricePer1M}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          pricing: { ...current.pricing, cacheWritePricePer1M: event.target.value }
                        }))
                      }
                    />
                  </label>
                </div>
              </details>

              <p className="helper-copy">
                {modalState.mode === "edit"
                  ? "编辑不会清空该员工已累计的工资和工时。运行中的员工请先停止后再编辑。"
                  : "场景标签必填。价格按每 1M tokens 计费；没有的项目可填 `0`。"}
              </p>

              <button
                type="submit"
                className="action-button"
                disabled={!form.projectPath || (modalState.mode === "create" && snapshot.employees.length >= snapshot.config.maxEmployees)}
              >
                {modalState.mode === "edit" ? "保存修改" : "接入胶囊舱"}
              </button>
            </form>
          </section>
        </div>
      ) : null}

      {message.text ? (
        <button
          type="button"
          className={`toast toast-${message.tone}`}
          onClick={() => setMessage({ text: "", tone: "info" })}
          title="点击立即关闭"
        >
          {message.text}
        </button>
      ) : null}
    </div>
  );
}
