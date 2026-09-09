const ansi = (code, text) => `\x1b[${code}m${text}\x1b[0m`;
const green = (text) => ansi("32", text);
const blue = (text) => ansi("34", text);
const bold = (text) => ansi("1", text);

export function createPreviewFrames(agentType = "claude-code") {
  const codex = agentType === "codex-cli";
  const name = codex ? "Codex CLI" : "Claude Code";
  const prompt = codex
    ? "检查任务筛选的边界情况，并运行测试。"
    : "给任务列表加上状态筛选，并补充测试。";
  const frames = [
    {
      reset: true,
      text: `${blue("╭──────────────────────────────────────────╮")}\r\n${bold(`  ${name}  /  capsule-office`)}\r\n  ~/projects/taskboard  ·  main\r\n${blue("╰──────────────────────────────────────────╯")}\r\n\r\n  模拟操作回放 · 不会执行真实命令\r\n\r\n${green("❯ ")}`,
      delay: 700,
      stage: "输入任务",
      context: 12,
    },
  ];
  for (const character of prompt)
    frames.push({ text: character, delay: 65, stage: "输入任务" });
  frames.push(
    { text: "\r\n\r\n", delay: 350, stage: "读取项目" },
    {
      text: `${green("●")} 我会先查看组件结构与现有测试。\r\n\r\n`,
      delay: 1100,
      stage: "读取项目",
      context: 18,
    },
    {
      text: `${bold("  Read")}  src/components/TaskList.jsx\r\n  └ 读取 128 行，找到任务列表与状态字段。\r\n\r\n`,
      delay: 1300,
      stage: "读取项目",
    },
    {
      text: `${bold("  Read")}  tests/task-filter.test.js\r\n  └ 已有用例覆盖全部任务与空列表。\r\n\r\n`,
      delay: 1200,
      stage: "读取项目",
      context: 24,
    },
    {
      text: `${bold("  Update")}  ${codex ? "tests/task-filter.test.js" : "src/components/TaskList.jsx"}\r\n`,
      delay: 550,
      stage: "修改代码",
    },
    {
      text:
        blue(
          codex
            ? '  + expect(filterTasks([], "done"))\r\n  +   .toEqual([]);'
            : "  + const visible = tasks.filter(\r\n  +   matchesStatus\r\n  + );",
        ) + "\r\n",
      delay: 550,
      stage: "修改代码",
    },
    {
      text:
        blue(
          codex
            ? "  + expect(tasks).toEqual(originalTasks);"
            : "  + <StatusFilter value={status}\r\n  +   onChange={setStatus} />",
        ) + "\r\n\r\n",
      delay: 1200,
      stage: "修改代码",
      context: 31,
    },
    {
      text: `${bold("  Test")}  npm run test:unit\r\n`,
      delay: 1500,
      stage: "运行测试",
    },
    {
      text: green("  ✓ 全部任务、进行中、已完成筛选") + "\r\n",
      delay: 650,
      stage: "运行测试",
    },
    {
      text: green("  ✓ 空列表与无匹配结果") + "\r\n",
      delay: 650,
      stage: "运行测试",
    },
    {
      text: green("  ✓ 切换筛选后保留原始任务数据") + "\r\n\r\n",
      delay: 650,
      stage: "运行测试",
    },
    {
      text: `  Tests  ${green("12 passed")}  ·  ${blue("0 failed")}\r\n\r\n`,
      delay: 1200,
      stage: "运行测试",
      context: 38,
    },
    {
      text: `${green("● 完成")} ${codex ? "边界测试已补充，任务筛选验证通过。" : "状态筛选已添加，边界用例通过。"}\r\n  ${blue("2 files changed")}  ·  +34 / -6\r\n\r\n${green("❯ ")}等待下一项任务`,
      delay: 0,
      stage: "任务完成",
      context: 38,
    },
  );
  return frames;
}

export function previewTranscript(agentType) {
  return createPreviewFrames(agentType)
    .map((frame) => frame.text)
    .join("");
}
