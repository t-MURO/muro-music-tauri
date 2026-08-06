/**
 * Integrated loudness per ITU-R BS.1770-4 / EBU R 128, and the ReplayGain 2.0
 * gain derived from it.
 *
 * The measurement is the standard three stages: K-weight each channel with a
 * high-shelf then a high-pass biquad, take the mean square over overlapping
 * 400 ms blocks, and average the blocks that survive the absolute (-70 LUFS)
 * and relative (-10 LU) gates.
 */

export type LoudnessResult = {
  /** Integrated loudness in LUFS, or null when the track is entirely silent. */
  integratedLufs: number | null;
  /** Highest absolute sample value across all channels, in linear scale. */
  samplePeak: number;
};

type BiquadCoefficients = {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
};

/**
 * BS.1770 defines the K-weighting curve by its 48 kHz coefficients. Both stages
 * are re-derived here for the file's own rate with the same bilinear transform
 * libebur128 uses, so 44.1 kHz material is not measured through a detuned
 * filter.
 */
const highShelfCoefficients = (sampleRate: number): BiquadCoefficients => {
  const f0 = 1681.974450955533;
  const gainDb = 3.999843853973347;
  const q = 0.7071752369554196;

  const k = Math.tan((Math.PI * f0) / sampleRate);
  const vh = Math.pow(10, gainDb / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  const denominator = 1 + k / q + k * k;

  return {
    b0: (vh + (vb * k) / q + k * k) / denominator,
    b1: (2 * (k * k - vh)) / denominator,
    b2: (vh - (vb * k) / q + k * k) / denominator,
    a1: (2 * (k * k - 1)) / denominator,
    a2: (1 - k / q + k * k) / denominator,
  };
};

const highPassCoefficients = (sampleRate: number): BiquadCoefficients => {
  const f0 = 38.13547087602444;
  const q = 0.5003270373238773;

  const k = Math.tan((Math.PI * f0) / sampleRate);
  const denominator = 1 + k / q + k * k;

  return {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (k * k - 1)) / denominator,
    a2: (1 - k / q + k * k) / denominator,
  };
};

/** Direct-form-I biquad applied in place. */
const applyBiquad = (samples: Float32Array, { b0, b1, b2, a1, a2 }: BiquadCoefficients) => {
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;

  for (let i = 0; i < samples.length; i += 1) {
    const x0 = samples[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    samples[i] = y0;
  }
};

/**
 * BS.1770 channel weights. Left, right and centre count fully; the surround
 * channels are weighted +1.5 dB. LFE is excluded from the measurement.
 *
 * Channel order follows the WAVE_FORMAT_EXTENSIBLE layout that
 * `decodeAudioData` produces for multichannel files.
 */
const channelWeight = (channelIndex: number, channelCount: number): number => {
  if (channelCount <= 2) return 1;
  // 5.x and 7.x: [L, R, C, LFE, Ls, Rs, ...]
  if (channelIndex === 3) return 0;
  if (channelIndex >= 4) return 1.41;
  return 1;
};

const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;
const BLOCK_MS = 400;
const HOP_MS = 100;

/** Loudness of a block from its per-channel weighted mean squares. */
const blockLoudness = (weightedMeanSquare: number): number =>
  -0.691 + 10 * Math.log10(weightedMeanSquare);

/**
 * @param channels One Float32Array per channel, all the same length. The
 *   arrays are filtered in place, so pass copies if the caller still needs the
 *   original PCM.
 */
export const measureLoudness = (
  channels: Float32Array[],
  sampleRate: number
): LoudnessResult => {
  if (channels.length === 0 || channels[0].length === 0 || sampleRate <= 0) {
    return { integratedLufs: null, samplePeak: 0 };
  }

  let samplePeak = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i += 1) {
      const magnitude = Math.abs(channel[i]);
      if (magnitude > samplePeak) samplePeak = magnitude;
    }
  }

  const shelf = highShelfCoefficients(sampleRate);
  const highPass = highPassCoefficients(sampleRate);
  for (const channel of channels) {
    applyBiquad(channel, shelf);
    applyBiquad(channel, highPass);
  }

  const blockSize = Math.round((sampleRate * BLOCK_MS) / 1000);
  const hopSize = Math.round((sampleRate * HOP_MS) / 1000);
  const length = channels[0].length;
  if (length < blockSize) {
    // Shorter than one gating block: BS.1770 has no integrated value here.
    return { integratedLufs: null, samplePeak };
  }

  // Weighted mean square per block, retained so the relative gate can make a
  // second pass without re-filtering.
  const blockPowers: number[] = [];
  for (let start = 0; start + blockSize <= length; start += hopSize) {
    let weightedSum = 0;
    for (let c = 0; c < channels.length; c += 1) {
      const weight = channelWeight(c, channels.length);
      if (weight === 0) continue;
      const channel = channels[c];
      let sumSquares = 0;
      for (let i = start; i < start + blockSize; i += 1) {
        const sample = channel[i];
        sumSquares += sample * sample;
      }
      weightedSum += weight * (sumSquares / blockSize);
    }
    blockPowers.push(weightedSum);
  }

  // Absolute gate.
  const aboveAbsolute = blockPowers.filter(
    (power) => power > 0 && blockLoudness(power) > ABSOLUTE_GATE_LUFS
  );
  if (aboveAbsolute.length === 0) {
    return { integratedLufs: null, samplePeak };
  }

  // Relative gate, referenced to the mean of the absolute-gated blocks.
  const absoluteMean =
    aboveAbsolute.reduce((sum, power) => sum + power, 0) / aboveAbsolute.length;
  const relativeThreshold = blockLoudness(absoluteMean) + RELATIVE_GATE_LU;
  const aboveRelative = aboveAbsolute.filter(
    (power) => blockLoudness(power) > relativeThreshold
  );
  if (aboveRelative.length === 0) {
    return { integratedLufs: blockLoudness(absoluteMean), samplePeak };
  }

  const gatedMean =
    aboveRelative.reduce((sum, power) => sum + power, 0) / aboveRelative.length;
  return { integratedLufs: blockLoudness(gatedMean), samplePeak };
};

/**
 * ReplayGain 2.0 reference level. The spec pins this at -18 LUFS; streaming
 * services normalize nearer -14, so it stays configurable.
 */
export const REFERENCE_LUFS = -18;

/** Gain in dB that brings `integratedLufs` to the reference level. */
export const replayGainFromLoudness = (
  integratedLufs: number,
  referenceLufs: number = REFERENCE_LUFS
): number => referenceLufs - integratedLufs;

/** Convert a dB gain to the linear multiplier used for playback. */
export const dbToLinear = (db: number): number => Math.pow(10, db / 20);
