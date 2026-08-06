// Pure DSP for beat-grid analysis. No DOM or browser APIs — this module must
// stay importable from plain Node (type-stripping) so tests can exercise it.
import { BEAT_GRID_VERSION, type BeatGrid } from "./types.ts";

export type OnsetEnvelope = { envelope: Float32Array; frameRate: number };

const FRAME_SIZE = 1024;
const HOP_SIZE = 256;
const LOW_BAND_HZ = 160;
const MIN_ANALYSIS_SECONDS = 15;

// Spectral flux reacts as a transient enters the (Hann-weighted) analysis
// window, so envelope frames lead the true onset by a roughly constant amount.
// This offset re-anchors envelope frame indices to audio time; it was
// calibrated against synthesized click tracks with known beat positions.
const ENVELOPE_LATENCY_SEC = 0.0725;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const hannWindow: Float32Array = (() => {
  const window = new Float32Array(FRAME_SIZE);
  for (let i = 0; i < FRAME_SIZE; i += 1) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FRAME_SIZE - 1)));
  }
  return window;
})();

// In-place iterative radix-2 Cooley-Tukey FFT. Lengths must be powers of two.
const fftInPlace = (real: Float32Array, imag: Float32Array): void => {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tempReal = real[i];
      real[i] = real[j];
      real[j] = tempReal;
      const tempImag = imag[i];
      imag[i] = imag[j];
      imag[j] = tempImag;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const stepReal = Math.cos(angle);
    const stepImag = Math.sin(angle);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let curReal = 1;
      let curImag = 0;
      for (let k = 0; k < half; k += 1) {
        const evenReal = real[i + k];
        const evenImag = imag[i + k];
        const oddReal = real[i + k + half] * curReal - imag[i + k + half] * curImag;
        const oddImag = real[i + k + half] * curImag + imag[i + k + half] * curReal;
        real[i + k] = evenReal + oddReal;
        imag[i + k] = evenImag + oddImag;
        real[i + k + half] = evenReal - oddReal;
        imag[i + k + half] = evenImag - oddImag;
        const nextReal = curReal * stepReal - curImag * stepImag;
        curImag = curReal * stepImag + curImag * stepReal;
        curReal = nextReal;
      }
    }
  }
};

// Light 3-point smoothing, then remove the global mean and floor at zero so
// only salient onsets remain.
const finalizeEnvelope = (raw: Float32Array): Float32Array => {
  const n = raw.length;
  const smoothed = new Float32Array(n);
  for (let t = 0; t < n; t += 1) {
    const prev = t > 0 ? raw[t - 1] : raw[t];
    const next = t < n - 1 ? raw[t + 1] : raw[t];
    smoothed[t] = (prev + 2 * raw[t] + next) / 4;
  }
  let mean = 0;
  for (let t = 0; t < n; t += 1) mean += smoothed[t];
  mean = n > 0 ? mean / n : 0;
  for (let t = 0; t < n; t += 1) smoothed[t] = Math.max(0, smoothed[t] - mean);
  return smoothed;
};

const interpolate = (values: Float32Array, position: number): number => {
  const index = Math.floor(position);
  if (index < 0 || index >= values.length) return 0;
  const fraction = position - index;
  const next = index + 1 < values.length ? values[index + 1] : values[index];
  return values[index] * (1 - fraction) + next * fraction;
};

/**
 * Log-spaced band magnitudes per frame, row-major.
 *
 * Structure analysis needs to ask "does this bar *sound* like that one", which
 * a single number per bar cannot answer. Keeping a coarse spectrum costs about
 * 1.5 MB for a six-minute track and rides along on the FFT pass that already
 * runs, so it is far cheaper than analysing twice.
 */
export type BandSpectrogram = {
  data: Float32Array;
  bandCount: number;
  frameCount: number;
  frameRate: number;
};

export const SPECTRAL_BAND_COUNT = 24;
const BAND_LOW_HZ = 40;

/** Bin index where each of the log-spaced bands begins, plus a closing edge. */
const bandEdges = (sampleRate: number, binCount: number): number[] => {
  const nyquist = sampleRate / 2;
  const top = Math.min(nyquist, sampleRate * 0.45);
  const edges: number[] = [];
  for (let band = 0; band <= SPECTRAL_BAND_COUNT; band += 1) {
    const hz = BAND_LOW_HZ * Math.pow(top / BAND_LOW_HZ, band / SPECTRAL_BAND_COUNT);
    edges.push(Math.min(binCount - 1, Math.max(1, Math.round((hz * FRAME_SIZE) / sampleRate))));
  }
  // Degenerate low bands can collapse onto one bin; keep every band non-empty.
  for (let band = 1; band <= SPECTRAL_BAND_COUNT; band += 1) {
    if (edges[band] <= edges[band - 1]) edges[band] = edges[band - 1] + 1;
  }
  return edges;
};

export function computeOnsetEnvelopes(
  samples: Float32Array,
  sampleRate: number,
): { full: OnsetEnvelope; low: OnsetEnvelope; bands: BandSpectrogram } {
  const frameRate = sampleRate / HOP_SIZE;
  const frameCount = samples.length >= FRAME_SIZE
    ? Math.floor((samples.length - FRAME_SIZE) / HOP_SIZE) + 1
    : 0;
  const fullFlux = new Float32Array(Math.max(0, frameCount));
  const lowFlux = new Float32Array(Math.max(0, frameCount));
  const binCount = FRAME_SIZE / 2 + 1;
  const lowBinLimit = Math.max(
    1,
    Math.min(binCount - 1, Math.floor((LOW_BAND_HZ * FRAME_SIZE) / sampleRate)),
  );
  const edges = bandEdges(sampleRate, binCount);
  const bandData = new Float32Array(Math.max(0, frameCount) * SPECTRAL_BAND_COUNT);
  const real = new Float32Array(FRAME_SIZE);
  const imag = new Float32Array(FRAME_SIZE);
  let previousLog = new Float32Array(binCount);
  let currentLog = new Float32Array(binCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const offset = frame * HOP_SIZE;
    for (let i = 0; i < FRAME_SIZE; i += 1) {
      real[i] = samples[offset + i] * hannWindow[i];
      imag[i] = 0;
    }
    fftInPlace(real, imag);
    for (let bin = 0; bin < binCount; bin += 1) {
      const magnitude = Math.sqrt(real[bin] * real[bin] + imag[bin] * imag[bin]);
      currentLog[bin] = Math.log1p(100 * magnitude);
    }
    if (frame > 0) {
      let full = 0;
      let low = 0;
      for (let bin = 1; bin < binCount; bin += 1) {
        const rise = currentLog[bin] - previousLog[bin];
        if (rise > 0) {
          full += rise;
          if (bin <= lowBinLimit) low += rise;
        }
      }
      fullFlux[frame] = full;
      lowFlux[frame] = low;
    }
    // Mean log magnitude per band. Level, not flux: a sustained pad has to keep
    // registering for as long as it plays, where flux would only mark its entry.
    const rowOffset = frame * SPECTRAL_BAND_COUNT;
    for (let band = 0; band < SPECTRAL_BAND_COUNT; band += 1) {
      const from = edges[band];
      const to = edges[band + 1];
      let sum = 0;
      for (let bin = from; bin < to; bin += 1) sum += currentLog[bin];
      bandData[rowOffset + band] = sum / Math.max(1, to - from);
    }
    const swap = previousLog;
    previousLog = currentLog;
    currentLog = swap;
  }
  return {
    full: { envelope: finalizeEnvelope(fullFlux), frameRate },
    low: { envelope: finalizeEnvelope(lowFlux), frameRate },
    bands: {
      data: bandData,
      bandCount: SPECTRAL_BAND_COUNT,
      frameCount: Math.max(0, frameCount),
      frameRate,
    },
  };
}

export function estimateTempo(
  envelope: OnsetEnvelope,
  opts?: { minBpm?: number; maxBpm?: number; bpmHint?: number | null },
): { bpm: number; strength: number } {
  const values = envelope.envelope;
  const frameRate = envelope.frameRate;
  const n = values.length;
  const minBpm = opts?.minBpm ?? 60;
  const maxBpm = opts?.maxBpm ?? 190;
  const bpmHint = opts?.bpmHint ?? null;
  const lagMin = Math.max(2, Math.floor((frameRate * 60) / maxBpm));
  const lagMax = Math.min(Math.floor(n / 2) - 1, Math.ceil((frameRate * 60) / minBpm));
  if (lagMax <= lagMin + 1) return { bpm: Math.min(Math.max(120, minBpm), maxBpm), strength: 0 };

  // Autocorrelation, count-normalized, out to several beat periods so the
  // winning lag can be refined against a long multiple for precision.
  const maxLag = Math.min(Math.floor(n / 2), lagMax * 8 + 4);
  const acf = new Float32Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag; lag += 1) {
    let sum = 0;
    const limit = n - lag;
    for (let t = 0; t < limit; t += 1) sum += values[t] * values[t + lag];
    acf[lag] = sum / limit;
  }
  const zeroLag = acf[0] > 0 ? acf[0] : 1;
  const normAt = (lag: number): number => {
    if (lag < 1 || lag > maxLag) return 0;
    const index = Math.floor(lag);
    const fraction = lag - index;
    const a = acf[index] / zeroLag;
    const b = index + 1 <= maxLag ? acf[index + 1] / zeroLag : a;
    return a + (b - a) * fraction;
  };

  // Mild log-normal preference for the 90-180 BPM range (centered ~127).
  const rangePrior = (bpm: number): number =>
    Math.exp(-0.5 * (Math.log2(bpm / 127) / 0.9) ** 2);
  const gaussian = (bpm: number, center: number): number =>
    Math.exp(-0.5 * (Math.log2(bpm / center) / 0.08) ** 2);
  const hintBias = (bpm: number): number => {
    if (bpmHint === null || !(bpmHint > 0)) return 1;
    return (
      1 +
      1.0 * gaussian(bpm, bpmHint) +
      0.15 * gaussian(bpm, bpmHint / 2) +
      0.15 * gaussian(bpm, bpmHint * 2)
    );
  };

  let bestLag = lagMin;
  let bestScore = -Infinity;
  for (let lag = lagMin; lag <= lagMax; lag += 1) {
    const bpm = (frameRate * 60) / lag;
    const octaveScore = normAt(lag) + 0.35 * normAt(lag * 2) + 0.35 * normAt(lag / 2);
    const score = octaveScore * rangePrior(bpm) * hintBias(bpm);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  // Parabolic interpolation around the winning integer lag.
  const refineParabolic = (center: number): number => {
    const a = normAt(center - 1);
    const b = normAt(center);
    const c = normAt(center + 1);
    const denominator = a - 2 * b + c;
    if (denominator >= 0) return center;
    const delta = (0.5 * (a - c)) / denominator;
    return center + Math.min(0.5, Math.max(-0.5, delta));
  };
  let refinedLag = refineParabolic(bestLag);

  // Re-estimate against the largest usable multiple of the beat lag: the same
  // fractional-frame error divided by k gives k-times finer tempo precision.
  const multiple = Math.min(8, Math.floor((maxLag - 1) / refinedLag));
  if (multiple >= 2) {
    const target = refinedLag * multiple;
    let peak = Math.max(2, Math.round(target));
    let peakValue = -Infinity;
    const from = Math.max(2, Math.round(target) - 3);
    const to = Math.min(maxLag - 1, Math.round(target) + 3);
    for (let lag = from; lag <= to; lag += 1) {
      const value = normAt(lag);
      if (value > peakValue) {
        peakValue = value;
        peak = lag;
      }
    }
    refinedLag = refineParabolic(peak) / multiple;
  }

  const bpm = (frameRate * 60) / refinedLag;
  const strength = clamp01(normAt(refinedLag));
  return { bpm, strength };
}

export function estimateBeatPhase(
  envelope: OnsetEnvelope,
  bpm: number,
): { firstBeatSec: number; confidence: number } {
  const values = envelope.envelope;
  const frameRate = envelope.frameRate;
  const n = values.length;
  const period = (frameRate * 60) / bpm;
  if (!(period > 1) || n < period * 2) return { firstBeatSec: 0, confidence: 0 };

  // Comb sum over sub-frame phase offsets; averaging across every beat in the
  // track gives well-below-frame phase resolution.
  const steps = 192;
  const combAt = (phase: number): number => {
    let sum = 0;
    let count = 0;
    for (let position = phase; position < n; position += period) {
      sum += interpolate(values, position);
      count += 1;
    }
    return count > 0 ? sum / count : 0;
  };
  const combValues = new Float32Array(steps);
  let bestStep = 0;
  let bestValue = -Infinity;
  let total = 0;
  for (let step = 0; step < steps; step += 1) {
    const value = combAt((step / steps) * period);
    combValues[step] = value;
    total += value;
    if (value > bestValue) {
      bestValue = value;
      bestStep = step;
    }
  }
  const before = combValues[(bestStep + steps - 1) % steps];
  const after = combValues[(bestStep + 1) % steps];
  let delta = 0;
  const denominator = before - 2 * bestValue + after;
  if (denominator < 0) {
    delta = Math.min(0.5, Math.max(-0.5, (0.5 * (before - after)) / denominator));
  }
  const phaseFrames = (((bestStep + delta + steps) % steps) / steps) * period;

  const beatSec = 60 / bpm;
  let firstBeatSec = phaseFrames / frameRate + ENVELOPE_LATENCY_SEC;
  while (firstBeatSec < 0) firstBeatSec += beatSec;
  while (firstBeatSec >= beatSec) firstBeatSec -= beatSec;

  const mean = total / steps;
  const contrast = bestValue > 0 ? (bestValue - mean) / (bestValue + mean) : 0;
  return { firstBeatSec, confidence: clamp01(contrast) };
}

export function estimateDownbeat(
  lowEnvelope: OnsetEnvelope,
  bpm: number,
  firstBeatSec: number,
): { firstDownbeatSec: number } {
  const values = lowEnvelope.envelope;
  const frameRate = lowEnvelope.frameRate;
  const n = values.length;
  const beatSec = 60 / bpm;
  const barPeriodFrames = 4 * beatSec * frameRate;
  let bestIndex = 0;
  let bestValue = -Infinity;
  for (let beat = 0; beat < 4; beat += 1) {
    const startFrames = (firstBeatSec + beat * beatSec - ENVELOPE_LATENCY_SEC) * frameRate;
    let sum = 0;
    let count = 0;
    for (let position = startFrames; position < n; position += barPeriodFrames) {
      if (position >= 0) {
        sum += interpolate(values, position);
        count += 1;
      }
    }
    const value = count > 0 ? sum / count : 0;
    if (value > bestValue) {
      bestValue = value;
      bestIndex = beat;
    }
  }
  return { firstDownbeatSec: firstBeatSec + bestIndex * beatSec };
}

export type BarFeatures = {
  /** barCount * bandCount, row-major; each row is L2-normalised. */
  shape: Float32Array;
  /** Mean band level per bar, before normalisation. */
  level: Float32Array;
  barCount: number;
  bandCount: number;
  barSec: number;
  firstBarSec: number;
};

/**
 * One timbre vector per bar.
 *
 * Each row is L2-normalised so it describes the *shape* of the spectrum rather
 * than its loudness. That normalisation is the whole point: an earlier attempt
 * scored bars by scalar flux and was defeated by frame-grid aliasing, because a
 * bar is a non-integer number of FFT frames and every transient straddles the
 * frame boundary differently. That jitter scales a band vector roughly
 * uniformly, so dividing it out removes the artifact while leaving the timbral
 * difference between an intro and a drop fully intact.
 */
export function computeBarFeatures(
  bands: BandSpectrogram,
  bpm: number,
  firstDownbeatSec: number,
): BarFeatures | null {
  const { data, bandCount, frameCount, frameRate } = bands;
  const barSec = 4 * (60 / bpm);
  const barFrames = barSec * frameRate;
  const startFrame = (firstDownbeatSec - ENVELOPE_LATENCY_SEC) * frameRate;
  const barCount = Math.floor((frameCount - Math.max(0, startFrame)) / barFrames);
  if (!(barFrames >= 1) || barCount < 4) return null;

  const shape = new Float32Array(barCount * bandCount);
  const level = new Float32Array(barCount);
  const accumulator = new Float32Array(bandCount);

  for (let bar = 0; bar < barCount; bar += 1) {
    accumulator.fill(0);
    const from = startFrame + bar * barFrames;
    const to = from + barFrames;
    let frames = 0;
    for (let frame = Math.max(0, Math.ceil(from)); frame < Math.min(frameCount, to); frame += 1) {
      const rowOffset = frame * bandCount;
      for (let band = 0; band < bandCount; band += 1) accumulator[band] += data[rowOffset + band];
      frames += 1;
    }
    if (frames === 0) continue;

    let sum = 0;
    let energy = 0;
    for (let band = 0; band < bandCount; band += 1) {
      const value = accumulator[band] / frames;
      accumulator[band] = value;
      sum += value;
      energy += value * value;
    }
    level[bar] = sum / bandCount;

    const norm = Math.sqrt(energy);
    const rowOffset = bar * bandCount;
    if (norm > 0) {
      for (let band = 0; band < bandCount; band += 1) {
        shape[rowOffset + band] = accumulator[band] / norm;
      }
    }
  }

  return {
    shape,
    level,
    barCount,
    bandCount,
    barSec,
    firstBarSec: firstDownbeatSec,
  };
}

/** Cosine similarity between two normalised rows. */
const barSimilarity = (features: BarFeatures, a: number, b: number): number => {
  const { shape, bandCount } = features;
  const offsetA = a * bandCount;
  const offsetB = b * bandCount;
  let dot = 0;
  for (let band = 0; band < bandCount; band += 1) {
    dot += shape[offsetA + band] * shape[offsetB + band];
  }
  return dot;
};

/**
 * Novelty per bar: how much the music on one side of a bar line differs from
 * the other.
 *
 * This is the checkerboard kernel of Foote's self-similarity method, reduced to
 * the diagonal — for each candidate boundary, the two blocks either side should
 * each be internally similar and mutually dissimilar. A section change lights
 * up; a bar that merely happens to be loud does not.
 */
export function computeBarNovelty(features: BarFeatures, kernelBars = 4): Float32Array {
  const { barCount } = features;
  const novelty = new Float32Array(barCount);
  const half = Math.max(1, Math.min(kernelBars, Math.floor(barCount / 4)));

  for (let bar = 0; bar < barCount; bar += 1) {
    if (bar - half < 0 || bar + half > barCount) continue;
    let within = 0;
    let across = 0;
    let withinCount = 0;
    let acrossCount = 0;
    for (let i = bar - half; i < bar; i += 1) {
      for (let j = bar - half; j < bar; j += 1) {
        within += barSimilarity(features, i, j);
        withinCount += 1;
      }
      for (let j = bar; j < bar + half; j += 1) {
        across += barSimilarity(features, i, j);
        acrossCount += 1;
      }
    }
    for (let i = bar; i < bar + half; i += 1) {
      for (let j = bar; j < bar + half; j += 1) {
        within += barSimilarity(features, i, j);
        withinCount += 1;
      }
    }
    const meanWithin = withinCount > 0 ? within / withinCount : 0;
    const meanAcross = acrossCount > 0 ? across / acrossCount : 0;
    novelty[bar] = Math.max(0, meanWithin - meanAcross);
  }
  return novelty;
}

/** Phrase lengths in bars, shortest first — the order the fundamental wins in. */
const PHRASE_CANDIDATES = [4, 8, 16, 32] as const;

// A true period's multiples explain the peaks just as well (every 16-bar
// boundary is also an 8-bar one), so the shortest period that comes within this
// fraction of the best score is taken as the fundamental.
const PHRASE_FUNDAMENTAL_TOLERANCE = 0.85;

// Below this the novelty curve is flat enough that any "period" found in it is
// noise, and the caller should stay on bar alignment.
const MIN_NOVELTY_PEAK = 0.02;

/**
 * Find the phrase period and where it starts, from the novelty curve.
 *
 * Beats and bars alone are not enough to make a transition sound intentional:
 * dance music is built from 8/16/32-bar phrases, and a blend that begins three
 * bars into one lines up every kick while still feeling wrong. Section changes
 * land on phrase boundaries, so the period of the novelty peaks *is* the phrase
 * length.
 */
export function estimatePhrase(
  features: BarFeatures,
  novelty: Float32Array,
): { phraseBars: number; firstPhraseSec: number; confidence: number } {
  const { barCount, barSec, firstBarSec } = features;
  const fallback = { phraseBars: 8, firstPhraseSec: firstBarSec, confidence: 0 };

  let peak = 0;
  for (let bar = 0; bar < barCount; bar += 1) {
    if (novelty[bar] > peak) peak = novelty[bar];
  }
  if (peak < MIN_NOVELTY_PEAK) return fallback;

  type Candidate = { bars: number; offset: number; contrast: number };
  const candidates: Candidate[] = [];
  for (const bars of PHRASE_CANDIDATES) {
    // Two full phrases minimum, or the comb averages almost nothing.
    if (barCount < bars * 2) continue;

    const means: number[] = [];
    for (let offset = 0; offset < bars; offset += 1) {
      let sum = 0;
      let count = 0;
      for (let bar = offset; bar < barCount; bar += bars) {
        sum += novelty[bar];
        count += 1;
      }
      means.push(count > 0 ? sum / count : 0);
    }

    let best = -Infinity;
    let bestOffset = 0;
    let total = 0;
    for (let offset = 0; offset < bars; offset += 1) {
      total += means[offset];
      if (means[offset] > best) {
        best = means[offset];
        bestOffset = offset;
      }
    }
    const mean = total / bars;
    const contrast = best + mean > 0 ? (best - mean) / (best + mean) : 0;
    candidates.push({ bars, offset: bestOffset, contrast });
  }
  if (candidates.length === 0) return fallback;

  const bestContrast = candidates.reduce(
    (highest, candidate) => Math.max(highest, candidate.contrast),
    0,
  );
  // PHRASE_CANDIDATES is ascending, so the first match is the shortest period
  // that explains the peaks nearly as well as the best one does.
  const chosen =
    candidates.find(
      (candidate) => candidate.contrast >= bestContrast * PHRASE_FUNDAMENTAL_TOLERANCE,
    ) ?? candidates[0];

  return {
    phraseBars: chosen.bars,
    firstPhraseSec: firstBarSec + chosen.offset * barSec,
    confidence: clamp01(chosen.contrast),
  };
}

export type Section = {
  startBar: number;
  endBar: number;
  /** Mean band level across the section, comparable within a track only. */
  level: number;
};

export type TrackStructure = {
  sections: Section[];
  /** Bar where the opening quiet run ends; 0 when the track starts at full tilt. */
  introEndBar: number;
  /** Bar where the closing quiet run begins; barCount when it never drops away. */
  outroStartBar: number;
};

// A novelty peak counts as a section boundary once it reaches this fraction of
// the strongest peak in the track.
const SECTION_BOUNDARY_FRACTION = 0.45;
// Sections shorter than this are arrangement detail, not structure.
const MIN_SECTION_BARS = 4;
/**
 * An "outro" longer than this share of the track is not an outro.
 *
 * The scan walks backwards through contiguous quiet sections, so a track whose
 * closing half is merely restrained can hand back most of its own length — an
 * early sample produced a 156-bar outro. The planner starts the blend at the
 * outro, so an overreaching one cuts the track off mid-arrangement.
 */
const MAX_OUTRO_FRACTION = 0.35;
/** The same overreach at the other end, where it inflates the intro runway. */
const MAX_INTRO_FRACTION = 0.35;
// A section counts as quiet below this fraction of the track's *loudest*
// section. Measured against the track rather than an absolute level, because
// masters differ by far more than sections within one master do — and against
// the peak rather than the median, because a track that opens and closes quietly
// has quiet sections on both sides of its own median, which would then sit below
// the level it is supposed to identify.
const QUIET_SECTION_RATIO = 0.9;

/**
 * Split the track into sections and locate its intro and outro.
 *
 * Boundaries are the peaks of the novelty curve, not the phrase lines. Those
 * are separate questions: the phrase grid is the repeating pulse a transition
 * should *align* to, while a section change is a one-off event that can land
 * anywhere. Snapping boundaries to phrase multiples pushed a detected outro
 * from bar 90 to bar 96 simply because 90 is not a multiple of the phrase
 * length.
 *
 * The planner uses the two ends. Mixing out should begin once the last loud
 * section is over, so a blend no longer runs across whatever happens to occupy
 * a track's final bars — an outro, a fade, applause, or silence.
 */
export function detectSections(
  features: BarFeatures,
  novelty: Float32Array,
): TrackStructure {
  const { barCount, level } = features;

  let strongest = 0;
  for (let bar = 0; bar < barCount; bar += 1) {
    if (novelty[bar] > strongest) strongest = novelty[bar];
  }

  const boundaries: number[] = [0];
  // A flat novelty curve means one continuous section. Without this guard the
  // threshold collapses toward zero and every bar reads as a boundary.
  if (strongest >= MIN_NOVELTY_PEAK) {
    const threshold = strongest * SECTION_BOUNDARY_FRACTION;
    for (let bar = 1; bar < barCount - 1; bar += 1) {
      if (novelty[bar] < threshold) continue;
      // Local maximum only, so one section change yields one boundary rather
      // than one per bar of its ramp.
      if (novelty[bar] < novelty[bar - 1] || novelty[bar] < novelty[bar + 1]) continue;
      if (bar - boundaries[boundaries.length - 1] < MIN_SECTION_BARS) continue;
      boundaries.push(bar);
    }
  }
  if (barCount - boundaries[boundaries.length - 1] < MIN_SECTION_BARS) {
    boundaries.pop();
  }
  boundaries.push(barCount);

  const sections: Section[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const startBar = boundaries[index];
    const endBar = boundaries[index + 1];
    if (endBar <= startBar) continue;
    let sum = 0;
    for (let bar = startBar; bar < endBar; bar += 1) sum += level[bar];
    sections.push({ startBar, endBar, level: sum / (endBar - startBar) });
  }

  if (sections.length === 0) {
    return { sections: [], introEndBar: 0, outroStartBar: barCount };
  }

  const loudest = sections.reduce(
    (highest, section) => Math.max(highest, section.level),
    0,
  );
  const quiet = loudest * QUIET_SECTION_RATIO;

  let introEndBar = 0;
  for (const section of sections) {
    if (section.level >= quiet) break;
    introEndBar = section.endBar;
  }

  let outroStartBar = barCount;
  for (let index = sections.length - 1; index >= 0; index -= 1) {
    if (sections[index].level >= quiet) break;
    outroStartBar = sections[index].startBar;
  }
  // A track that is quiet throughout would otherwise report its whole length as
  // both intro and outro.
  if (outroStartBar <= introEndBar) {
    return { sections, introEndBar: 0, outroStartBar: barCount };
  }

  // Reject a run that has swallowed too much of the track to be a real intro or
  // outro; treating one as structure would move the blend deep into the body.
  if (barCount - outroStartBar > barCount * MAX_OUTRO_FRACTION) {
    outroStartBar = barCount;
  }
  if (introEndBar > barCount * MAX_INTRO_FRACTION) {
    introEndBar = 0;
  }

  return { sections, introEndBar, outroStartBar };
}

export function analyzeBeatGrid(
  samples: Float32Array,
  sampleRate: number,
  opts?: { bpmHint?: number | null },
): BeatGrid {
  if (!(sampleRate > 0) || samples.length / sampleRate < MIN_ANALYSIS_SECONDS) {
    throw new Error("Audio too short or silent for beat analysis");
  }
  const { full, low, bands } = computeOnsetEnvelopes(samples, sampleRate);
  let peak = 0;
  for (let t = 0; t < full.envelope.length; t += 1) {
    if (full.envelope[t] > peak) peak = full.envelope[t];
  }
  if (!(peak > 0)) {
    throw new Error("Audio too short or silent for beat analysis");
  }
  const tempo = estimateTempo(full, { bpmHint: opts?.bpmHint ?? null });
  const phase = estimateBeatPhase(full, tempo.bpm);
  const downbeat = estimateDownbeat(low, tempo.bpm, phase.firstBeatSec);
  const features = computeBarFeatures(bands, tempo.bpm, downbeat.firstDownbeatSec);
  const novelty = features ? computeBarNovelty(features) : null;
  const phrase = features && novelty
    ? estimatePhrase(features, novelty)
    : { phraseBars: 8, firstPhraseSec: downbeat.firstDownbeatSec, confidence: 0 };
  const structure = features && novelty ? detectSections(features, novelty) : null;

  const trackEndSec = samples.length / sampleRate;
  const barToSec = (bar: number) =>
    features ? features.firstBarSec + bar * features.barSec : 0;
  const hasOutro = Boolean(
    structure && features && structure.outroStartBar < features.barCount,
  );

  const confidence = clamp01(0.45 * tempo.strength + 0.55 * phase.confidence);
  return {
    version: BEAT_GRID_VERSION,
    bpm: tempo.bpm,
    firstBeatSec: phase.firstBeatSec,
    firstDownbeatSec: downbeat.firstDownbeatSec,
    phraseBars: phrase.phraseBars,
    firstPhraseSec: phrase.firstPhraseSec,
    phraseConfidence: phrase.confidence,
    // Exactly 0 when there is no intro. Emitting the first downbeat instead
    // reads as a zero-length intro to the planner, which then treats the track
    // as having no room for a blend at all.
    introEndSec: structure && structure.introEndBar > 0
      ? barToSec(structure.introEndBar)
      : 0,
    outroStartSec: hasOutro && structure ? barToSec(structure.outroStartBar) : trackEndSec,
    hasOutro,
    confidence,
    analyzedAt: Math.floor(Date.now() / 1000),
  };
}
