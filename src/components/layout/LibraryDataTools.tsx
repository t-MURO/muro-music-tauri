import { useCallback, useEffect, useState } from "react";
import { confirm, open, save } from "../../desktop/dialogs";
import {
  createLibraryBackup,
  createPlaylistSnapshot,
  deletePlaylistSnapshot,
  exportItunesLibrary,
  importedTrackToTrack,
  listMetadataHistory,
  listPlaylistHistory,
  listPlaylistSnapshots,
  loadPlaylists,
  loadTracks,
  redoPlaylistHistory,
  restoreLibraryBackup,
  restorePlaylistSnapshot,
  rollbackMetadataChange,
  undoPlaylistHistory,
  type MetadataHistoryEntry,
  type PlaylistHistoryState,
  type PlaylistSnapshotEntry,
} from "../../utils";
import { notify, useLibraryStore, useSettingsStore } from "../../stores";

const SENSITIVE_SETTING_KEYS = [
  "lastFmApiKey",
  "theAudioDbApiKey",
  "fanartApiKey",
  "braveSearchApiKey",
  "acoustIdClientKey",
] as const;

const buttonClass =
  "rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 text-[12px] font-semibold text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50";
const primaryButtonClass =
  "rounded-[var(--radius-md)] bg-[var(--color-accent)] px-3 py-2 text-[12px] font-semibold text-white hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50";
const cardClass =
  "rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-4";

const displayValue = (value: unknown) => {
  if (value == null || value === "") return "Empty";
  if (Array.isArray(value)) return value.join(", ") || "Empty";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

type LibraryDataToolsProps = {
  dbPath: string;
};

export const LibraryDataTools = ({ dbPath }: LibraryDataToolsProps) => {
  const artistSeparatorExceptions = useSettingsStore(
    (state) => state.artistSeparatorExceptions,
  );
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [history, setHistory] = useState<PlaylistHistoryState>({
    entries: [],
    canUndo: false,
    canRedo: false,
  });
  const [snapshots, setSnapshots] = useState<PlaylistSnapshotEntry[]>([]);
  const [metadata, setMetadata] = useState<MetadataHistoryEntry[]>([]);
  const [snapshotName, setSnapshotName] = useState("");
  const [itunesExportStatus, setItunesExportStatus] = useState<string | null>(null);

  const refreshPlaylistData = useCallback(async () => {
    if (!dbPath) return;
    const [historyResult, snapshotResult, playlistData] = await Promise.all([
      listPlaylistHistory(dbPath),
      listPlaylistSnapshots(dbPath),
      loadPlaylists(dbPath),
    ]);
    setHistory(historyResult);
    setSnapshots(snapshotResult);
    const store = useLibraryStore.getState();
    store.setPlaylists(playlistData.playlists.map((playlist) => ({
      id: playlist.id,
      name: playlist.name,
      folderId: playlist.folder_id ?? undefined,
      sortOrder: playlist.sort_order,
      sourcePath: playlist.source_path ?? undefined,
      sourceMtimeMs: playlist.source_mtime_ms ?? undefined,
      sourceSize: playlist.source_size ?? undefined,
      sourceSyncError: playlist.source_sync_error ?? undefined,
      lastSyncedAt: playlist.last_synced_at ?? undefined,
      trackIds: playlist.track_ids,
    })));
    store.setPlaylistFolders(playlistData.folders.map((folder) => ({
      id: folder.id,
      name: folder.name,
      parentId: folder.parent_id ?? undefined,
      sortOrder: folder.sort_order,
    })));
  }, [dbPath]);

  const refreshMetadata = useCallback(async () => {
    if (dbPath) setMetadata(await listMetadataHistory(dbPath, undefined, 30));
  }, [dbPath]);

  const refreshTracks = useCallback(async () => {
    const snapshot = await loadTracks(dbPath, undefined, artistSeparatorExceptions);
    const store = useLibraryStore.getState();
    store.setTracks(snapshot.library.map(importedTrackToTrack));
    store.setInboxTracks(snapshot.inbox.map(importedTrackToTrack));
  }, [artistSeparatorExceptions, dbPath]);

  useEffect(() => {
    void Promise.all([refreshPlaylistData(), refreshMetadata()]).catch(() => undefined);
  }, [refreshMetadata, refreshPlaylistData]);

  const run = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    try {
      await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message);
      notify.error(message);
    } finally {
      setBusy(false);
    }
  };

  const handleBackup = () => run(async () => {
    const destinationPath = await save({
      defaultPath: `muro-library-${new Date().toISOString().slice(0, 10)}.murobackup`,
      filters: [{ name: "Muro Library Backup", extensions: ["murobackup"] }],
    });
    if (!destinationPath) return;
    const result = await createLibraryBackup(
      dbPath,
      destinationPath,
      window.localStorage.getItem("muro-settings") ?? "",
      window.localStorage.getItem("muro-smart-crates") ?? "",
    );
    setStatus(
      `Backup created: ${result.manifest.counts.tracks.toLocaleString()} tracks, `
      + `${result.manifest.counts.playlists.toLocaleString()} playlists, `
      + `${result.manifest.counts.artworkFiles.toLocaleString()} artwork files.`,
    );
  });

  const handleRestore = () => run(async () => {
    const selected = await open({
      properties: ["openFile"],
      filters: [{ name: "Muro Library Backup", extensions: ["murobackup"] }],
    });
    const archivePath = Array.isArray(selected) ? selected[0] : selected;
    if (!archivePath) return;
    const approved = await confirm(
      "Restore this backup? The current database will be kept as a recovery copy and the app will reload.",
      { title: "Restore Muro library", confirmLabel: "Restore backup" },
    );
    if (!approved) return;
    const result = await restoreLibraryBackup(dbPath, archivePath);
    if (result.settingsJson) {
      const restored = JSON.parse(result.settingsJson);
      if (restored?.state && typeof restored.state === "object") {
        const current = JSON.parse(window.localStorage.getItem("muro-settings") ?? "{}");
        const currentState = current?.state && typeof current.state === "object"
          ? current.state
          : {};
        restored.state = { ...currentState, ...restored.state };
        for (const key of SENSITIVE_SETTING_KEYS) {
          restored.state[key] = currentState[key] ?? "";
        }
        restored.state.dbPath = dbPath;
        restored.state.useAutoDbPath = false;
        window.localStorage.setItem("muro-settings", JSON.stringify(restored));
      }
    }
    if (result.smartCratesJson) {
      window.localStorage.setItem("muro-smart-crates", result.smartCratesJson);
    }
    window.location.reload();
  });

  const handleItunesExport = () => run(async () => {
    setItunesExportStatus(null);
    const destinationPath = await save({
      defaultPath: "Muro Music Library.xml",
      filters: [{ name: "iTunes Library XML", extensions: ["xml"] }],
    });
    if (!destinationPath) return;
    const result = await exportItunesLibrary(dbPath, destinationPath);
    const skipped = result.playlistEntriesSkipped > 0
      ? ` ${result.playlistEntriesSkipped.toLocaleString()} playlist entries that point to Inbox tracks were skipped.`
      : "";
    const missing = result.missingTracksReferenced > 0
      ? ` ${result.missingTracksReferenced.toLocaleString()} missing tracks remain as file references.`
      : "";
    setItunesExportStatus(
      `Exported ${result.tracksExported.toLocaleString()} tracks and `
      + `${result.playlistsExported.toLocaleString()} playlists to ${result.destinationPath}.`
      + skipped
      + missing,
    );
    notify.success("iTunes-compatible library XML exported");
  });

  const handlePlaylistChange = (operation: () => Promise<unknown>) => run(async () => {
    await operation();
    await refreshPlaylistData();
  });

  const handleCreateSnapshot = () => {
    const name = snapshotName.trim();
    if (!name) return;
    void handlePlaylistChange(() => createPlaylistSnapshot(dbPath, name));
    setSnapshotName("");
  };

  const handleRollback = (entry: MetadataHistoryEntry, field: string) => run(async () => {
    await rollbackMetadataChange(dbPath, entry.id, field);
    await Promise.all([refreshMetadata(), refreshTracks()]);
    setStatus(`Rolled back ${field} for ${entry.title}.`);
  });

  return (
    <div className="space-y-5" data-library-data-tools>
      <section className={cardClass}>
        <h4 className="text-[13px] font-semibold text-[var(--color-text-primary)]">
          Backup and restore
        </h4>
        <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
          A .murobackup archive contains a consistent SQLite snapshot, playlists, Smart Crates,
          non-secret settings, artwork selections and files, plus a versioned manifest. API keys
          and music files are not copied. Device-specific paths, including the local music-library
          folder, remain configured on this computer.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button className={primaryButtonClass} disabled={busy || !dbPath} onClick={handleBackup} type="button">
            Create backup
          </button>
          <button className={buttonClass} disabled={busy || !dbPath} onClick={handleRestore} type="button">
            Restore backup
          </button>
        </div>
        {status && <p className="mt-3 text-[12px] text-[var(--color-text-secondary)]">{status}</p>}
      </section>

      <section className={cardClass} data-itunes-library-export>
        <h4 className="text-[13px] font-semibold text-[var(--color-text-primary)]">
          iTunes-compatible library XML
        </h4>
        <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
          Exports track metadata, ratings, play counts, original file locations, playlist folders,
          and all playlists in the XML property-list format used by iTunes and Music. Music and
          artwork files are not copied or changed.
        </p>
        <button
          className={`mt-3 ${primaryButtonClass}`}
          disabled={busy || !dbPath}
          onClick={handleItunesExport}
          type="button"
          data-export-itunes-library
        >
          Export library XML
        </button>
        {itunesExportStatus && (
          <p
            className="mt-3 text-[12px] text-[var(--color-text-secondary)]"
            data-itunes-library-export-status
          >
            {itunesExportStatus}
          </p>
        )}
      </section>

      <section className={cardClass}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h4 className="text-[13px] font-semibold text-[var(--color-text-primary)]">
              Playlist history and snapshots
            </h4>
            <p className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
              Undo or redo persisted playlist changes, or save a named point-in-time snapshot.
            </p>
          </div>
          <div className="flex gap-2">
            <button className={buttonClass} disabled={busy || !history.canUndo} onClick={() =>
              handlePlaylistChange(() => undoPlaylistHistory(dbPath))} type="button">Undo</button>
            <button className={buttonClass} disabled={busy || !history.canRedo} onClick={() =>
              handlePlaylistChange(() => redoPlaylistHistory(dbPath))} type="button">Redo</button>
          </div>
        </div>
        <div className="mt-3 flex gap-2">
          <input
            className="min-w-0 flex-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 text-[12px] text-[var(--color-text-primary)]"
            placeholder="Snapshot name"
            value={snapshotName}
            onChange={(event) => setSnapshotName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") handleCreateSnapshot();
            }}
          />
          <button className={primaryButtonClass} disabled={busy || !snapshotName.trim()} onClick={handleCreateSnapshot} type="button">
            Save snapshot
          </button>
        </div>
        {snapshots.length > 0 && (
          <div className="mt-3 space-y-2">
            {snapshots.map((snapshot) => (
              <div key={snapshot.id} className="flex items-center justify-between gap-3 rounded border border-[var(--color-border-light)] px-3 py-2">
                <span className="min-w-0">
                  <span className="block truncate text-[12px] font-medium text-[var(--color-text-primary)]">{snapshot.name}</span>
                  <span className="text-[10px] text-[var(--color-text-muted)]">{new Date(snapshot.createdAt).toLocaleString()}</span>
                </span>
                <span className="flex gap-2">
                  <button className={buttonClass} disabled={busy} onClick={() =>
                    handlePlaylistChange(() => restorePlaylistSnapshot(dbPath, snapshot.id))} type="button">Restore</button>
                  <button className={buttonClass} disabled={busy} onClick={() =>
                    handlePlaylistChange(() => deletePlaylistSnapshot(dbPath, snapshot.id))} type="button">Delete</button>
                </span>
              </div>
            ))}
          </div>
        )}
        {history.entries.length > 0 && (
          <ol className="mt-3 max-h-40 space-y-1 overflow-y-auto">
            {history.entries.slice(0, 12).map((entry) => (
              <li key={entry.id} className={`flex justify-between gap-3 text-[11px] ${entry.undone ? "opacity-50" : ""}`}>
                <span className="truncate text-[var(--color-text-secondary)]">{entry.action}</span>
                <time className="shrink-0 text-[var(--color-text-muted)]">{new Date(entry.createdAt).toLocaleString()}</time>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className={cardClass}>
        <h4 className="text-[13px] font-semibold text-[var(--color-text-primary)]">
          Metadata change history
        </h4>
        <p className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
          Every edited field is recorded independently. Roll back only the field you choose.
        </p>
        <div className="mt-3 max-h-72 space-y-3 overflow-y-auto">
          {metadata.length === 0 && (
            <p className="text-[12px] text-[var(--color-text-muted)]">No metadata edits recorded yet.</p>
          )}
          {metadata.map((entry) => (
            <article key={entry.id} className="rounded border border-[var(--color-border-light)] p-3">
              <div className="flex justify-between gap-3">
                <strong className="truncate text-[12px] text-[var(--color-text-primary)]">
                  {entry.artist} — {entry.title}
                </strong>
                <time className="shrink-0 text-[10px] text-[var(--color-text-muted)]">
                  {new Date(entry.changedAt).toLocaleString()}
                </time>
              </div>
              <div className="mt-2 space-y-2">
                {Object.entries(entry.changes).map(([field, change]) => (
                  <div key={field} className="flex items-center justify-between gap-3 text-[11px]">
                    <span className="min-w-0 truncate text-[var(--color-text-secondary)]">
                      <b>{field}</b>: {displayValue(change.before)} → {displayValue(change.after)}
                    </span>
                    <button className={buttonClass} disabled={busy} onClick={() => handleRollback(entry, field)} type="button">
                      Roll back field
                    </button>
                  </div>
                ))}
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
};
