import { invoke } from "@muro/desktop/runtime";
import { listen, type UnlistenFn } from "@muro/desktop/events";
import type { Track } from "../types";
import type { AnalysisPerformanceMode } from "../stores/settingsStore";

const DEFAULT_BPM_MIN = 100;
const DEFAULT_BPM_MAX = 180;

const standardKeys = [
  "A", "Am", "Bb", "Bbm", "B", "Bm", "C", "Cm", "Db", "Dbm", "D", "Dm",
  "Eb", "Ebm", "E", "Em", "F", "Fm", "Gb", "Gbm", "G", "Gm", "Ab", "Abm",
];

export interface AnalysisResult {
  bpm: number;
  key: string;
  scale: string;
  camelot: string;
}

export interface BpmRange {
  min: number;
  max: number;
  label: string;
}

export interface TrackAnalysisSettings {
  performance: AnalysisPerformanceMode;
  notation: "standard" | "custom" | "combined" | "djCombined";
  customCodes: string[];
  delimiter: string;
  outputs: {
    comment: "none" | "prepend" | "append" | "overwrite";
    grouping: "none" | "prepend" | "append" | "overwrite";
    initialKey: "none" | "prepend" | "append" | "overwrite";
    bpm: "none" | "overwrite";
  };
}

export interface EngineTrack {
  id: string;
  detectedKey: number | null;
  detectedCode: string;
  detectedBpm: number | null;
  status: "ready" | "analyzing" | "completed" | "failed" | "cancelled" | "skipped";
  error: { message?: string } | null;
}

export interface KeyFinderEvent {
  version: number;
  event: "trackUpdated" | "trackProgress" | "jobProgress" | "jobFinished";
  jobId: string;
  sequence: number;
  payload: {
    track?: EngineTrack;
    trackId?: string;
    fraction?: number;
    completed?: number;
    total?: number;
    cancelled?: boolean;
  };
}

export const BPM_RANGES: BpmRange[] = [
  { min: 100, max: 180, label: "Electronic (100-180)" },
  { min: 70, max: 140, label: "Hip-Hop (70-140)" },
  { min: 60, max: 120, label: "Slow (60-120)" },
  { min: 120, max: 200, label: "Fast (120-200)" },
  { min: 60, max: 200, label: "Wide (60-200)" },
];

export const normalizeBpm = (
  bpm: number,
  min = DEFAULT_BPM_MIN,
  max = DEFAULT_BPM_MAX,
): number => {
  if (bpm <= 0) return 0;
  let result = bpm;
  while (result < min && result > 0) result *= 2;
  while (result > max) result /= 2;
  return result;
};

export const analysisResultFromTrack = (track: EngineTrack): AnalysisResult => {
  const notation = track.detectedKey == null ? "" : (standardKeys[track.detectedKey] ?? "");
  const minor = notation.endsWith("m");
  return {
    bpm: track.detectedBpm ?? 0,
    key: minor ? notation.slice(0, -1) : notation || "Unknown",
    scale: notation ? (minor ? "minor" : "major") : "",
    camelot: track.detectedCode || "?",
  };
};

export const startTrackAnalysis = (
  tracks: Track[],
  settings?: TrackAnalysisSettings,
): Promise<{ jobId: string }> => {
  const writeAuthorization = Boolean(settings &&
    Object.values(settings.outputs).some((mode) => mode !== "none"));
  return invoke("start_track_analysis", { tracks, settings, writeAuthorization });
};

export const cancelTrackAnalysis = (jobId: string): Promise<{ cancelled: boolean }> =>
  invoke("cancel_track_analysis", { jobId });

export const recycleKeyFinder = (): Promise<{ recycled: boolean }> =>
  invoke("recycle_keyfinder");

export const getAudioWaveform = (
  sourcePath: string,
  points = 512,
): Promise<{ peaks: number[] }> =>
  invoke("generate_track_waveform", { sourcePath, points });

export const listenKeyFinderEvents = (
  handler: (event: KeyFinderEvent) => void,
): Promise<UnlistenFn> =>
  listen<KeyFinderEvent>("muro://keyfinder-analysis", ({ payload }) => handler(payload));
