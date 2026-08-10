import assert from "node:assert/strict";
import {
  camelotDistance,
  planDjSet,
} from "../src/lib/mix/setPlanner.ts";

const track = (id, bpm, key, title = id) => ({
  id,
  title,
  artist: "Planner Artist",
  album: "Planner Album",
  bpm,
  key,
  durationSeconds: 180,
});

assert.equal(camelotDistance("8A", "8A"), 0);
assert.equal(camelotDistance("8A", "8B"), 1);
assert.equal(camelotDistance("8A", "9A"), 1);
assert.equal(camelotDistance("8A", "10B"), 3);
assert.equal(camelotDistance("unknown", "8A"), null);

const risingSource = [
  track("start", 100, "8A"),
  track("two", 104, "8A"),
  track("three", 108, "9A"),
  track("four", 112, "9B"),
  track("five", 116, "10B"),
  track("six", 120, "10A"),
  track("late-start-key", 122, "8A"),
  track("end", 126, "10A"),
  track("missing-bpm", 0, "11A"),
  track("missing-key", 118, undefined),
];

const rising = planDjSet(risingSource, {
  bpmFlow: "rising",
  trackCount: 7,
  startKey: "8A",
  endKey: "10A",
});
assert.equal(rising.tracks.length, 7);
assert.equal(rising.tracks[0].id, "start", "the requested start key anchors the low end");
assert.equal(rising.tracks.at(-1).id, "end", "the requested end key anchors the high end");
assert.equal(rising.missingBpmCount, 1);
assert.equal(rising.missingKeyCount, 1);
assert.ok(
  rising.tracks.at(-1).bpm >= rising.tracks[0].bpm,
  "a rising preference produces a rising overall arc",
);

const fixedStart = planDjSet(risingSource, {
  bpmFlow: "rising",
  trackCount: 4,
  startTrackId: "late-start-key",
  startKey: "10A",
  endKey: "10A",
});
assert.equal(
  fixedStart.tracks[0].id,
  "late-start-key",
  "an explicitly selected starting song overrides automatic start-key scoring",
);
assert.equal(new Set(fixedStart.tracks.map((entry) => entry.id)).size, fixedStart.tracks.length);

const falling = planDjSet(risingSource, {
  bpmFlow: "falling",
  trackCount: 6,
  startKey: "10A",
  endKey: "8A",
});
assert.equal(falling.tracks.length, 6);
assert.equal(falling.tracks[0].key, "10A");
assert.equal(falling.tracks.at(-1).key, "8A");
assert.ok(
  falling.tracks.at(-1).bpm <= falling.tracks[0].bpm,
  "a falling preference produces a falling overall arc",
);

const harmonicDetour = planDjSet([
  track("detour-start", 120, "8A"),
  track("closer-key", 118, "9A"),
  track("higher-bpm", 124, "8A"),
  track("detour-end", 126, "10A"),
], {
  bpmFlow: "rising",
  trackCount: 3,
  startKey: "8A",
  endKey: "10A",
});
assert.deepEqual(
  harmonicDetour.tracks.map((entry) => entry.id),
  ["detour-start", "closer-key", "detour-end"],
  "a small BPM dip is allowed when it creates a better harmonic path to the target key",
);

const tempoDetour = planDjSet([
  track("tempo-start", 120, "8A"),
  track("large-drop-closer-key", 105, "9A"),
  track("tempo-step", 124, "8A"),
  track("tempo-end", 128, "10A"),
], {
  bpmFlow: "rising",
  trackCount: 3,
  startKey: "8A",
  endKey: "10A",
});
assert.deepEqual(
  tempoDetour.tracks.map((entry) => entry.id),
  ["tempo-start", "tempo-step", "tempo-end"],
  "a large BPM reversal is rejected when the tempo arc outweighs the key improvement",
);

const deduplicated = planDjSet([
  risingSource[0],
  risingSource[0],
  risingSource[1],
], {
  bpmFlow: "steady",
  trackCount: 3,
});
assert.equal(deduplicated.sourceTrackCount, 2);
assert.equal(deduplicated.tracks.length, 2);
assert.equal(new Set(deduplicated.tracks.map((entry) => entry.id)).size, 2);

const noTempo = planDjSet([
  track("unknown-one", undefined, "8A"),
  track("unknown-two", 0, "8B"),
], {
  bpmFlow: "flexible",
  trackCount: 10,
});
assert.equal(noTempo.tracks.length, 0);
assert.equal(noTempo.missingBpmCount, 2);

console.log("set-planner-smoke: all assertions passed");
