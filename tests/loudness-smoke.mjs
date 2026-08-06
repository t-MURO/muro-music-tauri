import assert from "node:assert/strict";
import {
  dbToLinear,
  measureLoudness,
  replayGainFromLoudness,
} from "../src/lib/loudness/r128.ts";
import { resolveGainFactor } from "../src/utils/replayGain.ts";

const SAMPLE_RATE = 48_000;

/** Stereo sine at a given dBFS level, identical in both channels. */
const stereoSine = (dbfs, seconds = 20, frequency = 1000, sampleRate = SAMPLE_RATE) => {
  const amplitude = Math.pow(10, dbfs / 20);
  const length = Math.round(seconds * sampleRate);
  const left = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    left[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  }
  return [left, Float32Array.from(left)];
};

const closeTo = (actual, expected, tolerance, message) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message} (expected ${expected} ± ${tolerance}, got ${actual})`,
  );
};

// --- EBU Tech 3341 compliance cases -----------------------------------------
// A 1 kHz stereo sine must measure at its own dBFS level in LUFS. This is what
// calibrates the -0.691 offset against the K-weighting gain at 1 kHz, so it
// fails loudly if either the filter coefficients or the offset are wrong.
{
  const minus20 = measureLoudness(stereoSine(-20), SAMPLE_RATE);
  closeTo(minus20.integratedLufs, -20, 0.1, "1 kHz stereo sine at -20 dBFS reads -20 LUFS");

  const minus26 = measureLoudness(stereoSine(-26), SAMPLE_RATE);
  closeTo(minus26.integratedLufs, -26, 0.1, "1 kHz stereo sine at -26 dBFS reads -26 LUFS");

  const minus40 = measureLoudness(stereoSine(-40), SAMPLE_RATE);
  closeTo(minus40.integratedLufs, -40, 0.1, "1 kHz stereo sine at -40 dBFS reads -40 LUFS");
}

// The filters are re-derived per sample rate, so 44.1 kHz must agree with 48.
{
  const at44 = measureLoudness(stereoSine(-20, 20, 1000, 44_100), 44_100);
  closeTo(at44.integratedLufs, -20, 0.1, "the measurement is sample-rate independent");
}

// Sample peak is reported in linear scale, independent of the loudness gating.
{
  const result = measureLoudness(stereoSine(-6), SAMPLE_RATE);
  closeTo(result.samplePeak, dbToLinear(-6), 0.001, "sample peak matches the source amplitude");
}

// --- Gating ------------------------------------------------------------------
{
  // Digital silence has no measurable loudness at all.
  const silence = [new Float32Array(SAMPLE_RATE * 5), new Float32Array(SAMPLE_RATE * 5)];
  const result = measureLoudness(silence, SAMPLE_RATE);
  assert.equal(result.integratedLufs, null, "silence has no integrated loudness");
  assert.equal(result.samplePeak, 0, "silence has no peak");
}

{
  // A loud passage padded with silence must measure close to the loud passage:
  // the -70 LUFS absolute gate and the -10 LU relative gate drop the silence
  // instead of averaging it in.
  const tone = stereoSine(-20, 10);
  const padLength = SAMPLE_RATE * 10;
  const channels = tone.map((channel) => {
    const padded = new Float32Array(channel.length + padLength);
    padded.set(channel, 0);
    return padded;
  });
  const result = measureLoudness(channels, SAMPLE_RATE);
  closeTo(result.integratedLufs, -20, 0.5, "trailing silence is gated out");
}

{
  // Shorter than one 400 ms gating block: BS.1770 defines no integrated value.
  const short = stereoSine(-20, 0.1);
  const result = measureLoudness(short, SAMPLE_RATE);
  assert.equal(result.integratedLufs, null, "a clip shorter than one block has no value");
}

// --- ReplayGain derivation ---------------------------------------------------
{
  assert.equal(replayGainFromLoudness(-18, -18), 0, "material at the reference needs no change");
  assert.equal(replayGainFromLoudness(-8, -18), -10, "loud material is attenuated");
  assert.equal(replayGainFromLoudness(-23, -18), 5, "quiet material is boosted");
  closeTo(dbToLinear(-6), 0.5011, 0.001, "dB converts to a linear multiplier");
}

// --- Playback gain resolution ------------------------------------------------
{
  const base = { mode: "track", preampDb: 0, preventClipping: false };

  assert.equal(
    resolveGainFactor({ replayGainTrackDb: -6 }, { ...base, mode: "off" }),
    1,
    "the off mode never changes the level",
  );

  closeTo(
    resolveGainFactor({ replayGainTrackDb: -6 }, base),
    dbToLinear(-6),
    0.001,
    "track mode applies the track gain",
  );

  assert.equal(
    resolveGainFactor({}, base),
    1,
    "a track without a gain value plays untouched",
  );

  closeTo(
    resolveGainFactor(
      { replayGainTrackDb: -6, replayGainAlbumDb: -9 },
      { ...base, mode: "album" },
    ),
    dbToLinear(-9),
    0.001,
    "album mode prefers the album gain",
  );

  closeTo(
    resolveGainFactor({ replayGainTrackDb: -6 }, { ...base, mode: "album" }),
    dbToLinear(-6),
    0.001,
    "album mode falls back to the track gain when the release was not scanned",
  );

  closeTo(
    resolveGainFactor({ replayGainTrackDb: -6 }, { ...base, preampDb: -3 }),
    dbToLinear(-9),
    0.001,
    "the pre-amp is added to the stored gain",
  );

  // Clipping guard: a +6 dB boost on a track already peaking at 0.9 would
  // exceed full scale, so the gain is held to 1/peak.
  closeTo(
    resolveGainFactor(
      { replayGainTrackDb: 6, replayGainTrackPeak: 0.9 },
      { ...base, preventClipping: true },
    ),
    1 / 0.9,
    0.001,
    "the clipping guard holds the gain back",
  );

  closeTo(
    resolveGainFactor({ replayGainTrackDb: 12 }, base),
    dbToLinear(12),
    0.001,
    "positive gain is preserved for the Web Audio output stage",
  );
}

console.log("loudness-smoke: all assertions passed");
