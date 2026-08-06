import { create } from "zustand";
import type { Track } from "../types";

export type RecentlyPlayedStore = {
  recentlyPlayedTracks: Track[];
  playSessionTrackId: string | null;
  hasRecordedPlay: boolean;

  setRecentlyPlayedTracks: (tracks: Track[]) => void;
  addRecentlyPlayed: (track: Track, playedAt?: string) => void;
  startPlaySession: (trackId: string) => void;
  markPlayRecorded: () => void;
};

export const useRecentlyPlayedStore = create<RecentlyPlayedStore>((set, get) => ({
  recentlyPlayedTracks: [],
  playSessionTrackId: null,
  hasRecordedPlay: false,

  setRecentlyPlayedTracks: (tracks) => set({ recentlyPlayedTracks: tracks }),

  addRecentlyPlayed: (track, playedAt) => {
    const { recentlyPlayedTracks } = get();
    // Remove the track if it already exists, then add to the front
    const filtered = recentlyPlayedTracks.filter((t) => t.id !== track.id);
    // Update play count on the track
    const updatedTrack = {
      ...track,
      lastPlayedAt: playedAt ?? new Date().toISOString(),
      playCount: (track.playCount || 0) + 1,
    };
    set({ recentlyPlayedTracks: [updatedTrack, ...filtered] });
  },

  startPlaySession: (trackId) => {
    const { playSessionTrackId } = get();
    // Only reset if switching to a different track
    if (trackId !== playSessionTrackId) {
      set({ playSessionTrackId: trackId, hasRecordedPlay: false });
    }
  },

  markPlayRecorded: () => set({ hasRecordedPlay: true }),
}));
