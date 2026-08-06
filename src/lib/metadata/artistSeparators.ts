import type { Track } from "../../types";

const ARTIST_SEPARATOR_PATTERN = /\s+(?:&|feat\.?)\s+/gi;

const explicitAlbumArtistDisplay = (track: Track) => (
  track.albumArtist?.trim() ? track.albumArtist : track.artists ?? ""
);

export const artistSeparatorExceptionKey = (artist: string): string =>
  String(artist ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

export type ArtistSeparatorCandidate = {
  trackId: string;
  title: string;
  album: string;
  field: "artist" | "albumArtist";
  originalValue: string;
  proposedValue: string;
};

export const proposeCommaSeparatedArtists = (artist: string): string | null => {
  const parts = artist
    .split(ARTIST_SEPARATOR_PATTERN)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;

  const proposedArtist = parts.join(", ");
  return proposedArtist === artist.trim() ? null : proposedArtist;
};

export const findArtistSeparatorCandidates = (
  tracks: Track[],
  exceptions: Iterable<string> = [],
): ArtistSeparatorCandidate[] => {
  const exceptionKeys = new Set(
    Array.from(exceptions, artistSeparatorExceptionKey).filter(Boolean),
  );

  return tracks.flatMap((track) => {
    const candidates: ArtistSeparatorCandidate[] = [];
    const proposedArtist = proposeCommaSeparatedArtists(track.artist);
    if (proposedArtist && !exceptionKeys.has(artistSeparatorExceptionKey(track.artist))) {
      candidates.push({
        trackId: track.id,
        title: track.title,
        album: track.album,
        field: "artist",
        originalValue: track.artist,
        proposedValue: proposedArtist,
      });
    }

    const albumArtist = explicitAlbumArtistDisplay(track).trim();
    const proposedAlbumArtist = albumArtist
      ? proposeCommaSeparatedArtists(albumArtist)
      : null;
    if (
      albumArtist
      && proposedAlbumArtist
      && !exceptionKeys.has(artistSeparatorExceptionKey(albumArtist))
    ) {
      candidates.push({
        trackId: track.id,
        title: track.title,
        album: track.album,
        field: "albumArtist",
        originalValue: albumArtist,
        proposedValue: proposedAlbumArtist,
      });
    }

    return candidates;
  });
};
