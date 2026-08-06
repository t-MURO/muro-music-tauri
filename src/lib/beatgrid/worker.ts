// Module Web Worker: runs beat-grid analysis off the UI thread.
// Keep imports DOM-free — dsp.ts and types.ts only.
import { analyzeBeatGrid } from "./dsp";
import type { BeatGrid } from "./types";

type AnalyzeRequest = {
  samples: Float32Array;
  sampleRate: number;
  bpmHint: number | null;
};

type AnalyzeResponse =
  | { ok: true; grid: BeatGrid }
  | { ok: false; error: string };

type WorkerScope = {
  onmessage: ((event: MessageEvent<AnalyzeRequest>) => void) | null;
  postMessage: (message: AnalyzeResponse) => void;
};

const scope = self as unknown as WorkerScope;

scope.onmessage = (event: MessageEvent<AnalyzeRequest>) => {
  try {
    const { samples, sampleRate, bpmHint } = event.data;
    const grid = analyzeBeatGrid(samples, sampleRate, { bpmHint });
    scope.postMessage({ ok: true, grid });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    scope.postMessage({ ok: false, error: message });
  }
};
