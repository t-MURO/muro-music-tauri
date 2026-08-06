// Module Web Worker: runs BS.1770 loudness measurement off the UI thread.
// Keep imports DOM-free — r128.ts only.
import { measureLoudness, type LoudnessResult } from "./r128";

type MeasureRequest = {
  channels: Float32Array[];
  sampleRate: number;
};

type MeasureResponse =
  | { ok: true; result: LoudnessResult }
  | { ok: false; error: string };

type WorkerScope = {
  onmessage: ((event: MessageEvent<MeasureRequest>) => void) | null;
  postMessage: (message: MeasureResponse) => void;
};

const scope = self as unknown as WorkerScope;

scope.onmessage = (event: MessageEvent<MeasureRequest>) => {
  try {
    const { channels, sampleRate } = event.data;
    scope.postMessage({ ok: true, result: measureLoudness(channels, sampleRate) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    scope.postMessage({ ok: false, error: message });
  }
};
