const themes = {
  midnight: { name: "黑夜", label: "黑夜 / MIDNIGHT" },
  daylight: { name: "白昼", label: "白昼 / DAYLIGHT" },
  wood: { name: "木质", label: "木质 / WOOD" },
};

const preview = document.querySelector("#product-preview");
const label = document.querySelector("#preview-label");
const themeButtons = document.querySelectorAll("[data-theme]");
const viewport = document.querySelector(".preview-viewport");
const toggle = document.querySelector("#toggle-playback");
const replay = document.querySelector("#replay-preview");
const stage = document.querySelector("#playback-stage");
const progress = document.querySelector("#playback-progress");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let themeId = "midnight";
let ready = false;
let inView = false;
let wantsPlayback = !reducedMotion.matches;
let playback = {
  playing: false,
  completed: false,
  stage: "准备就绪",
  progress: 0,
};

function send(command) {
  if (ready)
    preview.contentWindow.postMessage(
      { type: "capsule:command", ...command },
      window.location.origin,
    );
}

function setTheme(id) {
  const theme = themes[id];
  if (!theme) return;
  themeId = id;
  label.textContent = theme.label;
  for (const item of themeButtons)
    item.setAttribute("aria-pressed", String(item.dataset.theme === id));
}

function syncPlayback() {
  send({
    theme: themeId,
    playing: wantsPlayback && inView && !document.hidden && !playback.completed,
  });
}

function renderPlayback() {
  toggle.disabled = replay.disabled = !ready;
  toggle.textContent = playback.completed
    ? "再次播放"
    : playback.playing
      ? "暂停演示"
      : "播放演示";
  stage.textContent = `模拟会话 · ${playback.stage}${!playback.playing && !playback.completed ? " · 已暂停" : ""}`;
  progress.style.width = `${Math.min(100, Math.max(0, playback.progress))}%`;
}

window.addEventListener("message", (event) => {
  if (
    event.source !== preview.contentWindow ||
    event.origin !== window.location.origin
  )
    return;
  if (event.data?.type === "capsule:ready") {
    ready = true;
    playback = { ...playback, completed: false };
    syncPlayback();
    renderPlayback();
  } else if (event.data?.type === "capsule:playback") {
    playback = event.data;
    renderPlayback();
  } else if (event.data?.type === "capsule:theme") {
    setTheme(event.data.theme);
  }
});

const resize = new ResizeObserver(() => {
  const width = viewport.clientWidth;
  const logicalWidth = width < 640 ? Math.max(480, width) : 1440;
  const logicalHeight = width < 640 ? 680 : 860;
  const scale = width / logicalWidth;
  preview.style.width = `${logicalWidth}px`;
  preview.style.height = `${logicalHeight}px`;
  preview.style.transform = `scale(${scale})`;
  viewport.style.height = `${logicalHeight * scale}px`;
});
resize.observe(viewport);

const visibility = new IntersectionObserver(
  (entries) => {
    inView = entries[0].isIntersecting;
    syncPlayback();
  },
  { threshold: 0.15 },
);
visibility.observe(viewport);
document.addEventListener("visibilitychange", syncPlayback);
reducedMotion.addEventListener("change", (event) => {
  if (event.matches) {
    wantsPlayback = false;
    syncPlayback();
  }
});

toggle.addEventListener("click", () => {
  if (playback.completed) {
    wantsPlayback = true;
    send({ action: "replay" });
  } else {
    wantsPlayback = !playback.playing;
    syncPlayback();
  }
});
replay.addEventListener("click", () => {
  wantsPlayback = true;
  send({ action: "replay" });
});

for (const button of themeButtons) {
  button.addEventListener("click", () => {
    const id = button.dataset.theme;
    setTheme(id);
    send({ theme: id });
  });
}

const copyButton = document.querySelector("#copy-commands");
const copyStatus = document.querySelector("#copy-status");
if (navigator.clipboard?.writeText) {
  copyButton.hidden = false;
  copyButton.addEventListener("click", async () => {
    copyButton.disabled = true;
    try {
      await navigator.clipboard.writeText(
        document.querySelector("#install-commands").textContent.trim(),
      );
      copyStatus.textContent = "命令已复制，在本地终端中粘贴即可。";
    } catch {
      copyStatus.textContent = "未能访问剪贴板，请手动选择并复制上方命令。";
    } finally {
      copyButton.disabled = false;
    }
  });
}
