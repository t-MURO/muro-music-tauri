import { create } from "zustand";
import type { Playlist, PlaylistFolder, Track } from "../types";

type LibraryState = {
  tracks: Track[];
  inboxTracks: Track[];
  playlists: Playlist[];
  playlistFolders: PlaylistFolder[];
  allTracks: Track[];
};

type LibraryActions = {
  // Tracks
  setTracks: (tracks: Track[] | ((prev: Track[]) => Track[])) => void;
  updateTrack: (id: string, updates: Partial<Track>) => void;

  // Inbox
  setInboxTracks: (tracks: Track[] | ((prev: Track[]) => Track[])) => void;
  moveToLibrary: (trackIds: string[]) => void;
  moveToInbox: (trackIds: string[]) => void;

  // Playlists
  setPlaylists: (playlists: Playlist[] | ((prev: Playlist[]) => Playlist[])) => void;
  setPlaylistFolders: (
    folders: PlaylistFolder[] | ((prev: PlaylistFolder[]) => PlaylistFolder[])
  ) => void;
  addPlaylist: (playlist: Playlist) => void;
  updatePlaylist: (id: string, updates: Partial<Playlist>) => void;
  deletePlaylist: (id: string) => void;
  addTracksToPlaylist: (playlistId: string, trackIds: string[]) => void;
  removeTracksFromPlaylist: (playlistId: string, count: number) => void;
  addPlaylistFolder: (folder: PlaylistFolder) => void;
  updatePlaylistFolder: (id: string, updates: Partial<PlaylistFolder>) => void;
  deletePlaylistFolder: (id: string) => void;
};

export type LibraryStore = LibraryState & LibraryActions;

export const useLibraryStore = create<LibraryStore>((set) => ({
  // State
  tracks: [],
  inboxTracks: [],
  playlists: [],
  playlistFolders: [],
  allTracks: [],

  // Track Actions
  setTracks: (tracks) =>
    set((state) => {
      const newTracks = typeof tracks === "function" ? tracks(state.tracks) : tracks;
      return {
        tracks: newTracks,
        allTracks: [...newTracks, ...state.inboxTracks],
      };
    }),

  updateTrack: (id, updates) =>
    set((state) => {
      const newTracks = state.tracks.map((t) => (t.id === id ? { ...t, ...updates } : t));
      const newInboxTracks = state.inboxTracks.map((t) =>
        t.id === id ? { ...t, ...updates } : t
      );
      return {
        tracks: newTracks,
        inboxTracks: newInboxTracks,
        allTracks: [...newTracks, ...newInboxTracks],
      };
    }),

  // Inbox Actions
  setInboxTracks: (tracks) =>
    set((state) => {
      const newInboxTracks = typeof tracks === "function" ? tracks(state.inboxTracks) : tracks;
      return {
        inboxTracks: newInboxTracks,
        allTracks: [...state.tracks, ...newInboxTracks],
      };
    }),

  moveToLibrary: (trackIds) => {
    const idSet = new Set(trackIds);
    set((state) => {
      const tracksToMove = state.inboxTracks.filter((t) => idSet.has(t.id));
      const newTracks = [...tracksToMove, ...state.tracks];
      const newInboxTracks = state.inboxTracks.filter((t) => !idSet.has(t.id));
      return {
        inboxTracks: newInboxTracks,
        tracks: newTracks,
        allTracks: [...newTracks, ...newInboxTracks],
      };
    });
  },

  moveToInbox: (trackIds) => {
    const idSet = new Set(trackIds);
    set((state) => {
      const tracksToMove = state.tracks.filter((t) => idSet.has(t.id));
      const newTracks = state.tracks.filter((t) => !idSet.has(t.id));
      const newInboxTracks = [...tracksToMove, ...state.inboxTracks];
      return {
        tracks: newTracks,
        inboxTracks: newInboxTracks,
        allTracks: [...newTracks, ...newInboxTracks],
      };
    });
  },

  // Playlist Actions
  setPlaylists: (playlists) =>
    set((state) => ({
      playlists:
        typeof playlists === "function" ? playlists(state.playlists) : playlists,
    })),

  setPlaylistFolders: (folders) =>
    set((state) => ({
      playlistFolders:
        typeof folders === "function" ? folders(state.playlistFolders) : folders,
    })),

  addPlaylist: (playlist) =>
    set((state) => ({ playlists: [...state.playlists, playlist] })),

  updatePlaylist: (id, updates) =>
    set((state) => ({
      playlists: state.playlists.map((p) =>
        p.id === id ? { ...p, ...updates } : p
      ),
    })),

  deletePlaylist: (id) =>
    set((state) => ({
      playlists: state.playlists.filter((p) => p.id !== id),
    })),

  addTracksToPlaylist: (playlistId, trackIds) =>
    set((state) => ({
      playlists: state.playlists.map((p) =>
        p.id === playlistId
          ? { ...p, trackIds: [...p.trackIds, ...trackIds] }
          : p
      ),
    })),

  removeTracksFromPlaylist: (playlistId, count) =>
    set((state) => ({
      playlists: state.playlists.map((p) =>
        p.id === playlistId
          ? { ...p, trackIds: p.trackIds.slice(0, -count) }
          : p
      ),
    })),

  addPlaylistFolder: (folder) =>
    set((state) => ({ playlistFolders: [...state.playlistFolders, folder] })),

  updatePlaylistFolder: (id, updates) =>
    set((state) => ({
      playlistFolders: state.playlistFolders.map((folder) =>
        folder.id === id ? { ...folder, ...updates } : folder
      ),
    })),

  deletePlaylistFolder: (id) =>
    set((state) => {
      const parentId = state.playlistFolders.find((folder) => folder.id === id)?.parentId;
      return {
        playlistFolders: state.playlistFolders
          .filter((folder) => folder.id !== id)
          .map((folder) => folder.parentId === id ? { ...folder, parentId } : folder),
        playlists: state.playlists.map((playlist) =>
          playlist.folderId === id ? { ...playlist, folderId: parentId } : playlist
        ),
      };
    }),
}));

// Selectors
export const selectAllTracks = (state: LibraryStore) => state.allTracks;

export const selectPlaylistTracks = (state: LibraryStore, playlistId: string) => {
  const playlist = state.playlists.find((p) => p.id === playlistId);
  if (!playlist) return [];
  const allTracks = [...state.tracks, ...state.inboxTracks];
  return playlist.trackIds
    .map((id) => allTracks.find((t) => t.id === id))
    .filter((t): t is Track => t !== undefined);
};

export const selectTrackById = (state: LibraryStore): Map<string, Track> => {
  const map = new Map<string, Track>();
  for (const track of state.tracks) {
    map.set(track.id, track);
  }
  for (const track of state.inboxTracks) {
    map.set(track.id, track);
  }
  return map;
};
