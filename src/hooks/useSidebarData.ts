import { useMemo } from "react";
import type { LibraryView } from "./useLibraryView";

type UseSidebarDataArgs = {
  view: LibraryView;
  draggingPlaylistId: string | null;
  onViewChange: (view: LibraryView) => void;
  onPlaylistDrop: (event: React.DragEvent<HTMLButtonElement>, id: string) => void;
  onPlaylistDragEnter: (id: string) => void;
  onPlaylistDragLeave: (id: string) => void;
  onPlaylistDragOver: (id: string) => void;
  onCreatePlaylist: () => void;
  onCreatePlaylistFolder: () => void;
  onImportPlaylist: () => void;
  onImportPlaylistFolder: () => void;
  onExportAllPlaylists: () => void;
  selectedPlaylistIds: ReadonlySet<string>;
  onPlaylistSelectionChange: (ids: string[]) => void;
  onPlaylistReorder: (
    sourceId: string,
    targetId: string,
    placement: "before" | "after",
  ) => void;
  onPlaylistContextMenu: (event: React.MouseEvent<HTMLButtonElement>, id: string) => void;
  onPlaylistFolderContextMenu: (event: React.MouseEvent<HTMLButtonElement>, id: string) => void;
  onCreateSmartCrate: () => void;
  onEditSmartCrate: (id: string) => void;
  onDeleteSmartCrate: (id: string) => void;
};

export const useSidebarData = ({
  view,
  draggingPlaylistId,
  onViewChange,
  onPlaylistDrop,
  onPlaylistDragEnter,
  onPlaylistDragLeave,
  onPlaylistDragOver,
  onCreatePlaylist,
  onCreatePlaylistFolder,
  onImportPlaylist,
  onImportPlaylistFolder,
  onExportAllPlaylists,
  selectedPlaylistIds,
  onPlaylistSelectionChange,
  onPlaylistReorder,
  onPlaylistContextMenu,
  onPlaylistFolderContextMenu,
  onCreateSmartCrate,
  onEditSmartCrate,
  onDeleteSmartCrate,
}: UseSidebarDataArgs) => {
  return useMemo(
    () => ({
      currentView: view,
      draggingPlaylistId,
      onViewChange,
      onPlaylistDrop,
      onPlaylistDragEnter,
      onPlaylistDragLeave,
      onPlaylistDragOver,
      onCreatePlaylist,
      onCreatePlaylistFolder,
      onImportPlaylist,
      onImportPlaylistFolder,
      onExportAllPlaylists,
      selectedPlaylistIds,
      onPlaylistSelectionChange,
      onPlaylistReorder,
      onPlaylistContextMenu,
      onPlaylistFolderContextMenu,
      onCreateSmartCrate,
      onEditSmartCrate,
      onDeleteSmartCrate,
    }),
    [
      draggingPlaylistId,
      onPlaylistContextMenu,
      onPlaylistFolderContextMenu,
      onPlaylistDragEnter,
      onPlaylistDragLeave,
      onPlaylistDragOver,
      onPlaylistDrop,
      onCreatePlaylist,
      onCreatePlaylistFolder,
      onImportPlaylist,
      onImportPlaylistFolder,
      onExportAllPlaylists,
      selectedPlaylistIds,
      onPlaylistSelectionChange,
      onPlaylistReorder,
      onCreateSmartCrate,
      onDeleteSmartCrate,
      onEditSmartCrate,
      onViewChange,
      view,
    ]
  );
};
