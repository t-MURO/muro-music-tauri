import type { MessageKey } from "../i18n";
import type { BeatGrid } from "../lib/beatgrid/types";

export type ArtistCredit = {
  artistId: string;
  name: string;
  creditedName: string;
  joinPhrase: string;
  musicBrainzId?: string;
};

export type Track = {
  id: string;
  title: string;
  artist: string;
  artistCredits: ArtistCredit[];
  albumArtist?: string;
  albumArtistCredits: ArtistCredit[];
  /** @deprecated Use albumArtist. Kept while older desktop payloads remain supported. */
  artists?: string;
  album: string;
  trackNumber?: number;
  trackTotal?: number;
  key?: string;
  bpm?: number;
  year?: number;
  date?: string;
  dateAdded?: string;
  dateModified?: string;
  duration: string;
  durationSeconds: number;
  bitrate: string;
  sampleRate?: number;
  bitDepth?: number;
  fileSize?: number;
  rating: number;
  sourcePath: string;
  coverArtPath?: string;
  coverArtThumbPath?: string;
  genre?: string;
  comment?: string;
  label?: string;
  discNumber?: number;
  discTotal?: number;
  lastPlayedAt?: string;
  playCount: number;
  beatGrid?: BeatGrid;
  /** Integrated loudness in LUFS, when measured. */
  loudnessLufs?: number;
  /** ReplayGain in dB relative to the reference level. */
  replayGainTrackDb?: number;
  /** Sample peak as a linear ratio, used to hold back clipping. */
  replayGainTrackPeak?: number;
  replayGainAlbumDb?: number;
  replayGainAlbumPeak?: number;
  loudnessSource?: "tag" | "analyzed";
  /** Source file was absent the last time the library was verified. */
  isMissing?: boolean;
  musicBrainzTrackId?: string;
  musicBrainzAlbumId?: string;
  musicBrainzReleaseGroupId?: string;
  acoustIdId?: string;
};

export type TrackMetadataUpdates = {
  title?: string;
  artist?: string;
  artistCredits?: ArtistCredit[];
  albumArtist?: string;
  albumArtistCredits?: ArtistCredit[];
  /** @deprecated Use albumArtist. */
  artists?: string;
  album?: string;
  trackNumber?: number;
  trackTotal?: number;
  discNumber?: number;
  discTotal?: number;
  year?: number;
  genre?: string;
  comment?: string;
  label?: string;
  bpm?: number;
  key?: string;
  rating?: number;
  coverArtPath?: string;
  coverArtThumbPath?: string;
  musicBrainzTrackId?: string;
  musicBrainzAlbumId?: string;
  musicBrainzReleaseGroupId?: string;
  acoustIdId?: string;
};

export type Playlist = {
  id: string;
  name: string;
  trackIds: string[];
  folderId?: string;
  sortOrder: number;
  /** Imported playlist file that remains authoritative for automatic syncing. */
  sourcePath?: string;
  sourceMtimeMs?: number;
  sourceSize?: number;
  sourceSyncError?: string;
  lastSyncedAt?: number;
};

export type PlaylistFolder = {
  id: string;
  name: string;
  parentId?: string;
  sortOrder: number;
};

export type ArtistProfile = {
  profileVersion?: number;
  artistKey: string;
  requestedName: string;
  name: string;
  status: "ready" | "not-found";
  sortName?: string | null;
  disambiguation?: string | null;
  type?: string | null;
  country?: string | null;
  area?: string | null;
  begin?: string | null;
  end?: string | null;
  ended?: boolean;
  genres?: string[];
  description?: string | null;
  biography?: string | null;
  imagePath?: string | null;
  imageUrl?: string | null;
  imageProvider?: "wikimedia-commons" | "wikipedia" | "theaudiodb" | "fanart.tv" | "deezer" | "brave-search" | null;
  imageAttribution?: string | null;
  imageLicense?: string | null;
  imageLicenseUrl?: string | null;
  imageSourceUrl?: string | null;
  imageSelection?: "automatic" | "manual";
  lastFmAttempted?: boolean;
  lastFmUrl?: string | null;
  similarArtists?: Array<{
    name: string;
    musicBrainzId?: string | null;
    url?: string | null;
  }>;
  theAudioDbAttempted?: boolean;
  theAudioDbId?: string | null;
  theAudioDbUrl?: string | null;
  fanartAttempted?: boolean;
  musicBrainzId?: string | null;
  musicBrainzUrl?: string | null;
  wikipediaUrl?: string | null;
  wikimediaCommonsUrl?: string | null;
  fanartUrl?: string | null;
  fetchedAt: string;
  cacheState?: "fresh" | "stale";
};

export type ArtistImageCandidate = {
  id: string;
  provider: "wikimedia-commons" | "wikipedia" | "theaudiodb" | "fanart.tv" | "deezer" | "brave-search";
  imageUrl: string;
  sourceUrl?: string | null;
  sourceName?: string | null;
  title?: string | null;
  attribution?: string | null;
  license?: string | null;
  licenseUrl?: string | null;
  width?: number | null;
  height?: number | null;
  score?: number;
  current?: boolean;
};

export type AlbumCoverCandidate = {
  id: string;
  provider: "brave-search";
  imageUrl: string;
  sourceUrl: string;
  sourceName?: string | null;
  title?: string | null;
  width?: number | null;
  height?: number | null;
  score?: number;
};

export type SmartCrateField =
  | "bpm"
  | "key"
  | "genre"
  | "rating"
  | "artist"
  | "album"
  | "year"
  | "dateAdded"
  | "playCount"
  | "comment";

export type SmartCrateOperator =
  | "equals"
  | "contains"
  | "atLeast"
  | "atMost"
  | "between"
  | "withinDays";

export type SmartCrateRule = {
  id: string;
  field: SmartCrateField;
  operator: SmartCrateOperator;
  value: string;
  secondaryValue?: string;
};

export type SmartCrate = {
  id: string;
  name: string;
  match: "all" | "any";
  rules: SmartCrateRule[];
};

export type ColumnKey =
  | "title"
  | "artist"
  | "artists"
  | "album"
  | "playlists"
  | "trackNumber"
  | "trackTotal"
  | "discNumber"
  | "key"
  | "bpm"
  | "genre"
  | "year"
  | "date"
  | "dateAdded"
  | "dateModified"
  | "lastPlayedAt"
  | "playCount"
  | "duration"
  | "bitrate"
  | "sampleRate"
  | "bitDepth"
  | "fileSize"
  | "format"
  | "rating"
  | "comment"
  | "sourcePath";

export type ColumnConfig = {
  key: ColumnKey;
  labelKey: MessageKey;
  visible: boolean;
  width: number;
};
