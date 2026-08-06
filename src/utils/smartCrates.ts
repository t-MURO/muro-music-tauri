import type {
  SmartCrate,
  SmartCrateField,
  SmartCrateRule,
  Track,
} from "../types";

const normalizeText = (value: unknown) => String(value ?? "").trim().toLocaleLowerCase();

const getTrackFieldValue = (track: Track, field: SmartCrateField): string | number | undefined => {
  if (field === "bpm") return track.bpm;
  if (field === "key") return track.key;
  if (field === "genre") return track.genre;
  if (field === "rating") return track.rating;
  if (field === "artist") return track.artist;
  if (field === "album") return track.album;
  if (field === "year") return track.year;
  if (field === "dateAdded") return track.dateAdded;
  if (field === "playCount") return track.playCount;
  return track.comment;
};

const numericValue = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const matchesSmartCrateRule = (
  track: Track,
  rule: SmartCrateRule,
  now: Date = new Date(),
) => {
  const actual = getTrackFieldValue(track, rule.field);

  if (rule.operator === "contains") {
    const expected = normalizeText(rule.value);
    return expected.length > 0 && normalizeText(actual).includes(expected);
  }

  if (rule.operator === "equals") {
    const expectedNumber = numericValue(rule.value);
    const actualNumber = numericValue(actual);
    if (expectedNumber !== null && actualNumber !== null && typeof actual === "number") {
      return actualNumber === expectedNumber;
    }
    return normalizeText(actual) === normalizeText(rule.value);
  }

  if (rule.operator === "withinDays") {
    if (!actual) return false;
    const days = numericValue(rule.value);
    const timestamp = new Date(String(actual)).getTime();
    if (days === null || days < 0 || !Number.isFinite(timestamp)) return false;
    const age = now.getTime() - timestamp;
    return age >= 0 && age <= days * 86_400_000;
  }

  const actualNumber = numericValue(actual);
  const expectedNumber = numericValue(rule.value);
  if (actualNumber === null || expectedNumber === null) return false;

  if (rule.operator === "atLeast") return actualNumber >= expectedNumber;
  if (rule.operator === "atMost") return actualNumber <= expectedNumber;
  if (rule.operator === "between") {
    const secondary = numericValue(rule.secondaryValue);
    if (secondary === null) return false;
    const minimum = Math.min(expectedNumber, secondary);
    const maximum = Math.max(expectedNumber, secondary);
    return actualNumber >= minimum && actualNumber <= maximum;
  }

  return false;
};

export const filterTracksBySmartCrate = (
  tracks: Track[],
  crate: SmartCrate,
  now: Date = new Date(),
) => {
  if (crate.rules.length === 0) return [];
  return tracks.filter((track) => {
    const results = crate.rules.map((rule) => matchesSmartCrateRule(track, rule, now));
    return crate.match === "any" ? results.some(Boolean) : results.every(Boolean);
  });
};
