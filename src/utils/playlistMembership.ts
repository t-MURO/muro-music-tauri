import type { Playlist } from "../types";

export type TrackPlaylistMembership = Pick<Playlist, "id" | "name">;

export const buildPlaylistMembershipMap = (
  playlists: Playlist[],
): Map<string, TrackPlaylistMembership[]> => {
  const memberships = new Map<string, TrackPlaylistMembership[]>();

  for (const playlist of playlists) {
    for (const trackId of new Set(playlist.trackIds)) {
      const current = memberships.get(trackId);
      const membership = { id: playlist.id, name: playlist.name };
      if (current) current.push(membership);
      else memberships.set(trackId, [membership]);
    }
  }

  return memberships;
};

export const formatPlaylistMembership = (
  memberships: readonly TrackPlaylistMembership[] | undefined,
): string => memberships?.map((playlist) => playlist.name).join(", ") ?? "";
