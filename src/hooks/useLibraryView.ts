import { useMemo } from "react";
import { t } from "../i18n";
import { filterTracksBySmartCrate } from "../utils/smartCrates";
import { toCamelotCode } from "../utils/camelot";
import { trackHasArtist } from "../utils/artistCredits";
import { useLocaleVersion } from "./useLocaleVersion";
import type { Playlist, SmartCrate, Track } from "../types";
import { useSettingsStore } from "../stores";

export type CollectionFacet = "genres" | "artists" | "albums" | "labels" | "keys" | "bpm" | "formats";
export type LibraryView =
  | "library"
  | "inbox"
  | "settings"
  | "recentlyPlayed"
  | "recentlyAdded"
  | "statistics"
  | `playlist:${string}`
  | `smartCrate:${string}`
  | `collection:${CollectionFacet}`;

export type ViewType = "library" | "inbox" | "settings" | "playlist" | "smartCrate" | "recentlyPlayed" | "recentlyAdded" | "statistics" | "collection";

export type EmptyStateConfig = {
  title: string;
  description: string;
  primaryAction?: {
    label: string;
  };
  secondaryAction?: {
    label: string;
  };
};

export type TrackTableConfig = {
  tracks: Track[];
  emptyState: EmptyStateConfig;
  showImportActions: boolean;
  banner?: "inbox";
};

export type ViewConfig = {
  type: ViewType;
  title: string;
  subtitle: string;
  playlist: Playlist | null;
  trackTable: TrackTableConfig | null;
};

const parsePlaylistId = (view: LibraryView): string | null => {
  if (view.startsWith("playlist:")) {
    return view.slice("playlist:".length);
  }
  return null;
};

const parseCollectionFacet = (view: LibraryView): CollectionFacet | null =>
  view.startsWith("collection:") ? view.slice("collection:".length) as CollectionFacet : null;

const parseSmartCrateId = (view: LibraryView): string | null =>
  view.startsWith("smartCrate:") ? view.slice("smartCrate:".length) : null;

type UseViewConfigArgs = {
  view: LibraryView;
  playlists: Playlist[];
  libraryTracks: Track[];
  inboxTracks: Track[];
  recentlyPlayedTracks: Track[];
  smartCrates: SmartCrate[];
  collectionFilterValue?: string | null;
  collectionFilterArtistId?: string | null;
};

export const useViewConfig = ({
  view,
  playlists,
  libraryTracks,
  inboxTracks,
  recentlyPlayedTracks,
  smartCrates,
  collectionFilterValue,
  collectionFilterArtistId,
}: UseViewConfigArgs): ViewConfig => {
  // Titles and empty states are translated inside the memo, so the language
  // has to invalidate it.
  const localeVersion = useLocaleVersion();
  const recentlyAddedPeriodDays = useSettingsStore(
    (state) => state.recentlyAddedPeriodDays,
  );

  return useMemo(() => {
    const playlistId = parsePlaylistId(view);
    const smartCrateId = parseSmartCrateId(view);
    const collectionFacet = parseCollectionFacet(view);
    const playlist = playlistId
      ? playlists.find((p) => p.id === playlistId) ?? null
      : null;

    // Settings view
    if (view === "settings") {
      return {
        type: "settings",
        title: t("header.settings"),
        subtitle: t("header.settings.subtitle"),
        playlist: null,
        trackTable: null,
      };
    }

    if (view === "statistics") {
      return {
        type: "statistics",
        title: t("header.statistics"),
        subtitle: t("header.statistics.subtitle"),
        playlist: null,
        trackTable: null,
      };
    }

    // Library view
    if (view === "library") {
      return {
        type: "library",
        title: t("header.library"),
        subtitle: t("header.library.subtitle"),
        playlist: null,
        trackTable: {
          tracks: libraryTracks,
          emptyState: {
            title: t("library.empty.title"),
            description: t("library.empty.description"),
            primaryAction: { label: t("import.files") },
            secondaryAction: { label: t("import.folder") },
          },
          showImportActions: true,
        },
      };
    }

    // Inbox view
    if (view === "inbox") {
      return {
        type: "inbox",
        title: t("header.inbox"),
        subtitle: t("header.inbox.subtitle"),
        playlist: null,
        trackTable: {
          tracks: inboxTracks,
          emptyState: {
            title: t("inbox.empty.title"),
            description: t("inbox.empty.description"),
            primaryAction: { label: t("import.files") },
            secondaryAction: { label: t("import.folder") },
          },
          showImportActions: true,
          banner: "inbox",
        },
      };
    }

    // Recently Played view
    if (view === "recentlyPlayed") {
      return {
        type: "recentlyPlayed",
        title: t("header.recentlyPlayed"),
        subtitle: t("header.recentlyPlayed.subtitle"),
        playlist: null,
        trackTable: {
          tracks: recentlyPlayedTracks,
          emptyState: {
            title: t("recentlyPlayed.empty.title"),
            description: t("recentlyPlayed.empty.description"),
          },
          showImportActions: false,
        },
      };
    }

    if (view === "recentlyAdded") {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - (recentlyAddedPeriodDays - 1));
      const recentlyAddedTracks = libraryTracks.filter((track) => {
        const added = track.dateAdded ? Date.parse(track.dateAdded) : NaN;
        return Number.isFinite(added) && added >= start.getTime();
      }).sort((left, right) => {
        const parsedLeft = left.dateAdded ? Date.parse(left.dateAdded) : 0;
        const parsedRight = right.dateAdded ? Date.parse(right.dateAdded) : 0;
        const leftAdded = Number.isFinite(parsedLeft) ? parsedLeft : 0;
        const rightAdded = Number.isFinite(parsedRight) ? parsedRight : 0;
        return rightAdded - leftAdded;
      });
      return {
        type: "recentlyAdded",
        title: t("header.recentlyAdded"),
        subtitle: t("header.recentlyAdded.subtitle", {
          count: recentlyAddedTracks.length.toLocaleString(),
        }),
        playlist: null,
        trackTable: {
          tracks: recentlyAddedTracks,
          emptyState: {
            title: t("recentlyAdded.empty.title"),
            description: t("recentlyAdded.empty.description"),
          },
          showImportActions: false,
        },
      };
    }

    if (smartCrateId) {
      const smartCrate = smartCrates.find((crate) => crate.id === smartCrateId) ?? null;
      if (!smartCrate) {
        return {
          type: "smartCrate",
          title: t("smartCrate.notFound.title"),
          subtitle: "",
          playlist: null,
          trackTable: {
            tracks: [],
            emptyState: {
              title: t("smartCrate.notFound.title"),
              description: t("smartCrate.notFound.description"),
            },
            showImportActions: false,
          },
        };
      }

      const crateTracks = filterTracksBySmartCrate(libraryTracks, smartCrate);
      return {
        type: "smartCrate",
        title: smartCrate.name,
        subtitle: t("smartCrate.subtitle", {
          count: crateTracks.length.toLocaleString(),
          rules: String(smartCrate.rules.length),
          ruleLabel: smartCrate.rules.length === 1 ? t("smartCrate.rule") : t("smartCrate.rules"),
        }),
        playlist: null,
        trackTable: {
          tracks: crateTracks,
          emptyState: {
            title: t("smartCrate.empty.title"),
            description: t("smartCrate.empty.description"),
          },
          showImportActions: false,
        },
      };
    }

    if (collectionFacet) {
      const labels: Record<CollectionFacet, string> = {
        genres: t("collection.genres"),
        artists: t("collection.artists"),
        albums: t("collection.albums"),
        labels: t("collection.labels"),
        keys: t("collection.keys"),
        bpm: t("collection.bpm"),
        formats: t("collection.formats"),
      };
      const normalizedFilter = collectionFilterValue?.trim().toLocaleLowerCase() ?? "";
      const collectionTracks = libraryTracks.filter((track) => {
        if (collectionFacet === "artists") {
          if (!collectionFilterArtistId && !normalizedFilter) {
            return trackHasArtist(track, {});
          }
          return trackHasArtist(track, {
            artistId: collectionFilterArtistId,
            name: collectionFilterValue,
          });
        }

        let value = "";
        if (collectionFacet === "genres") value = track.genre ?? "";
        else if (collectionFacet === "albums") value = track.album;
        else if (collectionFacet === "labels") value = track.label ?? "";
        else if (collectionFacet === "keys") value = track.key ?? "";
        else if (collectionFacet === "bpm") value = track.bpm == null ? "" : String(Math.round(track.bpm));
        else value = track.sourcePath.split(".").pop()?.toUpperCase() ?? "";

        if (!value.trim()) return false;
        if (!normalizedFilter) return true;
        if (collectionFacet === "keys") {
          const filterCode = toCamelotCode(collectionFilterValue ?? "");
          const trackCode = toCamelotCode(value);
          return filterCode && trackCode
            ? filterCode === trackCode
            : value.toLocaleLowerCase() === normalizedFilter;
        }
        return value.toLocaleLowerCase() === normalizedFilter;
      });
      const collectionTitle = labels[collectionFacet];
      const title = collectionFilterValue?.trim() || collectionTitle;
      const count = collectionTracks.length.toLocaleString();
      return {
        type: "collection",
        title,
        subtitle: normalizedFilter
          ? t("collection.subtitle.filtered", { count, facet: collectionTitle })
          : t("collection.subtitle", { count, facet: collectionTitle.toLowerCase() }),
        playlist: null,
        trackTable: {
          tracks: collectionTracks,
          emptyState: {
            title: normalizedFilter
              ? t("collection.empty.filtered", { value: title })
              : t("collection.empty.title", { facet: collectionTitle.toLowerCase() }),
            description: t("collection.empty.description"),
          },
          showImportActions: false,
        },
      };
    }

    // Playlist view
    if (playlist) {
      const trackMap = new Map(
        [...libraryTracks, ...inboxTracks].map((track) => [track.id, track])
      );
      const playlistTracks = playlist.trackIds
        .map((id) => trackMap.get(id))
        .filter((track): track is Track => track !== undefined);

      return {
        type: "playlist",
        title: playlist.name,
        subtitle: t("header.playlist.subtitle", {
          count: String(playlist.trackIds.length),
        }),
        playlist,
        trackTable: {
          tracks: playlistTracks,
          emptyState: {
            title: t("playlist.empty.title"),
            description: t("playlist.empty.description"),
          },
          showImportActions: false,
        },
      };
    }

    // Playlist not found fallback
    return {
      type: "playlist",
      title: t("header.playlist.notFound"),
      subtitle: "",
      playlist: null,
      trackTable: {
        tracks: [],
        emptyState: {
          title: t("header.playlist.notFound"),
          description: "",
        },
        showImportActions: false,
      },
    };
  }, [
    collectionFilterArtistId,
    collectionFilterValue,
    inboxTracks,
    libraryTracks,
    localeVersion,
    recentlyAddedPeriodDays,
    playlists,
    recentlyPlayedTracks,
    smartCrates,
    view,
  ]);
};
