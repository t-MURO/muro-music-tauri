import type { Track } from "../types";

const STANDARD_TO_CAMELOT: Record<string, string> = {
  A: "11B", Am: "8A", Bb: "6B", Bbm: "3A", B: "1B", Bm: "10A",
  C: "8B", Cm: "5A", Db: "3B", Dbm: "12A", D: "10B", Dm: "7A",
  Eb: "5B", Ebm: "2A", E: "12B", Em: "9A", F: "7B", Fm: "4A",
  Gb: "2B", Gbm: "11A", G: "9B", Gm: "6A", Ab: "4B", Abm: "1A",
  "A#": "6B", "A#m": "3A", "C#": "3B", "C#m": "12A",
  "D#": "5B", "D#m": "2A", "F#": "2B", "F#m": "11A",
  "G#": "4B", "G#m": "1A",
};

// Colors sampled from Mixed In Key's official Camelot Wheel artwork.
export const CAMELOT_COLORS: Record<string, string> = {
  "1A": "#B3FFED", "1B": "#90FFC7",
  "2A": "#C0FFC8", "2B": "#99FFAC",
  "3A": "#CEFBAB", "3B": "#AFFA7C",
  "4A": "#DFE8A7", "4B": "#D9C873",
  "5A": "#F0CEA7", "5B": "#E8B173",
  "6A": "#FEB1B4", "6B": "#FE8688",
  "7A": "#F1AED5", "7B": "#F87EA3",
  "8A": "#E9AEE1", "8B": "#DA7ED2",
  "9A": "#D4AEFB", "9B": "#B97EFA",
  "10A": "#BFCDFF", "10B": "#9AADFF",
  "11A": "#B3F0FE", "11B": "#87E5FE",
  "12A": "#B0FFF6", "12B": "#81FFF3",
};

export type CamelotMatch = {
  track: Track;
  code: string;
  reason: "Same key" | "Relative key" | "One step clockwise" | "One step counter-clockwise" | "Selected key";
  rank: number;
  bpmDifference: number;
  genreMatch: boolean;
  score: number;
};

export const calculateMixScore = (
  currentTrack: Track,
  candidate: Track,
  harmonicRank: number,
  bpmDifference: number,
) => {
  const harmonicBase = [100, 95, 90, 86][harmonicRank] ?? 82;
  const bpmPenalty = Number.isFinite(bpmDifference) ? Math.min(24, bpmDifference * 2) : 10;
  const genreMatch = Boolean(
    currentTrack.genre?.trim() &&
    candidate.genre?.trim() &&
    currentTrack.genre.trim().toLocaleLowerCase() === candidate.genre.trim().toLocaleLowerCase()
  );
  const genreBonus = genreMatch ? 3 : 0;
  const ratingBonus = Math.min(3, Math.max(0, candidate.rating) * 0.6);
  return {
    genreMatch,
    score: Math.round(Math.max(55, Math.min(100, harmonicBase - bpmPenalty + genreBonus + ratingBonus))),
  };
};

export const getCompatibleCamelotCodes = (code: string): string[] => {
  const normalized = toCamelotCode(code);
  if (!normalized) return [];
  const number = Number(normalized.slice(0, -1));
  const letter = normalized.charAt(normalized.length - 1);
  const otherLetter = letter === "A" ? "B" : "A";
  const previous = number === 1 ? 12 : number - 1;
  const next = number === 12 ? 1 : number + 1;
  return [normalized, `${number}${otherLetter}`, `${previous}${letter}`, `${next}${letter}`];
};

export const toCamelotCode = (value?: string): string | null => {
  if (!value) return null;
  const camelot = value.toUpperCase().match(/(?:^|\W)(1[0-2]|[1-9])([AB])(?:$|\W)/);
  if (camelot) return `${Number(camelot[1])}${camelot[2]}`;

  const normalized = value.replace(/♭/g, "b").replace(/♯/g, "#");
  const standard = normalized.match(/(?:^|[^A-Ga-g])([A-Ga-g](?:#|b)?m?)(?:$|[^A-Za-z#])/);
  if (!standard) return null;
  const raw = standard[1];
  const key = `${raw[0].toUpperCase()}${raw.slice(1).replace("M", "m")}`;
  return STANDARD_TO_CAMELOT[key] ?? null;
};

export const getCamelotColor = (value?: string): string | null => {
  const code = toCamelotCode(value);
  return code ? CAMELOT_COLORS[code] ?? null : null;
};

const wheelDistance = (from: number, to: number) => {
  const clockwise = ((to - from) + 12) % 12;
  const counterClockwise = ((from - to) + 12) % 12;
  return { clockwise, counterClockwise };
};

export const getCamelotSuggestions = (
  currentTrack: Track | null | undefined,
  tracks: Track[],
  excludedTrackIds: ReadonlySet<string> = new Set(),
): CamelotMatch[] => {
  const currentCode = toCamelotCode(currentTrack?.key);
  if (!currentTrack || !currentCode) return [];

  const currentNumber = Number(currentCode.slice(0, -1));
  const currentLetter = currentCode.charAt(currentCode.length - 1);
  const currentBpm = currentTrack.bpm ?? 0;

  return tracks
    .filter((track) => track.id !== currentTrack.id && !excludedTrackIds.has(track.id))
    .map((track): CamelotMatch | null => {
      const code = toCamelotCode(track.key);
      if (!code) return null;
      const number = Number(code.slice(0, -1));
      const letter = code.charAt(code.length - 1);
      let reason: CamelotMatch["reason"];
      let rank: number;

      if (code === currentCode) {
        reason = "Same key";
        rank = 0;
      } else if (number === currentNumber && letter !== currentLetter) {
        reason = "Relative key";
        rank = 1;
      } else if (letter === currentLetter) {
        const distance = wheelDistance(currentNumber, number);
        if (distance.clockwise === 1) {
          reason = "One step clockwise";
          rank = 2;
        } else if (distance.counterClockwise === 1) {
          reason = "One step counter-clockwise";
          rank = 2;
        } else {
          return null;
        }
      } else {
        return null;
      }

      const bpmDifference = currentBpm > 0 && (track.bpm ?? 0) > 0
        ? Math.abs((track.bpm ?? 0) - currentBpm)
        : Number.POSITIVE_INFINITY;
      const scoring = calculateMixScore(currentTrack, track, rank, bpmDifference);
      return {
        track,
        code,
        reason,
        rank,
        bpmDifference,
        ...scoring,
      };
    })
    .filter((suggestion): suggestion is CamelotMatch => suggestion !== null)
    .sort((left, right) =>
      left.rank - right.rank ||
      right.score - left.score ||
      left.bpmDifference - right.bpmDifference ||
      left.track.title.localeCompare(right.track.title)
    );
};

export const getTracksForCamelotCode = (
  code: string,
  currentTrack: Track,
  tracks: Track[],
  excludedTrackIds: ReadonlySet<string> = new Set(),
): Track[] => {
  const currentBpm = currentTrack.bpm ?? 0;
  return tracks
    .filter((track) =>
      track.id !== currentTrack.id &&
      !excludedTrackIds.has(track.id) &&
      toCamelotCode(track.key) === code
    )
    .sort((left, right) => {
      const leftDifference = currentBpm > 0 && (left.bpm ?? 0) > 0
        ? Math.abs((left.bpm ?? 0) - currentBpm)
        : Number.POSITIVE_INFINITY;
      const rightDifference = currentBpm > 0 && (right.bpm ?? 0) > 0
        ? Math.abs((right.bpm ?? 0) - currentBpm)
        : Number.POSITIVE_INFINITY;
      return leftDifference - rightDifference || left.title.localeCompare(right.title);
    });
};
