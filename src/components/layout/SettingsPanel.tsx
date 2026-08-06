import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AudioWaveform,
  ChevronDown,
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  FolderOutput,
  Gauge,
  Monitor,
  Moon,
  Replace,
  Search,
  Settings2,
  ShieldAlert,
  Sun,
  Tags,
  type LucideIcon,
} from "lucide-react";
import { t, type Locale } from "../../i18n";
import { openExternal } from "../../desktop/shell";
import { MIX_BAR_OPTIONS } from "../../lib/mix/config";
import { useLoudnessAnalysis } from "../../hooks/useLoudnessAnalysis";
import { useLibraryOrganization } from "../../hooks/useLibraryOrganization";
import { useLibraryVerification } from "../../hooks/useLibraryVerification";
import { useWatchedFolders } from "../../hooks/useWatchedFolders";
import { MissingTracksModal } from "../ui/MissingTracksModal";
import { MisplacedTracksModal } from "../ui/MisplacedTracksModal";
import { LibraryDataTools } from "./LibraryDataTools";
import { KeyboardShortcutSettings } from "./KeyboardShortcutSettings";
import type { ReplayGainMode } from "../../utils/replayGain";
import {
  useSettingsStore,
  type AnalysisNotationMode,
  type AnalysisOutputMode,
  type AnalysisOutputs,
  type MixBars,
  type ThemeMode,
} from "../../stores";

type SettingsPanelProps = {
  theme: ThemeMode;
  locale: Locale;
  themes: ReadonlyArray<{ id: ThemeMode; label: string }>;
  localeOptions: ReadonlyArray<{ id: string; label: string }>;
  dbPath: string;
  dbFileName: string;
  backfillPending: boolean;
  backfillStatus: string | null;
  coverArtBackfillPending: boolean;
  coverArtBackfillStatus: string | null;
  artistSeparatorCandidateCount: number;
  organizedLibraryExportPending: boolean;
  organizedLibraryExportStatus: string | null;
  clearSongsPending: boolean;
  seekMode: "fast" | "accurate";
  onThemeChange: (theme: ThemeMode) => void;
  onLocaleChange: (locale: Locale) => void;
  onSeekModeChange: (mode: "fast" | "accurate") => void;
  onDbPathChange: (value: string) => void;
  onDbFileNameChange: (value: string) => void;
  onBackfillSearchText: () => void;
  onBackfillCoverArt: () => void;
  onReviewArtistSeparators: () => void;
  onExportOrganizedLibrary: (useAsCurrentLibrary: boolean) => void;
  onClearSongs: () => void;
  onUseDefaultLocation: () => void;
};

type SettingsSectionId =
  | "general"
  | "library"
  | "metadata"
  | "analysis"
  | "dj"
  | "advanced";

type SettingsSection = {
  id: SettingsSectionId;
  label: string;
  description: string;
  keywords: string;
  icon: LucideIcon;
};

const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    id: "general",
    label: "General",
    description: "Language, appearance, and playback",
    keywords: "language theme dark light system playback seek",
    icon: Settings2,
  },
  {
    id: "library",
    label: "Library & Files",
    description: "Database, export, and maintenance",
    keywords: "database path files export organize structure validate move artist album separator cache index artwork backup restore history snapshots keyboard shortcuts itunes music xml playlists",
    icon: Database,
  },
  {
    id: "metadata",
    label: "Metadata & Artwork",
    description: "Identification and online providers",
    keywords: "metadata artwork cover acoustid musicbrainz lastfm theaudiodb fanart brave deezer",
    icon: Tags,
  },
  {
    id: "analysis",
    label: "Key & BPM",
    description: "Analysis, notation, and tag output",
    keywords: "key bpm analysis camelot notation workers tags comment grouping",
    icon: Gauge,
  },
  {
    id: "dj",
    label: "DJ & Mixing",
    description: "Experimental transitions",
    keywords: "dj mix mixing transition beat grid automix pitch bars",
    icon: AudioWaveform,
  },
  {
    id: "advanced",
    label: "Advanced",
    description: "Developer and destructive actions",
    keywords: "advanced developer reset clear empty database danger",
    icon: ShieldAlert,
  },
];

const themeDescriptions: Record<string, { label: string; description: string }> = {
  system: { label: "System", description: "Follow your computer's light or dark preference" },
  light: { label: "Light", description: "Polished, spacious design with light colors" },
  dark: { label: "Dark", description: "The original Studio appearance" },
};

const themeIcons = {
  system: Monitor,
  dark: Moon,
  light: Sun,
};

const KEY_NAMES = [
  "A", "Am", "Bb", "Bbm", "B", "Bm", "C", "Cm", "Db", "Dbm", "D", "Dm",
  "Eb", "Ebm", "E", "Em", "F", "Fm", "Gb", "Gbm", "G", "Gm", "Ab", "Abm", "Unknown",
];

const ANALYSIS_OUTPUT_FIELDS: Array<{
  field: keyof AnalysisOutputs;
  label: string;
  bpmOnly?: boolean;
}> = [
  { field: "comment", label: "Comment" },
  { field: "grouping", label: "Grouping / custom field" },
  { field: "initialKey", label: "Initial Key" },
  { field: "bpm", label: "Detected BPM", bpmOnly: true },
];

const CROSSFADE_OPTIONS = [2, 3, 4, 6, 8, 12];

const inputClass =
  "h-[var(--input-height)] w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-[var(--spacing-md)] text-[var(--font-size-sm)] text-[var(--color-text-primary)] transition-all duration-[var(--transition-fast)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-4 focus:ring-[var(--color-accent-light)]";

const selectClass =
  `${inputClass} appearance-none pr-10`;

const primaryButtonClass =
  "flex h-[var(--button-height)] items-center gap-[var(--spacing-sm)] rounded-[var(--radius-md)] bg-[var(--color-accent)] px-[var(--spacing-md)] text-[var(--font-size-sm)] font-medium text-white transition-all duration-[var(--transition-fast)] hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50";

const secondaryButtonClass =
  "flex h-[var(--button-height)] items-center gap-[var(--spacing-sm)] rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-[var(--spacing-md)] text-[var(--font-size-sm)] font-medium text-[var(--color-text-primary)] transition-all duration-[var(--transition-fast)] hover:bg-[var(--color-bg-hover)] disabled:cursor-not-allowed disabled:opacity-60";

const SettingsPageHeader = ({
  title,
  description,
}: {
  title: string;
  description: string;
}) => (
  <header className="mb-6">
    <h2 className="text-[18px] font-semibold text-[var(--color-text-primary)]">{title}</h2>
    <p className="mt-1 text-[var(--font-size-sm)] text-[var(--color-text-secondary)]">
      {description}
    </p>
  </header>
);

const SettingsGroup = ({
  title,
  description,
  children,
  className = "",
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) => (
  <section className={`rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)] ${className}`}>
    <div className="border-b border-[var(--color-border-light)] px-5 py-4">
      <h3 className="text-[var(--font-size-sm)] font-semibold text-[var(--color-text-primary)]">
        {title}
      </h3>
      {description && (
        <p className="mt-1 text-[var(--font-size-xs)] leading-relaxed text-[var(--color-text-secondary)]">
          {description}
        </p>
      )}
    </div>
    <div className="p-5">{children}</div>
  </section>
);

const SelectShell = ({ children, className = "w-64" }: { children: ReactNode; className?: string }) => (
  <div className={`relative ${className}`}>
    {children}
    <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
  </div>
);

type ProviderCardProps = {
  name: string;
  description: string;
  value: string;
  onChange: (value: string) => void;
  inputId: string;
  dataKey: string;
  placeholder: string;
  linkLabel: string;
  linkUrl: string;
  required?: boolean;
  warning?: string;
  defaultOpen?: boolean;
};

const ProviderCard = ({
  name,
  description,
  value,
  onChange,
  inputId,
  dataKey,
  placeholder,
  linkLabel,
  linkUrl,
  required = false,
  warning,
  defaultOpen = false,
}: ProviderCardProps) => {
  const [showKey, setShowKey] = useState(false);
  const [open, setOpen] = useState(defaultOpen);
  const dataAttribute = { [`data-${dataKey}`]: "" };
  const configured = value.trim().length > 0;

  return (
    <details
      className="group overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-primary)]"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">
          <span className="block text-[var(--font-size-sm)] font-semibold text-[var(--color-text-primary)]">
            {name}
          </span>
          <span className="mt-0.5 block truncate text-[var(--font-size-xs)] text-[var(--color-text-muted)]">
            {description}
          </span>
        </span>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
            configured
              ? "bg-emerald-500/10 text-emerald-500"
              : "bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]"
          }`}
        >
          {configured ? "Configured" : required ? "Not configured" : "Optional"}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-[var(--color-text-muted)] transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-3 border-t border-[var(--color-border-light)] px-4 py-4">
        <label
          className="block text-[var(--font-size-xs)] font-medium text-[var(--color-text-secondary)]"
          htmlFor={inputId}
        >
          API key
        </label>
        <div className="relative max-w-md">
          <input
            {...dataAttribute}
            autoComplete="off"
            className={`${inputClass} pr-20`}
            id={inputId}
            onChange={(event) => onChange(event.target.value.trim())}
            placeholder={placeholder}
            spellCheck={false}
            type={showKey ? "text" : "password"}
            value={value}
          />
          <button
            className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded px-2 py-1 text-[10px] font-medium text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"
            onClick={() => setShowKey((current) => !current)}
            type="button"
            aria-label={`${showKey ? "Hide" : "Show"} ${name} API key`}
          >
            {showKey ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            {showKey ? "Hide" : "Show"}
          </button>
        </div>
        <p className="max-w-2xl text-[var(--font-size-xs)] leading-relaxed text-[var(--color-text-secondary)]">
          {description}
        </p>
        {warning && (
          <p className="max-w-2xl text-[var(--font-size-xs)] leading-relaxed text-amber-600 dark:text-amber-400">
            {warning}
          </p>
        )}
        <button
          className="inline-flex items-center gap-1.5 text-[var(--font-size-xs)] font-medium text-[var(--color-accent)] hover:underline"
          onClick={() => { void openExternal(linkUrl); }}
          type="button"
        >
          {linkLabel} <ExternalLink className="h-3 w-3" />
        </button>
      </div>
    </details>
  );
};

export const SettingsPanel = ({
  theme,
  locale,
  themes,
  localeOptions,
  dbPath,
  dbFileName,
  backfillPending,
  backfillStatus,
  coverArtBackfillPending,
  coverArtBackfillStatus,
  artistSeparatorCandidateCount,
  organizedLibraryExportPending,
  organizedLibraryExportStatus,
  clearSongsPending,
  seekMode,
  onThemeChange,
  onLocaleChange,
  onSeekModeChange,
  onDbPathChange,
  onDbFileNameChange,
  onBackfillSearchText,
  onBackfillCoverArt,
  onReviewArtistSeparators,
  onExportOrganizedLibrary,
  onClearSongs,
  onUseDefaultLocation,
}: SettingsPanelProps) => {
  const artistSeparatorExceptions = useSettingsStore((s) => s.artistSeparatorExceptions);
  const addArtistSeparatorException = useSettingsStore(
    (s) => s.addArtistSeparatorException,
  );
  const removeArtistSeparatorException = useSettingsStore(
    (s) => s.removeArtistSeparatorException,
  );
  const clearArtistSeparatorExceptions = useSettingsStore(
    (s) => s.clearArtistSeparatorExceptions,
  );
  const [artistSeparatorExceptionInput, setArtistSeparatorExceptionInput] = useState("");
  const gaplessEnabled = useSettingsStore((s) => s.gaplessEnabled);
  const crossfadeSeconds = useSettingsStore((s) => s.crossfadeSeconds);
  const replayGainMode = useSettingsStore((s) => s.replayGainMode);
  const replayGainPreampDb = useSettingsStore((s) => s.replayGainPreampDb);
  const replayGainPreventClipping = useSettingsStore((s) => s.replayGainPreventClipping);
  const replayGainReferenceLufs = useSettingsStore((s) => s.replayGainReferenceLufs);
  const setGaplessEnabled = useSettingsStore((s) => s.setGaplessEnabled);
  const setCrossfadeSeconds = useSettingsStore((s) => s.setCrossfadeSeconds);
  const setReplayGainMode = useSettingsStore((s) => s.setReplayGainMode);
  const setReplayGainPreampDb = useSettingsStore((s) => s.setReplayGainPreampDb);
  const setReplayGainPreventClipping = useSettingsStore((s) => s.setReplayGainPreventClipping);
  const setReplayGainReferenceLufs = useSettingsStore((s) => s.setReplayGainReferenceLufs);
  const loudnessScan = useLoudnessAnalysis();
  const organization = useLibraryOrganization();
  const verification = useLibraryVerification();
  const watched = useWatchedFolders();
  const [missingTracksOpen, setMissingTracksOpen] = useState(false);
  const [misplacedTracksOpen, setMisplacedTracksOpen] = useState(false);

  const onShowMissingTracks = () => setMissingTracksOpen(true);
  const onValidateLibraryStructure = async () => {
    const result = await organization.validate();
    if (result && result.misplaced.length > 0) {
      setMisplacedTracksOpen(true);
    }
  };
  const onRepairLibraryStructure = async () => {
    const result = await organization.repair();
    if (result && result.validation.misplaced.length === 0) {
      setMisplacedTracksOpen(false);
    }
  };

  useEffect(() => {
    setMisplacedTracksOpen(false);
  }, [watched.watchedFolder]);

  const [activeSection, setActiveSection] = useState<SettingsSectionId>("general");
  const [settingsSearch, setSettingsSearch] = useState("");
  const [useExportAsCurrentLibrary, setUseExportAsCurrentLibrary] = useState(false);
  const analysisNotation = useSettingsStore((state) => state.analysisNotation);
  const analysisCustomCodes = useSettingsStore((state) => state.analysisCustomCodes);
  const analysisDelimiter = useSettingsStore((state) => state.analysisDelimiter);
  const analysisOutputs = useSettingsStore((state) => state.analysisOutputs);
  const analysisPerformance = useSettingsStore((state) => state.analysisPerformance);
  const setAnalysisNotation = useSettingsStore((state) => state.setAnalysisNotation);
  const setAnalysisCustomCode = useSettingsStore((state) => state.setAnalysisCustomCode);
  const setAnalysisDelimiter = useSettingsStore((state) => state.setAnalysisDelimiter);
  const setAnalysisOutput = useSettingsStore((state) => state.setAnalysisOutput);
  const setAnalysisPerformance = useSettingsStore((state) => state.setAnalysisPerformance);
  const djMixEnabled = useSettingsStore((state) => state.djMixEnabled);
  const autoMix = useSettingsStore((state) => state.autoMix);
  const mixBars = useSettingsStore((state) => state.mixBars);
  const mixPreservePitch = useSettingsStore((state) => state.mixPreservePitch);
  const setDjMixEnabled = useSettingsStore((state) => state.setDjMixEnabled);
  const setAutoMix = useSettingsStore((state) => state.setAutoMix);
  const setMixBars = useSettingsStore((state) => state.setMixBars);
  const setMixPreservePitch = useSettingsStore((state) => state.setMixPreservePitch);
  const lastFmApiKey = useSettingsStore((state) => state.lastFmApiKey);
  const setLastFmApiKey = useSettingsStore((state) => state.setLastFmApiKey);
  const theAudioDbApiKey = useSettingsStore((state) => state.theAudioDbApiKey);
  const setTheAudioDbApiKey = useSettingsStore((state) => state.setTheAudioDbApiKey);
  const fanartApiKey = useSettingsStore((state) => state.fanartApiKey);
  const setFanartApiKey = useSettingsStore((state) => state.setFanartApiKey);
  const braveSearchApiKey = useSettingsStore((state) => state.braveSearchApiKey);
  const setBraveSearchApiKey = useSettingsStore((state) => state.setBraveSearchApiKey);
  const acoustIdClientKey = useSettingsStore((state) => state.acoustIdClientKey);
  const setAcoustIdClientKey = useSettingsStore((state) => state.setAcoustIdClientKey);
  const writesAudioTags = Object.values(analysisOutputs).some((mode) => mode !== "none");

  const visibleSections = useMemo(() => {
    const query = settingsSearch.trim().toLocaleLowerCase();
    if (!query) return SETTINGS_SECTIONS;
    return SETTINGS_SECTIONS.filter((section) =>
      `${section.label} ${section.description} ${section.keywords}`
        .toLocaleLowerCase()
        .includes(query)
    );
  }, [settingsSearch]);

  const handleSettingsSearch = (value: string) => {
    setSettingsSearch(value);
    const query = value.trim().toLocaleLowerCase();
    if (!query) return;
    const firstMatch = SETTINGS_SECTIONS.find((section) =>
      `${section.label} ${section.description} ${section.keywords}`
        .toLocaleLowerCase()
        .includes(query)
    );
    if (firstMatch) setActiveSection(firstMatch.id);
  };

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row" data-settings-panel>
      <aside className="flex shrink-0 flex-col border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] md:w-[224px] md:border-b-0 md:border-r">
        <div className="border-b border-[var(--color-border-light)] p-3">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-text-muted)]" />
            <input
              className="h-9 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] pl-8 pr-3 text-[12px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)]"
              onChange={(event) => handleSettingsSearch(event.target.value)}
              placeholder="Search settings"
              type="search"
              value={settingsSearch}
              data-settings-search
            />
          </label>
        </div>

        <nav
          className="flex min-h-0 gap-1 overflow-x-auto p-2 md:flex-1 md:flex-col md:overflow-x-hidden md:overflow-y-auto"
          aria-label="Settings categories"
        >
          {visibleSections.map((section) => {
            const Icon = section.icon;
            const isActive = activeSection === section.id;
            return (
              <button
                key={section.id}
                className={`flex min-w-[168px] items-center gap-3 rounded-[var(--radius-md)] px-3 py-2.5 text-left transition-colors md:min-w-0 ${
                  isActive
                    ? "bg-[var(--color-bg-active)] text-[var(--color-text-primary)]"
                    : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"
                }`}
                onClick={() => {
                  setActiveSection(section.id);
                  setSettingsSearch("");
                }}
                type="button"
                data-settings-tab={section.id}
                data-settings-section={section.id}
                aria-current={isActive ? "page" : undefined}
              >
                <Icon className={`h-4 w-4 shrink-0 ${isActive ? "text-[var(--color-accent)]" : "text-[var(--color-text-muted)]"}`} />
                <span className="min-w-0">
                  <span className="block truncate text-[12px] font-semibold">{section.label}</span>
                  <span className="mt-0.5 hidden truncate text-[10px] text-[var(--color-text-muted)] md:block">
                    {section.description}
                  </span>
                </span>
              </button>
            );
          })}
          {visibleSections.length === 0 && (
            <p className="px-3 py-4 text-center text-[11px] text-[var(--color-text-muted)]">
              No settings found
            </p>
          )}
        </nav>

        <p className="hidden border-t border-[var(--color-border-light)] px-4 py-3 text-[10px] leading-relaxed text-[var(--color-text-muted)] md:block">
          Changes are saved automatically.
        </p>
      </aside>

      <div className="min-h-0 flex-1 overflow-y-auto" data-settings-content>
        <div className="mx-auto max-w-4xl p-[var(--spacing-lg)]">
          {activeSection === "general" && (
            <div data-settings-page="general">
              <SettingsPageHeader
                title="General"
                description="Choose how Muro looks, reads, and responds during playback."
              />
              <div className="space-y-5">
                <SettingsGroup
                  title="Appearance"
                  description="Choose a theme or follow your computer automatically."
                >
                  <div className="grid max-w-2xl grid-cols-1 gap-2 sm:grid-cols-3">
                    {themes.map((item) => {
                      const themeInfo = themeDescriptions[item.id];
                      const ThemeIcon = themeIcons[item.id];
                      const isSelected = theme === item.id;
                      return (
                        <button
                          key={item.id}
                          className={`group min-w-0 rounded-[var(--radius-md)] border p-2 text-left transition-all duration-[var(--transition-fast)] ${
                            isSelected
                              ? "border-[var(--color-accent)] bg-[var(--color-accent-light)] shadow-[0_0_0_1px_var(--color-accent)]"
                              : "border-[var(--color-border)] bg-[var(--color-bg-primary)] hover:-translate-y-px hover:border-[var(--color-text-muted)] hover:shadow-[var(--shadow-sm)]"
                          }`}
                          onClick={() => onThemeChange(item.id)}
                          title={themeInfo.description}
                          aria-pressed={isSelected}
                          type="button"
                        >
                          <div className="theme-preview" data-theme-preview={item.id} aria-hidden="true">
                            <div className="theme-preview__sidebar">
                              <span className="theme-preview__logo" />
                              <span className="theme-preview__nav theme-preview__nav--active" />
                              <span className="theme-preview__nav" />
                              <span className="theme-preview__nav" />
                            </div>
                            <div className="theme-preview__content">
                              <div className="theme-preview__toolbar"><span /><span /></div>
                              <div className="theme-preview__track">
                                <span className="theme-preview__cover" />
                                <span className="theme-preview__lines"><i /><i /></span>
                              </div>
                              <div className="theme-preview__track">
                                <span className="theme-preview__cover theme-preview__cover--alt" />
                                <span className="theme-preview__lines"><i /><i /></span>
                              </div>
                              <div className="theme-preview__waveform" />
                            </div>
                          </div>
                          <span className="mt-1.5 flex items-center gap-1.5 px-0.5">
                            <ThemeIcon className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />
                            <span className="truncate text-[11px] font-semibold text-[var(--color-text-primary)]">
                              {themeInfo.label}
                            </span>
                            <span className={`ml-auto h-1.5 w-1.5 rounded-full ${isSelected ? "bg-[var(--color-accent)]" : "bg-transparent"}`} />
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </SettingsGroup>

                <SettingsGroup title={t("settings.language")}>
                  <label className="mb-2 block text-[var(--font-size-sm)] font-medium text-[var(--color-text-primary)]">
                    Language
                  </label>
                  <SelectShell>
                    <select
                      className={selectClass}
                      onChange={(event) => onLocaleChange(event.target.value as Locale)}
                      value={locale}
                    >
                      {localeOptions.map((option) => (
                        <option key={option.id} value={option.id}>{option.label}</option>
                      ))}
                    </select>
                  </SelectShell>
                  <p className="mt-2 text-[var(--font-size-xs)] text-[var(--color-text-secondary)]">
                    {t("settings.language.help")}
                  </p>
                </SettingsGroup>

                <SettingsGroup title={t("playback.section")}>
                  <div className="space-y-5">
                    <div>
                      <label className="mb-2 block text-[var(--font-size-sm)] font-medium text-[var(--color-text-primary)]">
                        Seek mode
                      </label>
                      <SelectShell>
                        <select
                          className={selectClass}
                          onChange={(event) => onSeekModeChange(event.target.value as "fast" | "accurate")}
                          value={seekMode}
                        >
                          <option value="fast">Fast (Recommended)</option>
                          <option value="accurate">Accurate</option>
                        </select>
                      </SelectShell>
                      <p className="mt-2 text-[var(--font-size-xs)] text-[var(--color-text-secondary)]">
                        Fast seeking is snappier but can be slightly less precise on some formats.
                      </p>
                    </div>

                    <label className="flex items-start gap-3">
                      <input
                        checked={gaplessEnabled}
                        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
                        data-gapless-toggle
                        onChange={(event) => setGaplessEnabled(event.target.checked)}
                        type="checkbox"
                      />
                      <span className="min-w-0">
                        <span className="block text-[var(--font-size-sm)] font-medium text-[var(--color-text-primary)]">
                          {t("playback.gapless")}
                        </span>
                        <span className="mt-1 block text-[var(--font-size-xs)] leading-relaxed text-[var(--color-text-secondary)]">
                          {t("playback.gapless.description")}
                        </span>
                      </span>
                    </label>

                    <div>
                      <label className="mb-2 block text-[var(--font-size-sm)] font-medium text-[var(--color-text-primary)]">
                        {t("playback.crossfade")}
                      </label>
                      <SelectShell>
                        <select
                          className={selectClass}
                          data-crossfade-select
                          disabled={!gaplessEnabled}
                          onChange={(event) => setCrossfadeSeconds(Number(event.target.value))}
                          value={crossfadeSeconds}
                        >
                          <option value={0}>{t("playback.crossfade.off")}</option>
                          {CROSSFADE_OPTIONS.map((seconds) => (
                            <option key={seconds} value={seconds}>
                              {t("playback.crossfade.seconds", { seconds: String(seconds) })}
                            </option>
                          ))}
                        </select>
                      </SelectShell>
                      <p className="mt-2 text-[var(--font-size-xs)] text-[var(--color-text-secondary)]">
                        {t("playback.crossfade.description")}
                      </p>
                    </div>
                  </div>
                </SettingsGroup>

                <SettingsGroup
                  title={t("loudness.section")}
                  description={t("loudness.mode.description")}
                >
                  <div className="space-y-5">
                    <div>
                      <label className="mb-2 block text-[var(--font-size-sm)] font-medium text-[var(--color-text-primary)]">
                        {t("loudness.mode")}
                      </label>
                      <SelectShell>
                        <select
                          className={selectClass}
                          data-replaygain-mode
                          onChange={(event) =>
                            setReplayGainMode(event.target.value as ReplayGainMode)
                          }
                          value={replayGainMode}
                        >
                          <option value="off">{t("loudness.mode.off")}</option>
                          <option value="track">{t("loudness.mode.track")}</option>
                          <option value="album">{t("loudness.mode.album")}</option>
                        </select>
                      </SelectShell>
                      <p className="mt-2 text-[var(--font-size-xs)] text-[var(--color-text-secondary)]">
                        {t("loudness.boostNote")}
                      </p>
                    </div>

                    {replayGainMode !== "off" && (
                      <>
                        <div>
                          <label className="mb-2 block text-[var(--font-size-sm)] font-medium text-[var(--color-text-primary)]">
                            {t("loudness.preamp")}
                            <span className="ml-2 tabular-nums text-[var(--color-text-muted)]">
                              {replayGainPreampDb > 0 ? "+" : ""}
                              {replayGainPreampDb.toFixed(1)} dB
                            </span>
                          </label>
                          <input
                            className="w-64 accent-[var(--color-accent)]"
                            data-replaygain-preamp
                            max={15}
                            min={-15}
                            onChange={(event) =>
                              setReplayGainPreampDb(Number(event.target.value))
                            }
                            step={0.5}
                            type="range"
                            value={replayGainPreampDb}
                          />
                          <p className="mt-2 text-[var(--font-size-xs)] text-[var(--color-text-secondary)]">
                            {t("loudness.preamp.description")}
                          </p>
                        </div>

                        <label className="flex items-start gap-3">
                          <input
                            checked={replayGainPreventClipping}
                            className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
                            data-replaygain-clipping
                            onChange={(event) =>
                              setReplayGainPreventClipping(event.target.checked)
                            }
                            type="checkbox"
                          />
                          <span className="min-w-0">
                            <span className="block text-[var(--font-size-sm)] font-medium text-[var(--color-text-primary)]">
                              {t("loudness.preventClipping")}
                            </span>
                            <span className="mt-1 block text-[var(--font-size-xs)] leading-relaxed text-[var(--color-text-secondary)]">
                              {t("loudness.preventClipping.description")}
                            </span>
                          </span>
                        </label>

                        <div>
                          <label className="mb-2 block text-[var(--font-size-sm)] font-medium text-[var(--color-text-primary)]">
                            {t("loudness.reference")}
                          </label>
                          <SelectShell>
                            <select
                              className={selectClass}
                              data-replaygain-reference
                              onChange={(event) =>
                                setReplayGainReferenceLufs(Number(event.target.value))
                              }
                              value={replayGainReferenceLufs}
                            >
                              <option value={-18}>-18 LUFS (ReplayGain 2.0)</option>
                              <option value={-16}>-16 LUFS</option>
                              <option value={-14}>-14 LUFS (streaming)</option>
                            </select>
                          </SelectShell>
                          <p className="mt-2 text-[var(--font-size-xs)] text-[var(--color-text-secondary)]">
                            {t("loudness.reference.description")}
                          </p>
                        </div>
                      </>
                    )}

                    <div className="border-t border-[var(--color-border-light)] pt-5">
                      <p className="mb-3 text-[var(--font-size-xs)] leading-relaxed text-[var(--color-text-secondary)]">
                        {t("loudness.scan.description")}
                      </p>
                      <div className="flex items-center gap-3">
                        <button
                          className={primaryButtonClass}
                          data-loudness-scan
                          disabled={loudnessScan.running}
                          onClick={() => { void loudnessScan.run(); }}
                          type="button"
                        >
                          {t("loudness.scan.start")}
                        </button>
                        {loudnessScan.running && (
                          <>
                            <button
                              className={secondaryButtonClass}
                              onClick={loudnessScan.cancel}
                              type="button"
                            >
                              {t("loudness.scan.cancel")}
                            </button>
                            <span className="text-[var(--font-size-xs)] tabular-nums text-[var(--color-text-secondary)]">
                              {t("loudness.scan.progress", {
                                analyzed: String(loudnessScan.analyzed),
                                total: String(loudnessScan.total),
                              })}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </SettingsGroup>
              </div>
            </div>
          )}

          {activeSection === "library" && (
            <div data-settings-page="library">
              <SettingsPageHeader
                title="Library & Files"
                description="Control where library data lives and maintain or export your collection."
              />
              <div className="space-y-5">
                <SettingsGroup
                  title="Database location"
                  description="The default database lives in Muro's per-user application data directory."
                >
                  <div className="space-y-5">
                    <div>
                      <label className="mb-2 block text-[var(--font-size-sm)] font-medium text-[var(--color-text-primary)]">
                        Database file name
                      </label>
                      <input
                        className={`${inputClass} max-w-md`}
                        placeholder="muro.db"
                        value={dbFileName}
                        onChange={(event) => onDbFileNameChange(event.target.value)}
                      />
                    </div>
                    <div>
                      <label className="mb-2 block text-[var(--font-size-sm)] font-medium text-[var(--color-text-primary)]">
                        Custom database path
                      </label>
                      <input
                        className={`${inputClass} max-w-xl`}
                        placeholder="/path/to/muro.db"
                        value={dbPath}
                        onChange={(event) => onDbPathChange(event.target.value)}
                      />
                      <button className={`mt-3 ${secondaryButtonClass}`} type="button" onClick={onUseDefaultLocation}>
                        Use default location
                      </button>
                    </div>
                  </div>
                </SettingsGroup>

                <SettingsGroup
                  title="Library tools"
                  description="Review naming issues or create a portable copy of the complete collection."
                >
                  <div className="grid gap-4 lg:grid-cols-2">
                    <div
                      className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-4"
                      data-artist-separator-tool
                    >
                      <div className="flex items-start gap-3">
                        <Replace className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent)]" />
                        <div className="min-w-0 flex-1">
                          <h4 className="text-[var(--font-size-sm)] font-semibold text-[var(--color-text-primary)]">
                            Artist separator cleanup
                          </h4>
                          <p className="mt-1 text-[var(--font-size-xs)] leading-relaxed text-[var(--color-text-secondary)]">
                            Reviews artist and album-artist fields containing “ &amp; ” or “feat.”
                            and proposes comma-separated names. Every change requires approval.
                          </p>
                          <button
                            className={`mt-3 ${primaryButtonClass}`}
                            type="button"
                            disabled={artistSeparatorCandidateCount === 0}
                            onClick={onReviewArtistSeparators}
                            data-review-artist-separators
                          >
                            {artistSeparatorCandidateCount === 0
                              ? "No matching artist fields"
                              : `Review ${artistSeparatorCandidateCount.toLocaleString()} ${
                                  artistSeparatorCandidateCount === 1 ? "match" : "matches"
                                }`}
                          </button>
                          <form
                            className="mt-3 flex gap-2"
                            onSubmit={(event) => {
                              event.preventDefault();
                              const artist = artistSeparatorExceptionInput.trim();
                              if (!artist) return;
                              addArtistSeparatorException(artist);
                              setArtistSeparatorExceptionInput("");
                            }}
                          >
                            <input
                              className="min-w-0 flex-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 text-[11px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
                              value={artistSeparatorExceptionInput}
                              onChange={(event) => setArtistSeparatorExceptionInput(event.target.value)}
                              placeholder="Exact artist name to keep together"
                              aria-label="Artist separator exception"
                              data-artist-separator-exception-input
                            />
                            <button
                              className={secondaryButtonClass}
                              disabled={!artistSeparatorExceptionInput.trim()}
                              type="submit"
                              data-add-artist-separator-exception
                            >
                              Add exception
                            </button>
                          </form>
                          <p className="mt-1.5 text-[10px] leading-relaxed text-[var(--color-text-muted)]">
                            Use an exact exception for one artist name that contains a comma,
                            &amp;, or “feat.”, such as “Tyler, The Creator”.
                          </p>
                          {artistSeparatorExceptions.length > 0 && (
                            <div
                              className="mt-4 rounded-[var(--radius-md)] border border-[var(--color-border-light)] bg-[var(--color-bg-secondary)] p-3"
                              data-artist-separator-exceptions
                            >
                              <div className="flex items-center justify-between gap-3">
                                <span className="text-[11px] font-semibold text-[var(--color-text-secondary)]">
                                  Saved exceptions ({artistSeparatorExceptions.length.toLocaleString()})
                                </span>
                                <button
                                  className="text-[10px] font-medium text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
                                  onClick={clearArtistSeparatorExceptions}
                                  type="button"
                                  data-clear-artist-separator-exceptions
                                >
                                  Clear all
                                </button>
                              </div>
                              <ul className="mt-2 max-h-32 space-y-1 overflow-y-auto">
                                {artistSeparatorExceptions.map((artist) => (
                                  <li
                                    className="flex items-center justify-between gap-2 rounded px-2 py-1 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
                                    key={artist}
                                  >
                                    <span className="min-w-0 truncate" title={artist}>{artist}</span>
                                    <button
                                      aria-label={`Remove ${artist} from artist separator exceptions`}
                                      className="shrink-0 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
                                      onClick={() => removeArtistSeparatorException(artist)}
                                      type="button"
                                      data-remove-artist-separator-exception={artist}
                                    >
                                      Remove
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    <div
                      className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-4"
                      data-organized-library-export
                    >
                      <div className="flex items-start gap-3">
                        <FolderOutput className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent)]" />
                        <div className="min-w-0 flex-1">
                          <h4 className="text-[var(--font-size-sm)] font-semibold text-[var(--color-text-primary)]">
                            Export organized library
                          </h4>
                          <p className="mt-1 text-[var(--font-size-xs)] leading-relaxed text-[var(--color-text-secondary)]">
                            Copies music into Artist / Album / Disc folders and exports root and
                            nested playlists as portable M3U8 files. Originals stay untouched.
                          </p>
                          <label className="mt-3 flex cursor-pointer items-start gap-2 text-[var(--font-size-xs)] text-[var(--color-text-secondary)]">
                            <input
                              type="checkbox"
                              className="mt-0.5 h-3.5 w-3.5 accent-[var(--color-accent)]"
                              checked={useExportAsCurrentLibrary}
                              disabled={organizedLibraryExportPending}
                              onChange={(event) => setUseExportAsCurrentLibrary(event.target.checked)}
                              data-use-export-as-current-library
                            />
                            <span>Use exported files as the current library after a successful export.</span>
                          </label>
                          <button
                            className={`mt-3 ${primaryButtonClass}`}
                            type="button"
                            disabled={organizedLibraryExportPending}
                            onClick={() => onExportOrganizedLibrary(useExportAsCurrentLibrary)}
                            data-export-organized-library
                          >
                            {organizedLibraryExportPending ? "Exporting…" : "Choose export folder"}
                          </button>
                          {organizedLibraryExportStatus && (
                            <p
                              className="mt-2 text-[var(--font-size-xs)] text-[var(--color-text-secondary)]"
                              data-organized-library-export-status
                            >
                              {organizedLibraryExportStatus}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </SettingsGroup>

                <LibraryDataTools dbPath={dbPath} />

                <KeyboardShortcutSettings />

                <SettingsGroup
                  title="Maintenance"
                  description="Repair derived data without changing your source audio tags."
                >
                  <div className="grid gap-5 lg:grid-cols-2">
                    <div>
                      <div className="flex flex-wrap items-center gap-3">
                        <button
                          className={primaryButtonClass}
                          onClick={onBackfillSearchText}
                          disabled={backfillPending}
                          type="button"
                        >
                          {backfillPending ? "Backfilling..." : "Backfill search index"}
                        </button>
                        {backfillStatus && (
                          <span className="text-[var(--font-size-xs)] text-[var(--color-text-secondary)]">
                            {backfillStatus}
                          </span>
                        )}
                      </div>
                      <p className="mt-2 text-[var(--font-size-xs)] text-[var(--color-text-secondary)]">
                        Updates searchable text for existing tracks.
                      </p>
                    </div>
                    <div>
                      <div className="flex flex-wrap items-center gap-3">
                        <button
                          className={primaryButtonClass}
                          onClick={onBackfillCoverArt}
                          disabled={coverArtBackfillPending}
                          type="button"
                        >
                          {coverArtBackfillPending ? "Rebuilding..." : "Rebuild cover art cache"}
                        </button>
                        {coverArtBackfillStatus && (
                          <span className="text-[var(--font-size-xs)] text-[var(--color-text-secondary)]">
                            {coverArtBackfillStatus}
                          </span>
                        )}
                      </div>
                      <p className="mt-2 text-[var(--font-size-xs)] text-[var(--color-text-secondary)]">
                        Regenerates covers and thumbnails from embedded artwork without contacting
                        an online service.
                      </p>
                    </div>
                  </div>
                </SettingsGroup>

                <SettingsGroup
                  title={t("watch.section")}
                  description={t("watch.description")}
                >
                  <div className="space-y-4">
                    <label className="flex items-start gap-3">
                      <input
                        checked={watched.watchFolderEnabled}
                        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
                        data-watch-folder-toggle
                        disabled={!watched.watchedFolder}
                        onChange={(event) =>
                          watched.setWatchFolderEnabled(event.target.checked)
                        }
                        type="checkbox"
                      />
                      <span className="text-[var(--font-size-sm)] font-medium text-[var(--color-text-primary)]">
                        {t("watch.enable")}
                      </span>
                    </label>

                    <label className="flex items-start gap-3">
                      <input
                        checked={watched.organizeAcceptedTracks}
                        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
                        data-organize-accepted-tracks-toggle
                        onChange={(event) =>
                          watched.setOrganizeAcceptedTracks(event.target.checked)
                        }
                        type="checkbox"
                      />
                      <span>
                        <span className="block text-[var(--font-size-sm)] font-medium text-[var(--color-text-primary)]">
                          {t("watch.organizeAccepted")}
                        </span>
                        <span className="mt-1 block text-[var(--font-size-xs)] leading-relaxed text-[var(--color-text-secondary)]">
                          {t("watch.organizeAccepted.hint")}
                        </span>
                      </span>
                    </label>

                    {!watched.watchedFolder ? (
                      <p className="text-[var(--font-size-xs)] text-[var(--color-text-muted)]">
                        {t("watch.empty")}
                      </p>
                    ) : (
                      <div className="flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-3 py-2">
                        <span
                          className="min-w-0 flex-1 truncate text-[var(--font-size-xs)] text-[var(--color-text-secondary)]"
                          title={watched.watchedFolder}
                        >
                          {watched.watchedFolder}
                        </span>
                      </div>
                    )}
                    {watched.watchedFolder && (
                      <p
                        className="text-[var(--font-size-xs)] leading-relaxed text-[var(--color-text-secondary)]"
                        data-watch-folder-destination-hint
                      >
                        {t("watch.destination.hint")}
                      </p>
                    )}

                    <div className="flex flex-wrap items-center gap-3">
                      <button
                        className={secondaryButtonClass}
                        data-watch-add-folder
                        onClick={() => { void watched.addFolder(); }}
                        type="button"
                      >
                        {t(watched.watchedFolder ? "watch.change" : "watch.add")}
                      </button>
                      <button
                        className={secondaryButtonClass}
                        data-watch-scan-now
                        disabled={watched.scanning || !watched.watchedFolder}
                        onClick={() => { void watched.scanNow(); }}
                        type="button"
                      >
                        {watched.scanning ? t("watch.scanning") : t("watch.scan")}
                      </button>
                    </div>
                    <p className="text-[var(--font-size-xs)] leading-relaxed text-[var(--color-text-secondary)]">
                      {t("watch.scan.hint")}
                    </p>
                  </div>
                </SettingsGroup>

                <SettingsGroup
                  title={t("structure.section")}
                  description={t("structure.description")}
                >
                  <div className="space-y-3" data-library-structure-tool>
                    <div className="flex flex-wrap items-center gap-3">
                      <button
                        className={primaryButtonClass}
                        data-validate-library-structure
                        disabled={
                          !organization.hasLibraryRoot ||
                          organization.validating ||
                          organization.repairing
                        }
                        onClick={() => { void onValidateLibraryStructure(); }}
                        type="button"
                      >
                        {organization.validating
                          ? t("structure.running")
                          : t("structure.run")}
                      </button>
                      {organization.lastResult &&
                        organization.lastResult.misplaced.length > 0 && (
                          <button
                            className={secondaryButtonClass}
                            data-show-misplaced-tracks
                            onClick={() => setMisplacedTracksOpen(true)}
                            type="button"
                          >
                            {t("structure.showMisplaced")} (
                            {organization.lastResult.misplaced.length})
                          </button>
                        )}
                      {organization.lastResult && (
                        <span
                          className="text-[var(--font-size-xs)] tabular-nums text-[var(--color-text-secondary)]"
                          data-library-structure-status
                        >
                          {organization.lastResult.misplaced.length === 0
                            ? t("structure.allCorrect", {
                                checked: String(organization.lastResult.checked),
                              })
                            : t("structure.found", {
                                misplaced: String(
                                  organization.lastResult.misplaced.length
                                ),
                                checked: String(organization.lastResult.checked),
                              })}
                        </span>
                      )}
                    </div>
                    {!organization.hasLibraryRoot && (
                      <p className="text-[var(--font-size-xs)] leading-relaxed text-[var(--color-text-muted)]">
                        {t("structure.noRoot")}
                      </p>
                    )}
                    {organization.lastResult &&
                      (
                        organization.lastResult.outsideRoot > 0 ||
                        organization.lastResult.unavailable > 0
                      ) && (
                        <p className="text-[var(--font-size-xs)] leading-relaxed text-[var(--color-text-muted)]">
                          {t("structure.skipped", {
                            outside: String(organization.lastResult.outsideRoot),
                            unavailable: String(organization.lastResult.unavailable),
                          })}
                        </p>
                      )}
                  </div>
                </SettingsGroup>

                <SettingsGroup
                  title={t("verify.section")}
                  description={t("verify.description")}
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      className={primaryButtonClass}
                      data-verify-library
                      disabled={verification.verifying}
                      onClick={() => { void verification.verify(); }}
                      type="button"
                    >
                      {verification.verifying ? t("verify.running") : t("verify.run")}
                    </button>
                    {verification.missingTracks.length > 0 && (
                      <button
                        className={secondaryButtonClass}
                        data-show-missing-tracks
                        onClick={onShowMissingTracks}
                        type="button"
                      >
                        {t("verify.showMissing")} ({verification.missingTracks.length})
                      </button>
                    )}
                    {verification.lastResult && (
                      <span className="text-[var(--font-size-xs)] tabular-nums text-[var(--color-text-secondary)]">
                        {t("verify.result", {
                          missing: String(verification.lastResult.missing),
                          restored: String(verification.lastResult.restored),
                          checked: String(verification.lastResult.checked),
                        })}
                      </span>
                    )}
                  </div>
                </SettingsGroup>
              </div>
            </div>
          )}

          {activeSection === "metadata" && (
            <div data-settings-page="metadata">
              <SettingsPageHeader
                title="Metadata & Artwork"
                description="Configure optional services used for identification and artist information."
              />
              <div className="space-y-5">
                <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-accent-light)] px-4 py-3 text-[var(--font-size-xs)] leading-relaxed text-[var(--color-text-secondary)]">
                  MusicBrainz, Cover Art Archive, Wikimedia, Wikipedia, Wikidata, and Deezer work
                  without a key. Cover art is fetched only when you request it and is never
                  automatically applied over an existing cover.
                </div>

                <SettingsGroup
                  title="Track identification"
                  description="Identify recordings from their audio fingerprint."
                >
                  <div data-acoustid-settings>
                    <ProviderCard
                      name="AcoustID"
                      description="Audio stays on this computer; only the compact fingerprint and duration are sent to AcoustID."
                      value={acoustIdClientKey}
                      onChange={setAcoustIdClientKey}
                      inputId="acoustid-client-key"
                      dataKey="acoustid-client-key"
                      placeholder="Paste the key from My Applications"
                      linkLabel="Create an AcoustID application key"
                      linkUrl="https://acoustid.org/new-application"
                      required
                      defaultOpen
                      warning="Use an application API key, not the personal user API key shown on your profile."
                    />
                  </div>
                </SettingsGroup>

                <SettingsGroup
                  title="Artist information"
                  description="Optional providers add biographies, tags, related artists, and image candidates. Keys stay in local settings."
                >
                  <div className="space-y-3" data-artist-information-settings>
                    <ProviderCard
                      name="Last.fm"
                      description="Adds artist biographies, tags, profile links, and similar artists. Last.fm artwork is not used."
                      value={lastFmApiKey}
                      onChange={setLastFmApiKey}
                      inputId="lastfm-api-key"
                      dataKey="lastfm-api-key"
                      placeholder="Paste your Last.fm API key"
                      linkLabel="Create a Last.fm API key"
                      linkUrl="https://www.last.fm/api/account/create"
                    />
                    <ProviderCard
                      name="TheAudioDB"
                      description="Uses the Premium V2 API to fill missing artist biographies, genres, countries, and artwork."
                      value={theAudioDbApiKey}
                      onChange={setTheAudioDbApiKey}
                      inputId="theaudiodb-api-key"
                      dataKey="theaudiodb-api-key"
                      placeholder="Paste your Premium API key"
                      linkLabel="View TheAudioDB API details"
                      linkUrl="https://www.theaudiodb.com/free_music_api"
                    />
                    <ProviderCard
                      name="Fanart.tv"
                      description="Provides a final artist-artwork fallback after the no-key sources."
                      value={fanartApiKey}
                      onChange={setFanartApiKey}
                      inputId="fanart-api-key"
                      dataKey="fanart-api-key"
                      placeholder="Optional fallback"
                      linkLabel="Get a Fanart.tv API key"
                      linkUrl="https://fanart.tv/get-an-api-key/"
                    />
                    <ProviderCard
                      name="Brave Image Search"
                      description="Adds selectable artist-image results and a manual album-cover fallback with strict SafeSearch. Nothing is applied without selection."
                      value={braveSearchApiKey}
                      onChange={setBraveSearchApiKey}
                      inputId="brave-search-api-key"
                      dataKey="brave-search-api-key"
                      placeholder="Optional web image search"
                      linkLabel="Get a Brave Search API key"
                      linkUrl="https://api.search.brave.com/"
                    />
                  </div>
                </SettingsGroup>
              </div>
            </div>
          )}

          {activeSection === "analysis" && (
            <div data-settings-page="analysis" data-analysis-settings>
              <SettingsPageHeader
                title="Key & BPM Analysis"
                description="Configure analysis performance, key notation, and optional source-file tag output."
              />
              <div className="space-y-5">
                <SettingsGroup title="Analysis">
                  <div className="space-y-5">
                    <div>
                      <label className="mb-2 block text-[var(--font-size-sm)] font-medium text-[var(--color-text-primary)]">
                        Analysis performance
                      </label>
                      <SelectShell className="max-w-md">
                        <select
                          value={analysisPerformance}
                          onChange={(event) => setAnalysisPerformance(event.target.value as "stable" | "fast" | "maximum")}
                          data-analysis-performance
                          className={selectClass}
                        >
                          <option value="stable">Stable — 1 worker</option>
                          <option value="fast">Fast — 2 isolated workers</option>
                          <option value="maximum">Maximum — up to 4 isolated workers</option>
                        </select>
                      </SelectShell>
                      <p className="mt-2 max-w-2xl text-[var(--font-size-xs)] leading-relaxed text-[var(--color-text-secondary)]">
                        More workers analyze separate songs at the same accuracy. Maximum may
                        increase power use, fan noise, and memory pressure.
                      </p>
                    </div>

                    <div>
                      <label className="mb-2 block text-[var(--font-size-sm)] font-medium text-[var(--color-text-primary)]">
                        Key notation
                      </label>
                      <SelectShell className="max-w-md">
                        <select
                          value={analysisNotation}
                          onChange={(event) => setAnalysisNotation(event.target.value as AnalysisNotationMode)}
                          data-analysis-notation
                          className={selectClass}
                        >
                          <option value="standard">Standard key (Am)</option>
                          <option value="custom">Custom / Camelot (8A)</option>
                          <option value="combined">Custom + standard key (8A Am)</option>
                          <option value="djCombined">DJ notation + key (8A - Am)</option>
                        </select>
                      </SelectShell>
                    </div>

                    {(analysisNotation === "custom" || analysisNotation === "combined") && (
                      <details>
                        <summary className="cursor-pointer text-[var(--font-size-sm)] font-medium text-[var(--color-text-primary)]">
                          Custom key codes
                        </summary>
                        <div className="mt-3 grid max-h-64 grid-cols-2 gap-2 overflow-auto pr-2 sm:grid-cols-3 md:grid-cols-4">
                          {KEY_NAMES.map((name, index) => (
                            <label key={name} className="flex items-center gap-2 text-[var(--font-size-xs)] text-[var(--color-text-secondary)]">
                              <span className="w-9 shrink-0">{name}</span>
                              <input
                                value={analysisCustomCodes[index] ?? ""}
                                onChange={(event) => setAnalysisCustomCode(index, event.target.value)}
                                className="h-8 min-w-0 flex-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-2 text-[var(--font-size-xs)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
                              />
                            </label>
                          ))}
                        </div>
                      </details>
                    )}

                    <div>
                      <label className="mb-2 block text-[var(--font-size-sm)] font-medium text-[var(--color-text-primary)]">
                        Display separator
                      </label>
                      <input
                        value={analysisDelimiter}
                        onChange={(event) => setAnalysisDelimiter(event.target.value)}
                        className={`${inputClass} w-32`}
                      />
                    </div>
                  </div>
                </SettingsGroup>

                <SettingsGroup
                  title="Audio-file tag output"
                  description="All outputs are disabled by default. Enabling one modifies source audio tags during analysis."
                >
                  <div className="grid gap-3 sm:grid-cols-2">
                    {ANALYSIS_OUTPUT_FIELDS.map(({ field, label, bpmOnly }) => (
                      <label key={field} className="text-[var(--font-size-xs)] text-[var(--color-text-secondary)]">
                        <span className="mb-1 block">{label}</span>
                        <select
                          value={analysisOutputs[field]}
                          onChange={(event) => setAnalysisOutput(
                            field,
                            event.target.value as AnalysisOutputMode,
                          )}
                          className="h-9 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-2 text-[var(--font-size-sm)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
                        >
                          <option value="none">Do not write</option>
                          {!bpmOnly && <option value="prepend">Prepend</option>}
                          {!bpmOnly && <option value="append">Append</option>}
                          <option value="overwrite">Overwrite</option>
                        </select>
                      </label>
                    ))}
                  </div>
                  <p className={`mt-4 text-[var(--font-size-xs)] ${writesAudioTags ? "text-amber-500" : "text-[var(--color-text-muted)]"}`}>
                    {writesAudioTags
                      ? "Enabled outputs modify tags in the source audio files during analysis."
                      : "Source audio files are not modified."}
                  </p>
                </SettingsGroup>
              </div>
            </div>
          )}

          {activeSection === "dj" && (
            <div data-settings-page="dj" data-developer-features>
              <SettingsPageHeader
                title="DJ & Mixing"
                description="Configure the experimental beat-grid and transition engine."
              />
              <SettingsGroup
                title="Experimental DJ mixing"
                description="Mix Next recommendations remain available when audio transitions are disabled."
              >
                <label className="flex items-center gap-[var(--spacing-sm)] text-[var(--font-size-sm)] font-medium text-[var(--color-text-primary)]">
                  <input
                    type="checkbox"
                    checked={djMixEnabled}
                    onChange={(event) => setDjMixEnabled(event.target.checked)}
                    data-dj-mix-feature-toggle
                  />
                  Enable experimental DJ mixing
                </label>
                <p className="mt-2 max-w-2xl text-[var(--font-size-xs)] leading-relaxed text-[var(--color-text-secondary)]">
                  Adds beat-grid analysis, manual two-track mixes, and optional automatic
                  transitions.
                </p>

                {djMixEnabled && (
                  <div className="mt-5 space-y-5 border-t border-[var(--color-border)] pt-5" data-dj-mix-settings>
                    <div>
                      <label className="flex items-center gap-[var(--spacing-sm)] text-[var(--font-size-sm)] font-medium text-[var(--color-text-primary)]">
                        <input
                          type="checkbox"
                          checked={autoMix}
                          onChange={(event) => setAutoMix(event.target.checked)}
                          data-mix-auto
                        />
                        Auto-mix into next track
                      </label>
                      <p className="mt-2 text-[var(--font-size-xs)] text-[var(--color-text-secondary)]">
                        Blends the end of the playing track into the first queued track.
                      </p>
                    </div>

                    <div>
                      <label className="mb-2 block text-[var(--font-size-sm)] font-medium text-[var(--color-text-primary)]">
                        Transition length
                      </label>
                      <SelectShell>
                        <select
                          className={selectClass}
                          onChange={(event) => setMixBars(Number(event.target.value) as MixBars)}
                          value={mixBars}
                          data-mix-bars
                        >
                          {MIX_BAR_OPTIONS.map((bars) => (
                            <option key={bars} value={bars}>{bars} bars</option>
                          ))}
                        </select>
                      </SelectShell>
                    </div>

                    <label className="flex items-center gap-[var(--spacing-sm)] text-[var(--font-size-sm)] font-medium text-[var(--color-text-primary)]">
                      <input
                        type="checkbox"
                        checked={mixPreservePitch}
                        onChange={(event) => setMixPreservePitch(event.target.checked)}
                        data-mix-preserve-pitch
                      />
                      Keep pitch constant
                    </label>
                  </div>
                )}
              </SettingsGroup>
            </div>
          )}

          {activeSection === "advanced" && (
            <div data-settings-page="advanced">
              <SettingsPageHeader
                title="Advanced"
                description="Developer tools and actions that can remove application data."
              />
              <SettingsGroup
                title="Danger zone"
                description="These actions are destructive and require confirmation."
                className="border-red-500/30"
              >
                <div className="flex flex-col items-start gap-3">
                  <div>
                    <h4 className="text-[var(--font-size-sm)] font-semibold text-[var(--color-text-primary)]">
                      Empty song database
                    </h4>
                    <p className="mt-1 text-[var(--font-size-xs)] leading-relaxed text-[var(--color-text-secondary)]">
                      Removes all songs from Muro's database for a clean development state.
                      Source audio files are not deleted.
                    </p>
                  </div>
                  <button
                    className="flex h-[var(--button-height)] items-center rounded-[var(--radius-md)] border border-red-500/40 bg-red-500/10 px-[var(--spacing-md)] text-[var(--font-size-sm)] font-medium text-red-500 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={onClearSongs}
                    disabled={clearSongsPending}
                    type="button"
                  >
                    {clearSongsPending ? "Clearing..." : "Empty song database"}
                  </button>
                </div>
              </SettingsGroup>
            </div>
          )}
        </div>
      </div>

      <MissingTracksModal
        isOpen={missingTracksOpen}
        tracks={verification.missingTracks}
        relinking={verification.relinking}
        onClose={() => setMissingTracksOpen(false)}
        onRelinkTrack={(trackId) => { void verification.relinkTrack(trackId); }}
        onAutoRelink={() => { void verification.autoRelink(); }}
      />
      <MisplacedTracksModal
        isOpen={misplacedTracksOpen}
        tracks={organization.lastResult?.misplaced ?? []}
        repairing={organization.repairing}
        onClose={() => setMisplacedTracksOpen(false)}
        onRepair={() => { void onRepairLibraryStructure(); }}
      />
    </div>
  );
};
