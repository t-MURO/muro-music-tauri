import type { Track } from "../types";
import { explicitAlbumArtistDisplay } from "./artistCredits";

export type MissingMetadataField =
  | "albumArtist"
  | "album"
  | "genre"
  | "year"
  | "key"
  | "bpm"
  | "artwork"
  | "label"
  | "comment";

export type TrackAnalysisFilter = "any" | "complete" | "incomplete";

export type AdvancedTrackFilters = {
  missingMetadata: MissingMetadataField[];
  analysis: TrackAnalysisFilter;
  bpmMin: number | null;
  bpmMax: number | null;
  yearMin: number | null;
  yearMax: number | null;
  durationMinMinutes: number | null;
  durationMaxMinutes: number | null;
  ratingMin: number | null;
  format: string;
  genre: string;
  label: string;
};

export const DEFAULT_ADVANCED_TRACK_FILTERS: AdvancedTrackFilters = {
  missingMetadata: [],
  analysis: "any",
  bpmMin: null,
  bpmMax: null,
  yearMin: null,
  yearMax: null,
  durationMinMinutes: null,
  durationMaxMinutes: null,
  ratingMin: null,
  format: "",
  genre: "",
  label: "",
};

const hasText = (value: string | undefined) => Boolean(value?.trim());
const hasPositiveNumber = (value: number | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

export const trackFormat = (track: Pick<Track, "sourcePath">) => {
  const fileName = track.sourcePath.split(/[\\/]/).pop() ?? "";
  const extensionIndex = fileName.lastIndexOf(".");
  return extensionIndex > 0 ? fileName.slice(extensionIndex + 1).toLocaleLowerCase() : "";
};

const isMetadataMissing = (track: Track, field: MissingMetadataField) => {
  switch (field) {
    case "albumArtist": return !hasText(explicitAlbumArtistDisplay(track));
    case "album": return !hasText(track.album);
    case "genre": return !hasText(track.genre);
    case "year": return !hasPositiveNumber(track.year);
    case "key": return !hasText(track.key);
    case "bpm": return !hasPositiveNumber(track.bpm);
    case "artwork": return !hasText(track.coverArtPath) && !hasText(track.coverArtThumbPath);
    case "label": return !hasText(track.label);
    case "comment": return !hasText(track.comment);
  }
};

const containsText = (value: string | undefined, query: string) =>
  !query.trim() || (value ?? "").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());

export const matchesAdvancedTrackFilters = (track: Track, filters: AdvancedTrackFilters) => {
  if (filters.missingMetadata.some((field) => !isMetadataMissing(track, field))) return false;

  const analysisComplete = hasText(track.key) && hasPositiveNumber(track.bpm);
  if (filters.analysis === "complete" && !analysisComplete) return false;
  if (filters.analysis === "incomplete" && analysisComplete) return false;

  if (filters.bpmMin !== null && (!hasPositiveNumber(track.bpm) || track.bpm! < filters.bpmMin)) return false;
  if (filters.bpmMax !== null && (!hasPositiveNumber(track.bpm) || track.bpm! > filters.bpmMax)) return false;
  if (filters.yearMin !== null && (!hasPositiveNumber(track.year) || track.year! < filters.yearMin)) return false;
  if (filters.yearMax !== null && (!hasPositiveNumber(track.year) || track.year! > filters.yearMax)) return false;
  if (filters.durationMinMinutes !== null && track.durationSeconds < filters.durationMinMinutes * 60) return false;
  if (filters.durationMaxMinutes !== null && track.durationSeconds > filters.durationMaxMinutes * 60) return false;
  if (filters.ratingMin !== null && track.rating < filters.ratingMin) return false;
  if (filters.format && trackFormat(track) !== filters.format.toLocaleLowerCase()) return false;
  if (!containsText(track.genre, filters.genre)) return false;
  if (!containsText(track.label, filters.label)) return false;

  return true;
};

export const filterTracksAdvanced = (tracks: Track[], filters: AdvancedTrackFilters) =>
  tracks.filter((track) => matchesAdvancedTrackFilters(track, filters));

export const countAdvancedTrackFilters = (filters: AdvancedTrackFilters) =>
  filters.missingMetadata.length
  + (filters.analysis === "any" ? 0 : 1)
  + [
    filters.bpmMin,
    filters.bpmMax,
    filters.yearMin,
    filters.yearMax,
    filters.durationMinMinutes,
    filters.durationMaxMinutes,
    filters.ratingMin,
  ].filter((value) => value !== null).length
  + [filters.format, filters.genre, filters.label].filter((value) => value.trim()).length;

export const listTrackFormats = (tracks: Track[]) =>
  [...new Set(tracks.map(trackFormat).filter(Boolean))].sort((left, right) => left.localeCompare(right));
