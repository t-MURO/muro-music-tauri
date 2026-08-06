import type { LibraryView } from "../hooks/useLibraryView";

/**
 * Maps a LibraryView to its corresponding URL path.
 */
export const getPathForView = (view: LibraryView): string => {
  if (view === "inbox") return "/inbox";
  if (view === "settings") return "/settings";
  if (view === "recentlyPlayed") return "/recently-played";
  if (view === "recentlyAdded") return "/recently-added";
  if (view === "statistics") return "/statistics";
  if (view.startsWith("collection:"))
    return `/collection/${view.slice("collection:".length)}`;
  if (view.startsWith("playlist:"))
    return `/playlists/${view.slice("playlist:".length)}`;
  if (view.startsWith("smartCrate:"))
    return `/smart-crates/${view.slice("smartCrate:".length)}`;
  return "/";
};
