import { convertFileSrc } from "@muro/desktop/runtime";
import {
  ArrowLeft,
  Clock3,
  Disc3,
  Grid2X2,
  List,
  ListEnd,
  Music2,
  Pause,
  Play,
  Plus,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Album } from "../../utils/albums";
import { filterAlbumsBySearch } from "../../utils/albums";

type AlbumSort = "title" | "artist" | "year" | "recent";
type AlbumLayout = "grid" | "list";

type AlbumsViewProps = {
  albums: Album[];
  searchQuery: string;
  selectedAlbumId: string | null;
  currentTrackId: string | null;
  isPlaying: boolean;
  onSelectAlbum: (albumId: string | null) => void;
  onPlayTrack: (trackId: string) => void;
  onPlayAlbum: (trackIds: string[]) => void;
  onTogglePlay: () => void;
  onPlayNext: (trackIds: string[]) => void;
  onAddToQueue: (trackIds: string[]) => void;
  onOpenArtist: (artist: string) => void;
  onOpenGenre: (genre: string) => void;
  onTracksContextMenu: (event: React.MouseEvent, trackIds: string[]) => void;
  onImportFiles: () => void;
  onImportFolder: () => void;
  revealRequest?: { trackId: string; requestId: number } | null;
  onRevealHandled: (requestId: number) => void;
};

const formatDuration = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0 min";
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours} hr ${minutes} min` : `${minutes} min`;
};

const formatTrackDuration = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return "--:--";
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
};

const getArtworkStyle = (album: Album) => {
  let hash = 0;
  for (const char of album.id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  return {
    background: `linear-gradient(145deg, hsl(${hue} 42% 30%), hsl(${(hue + 42) % 360} 34% 13%))`,
  };
};

const AlbumArtwork = ({ album, className = "" }: { album: Album; className?: string }) => {
  const path = album.coverArtPath || album.coverArtThumbPath;
  return (
    <div className={`album-artwork ${className}`} style={path ? undefined : getArtworkStyle(album)}>
      {path ? (
        <img src={convertFileSrc(path)} alt={`${album.title} cover`} />
      ) : (
        <Disc3 aria-hidden="true" />
      )}
    </div>
  );
};

const AlbumCard = ({
  album,
  layout,
  isCurrentAlbum,
  isPlaying,
  onOpen,
  onPlay,
  onContextMenu,
}: {
  album: Album;
  layout: AlbumLayout;
  isCurrentAlbum: boolean;
  isPlaying: boolean;
  onOpen: () => void;
  onPlay: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
}) => {
  const subtitle = [album.artist, album.year].filter(Boolean).join(" · ");
  return (
    <article
      className={`album-card album-card--${layout}${isCurrentAlbum ? " album-card--current" : ""}`}
      onContextMenu={onContextMenu}
      data-album-card={album.id}
      data-album-context-target={album.id}
    >
      <div className="album-card-artwork-wrap">
        <button className="album-card-open" onClick={onOpen} type="button" aria-label={`Open ${album.title}`}>
          <AlbumArtwork album={album} />
        </button>
        <button
          className="album-card-play"
          onClick={onPlay}
          type="button"
          aria-label={`${isCurrentAlbum && isPlaying ? "Pause" : "Play"} ${album.title}`}
        >
          {isCurrentAlbum && isPlaying ? <Pause /> : <Play fill="currentColor" />}
        </button>
      </div>
      <button className="album-card-copy" onClick={onOpen} type="button">
        <strong>{album.title}</strong>
        <span>{subtitle || "Unknown artist"}</span>
        {layout === "list" && (
          <span className="album-card-stats">
            {album.tracks.length} {album.tracks.length === 1 ? "track" : "tracks"} · {formatDuration(album.durationSeconds)}
          </span>
        )}
      </button>
    </article>
  );
};

const AlbumDetail = ({
  album,
  currentTrackId,
  isPlaying,
  onBack,
  onPlayTrack,
  onPlayAlbum,
  onTogglePlay,
  onPlayNext,
  onAddToQueue,
  onOpenArtist,
  onOpenGenre,
  onTracksContextMenu,
  revealRequest,
  onRevealHandled,
}: {
  album: Album;
  currentTrackId: string | null;
  isPlaying: boolean;
  onBack: () => void;
  onPlayTrack: (trackId: string) => void;
  onPlayAlbum: (trackIds: string[]) => void;
  onTogglePlay: () => void;
  onPlayNext: (trackIds: string[]) => void;
  onAddToQueue: (trackIds: string[]) => void;
  onOpenArtist: (artist: string) => void;
  onOpenGenre: (genre: string) => void;
  onTracksContextMenu: (event: React.MouseEvent, trackIds: string[]) => void;
  revealRequest?: { trackId: string; requestId: number } | null;
  onRevealHandled: (requestId: number) => void;
}) => {
  const handledRevealRequestIdRef = useRef<number | null>(null);
  const trackIds = album.tracks.map((track) => track.id);
  const currentAlbumIsActive = album.tracks.some((track) => track.id === currentTrackId);
  const currentAlbumIsPlaying = isPlaying && currentAlbumIsActive;
  let previousDisc: number | undefined;

  useEffect(() => {
    if (!revealRequest || !album.tracks.some((track) => track.id === revealRequest.trackId)) return;
    if (handledRevealRequestIdRef.current === revealRequest.requestId) return;
    // Run synchronously: rAF callbacks can starve indefinitely while the
    // window is hidden or occluded, so the reveal must not wait on a frame.
    const row = Array.from(document.querySelectorAll<HTMLElement>("[data-album-track]"))
      .find((element) => element.dataset.albumTrack === revealRequest.trackId);
    if (!row) return;
    handledRevealRequestIdRef.current = revealRequest.requestId;
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    row.focus({ preventScroll: true });
    onRevealHandled(revealRequest.requestId);
  }, [album.tracks, onRevealHandled, revealRequest]);

  return (
    <div className="album-detail" data-album-detail={album.id}>
      <div
        className="album-detail-hero"
        onContextMenu={(event) => onTracksContextMenu(event, trackIds)}
        data-album-context-target={album.id}
      >
        <button className="album-back-button" onClick={onBack} type="button">
          <ArrowLeft />
          <span>All albums</span>
        </button>
        <div className="album-detail-hero-content">
          <AlbumArtwork album={album} className="album-detail-artwork" />
          <div className="album-detail-copy">
            <span className="album-eyebrow">Album</span>
            <h1>{album.title}</h1>
            <button className="album-detail-link album-detail-artist" onClick={() => onOpenArtist(album.artist)} data-album-artist type="button">{album.artist}</button>
            <p className="album-detail-meta">
              {album.year && <span>{album.year}</span>}
              <span>{album.tracks.length} {album.tracks.length === 1 ? "track" : "tracks"}</span>
              <span>{formatDuration(album.durationSeconds)}</span>
              {album.genres[0] && <button className="album-detail-link" onClick={() => onOpenGenre(album.genres[0])} data-album-genre type="button">{album.genres[0]}</button>}
            </p>
            <div className="album-detail-actions">
              <button className="album-primary-action" onClick={() => currentAlbumIsActive ? onTogglePlay() : onPlayAlbum(trackIds)} type="button">
                {currentAlbumIsPlaying ? <Pause /> : <Play fill="currentColor" />}
                <span>{currentAlbumIsPlaying ? "Pause" : "Play"}</span>
              </button>
              <button className="album-secondary-action" onClick={() => onPlayNext(trackIds)} type="button">
                <ListEnd />
                <span>Play next</span>
              </button>
              <button className="album-secondary-action" onClick={() => onAddToQueue(trackIds)} type="button">
                <Plus />
                <span>Queue</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="album-track-list" role="table" aria-label={`${album.title} tracks`}>
        <div className="album-track-header" role="row">
          <span>#</span><span>Title</span><span>Key</span><span>BPM</span><Clock3 />
        </div>
        {album.tracks.map((track, index) => {
          const disc = track.discNumber ?? 1;
          const showDisc = album.tracks.some((item) => (item.discNumber ?? 1) > 1) && disc !== previousDisc;
          previousDisc = disc;
          const isCurrent = track.id === currentTrackId;
          return (
            <div key={track.id}>
              {showDisc && <div className="album-disc-divider">Disc {disc}</div>}
              <button
                className={`album-track-row${isCurrent ? " album-track-row--current" : ""}`}
                onClick={() => onPlayTrack(track.id)}
                onContextMenu={(event) => onTracksContextMenu(event, [track.id])}
                type="button"
                role="row"
                data-album-track={track.id}
              >
                <span className="album-track-number">
                  <span>{isCurrent && isPlaying ? <Pause fill="currentColor" /> : track.trackNumber ?? index + 1}</span>
                  <Play className="album-track-play" fill="currentColor" />
                </span>
                <span className="album-track-title">
                  <strong>{track.title}</strong>
                  {track.artist !== album.artist && <small>{track.artist}</small>}
                </span>
                <span className="album-track-key">{track.key || "—"}</span>
                <span className="album-track-bpm">{track.bpm ? Math.round(track.bpm) : "—"}</span>
                <span className="album-track-duration">{formatTrackDuration(track.durationSeconds)}</span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const AlbumsView = ({
  albums,
  searchQuery,
  selectedAlbumId,
  currentTrackId,
  isPlaying,
  onSelectAlbum,
  onPlayTrack,
  onPlayAlbum,
  onTogglePlay,
  onPlayNext,
  onAddToQueue,
  onOpenArtist,
  onOpenGenre,
  onTracksContextMenu,
  onImportFiles,
  onImportFolder,
  revealRequest,
  onRevealHandled,
}: AlbumsViewProps) => {
  const [sort, setSort] = useState<AlbumSort>("title");
  const [layout, setLayout] = useState<AlbumLayout>(() =>
    window.localStorage.getItem("muro-album-layout") === "list" ? "list" : "grid"
  );

  useEffect(() => {
    window.localStorage.setItem("muro-album-layout", layout);
  }, [layout]);

  const visibleAlbums = useMemo(() => {
    const filtered = [...filterAlbumsBySearch(albums, searchQuery)];
    filtered.sort((left, right) => {
      if (sort === "artist") {
        return left.artist.localeCompare(right.artist, undefined, { sensitivity: "base" });
      }
      if (sort === "year") {
        return (right.year ?? -1) - (left.year ?? -1) || left.title.localeCompare(right.title);
      }
      if (sort === "recent") {
        return (right.dateAdded ?? "").localeCompare(left.dateAdded ?? "") || left.title.localeCompare(right.title);
      }
      return left.title.localeCompare(right.title, undefined, { numeric: true, sensitivity: "base" });
    });
    return filtered;
  }, [albums, searchQuery, sort]);

  const selectedAlbum = albums.find((album) => album.id === selectedAlbumId);
  const currentAlbumId = albums.find((album) =>
    album.tracks.some((track) => track.id === currentTrackId)
  )?.id;

  if (selectedAlbum) {
    return (
      <AlbumDetail
        album={selectedAlbum}
        currentTrackId={currentTrackId}
        isPlaying={isPlaying}
        onBack={() => onSelectAlbum(null)}
        onPlayTrack={onPlayTrack}
        onPlayAlbum={onPlayAlbum}
        onTogglePlay={onTogglePlay}
        onPlayNext={onPlayNext}
        onAddToQueue={onAddToQueue}
        onOpenArtist={onOpenArtist}
        onOpenGenre={onOpenGenre}
        onTracksContextMenu={onTracksContextMenu}
        revealRequest={revealRequest}
        onRevealHandled={onRevealHandled}
      />
    );
  }

  if (albums.length === 0) {
    return (
      <div className="album-empty-state" data-albums-view>
        <div className="album-empty-icon"><Music2 /></div>
        <h2>Your albums will live here</h2>
        <p>Import music with album metadata and Muro will organize it into a visual collection.</p>
        <div>
          <button className="album-primary-action" onClick={onImportFiles} type="button"><Plus /><span>Add music</span></button>
          <button className="album-secondary-action" onClick={onImportFolder} type="button">Add folder</button>
        </div>
      </div>
    );
  }

  return (
    <div className="albums-view" data-albums-view>
      <div className="albums-toolbar">
        <div>
          <strong>{searchQuery ? `${visibleAlbums.length} matching albums` : "Browse your collection"}</strong>
          <span>Albums are grouped by title and album artist</span>
        </div>
        <div className="albums-toolbar-actions">
          <label>
            <span className="sr-only">Sort albums</span>
            <select value={sort} onChange={(event) => setSort(event.target.value as AlbumSort)} data-album-sort>
              <option value="title">Title</option>
              <option value="artist">Artist</option>
              <option value="year">Newest year</option>
              <option value="recent">Recently added</option>
            </select>
          </label>
          <div className="album-layout-toggle" aria-label="Album layout">
            <button className={layout === "grid" ? "is-active" : ""} onClick={() => setLayout("grid")} aria-label="Grid view" aria-pressed={layout === "grid"} type="button"><Grid2X2 /></button>
            <button className={layout === "list" ? "is-active" : ""} onClick={() => setLayout("list")} aria-label="List view" aria-pressed={layout === "list"} type="button"><List /></button>
          </div>
        </div>
      </div>

      {visibleAlbums.length > 0 ? (
        <div className={`album-collection album-collection--${layout}`}>
          {visibleAlbums.map((album) => (
            <AlbumCard
              key={album.id}
              album={album}
              layout={layout}
              isCurrentAlbum={album.id === currentAlbumId}
              isPlaying={isPlaying}
              onOpen={() => onSelectAlbum(album.id)}
              onPlay={() => {
                if (album.id === currentAlbumId) onTogglePlay();
                else onPlayAlbum(album.tracks.map((track) => track.id));
              }}
              onContextMenu={(event) => onTracksContextMenu(
                event,
                album.tracks.map((track) => track.id),
              )}
            />
          ))}
        </div>
      ) : (
        <div className="album-search-empty">
          <Music2 />
          <h2>No albums found</h2>
          <p>Try another title, artist, year, genre, or track name.</p>
        </div>
      )}
    </div>
  );
};
