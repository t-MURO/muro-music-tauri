import type { Track } from "../types";
import { albumArtistDisplay } from "./artistCredits";

export type Album = {
  id: string;
  title: string;
  artist: string;
  year?: number;
  dateAdded?: string;
  coverArtPath?: string;
  coverArtThumbPath?: string;
  durationSeconds: number;
  genres: string[];
  tracks: Track[];
};

const normalize = (value: string) => value.trim().toLocaleLowerCase();

const getAlbumArtist = (track: Track) =>
  albumArtistDisplay(track).trim() || "Unknown artist";

const compareAlbumTracks = (left: Track, right: Track) => {
  const leftDisc = left.discNumber ?? 1;
  const rightDisc = right.discNumber ?? 1;
  if (leftDisc !== rightDisc) return leftDisc - rightDisc;

  const leftTrack = left.trackNumber ?? Number.MAX_SAFE_INTEGER;
  const rightTrack = right.trackNumber ?? Number.MAX_SAFE_INTEGER;
  if (leftTrack !== rightTrack) return leftTrack - rightTrack;

  return left.title.localeCompare(right.title, undefined, {
    numeric: true,
    sensitivity: "base",
  });
};

export const groupTracksIntoAlbums = (tracks: Track[]): Album[] => {
  const groups = new Map<string, Track[]>();

  for (const track of tracks) {
    const title = track.album.trim();
    if (!title) continue;

    const artist = getAlbumArtist(track);
    const id = `${normalize(title)}::${normalize(artist)}`;
    const group = groups.get(id);
    if (group) group.push(track);
    else groups.set(id, [track]);
  }

  return Array.from(groups, ([id, albumTracks]) => {
    const orderedTracks = [...albumTracks].sort(compareAlbumTracks);
    const representative = orderedTracks[0];
    const coverTrack = orderedTracks.find((track) => track.coverArtPath)
      ?? orderedTracks.find((track) => track.coverArtThumbPath);
    const years = orderedTracks
      .map((track) => track.year)
      .filter((year): year is number => typeof year === "number");
    const datesAdded = orderedTracks
      .map((track) => track.dateAdded)
      .filter((value): value is string => Boolean(value));
    datesAdded.sort();
    const genres = Array.from(
      new Set(
        orderedTracks
          .map((track) => track.genre?.trim())
          .filter((genre): genre is string => Boolean(genre))
      )
    );

    return {
      id,
      title: representative.album.trim(),
      artist: getAlbumArtist(representative),
      year: years.length > 0 ? Math.min(...years) : undefined,
      dateAdded: datesAdded[datesAdded.length - 1],
      coverArtPath: coverTrack?.coverArtPath,
      coverArtThumbPath: coverTrack?.coverArtThumbPath,
      durationSeconds: orderedTracks.reduce(
        (total, track) => total + (track.durationSeconds || 0),
        0
      ),
      genres,
      tracks: orderedTracks,
    };
  }).sort((left, right) =>
    left.title.localeCompare(right.title, undefined, {
      numeric: true,
      sensitivity: "base",
    })
  );
};

export const filterAlbumsBySearch = (albums: Album[], query: string) => {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return albums;

  return albums.filter((album) => {
    const searchable = normalize(
      [
        album.title,
        album.artist,
        album.year?.toString() ?? "",
        album.genres.join(" "),
        ...album.tracks.map((track) => `${track.title} ${track.artist}`),
      ].join(" ")
    );
    return terms.every((term) => searchable.includes(term));
  });
};
