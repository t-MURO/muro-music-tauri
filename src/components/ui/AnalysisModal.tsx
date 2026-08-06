import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke } from "@muro/desktop/runtime";
import { t } from "../../i18n";
import {
  analysisResultFromTrack,
  cancelTrackAnalysis,
  listenKeyFinderEvents,
  normalizeBpm,
  BPM_RANGES,
  startTrackAnalysis,
  type AnalysisResult,
  type BpmRange,
} from "../../lib/keyfinder";
import { useSettingsStore } from "../../stores";
import type { Track } from "../../types";

type TrackAnalysis = {
  track: Track;
  result: AnalysisResult | null;
  error: string | null;
  writeError: string | null;
  rawBpm: number; // Store raw BPM for re-normalization
};

type AnalysisModalProps = {
  isOpen: boolean;
  isMinimized: boolean;
  tracks: Track[];
  dbPath: string;
  onClose: () => void;
  onMinimize: () => void;
  onRestore: () => void;
  onAnalysisComplete?: (results: Map<string, AnalysisResult>) => void;
};

// Keep each native job small so its completed job state and IPC payloads are
// released regularly during very large library selections.
const ANALYSIS_BATCH_SIZE = 1;
const ANALYSIS_BATCH_COOLDOWN_MS = 25;
const FALLBACK_TRACK_DURATION_SECONDS = 180;

const analysisWorkerCount = (performance: "stable" | "fast" | "maximum") => {
  if (performance === "stable") return 1;
  if (performance === "fast") return 2;
  const available = typeof navigator === "undefined"
    ? 4
    : Number(navigator.hardwareConcurrency) || 4;
  return Math.max(1, Math.min(4, available));
};

const formatEta = (seconds: number) => {
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainingSeconds = rounded % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${remainingSeconds}s`;
  return `${remainingSeconds}s`;
};

export const AnalysisModal = ({
  isOpen,
  isMinimized,
  tracks,
  dbPath,
  onClose,
  onMinimize,
  onRestore,
  onAnalysisComplete,
}: AnalysisModalProps) => {
  const analysisNotation = useSettingsStore((state) => state.analysisNotation);
  const analysisCustomCodes = useSettingsStore((state) => state.analysisCustomCodes);
  const analysisDelimiter = useSettingsStore((state) => state.analysisDelimiter);
  const analysisOutputs = useSettingsStore((state) => state.analysisOutputs);
  const analysisPerformance = useSettingsStore((state) => state.analysisPerformance);
  const [analyses, setAnalyses] = useState<TrackAnalysis[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [etaSeconds, setEtaSeconds] = useState<number | null>(null);
  const [selectedRange, setSelectedRange] = useState<BpmRange>(BPM_RANGES[0]);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const activeJobIdsRef = useRef(new Set<string>());
  const cancelRequestedRef = useRef(false);
  const resultsScrollRef = useRef<HTMLDivElement | null>(null);
  const analysisIndexRef = useRef(new Map<string, number>());
  const analysisStartedAtRef = useRef<number | null>(null);
  const rowVirtualizer = useVirtualizer({
    count: analyses.length,
    getScrollElement: () => resultsScrollRef.current,
    estimateSize: () => 41,
    overscan: 8,
  });

  // Initialize analyses when tracks change
  useEffect(() => {
    if (isOpen && tracks.length > 0) {
      analysisIndexRef.current = new Map(
        tracks.map((track, index) => [track.id, index])
      );
      setAnalyses(
        tracks.map((track) => ({
          track,
          result: null,
          error: null,
          writeError: null,
          rawBpm: 0,
        }))
      );
      setProgress({ current: 0, total: tracks.length });
      setEtaSeconds(null);
      analysisStartedAtRef.current = null;
    }
  }, [isOpen, tracks]);

  // Start the native KeyFinder job when the modal opens.
  useEffect(() => {
    if (!isOpen || tracks.length === 0 || isAnalyzing) {
      return;
    }

    let disposed = false;
    let removeListener: (() => void) | undefined;
    const finishedJobs = new Set<string>();
    const finishResolvers = new Map<string, () => void>();
    const trackProgress = new Map<string, number>();
    const completedTrackIds = new Set<string>();
    let nextTrackIndex = 0;
    let completedTracks = 0;
    let completedWork = 0;
    const trackWork = new Map(tracks.map((track) => [
      track.id,
      Number.isFinite(track.durationSeconds) && track.durationSeconds > 0
        ? track.durationSeconds
        : FALLBACK_TRACK_DURATION_SECONDS,
    ]));
    const totalWork = [...trackWork.values()].reduce((total, duration) => total + duration, 0);

    const updateEta = (completedWork: number) => {
      const startedAt = analysisStartedAtRef.current;
      if (startedAt === null || completedWork <= 0 || totalWork <= completedWork) {
        setEtaSeconds(totalWork <= completedWork ? 0 : null);
        return;
      }
      const elapsedSeconds = (performance.now() - startedAt) / 1000;
      if (elapsedSeconds < 2) return;
      const workPerSecond = completedWork / elapsedSeconds;
      if (workPerSecond <= 0) return;
      const estimate = (totalWork - completedWork) / workPerSecond;
      setEtaSeconds((previous) => previous === null
        ? estimate
        : (previous * 0.7) + (estimate * 0.3));
    };

    const updateAggregateEta = () => {
      const activeWork = [...trackProgress.entries()].reduce(
        (total, [trackId, fraction]) => (
          total + ((trackWork.get(trackId) ?? FALLBACK_TRACK_DURATION_SECONDS) * fraction)
        ),
        0,
      );
      updateEta(completedWork + activeWork);
    };

    const runAnalysis = async () => {
      cancelRequestedRef.current = false;
      analysisStartedAtRef.current = performance.now();
      setIsAnalyzing(true);
      setSaveError(null);
      try {
        removeListener = await listenKeyFinderEvents((event) => {
          if (disposed) return;
          if (event.event === "trackUpdated" && event.payload.track) {
            const engineTrack = event.payload.track;
            const analysisIndex = analysisIndexRef.current.get(engineTrack.id);
            if (analysisIndex === undefined) return;
            if (engineTrack.status === "completed") {
              const result = analysisResultFromTrack(engineTrack);
              setAnalyses((previous) => {
                const next = [...previous];
                const analysis = next[analysisIndex];
                if (analysis) {
                  next[analysisIndex] = {
                    ...analysis,
                    result,
                    rawBpm: result.bpm,
                    error: null,
                    writeError: engineTrack.error?.message || null,
                  };
                }
                return next;
              });
            } else if (engineTrack.status === "failed") {
              setAnalyses((previous) => {
                const next = [...previous];
                const analysis = next[analysisIndex];
                if (analysis) {
                  next[analysisIndex] = {
                    ...analysis,
                    result: null,
                    rawBpm: 0,
                    error: engineTrack.error?.message || "Analysis failed",
                    writeError: null,
                  };
                }
                return next;
              });
            }
          } else if (event.event === "trackProgress" && event.payload.trackId) {
            const fraction = Math.max(0, Math.min(1, Number(event.payload.fraction) || 0));
            trackProgress.set(event.payload.trackId, fraction);
            updateAggregateEta();
          } else if (event.event === "jobFinished") {
            finishedJobs.add(event.jobId);
            activeJobIdsRef.current.delete(event.jobId);
            finishResolvers.get(event.jobId)?.();
            finishResolvers.delete(event.jobId);
          }
        });

        const runWorker = async () => {
          while (!disposed && !cancelRequestedRef.current) {
            const offset = nextTrackIndex;
            nextTrackIndex += ANALYSIS_BATCH_SIZE;
            if (offset >= tracks.length) return;
            const batch = tracks.slice(offset, offset + ANALYSIS_BATCH_SIZE);
            try {
              const started = await startTrackAnalysis(batch, {
                performance: analysisPerformance,
                notation: analysisNotation,
                customCodes: analysisCustomCodes,
                delimiter: analysisDelimiter,
                outputs: analysisOutputs,
              });
              if (disposed || cancelRequestedRef.current) {
                await cancelTrackAnalysis(started.jobId).catch(() => undefined);
                return;
              }
              if (!finishedJobs.has(started.jobId)) {
                activeJobIdsRef.current.add(started.jobId);
                await new Promise<void>((resolve) => {
                  if (finishedJobs.has(started.jobId)) {
                    activeJobIdsRef.current.delete(started.jobId);
                    resolve();
                  } else {
                    finishResolvers.set(started.jobId, resolve);
                  }
                });
              }
            } catch (error) {
              if (disposed) return;
              const message = error instanceof Error ? error.message : "Analysis failed";
              setAnalyses((previous) => {
                const next = [...previous];
                for (const track of batch) {
                  const analysisIndex = analysisIndexRef.current.get(track.id);
                  if (analysisIndex === undefined || !next[analysisIndex]) continue;
                  next[analysisIndex] = {
                    ...next[analysisIndex],
                    result: null,
                    rawBpm: 0,
                    error: message,
                    writeError: null,
                  };
                }
                return next;
              });
            } finally {
              for (const track of batch) {
                trackProgress.delete(track.id);
                if (completedTrackIds.has(track.id)) continue;
                completedTrackIds.add(track.id);
                completedTracks += 1;
                completedWork += trackWork.get(track.id) ?? FALLBACK_TRACK_DURATION_SECONDS;
              }
              updateAggregateEta();
              setProgress({ current: Math.min(completedTracks, tracks.length), total: tracks.length });
            }
            if (nextTrackIndex < tracks.length) {
              await new Promise((resolve) =>
                window.setTimeout(resolve, ANALYSIS_BATCH_COOLDOWN_MS)
              );
            }
          }
        };

        const workers = Math.min(tracks.length, analysisWorkerCount(analysisPerformance));
        await Promise.all(Array.from({ length: workers }, () => runWorker()));
      } catch (error) {
        if (disposed) return;
        const message = error instanceof Error ? error.message : "Analysis failed";
        setAnalyses((previous) => previous.map((analysis) =>
          analysis.result || analysis.error
            ? analysis
            : { ...analysis, error: message }
        ));
      } finally {
        if (!disposed) setIsAnalyzing(false);
      }
    };

    void runAnalysis();

    return () => {
      disposed = true;
      removeListener?.();
      for (const resolve of finishResolvers.values()) resolve();
      finishResolvers.clear();
      const activeJobIds = [...activeJobIdsRef.current];
      activeJobIdsRef.current.clear();
      for (const jobId of activeJobIds) {
        void cancelTrackAnalysis(jobId).catch(() => undefined);
      }
    };
  }, [isOpen, tracks]);

  // Re-normalize BPM when range changes
  useEffect(() => {
    setAnalyses((prev) =>
      prev.map((a) => {
        if (a.result && a.rawBpm > 0) {
          const normalizedBpm = normalizeBpm(
            a.rawBpm,
            selectedRange.min,
            selectedRange.max
          );
          return {
            ...a,
            result: { ...a.result, bpm: normalizedBpm },
          };
        }
        return a;
      })
    );
  }, [selectedRange]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setSaveError(null);

    try {
      const results = new Map<string, AnalysisResult>();

      for (const analysis of analyses) {
        if (analysis.result) {
          results.set(analysis.track.id, analysis.result);

          // Save to database
          await invoke("update_track_analysis", {
            dbPath,
            trackId: analysis.track.id,
            bpm: analysis.result.bpm > 0 ? analysis.result.bpm : null,
            key: analysis.result.camelot !== "?" ? analysis.result.camelot : null,
          });
        }
      }

      onAnalysisComplete?.(results);
      onClose();
    } catch (error) {
      console.error("Failed to save analysis results:", error);
      setSaveError(error instanceof Error ? error.message : "Failed to save");
    } finally {
      setIsSaving(false);
    }
  }, [analyses, dbPath, onAnalysisComplete, onClose]);

  const handleCancel = useCallback(() => {
    cancelRequestedRef.current = true;
    const activeJobIds = [...activeJobIdsRef.current];
    activeJobIdsRef.current.clear();
    for (const jobId of activeJobIds) {
      void cancelTrackAnalysis(jobId).catch(() => undefined);
    }
  }, []);

  const handleClose = useCallback(() => {
    // Cancel any ongoing analysis when closing
    handleCancel();
    onClose();
  }, [handleCancel, onClose]);

  useEffect(() => {
    if (!isOpen || isMinimized) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        handleClose(); // Cancels analysis and closes
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, isMinimized, handleClose]);

  if (!isOpen || typeof document === "undefined") {
    return null;
  }

  const isSingleTrack = tracks.length === 1;
  const hasResults = analyses.some((a) => a.result !== null);
  const allComplete = !isAnalyzing && analyses.length > 0;
  const successfulCount = analyses.filter((analysis) => analysis.result !== null).length;
  const failedCount = analyses.filter((analysis) => analysis.error !== null).length;
  const writeWarningCount = analyses.filter((analysis) => analysis.writeError !== null).length;
  const progressPercent = progress.total > 0
    ? Math.min(100, (progress.current / progress.total) * 100)
    : 0;
  const etaLabel = isAnalyzing
    ? etaSeconds === null
      ? t("analysis.etaCalculating")
      : t("analysis.etaRemaining", { time: formatEta(etaSeconds) })
    : t("analysis.complete");

  if (isMinimized) {
    return createPortal(
      <button
        type="button"
        onClick={onRestore}
        title={t("analysis.restore")}
        className="fixed bottom-6 right-6 z-50 w-[290px] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-[var(--spacing-md)] text-left shadow-[var(--shadow-lg)] transition-transform hover:-translate-y-0.5"
      >
        <div className="flex items-center gap-[var(--spacing-sm)]">
          {isAnalyzing && (
            <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-[var(--color-accent)] border-t-transparent" />
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[var(--font-size-sm)] font-semibold text-[var(--color-text-primary)]">
              {t("analysis.title")}
            </div>
            <div className="mt-0.5 flex justify-between gap-2 text-[var(--font-size-xs)] text-[var(--color-text-muted)]">
              <span>{t("analysis.progress", {
                current: String(progress.current),
                total: String(progress.total),
              })}</span>
              <span className="truncate">{etaLabel}</span>
            </div>
          </div>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--color-bg-secondary)]">
          <div
            className="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-200"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </button>,
      document.body,
    );
  }

  return createPortal(
    <div
      className="modal-overlay-animate fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-[var(--spacing-lg)] backdrop-blur-sm"
      onClick={handleClose}
    >
      <div
        className="modal-panel-animate flex max-h-[80vh] w-full max-w-[600px] flex-col rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] shadow-[var(--shadow-lg)]"
        onClick={(event) => event.stopPropagation()}
      >
        {/* Header */}
        <div className="border-b border-[var(--color-border)] p-[var(--spacing-lg)]">
          <div className="flex items-start justify-between gap-[var(--spacing-md)]">
            <h2 className="text-[var(--font-size-md)] font-semibold text-[var(--color-text-primary)]">
              {t("analysis.title")}
            </h2>
            <button
              type="button"
              onClick={onMinimize}
              title={t("analysis.minimize")}
              aria-label={t("analysis.minimize")}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-lg leading-none text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text-primary)]"
            >
              <span aria-hidden="true">−</span>
            </button>
          </div>
          <p className="mt-[var(--spacing-xs)] text-[var(--font-size-xs)] text-[var(--color-text-muted)]">
            {isAnalyzing
              ? t("analysis.analyzing")
              : allComplete
                ? t("analysis.complete")
                : t("analysis.subtitle")}
          </p>
          {tracks.length > 1 && (
            <div className="mt-[var(--spacing-sm)]">
              <div className="mb-1 flex items-center justify-between text-[var(--font-size-xs)] text-[var(--color-text-secondary)]">
                <span>{t("analysis.progress", {
                  current: String(progress.current),
                  total: String(progress.total),
                })}</span>
                <span>{t("analysis.resultSummary", {
                  success: String(successfulCount),
                  failed: String(failedCount),
                })}</span>
              </div>
              <div className="mb-1 text-[var(--font-size-xs)] text-[var(--color-text-muted)]">
                {etaLabel}
              </div>
              {writeWarningCount > 0 && (
                <div className="mb-1 text-[var(--font-size-xs)] text-amber-500">
                  {t("analysis.writeWarnings", { count: String(writeWarningCount) })}
                </div>
              )}
              <div className="h-1.5 overflow-hidden rounded-full bg-[var(--color-bg-secondary)]">
                <div
                  className="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-200"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-[var(--spacing-lg)]">
          {/* BPM Range Selector */}
          <div className="mb-[var(--spacing-md)]">
            <label className="mb-[var(--spacing-xs)] block text-[var(--font-size-xs)] font-medium text-[var(--color-text-secondary)]">
              {t("analysis.bpmRange")}
            </label>
            <select
              className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-[var(--spacing-md)] py-[var(--spacing-sm)] text-[var(--font-size-sm)] text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
              value={`${selectedRange.min}-${selectedRange.max}`}
              onChange={(e) => {
                const [min, max] = e.target.value.split("-").map(Number);
                const range = BPM_RANGES.find(
                  (r) => r.min === min && r.max === max
                );
                if (range) {
                  setSelectedRange(range);
                }
              }}
            >
              {BPM_RANGES.map((range) => (
                <option
                  key={`${range.min}-${range.max}`}
                  value={`${range.min}-${range.max}`}
                >
                  {range.label}
                </option>
              ))}
            </select>
            {Object.values(analysisOutputs).some((mode) => mode !== "none") && (
              <p className="mt-2 text-[var(--font-size-xs)] text-amber-500">
                Enabled tag outputs are being written to the source audio files.
              </p>
            )}
          </div>

          {/* Results */}
          {isSingleTrack && analyses[0] ? (
            // Single track view
            <div className="space-y-[var(--spacing-md)]">
              <div className="text-center">
                <div className="text-[var(--font-size-sm)] font-medium text-[var(--color-text-primary)]">
                  {analyses[0].track.title}
                </div>
                <div className="text-[var(--font-size-xs)] text-[var(--color-text-muted)]">
                  {analyses[0].track.artist}
                </div>
              </div>

              {analyses[0].error ? (
                <div className="rounded-[var(--radius-md)] bg-red-500/10 p-[var(--spacing-md)] text-center text-[var(--font-size-sm)] text-red-500">
                  {analyses[0].error}
                </div>
              ) : analyses[0].result ? (
                <>
                  <div className="grid grid-cols-2 gap-[var(--spacing-md)]">
                    <div className="rounded-[var(--radius-md)] bg-[var(--color-bg-secondary)] p-[var(--spacing-md)] text-center">
                      <div className="text-[var(--font-size-xs)] text-[var(--color-text-muted)]">
                        BPM
                      </div>
                      <div className="text-[var(--font-size-xl)] font-bold text-[var(--color-text-primary)]">
                        {analyses[0].result.bpm > 0
                          ? analyses[0].result.bpm.toFixed(1)
                          : "N/A"}
                      </div>
                    </div>
                    <div className="rounded-[var(--radius-md)] bg-[var(--color-bg-secondary)] p-[var(--spacing-md)] text-center">
                      <div className="text-[var(--font-size-xs)] text-[var(--color-text-muted)]">
                        {t("analysis.key")}
                      </div>
                      <div className="text-[var(--font-size-xl)] font-bold text-[var(--color-text-primary)]">
                        {analyses[0].result.camelot}
                      </div>
                      <div className="text-[var(--font-size-xs)] text-[var(--color-text-muted)]">
                        {analyses[0].result.key} {analyses[0].result.scale}
                      </div>
                    </div>
                  </div>
                  {analyses[0].writeError && (
                    <div className="rounded-[var(--radius-md)] bg-amber-500/10 p-[var(--spacing-md)] text-center text-[var(--font-size-sm)] text-amber-500">
                      {analyses[0].writeError}
                    </div>
                  )}
                </>
              ) : (
                <div className="flex items-center justify-center py-[var(--spacing-lg)]">
                  <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--color-accent)] border-t-transparent" />
                </div>
              )}
            </div>
          ) : (
            // Multiple tracks table view
            <div className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)]">
              <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_70px_60px] border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--font-size-xs)] font-medium text-[var(--color-text-secondary)]">
                <div className="px-[var(--spacing-md)] py-[var(--spacing-sm)]">{t("columns.title")}</div>
                <div className="px-[var(--spacing-md)] py-[var(--spacing-sm)]">{t("columns.artist")}</div>
                <div className="px-[var(--spacing-md)] py-[var(--spacing-sm)] text-right">BPM</div>
                <div className="px-[var(--spacing-md)] py-[var(--spacing-sm)] text-right">{t("columns.key")}</div>
              </div>
              <div ref={resultsScrollRef} className="max-h-[360px] overflow-auto">
                <div className="relative w-full" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
                  {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                    const analysis = analyses[virtualRow.index];
                    if (!analysis) return null;
                    return (
                    <div
                      key={analysis.track.id}
                      title={analysis.error ?? analysis.writeError ?? undefined}
                      className="absolute left-0 top-0 grid w-full grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_70px_60px] border-b border-[var(--color-border)]"
                      style={{ transform: `translateY(${virtualRow.start}px)`, height: `${virtualRow.size}px` }}
                    >
                      <div className="flex min-w-0 items-center gap-1 px-[var(--spacing-md)] py-[var(--spacing-sm)] text-[var(--font-size-sm)] text-[var(--color-text-primary)]">
                        <span className="truncate">{analysis.track.title}</span>
                        {analysis.writeError && (
                          <span className="shrink-0 font-bold text-amber-500" aria-label={analysis.writeError}>!</span>
                        )}
                      </div>
                      <div className="truncate px-[var(--spacing-md)] py-[var(--spacing-sm)] text-[var(--font-size-sm)] text-[var(--color-text-muted)]">
                        {analysis.track.artist}
                      </div>
                      <div className="px-[var(--spacing-md)] py-[var(--spacing-sm)] text-right text-[var(--font-size-sm)]">
                        {analysis.error ? (
                          <span className="text-red-500">Error</span>
                        ) : analysis.result ? (
                          <span className="font-medium text-[var(--color-text-primary)]">
                            {analysis.result.bpm > 0
                              ? analysis.result.bpm.toFixed(1)
                              : "N/A"}
                          </span>
                        ) : (
                          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-[var(--color-accent)] border-t-transparent" />
                        )}
                      </div>
                      <div className="px-[var(--spacing-md)] py-[var(--spacing-sm)] text-right text-[var(--font-size-sm)]">
                        {analysis.error ? (
                          <span className="text-red-500">-</span>
                        ) : analysis.result ? (
                          <span className="font-medium text-[var(--color-text-primary)]">
                            {analysis.result.camelot}
                          </span>
                        ) : (
                          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-[var(--color-accent)] border-t-transparent" />
                        )}
                      </div>
                    </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-[var(--color-border)] p-[var(--spacing-lg)]">
          {saveError && (
            <div className="mb-[var(--spacing-sm)] rounded-[var(--radius-md)] bg-red-500/10 px-[var(--spacing-md)] py-[var(--spacing-sm)] text-[var(--font-size-xs)] text-red-500">
              {saveError}
            </div>
          )}
          <div className="flex items-center justify-end gap-[var(--spacing-sm)]">
            {isAnalyzing ? (
              <button
                className="rounded-[var(--radius-md)] bg-red-500/10 px-[var(--spacing-md)] py-[var(--spacing-sm)] text-[var(--font-size-sm)] font-medium text-red-500 transition-colors hover:bg-red-500/20"
                onClick={handleCancel}
                type="button"
              >
                {t("analysis.cancel")}
              </button>
            ) : (
              <>
                <button
                  className="rounded-[var(--radius-md)] px-[var(--spacing-md)] py-[var(--spacing-sm)] text-[var(--font-size-sm)] font-medium text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)]"
                  onClick={handleClose}
                  type="button"
                >
                  {t("analysis.close")}
                </button>
                <button
                  className="rounded-[var(--radius-md)] bg-[var(--color-accent)] px-[var(--spacing-md)] py-[var(--spacing-sm)] text-[var(--font-size-sm)] font-semibold text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={handleSave}
                  disabled={!hasResults || isSaving}
                  type="button"
                >
                  {isSaving ? t("analysis.saving") : t("analysis.save")}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
