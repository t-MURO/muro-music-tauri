import { ArrowRight, UserRound } from "lucide-react";
import { convertFileSrc } from "@muro/desktop/runtime";
import type { ArtistProfile, Track } from "../../types";
import { normalizeArtistProfileKey } from "../../hooks";
import {
  artistIdentityKey,
  trackArtistCredits,
  type ArtistTarget,
} from "../../utils/artistCredits";

export type ArtistIndexItem = ArtistTarget & {
  artistKey: string;
  trackCount: number;
  albumCount: number;
};

export const buildArtistIndexItems = (tracks: Track[]): ArtistIndexItem[] => {
  const artists = new Map<string, ArtistIndexItem & { albums: Set<string> }>();
  tracks.forEach((track) => {
    const seenOnTrack = new Set<string>();
    trackArtistCredits(track).forEach((credit) => {
      const identity = artistIdentityKey(credit);
      if (!identity || seenOnTrack.has(identity)) return;
      seenOnTrack.add(identity);

      const name = credit.name.trim() || credit.creditedName.trim();
      const artistKey = normalizeArtistProfileKey(name);
      if (!artistKey) return;
      const existing = artists.get(identity);
      if (existing) {
        existing.trackCount += 1;
        if (track.album.trim()) existing.albums.add(track.album.trim().toLocaleLowerCase());
        existing.albumCount = existing.albums.size;
        return;
      }
      const albums = new Set<string>();
      if (track.album.trim()) albums.add(track.album.trim().toLocaleLowerCase());
      artists.set(identity, {
        artistId: identity,
        name,
        creditedName: credit.creditedName || name,
        musicBrainzId: credit.musicBrainzId,
        artistKey,
        trackCount: 1,
        albumCount: albums.size,
        albums,
      });
    });
  });
  return [...artists.values()]
    .map(({ albums: _albums, ...artist }) => artist)
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
};

const artistImageSource = (profile?: ArtistProfile) => {
  if (profile?.imagePath) return convertFileSrc(profile.imagePath);
  return profile?.imageUrl || undefined;
};

const initials = (name: string) => name
  .split(/\s+/)
  .filter(Boolean)
  .slice(0, 2)
  .map((part) => part[0]?.toLocaleUpperCase())
  .join("");

type ArtistIndexViewProps = {
  items: ArtistIndexItem[];
  profiles: Record<string, ArtistProfile>;
  onSelect: (artist: ArtistTarget) => void;
};

export const ArtistIndexView = ({ items, profiles, onSelect }: ArtistIndexViewProps) => (
  <div className="artist-index min-h-0 flex-1 overflow-y-auto" data-artist-index>
    {items.length > 0 ? (
      <div className="artist-index-grid">
        {items.map((artist) => {
          const profile = profiles[artistIdentityKey(artist)] ?? profiles[artist.artistKey];
          const imageSource = artistImageSource(profile);
          return (
            <button
              className="artist-index-card"
              data-artist-card={artist.name}
              data-artist-profile-cached={profile?.status === "ready" ? "true" : "false"}
              key={artist.artistId}
              onClick={() => onSelect(artist)}
              type="button"
            >
              <span className="artist-index-photo" aria-hidden="true">
                {imageSource ? <img alt="" src={imageSource} /> : <span>{initials(artist.name) || <UserRound />}</span>}
              </span>
              <span className="artist-index-copy">
                <strong>{profile?.name || artist.name}</strong>
                {profile?.description && <span className="artist-index-description">{profile.description}</span>}
                <span>{artist.trackCount.toLocaleString()} {artist.trackCount === 1 ? "track" : "tracks"} · {artist.albumCount.toLocaleString()} {artist.albumCount === 1 ? "album" : "albums"}</span>
              </span>
              <ArrowRight className="artist-index-arrow" aria-hidden="true" />
            </button>
          );
        })}
      </div>
    ) : (
      <div className="collection-index-empty">
        <UserRound aria-hidden="true" />
        <strong>No artists found</strong>
        <span>Artist metadata from your tracks will appear here.</span>
      </div>
    )}
  </div>
);
