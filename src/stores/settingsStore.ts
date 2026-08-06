import { create } from "zustand";
import { persist } from "zustand/middleware";
import { isLocale, setLocale as setI18nLocale, type Locale } from "../i18n";
import type { MixBars } from "../lib/mix/config";
import type { ReplayGainMode } from "../utils/replayGain";
import { artistSeparatorExceptionKey } from "../lib/metadata/artistSeparators";
import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  normalizeShortcutMap,
  type KeyboardShortcutMap,
  type ShortcutAction,
} from "../keyboard/shortcuts";

export type AnalysisOutputMode = "none" | "prepend" | "append" | "overwrite";
export type AnalysisNotationMode = "standard" | "custom" | "combined" | "djCombined";
export type AnalysisPerformanceMode = "stable" | "fast" | "maximum";
export type DeleteMode = "library" | "disk";
export type ThemeMode = "system" | "dark" | "light";
export type { MixBars } from "../lib/mix/config";
export type AnalysisOutputs = {
  comment: AnalysisOutputMode;
  grouping: AnalysisOutputMode;
  initialKey: AnalysisOutputMode;
  bpm: "none" | "overwrite";
};

const DEFAULT_CUSTOM_CODES = [
  "11B", "8A", "6B", "3A", "1B", "10A", "8B", "5A", "3B", "12A", "10B", "7A",
  "5B", "2A", "12B", "9A", "7B", "4A", "2B", "11A", "9B", "6A", "4B", "1A", "",
];

const DEFAULT_ANALYSIS_OUTPUTS: AnalysisOutputs = {
  comment: "none",
  grouping: "none",
  initialKey: "none",
  bpm: "none",
};

const normalizeThemeMode = (theme: unknown): ThemeMode => {
  if (theme === "system" || theme === "light") return theme;
  return "dark";
};

export const applyThemeMode = (theme: ThemeMode) => {
  if (typeof document === "undefined") return;

  const resolvedTheme = theme === "system"
    && typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";

  document.documentElement.dataset.theme = theme === "system" ? resolvedTheme : theme;
  document.documentElement.style.colorScheme = resolvedTheme;
};

type SettingsState = {
  theme: ThemeMode;
  locale: Locale;
  seekMode: "fast" | "accurate";
  dbPath: string;
  dbFileName: string;
  useAutoDbPath: boolean;
  analysisNotation: AnalysisNotationMode;
  analysisCustomCodes: string[];
  analysisDelimiter: string;
  analysisOutputs: AnalysisOutputs;
  analysisPerformance: AnalysisPerformanceMode;
  lastDeleteMode: DeleteMode;
  djMixEnabled: boolean;
  autoMix: boolean;
  mixBars: MixBars;
  mixPreservePitch: boolean;
  lastFmApiKey: string;
  theAudioDbApiKey: string;
  fanartApiKey: string;
  braveSearchApiKey: string;
  acoustIdClientKey: string;
  audioOutputDeviceId: string;
  audioOutputDeviceLabel: string;
  gaplessEnabled: boolean;
  /** Seconds of overlap between tracks; 0 keeps the plain gapless hand-off. */
  crossfadeSeconds: number;
  replayGainMode: ReplayGainMode;
  replayGainPreampDb: number;
  replayGainPreventClipping: boolean;
  /** ReplayGain 2.0 pins this at -18 LUFS; -14 matches streaming services. */
  replayGainReferenceLufs: number;
  watchFolderEnabled: boolean;
  /** Sole absolute path used as the library root and optionally watched for new audio. */
  watchedFolder: string;
  /** Move accepted watched-folder imports into Album Artist / Album folders. */
  organizeAcceptedTracks: boolean;
  recentlyAddedPeriodDays: 1 | 7 | 30;
  /** Exact artist/album-artist names ignored by separator cleanup. */
  artistSeparatorExceptions: string[];
  keyboardShortcuts: KeyboardShortcutMap;
};

type SettingsActions = {
  setTheme: (theme: ThemeMode) => void;
  setLocale: (locale: Locale) => void;
  setSeekMode: (mode: "fast" | "accurate") => void;
  setDbPath: (path: string) => void;
  setDbFileName: (name: string) => void;
  setUseAutoDbPath: (auto: boolean) => void;
  setAnalysisNotation: (notation: AnalysisNotationMode) => void;
  setAnalysisCustomCode: (index: number, value: string) => void;
  setAnalysisDelimiter: (delimiter: string) => void;
  setAnalysisOutput: <K extends keyof AnalysisOutputs>(field: K, mode: AnalysisOutputs[K]) => void;
  setAnalysisPerformance: (performance: AnalysisPerformanceMode) => void;
  setLastDeleteMode: (mode: DeleteMode) => void;
  setDjMixEnabled: (djMixEnabled: boolean) => void;
  setAutoMix: (autoMix: boolean) => void;
  setMixBars: (mixBars: MixBars) => void;
  setMixPreservePitch: (mixPreservePitch: boolean) => void;
  setLastFmApiKey: (lastFmApiKey: string) => void;
  setTheAudioDbApiKey: (theAudioDbApiKey: string) => void;
  setFanartApiKey: (fanartApiKey: string) => void;
  setBraveSearchApiKey: (braveSearchApiKey: string) => void;
  setAcoustIdClientKey: (acoustIdClientKey: string) => void;
  setAudioOutputDevice: (deviceId: string, label: string) => void;
  setGaplessEnabled: (enabled: boolean) => void;
  setCrossfadeSeconds: (seconds: number) => void;
  setReplayGainMode: (mode: ReplayGainMode) => void;
  setReplayGainPreampDb: (preampDb: number) => void;
  setReplayGainPreventClipping: (preventClipping: boolean) => void;
  setReplayGainReferenceLufs: (referenceLufs: number) => void;
  setWatchFolderEnabled: (enabled: boolean) => void;
  setOrganizeAcceptedTracks: (enabled: boolean) => void;
  setWatchedFolder: (folder: string) => void;
  setRecentlyAddedPeriodDays: (days: 1 | 7 | 30) => void;
  addArtistSeparatorException: (artist: string) => void;
  removeArtistSeparatorException: (artist: string) => void;
  clearArtistSeparatorExceptions: () => void;
  setKeyboardShortcut: (action: ShortcutAction, shortcut: string) => void;
  resetKeyboardShortcuts: () => void;
};

export type SettingsStore = SettingsState & SettingsActions;

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      // State
      theme: "dark",
      locale: "en",
      seekMode: "fast",
      dbPath: "",
      dbFileName: "muro.db",
      useAutoDbPath: true,
      analysisNotation: "custom",
      analysisCustomCodes: [...DEFAULT_CUSTOM_CODES],
      analysisDelimiter: " - ",
      analysisOutputs: { ...DEFAULT_ANALYSIS_OUTPUTS },
      analysisPerformance: "stable",
      lastDeleteMode: "library",
      djMixEnabled: false,
      autoMix: false,
      mixBars: 8,
      mixPreservePitch: true,
      lastFmApiKey: "",
      theAudioDbApiKey: "",
      fanartApiKey: "",
      braveSearchApiKey: "",
      acoustIdClientKey: "",
      audioOutputDeviceId: "",
      audioOutputDeviceLabel: "",
      gaplessEnabled: true,
      crossfadeSeconds: 0,
      replayGainMode: "off",
      replayGainPreampDb: 0,
      replayGainPreventClipping: true,
      replayGainReferenceLufs: -18,
      watchFolderEnabled: false,
      watchedFolder: "",
      organizeAcceptedTracks: true,
      recentlyAddedPeriodDays: 30,
      artistSeparatorExceptions: [],
      keyboardShortcuts: { ...DEFAULT_KEYBOARD_SHORTCUTS },

      // Actions
      setTheme: (theme) => {
        set({ theme });
        applyThemeMode(theme);
      },
      setLocale: (locale) => {
        set({ locale });
        setI18nLocale(locale);
      },
      setSeekMode: (seekMode) => set({ seekMode }),
      setDbPath: (dbPath) => set({ dbPath, useAutoDbPath: false }),
      setDbFileName: (dbFileName) => set({ dbFileName, useAutoDbPath: true }),
      setUseAutoDbPath: (useAutoDbPath) => set({ useAutoDbPath }),
      setAnalysisNotation: (analysisNotation) => set({ analysisNotation }),
      setAnalysisCustomCode: (index, value) => set((state) => {
        const analysisCustomCodes = [...state.analysisCustomCodes];
        analysisCustomCodes[index] = value;
        return { analysisCustomCodes };
      }),
      setAnalysisDelimiter: (analysisDelimiter) => set({ analysisDelimiter }),
      setAnalysisOutput: (field, mode) => set((state) => ({
        analysisOutputs: { ...state.analysisOutputs, [field]: mode },
      })),
      setAnalysisPerformance: (analysisPerformance) => set({ analysisPerformance }),
      setLastDeleteMode: (lastDeleteMode) => set({ lastDeleteMode }),
      setDjMixEnabled: (djMixEnabled) => set((state) => ({
        djMixEnabled,
        autoMix: djMixEnabled ? state.autoMix : false,
      })),
      setAutoMix: (autoMix) => set({ autoMix }),
      setMixBars: (mixBars) => set({ mixBars }),
      setMixPreservePitch: (mixPreservePitch) => set({ mixPreservePitch }),
      setLastFmApiKey: (lastFmApiKey) => set({ lastFmApiKey }),
      setTheAudioDbApiKey: (theAudioDbApiKey) => set({ theAudioDbApiKey }),
      setFanartApiKey: (fanartApiKey) => set({ fanartApiKey }),
      setBraveSearchApiKey: (braveSearchApiKey) => set({ braveSearchApiKey }),
      setAcoustIdClientKey: (acoustIdClientKey) => set({ acoustIdClientKey }),
      setAudioOutputDevice: (audioOutputDeviceId, audioOutputDeviceLabel) =>
        set({ audioOutputDeviceId, audioOutputDeviceLabel }),
      setGaplessEnabled: (gaplessEnabled) => set({ gaplessEnabled }),
      setCrossfadeSeconds: (seconds) =>
        set({ crossfadeSeconds: Math.max(0, Math.min(12, seconds)) }),
      setReplayGainMode: (replayGainMode) => set({ replayGainMode }),
      setReplayGainPreampDb: (preampDb) =>
        set({ replayGainPreampDb: Math.max(-15, Math.min(15, preampDb)) }),
      setReplayGainPreventClipping: (replayGainPreventClipping) =>
        set({ replayGainPreventClipping }),
      setReplayGainReferenceLufs: (referenceLufs) =>
        set({ replayGainReferenceLufs: Math.max(-30, Math.min(-5, referenceLufs)) }),
      setWatchFolderEnabled: (watchFolderEnabled) => set({ watchFolderEnabled }),
      setOrganizeAcceptedTracks: (organizeAcceptedTracks) =>
        set({ organizeAcceptedTracks }),
      setWatchedFolder: (watchedFolder) => set({ watchedFolder }),
      setRecentlyAddedPeriodDays: (recentlyAddedPeriodDays) =>
        set({ recentlyAddedPeriodDays }),
      addArtistSeparatorException: (artist) => set((state) => {
        const value = artist.normalize("NFKC").replace(/\s+/g, " ").trim();
        const key = artistSeparatorExceptionKey(value);
        if (!key || state.artistSeparatorExceptions.some(
          (entry) => artistSeparatorExceptionKey(entry) === key
        )) {
          return {};
        }
        return {
          artistSeparatorExceptions: [...state.artistSeparatorExceptions, value].slice(-1000),
        };
      }),
      removeArtistSeparatorException: (artist) => set((state) => {
        const key = artistSeparatorExceptionKey(artist);
        return {
          artistSeparatorExceptions: state.artistSeparatorExceptions.filter(
            (entry) => artistSeparatorExceptionKey(entry) !== key
          ),
        };
      }),
      clearArtistSeparatorExceptions: () => set({ artistSeparatorExceptions: [] }),
      setKeyboardShortcut: (action, shortcut) => set((state) => ({
        keyboardShortcuts: { ...state.keyboardShortcuts, [action]: shortcut },
      })),
      resetKeyboardShortcuts: () =>
        set({ keyboardShortcuts: { ...DEFAULT_KEYBOARD_SHORTCUTS } }),
    }),
    {
      name: "muro-settings",
      version: 7,
      partialize: (state) => ({
        theme: state.theme,
        locale: state.locale,
        seekMode: state.seekMode,
        dbPath: state.dbPath,
        dbFileName: state.dbFileName,
        useAutoDbPath: state.useAutoDbPath,
        analysisNotation: state.analysisNotation,
        analysisCustomCodes: state.analysisCustomCodes,
        analysisDelimiter: state.analysisDelimiter,
        analysisOutputs: state.analysisOutputs,
        analysisPerformance: state.analysisPerformance,
        lastDeleteMode: state.lastDeleteMode,
        djMixEnabled: state.djMixEnabled,
        autoMix: state.autoMix,
        mixBars: state.mixBars,
        mixPreservePitch: state.mixPreservePitch,
        lastFmApiKey: state.lastFmApiKey,
        theAudioDbApiKey: state.theAudioDbApiKey,
        fanartApiKey: state.fanartApiKey,
        braveSearchApiKey: state.braveSearchApiKey,
        acoustIdClientKey: state.acoustIdClientKey,
        audioOutputDeviceId: state.audioOutputDeviceId,
        audioOutputDeviceLabel: state.audioOutputDeviceLabel,
        gaplessEnabled: state.gaplessEnabled,
        crossfadeSeconds: state.crossfadeSeconds,
        replayGainMode: state.replayGainMode,
        replayGainPreampDb: state.replayGainPreampDb,
        replayGainPreventClipping: state.replayGainPreventClipping,
        replayGainReferenceLufs: state.replayGainReferenceLufs,
        watchFolderEnabled: state.watchFolderEnabled,
        watchedFolder: state.watchedFolder,
        organizeAcceptedTracks: state.organizeAcceptedTracks,
        recentlyAddedPeriodDays: state.recentlyAddedPeriodDays,
        artistSeparatorExceptions: state.artistSeparatorExceptions,
        keyboardShortcuts: state.keyboardShortcuts,
      }),
      migrate: (persistedState) => {
        if (!persistedState || typeof persistedState !== "object") return persistedState;
        const persisted = persistedState as Partial<SettingsState> & {
          watchFoldersEnabled?: unknown;
          watchedFolders?: unknown;
        };
        return { ...persisted, theme: normalizeThemeMode(persisted.theme) };
      },
      merge: (persistedState, currentState) => {
        const persisted = persistedState && typeof persistedState === "object"
          ? persistedState as Partial<SettingsState> & {
              watchFoldersEnabled?: unknown;
              watchedFolders?: unknown;
            }
          : {};
        const {
          watchFoldersEnabled: legacyWatchFoldersEnabled,
          watchedFolders: legacyWatchedFolders,
          ...persistedSettings
        } = persisted;
        const savedCustomCodes = Array.isArray(persisted.analysisCustomCodes)
          ? persisted.analysisCustomCodes
          : [];
        const watchedFolder = typeof persisted.watchedFolder === "string"
          ? persisted.watchedFolder.trim()
          : Array.isArray(legacyWatchedFolders)
            ? legacyWatchedFolders.find(
                (folder): folder is string => typeof folder === "string" && folder.trim().length > 0,
              )?.trim() ?? ""
            : "";
        const watchFolderEnabled = typeof persisted.watchFolderEnabled === "boolean"
          ? persisted.watchFolderEnabled
          : legacyWatchFoldersEnabled === true;
        const artistSeparatorExceptions = Array.isArray(persisted.artistSeparatorExceptions)
          ? [...new Map(
              persisted.artistSeparatorExceptions
                .filter((value): value is string => typeof value === "string")
                .map((value) => value.normalize("NFKC").replace(/\s+/g, " ").trim())
                .filter(Boolean)
                .map((value) => [artistSeparatorExceptionKey(value), value]),
            ).values()].slice(0, 1000)
          : [];

        return {
          ...currentState,
          ...persistedSettings,
          watchFolderEnabled,
          watchedFolder,
          artistSeparatorExceptions,
          theme: normalizeThemeMode(persisted.theme),
          // Analysis settings are a nested group. Merge them with their defaults so
          // settings written by older versions cannot discard newer Key/BPM fields.
          analysisCustomCodes: DEFAULT_CUSTOM_CODES.map((fallback, index) =>
            typeof savedCustomCodes[index] === "string"
              ? savedCustomCodes[index]
              : fallback
          ),
          analysisOutputs: {
            ...DEFAULT_ANALYSIS_OUTPUTS,
            ...(persisted.analysisOutputs ?? {}),
          },
          recentlyAddedPeriodDays:
            persisted.recentlyAddedPeriodDays === 1
            || persisted.recentlyAddedPeriodDays === 7
            || persisted.recentlyAddedPeriodDays === 30
              ? persisted.recentlyAddedPeriodDays
              : 30,
          keyboardShortcuts: normalizeShortcutMap(persisted.keyboardShortcuts),
        };
      },
      onRehydrateStorage: () => (state) => {
        if (state) {
          // Apply theme on rehydrate
          if (typeof document !== "undefined") {
            applyThemeMode(state.theme);
          }
          // Apply locale on rehydrate
          if (isLocale(state.locale)) {
            setI18nLocale(state.locale);
          }
        }
      },
    }
  )
);
