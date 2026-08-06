import assert from "node:assert/strict";
import { playWithTimeout, retryMediaLoadOnce } from "../src/desktop/mediaPlayback.ts";

{
  let attempts = 0;
  let resets = 0;
  const result = await retryMediaLoadOnce(
    async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient media error");
      return "loaded";
    },
    () => { resets += 1; },
  );
  assert.equal(result, "loaded");
  assert.equal(attempts, 2);
  assert.equal(resets, 1);
}

{
  let attempts = 0;
  await assert.rejects(
    retryMediaLoadOnce(
      async () => {
        attempts += 1;
        throw new Error(`media error ${attempts}`);
      },
      () => undefined,
    ),
    /media error 2/,
  );
  assert.equal(attempts, 2);
}

{
  let paused = 0;
  await playWithTimeout({
    play: async () => undefined,
    pause: () => { paused += 1; },
  }, 50);
  assert.equal(paused, 0);
}

{
  let paused = 0;
  await assert.rejects(
    playWithTimeout({
      play: () => new Promise(() => undefined),
      pause: () => { paused += 1; },
    }, 20, "Smoke playback"),
    /Smoke playback timed out/,
  );
  assert.equal(paused, 1);
}

{
  let paused = 0;
  await assert.rejects(
    playWithTimeout({
      play: async () => { throw new Error("decode failed"); },
      pause: () => { paused += 1; },
    }, 50),
    /decode failed/,
  );
  assert.equal(paused, 1);
}

console.log("Playback guard smoke test passed.");
