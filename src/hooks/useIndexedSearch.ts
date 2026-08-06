import { useEffect, useRef, useState } from "react";
import { invoke } from "@muro/desktop/runtime";
import { useDbPath } from "./useDbPath";

const DEBOUNCE_MS = 120;

/**
 * Resolves a search query through the SQLite full-text index instead of
 * re-normalizing every track's text on each keystroke.
 *
 * Returns the matching ids as a Set, or null while no query is active or the
 * index has not answered yet — callers treat null as "do not filter" and can
 * fall back to their in-memory matcher.
 */
export const useIndexedSearch = (query: string) => {
  const [matchedIds, setMatchedIds] = useState<Set<string> | null>(null);
  const [pending, setPending] = useState(false);
  const resolveDbPath = useDbPath();
  // Late responses from a stale query must not overwrite a newer result.
  const requestIdRef = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      requestIdRef.current += 1;
      setMatchedIds(null);
      setPending(false);
      return;
    }

    const requestId = ++requestIdRef.current;
    setPending(true);

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const dbPath = await resolveDbPath();
          const ids = await invoke<string[] | null>("search_tracks", {
            dbPath,
            query: trimmed,
          });
          if (requestIdRef.current !== requestId) return;
          // null means the index had no opinion (no searchable terms, or an
          // expression it could not evaluate); fall back to the local matcher
          // rather than showing an empty library.
          setMatchedIds(ids === null ? null : new Set(ids));
        } catch {
          // Leave the previous answer in place; the in-memory matcher covers
          // the query until the index responds again.
          if (requestIdRef.current === requestId) setMatchedIds(null);
        } finally {
          if (requestIdRef.current === requestId) setPending(false);
        }
      })();
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query, resolveDbPath]);

  return { matchedIds, pending };
};
