import { appDataDir, join } from "@muro/desktop/paths";

const DEFAULT_DB_FILENAME = "muro.db";

/**
 * Resolves the full database path from the provided path and filename.
 * If dbPath is empty, uses the app data directory with the given filename.
 */
export const resolveDbPath = async (
  dbPath: string,
  dbFileName: string
): Promise<string> => {
  const trimmed = dbPath.trim();
  if (trimmed) {
    return trimmed;
  }
  const baseDir = await appDataDir();
  return join(baseDir, dbFileName || DEFAULT_DB_FILENAME);
};
