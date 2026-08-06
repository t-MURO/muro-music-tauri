import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import {
  ArrowRight,
  Blend,
  Music2,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from "lucide-react";
import { convertFileSrc } from "@muro/desktop/runtime";
import { t } from "../../i18n";
import { getAudioWaveform } from "../../lib/keyfinder";
import { useLibraryStore, usePlaybackStore } from "../../stores";
import { RatingCell } from "../library/RatingCell";
import { OutputMenu } from "../player/OutputMenu";
import { WaveformSeekBar } from "../player/WaveformSeekBar";

const formatTime = (seconds: number) => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
};

type PlayerBarProps = {
  onTogglePlay: () => void;
  onOpenCurrentTrack: () => void;
  onSeekChange: (value: number) => void;
  onVolumeChange: (value: number) => void;
  onSkipPrevious: () => void;
  onSkipNext: () => void;
  onRatingChange: (id: string, rating: number) => void;
  transition?: { status: string; toTitle: string; progress: number } | null;
};

export const PlayerBar = ({
  onTogglePlay,
  onOpenCurrentTrack,
  onSeekChange,
  onVolumeChange,
  onSkipPrevious,
  onSkipNext,
  onRatingChange,
  transition,
}: PlayerBarProps) => {
  const isPlaying = usePlaybackStore((state) => state.isPlaying);
  const shuffleEnabled = usePlaybackStore((state) => state.shuffleEnabled);
  const repeatMode = usePlaybackStore((state) => state.repeatMode);
  const currentPosition = usePlaybackStore((state) => state.currentPosition);
  const duration = usePlaybackStore((state) => state.duration);
  const volume = usePlaybackStore((state) => state.volume);
  const currentTrack = usePlaybackStore((state) => state.currentTrack);
  const toggleShuffle = usePlaybackStore((state) => state.toggleShuffle);
  const toggleRepeat = usePlaybackStore((state) => state.toggleRepeat);
  const libraryTracks = useLibraryStore((state) => state.tracks);
  const inboxTracks = useLibraryStore((state) => state.inboxTracks);
  const trackDetails = currentTrack
    ? [...libraryTracks, ...inboxTracks].find((track) => track.id === currentTrack.id)
    : undefined;

  const [isSeeking, setIsSeeking] = useState(false);
  const [seekValue, setSeekValue] = useState(0);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [waveformLoading, setWaveformLoading] = useState(false);
  const progressRef = useRef<HTMLDivElement | null>(null);
  const isSeekingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setPeaks([]);
    if (!currentTrack?.sourcePath) return () => { cancelled = true; };
    setWaveformLoading(true);
    getAudioWaveform(currentTrack.sourcePath, 768)
      .then((result) => {
        if (!cancelled) setPeaks(Array.isArray(result.peaks) ? result.peaks : []);
      })
      .catch((error) => {
        console.warn("Could not generate playback waveform", error);
      })
      .finally(() => {
        if (!cancelled) setWaveformLoading(false);
      });
    return () => { cancelled = true; };
  }, [currentTrack?.sourcePath]);

  const displayPosition = isSeeking ? seekValue : currentPosition;
  const progress = duration > 0
    ? Math.min(100, Math.max(0, (displayPosition / duration) * 100))
    : 0;
  const volumePercent = volume * 100;

  const getSeekValue = useCallback((clientX: number) => {
    if (!progressRef.current || duration <= 0) return 0;
    const rect = progressRef.current.getBoundingClientRect();
    const clamped = Math.min(Math.max(clientX - rect.left, 0), rect.width);
    return (rect.width > 0 ? clamped / rect.width : 0) * duration;
  }, [duration]);

  const updateSeekValue = useCallback((clientX: number) => {
    const value = getSeekValue(clientX);
    setSeekValue(value);
    return value;
  }, [getSeekValue]);

  const handleSeekStart = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (duration <= 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    isSeekingRef.current = true;
    setIsSeeking(true);
    updateSeekValue(event.clientX);
  }, [duration, updateSeekValue]);

  const handleSeekMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (isSeekingRef.current) updateSeekValue(event.clientX);
  }, [updateSeekValue]);

  const handleSeekEnd = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!isSeekingRef.current) return;
    const value = updateSeekValue(event.clientX);
    isSeekingRef.current = false;
    setIsSeeking(false);
    onSeekChange(value);
  }, [onSeekChange, updateSeekValue]);

  const handleSeekCancel = useCallback(() => {
    isSeekingRef.current = false;
    setIsSeeking(false);
  }, []);

  const controlButtonClass = "player-bar-button flex h-8 w-8 items-center justify-center rounded-[var(--radius-md)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]";

  const showTransitionBadge =
    transition != null && (transition.status === "armed" || transition.status === "active");
  const isMixing = transition?.status === "active";
  const transitionPercent = transition
    ? Math.round(Math.min(1, Math.max(0, transition.progress)) * 100)
    : 0;

  return (
    <footer className="player-bar relative col-span-3 col-start-1 row-start-3 grid h-[var(--media-controls-height)] grid-cols-[minmax(320px,420px)_minmax(360px,1fr)_minmax(190px,270px)] items-center gap-5 border-t border-[var(--color-border)] bg-[var(--color-bg-primary)] px-4 py-3">
      {isMixing && transition && (
        <div
          className="absolute inset-x-0 top-0 h-[3px] overflow-hidden bg-[var(--color-bg-tertiary)]"
          role="progressbar"
          aria-label={`Mix progress into ${transition.toTitle}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={transitionPercent}
          data-mix-progress
        >
          <span
            className="absolute inset-y-0 left-0 rounded-r-[var(--radius-full)] bg-[var(--color-accent)] transition-[width] duration-150 ease-linear"
            style={{ width: `${transitionPercent}%` }}
          >
            <span className="absolute right-0 top-1/2 h-2 w-2 -translate-y-1/2 translate-x-1/2 animate-pulse rounded-full bg-[var(--color-accent)] shadow-[0_0_10px_var(--color-accent)]" />
          </span>
        </div>
      )}
      <div className="flex min-w-0 items-center gap-3">
        <button
          className="group flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-default"
          onClick={onOpenCurrentTrack}
          disabled={!currentTrack}
          title={currentTrack ? "Show current track in its list" : undefined}
          type="button"
          data-now-playing-link
        >
          {currentTrack?.coverArtThumbPath ? (
            <img src={convertFileSrc(currentTrack.coverArtThumbPath)} alt={`${currentTrack.title} cover`} className="h-[62px] w-[62px] shrink-0 rounded-[var(--radius-sm)] border border-[var(--color-border)] object-cover transition-colors group-hover:border-[var(--color-accent)]" />
          ) : (
            <div className="flex h-[62px] w-[62px] shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] transition-colors group-hover:border-[var(--color-accent)]"><Music2 className="h-5 w-5" /></div>
          )}
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold text-[var(--color-text-primary)]">{currentTrack ? currentTrack.title : t("player.empty.title")}</p>
            {showTransitionBadge && transition ? (
              <div
                className="mt-1 flex max-w-full items-center gap-1.5 rounded-[var(--radius-full)] border border-[var(--color-accent)] bg-[var(--color-accent-light)] px-2 py-1 text-[10px] font-semibold text-[var(--color-accent)] shadow-[0_0_14px_var(--color-accent-light)]"
                data-transition-badge={transition.status}
                data-mix-indicator={transition.status}
                role="status"
                aria-live="polite"
              >
                <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
                  {isMixing && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-accent)] opacity-60" />}
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--color-accent)]" />
                </span>
                <Blend className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span className="shrink-0 uppercase tracking-[0.08em]">
                  {isMixing ? "Mixing" : "Mix ready"}
                </span>
                {isMixing && <span className="shrink-0 tabular-nums" data-mix-percent>{transitionPercent}%</span>}
                <ArrowRight className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
                <span className="truncate text-[var(--color-text-primary)]">{transition.toTitle}</span>
              </div>
            ) : (
              <p className="mt-0.5 truncate text-[11px] text-[var(--color-text-secondary)]">{currentTrack ? currentTrack.artist : t("player.empty.subtitle")}</p>
            )}
            {currentTrack?.album && <p className="mt-0.5 truncate text-[10px] text-[var(--color-text-muted)]">{currentTrack.album}</p>}
          </div>
        </button>
        {currentTrack && trackDetails && (
          <div className="flex shrink-0 flex-col gap-1.5 border-l border-[var(--color-border-light)] pl-3" data-player-track-metadata>
            <div className="flex items-center gap-2 text-[10px] tabular-nums text-[var(--color-text-muted)]">
              {trackDetails.bpm ? <span>{trackDetails.bpm.toFixed(1)} BPM</span> : <span>— BPM</span>}
              <span className="font-semibold text-[var(--color-accent)]">{trackDetails.key || "—"}</span>
            </div>
            <RatingCell
              compact
              trackId={trackDetails.id}
              title={trackDetails.title}
              rating={trackDetails.rating}
              onRate={onRatingChange}
            />
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex items-center justify-center gap-2">
          <button className={`${controlButtonClass} ${shuffleEnabled ? "text-[var(--color-accent)]" : ""}`} onClick={toggleShuffle} title={t("player.shuffle")} type="button"><Shuffle className="h-4 w-4" /></button>
          <button className={controlButtonClass} onClick={onSkipPrevious} title={t("player.previous")} type="button"><SkipBack className="h-[18px] w-[18px]" /></button>
          <button className="player-bar-play-button flex h-10 w-10 items-center justify-center rounded-full border border-[var(--color-accent)] bg-transparent text-[var(--color-text-primary)] hover:bg-[var(--color-accent-light)]" onClick={onTogglePlay} title={t(isPlaying ? "player.pause" : "player.play")} type="button">
            {isPlaying ? <Pause className="h-[18px] w-[18px]" fill="currentColor" /> : <Play className="h-[18px] w-[18px] translate-x-px" fill="currentColor" />}
          </button>
          <button className={controlButtonClass} onClick={onSkipNext} title={t("player.next")} type="button"><SkipForward className="h-[18px] w-[18px]" /></button>
          <button className={`${controlButtonClass} ${repeatMode !== "off" ? "text-[var(--color-accent)]" : ""}`} onClick={toggleRepeat} title={t(repeatMode === "off" ? "player.repeat" : repeatMode === "all" ? "player.repeatAll" : "player.repeatOne")} type="button">
            {repeatMode === "one" ? <Repeat1 className="h-4 w-4" /> : <Repeat className="h-4 w-4" />}
          </button>
        </div>
        <div className="group flex min-w-0 items-center gap-2.5">
          <span className="w-9 text-right text-[10px] tabular-nums text-[var(--color-text-secondary)]">{formatTime(displayPosition)}</span>
          <WaveformSeekBar
            peaks={peaks}
            progress={progress}
            duration={duration}
            displayPosition={displayPosition}
            onSeekStart={handleSeekStart}
            onSeekMove={handleSeekMove}
            onSeekEnd={handleSeekEnd}
            onSeekCancel={handleSeekCancel}
            progressRef={progressRef}
          />
          <span className="w-9 text-[10px] tabular-nums text-[var(--color-text-secondary)]">{formatTime(duration)}</span>
        </div>
        {waveformLoading && <span className="sr-only" role="status">{t("player.waveform.generating")}</span>}
      </div>

      <div className="flex items-center justify-end gap-3 pr-2">
        <OutputMenu />
        <button className={controlButtonClass} onClick={() => onVolumeChange(volume > 0 ? 0 : 0.8)} title={t(volume > 0 ? "player.mute" : "player.unmute")} type="button">
          {volume > 0 ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
        </button>
        <div className="player-volume-control relative h-1 w-[92px]">
          <input type="range" min="0" max="100" value={volumePercent} onChange={(event) => onVolumeChange(Number(event.target.value) / 100)} className="absolute left-0 top-0 z-[2] h-full w-full cursor-pointer opacity-0" aria-label={t("player.volume")} />
          <div className="player-volume-fill" style={{ width: `${volumePercent}%` }} />
        </div>
      </div>
    </footer>
  );
};
