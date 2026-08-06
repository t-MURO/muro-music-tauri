import {
  AudioWaveform,
  Blend,
  ListMinus,
  ListPlus,
  Pencil,
  Play,
  SkipForward,
  Trash2,
  X,
} from "lucide-react";
import { t } from "../../i18n";

type TrackSelectionBarProps = {
  selectedCount: number;
  onPlay: () => void;
  onMix?: () => void;
  onPlayNext: () => void;
  onAddToQueue: () => void;
  onAnalyze: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onClear: () => void;
  onRemoveFromPlaylist?: () => void;
};

const actionClass =
  "inline-flex h-9 shrink-0 items-center gap-2 rounded-[var(--radius-md)] px-3 text-[12px] font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]";

export const TrackSelectionBar = ({
  selectedCount,
  onPlay,
  onMix,
  onPlayNext,
  onAddToQueue,
  onAnalyze,
  onEdit,
  onDelete,
  onClear,
  onRemoveFromPlaylist,
}: TrackSelectionBarProps) => {
  if (selectedCount <= 0) return null;

  return (
    <div
      className="flex min-h-[52px] shrink-0 items-center gap-1 overflow-x-auto border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 shadow-[0_-8px_24px_rgba(0,0,0,0.12)]"
      data-selection-bar
      role="toolbar"
      aria-label={t("selection.aria", { count: String(selectedCount) })}
    >
      <div className="mr-2 flex h-8 shrink-0 items-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-accent-light)] px-3 text-[12px] font-semibold text-[var(--color-accent)]">
        <span className="tabular-nums">{selectedCount.toLocaleString()}</span>
        <span>{t(
          selectedCount === 1 ? "selection.count.one" : "selection.count.many",
          { count: String(selectedCount) },
        )}</span>
      </div>
      <button className={`${actionClass} bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] hover:text-white`} onClick={onPlay} data-selection-play type="button"><Play className="h-3.5 w-3.5" fill="currentColor" />{t("selection.play")}</button>
      {selectedCount === 2 && onMix && (
        <button className={actionClass} onClick={onMix} title={t("selection.mixHint")} data-selection-mix type="button"><Blend className="h-3.5 w-3.5" />{t("selection.mix")}</button>
      )}
      <button className={actionClass} onClick={onPlayNext} data-selection-play-next type="button"><SkipForward className="h-3.5 w-3.5" />{t("selection.playNext")}</button>
      <button className={actionClass} onClick={onAddToQueue} data-selection-queue type="button"><ListPlus className="h-3.5 w-3.5" />{t("selection.queue")}</button>
      <span className="mx-1 h-5 w-px shrink-0 bg-[var(--color-border)]" aria-hidden="true" />
      <button className={actionClass} onClick={onAnalyze} data-selection-analyze type="button"><AudioWaveform className="h-3.5 w-3.5" />{t("selection.analyze")}</button>
      <button className={actionClass} onClick={onEdit} data-selection-edit type="button"><Pencil className="h-3.5 w-3.5" />{t("selection.edit")}</button>
      {onRemoveFromPlaylist && (
        <button className={actionClass} onClick={onRemoveFromPlaylist} data-remove-from-playlist type="button"><ListMinus className="h-3.5 w-3.5" />{t("selection.remove")}</button>
      )}
      <button className={`${actionClass} text-[var(--color-danger)] hover:text-[var(--color-danger)]`} onClick={onDelete} data-selection-delete type="button"><Trash2 className="h-3.5 w-3.5" />{t("selection.delete")}</button>
      <button className="toolbar-icon-button ml-auto h-9 w-9 shrink-0" onClick={onClear} title={t("selection.clear")} aria-label={t("selection.clear")} data-selection-clear type="button"><X className="h-4 w-4" /></button>
    </div>
  );
};
