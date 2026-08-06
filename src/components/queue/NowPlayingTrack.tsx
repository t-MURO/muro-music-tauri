import { Music2 } from "lucide-react";
import { convertFileSrc } from "@muro/desktop/runtime";
import { t } from "../../i18n";
import { usePlaybackStore } from "../../stores";
import type { CurrentTrack } from "../../hooks";
import type { Track } from "../../types";

type NowPlayingTrackProps = {
  currentTrack: CurrentTrack | null;
  trackDetails?: Track | null;
};

const formatTime = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
};

export const NowPlayingTrack = ({ currentTrack, trackDetails }: NowPlayingTrackProps) => {
  const position = usePlaybackStore((state) => state.currentPosition);
  const duration = usePlaybackStore((state) => state.duration);
  const progress = duration > 0 ? Math.min(100, Math.max(0, (position / duration) * 100)) : 0;

  if (!currentTrack) {
    return (
      <div className="flex w-full items-center gap-3 px-4 py-3 text-[var(--color-text-muted)]">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg-tertiary)]"><Music2 className="h-5 w-5" /></div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{t("player.empty.title")}</div>
          <div className="mt-1 truncate text-[10px]">{t("player.empty.subtitle")}</div>
        </div>
      </div>
    );
  }

  const coverPath = currentTrack.coverArtPath || currentTrack.coverArtThumbPath;
  return (
    <div className="px-4 pb-4">
      <div className="flex items-center gap-3">
        <div className="h-[92px] w-[92px] shrink-0 overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg-tertiary)]">
          {coverPath ? <img src={convertFileSrc(coverPath)} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full w-full items-center justify-center text-[var(--color-text-muted)]"><Music2 className="h-5 w-5" /></div>}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-[var(--color-text-primary)]">{currentTrack.title}</div>
          <div className="mt-1 truncate text-[11px] text-[var(--color-text-secondary)]">{currentTrack.artist}</div>
          <div className="mt-0.5 truncate text-[10px] text-[var(--color-text-muted)]">{currentTrack.album}</div>
          {(trackDetails?.bitrate || trackDetails?.bpm || trackDetails?.key) && (
            <div className="mt-2 truncate text-[10px] tabular-nums text-[var(--color-text-muted)]">
              {[trackDetails?.bitrate, trackDetails?.bpm ? `${trackDetails.bpm.toFixed(1)} BPM` : "", trackDetails?.key].filter(Boolean).join(" · ")}
            </div>
          )}
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2.5">
        <span className="text-[10px] tabular-nums text-[var(--color-text-muted)]">{formatTime(position)}</span>
        <div className="h-0.5 flex-1 overflow-hidden bg-[var(--color-bg-tertiary)]">
          <div className="h-full bg-[var(--color-accent)]" style={{ width: `${progress}%` }} />
        </div>
        <span className="text-[10px] tabular-nums text-[var(--color-text-muted)]">{formatTime(duration)}</span>
      </div>
    </div>
  );
};
