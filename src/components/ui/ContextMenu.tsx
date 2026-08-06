import {
  AudioWaveform,
  ChevronLeft,
  DatabaseZap,
  FolderOpen,
  Fingerprint,
  ListChecks,
  ListMusic,
  ListMinus,
  ListPlus,
  Pencil,
  Play,
  SkipForward,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { t } from "../../i18n";
import { Popover, PopoverDivider, PopoverHeader, PopoverItem } from "./Popover";

type ContextMenuProps = {
  isOpen: boolean;
  position: { x: number; y: number };
  selectionCount: number;
  onPlay?: () => void;
  onPlayNext?: () => void;
  onAddToQueue?: () => void;
  playlistOptions?: Array<{
    id: string;
    name: string;
    trackCount: number;
    folderName?: string;
  }>;
  onAddToPlaylist?: (playlistId: string) => void;
  onShowInFinder?: () => void;
  onRemoveFromPlaylist?: () => void;
  onShowBpmKey?: () => void;
  onSearchMetadata?: () => void;
  onSearchAlbumMetadata?: () => void;
  onIdentifyWithAcoustId?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onClose: () => void;
};

export const ContextMenu = ({
  isOpen,
  position,
  selectionCount,
  onPlay,
  onPlayNext,
  onAddToQueue,
  playlistOptions = [],
  onAddToPlaylist,
  onShowInFinder,
  onRemoveFromPlaylist,
  onShowBpmKey,
  onSearchMetadata,
  onSearchAlbumMetadata,
  onIdentifyWithAcoustId,
  onEdit,
  onDelete,
  onClose,
}: ContextMenuProps) => {
  const [showPlaylistChoices, setShowPlaylistChoices] = useState(false);

  useEffect(() => {
    if (!isOpen) setShowPlaylistChoices(false);
  }, [isOpen]);

  return (
    <Popover isOpen={isOpen} position={position} className="w-60 py-1" onClose={onClose}>
      {showPlaylistChoices ? (
        <>
          <PopoverHeader>Add {selectionCount > 1 ? `${selectionCount} tracks` : "track"} to playlist</PopoverHeader>
          <div className="max-h-64 overflow-y-auto py-1" data-playlist-choices>
            {playlistOptions.length > 0 ? playlistOptions.map((playlist) => (
              <button
                key={playlist.id}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[var(--color-text-primary)] transition-colors duration-100 hover:bg-[var(--color-bg-hover)]"
                onClick={() => onAddToPlaylist?.(playlist.id)}
                data-playlist-choice={playlist.id}
                type="button"
              >
                <ListMusic className="h-4 w-4 shrink-0 opacity-60" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">{playlist.name}</span>
                  {playlist.folderName && (
                    <span className="block truncate text-[10px] text-[var(--color-text-muted)]">{playlist.folderName}</span>
                  )}
                </span>
                <span className="shrink-0 text-[10px] tabular-nums text-[var(--color-text-muted)]">{playlist.trackCount}</span>
              </button>
            )) : (
              <p className="px-3 py-4 text-center text-xs text-[var(--color-text-muted)]">Create a playlist first</p>
            )}
          </div>
          <PopoverDivider />
          <PopoverItem onClick={() => setShowPlaylistChoices(false)}>
            <ChevronLeft className="h-4 w-4 opacity-60" />
            Back
          </PopoverItem>
        </>
      ) : (
        <>
          {selectionCount > 1 && (
            <PopoverHeader>{selectionCount} selected</PopoverHeader>
          )}
          <PopoverItem onClick={onPlay}>
            <Play className="h-4 w-4 opacity-60" />
            {t("menu.play")}
          </PopoverItem>
          <PopoverItem onClick={onPlayNext}>
            <SkipForward className="h-4 w-4 opacity-60" />
            {t("menu.playNext")}
          </PopoverItem>
          <PopoverItem onClick={onAddToQueue}>
            <ListChecks className="h-4 w-4 opacity-60" />
            {t("menu.addQueue")}
          </PopoverItem>
          <PopoverItem onClick={() => setShowPlaylistChoices(true)} dataTestId="add-to-playlist-menu-item">
            <ListPlus className="h-4 w-4 opacity-60" />
            {t("menu.addPlaylist")}
          </PopoverItem>
          {onShowInFinder && (
            <PopoverItem onClick={onShowInFinder} dataTestId="show-in-finder-menu-item">
              <FolderOpen className="h-4 w-4 opacity-60" />
              {window.muro?.platform === "darwin" ? "Show in Finder" : "Show in folder"}
            </PopoverItem>
          )}
          {onRemoveFromPlaylist && (
            <PopoverItem onClick={onRemoveFromPlaylist}>
              <ListMinus className="h-4 w-4 opacity-60" />
              {t("menu.removePlaylist")}
            </PopoverItem>
          )}
          <PopoverDivider />
          <PopoverItem onClick={onShowBpmKey}>
            <AudioWaveform className="h-4 w-4 opacity-60" />
            {t("menu.showBpmKey")}
          </PopoverItem>
          {onSearchMetadata && (
            <PopoverItem onClick={onSearchMetadata} dataTestId="search-metadata-menu-item">
              <DatabaseZap className="h-4 w-4 opacity-60" />
              {t("metadataSearch.menu")}
            </PopoverItem>
          )}
          {onSearchAlbumMetadata && (
            <PopoverItem onClick={onSearchAlbumMetadata} dataTestId="search-album-metadata-menu-item">
              <DatabaseZap className="h-4 w-4 opacity-60" />
              Search for album metadata
            </PopoverItem>
          )}
          {onIdentifyWithAcoustId && (
            <PopoverItem onClick={onIdentifyWithAcoustId} dataTestId="identify-acoustid-menu-item">
              <Fingerprint className="h-4 w-4 opacity-60" />
              Identify with AcoustID
            </PopoverItem>
          )}
          <PopoverItem onClick={onEdit}>
            <Pencil className="h-4 w-4 opacity-60" />
            {t("menu.edit")}
          </PopoverItem>
          <PopoverItem variant="danger" onClick={onDelete} dataTestId="delete-track-menu-item">
            <Trash2 className="h-4 w-4 opacity-70" />
            {t("menu.delete")}
          </PopoverItem>
        </>
      )}
    </Popover>
  );
};
