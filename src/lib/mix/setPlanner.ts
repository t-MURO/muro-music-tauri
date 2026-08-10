import type { Track } from "../../types";
import { toCamelotCode } from "../../utils/camelot.ts";

export const CAMELOT_CODES = Array.from({ length: 12 }, (_, index) => [
  `${index + 1}A`,
  `${index + 1}B`,
]).flat();

export type SetBpmFlow = "rising" | "falling" | "steady" | "flexible";

export type SetPlanOptions = {
  bpmFlow: SetBpmFlow;
  trackCount: number;
  startTrackId?: string | null;
  startKey?: string | null;
  endKey?: string | null;
};

export type SetPlanTransition = {
  fromTrackId: string;
  toTrackId: string;
  bpmChange: number;
  camelotDistance: number | null;
  harmonicallyCompatible: boolean;
};

export type SetPlan = {
  tracks: Track[];
  transitions: SetPlanTransition[];
  sourceTrackCount: number;
  eligibleTrackCount: number;
  missingBpmCount: number;
  missingKeyCount: number;
  requestedCount: number;
};

type Candidate = {
  track: Track;
  bpm: number;
  code: string | null;
  sourceIndex: number;
};

const normalizedBpm = (track: Track) =>
  typeof track.bpm === "number" && Number.isFinite(track.bpm) && track.bpm > 0
    ? track.bpm
    : null;

const wheelDistance = (left: number, right: number) => {
  const difference = Math.abs(left - right);
  return Math.min(difference, 12 - difference);
};

/** Number of one-step Camelot moves between two codes. */
export const camelotDistance = (left?: string | null, right?: string | null) => {
  const from = toCamelotCode(left ?? undefined);
  const to = toCamelotCode(right ?? undefined);
  if (!from || !to) return null;
  const numberDistance = wheelDistance(Number(from.slice(0, -1)), Number(to.slice(0, -1)));
  return numberDistance + (from.endsWith(to.slice(-1)) ? 0 : 1);
};

const keyDistanceForScore = (left: string | null, right: string | null) =>
  camelotDistance(left, right) ?? 6;

const targetBpmAt = (
  flow: SetBpmFlow,
  progress: number,
  minimum: number,
  maximum: number,
  median: number,
) => {
  if (flow === "rising") return minimum + (maximum - minimum) * progress;
  if (flow === "falling") return maximum - (maximum - minimum) * progress;
  if (flow === "steady") return median;
  return null;
};

const bpmFlowPenalty = (
  previous: Candidate,
  candidate: Candidate,
  flow: SetBpmFlow,
) => {
  const change = candidate.bpm - previous.bpm;
  if (flow === "rising" && change < 0) return Math.abs(change) * 3;
  if (flow === "falling" && change > 0) return change * 3;
  if (flow === "steady") return Math.abs(change) * 1.1;
  return 0;
};

const transitionPenalty = (
  previous: Candidate,
  candidate: Candidate,
  flow: SetBpmFlow,
) => {
  const distance = camelotDistance(previous.code, candidate.code);
  const harmonicPenalty = distance === null
    ? 28
    : distance <= 1
      ? 0
      : 16 + (distance - 2) * 8;
  return harmonicPenalty
    + Math.abs(candidate.bpm - previous.bpm) * 0.45
    + bpmFlowPenalty(previous, candidate, flow);
};

const endKeyPathPenalty = (
  previous: Candidate,
  candidate: Candidate,
  endCode: string | null,
  progress: number,
) => {
  if (!endCode) return 0;
  const previousDistance = camelotDistance(previous.code, endCode);
  const candidateDistance = camelotDistance(candidate.code, endCode);
  if (candidateDistance === null) return 18 * progress;

  const proximityPenalty = candidateDistance * (3 + progress * 10);
  if (previousDistance === null) return proximityPenalty;
  const movement = candidateDistance - previousDistance;
  const regressionPenalty = Math.max(0, movement) * 6;
  const progressReward = Math.max(0, -movement) * 4;
  return proximityPenalty + regressionPenalty - progressReward;
};

const chooseLowestScore = (
  candidates: Candidate[],
  score: (candidate: Candidate) => number,
) => [...candidates].sort((left, right) =>
  score(left) - score(right)
  || left.sourceIndex - right.sourceIndex
  || left.track.title.localeCompare(right.track.title)
)[0] ?? null;

/**
 * Suggest an ordered subset from a playlist. Tracks without BPM are excluded
 * because a requested tempo curve cannot place them honestly. Missing keys
 * remain usable, but known compatible keys receive a strong preference.
 */
export const planDjSet = (
  sourceTracks: Track[],
  options: SetPlanOptions,
): SetPlan => {
  const uniqueTracks = [...new Map(sourceTracks.map((track) => [track.id, track])).values()];
  const missingBpmCount = uniqueTracks.filter((track) => normalizedBpm(track) === null).length;
  const candidates: Candidate[] = uniqueTracks.flatMap((track, sourceIndex) => {
    const bpm = normalizedBpm(track);
    return bpm === null ? [] : [{
      track,
      bpm,
      code: toCamelotCode(track.key),
      sourceIndex,
    }];
  });
  const requestedCount = Math.max(
    0,
    Math.min(candidates.length, Math.floor(options.trackCount)),
  );
  const baseResult = {
    sourceTrackCount: uniqueTracks.length,
    eligibleTrackCount: candidates.length,
    missingBpmCount,
    missingKeyCount: candidates.filter((candidate) => !candidate.code).length,
    requestedCount,
  };
  if (requestedCount === 0) return { ...baseResult, tracks: [], transitions: [] };

  const bpms = candidates.map((candidate) => candidate.bpm).sort((left, right) => left - right);
  const minimumBpm = bpms[0];
  const maximumBpm = bpms[bpms.length - 1];
  const medianBpm = bpms[Math.floor(bpms.length / 2)];
  const startCode = toCamelotCode(options.startKey ?? undefined);
  const endCode = toCamelotCode(options.endKey ?? undefined);

  const startTargetBpm = targetBpmAt(
    options.bpmFlow,
    0,
    minimumBpm,
    maximumBpm,
    medianBpm,
  );
  const requestedStart = options.startTrackId
    ? candidates.find((candidate) => candidate.track.id === options.startTrackId) ?? null
    : null;
  const start = requestedStart ?? chooseLowestScore(candidates, (candidate) =>
      (startCode ? keyDistanceForScore(candidate.code, startCode) * 500 : 0)
      + (startTargetBpm === null
        ? candidate.sourceIndex * 0.001
        : Math.abs(candidate.bpm - startTargetBpm) * 2)
    );
  if (!start) return { ...baseResult, tracks: [], transitions: [] };

  const selected: Candidate[] = [start];
  const used = new Set([start.track.id]);

  // Reserve the requested musical destination, while treating the BPM curve
  // as a preference. The middle of the set may briefly reverse tempo when a
  // harmonic step makes the overall route better.
  const endpointPool = candidates.filter((candidate) => !used.has(candidate.track.id));
  const endTargetBpm = targetBpmAt(
    options.bpmFlow,
    1,
    minimumBpm,
    maximumBpm,
    medianBpm,
  );
  const reservedEnd = requestedCount > 1 && (endCode || endTargetBpm !== null)
    ? chooseLowestScore(endpointPool, (candidate) =>
        (endCode ? keyDistanceForScore(candidate.code, endCode) * 500 : 0)
        + (endTargetBpm === null ? 0 : Math.abs(candidate.bpm - endTargetBpm) * 2)
      )
    : null;

  while (selected.length < requestedCount) {
    const previous = selected[selected.length - 1];
    const slotsRemaining = requestedCount - selected.length;
    if (slotsRemaining === 1 && reservedEnd && !used.has(reservedEnd.track.id)) {
      selected.push(reservedEnd);
      used.add(reservedEnd.track.id);
      break;
    }

    const available = candidates.filter((candidate) =>
      !used.has(candidate.track.id)
      && candidate.track.id !== reservedEnd?.track.id
    );
    if (available.length === 0) break;

    const progress = selected.length / Math.max(1, requestedCount - 1);
    const bpmTarget = targetBpmAt(
      options.bpmFlow,
      progress,
      minimumBpm,
      maximumBpm,
      medianBpm,
    );
    const next = chooseLowestScore(available, (candidate) =>
      transitionPenalty(previous, candidate, options.bpmFlow)
      + (bpmTarget === null ? 0 : Math.abs(candidate.bpm - bpmTarget) * 1.3)
      + endKeyPathPenalty(previous, candidate, endCode, progress)
      + (reservedEnd
        ? transitionPenalty(candidate, reservedEnd, options.bpmFlow) * 0.3
        : 0)
    );
    if (!next) break;
    selected.push(next);
    used.add(next.track.id);
  }

  const transitions = selected.slice(1).map((candidate, index): SetPlanTransition => {
    const previous = selected[index];
    const distance = camelotDistance(previous.code, candidate.code);
    return {
      fromTrackId: previous.track.id,
      toTrackId: candidate.track.id,
      bpmChange: candidate.bpm - previous.bpm,
      camelotDistance: distance,
      harmonicallyCompatible: distance !== null && distance <= 1,
    };
  });

  return {
    ...baseResult,
    tracks: selected.map((candidate) => candidate.track),
    transitions,
  };
};
