import { useEffect, useRef } from "react";
import { invoke } from "@muro/desktop/runtime";
import {
  useLibraryStore,
  usePlaybackStore,
  useRecentlyPlayedStore,
  useSettingsStore,
} from "../stores";
import type { Track } from "../types";

const PLAY_THRESHOLD_SECONDS = 30;
const SYNC_INTERVAL_SECONDS = 10;

type UsePlayTrackingArgs = {
  currentPosition: number;
  allTracks: Track[];
};

type ActiveSession = {
  trackId: string | null;
  accumulated: number;
  lastPosition: number;
  lastSynced: number;
  historyId: number | null;
  recording: boolean;
};

export const usePlayTracking = ({
  currentPosition,
  allTracks,
}: UsePlayTrackingArgs) => {
  const currentTrack = usePlaybackStore((s) => s.currentTrack);
  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  const dbPath = useSettingsStore((s) => s.dbPath);
  const setTracks = useLibraryStore((s) => s.setTracks);
  const setInboxTracks = useLibraryStore((s) => s.setInboxTracks);
  const startPlaySession = useRecentlyPlayedStore((s) => s.startPlaySession);
  const markPlayRecorded = useRecentlyPlayedStore((s) => s.markPlayRecorded);
  const addRecentlyPlayed = useRecentlyPlayedStore((s) => s.addRecentlyPlayed);
  const sessionRef = useRef<ActiveSession>({
    trackId: null,
    accumulated: 0,
    lastPosition: 0,
    lastSynced: 0,
    historyId: null,
    recording: false,
  });
  const dbPathRef = useRef(dbPath);
  dbPathRef.current = dbPath;

  const flushSession = (session: ActiveSession) => {
    if (!session.historyId || session.accumulated <= session.lastSynced) return;
    session.lastSynced = session.accumulated;
    invoke("update_play_history", {
      dbPath: dbPathRef.current,
      historyId: session.historyId,
      listenedSeconds: session.accumulated,
    }).catch((error) => console.error("Failed to update listening history:", error));
  };

  useEffect(() => () => flushSession(sessionRef.current), []);

  useEffect(() => {
    const trackId = currentTrack?.id ?? null;
    const session = sessionRef.current;
    if (trackId !== session.trackId) {
      flushSession(session);
      sessionRef.current = {
        trackId,
        accumulated: 0,
        lastPosition: currentPosition,
        lastSynced: 0,
        historyId: null,
        recording: false,
      };
      if (trackId) startPlaySession(trackId);
      return;
    }
    session.lastPosition = currentPosition;
  }, [currentTrack?.id, startPlaySession]);

  useEffect(() => {
    const session = sessionRef.current;
    if (!currentTrack || currentTrack.id !== session.trackId) return;
    const delta = currentPosition - session.lastPosition;
    session.lastPosition = currentPosition;
    if (!isPlaying) return;
    if (delta > 0 && delta < 2) session.accumulated += delta;

    if (
      session.accumulated >= PLAY_THRESHOLD_SECONDS
      && !session.historyId
      && !session.recording
    ) {
      session.recording = true;
      markPlayRecorded();
      const track = allTracks.find((candidate) => candidate.id === currentTrack.id);
      if (track) {
        const playedAt = new Date().toISOString();
        const applyRecordedPlay = (candidate: Track): Track => candidate.id === track.id
          ? {
              ...candidate,
              lastPlayedAt: playedAt,
              playCount: (candidate.playCount || 0) + 1,
            }
          : candidate;
        addRecentlyPlayed(track, playedAt);
        setTracks((items) => items.map(applyRecordedPlay));
        setInboxTracks((items) => items.map(applyRecordedPlay));
      }
      invoke<{ historyId: number }>("record_track_play", {
        dbPath,
        trackId: currentTrack.id,
      }).then((result) => {
        session.historyId = result.historyId;
        session.lastSynced = PLAY_THRESHOLD_SECONDS;
        flushSession(session);
      }).catch((error) => {
        session.recording = false;
        console.error("Failed to record track play:", error);
      });
      return;
    }

    if (
      session.historyId
      && session.accumulated - session.lastSynced >= SYNC_INTERVAL_SECONDS
    ) flushSession(session);
  }, [
    addRecentlyPlayed,
    allTracks,
    currentPosition,
    currentTrack,
    dbPath,
    isPlaying,
    markPlayRecorded,
    setInboxTracks,
    setTracks,
  ]);
};
