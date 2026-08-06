import { convertFileSrc, invoke } from "@muro/desktop/runtime";
import type { Track } from "../../types";
import { BEAT_GRID_VERSION, type BeatGrid } from "./types";

type WorkerReply =
  | { ok: true; grid: BeatGrid }
  | { ok: false; error: string };

const ANALYSIS_SAMPLE_RATE = 11025;

let analysisWorker: Worker | null = null;
// One analysis at a time: decoded PCM plus worker copies are large, so calls
// are serialized through this module-level chain.
let analysisChain: Promise<unknown> = Promise.resolve();

const ensureWorker = (): Worker => {
  if (!analysisWorker) {
    analysisWorker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
  }
  return analysisWorker;
};

const runWorkerAnalysis = (
  samples: Float32Array,
  sampleRate: number,
  bpmHint: number | null,
): Promise<BeatGrid> =>
  new Promise<BeatGrid>((resolve, reject) => {
    const worker = ensureWorker();
    const handleMessage = (event: MessageEvent<WorkerReply>) => {
      cleanup();
      if (event.data.ok) {
        resolve(event.data.grid);
      } else {
        reject(new Error(event.data.error));
      }
    };
    const handleError = (event: ErrorEvent) => {
      cleanup();
      analysisWorker = null;
      reject(new Error(event.message || "Beat analysis worker failed"));
    };
    const cleanup = () => {
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleError);
    };
    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleError);
    worker.postMessage({ samples, sampleRate, bpmHint }, [samples.buffer]);
  });

const decodeAndAnalyze = async (
  sourcePath: string,
  bpmHint: number | null,
): Promise<BeatGrid> => {
  const response = await fetch(convertFileSrc(sourcePath));
  if (!response.ok) {
    throw new Error(`Could not read audio file for beat analysis (HTTP ${response.status}): ${sourcePath}`);
  }
  const encoded = await response.arrayBuffer();
  // OfflineAudioContext decodes AND resamples to the analysis rate in one go.
  const context = new OfflineAudioContext(1, 1, ANALYSIS_SAMPLE_RATE);
  let decoded: AudioBuffer;
  try {
    decoded = await context.decodeAudioData(encoded);
  } catch (error) {
    const detail = error instanceof Error && error.message ? ` (${error.message})` : "";
    throw new Error(
      `Could not decode audio for beat analysis${detail} — the format may be unsupported: ${sourcePath}`,
    );
  }
  const channelCount = decoded.numberOfChannels;
  const mono = new Float32Array(decoded.length);
  for (let channel = 0; channel < channelCount; channel += 1) {
    const data = decoded.getChannelData(channel);
    for (let i = 0; i < mono.length; i += 1) mono[i] += data[i];
  }
  if (channelCount > 1) {
    for (let i = 0; i < mono.length; i += 1) mono[i] /= channelCount;
  }
  return runWorkerAnalysis(mono, decoded.sampleRate, bpmHint);
};

export function analyzeSourceBeatGrid(
  sourcePath: string,
  bpmHint: number | null = null,
): Promise<BeatGrid> {
  const task = analysisChain.then(
    () => decodeAndAnalyze(sourcePath, bpmHint),
    () => decodeAndAnalyze(sourcePath, bpmHint),
  );
  analysisChain = task.catch(() => undefined);
  return task;
}

export async function getOrComputeBeatGrid(
  track: Track,
  dbPath: string,
): Promise<BeatGrid> {
  if (track.beatGrid?.version === BEAT_GRID_VERSION) return track.beatGrid;
  const grid = await analyzeSourceBeatGrid(track.sourcePath, track.bpm ?? null);
  // Persist fire-and-forget: a failed write must not block the transition.
  invoke("update_track_beat_grid", {
    dbPath,
    trackId: track.id,
    beatGridJson: JSON.stringify(grid),
  }).catch(() => undefined);
  return grid;
}
