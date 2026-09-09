const themes = {
  midnight: { name: "黑夜", label: "黑夜 / MIDNIGHT" },
  daylight: { name: "白昼", label: "白昼 / DAYLIGHT" },
  wood: { name: "木质", label: "木质 / WOOD" },
};

const preview = document.querySelector("#product-preview");
const label = document.querySelector("#preview-label");
const themeButtons = document.querySelectorAll("[data-theme]");

for (const button of themeButtons) {
  button.addEventListener("click", () => {
    const id = button.dataset.theme;
    const theme = themes[id];
    if (!theme) return;
    preview.src = `./assets/preview-${id}.jpg`;
    preview.alt = `胶囊办公室${theme.name}主题界面：左侧员工列表、中间终端、右侧会话状态与用量`;
    label.textContent = theme.label;
    for (const item of themeButtons) {
      item.setAttribute("aria-pressed", String(item === button));
    }
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
