import { useCallback } from "react";
import { useLibraryStore, useUIStore } from "../stores";
import type { Track } from "../types";

export const useTrackAnalysis = () => {
  // Get state and actions from stores
  const setTracks = useLibraryStore((s) => s.setTracks);
  const setInboxTracks = useLibraryStore((s) => s.setInboxTracks);
  const analysisTrackIds = useUIStore((s) => s.analysisTrackIds);
  const isAnalysisModalMinimized = useUIStore((s) => s.isAnalysisModalMinimized);
  const openAnalysisModal = useUIStore((s) => s.openAnalysisModal);
  const closeAnalysisModal = useUIStore((s) => s.closeAnalysisModal);
  const minimizeAnalysisModal = useUIStore((s) => s.minimizeAnalysisModal);
  const restoreAnalysisModal = useUIStore((s) => s.restoreAnalysisModal);

  const handleAnalysisComplete = useCallback(
    (results: Map<string, { bpm: number; camelot: string }>) => {
      const updateTrackList = (trackList: Track[]): Track[] =>
        trackList.map((track) => {
          const result = results.get(track.id);
          if (result) {
            return {
              ...track,
              bpm: result.bpm > 0 ? result.bpm : track.bpm,
              key: result.camelot !== "?" ? result.camelot : track.key,
            };
          }
          return track;
        });

      setTracks(updateTrackList);
      setInboxTracks(updateTrackList);
    },
    [setTracks, setInboxTracks]
  );

  return {
    analysisTrackIds,
    isAnalysisModalOpen: analysisTrackIds.length > 0,
    isAnalysisModalMinimized,
    openAnalysisModal,
    closeAnalysisModal,
    minimizeAnalysisModal,
    restoreAnalysisModal,
    handleAnalysisComplete,
  };
};
