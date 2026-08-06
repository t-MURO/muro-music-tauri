import { useCallback, useSyncExternalStore } from "react";
import { commandManager, type HistoryState } from "../command-manager/commandManager";
import { notify } from "../stores";
import { t } from "../i18n";

const EMPTY_STATE: HistoryState = { canUndo: false, canRedo: false, isBusy: false };

// useSyncExternalStore compares snapshots by identity, so the manager's state
// object is cached and only replaced when the history actually changes.
let snapshot: HistoryState = commandManager.state;
commandManager.subscribe((state) => {
  snapshot = state;
});

const subscribe = (listener: () => void) => commandManager.subscribe(listener);
const getSnapshot = () => snapshot;
const getServerSnapshot = () => EMPTY_STATE;

/**
 * Reactive view of the undo stack plus the handlers the shortcut layer and the
 * edit menu both call. Undo is silent today; a toast makes it clear that a
 * destructive batch (a rejected inbox import, a playlist delete) came back.
 */
export const useCommandHistory = () => {
  const history = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const undo = useCallback(async () => {
    try {
      const outcome = await commandManager.undo();
      if (outcome) notify.info(outcome);
    } catch (error) {
      notify.error(error instanceof Error ? error.message : t("history.undoFailed"));
    }
  }, []);

  const redo = useCallback(async () => {
    try {
      const outcome = await commandManager.redo();
      if (outcome) notify.info(outcome);
    } catch (error) {
      notify.error(error instanceof Error ? error.message : t("history.redoFailed"));
    }
  }, []);

  return { ...history, undo, redo };
};
