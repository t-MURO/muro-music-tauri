import assert from "node:assert/strict";
import { transitionAutomationAt } from "../src/lib/mix/automation.ts";
import { MIX_BAR_OPTIONS, isDjMixFeatureAvailable } from "../src/lib/mix/config.ts";
import { planTransition } from "../src/lib/mix/plan.ts";
import { getTransitionSeekPhase } from "../src/lib/mix/seek.ts";

assert.deepEqual(MIX_BAR_OPTIONS, [4, 8, 16, 32]);
assert.equal(isDjMixFeatureAvailable(true), true);
assert.equal(isDjMixFeatureAvailable(false), false);

// phraseConfidence defaults to 0, so the existing cases keep exercising plain
// bar alignment; the phrase cases below opt in explicitly.
const grid = (
  bpm,
  firstDownbeatSec = 0.5,
  confidence = 0.8,
  {
    phraseBars = 8,
    firstPhraseSec = firstDownbeatSec,
    phraseConfidence = 0,
    introEndSec = 0,
    outroStartSec = Number.MAX_SAFE_INTEGER,
    hasOutro = false,
  } = {},
) => ({
  version: 3,
  bpm,
  firstBeatSec: firstDownbeatSec,
  firstDownbeatSec,
  phraseBars,
  firstPhraseSec,
  phraseConfidence,
  introEndSec,
  outroStartSec,
  hasOutro,
  confidence,
  analyzedAt: 1_752_000_000,
});

const approx = (actual, expected, epsilon, label) => {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `${label}: expected ${expected} ±${epsilon}, got ${actual}`
  );
};

// 1. Matched tempos → beatmatch at rate 1, 8 bars, downbeat-aligned start.
{
  const plan = planTransition({
    gridA: grid(128),
    gridB: grid(128),
    durationASec: 300,
    durationBSec: 300,
  });
  const barSec = 4 * (60 / 128);
  assert.equal(plan.mode, "beatmatch");
  approx(plan.rate, 1, 1e-9, "rate 128->128");
  approx(plan.durationSec, 15, 1e-9, "8 bars at 128 BPM = 15 s");
  approx(plan.beatSecA, 60 / 128, 1e-9, "beatSecA");
  assert.ok(plan.startAtSec >= 0, "startAtSec >= 0");
  const barsFromDownbeat = (plan.startAtSec - 0.5) / barSec;
  approx(barsFromDownbeat, Math.round(barsFromDownbeat), 1e-6, "start lands on a downbeat");
  assert.ok(
    plan.startAtSec <= 300 - plan.durationSec - 1.5,
    "start leaves tail margin"
  );
  assert.ok(
    plan.startAtSec + barSec > 300 - plan.durationSec - 1.5,
    "start is the LATEST fitting downbeat"
  );
  approx(plan.cueInSec, 0.5, 1e-9, "cue at B's first downbeat");
}

// 2. Tempos too far apart (128 vs 172) → fade.
{
  const plan = planTransition({
    gridA: grid(128),
    gridB: grid(172),
    durationASec: 300,
    durationBSec: 300,
  });
  assert.equal(plan.mode, "fade");
  assert.equal(plan.rate, 1);
  assert.equal(plan.beatSecA, null);
  approx(plan.durationSec, 8, 1e-9, "fade duration for a 300 s track");
  approx(plan.startAtSec, 291, 1e-9, "fade startAt");
  approx(plan.bassSwapAtSec, 4, 1e-9, "fade bass swap at midpoint");
  approx(plan.bassSwapDurSec, 2, 1e-9, "fade bass swap length");
}

// 3. Octave match (128 vs 65) → beatmatch with doubled B tempo.
{
  const plan = planTransition({
    gridA: grid(128),
    gridB: grid(65),
    durationASec: 300,
    durationBSec: 300,
  });
  assert.equal(plan.mode, "beatmatch");
  approx(plan.rate, 128 / 130, 1e-9, "rate = 128 / (65 * 2)");
  approx(65 * 2 * plan.rate, 128, 1e-6, "65 * 2 * rate matches A's tempo");
}

// 4. Missing grid → fade.
{
  const plan = planTransition({
    gridA: null,
    gridB: grid(128),
    durationASec: 300,
    durationBSec: 300,
  });
  assert.equal(plan.mode, "fade");
  assert.equal(plan.beatSecA, null);
}

// 5. Short outgoing track (50 s) → fade with scaled duration.
{
  const plan = planTransition({
    gridA: grid(128),
    gridB: grid(128),
    durationASec: 50,
    durationBSec: 300,
  });
  assert.equal(plan.mode, "fade");
  approx(plan.durationSec, 5, 1e-9, "fade duration = durationA * 0.1");
  approx(plan.startAtSec, 44, 1e-9, "fade startAt for 50 s track");
}

// 6. Bars fallback: room for 4 bars but not 8 → degrade, still beatmatch.
{
  const plan = planTransition({
    gridA: grid(60, 30),
    gridB: grid(60, 0.5),
    durationASec: 60,
    durationBSec: 100,
  });
  const barSec = 4; // 60 BPM
  assert.equal(plan.mode, "beatmatch");
  approx(plan.durationSec, 4 * barSec, 1e-9, "degraded to 4 bars");
  assert.ok(plan.startAtSec >= 30, "start not before A's first downbeat");
  const barsFromDownbeat = (plan.startAtSec - 30) / barSec;
  approx(barsFromDownbeat, Math.round(barsFromDownbeat), 1e-6, "fallback start on a downbeat");
  assert.ok(plan.startAtSec <= 60 - plan.durationSec - 1.5, "fallback tail margin");
}

// 7. Bass swap sits on a whole bar inside the transition.
{
  const plans = [
    planTransition({
      gridA: grid(128),
      gridB: grid(128),
      durationASec: 300,
      durationBSec: 300,
    }),
    planTransition({
      gridA: grid(128),
      gridB: grid(128),
      durationASec: 300,
      durationBSec: 300,
      bars: 16,
    }),
    planTransition({
      gridA: grid(60, 30),
      gridB: grid(60, 0.5),
      durationASec: 60,
      durationBSec: 100,
    }),
  ];
  for (const plan of plans) {
    assert.equal(plan.mode, "beatmatch");
    const barSec = 4 * plan.beatSecA;
    const barsToSwap = plan.bassSwapAtSec / barSec;
    approx(barsToSwap, Math.round(barsToSwap), 1e-6, "bass swap on a whole bar");
    assert.ok(plan.bassSwapAtSec >= barSec, "bass swap at least one bar in");
    assert.ok(plan.bassSwapAtSec < plan.durationSec, "bass swap before transition end");
    approx(plan.bassSwapDurSec, barSec, 1e-9, "bass swap lasts one bar");
  }
}

// 8. Incoming track too short past the cue point → fade.
{
  const plan = planTransition({
    gridA: grid(128),
    gridB: grid(128, 10),
    durationASec: 300,
    durationBSec: 45,
    bars: 16,
  });
  assert.equal(plan.mode, "fade");
}

// 9. A 32-bar transition is honored when both tracks have enough room.
{
  const plan = planTransition({
    gridA: grid(128),
    gridB: grid(128),
    durationASec: 300,
    durationBSec: 300,
    bars: 32,
  });
  assert.equal(plan.mode, "beatmatch");
  approx(plan.durationSec, 60, 1e-9, "32 bars at 128 BPM = 60 s");
  approx(plan.bassSwapAtSec, 30, 1e-9, "32-bar bass swap starts halfway");
}

// 10. A requested 32-bar transition degrades to 16 bars before shorter fallbacks.
{
  const plan = planTransition({
    gridA: grid(128, 30),
    gridB: grid(128),
    durationASec: 70,
    durationBSec: 300,
    bars: 32,
  });
  assert.equal(plan.mode, "beatmatch");
  approx(plan.durationSec, 30, 1e-9, "32-bar request falls back to 16 bars");
}

// 11. Transition gains remain complementary so two mastered tracks cannot
// exceed unity merely because the crossfade overlaps them.
for (const plan of [
  planTransition({
    gridA: grid(128),
    gridB: grid(128),
    durationASec: 300,
    durationBSec: 300,
    bars: 32,
  }),
  planTransition({
    gridA: grid(128),
    gridB: grid(172),
    durationASec: 300,
    durationBSec: 300,
  }),
  planTransition({
    gridA: grid(60, 46),
    gridB: grid(60),
    durationASec: 60,
    durationBSec: 100,
    bars: 4,
  }),
]) {
  // Which conservation law applies depends on how the two decks relate.
  //
  // Beat-matched decks are correlated, so their amplitudes add and gains must
  // sum to one or the blend clips. Faded decks are not aligned and therefore
  // uncorrelated, so their power adds and the *squares* must sum to one or the
  // blend dips in the middle. The two failure modes are mutually exclusive:
  // material correlated enough to clip under equal power would not have dipped
  // under complementary gain in the first place.
  for (let sample = 0; sample <= 200; sample += 1) {
    const offset = plan.durationSec * sample / 200;
    const automation = transitionAutomationAt(plan, offset);
    assert.ok(automation.incomingGain >= 0 && automation.incomingGain <= 1);
    assert.ok(automation.outgoingGain >= 0 && automation.outgoingGain <= 1);
    if (plan.mode === "fade") {
      // The -4.5 dB law makes two guarantees at once, and neither pure law
      // manages both: the combined level never dips far, and the two gains
      // never sum high enough to clip two loud masters together.
      const power = automation.incomingGain ** 2 + automation.outgoingGain ** 2;
      assert.ok(
        power >= 0.69 && power <= 1.001,
        `fade power at ${offset.toFixed(3)} s should stay within 1.6 dB of unity, got ${(10 * Math.log10(power)).toFixed(2)} dB`,
      );
      const sum = automation.incomingGain + automation.outgoingGain;
      assert.ok(
        sum <= 1.2,
        `fade gains at ${offset.toFixed(3)} s sum to ${sum.toFixed(3)}, enough to clip`,
      );
    } else {
      approx(
        automation.incomingGain + automation.outgoingGain,
        1,
        1e-9,
        `complementary gain at ${offset.toFixed(3)} s`,
      );
    }
  }

  // The midpoint is where both pure laws fail. Complementary gains put an
  // unaligned blend at sqrt(0.45^2 + 0.55^2) ~= 0.71, a 3 dB hole; equal power
  // fills the hole but lets the two gains reach 1.41 together, which clips.
  // The compromise must land between them on both counts.
  if (plan.mode === "fade") {
    const middle = transitionAutomationAt(plan, plan.durationSec / 2);
    const combined = Math.hypot(middle.incomingGain, middle.outgoingGain);
    const dip = 20 * Math.log10(combined);
    assert.ok(
      dip > -1.8 && dip <= 0.05,
      `fade midpoint should dip by well under 3 dB, got ${dip.toFixed(2)} dB`,
    );
    assert.ok(
      middle.incomingGain + middle.outgoingGain < 1.25,
      `fade midpoint gains sum to ${(middle.incomingGain + middle.outgoingGain).toFixed(3)}, too close to clipping`,
    );
  }
  // Endpoints are compared with a tolerance because the equal-power law lands
  // on cos(pi/2), which is 5.6e-17 rather than a clean zero.
  const start = transitionAutomationAt(plan, 0);
  const end = transitionAutomationAt(plan, plan.durationSec);
  for (const [label, actual, expected] of [
    ["start incoming", start.incomingGain, 0],
    ["start outgoing", start.outgoingGain, 1],
    ["end incoming", end.incomingGain, 1],
    ["end outgoing", end.outgoingGain, 0],
  ]) {
    approx(actual, expected, 1e-9, label);
  }
  assert.deepEqual(
    [Math.round(start.incomingGain), Math.round(start.outgoingGain),
      Math.round(end.incomingGain), Math.round(end.outgoingGain)],
    [0, 1, 1, 0],
  );
}

// Seeking keeps an armed mix and tells the engine whether to re-arm,
// synchronize both decks, or complete the handoff.
{
  const plan = planTransition({
    gridA: grid(128),
    gridB: grid(128),
    durationASec: 300,
    durationBSec: 300,
  });
  assert.equal(getTransitionSeekPhase(plan, plan.startAtSec - 1), "before");
  assert.equal(getTransitionSeekPhase(plan, plan.startAtSec), "inside");
  assert.equal(
    getTransitionSeekPhase(plan, plan.startAtSec + plan.durationSec - 0.01),
    "inside",
  );
  assert.equal(
    getTransitionSeekPhase(plan, plan.startAtSec + plan.durationSec),
    "after",
  );
}

// Phrase alignment: the blend must begin on a phrase line of A and cue B at a
// phrase line of its own, not merely on a downbeat. A beat-matched blend that
// starts three bars into a phrase lines every kick up and still sounds wrong.
{
  const barSec = 4 * (60 / 128);
  const phraseSec = 8 * barSec;
  // A's phrase grid is offset from its first downbeat by 3 bars.
  const gridA = grid(128, 0.5, 0.8, {
    phraseBars: 8,
    firstPhraseSec: 0.5 + 3 * barSec,
    phraseConfidence: 0.6,
  });
  const gridB = grid(128, 1.25, 0.8, {
    phraseBars: 8,
    firstPhraseSec: 1.25 + 2 * barSec,
    phraseConfidence: 0.6,
  });
  const plan = planTransition({
    gridA,
    gridB,
    durationASec: 300,
    durationBSec: 300,
    bars: 16,
  });

  assert.equal(plan.mode, "beatmatch");

  const startOffset = plan.startAtSec - gridA.firstPhraseSec;
  approx(
    startOffset / phraseSec - Math.round(startOffset / phraseSec),
    0,
    1e-9,
    "start lands a whole number of phrases after A's first phrase",
  );
  // The incoming track always starts at its beginning. Cueing it at its first
  // detected phrase instead discarded everything before that line — a mean of
  // about thirty seconds across a real library, intro included.
  approx(
    plan.cueInSec,
    gridB.firstDownbeatSec,
    1e-9,
    "B is cued at its first downbeat, not at a phrase line further in",
  );
  assert.ok(
    plan.cueInSec < 5,
    `B must start near the beginning of the track, got ${plan.cueInSec.toFixed(1)}s in`,
  );
  // 16 bars is two whole 8-bar phrases, so the blend also ends on a phrase line.
  approx(
    plan.durationSec / phraseSec - Math.round(plan.durationSec / phraseSec),
    0,
    1e-9,
    "the blend spans whole phrases",
  );
}

// Without a trustworthy phrase grid the plan must behave exactly as before,
// anchoring on the first downbeat.
{
  const barSec = 4 * (60 / 128);
  const gridA = grid(128, 0.5, 0.8, {
    phraseBars: 8,
    firstPhraseSec: 0.5 + 3 * barSec,
    phraseConfidence: 0.02,
  });
  const plan = planTransition({
    gridA,
    gridB: grid(128, 1.25),
    durationASec: 300,
    durationBSec: 300,
    bars: 16,
  });
  const startOffset = plan.startAtSec - gridA.firstDownbeatSec;
  approx(
    startOffset / barSec - Math.round(startOffset / barSec),
    0,
    1e-9,
    "low phrase confidence falls back to bar alignment",
  );
  approx(plan.cueInSec, 1.25, 1e-9, "B is cued at its first downbeat when no phrase is trusted");
}

// The blend starts where the outgoing track stops being the main event, rather
// than simply occupying its final bars.
{
  const barSec = 4 * (60 / 128);
  const outroStartSec = 240;
  const gridA = grid(128, 0.5, 0.8, { hasOutro: true, outroStartSec });
  const plan = planTransition({
    gridA,
    gridB: grid(128, 0.5),
    durationASec: 300,
    durationBSec: 300,
    bars: 8,
  });
  assert.equal(plan.mode, "beatmatch");
  assert.ok(
    plan.startAtSec <= outroStartSec + barSec && plan.startAtSec >= outroStartSec - barSec,
    `expected the mix to start at the outro (~${outroStartSec}s), got ${plan.startAtSec.toFixed(2)}s`,
  );
  // Without the outro it would have started as late as the tail margin allows.
  const noOutro = planTransition({
    gridA: grid(128, 0.5),
    gridB: grid(128, 0.5),
    durationASec: 300,
    durationBSec: 300,
    bars: 8,
  });
  assert.ok(
    noOutro.startAtSec > outroStartSec + 30,
    `a track with no outro should still mix out near its end, got ${noOutro.startAtSec.toFixed(2)}s`,
  );
}

// The requested bar count is a cap: the runway the two tracks actually offer
// decides the length.
{
  const barSecA = 4 * (60 / 128);
  // A short outro must NOT shorten the blend. Detected outros across a real
  // library run about five bars at the median, and capping on them produced
  // four-bar transitions for half of all pairs. A DJ facing a short outro
  // starts earlier, over the final chorus, instead of taking a snatched blend.
  const shortOutro = planTransition({
    gridA: grid(128, 0.5, 0.8, {
      hasOutro: true,
      outroStartSec: 300 - 8 * barSecA,
    }),
    gridB: grid(128, 0.5),
    durationASec: 300,
    durationBSec: 300,
    bars: 32,
  });
  approx(
    shortOutro.durationSec,
    32 * barSecA,
    1e-6,
    "a short outro must not shorten the blend",
  );
  assert.ok(
    shortOutro.startAtSec < 300 - 8 * barSecA,
    "with a short outro the blend must start before it, not inside it",
  );
  assert.ok(
    shortOutro.startAtSec + shortOutro.durationSec <= 300,
    "the blend must still end within the track",
  );

  // B has only a 4-bar intro, which caps it just as hard.
  const barSecB = 4 * (60 / 128);
  const shortIntro = planTransition({
    gridA: grid(128, 0.5),
    gridB: grid(128, 0.5, 0.8, { introEndSec: 0.5 + 4 * barSecB }),
    durationASec: 300,
    durationBSec: 300,
    bars: 32,
  });
  assert.ok(
    shortIntro.durationSec <= 4 * barSecA + 1e-6,
    `a 4-bar intro must cap the blend, got ${(shortIntro.durationSec / barSecA).toFixed(1)} bars`,
  );

  // Plenty of runway on both sides: the cap is what binds.
  const roomy = planTransition({
    gridA: grid(128, 0.5, 0.8, { hasOutro: true, outroStartSec: 300 - 40 * barSecA }),
    gridB: grid(128, 0.5, 0.8, { introEndSec: 0.5 + 40 * barSecB }),
    durationASec: 300,
    durationBSec: 300,
    bars: 16,
  });
  approx(roomy.durationSec, 16 * barSecA, 1e-9, "with room on both sides the cap decides");
}

// Neither a wide tempo gap nor a middling grid may shorten the blend.
//
// Earlier revisions halved it for both, reasoning that a riskier blend should
// be held for less time. Both thresholds fired constantly on a real library —
// the tempo one at a 4.7% ratio, six BPM at 128, and the confidence one at the
// tenth percentile — so the widest-gap pairs, where beatmatching is most
// audible, were the ones cut to two bars. It sounded worse, which is the only
// evidence that ever bore on the question.
{
  const barSec = 4 * (60 / 128);
  const relaxed = planTransition({
    gridA: grid(128, 0.5, 0.9),
    gridB: grid(128, 0.5, 0.9),
    durationASec: 300, durationBSec: 300, bars: 16,
  });
  const strained = planTransition({
    gridA: grid(128, 0.5, 0.9),
    gridB: grid(120, 0.5, 0.9), // ~6.5% pull, past the old strain threshold
    durationASec: 300, durationBSec: 300, bars: 16,
  });
  approx(
    strained.durationSec,
    relaxed.durationSec,
    1e-9,
    `a wide tempo gap must not shorten the blend: relaxed=${(relaxed.durationSec / barSec).toFixed(1)} strained=${(strained.durationSec / barSec).toFixed(1)} bars`,
  );

  const shaky = planTransition({
    gridA: grid(128, 0.5, 0.3),
    gridB: grid(128, 0.5, 0.3),
    durationASec: 300, durationBSec: 300, bars: 16,
  });
  approx(
    shaky.durationSec,
    relaxed.durationSec,
    1e-9,
    `a middling grid must not shorten the blend: got ${(shaky.durationSec / barSec).toFixed(1)} bars`,
  );
}

// Beatmatching invariant: both decks must enter on a downbeat of their own
// grid. If either start is a fraction of a bar off, every kick in the blend
// flams no matter how good the tempo match is. Phrase alignment, the outro
// start point and the derived length all move these two numbers, so the
// invariant is checked across the combinations rather than one happy path.
{
  const cases = [];
  for (const phraseConfidence of [0, 0.6]) {
    for (const phraseOffsetBars of [0, 3, 7]) {
      for (const hasOutro of [false, true]) {
        for (const [bpmA, bpmB] of [[128, 128], [128, 124], [128, 174], [124, 128]]) {
          for (const bars of [4, 8, 16, 32]) {
            cases.push({ phraseConfidence, phraseOffsetBars, hasOutro, bpmA, bpmB, bars });
          }
        }
      }
    }
  }

  let checked = 0;
  for (const testCase of cases) {
    const barSecA = 4 * (60 / testCase.bpmA);
    const firstDownbeatA = 0.37;
    const firstDownbeatB = 1.21;
    const gridA = grid(testCase.bpmA, firstDownbeatA, 0.8, {
      phraseBars: 16,
      firstPhraseSec: firstDownbeatA + testCase.phraseOffsetBars * barSecA,
      phraseConfidence: testCase.phraseConfidence,
      hasOutro: testCase.hasOutro,
      outroStartSec: testCase.hasOutro ? 240 : Number.MAX_SAFE_INTEGER,
    });
    const gridB = grid(testCase.bpmB, firstDownbeatB, 0.8, {
      phraseBars: 16,
      firstPhraseSec: firstDownbeatB + 5 * (4 * (60 / testCase.bpmB)),
      phraseConfidence: testCase.phraseConfidence,
    });
    const plan = planTransition({
      gridA, gridB, durationASec: 300, durationBSec: 300, bars: testCase.bars,
    });
    if (plan.mode !== "beatmatch") continue;
    checked += 1;
    const label = JSON.stringify(testCase);

    // A enters on one of its own bar lines.
    const barsFromDownbeatA = (plan.startAtSec - firstDownbeatA) / barSecA;
    approx(
      barsFromDownbeatA - Math.round(barsFromDownbeatA),
      0,
      1e-9,
      `A must start on a downbeat, off by ${(
        (barsFromDownbeatA - Math.round(barsFromDownbeatA)) * barSecA * 1000
      ).toFixed(1)} ms — ${label}`,
    );

    // B enters on one of its own bar lines.
    const barSecB = 4 * (60 / testCase.bpmB);
    const barsFromDownbeatB = (plan.cueInSec - firstDownbeatB) / barSecB;
    approx(
      barsFromDownbeatB - Math.round(barsFromDownbeatB),
      0,
      1e-9,
      `B must be cued on a downbeat — ${label}`,
    );

    // The blend has to finish inside the outgoing track.
    assert.ok(
      plan.startAtSec + plan.durationSec <= 300,
      `blend must end within A — ${label}`,
    );
    // And the incoming track must have the material to cover it.
    assert.ok(
      plan.cueInSec + plan.durationSec * plan.rate <= 300,
      `blend must fit inside B — ${label}`,
    );
  }
  assert.ok(checked > 40, `expected many beatmatched cases, only checked ${checked}`);
}

console.log("Mix plan smoke test passed.");
