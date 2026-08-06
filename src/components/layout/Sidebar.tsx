import {
  Badge,
  CalendarPlus,
  ChevronDown,
  ChevronRight,
  Clock3,
  Disc3,
  Download,
  Folder,
  FolderInput,
  FolderPlus,
  GripVertical,
  Import,
  Inbox,
  ListMusic,
  Music2,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
  Tag,
  Trash2,
  TriangleAlert,
  UserRound,
  KeyRound,
  MoreHorizontal,
  ChartNoAxesColumnIncreasing,
} from "lucide-react";
import { useMemo, useState } from "react";
import { t } from "../../i18n";
import { useStickyState } from "../../hooks/useStickyState";
import { useLibraryStore, useSmartCrateStore } from "../../stores";
import { filterTracksBySmartCrate } from "../../utils";
import type { CollectionFacet, LibraryView } from "../../hooks";
import { Popover, PopoverItem } from "../ui/Popover";

type SidebarProps = {
  collapsed: boolean;
  currentView: LibraryView;
  draggingPlaylistId: string | null;
  onToggleCollapsed: () => void;
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

const parseCollapsedPlaylistFolders = (raw: string) => {
  const parsed: unknown = JSON.parse(raw);
  return new Set(
    Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [],
  );
};

const serializeCollapsedPlaylistFolders = (folderIds: Set<string>) =>
  JSON.stringify([...folderIds]);

export const Sidebar = ({
  collapsed,
  currentView,
  draggingPlaylistId,
  onToggleCollapsed,
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
}: SidebarProps) => {
  const tracks = useLibraryStore((state) => state.tracks);
  const inboxTracks = useLibraryStore((state) => state.inboxTracks);
  const playlists = useLibraryStore((state) => state.playlists);
  const playlistFolders = useLibraryStore((state) => state.playlistFolders);
  const [collapsedFolderIds, setCollapsedFolderIds] = useStickyState(
    "muro-collapsed-playlist-folders",
    new Set<string>(),
    {
      parse: parseCollapsedPlaylistFolders,
      serialize: serializeCollapsedPlaylistFolders,
    },
  );
  const [playlistSelectionAnchorId, setPlaylistSelectionAnchorId] = useState<string | null>(null);
  const [reorderingPlaylistId, setReorderingPlaylistId] = useState<string | null>(null);
  const [reorderTarget, setReorderTarget] = useState<{
    id: string;
    placement: "before" | "after";
  } | null>(null);
  const [playlistActionsPosition, setPlaylistActionsPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const smartCrates = useSmartCrateStore((state) => state.smartCrates);
  const smartCrateCounts = useMemo(
    () => new Map(smartCrates.map((crate) => [crate.id, filterTracksBySmartCrate(tracks, crate).length])),
    [smartCrates, tracks],
  );

  const navigation = [
    { view: "library" as const, label: t("nav.library"), icon: Music2, count: tracks.length },
    { view: "inbox" as const, label: t("nav.inbox"), icon: Inbox, count: inboxTracks.length },
    { view: "recentlyPlayed" as const, label: t("nav.recentlyPlayed"), icon: Clock3 },
    { view: "recentlyAdded" as const, label: t("nav.recentlyAdded"), icon: CalendarPlus },
    { view: "statistics" as const, label: t("nav.statistics"), icon: ChartNoAxesColumnIncreasing },
  ];
  const collections: { facet: CollectionFacet; label: string; icon: typeof Tag }[] = [
    { facet: "genres", label: t("collection.genres"), icon: Tag },
    { facet: "artists", label: t("collection.artists"), icon: UserRound },
    { facet: "albums", label: t("collection.albums"), icon: Disc3 },
    { facet: "labels", label: t("collection.labels"), icon: Badge },
    { facet: "keys", label: t("collection.keys"), icon: KeyRound },
  ];

  const itemClass = (active: boolean) =>
    `sidebar-item ${active ? "sidebar-item--active" : ""} ${collapsed ? "justify-center px-0" : ""}`;

  const folderIds = useMemo(
    () => new Set(playlistFolders.map((folder) => folder.id)),
    [playlistFolders],
  );
  const orderedPlaylists = useMemo(
    () => [...playlists].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
    [playlists],
  );
  const orderedFolders = useMemo(
    () => [...playlistFolders].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
    [playlistFolders],
  );
  const rootPlaylists = orderedPlaylists.filter(
    (playlist) => !playlist.folderId || !folderIds.has(playlist.folderId),
  );
  const childFoldersByParent = useMemo(() => {
    const children = new Map<string, typeof playlistFolders>();
    for (const folder of orderedFolders) {
      const parentId = folder.parentId && folderIds.has(folder.parentId) ? folder.parentId : "";
      const current = children.get(parentId) ?? [];
      current.push(folder);
      children.set(parentId, current);
    }
    return children;
  }, [folderIds, orderedFolders, playlistFolders]);
  const playlistsByFolder = useMemo(() => {
    const grouped = new Map<string, typeof playlists>();
    for (const playlist of orderedPlaylists) {
      if (!playlist.folderId || !folderIds.has(playlist.folderId)) continue;
      const current = grouped.get(playlist.folderId) ?? [];
      current.push(playlist);
      grouped.set(playlist.folderId, current);
    }
    return grouped;
  }, [folderIds, orderedPlaylists, playlists]);
  const orderedPlaylistIds = useMemo(() => {
    const ids = rootPlaylists.map((playlist) => playlist.id);
    const visited = new Set<string>();
    const collectFolder = (folderId: string) => {
      if (visited.has(folderId)) return;
      visited.add(folderId);
      if (collapsedFolderIds.has(folderId)) return;
      ids.push(...(playlistsByFolder.get(folderId) ?? []).map((playlist) => playlist.id));
      for (const folder of childFoldersByParent.get(folderId) ?? []) collectFolder(folder.id);
    };
    for (const folder of childFoldersByParent.get("") ?? []) collectFolder(folder.id);
    return ids;
  }, [childFoldersByParent, collapsedFolderIds, playlistsByFolder, rootPlaylists]);
  const toggleFolder = (folderId: string) => {
    setCollapsedFolderIds((current) => {
      const next = new Set(current);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  };
  const selectPlaylist = (event: React.MouseEvent<HTMLButtonElement>, playlistId: string) => {
    let nextSelection: string[];
    if (event.shiftKey && playlistSelectionAnchorId) {
      const anchorIndex = orderedPlaylistIds.indexOf(playlistSelectionAnchorId);
      const targetIndex = orderedPlaylistIds.indexOf(playlistId);
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const range = orderedPlaylistIds.slice(
          Math.min(anchorIndex, targetIndex),
          Math.max(anchorIndex, targetIndex) + 1,
        );
        nextSelection = event.metaKey || event.ctrlKey
          ? [...new Set([...selectedPlaylistIds, ...range])]
          : range;
      } else {
        nextSelection = [playlistId];
      }
    } else if (event.metaKey || event.ctrlKey) {
      const next = new Set(selectedPlaylistIds);
      if (next.has(playlistId)) next.delete(playlistId);
      else next.add(playlistId);
      nextSelection = [...next];
      setPlaylistSelectionAnchorId(playlistId);
    } else {
      nextSelection = [playlistId];
      setPlaylistSelectionAnchorId(playlistId);
    }
    onPlaylistSelectionChange(nextSelection);
    onViewChange(`playlist:${playlistId}`);
  };
  const openPlaylistContextMenu = (
    event: React.MouseEvent<HTMLButtonElement>,
    playlistId: string,
  ) => {
    if (!selectedPlaylistIds.has(playlistId)) {
      onPlaylistSelectionChange([playlistId]);
      setPlaylistSelectionAnchorId(playlistId);
    }
    onPlaylistContextMenu(event, playlistId);
  };
  const renderPlaylist = (playlist: (typeof playlists)[number], depth = 0) => {
    const active = currentView === `playlist:${playlist.id}`;
    const selected = selectedPlaylistIds.has(playlist.id);
    const dropTarget = draggingPlaylistId === playlist.id;
    const reorderPosition = reorderTarget?.id === playlist.id ? reorderTarget.placement : null;
    return (
      <button
        key={playlist.id}
        className={`${itemClass(active)} ${selected ? "sidebar-item--selected" : ""} ${dropTarget ? "sidebar-item--drop" : ""} ${reorderPosition ? `sidebar-item--reorder-${reorderPosition}` : ""}`}
        style={{ paddingLeft: `${9 + depth * 16}px` }}
        onClick={(event) => selectPlaylist(event, playlist.id)}
        onContextMenu={(event) => openPlaylistContextMenu(event, playlist.id)}
        draggable
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("application/x-muro-playlist-id", playlist.id);
          setReorderingPlaylistId(playlist.id);
        }}
        onDragEnd={() => {
          setReorderingPlaylistId(null);
          setReorderTarget(null);
        }}
        onDragEnter={(event) => {
          event.preventDefault();
          if (reorderingPlaylistId) return;
          onPlaylistDragEnter(playlist.id);
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          if (reorderingPlaylistId) {
            if (reorderTarget?.id === playlist.id) setReorderTarget(null);
            return;
          }
          onPlaylistDragLeave(playlist.id);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          if (reorderingPlaylistId) {
            const bounds = event.currentTarget.getBoundingClientRect();
            const placement = event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
            setReorderTarget({ id: playlist.id, placement });
            event.dataTransfer.dropEffect = "move";
            return;
          }
          onPlaylistDragOver(playlist.id);
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const sourceId = reorderingPlaylistId
            ?? event.dataTransfer.getData("application/x-muro-playlist-id");
          if (sourceId) {
            const placement = reorderTarget?.id === playlist.id
              ? reorderTarget.placement
              : "before";
            onPlaylistReorder(sourceId, playlist.id, placement);
            setReorderingPlaylistId(null);
            setReorderTarget(null);
            return;
          }
          onPlaylistDrop(event, playlist.id);
        }}
        data-playlist-id={playlist.id}
        data-playlist-target={playlist.id}
        data-playlist-folder-parent={playlist.folderId}
        aria-selected={selected}
        type="button"
      >
        <GripVertical className="sidebar-playlist-grip h-3 w-3 shrink-0" />
        <ListMusic className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{playlist.name}</span>
        {playlist.sourcePath && (
          <span
            className={playlist.sourceSyncError
              ? "shrink-0 text-[var(--color-danger)]"
              : "shrink-0 text-[var(--color-text-muted)]"}
            data-playlist-source-linked={playlist.id}
            title={playlist.sourceSyncError
              ? `Could not fully sync ${playlist.sourcePath}: ${playlist.sourceSyncError}`
              : `Automatically synced from ${playlist.sourcePath}`}
          >
            {playlist.sourceSyncError
              ? <TriangleAlert className="h-3 w-3" aria-hidden="true" />
              : <RefreshCw className="h-3 w-3" aria-hidden="true" />}
          </span>
        )}
        <span className="sidebar-count">{playlist.trackIds.length}</span>
      </button>
    );
  };
  const countFolderPlaylists = (folderId: string, visited = new Set<string>()): number => {
    if (visited.has(folderId)) return 0;
    visited.add(folderId);
    return (playlistsByFolder.get(folderId)?.length ?? 0)
      + (childFoldersByParent.get(folderId) ?? [])
        .reduce((total, child) => total + countFolderPlaylists(child.id, visited), 0);
  };
  const renderFolder = (folder: (typeof playlistFolders)[number], depth = 0) => {
    const folderPlaylists = playlistsByFolder.get(folder.id) ?? [];
    const childFolders = childFoldersByParent.get(folder.id) ?? [];
    const isCollapsed = collapsedFolderIds.has(folder.id);
    return (
      <div key={folder.id} data-playlist-folder={folder.id}>
        <button
          className="sidebar-item"
          style={{ paddingLeft: `${9 + depth * 16}px` }}
          onClick={() => toggleFolder(folder.id)}
          onContextMenu={(event) => onPlaylistFolderContextMenu(event, folder.id)}
          aria-expanded={!isCollapsed}
          type="button"
        >
          {isCollapsed ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
          <Folder className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{folder.name}</span>
          <span className="sidebar-count">{countFolderPlaylists(folder.id)}</span>
        </button>
        {!isCollapsed && (
          <>
            {folderPlaylists.map((playlist) => renderPlaylist(playlist, depth + 1))}
            {childFolders.map((child) => renderFolder(child, depth + 1))}
          </>
        )}
      </div>
    );
  };

  return (
    <aside className="sidebar-shell flex h-full flex-col overflow-hidden border-r border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
      <div className={`sidebar-titlebar flex h-[68px] shrink-0 items-center border-b border-[var(--color-border)] ${collapsed ? "justify-center px-2" : "justify-end px-3"}`}>
        <button
          className="toolbar-icon-button sidebar-collapse-button shrink-0"
          onClick={onToggleCollapsed}
          title={collapsed ? "Expand navigation" : "Collapse navigation"}
          aria-label={collapsed ? t("nav.aria.expand") : t("nav.aria.collapse")}
          type="button"
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </button>
      </div>

      <nav className={`shrink-0 ${collapsed ? "px-2 py-3" : "px-3 py-4"}`} aria-label={t("nav.aria.library")}>
        {!collapsed && <div className="sidebar-section-label">{t("nav.library.section")}</div>}
        <div className="space-y-1">
          {navigation.map(({ view, label, icon: Icon, count }) => {
            const active = currentView === view;
            return (
              <button
                key={view}
                className={itemClass(active)}
                onClick={() => onViewChange(view)}
                title={collapsed ? label : undefined}
                aria-label={label}
                aria-current={active ? "page" : undefined}
                data-library-view={view}
                type="button"
              >
                <Icon className="h-4 w-4 shrink-0" />
                {!collapsed && <><span className="min-w-0 flex-1 truncate">{label}</span>{count !== undefined && <span className="sidebar-count">{count.toLocaleString()}</span>}</>}
              </button>
            );
          })}
        </div>
      </nav>

      {!collapsed && (
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-[var(--color-border-light)] px-3 py-4">
          <div data-sidebar-section="collection">
            <div className="sidebar-section-label">{t("nav.collection.section")}</div>
            <div className="space-y-1">
              {collections.map(({ facet, label, icon: Icon }) => {
                const collectionView = `collection:${facet}` as LibraryView;
                return (
                  <button
                    key={facet}
                    className={itemClass(currentView === collectionView)}
                    onClick={() => onViewChange(collectionView)}
                    data-collection-facet={facet}
                    type="button"
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{label}</span>
                  </button>
                );
              })}
            </div>

            <div className="mt-4 border-t border-[var(--color-border-light)] pt-4" data-sidebar-section="playlists">
              <div className="sidebar-section-label">
                <ListMusic className="h-3.5 w-3.5" />
                <span className="flex-1">Playlists</span>
                <button
                  className="toolbar-icon-button h-6 w-6"
                  onClick={onCreatePlaylist}
                  title="Add playlist"
                  aria-label={t("nav.aria.addPlaylist")}
                  data-playlist-create
                  type="button"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
                <button
                  className="toolbar-icon-button h-6 w-6"
                  onClick={(event) => {
                    if (playlistActionsPosition) {
                      setPlaylistActionsPosition(null);
                      return;
                    }
                    const rect = event.currentTarget.getBoundingClientRect();
                    setPlaylistActionsPosition({ x: rect.right, y: rect.bottom + 4 });
                  }}
                  title="More playlist actions"
                  aria-label={t("nav.aria.morePlaylistActions")}
                  aria-expanded={Boolean(playlistActionsPosition)}
                  aria-haspopup="menu"
                  data-playlist-actions-menu
                  type="button"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
              </div>
              <Popover
                isOpen={Boolean(playlistActionsPosition)}
                position={playlistActionsPosition ?? { x: 0, y: 0 }}
                className="w-64 py-1"
                onClose={() => setPlaylistActionsPosition(null)}
              >
                <div role="menu" aria-label={t("nav.aria.playlistActions")}>
                  <PopoverItem
                    onClick={() => {
                      setPlaylistActionsPosition(null);
                      onImportPlaylist();
                    }}
                    data-playlist-import
                    role="menuitem"
                  >
                    <Import className="h-4 w-4 opacity-60" />
                    Import playlist file
                  </PopoverItem>
                  <PopoverItem
                    onClick={() => {
                      setPlaylistActionsPosition(null);
                      onImportPlaylistFolder();
                    }}
                    data-playlist-folder-import
                    role="menuitem"
                  >
                    <FolderInput className="h-4 w-4 opacity-60" />
                    Import playlist folder
                  </PopoverItem>
                  <PopoverItem
                    disabled={playlists.length === 0}
                    onClick={() => {
                      setPlaylistActionsPosition(null);
                      onExportAllPlaylists();
                    }}
                    data-playlist-export-all
                    role="menuitem"
                  >
                    <Download className="h-4 w-4 opacity-60" />
                    Export all playlists
                  </PopoverItem>
                  <PopoverItem
                    onClick={() => {
                      setPlaylistActionsPosition(null);
                      onCreatePlaylistFolder();
                    }}
                    data-playlist-folder-create
                    role="menuitem"
                  >
                    <FolderPlus className="h-4 w-4 opacity-60" />
                    New playlist folder
                  </PopoverItem>
                </div>
              </Popover>
              <div className="space-y-1">
                {rootPlaylists.map((playlist) => renderPlaylist(playlist))}
                {(childFoldersByParent.get("") ?? []).map((folder) => renderFolder(folder))}
              </div>
            </div>
          </div>
          <div className="mt-4 border-t border-[var(--color-border-light)] pt-4" data-sidebar-section="smart-crates">
            <div className="sidebar-section-label">
              <Sparkles className="h-3.5 w-3.5" />
              <span className="flex-1">Smart Crates</span>
              <button
                className="toolbar-icon-button h-6 w-6"
                onClick={onCreateSmartCrate}
                title="New Smart Crate"
                aria-label={t("nav.aria.newSmartCrate")}
                data-smart-crate-create
                type="button"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
            {smartCrates.length > 0 ? (
              <div className="space-y-1">
                {smartCrates.map((crate) => {
                  const crateView = `smartCrate:${crate.id}` as LibraryView;
                  const active = currentView === crateView;
                  return (
                    <div className="smart-crate-sidebar-row group flex min-w-0 items-center gap-1" key={crate.id}>
                      <button
                        className={`${itemClass(active)} min-w-0 flex-1`}
                        onClick={() => onViewChange(crateView)}
                        aria-current={active ? "page" : undefined}
                        data-smart-crate-id={crate.id}
                        type="button"
                      >
                        <Sparkles className="h-3.5 w-3.5 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{crate.name}</span>
                        <span className="sidebar-count">{(smartCrateCounts.get(crate.id) ?? 0).toLocaleString()}</span>
                      </button>
                      <div className="smart-crate-sidebar-actions flex shrink-0 items-center">
                        <button className="toolbar-icon-button h-7 w-7" onClick={() => onEditSmartCrate(crate.id)} title={t("nav.aria.editNamed", { name: crate.name })} aria-label={t("nav.aria.editNamed", { name: crate.name })} data-smart-crate-edit={crate.id} type="button"><Pencil className="h-3 w-3" /></button>
                        <button className="toolbar-icon-button h-7 w-7" onClick={() => onDeleteSmartCrate(crate.id)} title={t("nav.aria.deleteNamed", { name: crate.name })} aria-label={t("nav.aria.deleteNamed", { name: crate.name })} data-smart-crate-delete={crate.id} type="button"><Trash2 className="h-3 w-3" /></button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <button
                className="mx-2 mt-1 text-left text-[10px] leading-relaxed text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-secondary)]"
                onClick={onCreateSmartCrate}
                type="button"
              >
                Build a live playlist from BPM, key, genre, rating, and more.
              </button>
            )}
          </div>
        </div>
      )}

      <div className={`mt-auto border-t border-[var(--color-border)] ${collapsed ? "p-2" : "p-3"}`}>
        <button
          className={itemClass(currentView === "settings")}
          onClick={() => onViewChange("settings")}
          title={collapsed ? t("nav.settings") : undefined}
          aria-label={t("nav.settings")}
          type="button"
        >
          <Settings className="h-4 w-4 shrink-0" />
          {!collapsed && <span>{t("nav.settings")}</span>}
        </button>
      </div>
    </aside>
  );
};
