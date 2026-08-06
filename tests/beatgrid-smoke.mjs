import assert from "node:assert/strict";
import { analyzeBeatGrid } from "../src/lib/beatgrid/dsp.ts";

const SAMPLE_RATE = 11025;
const DURATION_SEC = 40;

// Synthesized click/kick track: a 60 Hz decaying-sine kick (80 ms) plus a
// short click transient on every beat; beat 0 of each 4-beat bar is accented
// with +6 dB and extra low-frequency content.
const synthesizeClickTrack = ({ bpm, firstBeatSec, durationSec = DURATION_SEC }) => {
  const total = Math.floor(durationSec * SAMPLE_RATE);
  const samples = new Float32Array(total);
  const beatSec = 60 / bpm;
  for (let beat = 0; ; beat += 1) {
    const beatTime = firstBeatSec + beat * beatSec;
    if (beatTime >= durationSec - 0.12) break;
    const accent = beat % 4 === 0;
    const amplitude = accent ? 1 : 0.5; // accent = +6 dB
    const start = Math.round(beatTime * SAMPLE_RATE);
    const kickLength = Math.round(0.08 * SAMPLE_RATE);
    for (let i = 0; i < kickLength && start + i < total; i += 1) {
      const t = i / SAMPLE_RATE;
      const decay = Math.exp(-t / 0.02);
      samples[start + i] += amplitude * decay * Math.sin(2 * Math.PI * 60 * t);
      if (accent) {
        samples[start + i] += 0.7 * amplitude * decay * Math.sin(2 * Math.PI * 50 * t);
      }
    }
    const clickLength = Math.round(0.005 * SAMPLE_RATE);
    for (let i = 0; i < clickLength && start + i < total; i += 1) {
      const t = i / SAMPLE_RATE;
      samples[start + i] += amplitude * Math.exp(-t / 0.0015) * Math.sin(2 * Math.PI * 3000 * t);
    }
  }
  return samples;
};

// Sectioned track: every `sectionBars` the arrangement swaps timbre, the way an
// intro gives way to a drop. This is what phrase detection actually keys on —
// a change in what the music *sounds like*, not a louder bar.
const synthesizeSectionedTrack = ({ bpm, firstBeatSec, durationSec, sectionBars, offset = 0 }) => {
  const total = Math.floor(durationSec * SAMPLE_RATE);
  const samples = new Float32Array(total);
  const beatSec = 60 / bpm;
  for (let beat = 0; ; beat += 1) {
    const beatTime = firstBeatSec + beat * beatSec;
    if (beatTime >= durationSec - 0.2) break;
    const bar = Math.floor(beat / 4);
    const section = sectionBars > 0 ? Math.floor(Math.max(0, bar - offset) / sectionBars) : 0;
    const hasBass = sectionBars === 0 ? true : section % 2 === 1;
    const hasHats = sectionBars === 0 ? true : section % 2 === 0;
    const accent = beat % 4 === 0;
    const amplitude = accent ? 1 : 0.5;
    const start = Math.round(beatTime * SAMPLE_RATE);

    const kickLength = Math.round(0.08 * SAMPLE_RATE);
    for (let i = 0; i < kickLength && start + i < total; i += 1) {
      const t = i / SAMPLE_RATE;
      const decay = Math.exp(-t / 0.02);
      samples[start + i] += amplitude * decay * Math.sin(2 * Math.PI * 60 * t);
      if (hasBass) samples[start + i] += 0.8 * amplitude * decay * Math.sin(2 * Math.PI * 45 * t);
    }
    if (hasHats) {
      const hatLength = Math.round(0.03 * SAMPLE_RATE);
      let noise = 0;
      for (let i = 0; i < hatLength && start + i < total; i += 1) {
        const t = i / SAMPLE_RATE;
        // Deterministic pseudo-noise; tests must not depend on Math.random.
        noise = Math.sin(noise * 12.9898 + i * 78.233) * 43758.5453;
        samples[start + i] += 0.35 * Math.exp(-t / 0.008) * (noise - Math.floor(noise) - 0.5);
      }
    }
    const padLength = Math.round(beatSec * SAMPLE_RATE);
    for (let i = 0; i < padLength && start + i < total; i += 1) {
      const t = i / SAMPLE_RATE;
      samples[start + i] += 0.12 * Math.sin(2 * Math.PI * (hasBass ? 220 : 330) * t);
    }
  }
  return samples;
};

// Quiet intro, full body, quiet outro — the shape the planner needs in order to
// mix out where a track stops being the main event.
const synthesizeArrangedTrack = ({ bpm, firstBeatSec, durationSec, introBars, outroBars }) => {
  const total = Math.floor(durationSec * SAMPLE_RATE);
  const samples = new Float32Array(total);
  const beatSec = 60 / bpm;
  const totalBars = Math.floor((durationSec - firstBeatSec) / (4 * beatSec));
  for (let beat = 0; ; beat += 1) {
    const beatTime = firstBeatSec + beat * beatSec;
    if (beatTime >= durationSec - 0.2) break;
    const bar = Math.floor(beat / 4);
    const full = bar >= introBars && bar < totalBars - outroBars;
    const accent = beat % 4 === 0;
    const amplitude = accent ? 1 : 0.5;
    const start = Math.round(beatTime * SAMPLE_RATE);

    const kickLength = Math.round(0.08 * SAMPLE_RATE);
    for (let i = 0; i < kickLength && start + i < total; i += 1) {
      const t = i / SAMPLE_RATE;
      const decay = Math.exp(-t / 0.02);
      samples[start + i] += amplitude * decay * Math.sin(2 * Math.PI * 60 * t) * (full ? 1 : 0.55);
      if (full) samples[start + i] += 0.8 * amplitude * decay * Math.sin(2 * Math.PI * 45 * t);
    }
    if (full) {
      const hatLength = Math.round(0.03 * SAMPLE_RATE);
      let noise = 0;
      for (let i = 0; i < hatLength && start + i < total; i += 1) {
        const t = i / SAMPLE_RATE;
        noise = Math.sin(noise * 12.9898 + i * 78.233) * 43758.5453;
        samples[start + i] += 0.35 * Math.exp(-t / 0.008) * (noise - Math.floor(noise) - 0.5);
      }
    }
    const padLength = Math.round(beatSec * SAMPLE_RATE);
    for (let i = 0; i < padLength && start + i < total; i += 1) {
      const t = i / SAMPLE_RATE;
      samples[start + i] += (full ? 0.18 : 0.05) * Math.sin(2 * Math.PI * (full ? 220 : 330) * t);
    }
  }
  return samples;
};

// Smallest absolute distance between a and b on a circle of the given period.
const circularErrorSec = (a, b, period) => {
  let d = (a - b) % period;
  if (d > period / 2) d -= period;
  if (d < -period / 2) d += period;
  return Math.abs(d);
};

// Test 1: 128 BPM click track, first beat (a downbeat) at 0.37 s, no hint.
{
  const truthBpm = 128;
  const truthFirstBeat = 0.37;
  const grid = analyzeBeatGrid(
    synthesizeClickTrack({ bpm: truthBpm, firstBeatSec: truthFirstBeat }),
    SAMPLE_RATE,
  );
  assert.equal(grid.version, 3);
  assert.ok(
    Math.abs(grid.bpm - truthBpm) <= 0.8,
    `128 BPM: detected ${grid.bpm}, expected within ±0.8`,
  );
  const beatSec = 60 / truthBpm;
  const beatError = circularErrorSec(grid.firstBeatSec, truthFirstBeat, beatSec);
  assert.ok(
    beatError <= 0.02,
    `128 BPM: firstBeatSec ${grid.firstBeatSec} off by ${(beatError * 1000).toFixed(1)} ms (mod beat), expected ≤ 20 ms`,
  );
  const barError = circularErrorSec(grid.firstDownbeatSec, truthFirstBeat, 4 * beatSec);
  assert.ok(
    barError <= 0.02,
    `128 BPM: firstDownbeatSec ${grid.firstDownbeatSec} off by ${(barError * 1000).toFixed(1)} ms (mod bar), expected ≤ 20 ms`,
  );
  assert.ok(grid.confidence > 0.3, `128 BPM: confidence ${grid.confidence}, expected > 0.3`);
  assert.ok(Number.isFinite(grid.analyzedAt) && grid.analyzedAt > 0);
  console.log(`test 1 ok: bpm=${grid.bpm.toFixed(3)} beatErr=${(beatError * 1000).toFixed(1)}ms barErr=${(barError * 1000).toFixed(1)}ms conf=${grid.confidence.toFixed(3)}`);
}

// Test 2: 174 BPM with bpmHint 174.
{
  const grid = analyzeBeatGrid(
    synthesizeClickTrack({ bpm: 174, firstBeatSec: 0.37 }),
    SAMPLE_RATE,
    { bpmHint: 174 },
  );
  assert.ok(
    Math.abs(grid.bpm - 174) <= 1.2,
    `174 BPM hinted: detected ${grid.bpm}, expected within ±1.2`,
  );
  console.log(`test 2 ok: bpm=${grid.bpm.toFixed(3)}`);
}

// Test 3: 87 BPM. Without a hint, octave ambiguity (87 or 174) is tolerated;
// with hint 87 the detector must settle on 87.
{
  const samples = synthesizeClickTrack({ bpm: 87, firstBeatSec: 0.37 });
  const unhinted = analyzeBeatGrid(samples.slice(), SAMPLE_RATE);
  assert.ok(
    Math.abs(unhinted.bpm - 87) <= 1 || Math.abs(unhinted.bpm - 174) <= 2,
    `87 BPM unhinted: detected ${unhinted.bpm}, expected 87±1 or 174±2`,
  );
  const hinted = analyzeBeatGrid(samples, SAMPLE_RATE, { bpmHint: 87 });
  assert.ok(
    Math.abs(hinted.bpm - 87) <= 1,
    `87 BPM hinted: detected ${hinted.bpm}, expected within ±1`,
  );
  console.log(`test 3 ok: unhinted=${unhinted.bpm.toFixed(3)} hinted=${hinted.bpm.toFixed(3)}`);
}

// Test 4: silent (and too-short) input throws.
{
  assert.throws(
    () => analyzeBeatGrid(new Float32Array(DURATION_SEC * SAMPLE_RATE), SAMPLE_RATE),
    /too short or silent/i,
    "silent input should throw",
  );
  assert.throws(
    () => analyzeBeatGrid(new Float32Array(5 * SAMPLE_RATE), SAMPLE_RATE),
    /too short or silent/i,
    "short input should throw",
  );
  console.log("test 4 ok: degenerate input throws");
}

// Test 5: the phrase period and its starting bar are both recovered.
{
  for (const { bpm, sectionBars, offset, durationSec } of [
    { bpm: 128, sectionBars: 8, offset: 0, durationSec: 120 },
    { bpm: 128, sectionBars: 8, offset: 3, durationSec: 120 },
    { bpm: 124, sectionBars: 16, offset: 5, durationSec: 240 },
    { bpm: 130, sectionBars: 4, offset: 2, durationSec: 120 },
  ]) {
    const grid = analyzeBeatGrid(
      synthesizeSectionedTrack({ bpm, firstBeatSec: 0.31, durationSec, sectionBars, offset }),
      SAMPLE_RATE,
    );
    const barSec = 4 * (60 / grid.bpm);

    assert.equal(
      grid.phraseBars,
      sectionBars,
      `${sectionBars}-bar sections: detected phrase of ${grid.phraseBars}`,
    );
    assert.ok(
      grid.phraseConfidence > 0.15,
      `${sectionBars}-bar sections: phrase confidence ${grid.phraseConfidence} too low to use`,
    );

    // The phrase must start on the bar the arrangement changes on, modulo the
    // phrase period.
    const expected = grid.firstDownbeatSec + (offset % sectionBars) * barSec;
    const error = circularErrorSec(grid.firstPhraseSec, expected, sectionBars * barSec);
    assert.ok(
      error <= barSec * 0.5,
      `${sectionBars}@${offset}: firstPhraseSec off by ${error.toFixed(3)}s (bar is ${barSec.toFixed(3)}s)`,
    );

    // A phrase start is always a bar line.
    const barError = circularErrorSec(grid.firstPhraseSec, grid.firstDownbeatSec, barSec);
    assert.ok(
      barError <= 0.02,
      `${sectionBars}@${offset}: phrase start is not on a bar line, off by ${barError.toFixed(3)}s`,
    );
  }

  // The case that sank the previous approach: audio with no structure at all
  // must report no phrase rather than locking onto an analysis artifact. A
  // scalar per-bar score reported *higher* confidence here than for genuinely
  // sectioned audio, because a bar is a non-integer number of FFT frames and
  // the resulting jitter is itself bar-periodic.
  const flat = analyzeBeatGrid(
    synthesizeSectionedTrack({
      bpm: 128, firstBeatSec: 0.31, durationSec: 120, sectionBars: 0,
    }),
    SAMPLE_RATE,
  );
  assert.equal(
    flat.phraseConfidence,
    0,
    `featureless audio must report no phrase, got ${flat.phraseConfidence}`,
  );
  console.log("test 5 ok: phrase grid detected, flat audio rejected");
}

// Test 6: the intro and outro are located, so the planner can mix out where the
// track stops being the main event instead of over whatever fills its last bars.
{
  for (const { introBars, outroBars, bpm, durationSec } of [
    { introBars: 16, outroBars: 16, bpm: 128, durationSec: 200 },
    { introBars: 8, outroBars: 24, bpm: 128, durationSec: 200 },
    { introBars: 32, outroBars: 0, bpm: 128, durationSec: 200 },
    { introBars: 16, outroBars: 8, bpm: 124, durationSec: 240 },
  ]) {
    const grid = analyzeBeatGrid(
      synthesizeArrangedTrack({ bpm, firstBeatSec: 0.31, durationSec, introBars, outroBars }),
      SAMPLE_RATE,
    );
    const barSec = 4 * (60 / grid.bpm);
    const label = `intro=${introBars} outro=${outroBars}`;

    const introBarsFound = (grid.introEndSec - grid.firstDownbeatSec) / barSec;
    assert.ok(
      Math.abs(introBarsFound - introBars) <= 2,
      `${label}: intro ended at bar ${introBarsFound.toFixed(1)}, expected ${introBars}`,
    );

    assert.equal(grid.hasOutro, outroBars > 0, `${label}: hasOutro`);
    if (outroBars > 0) {
      const outroBarsFound = (durationSec - grid.outroStartSec) / barSec;
      assert.ok(
        Math.abs(outroBarsFound - outroBars) <= 3,
        `${label}: outro runs ${outroBarsFound.toFixed(1)} bars, expected ${outroBars}`,
      );
    }
  }

  // A track that never drops away must not report a phantom outro, or the
  // planner would mix out early and cut the ending off.
  const steady = analyzeBeatGrid(
    synthesizeArrangedTrack({
      bpm: 128, firstBeatSec: 0.31, durationSec: 200, introBars: 0, outroBars: 0,
    }),
    SAMPLE_RATE,
  );
  assert.equal(steady.hasOutro, false, "a track with no outro must report none");
  assert.equal(steady.introEndSec, 0, "a track with no intro must report none");

  // A track whose whole back half is restrained must not report all of it as an
  // outro. The backwards scan walks through contiguous quiet sections, so
  // without a bound it hands back most of the track — an early sample produced
  // a 156-bar outro — and the planner would then start the blend deep inside
  // the body and cut the track off.
  const longTail = analyzeBeatGrid(
    synthesizeArrangedTrack({
      bpm: 128, firstBeatSec: 0.31, durationSec: 200, introBars: 0, outroBars: 60,
    }),
    SAMPLE_RATE,
  );
  assert.equal(
    longTail.hasOutro,
    false,
    "an outro covering more than a third of the track must be rejected",
  );
  console.log("test 6 ok: intro and outro located, overreaching runs rejected");
}

console.log("Beat grid smoke test passed");
