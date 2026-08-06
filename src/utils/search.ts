import type { Track } from "../types";
import {
  albumArtistCredits,
  explicitAlbumArtistDisplay,
  trackArtistCredits,
} from "./artistCredits";

/**
 * Normalize a string for search comparison.
 * Converts to lowercase, removes accents, and normalizes whitespace.
 */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // Remove diacritics
    .replace(/[._\\/:-]+/g, " ")
    .replace(/\s+/g, " ") // Collapse multiple spaces
    .trim();
}

/**
 * Check if a track matches a search query.
 * Keep this field list aligned with electron/database.mjs refreshSearchText so
 * the immediate in-memory answer cannot change when the indexed answer arrives.
 */
export function matchesSearchQuery(track: Track, query: string): boolean {
  if (!query.trim()) {
    return true;
  }

  const normalizedQuery = normalizeText(query);
  const queryTerms = normalizedQuery.split(" ").filter(Boolean);
  const creditedArtistNames = trackArtistCredits(track)
    .flatMap((credit) => [credit.name, credit.creditedName]);
  const creditedAlbumArtistNames = albumArtistCredits(track, { fallbackToTrack: false })
    .flatMap((credit) => [credit.name, credit.creditedName]);

  // Build searchable text from track fields
  const searchableFields = [
    track.title,
    track.artist,
    ...creditedArtistNames,
    explicitAlbumArtistDisplay(track),
    ...creditedAlbumArtistNames,
    track.album,
    track.genre,
    track.comment,
    track.label,
    track.sourcePath.split(/[\\/]/).pop(),
    track.year?.toString(),
    track.trackNumber?.toString(),
    track.discNumber?.toString(),
    track.key,
    track.bpm?.toString(),
  ].filter(Boolean);

  const normalizedTrackText = normalizeText(searchableFields.join(" "));

  // All query terms must match somewhere in the track text
  return queryTerms.every((term) => normalizedTrackText.includes(term));
}

/**
 * Filter tracks by search query.
 */
export function filterTracksBySearch(tracks: Track[], query: string): Track[] {
  if (!query.trim()) {
    return tracks;
  }

  return tracks.filter((track) => matchesSearchQuery(track, query));
}
