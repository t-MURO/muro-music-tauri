// The .ts extension keeps this module importable from plain Node
// (type-stripping) so the loudness tests can exercise it directly.
import { dbToLinear } from "../lib/loudness/r128.ts";
import type { Track } from "../types";

export type ReplayGainMode = "off" | "track" | "album";

export type ReplayGainSettings = {
  mode: ReplayGainMode;
  /** Extra dB applied on top of the stored gain. */
  preampDb: number;
  /** Hold the gain back so the track's peak stays below full scale. */
  preventClipping: boolean;
};

/** Applied when a track has no gain value of its own. */
export const DEFAULT_FALLBACK_GAIN = 1;

/**
 * Linear multiplier for a track under the current settings.
 *
 * Album mode falls back to the track value when a release has not been scanned
 * as a whole, which is the behaviour every other ReplayGain-aware player has.
 */
export const resolveGainFactor = (
  track: Pick<
    Track,
    "replayGainTrackDb" | "replayGainAlbumDb" | "replayGainTrackPeak" | "replayGainAlbumPeak"
  >,
  settings: ReplayGainSettings
): number => {
  if (settings.mode === "off") return DEFAULT_FALLBACK_GAIN;

  const gainDb =
    settings.mode === "album"
      ? track.replayGainAlbumDb ?? track.replayGainTrackDb
      : track.replayGainTrackDb;

  if (gainDb === undefined || !Number.isFinite(gainDb)) {
    return DEFAULT_FALLBACK_GAIN;
  }

  let factor = dbToLinear(gainDb + settings.preampDb);

  if (settings.preventClipping) {
    const peak =
      settings.mode === "album"
        ? track.replayGainAlbumPeak ?? track.replayGainTrackPeak
        : track.replayGainTrackPeak;
    if (typeof peak === "number" && peak > 0 && factor * peak > 1) {
      factor = 1 / peak;
    }
  }

  // Web Audio applies boosts above unity. Keep malformed or hostile tags from
  // producing an unbounded multiplier; +24 dB is already a 15.8× increase.
  return Number.isFinite(factor)
    ? Math.max(0, Math.min(dbToLinear(24), factor))
    : DEFAULT_FALLBACK_GAIN;
};
