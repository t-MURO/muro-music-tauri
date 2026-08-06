import { useCallback } from "react";
import { invoke } from "@muro/desktop/runtime";
import { notify, useLibraryStore } from "../stores";
import { useDbPath } from "./useDbPath";

type MetadataWriteResult = {
  updated: number;
  filesWritten: number;
  fileWriteErrors: Array<{ trackId: string; fileName: string; message: string }>;
};

export const useTrackRatings = () => {
  const setTracks = useLibraryStore((s) => s.setTracks);
  const setInboxTracks = useLibraryStore((s) => s.setInboxTracks);
  const resolveDbPath = useDbPath();

  const clampRating = (value: number) =>
    Math.max(0, Math.min(5, Math.round(value * 2) / 2));

  const handleRatingChange = useCallback(
    (id: string, rating: number) => {
      const nextRating = clampRating(rating);
      setTracks((current) =>
        current.map((track) =>
          track.id === id ? { ...track, rating: nextRating } : track
        )
      );
      setInboxTracks((current) =>
        current.map((track) =>
          track.id === id ? { ...track, rating: nextRating } : track
        )
      );

      resolveDbPath()
        .then((dbPath) =>
          invoke<MetadataWriteResult>("update_track_metadata", {
            dbPath,
            trackIds: [id],
            updates: { rating: nextRating },
          })
        )
        .then((result) => {
          const failure = result.fileWriteErrors[0];
          if (failure) {
            notify.error(
              `Rating saved in Muro Music, but ${failure.fileName} could not store it in the audio file`,
            );
          }
        })
        .catch((err) => console.error("Failed to persist rating:", err));
    },
    [resolveDbPath, setInboxTracks, setTracks]
  );

  return { handleRatingChange };
};
