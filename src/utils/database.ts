import { invoke } from "@muro/desktop/runtime";
import type { LibrarySnapshot, PlaylistSnapshot } from "./importApi";
import type {
  AlbumCoverCandidate,
  ArtistImageCandidate,
  ArtistProfile,
} from "../types";
import type { ArtistCreditInput } from "./artistCredits";

// ============================================================================
// Library Operations
// ============================================================================

export const loadTracks = (
  dbPath: string,
  libraryRoot?: string,
  artistSeparatorExceptions?: string[],
) => {
  return invoke<LibrarySnapshot>("load_tracks", {
    dbPath,
    libraryRoot,
    artistSeparatorExceptions,
  });
};

export const clearTracks = (dbPath: string) => {
  return invoke<void>("clear_tracks", { dbPath });
};

export type AcceptTracksResult = {
  accepted: number;
  acceptedTrackIds: string[];
  moved: Array<{ trackId: string; sourcePath: string; filename: string }>;
  failures: Array<{ trackId: string; sourcePath: string; message: string }>;
};

export const acceptTracks = (
  dbPath: string,
  trackIds: string[],
  options?: { organize?: boolean; libraryFolder?: string },
) => {
  return invoke<AcceptTracksResult>("accept_tracks", {
    dbPath,
    trackIds,
    organize: options?.organize ?? false,
    libraryFolder: options?.libraryFolder ?? "",
  });
};

export type LibraryStructureIssue = {
  trackId: string;
  title: string;
  artist: string;
  albumArtist: string;
  album: string;
  filename: string;
  currentPath: string;
  currentFolder: string;
  expectedFolder: string;
};

export type LibraryStructureValidationResult = {
  checked: number;
  unavailable: number;
  outsideRoot: number;
  misplaced: LibraryStructureIssue[];
};

export type LibraryStructureRepairResult = {
  requested: number;
  moved: Array<{ trackId: string; sourcePath: string; filename: string }>;
  skipped: number;
  failures: Array<{ trackId: string; sourcePath: string; message: string }>;
};

export const validateLibraryStructure = (
  dbPath: string,
  libraryRoot: string,
) => invoke<LibraryStructureValidationResult>("validate_library_structure", {
  dbPath,
  libraryRoot,
});

export const repairLibraryStructure = (
  dbPath: string,
  libraryRoot: string,
  trackIds: string[],
) => invoke<LibraryStructureRepairResult>("repair_library_structure", {
  dbPath,
  libraryRoot,
  trackIds,
});

export const unacceptTracks = (dbPath: string, trackIds: string[]) => {
  return invoke<void>("unaccept_tracks", { dbPath, trackIds });
};

export const rejectTracks = (dbPath: string, trackIds: string[]) => {
  return invoke<void>("reject_tracks", { dbPath, trackIds });
};

export type DeleteTracksResult = {
  deletedTrackIds: string[];
  failures: Array<{ trackId: string; path: string; message: string }>;
};

export const deleteTracks = (
  dbPath: string,
  trackIds: string[],
  deleteFromDisk: boolean
) => {
  return invoke<DeleteTracksResult>("delete_tracks", {
    dbPath,
    trackIds,
    deleteFromDisk,
  });
};

export const updateTrackBeatGrid = (dbPath: string, trackId: string, beatGridJson: string) =>
  invoke<{ updated: boolean }>("update_track_beat_grid", { dbPath, trackId, beatGridJson });

export const loadCachedArtistProfiles = (dbPath: string) =>
  invoke<ArtistProfile[]>("load_cached_artist_profiles", { dbPath });

export type ArtistProfileIdentity = {
  artistId?: string;
  musicBrainzId?: string;
};

export const getArtistProfile = (
  dbPath: string,
  artistName: string,
  force = false,
  providerKeys: ArtistProfileProviderKeys = {},
  identity: ArtistProfileIdentity = {},
) => invoke<ArtistProfile>("get_artist_profile", {
  dbPath,
  artistName,
  ...identity,
  force,
  ...providerKeys,
});

export const searchArtistImages = (
  dbPath: string,
  artistName: string,
  providerKeys: ArtistProfileProviderKeys = {},
  identity: ArtistProfileIdentity = {},
) => invoke<ArtistImageCandidate[]>("search_artist_images", {
  dbPath,
  artistName,
  ...identity,
  ...providerKeys,
});

export const setArtistImage = (
  dbPath: string,
  artistName: string,
  candidate: ArtistImageCandidate,
  identity: ArtistProfileIdentity = {},
) => invoke<ArtistProfile>("set_artist_image", {
  dbPath,
  artistName,
  candidate,
  ...identity,
});

export type ArtistProfileProviderKeys = {
  braveSearchApiKey?: string;
  fanartApiKey?: string;
  lastFmApiKey?: string;
  theAudioDbApiKey?: string;
};

export type ArtistProfileScanResult = {
  checked: number;
  updated: number;
  failed: number;
  queued: number;
  remaining: number;
  totalArtists: number;
};

export const scanArtistProfiles = (
  dbPath: string,
  providerKeys: ArtistProfileProviderKeys = {},
  limit = 25,
) => invoke<ArtistProfileScanResult>("scan_artist_profiles", { dbPath, ...providerKeys, limit });

export type FetchedCoverArt = {
  fullPath: string;
  thumbPath: string;
  sourceUrl?: string | null;
  provider?: "cover-art-archive" | "deezer" | "brave-search" | null;
};

export const fetchTrackCoverArt = (
  dbPath: string,
  trackId: string,
  metadata: { album?: string; artist?: string } = {},
) => invoke<FetchedCoverArt | null>("fetch_track_cover_art", {
  dbPath,
  trackId,
  ...metadata,
});

export const searchAlbumCoverImages = (
  metadata: { album: string; artist: string },
  braveSearchApiKey: string,
) => invoke<AlbumCoverCandidate[]>("search_album_cover_images", {
  ...metadata,
  braveSearchApiKey,
});

export const cacheAlbumCoverCandidate = (
  candidate: AlbumCoverCandidate,
) => invoke<FetchedCoverArt>("cache_album_cover_candidate", { candidate });

export type MetadataSearchCandidate = {
  id: string;
  score: number;
  recordingId: string | null;
  releaseId: string | null;
  releaseGroupId: string | null;
  title: string;
  artist: string;
  artistCredits?: ArtistCreditInput[];
  album: string;
  albumArtist: string;
  albumArtistCredits?: ArtistCreditInput[];
  year: number | null;
  country: string | null;
  status: string | null;
  genre: string | null;
  albumMatch: boolean;
};

export const searchTrackMetadata = (
  metadata: { title: string; artist: string; album?: string },
) => invoke<MetadataSearchCandidate[]>("search_track_metadata", metadata);

export type AcoustIdCandidate = MetadataSearchCandidate & {
  acoustidId: string;
};

export type AcoustIdIdentificationResult = {
  trackId: string;
  cached: boolean;
  duration: number;
  candidates: AcoustIdCandidate[];
};

export const identifyTrackWithAcoustId = (
  dbPath: string,
  trackId: string,
  clientKey: string,
  force = false,
) => invoke<AcoustIdIdentificationResult>("identify_track_acoustid", {
  dbPath,
  trackId,
  clientKey,
  force,
});

export type AlbumMetadataCandidate = {
  id: string;
  score: number;
  title: string;
  artist: string;
  artistCredits?: ArtistCreditInput[];
  releaseGroupId: string | null;
  year: number | null;
  country: string | null;
  status: string | null;
  barcode: string | null;
  trackCount: number;
  disambiguation: string | null;
};

export type AlbumMetadataTrack = {
  id: string;
  recordingId: string | null;
  title: string;
  artist: string;
  artistCredits?: ArtistCreditInput[];
  trackNumber: number;
  trackTotal: number;
  discNumber: number;
  discTotal: number;
};

export type AlbumMetadataRelease = {
  id: string;
  title: string;
  artist: string;
  artistCredits?: ArtistCreditInput[];
  albumArtistCredits?: ArtistCreditInput[];
  releaseGroupId: string | null;
  year: number | null;
  country: string | null;
  status: string | null;
  label: string | null;
  genre: string | null;
  discTotal: number | null;
  tracks: AlbumMetadataTrack[];
};

export const searchAlbumMetadata = (metadata: { album: string; artist: string }) =>
  invoke<AlbumMetadataCandidate[]>("search_album_metadata", metadata);

export const loadAlbumMetadata = (releaseId: string) =>
  invoke<AlbumMetadataRelease>("load_album_metadata", { releaseId });

export type TechnicalMetadataScanResult = {
  checked: number;
  updated: number;
  failed: number;
  remaining: number;
};

export const scanTechnicalMetadata = (dbPath: string, limit = 25) =>
  invoke<TechnicalMetadataScanResult>("scan_technical_metadata", { dbPath, limit });

// ============================================================================
// Playlist Operations
// ============================================================================

export const loadPlaylists = (dbPath: string, libraryRoot?: string) => {
  return invoke<PlaylistSnapshot>("load_playlists", { dbPath, libraryRoot });
};

export const createPlaylist = (
  dbPath: string,
  id: string,
  name: string,
  folderId?: string,
  sortOrder?: number,
  sourcePath?: string,
) => {
  return invoke<void>("create_playlist", {
    dbPath,
    id,
    name,
    folderId,
    sortOrder,
    sourcePath,
  });
};

export const updatePlaylist = (
  dbPath: string,
  playlistId: string,
  updates: { name?: string; folderId?: string | null; sortOrder?: number },
) => invoke<void>("update_playlist", { dbPath, playlistId, ...updates });

export const reorderPlaylists = (
  dbPath: string,
  items: Array<{ id: string; folderId?: string; sortOrder: number }>,
) => invoke<void>("reorder_playlists", { dbPath, items });

export const deletePlaylist = (dbPath: string, playlistId: string) => {
  return invoke<void>("delete_playlist", {
    dbPath,
    playlistId,
  });
};

export const deletePlaylists = (dbPath: string, playlistIds: string[]) =>
  invoke<{ deleted: number }>("delete_playlists", { dbPath, playlistIds });

export const restorePlaylists = (
  dbPath: string,
  playlists: Array<{
    id: string;
    name: string;
    trackIds: string[];
    folderId?: string;
    sortOrder: number;
    sourcePath?: string;
    sourceMtimeMs?: number;
    sourceSize?: number;
    sourceSyncError?: string;
    lastSyncedAt?: number;
  }>,
) => invoke<{ restored: number }>("restore_playlists", { dbPath, playlists });

export const addTracksToPlaylist = (
  dbPath: string,
  playlistId: string,
  trackIds: string[]
) => {
  return invoke<void>("add_tracks_to_playlist", {
    dbPath,
    playlistId,
    trackIds,
  });
};

export const setPlaylistTracks = (
  dbPath: string,
  playlistId: string,
  trackIds: string[]
) => {
  return invoke<void>("set_playlist_tracks", {
    dbPath,
    playlistId,
    trackIds,
  });
};

export const removeLastTracksFromPlaylist = (
  dbPath: string,
  playlistId: string,
  count: number
) => {
  return invoke<void>("remove_last_tracks_from_playlist", {
    dbPath,
    playlistId,
    count,
  });
};

export const createPlaylistFolder = (
  dbPath: string,
  id: string,
  name: string,
  parentId?: string,
  sortOrder?: number,
) => invoke<void>("create_playlist_folder", { dbPath, id, name, parentId, sortOrder });

export const updatePlaylistFolder = (dbPath: string, folderId: string, name: string) =>
  invoke<void>("update_playlist_folder", { dbPath, folderId, name });

export const deletePlaylistFolder = (dbPath: string, folderId: string) =>
  invoke<void>("delete_playlist_folder", { dbPath, folderId });

export type PlaylistFolderImportScan = {
  name: string;
  audioFileCount: number;
  files: string[];
  entries: Array<{
    path: string;
    relativePath: string;
    folderPath: string | null;
  }>;
  folders: Array<{
    path: string;
    name: string;
    parentPath: string | null;
  }>;
};

export const listPlaylistFiles = (directoryPath: string) =>
  invoke<PlaylistFolderImportScan>("list_playlist_files", { directoryPath });

export const importPlaylistFile = (dbPath: string, filePath: string) =>
  invoke<import("./importApi").ImportedPlaylistFile>("import_playlist_file", {
    dbPath,
    filePath,
  });

export type PlaylistSourceSyncResult = {
  playlistId: string;
  name: string;
  sourcePath: string;
  trackIds: string[];
  imported: import("./importApi").ImportedTrack[];
  added: number;
  removed: number;
  skipped: number;
  changed: boolean;
  sourceSyncError: string | null;
  errorChanged: boolean;
  reason: "startup" | "watch" | "manual";
};

export const configurePlaylistSync = (dbPath: string) =>
  invoke<{ linked: number; synced: number; changed: number }>(
    "configure_playlist_sync",
    { dbPath },
  );

export const syncPlaylistSource = (dbPath: string, playlistId: string) =>
  invoke<PlaylistSourceSyncResult | null>("sync_playlist_source", {
    dbPath,
    playlistId,
  });

export const exportPlaylistFile = (
  dbPath: string,
  playlistId: string,
  filePath: string,
) => invoke<{ exported: number; filePath: string }>("export_playlist_file", {
  dbPath,
  playlistId,
  filePath,
});

export type PlaylistCollectionExportResult = {
  exportRoot: string;
  playlistsExported: number;
  playlistEntriesExported: number;
};

export const exportAllPlaylists = (
  dbPath: string,
  destinationPath: string,
) => invoke<PlaylistCollectionExportResult>("export_all_playlists", {
  dbPath,
  destinationPath,
});

export type ItunesLibraryExportResult = {
  destinationPath: string;
  tracksExported: number;
  missingTracksReferenced: number;
  playlistFoldersExported: number;
  playlistsExported: number;
  playlistEntriesExported: number;
  playlistEntriesSkipped: number;
};

export const exportItunesLibrary = (
  dbPath: string,
  destinationPath: string,
) => invoke<ItunesLibraryExportResult>("export_itunes_library", {
  dbPath,
  destinationPath,
});

export type LibraryBackupResult = {
  destinationPath: string;
  bytes: number;
  manifest: {
    version: number;
    backupId: string;
    createdAt: string;
    counts: {
      tracks: number;
      playlists: number;
      playlistFolders: number;
      playlistEntries: number;
      artworkFiles: number;
      smartCrates: number;
    };
  };
};

export const createLibraryBackup = (
  dbPath: string,
  destinationPath: string,
  settingsJson: string,
  smartCratesJson: string,
) => invoke<LibraryBackupResult>("create_library_backup", {
  dbPath,
  destinationPath,
  settingsJson,
  smartCratesJson,
});

export type LibraryRestoreResult = {
  archivePath: string;
  recoveryPath: string | null;
  settingsJson: string;
  smartCratesJson: string;
  restoredArtworkFiles: number;
  manifest: LibraryBackupResult["manifest"];
};

export const restoreLibraryBackup = (dbPath: string, archivePath: string) =>
  invoke<LibraryRestoreResult>("restore_library_backup", { dbPath, archivePath });

export type MetadataHistoryEntry = {
  id: number;
  trackId: string;
  changedAt: string;
  source: string;
  title: string;
  artist: string;
  changes: Record<string, { before: unknown; after: unknown }>;
};

export const listMetadataHistory = (
  dbPath: string,
  trackId?: string,
  limit = 100,
) => invoke<MetadataHistoryEntry[]>("list_metadata_history", { dbPath, trackId, limit });

export const rollbackMetadataChange = (
  dbPath: string,
  historyId: number,
  field: string,
) => invoke("rollback_metadata_change", { dbPath, historyId, field });

export type PlaylistHistoryState = {
  entries: Array<{ id: number; action: string; createdAt: string; undone: boolean }>;
  canUndo: boolean;
  canRedo: boolean;
};

export type PlaylistSnapshotEntry = {
  id: string;
  name: string;
  createdAt: string;
};

export const listPlaylistHistory = (dbPath: string, limit = 50) =>
  invoke<PlaylistHistoryState>("list_playlist_history", { dbPath, limit });
export const undoPlaylistHistory = (dbPath: string) =>
  invoke("undo_playlist_history", { dbPath });
export const redoPlaylistHistory = (dbPath: string) =>
  invoke("redo_playlist_history", { dbPath });
export const createPlaylistSnapshot = (dbPath: string, name: string) =>
  invoke<PlaylistSnapshotEntry>("create_playlist_snapshot", { dbPath, name });
export const listPlaylistSnapshots = (dbPath: string) =>
  invoke<PlaylistSnapshotEntry[]>("list_playlist_snapshots", { dbPath });
export const restorePlaylistSnapshot = (dbPath: string, snapshotId: string) =>
  invoke("restore_playlist_snapshot", { dbPath, snapshotId });
export const deletePlaylistSnapshot = (dbPath: string, snapshotId: string) =>
  invoke<{ deleted: boolean }>("delete_playlist_snapshot", { dbPath, snapshotId });

export type ListeningStatistics = {
  listeningSeconds: number;
  plays: number;
  uniqueTracks: number;
  discoveryRate: number;
  topArtists: Array<{ name: string; plays: number; listeningSeconds: number }>;
  topAlbums: Array<{ name: string; plays: number; listeningSeconds: number }>;
  monthly: Array<{ month: string; plays: number; listeningSeconds: number }>;
  neglectedTracks: Array<{
    id: string;
    title: string;
    artist: string;
    album: string;
    lastPlayedAt: string | null;
    playCount: number;
  }>;
};

export const loadListeningStatistics = (dbPath: string) =>
  invoke<ListeningStatistics>("load_listening_statistics", { dbPath });

export type OrganizedLibraryExportResult = {
  exportRoot: string;
  tracks: number;
  filesCopied: number;
  tracksFailed: number;
  playlistsExported: number;
  playlistEntriesExported: number;
  playlistEntriesMissing: number;
  librarySwitchRequested: boolean;
  librarySwitched: boolean;
  librarySwitchError: string | null;
  failures: Array<{ trackId: string; sourcePath: string; message: string }>;
};

export const exportOrganizedLibrary = (
  dbPath: string,
  destinationPath: string,
  useAsCurrentLibrary: boolean,
) => invoke<OrganizedLibraryExportResult>("export_organized_library", {
  dbPath,
  destinationPath,
  useAsCurrentLibrary,
});

// ============================================================================
// Backfill Operations
// ============================================================================

export const backfillSearchText = (dbPath: string) => {
  return invoke<number>("backfill_search_text", { dbPath });
};

export const backfillCoverArt = (dbPath: string) => {
  return invoke<number>("backfill_cover_art", { dbPath });
};

export type ArtistCreditMigrationResult = {
  skipped: boolean;
  tracksChecked: number;
  setsCreated: number;
  setsReplaced: number;
  creditsCreated: number;
};

export const migrateArtistCredits = (
  dbPath: string,
  artistSeparatorExceptions: string[] = [],
) => invoke<ArtistCreditMigrationResult>("migrate_artist_credits", {
  dbPath,
  artistSeparatorExceptions,
});

// ============================================================================
// Recently Played Operations
// ============================================================================

export const loadRecentlyPlayed = (
  dbPath: string,
  limit: number = 50,
  libraryRoot?: string,
  artistSeparatorExceptions?: string[],
) => {
  return invoke<import("./importApi").ImportedTrack[]>("load_recently_played", {
    dbPath,
    limit,
    libraryRoot,
    artistSeparatorExceptions,
  });
};

export const recordTrackPlay = (dbPath: string, trackId: string) => {
  return invoke<{ historyId: number; playedAt: string }>("record_track_play", {
    dbPath,
    trackId,
  });
};

export const updatePlayHistory = (
  dbPath: string,
  historyId: number,
  listenedSeconds: number,
) => invoke<{ updated: boolean }>("update_play_history", {
  dbPath,
  historyId,
  listenedSeconds,
});
