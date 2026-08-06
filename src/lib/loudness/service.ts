import { convertFileSrc, invoke } from "@muro/desktop/runtime";
import { REFERENCE_LUFS, replayGainFromLoudness, type LoudnessResult } from "./r128";

type WorkerReply =
  | { ok: true; result: LoudnessResult }
  | { ok: false; error: string };

export type TrackLoudness = {
  integratedLufs: number | null;
  samplePeak: number;
  /** Gain in dB relative to the reference level. */
  gainDb: number | null;
};

let analysisWorker: Worker | null = null;
// Decoded PCM for a full track is large (a 5-minute stereo 44.1 kHz file is
// ~100 MB as Float32), so analyses are serialized rather than run in parallel.
let analysisChain: Promise<unknown> = Promise.resolve();

const ensureWorker = (): Worker => {
  if (!analysisWorker) {
    analysisWorker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
  }
  return analysisWorker;
};

const runWorkerMeasurement = (
  channels: Float32Array[],
  sampleRate: number
): Promise<LoudnessResult> =>
  new Promise<LoudnessResult>((resolve, reject) => {
    const worker = ensureWorker();
    const handleMessage = (event: MessageEvent<WorkerReply>) => {
      cleanup();
      if (event.data.ok) resolve(event.data.result);
      else reject(new Error(event.data.error));
    };
    const handleError = (event: ErrorEvent) => {
      cleanup();
      analysisWorker = null;
      reject(new Error(event.message || "Loudness analysis worker failed"));
    };
    const cleanup = () => {
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleError);
    };
    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleError);
    worker.postMessage(
      { channels, sampleRate },
      channels.map((channel) => channel.buffer)
    );
  });

const decodeAndMeasure = async (
  sourcePath: string,
  referenceLufs: number
): Promise<TrackLoudness> => {
  const response = await fetch(convertFileSrc(sourcePath));
  if (!response.ok) {
    throw new Error(
      `Could not read audio file for loudness analysis (HTTP ${response.status}): ${sourcePath}`
    );
  }
  const encoded = await response.arrayBuffer();
  // Decode at the file's own rate: BS.1770 filters are derived per sample rate
  // and resampling first would only add error.
  const context = new OfflineAudioContext(1, 1, 48_000);
  let decoded: AudioBuffer;
  try {
    decoded = await context.decodeAudioData(encoded);
  } catch (error) {
    const detail = error instanceof Error && error.message ? ` (${error.message})` : "";
    throw new Error(
      `Could not decode audio for loudness analysis${detail} — the format may be unsupported: ${sourcePath}`
    );
  }

  // Copy each channel: the worker filters in place and the AudioBuffer's own
  // storage must not be mutated or detached.
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
    channels.push(new Float32Array(decoded.getChannelData(channel)));
  }

  const result = await runWorkerMeasurement(channels, decoded.sampleRate);
  return {
    integratedLufs: result.integratedLufs,
    samplePeak: result.samplePeak,
    gainDb:
      result.integratedLufs === null
        ? null
        : replayGainFromLoudness(result.integratedLufs, referenceLufs),
  };
};

export function analyzeSourceLoudness(
  sourcePath: string,
  referenceLufs: number = REFERENCE_LUFS
): Promise<TrackLoudness> {
  const task = analysisChain.then(
    () => decodeAndMeasure(sourcePath, referenceLufs),
    () => decodeAndMeasure(sourcePath, referenceLufs)
  );
  analysisChain = task.catch(() => undefined);
  return task;
}

/**
 * Measure a track and persist the result. Album gain is not derived here: it
 * needs every track on the release, so `recomputeAlbumGain` runs afterwards.
 */
export async function analyzeAndStoreLoudness(
  track: { id: string; sourcePath: string },
  dbPath: string,
  referenceLufs: number = REFERENCE_LUFS
): Promise<TrackLoudness> {
  const loudness = await analyzeSourceLoudness(track.sourcePath, referenceLufs);
  await invoke("update_track_loudness", {
    dbPath,
    trackId: track.id,
    integratedLufs: loudness.integratedLufs,
    gainDb: loudness.gainDb,
    peak: loudness.samplePeak,
    source: "analyzed",
  });
  return loudness;
}
