import assert from "node:assert/strict";
import {
  artistSeparatorExceptionKey,
  findArtistSeparatorCandidates,
  proposeCommaSeparatedArtists,
} from "../src/lib/metadata/artistSeparators.ts";

assert.equal(proposeCommaSeparatedArtists("Artist A & Artist B"), "Artist A, Artist B");
assert.equal(proposeCommaSeparatedArtists("Artist A feat. Artist B"), "Artist A, Artist B");
assert.equal(proposeCommaSeparatedArtists("Artist A FEAT Artist B"), "Artist A, Artist B");
assert.equal(
  proposeCommaSeparatedArtists("Artist A & Artist B feat. Artist C"),
  "Artist A, Artist B, Artist C",
);
assert.equal(proposeCommaSeparatedArtists("R&B"), null);
assert.equal(proposeCommaSeparatedArtists("Artist A featuring Artist B"), null);
assert.equal(proposeCommaSeparatedArtists("Solo Artist"), null);
assert.equal(artistSeparatorExceptionKey("  SHDW   & Obscure  "), "shdw & obscure");

const track = (id, artist, albumArtist) => ({
  id,
  title: `Track ${id}`,
  artist,
  artists: albumArtist,
  album: "Test Album",
  duration: "3:00",
  durationSeconds: 180,
  bitrate: "320 kbps",
  rating: 0,
  sourcePath: `/music/${id}.mp3`,
  playCount: 0,
});

assert.deepEqual(
  findArtistSeparatorCandidates([
    track("one", "Artist A & Artist B"),
    track("two", "Solo Artist"),
    track("three", "Artist C feat. Artist D", "Album Artist A & Album Artist B"),
    track("four", "Solo Artist", "R&B"),
  ]),
  [
    {
      trackId: "one",
      title: "Track one",
      album: "Test Album",
      field: "artist",
      originalValue: "Artist A & Artist B",
      proposedValue: "Artist A, Artist B",
    },
    {
      trackId: "three",
      title: "Track three",
      album: "Test Album",
      field: "artist",
      originalValue: "Artist C feat. Artist D",
      proposedValue: "Artist C, Artist D",
    },
    {
      trackId: "three",
      title: "Track three",
      album: "Test Album",
      field: "albumArtist",
      originalValue: "Album Artist A & Album Artist B",
      proposedValue: "Album Artist A, Album Artist B",
    },
  ],
);

const exceptionTracks = [
  track("five", "SHDW & Obscure"),
  track("six", "Solo Artist", "shdw & obscure"),
  track("seven", "SHDW & Obscure feat. Guest"),
];
assert.equal(findArtistSeparatorCandidates(exceptionTracks).length, 3);
assert.deepEqual(
  findArtistSeparatorCandidates(exceptionTracks, [" SHDW & OBSCURE "]),
  [{
    trackId: "seven",
    title: "Track seven",
    album: "Test Album",
    field: "artist",
    originalValue: "SHDW & Obscure feat. Guest",
    proposedValue: "SHDW, Obscure, Guest",
  }],
);

console.log("Artist separator smoke test passed.");
