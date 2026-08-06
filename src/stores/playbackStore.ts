import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { Track } from "../types";

export type RepeatMode = "off" | "all" | "one";

export type CurrentTrack = {
  id: string;
  title: string;
  artist: string;
  album: string;
  sourcePath: string;
  durationSeconds: number;
  coverArtPath?: string;
  coverArtThumbPath?: string;
};

export type TransitionUiState = {
  status: "armed" | "active" | "completed" | "cancelled";
  fromId: string;
  toId: string;
  toTitle: string;
  progress: number;
};

type PlaybackState = {
  isPlaying: boolean;
  currentTrack: CurrentTrack | null;
  currentPosition: number;
  duration: number;
  volume: number;
  shuffleEnabled: boolean;
  repeatMode: RepeatMode;
  queue: string[];
  playingNext: string[];
  transition: TransitionUiState | null;
};

type PlaybackActions = {
  // Playback control
  setIsPlaying: (isPlaying: boolean) => void;
  setCurrentTrack: (track: CurrentTrack | null) => void;
  setCurrentPosition: (position: number) => void;
  setDuration: (duration: number) => void;
  setVolume: (volume: number) => void;
  setTransition: (transition: TransitionUiState | null) => void;

  // Mode toggles
  toggleShuffle: () => void;
  toggleRepeat: () => void;
  setShuffleEnabled: (enabled: boolean) => void;
  setRepeatMode: (mode: RepeatMode) => void;

  // Queue management
  setQueue: (queue: string[] | ((prev: string[]) => string[])) => void;
  addToQueue: (trackIds: string[]) => void;
  playNext: (trackIds: string[]) => void;
  removeFromQueue: (index: number) => void;
  clearQueue: () => void;
  reorderQueue: (fromIndex: number, toIndex: number) => void;
  setPlayingNext: (trackIds: string[] | ((prev: string[]) => string[])) => void;
  reorderPlayingNext: (fromIndex: number, toIndex: number) => void;
  movePlayingNextToQueue: (fromIndex: number, toIndex: number) => void;

  // Reset
  reset: () => void;
};

export type PlaybackStore = PlaybackState & PlaybackActions;

const initialState: PlaybackState = {
  isPlaying: false,
  currentTrack: null,
  currentPosition: 0,
  duration: 0,
  volume: 1,
  shuffleEnabled: false,
  repeatMode: "off",
  queue: [],
  playingNext: [],
  transition: null,
};

export const usePlaybackStore = create<PlaybackStore>()(
  subscribeWithSelector((set) => ({
    ...initialState,

    // Playback control
    setIsPlaying: (isPlaying) => set({ isPlaying }),
    setCurrentTrack: (currentTrack) => set({ currentTrack }),
    setCurrentPosition: (currentPosition) => set({ currentPosition }),
    setDuration: (duration) => set({ duration }),
    setVolume: (volume) => set({ volume }),
    setTransition: (transition) => set({ transition }),

    // Mode toggles
    toggleShuffle: () => set((state) => ({ shuffleEnabled: !state.shuffleEnabled })),
    toggleRepeat: () =>
      set((state) => ({
        repeatMode:
          state.repeatMode === "off"
            ? "all"
            : state.repeatMode === "all"
              ? "one"
              : "off",
      })),
    setShuffleEnabled: (shuffleEnabled) => set({ shuffleEnabled }),
    setRepeatMode: (repeatMode) => set({ repeatMode }),

    // Queue management
    setQueue: (queue) =>
      set((state) => ({
        queue: typeof queue === "function" ? queue(state.queue) : queue,
      })),

    addToQueue: (trackIds) =>
      set((state) => ({ queue: [...state.queue, ...trackIds] })),

    playNext: (trackIds) =>
      set((state) => ({ queue: [...trackIds, ...state.queue] })),

    removeFromQueue: (index) =>
      set((state) => ({ queue: state.queue.filter((_, i) => i !== index) })),

    clearQueue: () => set({ queue: [] }),

    reorderQueue: (fromIndex, toIndex) =>
      set((state) => {
        const newQueue = [...state.queue];
        const [removed] = newQueue.splice(fromIndex, 1);
        newQueue.splice(toIndex, 0, removed);
        return { queue: newQueue };
      }),

    setPlayingNext: (trackIds) =>
      set((state) => ({
        playingNext: typeof trackIds === "function" ? trackIds(state.playingNext) : trackIds,
      })),

    reorderPlayingNext: (fromIndex, toIndex) =>
      set((state) => {
        const nextTracks = [...state.playingNext];
        const [removed] = nextTracks.splice(fromIndex, 1);
        nextTracks.splice(toIndex, 0, removed);
        return { playingNext: nextTracks };
      }),

    movePlayingNextToQueue: (fromIndex, toIndex) =>
      set((state) => {
        if (fromIndex < 0 || fromIndex >= state.playingNext.length) return state;
        const nextTracks = [...state.playingNext];
        const [movedTrackId] = nextTracks.splice(fromIndex, 1);
        const nextQueue = [...state.queue];
        const resolvedIndex = Math.max(0, Math.min(toIndex, nextQueue.length));
        nextQueue.splice(resolvedIndex, 0, movedTrackId);
        return { playingNext: nextTracks, queue: nextQueue };
      }),

    // Reset
    reset: () => set(initialState),
  }))
);

// Helper to convert Track to CurrentTrack
export const trackToCurrentTrack = (track: Track): CurrentTrack => ({
  id: track.id,
  title: track.title,
  artist: track.artist,
  album: track.album,
  sourcePath: track.sourcePath,
  durationSeconds: track.durationSeconds,
  coverArtPath: track.coverArtPath,
  coverArtThumbPath: track.coverArtThumbPath,
});

// Selectors
export const selectQueueTracks = (
  state: PlaybackStore,
  allTracks: Track[]
): Track[] => {
  return state.queue
    .map((id) => allTracks.find((t) => t.id === id))
    .filter((t): t is Track => t !== undefined);
};
