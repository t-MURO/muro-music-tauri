import { ListMinus } from "lucide-react";
import { t } from "../../i18n";

type PlaylistSelectionBarProps = {
  playlistName: string;
  selectedCount: number;
  onRemove: () => void;
};

export const PlaylistSelectionBar = ({
  playlistName,
  selectedCount,
  onRemove,
}: PlaylistSelectionBarProps) => (
  <div className="px-[var(--spacing-lg)] pb-[var(--spacing-md)]">
    <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius-lg)] bg-[var(--color-bg-primary)] px-5 py-4 text-[var(--font-size-sm)]">
      <div className="min-w-0 truncate text-[var(--font-size-xs)] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
        {playlistName}
      </div>
      <div className="flex items-center gap-2 rounded-full bg-[var(--color-bg-tertiary)] px-3 py-1.5 text-[var(--font-size-xs)]">
        <span className="text-[var(--color-text-secondary)]">{t("playlist.remove.selected")}</span>
        <span className="font-bold text-[var(--color-accent)]">{selectedCount}</span>
      </div>
      <button
        className="ml-auto flex h-[var(--button-height)] items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-[var(--spacing-md)] text-[var(--font-size-sm)] font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-hover)] disabled:pointer-events-none disabled:opacity-40"
        data-remove-from-playlist
        disabled={selectedCount === 0}
        onClick={onRemove}
        type="button"
      >
        <ListMinus className="h-4 w-4" />
        {t("playlist.remove.action")}
      </button>
    </div>
  </div>
);
