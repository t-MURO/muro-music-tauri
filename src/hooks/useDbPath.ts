import { useCallback } from "react";
import { appDataDir, join } from "@muro/desktop/paths";
import { useSettingsStore } from "../stores";

export const useDbPath = () => {
  const dbPath = useSettingsStore((s) => s.dbPath);
  const dbFileName = useSettingsStore((s) => s.dbFileName);

  return useCallback(async () => {
    const trimmed = dbPath.trim();
    return trimmed || join(await appDataDir(), dbFileName || "muro.db");
  }, [dbPath, dbFileName]);
};
