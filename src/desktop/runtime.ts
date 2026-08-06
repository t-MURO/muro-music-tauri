import { convertFileSrc as tauriConvertFileSrc } from "@tauri-apps/api/core";
import { bridge } from "./bridge";
import { emitLocal } from "./events";
import * as mix from "./mixEngine";
import { playWithTimeout } from "./mediaPlayback";
import type { TransitionPlan } from "../lib/mix/plan";

type CurrentTrack = {
  id: string;
  title: string;
  artist: string;
  album: string;
  source_path: string;
  cover_art_path?: string;
  cover_art_thumb_path?: string;
};

type PlaybackState = {
  is_playing: boolean;
  current_position: number;
  duration: number;
  volume: number;
  current_track: CurrentTrack | null;
};

export type MediaControlPayload = {
  action: "play" | "pause" | "toggle" | "next" | "previous";
  source: "media-session" | "global-shortcut" | string;
};

let audio: HTMLAudioElement | null = null;
let idleEl: HTMLAudioElement | null = null;
let masterVolume = 1;
// "" = system default. Applied to every created element and, once the mix
// engine's Web Audio graph exists, to its AudioContext as well.
let outputDeviceId = "";
const createdElements = new Set<HTMLAudioElement>();

const applyOutputDevice = (element: HTMLAudioElement) => {
  if (outputDeviceId === "" || typeof element.setSinkId !== "function") return;
  element.setSinkId(outputDeviceId).catch(() => {
    // A vanished device falls back to whatever Chromium routes by default.
  });
};
let currentTrack: CurrentTrack | null = null;
let durationHint = 0;
let seekMode = "accurate";
let mediaSessionConfigured = false;
let mediaSessionArtworkUrl: string | null = null;
let mediaSessionArtworkRequest = 0;
let playbackOperationChain: Promise<unknown> = Promise.resolve();

// ---------------------------------------------------------------------------
// Gapless / crossfade / loudness state
// ---------------------------------------------------------------------------

type PreloadedTrack = {
  track: CurrentTrack;
  durationHint: number;
  gainFactor: number;
};

/**
 * The next track, already decoded into the idle element. The renderer decides
 * *what* to preload (it owns the queue); the runtime only holds it ready and
 * reports when it took over, via `muro://track-advanced`.
 */
let preloaded: PreloadedTrack | null = null;
let gaplessEnabled = true;
/** 0 disables crossfading and falls back to the gapless hand-off. */
let crossfadeSeconds = 0;
/** Linear multiplier applied on top of masterVolume for the playing track. */
let currentGainFactor = 1;
let crossfadeTimer: number | null = null;
let crossfadeStartedAt = 0;
/** Guards against the boundary firing twice for one track. */
let handoffInFlight = false;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const applyElementVolume = (element: HTMLAudioElement, gainFactor: number) => {
  if (mix.refreshElementLevel(element, gainFactor)) {
    element.volume = masterVolume;
    return;
  }
  // Before the Web Audio route has been prepared, retain a safe direct-output
  // fallback. Values above unity are clamped until routing can be prepared.
  element.volume = clamp01(masterVolume * gainFactor);
};

const prepareElementVolume = async (
  element: HTMLAudioElement,
  gainFactor: number,
) => {
  if (gainFactor > 1 && !mix.refreshElementLevel(element, gainFactor)) {
    try {
      await mix.setElementLevel(element, gainFactor);
    } catch {
      // Playback must still work if Web Audio is unavailable. The direct path
      // below safely clamps the boost rather than failing the whole track.
    }
  }
  applyElementVolume(element, gainFactor);
};

const applyCurrentVolume = () => {
  if (audio) applyElementVolume(audio, currentGainFactor);
};

const stopCrossfade = () => {
  if (crossfadeTimer !== null) {
    window.clearInterval(crossfadeTimer);
    crossfadeTimer = null;
  }
};

const emitTrackAdvanced = (trackId: string, reason: "gapless" | "crossfade") => {
  emitLocal("muro://track-advanced", { track_id: trackId, reason });
};

const MEDIA_SESSION_ACTIONS: MediaSessionAction[] = [
  "play",
  "pause",
  "stop",
  "nexttrack",
  "previoustrack",
  "seekbackward",
  "seekforward",
  "seekto",
];
const PLAYBACK_START_TIMEOUT_MS = 8_000;

const state = (): PlaybackState => ({
  is_playing: Boolean(audio && !audio.paused && !audio.ended),
  current_position: audio?.currentTime ?? 0,
  duration: Number.isFinite(audio?.duration) ? audio!.duration : durationHint,
  volume: masterVolume,
  current_track: currentTrack,
});

const syncMediaSessionState = () => {
  if (!("mediaSession" in navigator)) return;

  try {
    navigator.mediaSession.playbackState = audio && !audio.paused && !audio.ended
      ? "playing"
      : "paused";
  } catch {
    // Media-session state can be unavailable during device hand-off.
  }

  const duration = Number.isFinite(audio?.duration) ? audio!.duration : durationHint;
  if (!audio || !Number.isFinite(duration) || duration <= 0) return;

  try {
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate: audio.playbackRate || 1,
      position: Math.max(0, Math.min(audio.currentTime || 0, duration)),
    });
  } catch {
    // Some platforms expose Media Session without position-state support.
  }
};

const emitState = () => {
  syncMediaSessionState();
  emitLocal("muro://playback-state", state());
};

const waitForMediaEvent = (
  player: HTMLAudioElement,
  successEvent: "loadedmetadata" | "seeked",
  timeoutMs: number
) =>
  new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timeout);
      player.removeEventListener(successEvent, handleSuccess);
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
      reject(new Error(`${successEvent} timed out`));
    }, timeoutMs);

    player.addEventListener(successEvent, handleSuccess, { once: true });
    player.addEventListener("error", handleError, { once: true });
  });

const seekPlayer = async (player: HTMLAudioElement, requestedPosition: number) => {
  if (player.readyState === HTMLMediaElement.HAVE_NOTHING) {
    const metadataLoaded = waitForMediaEvent(player, "loadedmetadata", 5_000);
    player.load();
    await metadataLoaded;
  }

  const knownDuration = Number.isFinite(player.duration) ? player.duration : durationHint;
  const position = Math.max(
    0,
    knownDuration > 0 ? Math.min(requestedPosition, knownDuration) : requestedPosition
  );

  if (Math.abs(player.currentTime - position) < 0.01) {
    emitLocal("muro://playback-position", player.currentTime);
    return;
  }

  const seekFinished = waitForMediaEvent(player, "seeked", 5_000);
  const fastSeek = (player as HTMLAudioElement & { fastSeek?: (time: number) => void }).fastSeek;
  try {
    if (seekMode === "fast" && typeof fastSeek === "function") {
      fastSeek.call(player, position);
    } else {
      player.currentTime = position;
    }
  } catch (error) {
    void seekFinished.catch(() => undefined);
    throw error;
  }
  await seekFinished;
  emitLocal("muro://playback-position", player.currentTime);
  emitState();
};

const setMediaSessionMetadata = (track: CurrentTrack | null) => {
  if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;
  const requestId = ++mediaSessionArtworkRequest;
  if (mediaSessionArtworkUrl) {
    URL.revokeObjectURL(mediaSessionArtworkUrl);
    mediaSessionArtworkUrl = null;
  }
  if (!track) {
    navigator.mediaSession.metadata = null;
    return;
  }

  const coverPath = track.cover_art_path || track.cover_art_thumb_path;
  const metadata = {
    title: track.title,
    artist: track.artist,
    album: track.album,
  };
  navigator.mediaSession.metadata = new MediaMetadata(metadata);
  if (!coverPath) return;

  // Chromium's Media Session implementation rejects custom URL schemes even
  // when they are secure. Convert cached local artwork into a blob URL and
  // discard stale responses if playback changes while the file is loading.
  void fetch(convertFileSrc(coverPath))
    .then((response) => {
      if (!response.ok) throw new Error("Artwork could not be read");
      return response.blob();
    })
    .then((blob) => {
      if (!blob.type.startsWith("image/")) return;
      const artworkUrl = URL.createObjectURL(blob);
      if (requestId !== mediaSessionArtworkRequest || currentTrack?.id !== track.id) {
        URL.revokeObjectURL(artworkUrl);
        return;
      }
      mediaSessionArtworkUrl = artworkUrl;
      navigator.mediaSession.metadata = new MediaMetadata({
        ...metadata,
        artwork: [{ src: artworkUrl, type: blob.type }],
      });
    })
    .catch(() => undefined);
};

const emitMediaSessionControl = (action: MediaControlPayload["action"]) => {
  emitLocal("muro://media-control", { action, source: "media-session" } satisfies MediaControlPayload);
};

const configureMediaSession = () => {
  if (!("mediaSession" in navigator) || mediaSessionConfigured) return;
  mediaSessionConfigured = true;

  const setHandler = (
    action: MediaSessionAction,
    handler: MediaSessionActionHandler,
  ) => {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {
      // Action support varies by operating system and Electron version.
    }
  };

  setHandler("play", () => emitMediaSessionControl("play"));
  setHandler("pause", () => emitMediaSessionControl("pause"));
  setHandler("stop", () => {
    void queuePlaybackInvoke("playback_stop", {}).catch(() => {
      emitLocal("muro://playback-error", "Failed to stop playback");
    });
  });
  setHandler("nexttrack", () => emitMediaSessionControl("next"));
  setHandler("previoustrack", () => emitMediaSessionControl("previous"));
  setHandler("seekbackward", (details) => {
    void queuePlaybackInvoke("playback_seek", {
      positionSecs: (audio?.currentTime ?? 0) - (details.seekOffset ?? 10),
    }).catch(() => {
      emitLocal("muro://playback-error", "Failed to seek backward");
    });
  });
  setHandler("seekforward", (details) => {
    void queuePlaybackInvoke("playback_seek", {
      positionSecs: (audio?.currentTime ?? 0) + (details.seekOffset ?? 10),
    }).catch(() => {
      emitLocal("muro://playback-error", "Failed to seek forward");
    });
  });
  setHandler("seekto", (details) => {
    if (typeof details.seekTime === "number") {
      void queuePlaybackInvoke("playback_seek", { positionSecs: details.seekTime }).catch(() => {
        emitLocal("muro://playback-error", "Failed to seek");
      });
    }
  });
};

const attachElementListeners = (el: HTMLAudioElement) => {
  el.addEventListener("timeupdate", () => {
    if (el !== audio) return;
    emitLocal("muro://playback-position", el.currentTime);
    syncMediaSessionState();
    maybeStartCrossfade(el);
  });
  el.addEventListener("play", () => {
    if (el !== audio) return;
    emitState();
  });
  el.addEventListener("pause", () => {
    if (el !== audio) return;
    emitState();
  });
  el.addEventListener("loadedmetadata", () => {
    if (el !== audio) return;
    emitState();
  });
  el.addEventListener("ended", () => {
    if (mix.isTransitionEngaged() && el === audio) {
      // The outgoing deck ran out mid-transition: force-complete the handoff
      // instead of announcing a normal track end.
      mix.notifyOutgoingEnded();
      return;
    }
    if (el !== audio) return;

    // A crossfade already promoted the incoming track; the outgoing element
    // reaching its end is expected and must not advance the queue again.
    if (handoffInFlight) return;

    // Gapless: the next track is already decoded, so start it here instead of
    // asking the renderer to load it. This removes the load-and-decode gap;
    // the remaining element-swap latency is a few milliseconds.
    if (gaplessEnabled && preloaded && idleEl) {
      handoffInFlight = true;
      void promotePreloaded("gapless");
      return;
    }

    emitState();
    emitLocal("muro://track-ended", null);
  });
  el.addEventListener("error", () => {
    if (el !== audio) return;
    emitLocal("muro://playback-error", el.error?.message ?? "Playback failed");
  });
};

const createAudioElement = (preload: "metadata" | "auto") => {
  const element = new Audio();
  // The custom file protocol is a different origin from both the packaged
  // renderer and the dev server. Opt in before assigning a source so Web Audio
  // can route the media without Chromium replacing it with silence.
  element.crossOrigin = "anonymous";
  element.preload = preload;
  element.volume = masterVolume;
  attachElementListeners(element);
  applyOutputDevice(element);
  createdElements.add(element);
  return element;
};

const ensureAudio = (): HTMLAudioElement => {
  if (audio) return audio;
  audio = createAudioElement("metadata");
  configureMediaSession();
  return audio;
};

const ensureIdleElement = (): HTMLAudioElement => {
  if (!idleEl) idleEl = createAudioElement("auto");
  return idleEl;
};

const discardPreload = () => {
  stopCrossfade();
  if (preloaded && idleEl) {
    idleEl.pause();
    idleEl.removeAttribute("src");
    idleEl.load();
  }
  preloaded = null;
  handoffInFlight = false;
};

/**
 * Make the preloaded element the playing one. The two elements swap roles
 * exactly as they do after a DJ transition hand-off, so the retired element
 * becomes the idle slot for the next preload.
 */
const promotePreloaded = async (reason: "gapless" | "crossfade") => {
  const pending = preloaded;
  const incoming = idleEl;
  if (!pending || !incoming || !audio) return;

  const outgoing = audio;
  preloaded = null;

  audio = incoming;
  idleEl = outgoing;
  currentTrack = pending.track;
  durationHint = pending.durationHint;
  currentGainFactor = pending.gainFactor;

  setMediaSessionMetadata(currentTrack);
  // Bring the incoming element to its full level. The crossfade ticker ends at
  // full gain anyway, but a fade cut short by a pause would not have.
  applyElementVolume(incoming, pending.gainFactor);

  if (reason === "gapless") {
    try {
      await playWithTimeout(incoming, PLAYBACK_START_TIMEOUT_MS, "Gapless playback");
    } catch {
      // The buffered element refused to start; fall back to the normal
      // advance so the renderer can load the track the usual way.
      emitLocal("muro://track-ended", null);
      handoffInFlight = false;
      return;
    }
  }

  outgoing.pause();
  outgoing.removeAttribute("src");
  outgoing.load();

  emitState();
  emitTrackAdvanced(currentTrack.id, reason);
  handoffInFlight = false;
};

/**
 * Equal-power crossfade driven by a timer rather than Web Audio ramps, because
 * normal playback runs straight through the media elements. The mix engine's
 * AudioContext is reserved for DJ transitions.
 */
const beginCrossfade = (durationSeconds: number) => {
  const pending = preloaded;
  const incoming = idleEl;
  const outgoing = audio;
  if (!pending || !incoming || !outgoing) return;

  handoffInFlight = true;
  const outgoingGain = currentGainFactor;
  incoming.currentTime = 0;
  applyElementVolume(incoming, 0);

  void playWithTimeout(incoming, PLAYBACK_START_TIMEOUT_MS, "Crossfade playback")
    .then(() => {
      crossfadeStartedAt = performance.now();
      stopCrossfade();
      crossfadeTimer = window.setInterval(() => {
        const elapsed = (performance.now() - crossfadeStartedAt) / 1000;
        const progress = clamp01(elapsed / durationSeconds);
        // sin/cos keeps summed power constant across the fade.
        const fadeIn = Math.sin((progress * Math.PI) / 2);
        const fadeOut = Math.cos((progress * Math.PI) / 2);
        applyElementVolume(incoming, pending.gainFactor * fadeIn);
        applyElementVolume(outgoing, outgoingGain * fadeOut);

        if (progress >= 1) {
          stopCrossfade();
          void promotePreloaded("crossfade");
        }
      }, 50);
    })
    .catch(() => {
      // Could not start the incoming deck: leave the outgoing track alone and
      // let it end normally.
      handoffInFlight = false;
      applyElementVolume(outgoing, outgoingGain);
    });
};

/**
 * Abandon an in-progress crossfade and return the outgoing track to full
 * volume. Used when the user seeks away from the boundary.
 */
const cancelCrossfade = () => {
  stopCrossfade();
  if (!handoffInFlight) return;
  handoffInFlight = false;
  if (idleEl) {
    idleEl.pause();
    idleEl.currentTime = 0;
  }
  applyCurrentVolume();
};

/**
 * Collapse a running crossfade to its end state at once. Pausing mid-fade
 * would otherwise leave both elements stuck at partial volume, so the incoming
 * track simply becomes the current one immediately.
 */
const finishCrossfadeImmediately = () => {
  if (!handoffInFlight || crossfadeTimer === null) return;
  stopCrossfade();
  void promotePreloaded("crossfade");
};

/**
 * Called on every timeupdate of the playing element. Starts a crossfade once
 * the remaining time reaches the configured length.
 */
const maybeStartCrossfade = (element: HTMLAudioElement) => {
  if (handoffInFlight || crossfadeSeconds <= 0 || !preloaded) return;
  if (mix.isTransitionEngaged()) return;

  const duration = Number.isFinite(element.duration) ? element.duration : durationHint;
  if (!Number.isFinite(duration) || duration <= 0) return;

  const remaining = duration - element.currentTime;
  // A crossfade longer than the track itself would start before playback does.
  const fade = Math.min(crossfadeSeconds, duration / 2);
  if (remaining > fade || remaining <= 0) return;

  beginCrossfade(fade);
};

const resumeTransitionPlayers = async (
  outgoing: HTMLAudioElement,
  incoming: HTMLAudioElement,
) => {
  await mix.resumeAudioOutput();
  try {
    await Promise.all([
      playWithTimeout(incoming, PLAYBACK_START_TIMEOUT_MS, "Incoming deck playback"),
      playWithTimeout(outgoing, PLAYBACK_START_TIMEOUT_MS, "Outgoing deck playback"),
    ]);
  } catch (error) {
    // Never leave just one deck running after a partial resume failure.
    incoming.pause();
    outgoing.pause();
    mix.notifyPause();
    throw error;
  }
  mix.notifyResume();
};

const playbackInvoke = async <T>(
  command: string,
  args: Record<string, unknown>
): Promise<T> => {
  const player = ensureAudio();
  switch (command) {
    case "playback_play_file": {
      if (mix.isTransitionEngaged()) mix.cancelTransition();
      // An explicit play request overrides whatever was queued up for the
      // gapless hand-off.
      discardPreload();
      // Stop the previous source before changing tracks. This also makes
      // repeated/rapid play requests deterministic on Windows.
      player.pause();
      currentTrack = {
        id: String(args.id),
        title: String(args.title),
        artist: String(args.artist),
        album: String(args.album),
        source_path: String(args.sourcePath),
        cover_art_path: args.coverArtPath as string | undefined,
        cover_art_thumb_path: args.coverArtThumbPath as string | undefined,
      };
      durationHint = Number(args.durationHint) || 0;
      currentGainFactor = Number(args.gainFactor) > 0 ? Number(args.gainFactor) : 1;
      setMediaSessionMetadata(currentTrack);
      await prepareElementVolume(player, currentGainFactor);
      player.src = convertFileSrc(currentTrack.source_path);
      player.currentTime = 0;
      emitState();
      await playWithTimeout(player, PLAYBACK_START_TIMEOUT_MS, "Track playback");
      return undefined as T;
    }
    case "playback_preload_next": {
      // The renderer peeks at its own queue and hands the result here. Nothing
      // is played until the current track reaches its boundary.
      if (mix.isTransitionEngaged() || handoffInFlight) return undefined as T;
      const track = args.track as {
        id: string;
        title: string;
        artist: string;
        album: string;
        sourcePath: string;
        durationHint?: number;
        coverArtPath?: string;
        coverArtThumbPath?: string;
        gainFactor?: number;
      } | null;

      if (!track) {
        discardPreload();
        return undefined as T;
      }
      if (preloaded?.track.id === track.id) return undefined as T;

      discardPreload();
      const element = ensureIdleElement();
      const nextGainFactor = Number(track.gainFactor) > 0 ? Number(track.gainFactor) : 1;
      await prepareElementVolume(element, nextGainFactor);
      element.src = convertFileSrc(String(track.sourcePath));
      element.currentTime = 0;
      element.load();
      preloaded = {
        track: {
          id: String(track.id),
          title: String(track.title),
          artist: String(track.artist),
          album: String(track.album),
          source_path: String(track.sourcePath),
          cover_art_path: track.coverArtPath,
          cover_art_thumb_path: track.coverArtThumbPath,
        },
        durationHint: Number(track.durationHint) || 0,
        gainFactor: nextGainFactor,
      };
      return undefined as T;
    }
    case "playback_clear_preload":
      discardPreload();
      return undefined as T;
    case "playback_set_gapless":
      gaplessEnabled = Boolean(args.enabled);
      if (!gaplessEnabled) discardPreload();
      return undefined as T;
    case "playback_set_crossfade":
      crossfadeSeconds = Math.max(0, Math.min(12, Number(args.seconds) || 0));
      return undefined as T;
    case "playback_set_track_gain":
      currentGainFactor = Number(args.gainFactor) > 0 ? Number(args.gainFactor) : 1;
      await prepareElementVolume(player, currentGainFactor);
      emitState();
      return undefined as T;
    case "playback_toggle":
      if (player.paused) {
        if (mix.isTransitionActive() && idleEl) {
          await resumeTransitionPlayers(player, idleEl);
        } else {
          await playWithTimeout(player, PLAYBACK_START_TIMEOUT_MS, "Track playback");
        }
      } else {
        if (mix.isTransitionActive()) {
          player.pause();
          if (idleEl && !idleEl.paused) idleEl.pause();
          mix.notifyPause();
        } else {
          finishCrossfadeImmediately();
          (audio ?? player).pause();
        }
      }
      return (!(audio ?? player).paused) as T;
    case "playback_play":
      if (mix.isTransitionActive() && idleEl && player.paused) {
        await resumeTransitionPlayers(player, idleEl);
      } else {
        await playWithTimeout(player, PLAYBACK_START_TIMEOUT_MS, "Track playback");
      }
      return undefined as T;
    case "playback_pause": {
      const transitionActive = mix.isTransitionActive();
      if (!transitionActive) finishCrossfadeImmediately();
      const active = audio ?? player;
      if (!active.paused) active.pause();
      if (transitionActive) {
        if (idleEl && !idleEl.paused) idleEl.pause();
        mix.notifyPause();
      }
      emitState();
      return undefined as T;
    }
    case "playback_stop":
      if (mix.isTransitionEngaged()) mix.cancelTransition();
      cancelCrossfade();
      discardPreload();
      player.pause();
      player.currentTime = 0;
      currentTrack = null;
      setMediaSessionMetadata(null);
      emitState();
      return undefined as T;
    case "playback_seek":
      // Seeking away from the boundary abandons a fade that already started.
      if (crossfadeTimer !== null) cancelCrossfade();
      await seekPlayer(audio ?? player, Math.max(0, Number(args.positionSecs) || 0));
      if (mix.isTransitionEngaged()) mix.notifySeek();
      return undefined as T;
    case "playback_set_volume":
      masterVolume = Math.max(0, Math.min(1, Number(args.volume)));
      // Track gain rides on top of the master volume, so both elements are
      // re-derived rather than assigned the raw value.
      applyCurrentVolume();
      if (idleEl && preloaded && crossfadeTimer === null) {
        applyElementVolume(idleEl, preloaded.gainFactor);
      }
      emitState();
      return undefined as T;
    case "playback_set_seek_mode":
      seekMode = String(args.mode || "accurate");
      return undefined as T;
    case "playback_set_output_device": {
      outputDeviceId = String(args.deviceId ?? "");
      const sinkId = outputDeviceId; // "" resets to the system default
      await Promise.allSettled(
        [...createdElements]
          .filter((element) => typeof element.setSinkId === "function")
          .map((element) => element.setSinkId(sinkId)),
      );
      // During DJ transitions audio flows through the mix engine's
      // AudioContext, which has its own output routing.
      await mix.setOutputDevice(sinkId);
      return undefined as T;
    }
    case "playback_get_output_device":
      return outputDeviceId as T;
    case "playback_get_state":
      return state() as T;
    case "playback_is_finished":
      return Boolean(player.ended) as T;
    case "playback_transition_to": {
      if (mix.isTransitionEngaged()) mix.cancelTransition();
      // A DJ transition drives the idle element itself, so any gapless preload
      // sitting in it is released first.
      cancelCrossfade();
      discardPreload();
      if (!currentTrack || player.paused) {
        throw new Error("Nothing playing to transition from");
      }
      const track = args.track as {
        id: string;
        title: string;
        artist: string;
        album: string;
        sourcePath: string;
        durationHint: number;
        coverArtPath?: string;
        coverArtThumbPath?: string;
        gainFactor?: number;
      };
      const plan = args.plan as TransitionPlan;
      if (!idleEl) {
        idleEl = createAudioElement("auto");
      }
      const incomingEl = idleEl;
      const incomingGainFactor = Number(track.gainFactor) > 0
        ? Number(track.gainFactor)
        : 1;
      await mix.setElementLevel(incomingEl, incomingGainFactor);
      applyElementVolume(incomingEl, incomingGainFactor);
      const fromId = currentTrack.id;
      await mix.armTransition({
        plan,
        incoming: { el: incomingEl, srcUrl: convertFileSrc(String(track.sourcePath)) },
        outgoing: { el: player },
        preservePitch: Boolean(args.preservePitch),
        callbacks: {
          onStateChange: (status, progress) => {
            emitLocal("muro://transition-state", {
              status,
              progress,
              from_id: fromId,
              to_id: track.id,
              to_title: track.title,
            });
          },
          onHandoff: () => {
            const previous = audio;
            audio = incomingEl;
            idleEl = previous;
            currentTrack = {
              id: String(track.id),
              title: String(track.title),
              artist: String(track.artist),
              album: String(track.album),
              source_path: String(track.sourcePath),
              cover_art_path: track.coverArtPath,
              cover_art_thumb_path: track.coverArtThumbPath,
            };
            durationHint = Number(track.durationHint) || 0;
            currentGainFactor = incomingGainFactor;
            setMediaSessionMetadata(currentTrack);
            emitState();
          },
        },
      });
      return undefined as T;
    }
    case "playback_cancel_transition":
      mix.cancelTransition();
      return undefined as T;
    default:
      throw new Error(`Unknown playback command: ${command}`);
  }
};

const queuePlaybackInvoke = <T>(
  command: string,
  args: Record<string, unknown>,
): Promise<T> => {
  const operation = playbackOperationChain.then(
    () => playbackInvoke<T>(command, args),
    () => playbackInvoke<T>(command, args),
  );
  playbackOperationChain = operation.catch(() => undefined);
  return operation;
};

const cleanRemoteError = (error: unknown) => {
  if (!(error instanceof Error)) return error;
  const message = error.message
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^(?:Error|TypeError):\s*/i, "");
  return message === error.message
    ? error
    : Object.assign(new Error(message), { cause: error });
};

export const invoke = <T>(
  command: string,
  args: Record<string, unknown> = {}
): Promise<T> => {
  if (command.startsWith("playback_")) {
    if (
      command === "playback_play_file" ||
      command === "playback_pause" ||
      command === "playback_stop"
    ) {
      // Interrupt a pending media.play() immediately. The queued command then
      // runs in order once the interrupted promise rejects, instead of sitting
      // behind a browser media promise that may never settle.
      audio?.pause();
      idleEl?.pause();
    }
    return queuePlaybackInvoke<T>(command, args);
  }
  return bridge().invoke<T>(command, args).catch((error) => {
    throw cleanRemoteError(error);
  });
};

export const convertFileSrc = (filePath: string): string => tauriConvertFileSrc(filePath);

export const startFileDrag = (filePaths: string[]): void => {
  bridge().startFileDrag(filePaths);
};

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    // A Vite hot reload must never leave the previous module's Audio element
    // playing invisibly alongside the replacement runtime.
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    if (idleEl) {
      idleEl.pause();
      idleEl.removeAttribute("src");
      idleEl.load();
    }
    mix.disposeMixEngine();
    if ("mediaSession" in navigator) {
      for (const action of MEDIA_SESSION_ACTIONS) {
        try {
          navigator.mediaSession.setActionHandler(action, null);
        } catch {
          // Ignore actions unsupported by the host OS.
        }
      }
      navigator.mediaSession.metadata = null;
    }
    if (mediaSessionArtworkUrl) {
      URL.revokeObjectURL(mediaSessionArtworkUrl);
      mediaSessionArtworkUrl = null;
    }
    mediaSessionArtworkRequest += 1;
    stopCrossfade();
    audio = null;
    idleEl = null;
    masterVolume = 1;
    currentTrack = null;
    durationHint = 0;
    mediaSessionConfigured = false;
    playbackOperationChain = Promise.resolve();
    preloaded = null;
    handoffInFlight = false;
    currentGainFactor = 1;
    crossfadeSeconds = 0;
    gaplessEnabled = true;
  });
}
