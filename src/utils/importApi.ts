import { invoke } from "@muro/desktop/runtime";
import type { ArtistCredit, Track } from "../types";
import { BEAT_GRID_VERSION, type BeatGrid } from "../lib/beatgrid/types";

// ============================================================================
// Types
// ============================================================================

export type ImportedTrack = {
  id: string;
  title: string;
  artist: string;
  artist_credits?: ArtistCredit[];
  album_artist?: string;
  album_artist_credits?: ArtistCredit[];
  artists?: string;
  album: string;
  track_number?: number;
  track_total?: number;
  key?: string;
  bpm?: number;
  year?: number;
  date?: string;
  date_added?: string;
  date_modified?: string;
  duration: string;
  duration_seconds: number;
  bitrate: string;
  sample_rate_hz?: number;
  bit_depth?: number;
  file_size_bytes?: number;
  rating: number;
  source_path: string;
  cover_art_path?: string;
  cover_art_thumb_path?: string;
  genre?: string;
  comment?: string;
  label?: string;
  disc_number?: number;
  disc_total?: number;
  last_played_at?: string;
  play_count: number;
  beat_grid_json?: string | null;
  loudness_lufs?: number;
  replaygain_track_gain_db?: number;
  replaygain_track_peak?: number;
  replaygain_album_gain_db?: number;
  replaygain_album_peak?: number;
  loudness_source?: string;
  is_missing?: number;
  musicbrainz_trackid?: string;
  musicbrainz_albumid?: string;
  musicbrainz_releasegroupid?: string;
  acoustid_id?: string;
};

export type LibrarySnapshot = {
  library: ImportedTrack[];
  inbox: ImportedTrack[];
};

export type PlaylistSnapshot = {
  playlists: {
    id: string;
    name: string;
    folder_id: string | null;
    sort_order: number;
    source_path: string | null;
    source_mtime_ms: number | null;
    source_size: number | null;
    source_sync_error: string | null;
    last_synced_at: number | null;
    track_ids: string[];
  }[];
  folders: {
    id: string;
    name: string;
    parent_id: string | null;
    sort_order: number;
  }[];
};

export type ImportedPlaylistFile = {
  name: string;
  source_path: string;
  entries: Array<{
    path: string;
    track_id: string | null;
    exists: boolean;
  }>;
};

export type ImportFilesResult = {
  imported: ImportedTrack[];
  scanned: number;
  failures: Array<{ path: string; message: string }>;
};

// ============================================================================
// Import Operations
// ============================================================================

export const importFiles = (
  dbPath: string,
  paths: string[],
  options: {
    libraryFolder?: string;
  } = {},
) => {
  return invoke<ImportFilesResult>("import_files", {
    paths,
    dbPath,
    libraryFolder: options.libraryFolder ?? "",
  });
};

// ============================================================================
// Type Conversion
// ============================================================================

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const parseBeatGrid = (raw?: string | null): BeatGrid | undefined => {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const candidate = parsed as Partial<BeatGrid>;
    // An older version counts as absent, so the caller re-analyses and picks up
    // the fields it predates rather than planning against missing ones.
    if (
      candidate.version === BEAT_GRID_VERSION &&
      isFiniteNumber(candidate.bpm) &&
      isFiniteNumber(candidate.firstBeatSec) &&
      isFiniteNumber(candidate.firstDownbeatSec) &&
      isFiniteNumber(candidate.phraseBars) &&
      isFiniteNumber(candidate.firstPhraseSec) &&
      isFiniteNumber(candidate.phraseConfidence) &&
      isFiniteNumber(candidate.introEndSec) &&
      isFiniteNumber(candidate.outroStartSec) &&
      typeof candidate.hasOutro === "boolean" &&
      isFiniteNumber(candidate.confidence)
    ) {
      return candidate as BeatGrid;
    }
    return undefined;
  } catch {
    return undefined;
  }
};

/**
 * Converts the database transfer object to the renderer's Track shape.
 */
export const importedTrackToTrack = (imported: ImportedTrack): Track => ({
  id: imported.id,
  title: imported.title,
  artist: imported.artist,
  artistCredits: imported.artist_credits ?? [],
  albumArtist: imported.album_artist ?? imported.artists,
  albumArtistCredits: imported.album_artist_credits ?? [],
  artists: imported.album_artist ?? imported.artists,
  album: imported.album,
  trackNumber: imported.track_number,
  trackTotal: imported.track_total,
  key: imported.key,
  bpm: imported.bpm,
  year: imported.year,
  date: imported.date,
  dateAdded: imported.date_added,
  dateModified: imported.date_modified,
  duration: imported.duration,
  durationSeconds: imported.duration_seconds,
  bitrate: imported.bitrate,
  sampleRate: imported.sample_rate_hz,
  bitDepth: imported.bit_depth,
  fileSize: imported.file_size_bytes,
  rating: imported.rating,
  sourcePath: imported.source_path,
  coverArtPath: imported.cover_art_path,
  coverArtThumbPath: imported.cover_art_thumb_path,
  genre: imported.genre,
  comment: imported.comment,
  label: imported.label,
  discNumber: imported.disc_number,
  discTotal: imported.disc_total,
  lastPlayedAt: imported.last_played_at,
  playCount: imported.play_count,
  beatGrid: parseBeatGrid(imported.beat_grid_json),
  loudnessLufs: imported.loudness_lufs,
  replayGainTrackDb: imported.replaygain_track_gain_db,
  replayGainTrackPeak: imported.replaygain_track_peak,
  replayGainAlbumDb: imported.replaygain_album_gain_db,
  replayGainAlbumPeak: imported.replaygain_album_peak,
  loudnessSource:
    imported.loudness_source === "tag" || imported.loudness_source === "analyzed"
      ? imported.loudness_source
      : undefined,
  isMissing: imported.is_missing === 1,
  musicBrainzTrackId: imported.musicbrainz_trackid,
  musicBrainzAlbumId: imported.musicbrainz_albumid,
  musicBrainzReleaseGroupId: imported.musicbrainz_releasegroupid,
  acoustIdId: imported.acoustid_id,
});
