import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ColumnConfig } from "../types";
import type { PlaylistDropOperation } from "../hooks/useFileImport";
import {
  DEFAULT_ADVANCED_TRACK_FILTERS,
  type AdvancedTrackFilters,
} from "../utils/trackFilters";

export type SortState = {
  key: ColumnConfig["key"];
  direction: "asc" | "desc";
} | null;

type StoredSortState = Exclude<SortState, null>;

type UIState = {
  // Selection
  selectedIds: Set<string>;
  activeIndex: number | null;

  // Sorting
  sortState: SortState;
  sortViewKey: string;
  sortStates: Record<string, StoredSortState>;

  // Search
  searchQuery: string;
  advancedTrackFilters: AdvancedTrackFilters;

  // Modals
  analysisTrackIds: string[];
  isAnalysisModalMinimized: boolean;
  editTrackIds: string[];
  pendingPlaylistDrop: PlaylistDropOperation | null;
  isPlaylistModalOpen: boolean;
  playlistModalName: string;
  playlistEditState: { id: string; name: string } | null;

  // Import progress
  importProgress: {
    imported: number;
    total: number;
    phase: "scanning" | "importing";
  } | null;
};

type UIActions = {
  // Selection
  setSelectedIds: (ids: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  setActiveIndex: (index: number | null) => void;
  selectTrack: (
    index: number,
    id: string,
    options?: { isMetaKey?: boolean; isShiftKey?: boolean },
    tracks?: { id: string }[]
  ) => void;
  selectAll: (trackIds: string[]) => void;
  clearSelection: () => void;

  // Sorting
  activateSortView: (viewKey: string) => void;
  setSortState: (state: SortState) => void;
  toggleSort: (key: ColumnConfig["key"]) => void;

  // Search
  setSearchQuery: (query: string) => void;
  setAdvancedTrackFilters: (
    filters: AdvancedTrackFilters | ((current: AdvancedTrackFilters) => AdvancedTrackFilters),
  ) => void;
  resetAdvancedTrackFilters: () => void;

  // Analysis modal
  openAnalysisModal: (trackIds: string[]) => void;
  closeAnalysisModal: () => void;
  minimizeAnalysisModal: () => void;
  restoreAnalysisModal: () => void;

  // Edit modal
  openEditModal: (trackIds: string[]) => void;
  closeEditModal: () => void;

  // Playlist drop
  setPendingPlaylistDrop: (drop: PlaylistDropOperation | null) => void;

  // Playlist create modal
  openPlaylistModal: () => void;
  closePlaylistModal: () => void;
  setPlaylistModalName: (name: string) => void;

  // Playlist edit modal
  openPlaylistEdit: (id: string, name: string) => void;
  closePlaylistEdit: () => void;
  setPlaylistEditName: (name: string) => void;

  // Import progress
  setImportProgress: (progress: UIState["importProgress"]) => void;
};

export type UIStore = UIState & UIActions;

export const useUIStore = create<UIStore>()(persist((set, get) => ({
  // State
  selectedIds: new Set<string>(),
  activeIndex: null,
  sortState: null,
  sortViewKey: "library",
  sortStates: {},
  searchQuery: "",
  advancedTrackFilters: { ...DEFAULT_ADVANCED_TRACK_FILTERS },
  analysisTrackIds: [],
  isAnalysisModalMinimized: false,
  editTrackIds: [],
  pendingPlaylistDrop: null,
  isPlaylistModalOpen: false,
  playlistModalName: "",
  playlistEditState: null,
  importProgress: null,

  // Selection Actions
  setSelectedIds: (ids) =>
    set((state) => ({
      selectedIds: typeof ids === "function" ? ids(state.selectedIds) : ids,
    })),

  setActiveIndex: (activeIndex) => set({ activeIndex }),

  selectTrack: (index, id, options, tracks) => {
    const { isMetaKey, isShiftKey } = options ?? {};
    const state = get();

    if (isShiftKey && state.activeIndex !== null && tracks) {
      // Range selection
      const start = Math.min(state.activeIndex, index);
      const end = Math.max(state.activeIndex, index);
      const rangeIds = tracks.slice(start, end + 1).map((t) => t.id);
      set({
        selectedIds: new Set([...state.selectedIds, ...rangeIds]),
        activeIndex: index,
      });
    } else if (isMetaKey) {
      // Toggle selection
      const newSelected = new Set(state.selectedIds);
      if (newSelected.has(id)) {
        newSelected.delete(id);
      } else {
        newSelected.add(id);
      }
      set({ selectedIds: newSelected, activeIndex: index });
    } else {
      // Single selection
      set({ selectedIds: new Set([id]), activeIndex: index });
    }
  },

  selectAll: (trackIds) =>
    set({ selectedIds: new Set(trackIds), activeIndex: trackIds.length > 0 ? 0 : null }),

  clearSelection: () => set({ selectedIds: new Set(), activeIndex: null }),

  // Sorting Actions
  activateSortView: (sortViewKey) => set((state) => ({
    sortViewKey,
    sortState: state.sortStates[sortViewKey] ?? null,
  })),

  setSortState: (sortState) => set((state) => {
    const sortStates = { ...state.sortStates };
    if (sortState) sortStates[state.sortViewKey] = sortState;
    else delete sortStates[state.sortViewKey];
    return { sortState, sortStates };
  }),

  toggleSort: (key) =>
    set((state) => {
      let sortState: SortState;
      if (!state.sortState || state.sortState.key !== key) {
        sortState = { key, direction: "asc" };
      } else if (state.sortState.direction === "asc") {
        sortState = { key, direction: "desc" };
      } else {
        sortState = null;
      }
      const sortStates = { ...state.sortStates };
      if (sortState) sortStates[state.sortViewKey] = sortState;
      else delete sortStates[state.sortViewKey];
      return { sortState, sortStates };
    }),

  // Search
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setAdvancedTrackFilters: (filters) => set((state) => ({
    advancedTrackFilters: typeof filters === "function"
      ? filters(state.advancedTrackFilters)
      : filters,
  })),
  resetAdvancedTrackFilters: () => set({
    advancedTrackFilters: { ...DEFAULT_ADVANCED_TRACK_FILTERS, missingMetadata: [] },
  }),

  // Analysis Modal
  openAnalysisModal: (trackIds) => set({
    analysisTrackIds: trackIds,
    isAnalysisModalMinimized: false,
  }),
  closeAnalysisModal: () => set({
    analysisTrackIds: [],
    isAnalysisModalMinimized: false,
  }),
  minimizeAnalysisModal: () => set({ isAnalysisModalMinimized: true }),
  restoreAnalysisModal: () => set({ isAnalysisModalMinimized: false }),

  // Edit Modal
  openEditModal: (trackIds) => set({ editTrackIds: trackIds }),
  closeEditModal: () => set({ editTrackIds: [] }),

  // Playlist Drop
  setPendingPlaylistDrop: (pendingPlaylistDrop) => set({ pendingPlaylistDrop }),

  // Playlist Create Modal
  openPlaylistModal: () => set({ isPlaylistModalOpen: true, playlistModalName: "" }),
  closePlaylistModal: () => set({ isPlaylistModalOpen: false, playlistModalName: "" }),
  setPlaylistModalName: (playlistModalName) => set({ playlistModalName }),

  // Playlist Edit Modal
  openPlaylistEdit: (id, name) => set({ playlistEditState: { id, name } }),
  closePlaylistEdit: () => set({ playlistEditState: null }),
  setPlaylistEditName: (name) =>
    set((state) =>
      state.playlistEditState
        ? { playlistEditState: { ...state.playlistEditState, name } }
        : {}
    ),

  // Import Progress
  setImportProgress: (importProgress) => set({ importProgress }),
}), {
  name: "muro-ui-preferences",
  partialize: (state) => ({ sortStates: state.sortStates }),
}));

// Selectors
export const selectIsAnalysisModalOpen = (state: UIStore) =>
  state.analysisTrackIds.length > 0;

export const selectIsPlaylistEditOpen = (state: UIStore) =>
  state.playlistEditState !== null;

export const selectIsEditModalOpen = (state: UIStore) =>
  state.editTrackIds.length > 0;
