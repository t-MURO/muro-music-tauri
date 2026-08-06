import { useEffect, useState } from "react";
import { CalendarDays, Disc3, ExternalLink, ImageIcon, MapPin, Music2, RefreshCw, UserRound } from "lucide-react";
import { convertFileSrc } from "@muro/desktop/runtime";
import type { ArtistProfile } from "../../types";

const profileImageSource = (profile?: ArtistProfile | null) => {
  if (profile?.imagePath) return convertFileSrc(profile.imagePath);
  return profile?.imageUrl || undefined;
};

const lifespan = (profile?: ArtistProfile | null) => {
  if (!profile?.begin && !profile?.end) return null;
  if (profile.begin && profile.end) return `${profile.begin} – ${profile.end}`;
  if (profile.begin) return profile.ended ? profile.begin : `${profile.begin} – present`;
  return profile.end;
};

type ArtistDetailPanelProps = {
  artistName: string;
  profile?: ArtistProfile | null;
  isLoading: boolean;
  error?: string;
  trackCount: number;
  albumCount: number;
  onRefresh: () => void;
  onChangePicture: () => void;
  onOpenSource: (url: string) => void;
};

export const ArtistDetailPanel = ({
  artistName,
  profile,
  isLoading,
  error,
  trackCount,
  albumCount,
  onRefresh,
  onChangePicture,
  onOpenSource,
}: ArtistDetailPanelProps) => {
  const imageSource = profileImageSource(profile);
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [imageSource]);
  const years = lifespan(profile);

  return (
    <section className="artist-detail-panel" data-artist-detail={artistName} data-artist-status={profile?.status ?? (isLoading ? "loading" : "empty")}>
      <button className="artist-detail-photo" onClick={onChangePicture} title="Change artist picture" type="button">
        {imageSource && !imageFailed
          ? <img alt={`${profile?.name || artistName} profile`} onError={() => setImageFailed(true)} src={imageSource} />
          : <UserRound aria-hidden="true" />}
      </button>
      <div className="artist-detail-content">
        <div className="artist-detail-heading">
          <div>
            <span className="artist-detail-eyebrow">Artist profile</span>
            <h3>{profile?.name || artistName}</h3>
            {(profile?.description || profile?.disambiguation) && (
              <p className="artist-detail-description">{profile.description || profile.disambiguation}</p>
            )}
          </div>
          <div className="artist-detail-heading-actions">
            <button className="artist-detail-refresh" onClick={onChangePicture} title="Search for another artist picture" type="button">
              <ImageIcon />
              Picture
            </button>
            <button className="artist-detail-refresh" disabled={isLoading} onClick={onRefresh} title="Refresh artist information" type="button">
              <RefreshCw className={isLoading ? "animate-spin" : ""} />
              {isLoading ? "Loading" : "Refresh"}
            </button>
          </div>
        </div>

        <div className="artist-detail-facts">
          <span><Music2 />{trackCount.toLocaleString()} {trackCount === 1 ? "track" : "tracks"}</span>
          <span><Disc3 />{albumCount.toLocaleString()} {albumCount === 1 ? "album" : "albums"}</span>
          {(profile?.area || profile?.country) && <span><MapPin />{profile.area || profile.country}</span>}
          {years && <span><CalendarDays />{years}</span>}
          {profile?.type && <span><UserRound />{profile.type}</span>}
        </div>

        {isLoading && !profile && <p className="artist-detail-message">Looking up artist information…</p>}
        {error && !profile && <p className="artist-detail-message artist-detail-message--error">Artist information could not be loaded. Check your connection and try again.</p>}
        {profile?.status === "not-found" && <p className="artist-detail-message">No reliable online artist match was found. Your local tracks are still shown below.</p>}
        {profile?.biography && <p className="artist-detail-biography">{profile.biography}</p>}
        {profile?.genres && profile.genres.length > 0 && (
          <div className="artist-detail-genres">
            {profile.genres.map((genre) => <span key={genre}>{genre}</span>)}
          </div>
        )}
        {profile?.similarArtists && profile.similarArtists.length > 0 && (
          <div className="artist-detail-similar">
            <span>Similar artists</span>
            <div>
              {profile.similarArtists.map((artist) => artist.url
                ? (
                  <button key={artist.name} onClick={() => onOpenSource(artist.url!)} type="button">
                    {artist.name} <ExternalLink />
                  </button>
                )
                : <em key={artist.name}>{artist.name}</em>)}
            </div>
          </div>
        )}
        {(profile?.imageAttribution || profile?.imageLicense) && (
          <p className="artist-detail-photo-credit">
            Photo: {profile.imageAttribution || profile.imageProvider || "online source"}
            {profile.imageLicense && ` · ${profile.imageLicense}`}
          </p>
        )}
        {(profile?.wikipediaUrl || profile?.wikimediaCommonsUrl || profile?.musicBrainzUrl || profile?.lastFmUrl || profile?.theAudioDbUrl || profile?.fanartUrl || profile?.imageSourceUrl) && (
          <div className="artist-detail-sources">
            <span>Information from</span>
            {profile.wikipediaUrl && <button onClick={() => onOpenSource(profile.wikipediaUrl!)} type="button">Wikipedia <ExternalLink /></button>}
            {profile.wikimediaCommonsUrl && <button onClick={() => onOpenSource(profile.wikimediaCommonsUrl!)} type="button">Wikimedia Commons <ExternalLink /></button>}
            {profile.musicBrainzUrl && <button onClick={() => onOpenSource(profile.musicBrainzUrl!)} type="button">MusicBrainz <ExternalLink /></button>}
            {profile.lastFmUrl && <button onClick={() => onOpenSource(profile.lastFmUrl!)} type="button">Last.fm <ExternalLink /></button>}
            {profile.theAudioDbUrl && <button onClick={() => onOpenSource(profile.theAudioDbUrl!)} type="button">TheAudioDB <ExternalLink /></button>}
            {profile.fanartUrl && <button onClick={() => onOpenSource(profile.fanartUrl!)} type="button">Fanart.tv <ExternalLink /></button>}
            {profile.imageProvider === "deezer" && profile.imageSourceUrl && <button onClick={() => onOpenSource(profile.imageSourceUrl!)} type="button">Deezer <ExternalLink /></button>}
            {profile.imageProvider === "brave-search" && profile.imageSourceUrl && <button onClick={() => onOpenSource(profile.imageSourceUrl!)} type="button">Brave Image Search <ExternalLink /></button>}
            {profile.cacheState === "stale" && <em>cached copy</em>}
          </div>
        )}
      </div>
    </section>
  );
};
