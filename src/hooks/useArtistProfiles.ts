import { useCallback, useEffect, useState } from "react";
import type { ArtistImageCandidate, ArtistProfile } from "../types";
import {
  artistIdentityKey,
  type ArtistTarget,
} from "../utils/artistCredits";
import {
  getArtistProfile,
  loadCachedArtistProfiles,
  scanArtistProfiles,
  searchArtistImages,
  setArtistImage,
} from "../utils";
import { useSettingsStore } from "../stores";
import { useDbPath } from "./useDbPath";

const INITIAL_SCAN_DELAY_MS = 5_000;
const CONTINUE_SCAN_DELAY_MS = 60_000;
const PERIODIC_SCAN_DELAY_MS = 30 * 60_000;
const SCAN_BATCH_SIZE = 25;

export const normalizeArtistProfileKey = (artistName: string) => artistName
  .normalize("NFKC")
  .trim()
  .replace(/\s+/g, " ")
  .toLocaleLowerCase();

export const useArtistProfiles = () => {
  const resolveDbPath = useDbPath();
  const lastFmApiKey = useSettingsStore((state) => state.lastFmApiKey);
  const theAudioDbApiKey = useSettingsStore((state) => state.theAudioDbApiKey);
  const fanartApiKey = useSettingsStore((state) => state.fanartApiKey);
  const braveSearchApiKey = useSettingsStore((state) => state.braveSearchApiKey);
  const [profiles, setProfiles] = useState<Record<string, ArtistProfile>>({});
  const [loadingKeys, setLoadingKeys] = useState<Set<string>>(() => new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const dbPath = await resolveDbPath();
        const cached = await loadCachedArtistProfiles(dbPath);
        if (cancelled) return;
        setProfiles(Object.fromEntries(cached.map((profile) => [profile.artistKey, profile])));
      } catch {
        // Cached profiles are optional; artist pages still work through on-demand lookup.
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [resolveDbPath]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (delayMs: number) => {
      if (!cancelled) timer = setTimeout(run, delayMs);
    };
    const run = async () => {
      try {
        const dbPath = await resolveDbPath();
        const result = await scanArtistProfiles(
          dbPath,
          { fanartApiKey, lastFmApiKey, theAudioDbApiKey },
          SCAN_BATCH_SIZE,
        );
        if (cancelled) return;
        const cached = await loadCachedArtistProfiles(dbPath);
        if (cancelled) return;
        setProfiles(Object.fromEntries(cached.map((profile) => [profile.artistKey, profile])));
        schedule(result.queued > 0
          ? CONTINUE_SCAN_DELAY_MS
          : PERIODIC_SCAN_DELAY_MS);
      } catch {
        schedule(PERIODIC_SCAN_DELAY_MS);
      }
    };
    schedule(INITIAL_SCAN_DELAY_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [fanartApiKey, lastFmApiKey, resolveDbPath, theAudioDbApiKey]);

  const loadProfile = useCallback(async (
    artistName: string,
    force = false,
    identity?: ArtistTarget,
  ) => {
    const artistKey = identity
      ? artistIdentityKey(identity)
      : normalizeArtistProfileKey(artistName);
    if (!artistKey) return null;
    setLoadingKeys((current) => new Set(current).add(artistKey));
    setErrors((current) => {
      const next = { ...current };
      delete next[artistKey];
      return next;
    });
    try {
      const dbPath = await resolveDbPath();
      const profile = await getArtistProfile(dbPath, artistName, force, {
        fanartApiKey,
        lastFmApiKey,
        theAudioDbApiKey,
      }, {
        artistId: identity?.artistId,
        musicBrainzId: identity?.musicBrainzId,
      });
      setProfiles((current) => ({ ...current, [artistKey]: profile }));
      return profile;
    } catch (error) {
      setErrors((current) => ({
        ...current,
        [artistKey]: error instanceof Error ? error.message : "Artist information is unavailable",
      }));
      return null;
    } finally {
      setLoadingKeys((current) => {
        const next = new Set(current);
        next.delete(artistKey);
        return next;
      });
    }
  }, [fanartApiKey, lastFmApiKey, resolveDbPath, theAudioDbApiKey]);

  const searchImages = useCallback(async (artistName: string, identity?: ArtistTarget) => {
    const dbPath = await resolveDbPath();
    return searchArtistImages(dbPath, artistName, {
      braveSearchApiKey,
      fanartApiKey,
      lastFmApiKey,
      theAudioDbApiKey,
    }, {
      artistId: identity?.artistId,
      musicBrainzId: identity?.musicBrainzId,
    });
  }, [braveSearchApiKey, fanartApiKey, lastFmApiKey, resolveDbPath, theAudioDbApiKey]);

  const selectImage = useCallback(async (
    artistName: string,
    candidate: ArtistImageCandidate,
    identity?: ArtistTarget,
  ) => {
    const artistKey = identity
      ? artistIdentityKey(identity)
      : normalizeArtistProfileKey(artistName);
    const dbPath = await resolveDbPath();
    const profile = await setArtistImage(dbPath, artistName, candidate, {
      artistId: identity?.artistId,
      musicBrainzId: identity?.musicBrainzId,
    });
    setProfiles((current) => ({ ...current, [artistKey]: profile }));
    return profile;
  }, [resolveDbPath]);

  return { profiles, loadingKeys, errors, loadProfile, searchImages, selectImage };
};
