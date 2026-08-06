import type { BeatGrid } from "../beatgrid/types";
import type { MixBars } from "./config";

export type TransitionPlan = {
  mode: "beatmatch" | "fade";
  rate: number;             // initial playbackRate for incoming deck; 1 in fade mode
  startAtSec: number;       // position in A when the incoming deck starts playing
  cueInSec: number;         // position in B (B-time) where B starts
  durationSec: number;      // total transition length measured on A's clock
  bassSwapAtSec: number;    // offset from transition start when bass swap begins
  bassSwapDurSec: number;   // bass swap ramp length
  beatSecA: number | null;  // A beat interval in seconds; null in fade mode
};

export type PlanTransitionArgs = {
  gridA: BeatGrid | null;
  gridB: BeatGrid | null;
  durationASec: number;
  durationBSec: number;
  /**
   * Upper bound on the blend, not a fixed length. The pair decides how much of
   * it to use — a track with an eight-bar outro cannot give a thirty-two-bar
   * blend no matter what the setting says.
   */
  bars?: MixBars;           // default 8
};

const MIN_CONFIDENCE = 0.25;
const MIN_BPM = 60;
const MAX_BPM = 200;
const MAX_RATE_LOG2 = Math.log2(1.08);
const TAIL_MARGIN_SEC = 1.5;
const RATE_MULTIPLIERS = [0.5, 1, 2];

// Below this the novelty curve was too flat to trust a phrase period, so the
// plan stays on plain bar alignment. Measured across 199 tracks of a real
// library, phrase confidence is cleanly bimodal — a cluster at zero, nothing
// at all between 0.05 and 0.30, then everything else above 0.30 — so this sits
// in the empty gap rather than cutting through a distribution.
const MIN_PHRASE_CONFIDENCE = 0.15;

/**
 * Ceiling on the alignment step, in bars.
 *
 * What the novelty curve finds is the *section* period, and in real music that
 * is usually 16 or 32 bars — 72% of a 199-track sample came back as 32. A
 * 32-bar step is 60 seconds at 128 BPM, far too coarse to place a transition
 * with: the start rounds down to the grid, so it can land a full minute before
 * the intended point.
 *
 * Capping at 16 costs nothing musically. Every 32-bar boundary is also a 16-bar
 * boundary, so the finer grid still lands on a phrase line — it just offers
 * twice as many of them.
 */
const MAX_ALIGNMENT_BARS = 16;

/**
 * The musical grid a transition should start on.
 *
 * Bars alone put the blend on a downbeat, which lines the kicks up but can
 * still land three bars into a phrase — beat-matched and yet plainly wrong to
 * anyone listening. Where the phrase grid is trustworthy the anchor advances a
 * whole phrase at a time instead.
 */
/**
 * How long the blend should run, given what the two tracks actually offer.
 *
 * The incoming track's intro bounds it: blending for longer than that means the
 * new track's main body arrives while the old one is still playing.
 *
 * The outgoing track's outro does *not* bound it, which took a real library to
 * see. Detected outros there run about five bars at the median, and letting
 * that cap the blend produced four-bar transitions — under eight seconds — for
 * half of all pairs. A DJ facing a short outro starts the blend earlier, over
 * the final chorus, rather than accepting a snatched one. So the outro decides
 * where the blend *starts*, not how long it runs; the tail margin already
 * guarantees it fits.
 *
 * Nothing else shortens it. Earlier revisions halved the length for a large
 * tempo pull and again for a weak grid, on the theory that a riskier blend
 * should be held for less time. Both thresholds turned out to fire constantly —
 * the tempo one at a 4.7% ratio, a six BPM gap at 128, and the confidence one
 * at the tenth percentile of a real library — so the pairs with the widest
 * tempo gap, where beatmatching is most audible, were the ones cut to two
 * bars. Neither rule was ever tested against listening, and both made it worse.
 */
const deriveBars = (args: {
  cap: number;
  introBarsB: number | null;
}): number => {
  const { cap, introBarsB } = args;
  // Only constrain by a runway that was actually detected.
  return introBarsB !== null ? Math.min(cap, introBarsB) : cap;
};

const gridAnchor = (grid: BeatGrid, barSec: number) => {
  const usePhrase =
    grid.phraseConfidence >= MIN_PHRASE_CONFIDENCE &&
    grid.phraseBars > 0 &&
    Number.isFinite(grid.firstPhraseSec);
  if (!usePhrase) {
    return { originSec: Math.max(0, grid.firstDownbeatSec), stepSec: barSec, bars: 1 };
  }
  const bars = Math.min(grid.phraseBars, MAX_ALIGNMENT_BARS);
  return {
    originSec: Math.max(0, grid.firstPhraseSec),
    stepSec: bars * barSec,
    bars,
  };
};

const buildFadePlan = (
  gridB: BeatGrid | null,
  durationASec: number,
  durationBSec: number
): TransitionPlan => {
  const durationSec = Math.min(8, Math.max(3, durationASec * 0.1));
  const startAtSec = Math.max(0, durationASec - durationSec - 1);
  const maxCueInSec = Math.max(0, durationBSec - durationSec - 5);
  const cueInSec = Math.min(Math.max(gridB?.firstDownbeatSec ?? 0, 0), maxCueInSec);
  return {
    mode: "fade",
    rate: 1,
    startAtSec,
    cueInSec,
    durationSec,
    bassSwapAtSec: durationSec / 2,
    bassSwapDurSec: Math.min(2, durationSec / 4),
    beatSecA: null,
  };
};

export function planTransition(args: PlanTransitionArgs): TransitionPlan {
  const { gridA, gridB, durationASec, durationBSec } = args;
  const requestedBars = args.bars ?? 8;

  if (
    !gridA ||
    !gridB ||
    gridA.confidence < MIN_CONFIDENCE ||
    gridB.confidence < MIN_CONFIDENCE ||
    gridA.bpm < MIN_BPM ||
    gridA.bpm > MAX_BPM ||
    gridB.bpm < MIN_BPM ||
    gridB.bpm > MAX_BPM ||
    durationASec < 60 ||
    durationBSec < 45
  ) {
    return buildFadePlan(gridB, durationASec, durationBSec);
  }

  let rate = 1;
  let bestRateLog2 = Number.POSITIVE_INFINITY;
  for (const multiplier of RATE_MULTIPLIERS) {
    const candidate = (gridA.bpm * multiplier) / gridB.bpm;
    const absLog2 = Math.abs(Math.log2(candidate));
    if (absLog2 < bestRateLog2) {
      bestRateLog2 = absLog2;
      rate = candidate;
    }
  }
  if (bestRateLog2 > MAX_RATE_LOG2) {
    return buildFadePlan(gridB, durationASec, durationBSec);
  }

  const beatSecA = 60 / gridA.bpm;
  const barSecA = 4 * beatSecA;
  const anchorA = gridAnchor(gridA, barSecA);

  // A runway under a bar is no runway at all, and must not be read as "zero
  // bars of blend allowed".
  const introBarsB = gridB.introEndSec > 0
    ? (() => {
        const bars = (gridB.introEndSec - gridB.firstDownbeatSec) / (4 * (60 / gridB.bpm));
        return bars >= 1 ? bars : null;
      })()
    : null;
  const targetBars = deriveBars({ cap: requestedBars, introBarsB });

  // A blend that both begins and ends on a phrase boundary is what makes the
  // change of track sound intended, so whole-phrase lengths come first. The
  // rest stay available for tracks with little runway left.
  const barsCandidates = [32, 16, 8, 4, 2]
    .filter((bars) => bars <= targetBars)
    .sort((left, right) => {
      const wholePhrase = (bars: number) => (bars % anchorA.bars === 0 ? 0 : 1);
      return wholePhrase(left) - wholePhrase(right) || right - left;
    });
  // Never drop the transition entirely just because the runway was tight.
  if (barsCandidates.length === 0) barsCandidates.push(2);

  let chosenBars = 0;
  let durationSec = 0;
  let startAtSec = -1;
  for (const bars of barsCandidates) {
    const candidateDuration = bars * barSecA;
    const latestStart = durationASec - candidateDuration - TAIL_MARGIN_SEC;
    if (anchorA.originSec > latestStart) continue;

    // Mix out where the track stops being the main event. Without this the
    // blend simply occupies A's final bars, whatever they contain — an outro,
    // a fade, applause, or silence.
    const preferredStart = gridA.hasOutro
      ? Math.min(gridA.outroStartSec, latestStart)
      : latestStart;
    const k = Math.floor((preferredStart - anchorA.originSec) / anchorA.stepSec);
    if (k < 0) continue;

    chosenBars = bars;
    durationSec = candidateDuration;
    startAtSec = anchorA.originSec + k * anchorA.stepSec;
    break;
  }
  if (chosenBars === 0 || startAtSec < 0 || durationSec <= 0) {
    return buildFadePlan(gridB, durationASec, durationBSec);
  }

  // Always cue B at its first downbeat — the beginning of the track.
  //
  // Cueing it at the first detected *phrase* instead skips whatever comes
  // before that phrase line. The detected offset lies anywhere within one
  // phrase, and 72% of a real library reports 32-bar phrases, so the incoming
  // track was starting a mean of about sixteen bars — roughly thirty seconds —
  // in, dropping straight into the middle of the arrangement with its intro
  // discarded. The phrase grid belongs to the question of where the outgoing
  // track mixes out, not to how much of the incoming track is thrown away.
  const cueInSec = Math.max(0, gridB.firstDownbeatSec);
  if (!(durationBSec - cueInSec > durationSec * rate + 10)) {
    return buildFadePlan(gridB, durationASec, durationBSec);
  }

  const bassSwapBars = Math.max(1, Math.floor(chosenBars / 2));
  return {
    mode: "beatmatch",
    rate,
    startAtSec,
    cueInSec,
    durationSec,
    bassSwapAtSec: bassSwapBars * barSecA,
    bassSwapDurSec: barSecA,
    beatSecA,
  };
}
