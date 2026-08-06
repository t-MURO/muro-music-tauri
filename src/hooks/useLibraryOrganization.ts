import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { notify, useLibraryStore, useSettingsStore } from "../stores";
import {
  loadTracks,
  repairLibraryStructure,
  validateLibraryStructure,
  type LibraryStructureRepairResult,
  type LibraryStructureValidationResult,
} from "../utils/database";
import { importedTrackToTrack } from "../utils/importApi";
import { useDbPath } from "./useDbPath";

export type LibraryStructureRepairOutcome = {
  repair: LibraryStructureRepairResult;
  validation: LibraryStructureValidationResult;
};

export const useLibraryOrganization = () => {
  const libraryRoot = useSettingsStore((state) => state.watchedFolder);
  const artistSeparatorExceptions = useSettingsStore(
    (state) => state.artistSeparatorExceptions,
  );
  const setTracks = useLibraryStore((state) => state.setTracks);
  const setInboxTracks = useLibraryStore((state) => state.setInboxTracks);
  const resolveDbPath = useDbPath();
  const busyRef = useRef(false);
  const [validating, setValidating] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [lastResult, setLastResult] =
    useState<LibraryStructureValidationResult | null>(null);

  useEffect(() => {
    setLastResult(null);
  }, [libraryRoot]);

  const reloadLibrary = useCallback(async (dbPath: string) => {
    try {
      const snapshot = await loadTracks(
        dbPath,
        libraryRoot,
        artistSeparatorExceptions,
      );
      setTracks(snapshot.library.map(importedTrackToTrack));
      setInboxTracks(snapshot.inbox.map(importedTrackToTrack));
    } catch {
      // The next normal library refresh will pick up the repaired paths.
    }
  }, [artistSeparatorExceptions, libraryRoot, setInboxTracks, setTracks]);

  const validate = useCallback(async () => {
    if (!libraryRoot) {
      notify.info(t("structure.noRoot"));
      return null;
    }
    if (busyRef.current) return null;

    busyRef.current = true;
    setValidating(true);
    try {
      const dbPath = await resolveDbPath();
      const result = await validateLibraryStructure(dbPath, libraryRoot);
      setLastResult(result);
      if (result.misplaced.length === 0) {
        notify.success(t("structure.allCorrect", { checked: String(result.checked) }));
      } else {
        notify.info(t("structure.found", {
          misplaced: String(result.misplaced.length),
          checked: String(result.checked),
        }));
      }
      return result;
    } catch {
      notify.error(t("structure.failed"));
      return null;
    } finally {
      busyRef.current = false;
      setValidating(false);
    }
  }, [libraryRoot, resolveDbPath]);

  const repair = useCallback(async () => {
    const trackIds = lastResult?.misplaced.map((track) => track.trackId) ?? [];
    if (!libraryRoot || trackIds.length === 0 || busyRef.current) return null;

    busyRef.current = true;
    setRepairing(true);
    try {
      const dbPath = await resolveDbPath();
      const repairResult = await repairLibraryStructure(dbPath, libraryRoot, trackIds);
      await reloadLibrary(dbPath);
      const validation = await validateLibraryStructure(dbPath, libraryRoot);
      setLastResult(validation);

      if (repairResult.failures.length > 0) {
        notify.error(t("structure.repairPartial", {
          moved: String(repairResult.moved.length),
          failed: String(repairResult.failures.length),
        }));
      } else {
        notify.success(t("structure.repairDone", {
          moved: String(repairResult.moved.length),
        }));
      }
      return { repair: repairResult, validation } satisfies LibraryStructureRepairOutcome;
    } catch {
      notify.error(t("structure.repairFailed"));
      return null;
    } finally {
      busyRef.current = false;
      setRepairing(false);
    }
  }, [lastResult, libraryRoot, reloadLibrary, resolveDbPath]);

  return {
    hasLibraryRoot: Boolean(libraryRoot),
    validating,
    repairing,
    lastResult,
    validate,
    repair,
  };
};
