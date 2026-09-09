export function createPreviewPlayback({
  frames,
  onFrame,
  onState = () => {},
  schedule = setTimeout,
  cancel = clearTimeout,
}) {
  let index = 0;
  let timer = null;
  let playing = false;
  let disposed = false;
  const getState = () => ({
    playing,
    completed: index === frames.length,
    stage: frames[Math.max(0, index - 1)]?.stage ?? "演示就绪",
    progress: frames.length ? Math.round((index / frames.length) * 100) : 100,
  });
  function advance() {
    timer = null;
    if (!playing || disposed) return;
    const frame = frames[index++];
    if (frame) onFrame(frame);
    if (index >= frames.length) playing = false;
    onState(getState());
    if (playing) timer = schedule(advance, frame.delay ?? 1000);
  }
  function pause() {
    if (disposed) return;
    playing = false;
    if (timer !== null) cancel(timer);
    timer = null;
    onState(getState());
  }
  function play() {
    if (disposed || playing || !frames.length) return;
    if (index >= frames.length) index = 0;
    playing = true;
    advance();
  }
  function replay() {
    if (disposed) return;
    pause();
    index = 0;
    play();
  }
  function destroy() {
    pause();
    disposed = true;
  }
  return { play, pause, replay, destroy, getState };
}
