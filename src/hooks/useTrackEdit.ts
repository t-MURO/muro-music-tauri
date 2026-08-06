import { useCallback } from "react";
import { invoke } from "@muro/desktop/runtime";
import { notify, useLibraryStore, useSettingsStore, useUIStore } from "../stores";
import type { Track, TrackMetadataUpdates } from "../types";
import {
  cacheAlbumCoverCandidate,
  fetchTrackCoverArt,
  searchAlbumCoverImages,
  searchTrackMetadata,
  searchAlbumMetadata,
  loadAlbumMetadata,
  identifyTrackWithAcoustId,
  type FetchedCoverArt,
  type MetadataSearchCandidate,
  type AlbumMetadataCandidate,
  type AlbumMetadataRelease,
  type AcoustIdIdentificationResult,
} from "../utils/database";
import { useDbPath } from "./useDbPath";
import type { AlbumCoverCandidate } from "../types";
import { albumArtistDisplay } from "../utils/artistCredits";

type MetadataWriteResult = {
  updated: number;
  filesWritten: number;
  fileWriteErrors: Array<{ trackId: string; fileName: string; message: string }>;
};

export const useTrackEdit = () => {
  const setTracks = useLibraryStore((s) => s.setTracks);
  const setInboxTracks = useLibraryStore((s) => s.setInboxTracks);
  const editTrackIds = useUIStore((s) => s.editTrackIds);
  const openEditModal = useUIStore((s) => s.openEditModal);
  const closeEditModal = useUIStore((s) => s.closeEditModal);
  const resolveDbPath = useDbPath();
  const acoustIdClientKey = useSettingsStore((state) => state.acoustIdClientKey);
  const braveSearchApiKey = useSettingsStore((state) => state.braveSearchApiKey);

  const handleSaveMetadata = useCallback(
    async (trackIds: string[], updates: TrackMetadataUpdates) => {
      // Build the updates map for the desktop command.
      const updateMap: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(updates)) {
        if (value !== undefined) {
          updateMap[key] = value;
        }
      }

      if (Object.keys(updateMap).length === 0) {
        return;
      }

      const dbPath = await resolveDbPath();
      const result = await invoke<MetadataWriteResult | undefined>("update_track_metadata", {
        dbPath,
        trackIds,
        updates: updateMap,
      });

      // Update local state
      const updateTrackList = (trackList: Track[]): Track[] =>
        trackList.map((track) => {
          if (trackIds.includes(track.id)) {
            return { ...track, ...updates };
          }
          return track;
        });

      setTracks(updateTrackList);
      setInboxTracks(updateTrackList);

      if (updates.coverArtPath && result) {
        if (result.fileWriteErrors.length > 0) {
          const failedNames = result.fileWriteErrors
            .slice(0, 3)
            .map((failure) => failure.fileName)
            .join(", ");
          const remaining = result.fileWriteErrors.length - 3;
          throw new Error(
            `Cover art was embedded in ${result.filesWritten} of ${trackIds.length} files. `
            + `Could not write ${failedNames}${remaining > 0 ? ` and ${remaining} more` : ""}. `
            + "Check that the files are writable.",
          );
        }
        notify.success(
          trackIds.length === 1
            ? "Cover art embedded in the music file"
            : `Cover art embedded in all ${result.filesWritten} music files`,
        );
      }
    },
    [resolveDbPath, setTracks, setInboxTracks]
  );

  const handleFetchCoverArt = useCallback(
    async (
      trackId: string,
      metadata: { album?: string; artist?: string },
    ): Promise<FetchedCoverArt | { candidates: AlbumCoverCandidate[] } | null> => {
      const dbPath = await resolveDbPath();
      let providerError: unknown = null;
      try {
        const cover = await fetchTrackCoverArt(dbPath, trackId, metadata);
        if (cover) return cover;
      } catch (error) {
        providerError = error;
      }

      const candidates = await searchAlbumCoverImages({
        album: metadata.album ?? "",
        artist: metadata.artist ?? "",
      }, braveSearchApiKey);
      if (candidates.length > 0) return { candidates };

      if (providerError) throw providerError;
      return null;
    },
    [braveSearchApiKey, resolveDbPath],
  );

  const handleCacheCoverCandidate = useCallback(
    (candidate: AlbumCoverCandidate): Promise<FetchedCoverArt> =>
      cacheAlbumCoverCandidate(candidate),
    [],
  );

  const handleSearchMetadata = useCallback(
    (track: Track): Promise<MetadataSearchCandidate[]> => searchTrackMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album,
    }),
    [],
  );

  const handleSearchAlbumMetadata = useCallback(
    (tracks: Track[]): Promise<AlbumMetadataCandidate[]> => {
      const first = tracks[0];
      if (!first) return Promise.resolve([]);
      return searchAlbumMetadata({
        album: first.album,
        artist: albumArtistDisplay(first),
      });
    },
    [],
  );

  const handleLoadAlbumMetadata = useCallback(
    (releaseId: string): Promise<AlbumMetadataRelease> => loadAlbumMetadata(releaseId),
    [],
  );

  const handleIdentifyWithAcoustId = useCallback(
    async (track: Track, force = false): Promise<AcoustIdIdentificationResult> => {
      const dbPath = await resolveDbPath();
      return identifyTrackWithAcoustId(dbPath, track.id, acoustIdClientKey, force);
    },
    [acoustIdClientKey, resolveDbPath],
  );

  return {
    editTrackIds,
    isEditModalOpen: editTrackIds.length > 0,
    openEditModal,
    closeEditModal,
    handleSaveMetadata,
    handleFetchCoverArt,
    handleCacheCoverCandidate,
    handleSearchMetadata,
    handleSearchAlbumMetadata,
    handleLoadAlbumMetadata,
    handleIdentifyWithAcoustId,
  };
};
