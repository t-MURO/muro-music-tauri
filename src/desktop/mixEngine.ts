import type { TransitionPlan } from "../lib/mix/plan";
import {
  buildTransitionAutomation,
  transitionAutomationAt,
  valueAtAutomationPoint,
  type AutomationPoint,
} from "../lib/mix/automation";
import { getTransitionSeekPhase } from "../lib/mix/seek";
import { retryMediaLoadOnce } from "./mediaPlayback";

export type DeckHandle = {
  el: HTMLAudioElement;
};

export type TransitionRequest = {
  plan: TransitionPlan;
  incoming: { el: HTMLAudioElement; srcUrl: string };  // el NOT yet loaded; engine sets src, seeks, rates
  outgoing: { el: HTMLAudioElement };
  preservePitch: boolean;
  callbacks: {
    onStateChange: (status: "armed" | "active" | "completed" | "cancelled", progress: number) => void;
    onHandoff: () => void;   // runtime swaps active element/current track here, synchronously
  };
};

type ElementChain = {
  source: MediaElementAudioSourceNode;
  lowShelf: BiquadFilterNode;
  transitionGain: GainNode;
  levelGain: GainNode;
};

type PitchCapableElement = HTMLAudioElement & {
  preservesPitch?: boolean;
  webkitPreservesPitch?: boolean;
};

type HoldableParam = AudioParam & {
  cancelAndHoldAtTime?: (cancelTime: number) => AudioParam;
};

type ActiveTransition = {
  plan: TransitionPlan;
  incomingEl: HTMLAudioElement;
  outgoingEl: HTMLAudioElement;
  callbacks: TransitionRequest["callbacks"];
  started: boolean;   // audio from both decks flowing
  starting: boolean;  // incoming.play() in flight
  frozen: boolean;    // user paused mid-transition
  watcherId: number | null;
  lastProgressEmitMs: number;
  activationId: number;
};

const BASS_KILL_DB = -28;
const LOW_SHELF_FREQ_HZ = 200;
const WATCH_INTERVAL_MS = 100;
const PROGRESS_EMIT_MS = 250;
const METADATA_TIMEOUT_MS = 5_000;
const CANCEL_RAMP_SEC = 0.25;
const RATE_EASE_STEP = 0.0015;
const RATE_EASE_EPSILON = 0.002;

let audioContext: AudioContext | null = null;
const elementChains = new Map<HTMLAudioElement, ElementChain>();
let transition: ActiveTransition | null = null;
let rateEaseTimerId: number | null = null;
let cancelCleanupTimerId: number | null = null;
let pendingCancelPark: (() => void) | null = null;

const clampNumber = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

// "" = system default. AudioContext.setSinkId is a Chromium extension not in
// every TypeScript DOM lib, hence the structural cast.
let outputDeviceId = "";

const applyContextOutputDevice = async (context: AudioContext): Promise<void> => {
  const sinkable = context as AudioContext & { setSinkId?: (sinkId: string) => Promise<void> };
  if (typeof sinkable.setSinkId !== "function") return;
  try {
    await sinkable.setSinkId(outputDeviceId);
  } catch {
    // A vanished device falls back to whatever Chromium routes by default.
  }
};

// Called by the runtime when the user picks an output device so transition
// audio (routed through this context) follows the element audio.
export const setOutputDevice = async (deviceId: string): Promise<void> => {
  outputDeviceId = deviceId;
  if (audioContext && audioContext.state !== "closed") {
    await applyContextOutputDevice(audioContext);
  }
};

const ensureAudioContextRunning = async (): Promise<AudioContext> => {
  if (!audioContext || audioContext.state === "closed") {
    audioContext = new AudioContext({ latencyHint: "interactive" });
    if (outputDeviceId !== "") void applyContextOutputDevice(audioContext);
  }
  const context = audioContext;
  if (context.state !== "running") await context.resume();
  if (String(context.state) !== "running") {
    throw new Error("Mix audio output could not be started");
  }
  return context;
};

export function routeElement(el: HTMLAudioElement): void {
  // The graph is created lazily when a transition or above-unity ReplayGain
  // needs Web Audio; otherwise elements keep the simpler default output path.
  if (!audioContext || elementChains.has(el)) return;
  const source = audioContext.createMediaElementSource(el);
  const lowShelf = audioContext.createBiquadFilter();
  lowShelf.type = "lowshelf";
  lowShelf.frequency.value = LOW_SHELF_FREQ_HZ;
  lowShelf.gain.value = 0;
  const gain = audioContext.createGain();
  gain.gain.value = 1;
  const levelGain = audioContext.createGain();
  levelGain.gain.value = 1;
  source.connect(lowShelf);
  lowShelf.connect(gain);
  gain.connect(levelGain);
  levelGain.connect(audioContext.destination);
  elementChains.set(el, { source, lowShelf, transitionGain: gain, levelGain });
}

const getChain = (el: HTMLAudioElement): ElementChain | null =>
  elementChains.get(el) ?? null;

const holdParam = (param: AudioParam): void => {
  if (!audioContext) return;
  const now = audioContext.currentTime;
  const holdable = param as HoldableParam;
  if (typeof holdable.cancelAndHoldAtTime === "function") {
    holdable.cancelAndHoldAtTime(now);
    return;
  }
  const value = param.value;
  param.cancelScheduledValues(now);
  param.setValueAtTime(value, now);
};

const setChainNeutral = (chain: ElementChain): void => {
  if (!audioContext) return;
  const now = audioContext.currentTime;
  chain.transitionGain.gain.cancelScheduledValues(now);
  chain.transitionGain.gain.setValueAtTime(1, now);
  chain.lowShelf.gain.cancelScheduledValues(now);
  chain.lowShelf.gain.setValueAtTime(0, now);
};

const updateElementLevel = (el: HTMLAudioElement, level: number): boolean => {
  if (!audioContext) return false;
  const chain = getChain(el);
  if (!chain) return false;
  const normalized = Number.isFinite(level) && level >= 0 ? level : 1;
  const now = audioContext.currentTime;
  chain.levelGain.gain.cancelScheduledValues(now);
  chain.levelGain.gain.setValueAtTime(normalized, now);
  return true;
};

export const setElementLevel = async (
  el: HTMLAudioElement,
  level: number,
): Promise<void> => {
  await ensureAudioContextRunning();
  routeElement(el);
  updateElementLevel(el, level);
};

export const refreshElementLevel = updateElementLevel;

const waitForLoadedMetadata = (player: HTMLAudioElement, timeoutMs: number) =>
  new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timeout);
      player.removeEventListener("loadedmetadata", handleSuccess);
      player.removeEventListener("error", handleError);
    };
    const handleSuccess = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error(player.error?.message ?? "Media operation failed"));
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("loadedmetadata timed out"));
    }, timeoutMs);

    player.addEventListener("loadedmetadata", handleSuccess, { once: true });
    player.addEventListener("error", handleError, { once: true });
  });

const loadIncomingMetadata = async (
  player: HTMLAudioElement,
  srcUrl: string,
): Promise<void> => {
  const load = async () => {
    const metadataLoaded = waitForLoadedMetadata(player, METADATA_TIMEOUT_MS);
    player.src = srcUrl;
    player.load();
    await metadataLoaded;
  };

  await retryMediaLoadOnce(load, async () => {
    // Chromium can deliver a transient media error while an idle deck is
    // being reused after cancellation. Clear it and let those stale events
    // settle before making one fresh request for the same source.
    player.pause();
    player.removeAttribute("src");
    player.load();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  });
};

const scheduleParam = (
  param: AudioParam,
  points: AutomationPoint[],
  offsetSec: number
): void => {
  if (!audioContext) return;
  const now = audioContext.currentTime;
  param.cancelScheduledValues(now);
  param.setValueAtTime(valueAtAutomationPoint(points, offsetSec), now);
  for (const point of points) {
    if (point.at <= offsetSec) continue;
    param.linearRampToValueAtTime(point.value, now + (point.at - offsetSec));
  }
};

// Schedules (or reschedules, on resume) all remaining automation. The offset
// is how far into the transition we are on the outgoing element's clock.
const scheduleAutomation = (t: ActiveTransition, fromAClockOffset: number): void => {
  const inChain = getChain(t.incomingEl);
  const outChain = getChain(t.outgoingEl);
  if (!inChain || !outChain) return;
  const automation = buildTransitionAutomation(t.plan);
  scheduleParam(inChain.transitionGain.gain, automation.incomingGain, fromAClockOffset);
  scheduleParam(inChain.lowShelf.gain, automation.incomingShelf, fromAClockOffset);
  scheduleParam(outChain.transitionGain.gain, automation.outgoingGain, fromAClockOffset);
  scheduleParam(outChain.lowShelf.gain, automation.outgoingShelf, fromAClockOffset);
};

const setAutomationAt = (t: ActiveTransition, offsetSec: number): void => {
  if (!audioContext) return;
  const incoming = getChain(t.incomingEl);
  const outgoing = getChain(t.outgoingEl);
  if (!incoming || !outgoing) return;
  const now = audioContext.currentTime;
  const snapshot = transitionAutomationAt(t.plan, offsetSec);
  for (const [param, value] of [
    [incoming.transitionGain.gain, snapshot.incomingGain],
    [incoming.lowShelf.gain, snapshot.incomingShelf],
    [outgoing.transitionGain.gain, snapshot.outgoingGain],
    [outgoing.lowShelf.gain, snapshot.outgoingShelf],
  ] as const) {
    param.cancelScheduledValues(now);
    param.setValueAtTime(value, now);
  }
};

const stopWatcher = (t: ActiveTransition): void => {
  if (t.watcherId !== null) {
    window.clearInterval(t.watcherId);
    t.watcherId = null;
  }
};

const stopRateEase = (): void => {
  if (rateEaseTimerId !== null) {
    window.clearInterval(rateEaseTimerId);
    rateEaseTimerId = null;
  }
};

const startRateEase = (el: HTMLAudioElement): void => {
  stopRateEase();
  if (Math.abs(el.playbackRate - 1) < RATE_EASE_EPSILON) {
    el.playbackRate = 1;
    return;
  }
  rateEaseTimerId = window.setInterval(() => {
    try {
      const diff = 1 - el.playbackRate;
      if (Math.abs(diff) < RATE_EASE_EPSILON) {
        el.playbackRate = 1;
        stopRateEase();
        return;
      }
      el.playbackRate += clampNumber(diff, -RATE_EASE_STEP, RATE_EASE_STEP);
    } catch {
      stopRateEase();
    }
  }, 100);
};

const flushPendingCancelPark = (): void => {
  if (cancelCleanupTimerId !== null) {
    window.clearTimeout(cancelCleanupTimerId);
    cancelCleanupTimerId = null;
  }
  if (pendingCancelPark) {
    const park = pendingCancelPark;
    pendingCancelPark = null;
    park();
  }
};

const parkElement = (el: HTMLAudioElement): void => {
  el.pause();
  el.removeAttribute("src");
  el.load();
  el.playbackRate = 1;
};

const completeTransition = (t: ActiveTransition): void => {
  if (transition !== t) return;
  stopWatcher(t);
  transition = null;

  t.outgoingEl.pause();
  const outChain = getChain(t.outgoingEl);
  if (outChain) setChainNeutral(outChain);
  t.outgoingEl.removeAttribute("src");
  t.outgoingEl.load();

  const inChain = getChain(t.incomingEl);
  if (inChain) setChainNeutral(inChain);

  t.callbacks.onHandoff();
  startRateEase(t.incomingEl);
  t.callbacks.onStateChange("completed", 1);
};

const synchronizeIncomingClock = (t: ActiveTransition, outCur: number): void => {
  const expected = t.plan.cueInSec + (outCur - t.plan.startAtSec) * t.plan.rate;
  const duration = t.incomingEl.duration;
  const boundedExpected = Number.isFinite(duration) && duration > 0
    ? Math.min(expected, Math.max(0, duration - 0.05))
    : Math.max(0, expected);
  if (Math.abs(t.incomingEl.currentTime - boundedExpected) > 0.008) {
    try {
      // This runs while the incoming deck is still at zero gain. A single
      // clock correction is much less audible than changing playbackRate on
      // every watcher tick.
      t.incomingEl.currentTime = boundedExpected;
    } catch {
      // Keep the pre-cued position if this media format cannot seek here.
    }
  }
  t.incomingEl.playbackRate = t.plan.rate;
};

const startTransition = (t: ActiveTransition, outCur: number): void => {
  const activationId = ++t.activationId;
  t.starting = true;
  const lateBy = Math.max(0, outCur - t.plan.startAtSec);
  if (lateBy > 0.05) {
    try {
      t.incomingEl.currentTime = t.plan.cueInSec + lateBy * t.plan.rate;
    } catch {
      // Keep the pre-cued position; the phase corrector will converge.
    }
  }
  t.incomingEl.play().then(
    () => {
      if (transition !== t || activationId !== t.activationId) return;
      t.starting = false;
      t.started = true;
      const outgoingNow = t.outgoingEl.currentTime;
      synchronizeIncomingClock(t, outgoingNow);
      const offset = Math.max(0, outgoingNow - t.plan.startAtSec);
      scheduleAutomation(t, offset);
      t.lastProgressEmitMs = Date.now();
      t.callbacks.onStateChange(
        "active",
        clampNumber(offset / t.plan.durationSec, 0, 1)
      );
    },
    () => {
      if (transition !== t || activationId !== t.activationId) return;
      t.starting = false;
      cancelTransition();
    }
  );
};

const handleWatchTick = (): void => {
  const t = transition;
  if (!t || t.frozen) return;
  try {
    const outCur = t.outgoingEl.currentTime;
    if (!t.started) {
      if (!t.starting && outCur >= t.plan.startAtSec) startTransition(t, outCur);
      return;
    }
    const progress = clampNumber(
      (outCur - t.plan.startAtSec) / t.plan.durationSec,
      0,
      1
    );
    const nowMs = Date.now();
    if (nowMs - t.lastProgressEmitMs >= PROGRESS_EMIT_MS) {
      t.lastProgressEmitMs = nowMs;
      t.callbacks.onStateChange("active", progress);
    }
    if (outCur >= t.plan.startAtSec + t.plan.durationSec) {
      completeTransition(t);
    }
  } catch {
    cancelTransition();
  }
};

export function isTransitionEngaged(): boolean {
  return transition !== null;
}

export function isTransitionActive(): boolean {
  return transition !== null && transition.started;
}

export async function armTransition(req: TransitionRequest): Promise<void> {
  cancelTransition();
  flushPendingCancelPark();

  // Never reroute an already-playing media element into a suspended context:
  // doing so immediately mutes the song. If output cannot start, fail while
  // the element is still on its normal browser audio path.
  const context = await ensureAudioContextRunning();
  routeElement(req.outgoing.el);
  routeElement(req.incoming.el);

  const incomingEl = req.incoming.el;
  const pitchEl = incomingEl as PitchCapableElement;
  if ("preservesPitch" in pitchEl) pitchEl.preservesPitch = req.preservePitch;
  if ("webkitPreservesPitch" in pitchEl) pitchEl.webkitPreservesPitch = req.preservePitch;
  incomingEl.playbackRate = req.plan.rate;

  const now = context.currentTime;
  const inChain = getChain(incomingEl);
  if (inChain) {
    inChain.transitionGain.gain.cancelScheduledValues(now);
    inChain.transitionGain.gain.setValueAtTime(0, now);
    inChain.lowShelf.gain.cancelScheduledValues(now);
    inChain.lowShelf.gain.setValueAtTime(
      req.plan.mode === "beatmatch" ? BASS_KILL_DB : 0,
      now
    );
  }
  const outChain = getChain(req.outgoing.el);
  if (outChain) setChainNeutral(outChain);

  const t: ActiveTransition = {
    plan: req.plan,
    incomingEl,
    outgoingEl: req.outgoing.el,
    callbacks: req.callbacks,
    started: false,
    starting: false,
    frozen: false,
    watcherId: null,
    lastProgressEmitMs: 0,
    activationId: 0,
  };
  transition = t;

  try {
    await loadIncomingMetadata(incomingEl, req.incoming.srcUrl);
    incomingEl.playbackRate = req.plan.rate;
    incomingEl.currentTime = Math.max(0, req.plan.cueInSec);
    incomingEl.pause();
  } catch (error) {
    if (transition === t) cancelTransition();
    throw error instanceof Error ? error : new Error("Failed to arm transition");
  }
  if (transition !== t) {
    throw new Error("Transition cancelled while arming");
  }

  t.watcherId = window.setInterval(handleWatchTick, WATCH_INTERVAL_MS);
  t.callbacks.onStateChange("armed", 0);
}

export function cancelTransition(): void {
  stopRateEase();
  const t = transition;
  if (!t) return;
  stopWatcher(t);
  transition = null;

  const inChain = getChain(t.incomingEl);
  const outChain = getChain(t.outgoingEl);
  const parkIncoming = () => {
    parkElement(t.incomingEl);
    if (inChain) setChainNeutral(inChain);
  };

  if (!t.started || !audioContext) {
    // Armed only: the incoming deck never became audible.
    parkIncoming();
    if (outChain) setChainNeutral(outChain);
    t.callbacks.onStateChange("cancelled", 0);
    return;
  }

  // Active: quick ramp back to the outgoing deck, then park the incoming one.
  const rampEnd = audioContext.currentTime + CANCEL_RAMP_SEC;
  if (inChain) {
    holdParam(inChain.transitionGain.gain);
    inChain.transitionGain.gain.linearRampToValueAtTime(0, rampEnd);
    holdParam(inChain.lowShelf.gain);
  }
  if (outChain) {
    holdParam(outChain.transitionGain.gain);
    outChain.transitionGain.gain.linearRampToValueAtTime(1, rampEnd);
    holdParam(outChain.lowShelf.gain);
    outChain.lowShelf.gain.linearRampToValueAtTime(0, rampEnd);
  }
  flushPendingCancelPark();
  pendingCancelPark = parkIncoming;
  cancelCleanupTimerId = window.setTimeout(() => {
    cancelCleanupTimerId = null;
    pendingCancelPark = null;
    parkIncoming();
  }, CANCEL_RAMP_SEC * 1000 + 50);
  t.callbacks.onStateChange("cancelled", 0);
}

export function notifySeek(): void {
  const t = transition;
  if (!t) return;

  const outgoingPosition = t.outgoingEl.currentTime;
  const phase = getTransitionSeekPhase(t.plan, outgoingPosition);

  if (phase === "before") {
    t.activationId += 1;
    t.started = false;
    t.starting = false;
    t.frozen = false;
    t.incomingEl.pause();
    t.incomingEl.playbackRate = t.plan.rate;
    try {
      t.incomingEl.currentTime = Math.max(0, t.plan.cueInSec);
    } catch {
      // The deck will be synchronized again when the transition starts.
    }
    setAutomationAt(t, 0);
    t.callbacks.onStateChange("armed", 0);
    return;
  }

  if (phase === "after") {
    synchronizeIncomingClock(t, outgoingPosition);
    if (t.started || t.outgoingEl.paused) {
      completeTransition(t);
      return;
    }
    const activationId = ++t.activationId;
    void t.incomingEl.play().then(
      () => {
        if (transition !== t || activationId !== t.activationId) return;
        completeTransition(t);
      },
      () => {
        if (transition === t && activationId === t.activationId) cancelTransition();
      },
    );
    return;
  }

  const offset = Math.max(0, outgoingPosition - t.plan.startAtSec);
  synchronizeIncomingClock(t, outgoingPosition);
  if (!t.started) {
    if (!t.outgoingEl.paused && !t.starting) startTransition(t, outgoingPosition);
    return;
  }

  if (t.frozen) setAutomationAt(t, offset);
  else scheduleAutomation(t, offset);
  t.callbacks.onStateChange(
    "active",
    clampNumber(offset / t.plan.durationSec, 0, 1),
  );
}

export function notifyOutgoingEnded(): void {
  const t = transition;
  if (!t) return;
  if (!t.started) {
    // The outgoing track ended before the transition window was reached;
    // start the incoming deck immediately and hand off.
    void t.incomingEl.play().catch(() => undefined);
  }
  completeTransition(t);
}

export function notifyPause(): void {
  const t = transition;
  if (!t) return;
  t.frozen = true;
  if (!t.started || !audioContext) return;
  for (const chain of [getChain(t.incomingEl), getChain(t.outgoingEl)]) {
    if (!chain) continue;
    holdParam(chain.transitionGain.gain);
    holdParam(chain.lowShelf.gain);
  }
}

export async function resumeAudioOutput(): Promise<void> {
  if (!audioContext) return;
  await ensureAudioContextRunning();
}

export function notifyResume(): void {
  const t = transition;
  if (!t) return;
  t.frozen = false;
  if (!t.started) return;
  t.incomingEl.playbackRate = t.plan.rate;
  const offset = Math.max(0, t.outgoingEl.currentTime - t.plan.startAtSec);
  scheduleAutomation(t, offset);
}

export function disposeMixEngine(): void {
  stopRateEase();
  flushPendingCancelPark();
  const t = transition;
  if (t) {
    stopWatcher(t);
    transition = null;
    parkElement(t.incomingEl);
  }
  for (const chain of elementChains.values()) {
    try {
      chain.source.disconnect();
      chain.lowShelf.disconnect();
      chain.transitionGain.disconnect();
      chain.levelGain.disconnect();
    } catch {
      // Nodes may already be disconnected if the context is closing.
    }
  }
  elementChains.clear();
  if (audioContext) {
    void audioContext.close().catch(() => undefined);
    audioContext = null;
  }
}
