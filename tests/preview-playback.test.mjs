import assert from "node:assert/strict";
import test from "node:test";
import { createPreviewPlayback } from "../src/preview-playback.mjs";

function setup() {
  const pending = new Map();
  let sequence = 0;
  const output = [];
  const states = [];
  const player = createPreviewPlayback({
    frames: [
      { text: "task", delay: 10, stage: "输入任务" },
      { text: "tool", delay: 10, stage: "执行步骤" },
      { text: "done", delay: 10, stage: "任务完成" },
    ],
    onFrame: (frame) => output.push(frame.text),
    onState: (state) => states.push(state),
    schedule: (callback) => {
      pending.set(++sequence, callback);
      return sequence;
    },
    cancel: (id) => pending.delete(id),
  });
  const tick = () => {
    const callbacks = [...pending.values()];
    pending.clear();
    callbacks.forEach((callback) => callback());
  };
  return { player, output, states, pending, tick };
}

test("play emits progress; pause holds output; resume completes without duplicates", () => {
  const { player, output, states, pending, tick } = setup();
  player.play();
  player.play();
  assert.deepEqual(output, ["task"]);
  assert.equal(pending.size, 1);
  player.pause();
  tick();
  assert.deepEqual(output, ["task"]);
  player.play();
  tick();
  tick();
  assert.deepEqual(output, ["task", "tool", "done"]);
  assert.equal(states.at(-1).completed, true);
  assert.equal(states.at(-1).playing, false);
});

test("replay starts over with one timer; destroying stops every future frame", () => {
  const { player, output, pending, tick } = setup();
  player.play();
  tick();
  player.replay();
  assert.deepEqual(output, ["task", "tool", "task"]);
  assert.equal(pending.size, 1);
  player.destroy();
  tick();
  player.play();
  player.replay();
  assert.deepEqual(output, ["task", "tool", "task"]);
  assert.equal(pending.size, 0);
});
