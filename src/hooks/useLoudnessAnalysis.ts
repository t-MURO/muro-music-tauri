import { useCallback, useRef, useState } from "react";
import { invoke } from "@muro/desktop/runtime";
import { analyzeAndStoreLoudness } from "../lib/loudness/service";
import { notify, useLibraryStore, useSettingsStore } from "../stores";
import { loadTracks, importedTrackToTrack } from "../utils";
import { t } from "../i18n";
import { useDbPath } from "./useDbPath";

type PendingTrack = { id: string; source_path: string };

export type LoudnessScanState = {
  running: boolean;
  analyzed: number;
  total: number;
  failed: number;
};

const IDLE_STATE: LoudnessScanState = {
  running: false,
  analyzed: 0,
  total: 0,
  failed: 0,
};

/**
 * Measures loudness for library tracks that have no ReplayGain value yet.
 *
 * Decoding happens in the renderer (the same route beat-grid analysis takes),
 * one track at a time, so a long scan does not compete with playback for
 * memory. Tracks that already carried ReplayGain tags are skipped by the
 * backend query.
 */
export const useLoudnessAnalysis = () => {
  const [state, setState] = useState<LoudnessScanState>(IDLE_STATE);
  const cancelRef = useRef(false);
  const resolveDbPath = useDbPath();
  const setTracks = useLibraryStore((s) => s.setTracks);
  const setInboxTracks = useLibraryStore((s) => s.setInboxTracks);
  const artistSeparatorExceptions = useSettingsStore(
    (settings) => settings.artistSeparatorExceptions,
  );

  const cancel = useCallback(() => {
    cancelRef.current = true;
  }, []);

  const run = useCallback(async () => {
    if (cancelRef.current) cancelRef.current = false;

    const referenceLufs = useSettingsStore.getState().replayGainReferenceLufs;
    let dbPath: string;
    try {
      dbPath = await resolveDbPath();
    } catch {
      notify.error(t("loudness.scan.failed"));
      return;
    }

    let pending: PendingTrack[];
    try {
      pending = await invoke<PendingTrack[]>("list_tracks_needing_loudness", {
        dbPath,
        limit: 2000,
      });
    } catch {
      notify.error(t("loudness.scan.failed"));
      return;
    }

    if (pending.length === 0) {
      notify.info(t("loudness.scan.upToDate"));
      return;
    }

    setState({ running: true, analyzed: 0, total: pending.length, failed: 0 });

    let analyzed = 0;
    let failed = 0;
    for (const track of pending) {
      if (cancelRef.current) break;
      try {
        await analyzeAndStoreLoudness(
          { id: track.id, sourcePath: track.source_path },
          dbPath,
          referenceLufs
        );
        analyzed += 1;
      } catch {
        // A single undecodable file must not end the scan.
        failed += 1;
      }
      setState({ running: true, analyzed, total: pending.length, failed });
    }

    // Album gain needs every track on a release, so it is derived once at the
    // end rather than after each file.
    if (analyzed > 0) {
      try {
        await invoke("recompute_album_gain", { dbPath, referenceLufs });
      } catch {
        // Track gain is still usable without it.
      }
      try {
        const snapshot = await loadTracks(
          dbPath,
          undefined,
          artistSeparatorExceptions,
        );
        setTracks(snapshot.library.map(importedTrackToTrack));
        setInboxTracks(snapshot.inbox.map(importedTrackToTrack));
      } catch {
        // The next library load picks the new values up.
      }
    }

    setState({ running: false, analyzed, total: pending.length, failed });
    cancelRef.current = false;

    if (failed > 0) {
      notify.info(
        t("loudness.scan.finishedWithFailures", {
          analyzed: String(analyzed),
          failed: String(failed),
        })
      );
    } else {
      notify.success(t("loudness.scan.finished", { analyzed: String(analyzed) }));
    }
  }, [artistSeparatorExceptions, resolveDbPath, setInboxTracks, setTracks]);

  return { ...state, run, cancel };
};
