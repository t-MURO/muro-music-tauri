import type { ArtistCredit, Track } from "../types";

export type ArtistTarget = Pick<
  ArtistCredit,
  "artistId" | "name" | "creditedName" | "musicBrainzId"
>;

export type ArtistCreditInput = {
  artistId?: string;
  name: string;
  creditedName: string;
  joinPhrase?: string | null;
  musicBrainzId?: string;
};

export type ArtistCreditSegment =
  | { kind: "artist"; text: string; credit: ArtistCredit }
  | { kind: "text"; text: string };

export const normalizeArtistName = (value: string) => value
  .normalize("NFKC")
  .trim()
  .replace(/\s+/g, " ")
  .toLocaleLowerCase();

const legacyArtistId = (name: string) => `legacy:${normalizeArtistName(name)}`;

export const legacyArtistCredit = (displayName: string): ArtistCredit | null => {
  const name = displayName.trim();
  if (!name) return null;
  return {
    artistId: legacyArtistId(name),
    name,
    creditedName: displayName,
    joinPhrase: "",
  };
};

export const legacyArtistCredits = (displayName: string): ArtistCredit[] => {
  const credit = legacyArtistCredit(displayName);
  return credit ? [credit] : [];
};

/**
 * Convert the canonical output of the explicit separator-review flow into
 * ordered credits. Do not use this for arbitrary imported or edited text:
 * commas in unreviewed artist names are not safe split points.
 */
export const reviewedCommaSeparatedArtistCredits = (displayName: string): ArtistCredit[] => {
  const names = displayName.split(",").map((name) => name.trim()).filter(Boolean);
  return names.map((name, index) => ({
    artistId: legacyArtistId(name),
    name,
    creditedName: name,
    joinPhrase: index < names.length - 1 ? ", " : "",
  }));
};

const editedCredit = (
  creditedName: string,
  joinPhrase: string,
  previous?: ArtistCredit,
): ArtistCredit => {
  const canonicalName = creditedName.trim();
  if (
    previous
    && normalizeArtistName(previous.creditedName || previous.name)
      === normalizeArtistName(canonicalName)
  ) {
    return {
      ...previous,
      creditedName,
      joinPhrase,
    };
  }
  return {
    artistId: legacyArtistId(canonicalName),
    name: canonicalName,
    creditedName,
    joinPhrase,
  };
};

/**
 * Preserve established credit boundaries while editing their visible text.
 * A brand-new ambiguous value remains one credit until separator review; this
 * avoids silently splitting atomic names that contain punctuation.
 */
export const editedArtistCredits = (
  displayName: string,
  previousCredits: ArtistCredit[] = [],
): ArtistCredit[] => {
  if (previousCredits.length < 2) {
    const separators: Array<{ start: number; end: number; text: string }> = [];
    const pattern = /\s*,\s*/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(displayName)) !== null) {
      separators.push({
        start: match.index,
        end: match.index + match[0].length,
        text: match[0],
      });
    }
    if (separators.length === 0) return legacyArtistCredits(displayName);

    const credits: ArtistCredit[] = [];
    let cursor = 0;
    for (const separator of separators) {
      const creditedName = displayName.slice(cursor, separator.start);
      if (!creditedName.trim()) return legacyArtistCredits(displayName);
      credits.push(editedCredit(creditedName, separator.text));
      cursor = separator.end;
    }
    const creditedName = displayName.slice(cursor);
    if (!creditedName.trim()) return legacyArtistCredits(displayName);
    credits.push(editedCredit(creditedName, ""));
    return credits;
  }

  const edited: ArtistCredit[] = [];
  let cursor = 0;
  for (let index = 0; index < previousCredits.length - 1; index += 1) {
    const joinPhrase = previousCredits[index].joinPhrase;
    if (!joinPhrase) return legacyArtistCredits(displayName);
    const joinIndex = displayName.indexOf(joinPhrase, cursor);
    if (joinIndex < cursor) return legacyArtistCredits(displayName);
    const creditedName = displayName.slice(cursor, joinIndex);
    if (!creditedName.trim()) return legacyArtistCredits(displayName);
    edited.push(editedCredit(creditedName, joinPhrase, previousCredits[index]));
    cursor = joinIndex + joinPhrase.length;
  }
  const creditedName = displayName.slice(cursor);
  if (!creditedName.trim()) return legacyArtistCredits(displayName);
  edited.push(editedCredit(
    creditedName,
    "",
    previousCredits[previousCredits.length - 1],
  ));
  return edited;
};

/**
 * Complete metadata-service credits before they enter Track state. Services
 * can provide MusicBrainz IDs before the local artist entity has been created.
 */
export const coerceArtistCredits = (
  credits: ArtistCreditInput[] | undefined,
  displayName: string,
): ArtistCredit[] => {
  const source = credits ?? [];
  const coerced = source.flatMap((credit, index) => {
    const creditedName = String(credit?.creditedName ?? "").trim();
    const name = String(credit?.name ?? creditedName).trim() || creditedName;
    if (!name || !creditedName) return [];
    const musicBrainzId = credit.musicBrainzId?.trim();
    return [{
      artistId: credit.artistId?.trim()
        || (musicBrainzId ? `mbid:${musicBrainzId.toLocaleLowerCase()}` : legacyArtistId(name)),
      name,
      creditedName,
      joinPhrase: credit.joinPhrase == null
        ? (index < source.length - 1 ? ", " : "")
        : String(credit.joinPhrase),
      ...(musicBrainzId ? { musicBrainzId } : {}),
    }];
  });
  if (coerced.length === 0) return legacyArtistCredits(displayName);
  return !displayName || formatArtistCredits(coerced) === displayName
    ? coerced
    : legacyArtistCredits(displayName);
};

const usableCredits = (credits: ArtistCredit[] | undefined) => (credits ?? []).filter(
  (credit) => Boolean(credit?.artistId && (credit.creditedName || credit.name)?.trim()),
);

export const formatArtistCredits = (credits: ArtistCredit[]) => credits
  .map((credit) => `${credit.creditedName || credit.name}${credit.joinPhrase || ""}`)
  .join("");

export const trackArtistCredits = (track: Track): ArtistCredit[] => {
  const structured = usableCredits(track.artistCredits);
  if (structured.length > 0) return structured;
  const legacy = legacyArtistCredit(track.artist);
  return legacy ? [legacy] : [];
};

export const explicitAlbumArtistDisplay = (track: Track) => {
  if (track.albumArtist?.trim()) return track.albumArtist;
  if (track.artists?.trim()) return track.artists;
  return "";
};

export const albumArtistCredits = (
  track: Track,
  { fallbackToTrack = true }: { fallbackToTrack?: boolean } = {},
): ArtistCredit[] => {
  const structured = usableCredits(track.albumArtistCredits);
  if (structured.length > 0) return structured;
  const display = explicitAlbumArtistDisplay(track);
  const legacy = legacyArtistCredit(display);
  if (legacy) return [legacy];
  return fallbackToTrack ? trackArtistCredits(track) : [];
};

export const albumArtistDisplay = (
  track: Track,
  { fallbackToTrack = true }: { fallbackToTrack?: boolean } = {},
) => explicitAlbumArtistDisplay(track) || (fallbackToTrack ? track.artist : "");

export const artistIdentityKey = (credit: ArtistTarget) =>
  (credit.musicBrainzId ? `mbid:${credit.musicBrainzId.toLocaleLowerCase()}` : "")
  || credit.artistId
  || `name:${normalizeArtistName(credit.name)}`;

export const isLegacyArtistId = (artistId: string) => artistId.startsWith("legacy:");

export const trackHasArtist = (
  track: Track,
  target: { artistId?: string | null; name?: string | null },
) => {
  const wantedId = target.artistId?.trim() ?? "";
  const wantedName = normalizeArtistName(target.name ?? "");
  const credits = trackArtistCredits(track);
  if (!wantedId && !wantedName) return credits.length > 0;
  if (
    wantedName
    && (!wantedId || isLegacyArtistId(wantedId))
    && normalizeArtistName(track.artist) === wantedName
  ) {
    return true;
  }
  return credits.some((credit) => (
    (wantedId && artistIdentityKey(credit) === wantedId)
    || (
      wantedName
      && (!wantedId || isLegacyArtistId(wantedId))
      && normalizeArtistName(credit.name) === wantedName
    )
  ));
};

/**
 * Map structured credits onto the exact scalar display value. Normally the
 * structured join phrases already reproduce it. The positional fallback keeps
 * legacy punctuation and spacing byte-for-byte while retaining individual links.
 */
export const artistCreditSegments = (
  display: string,
  credits: ArtistCredit[],
): ArtistCreditSegment[] => {
  if (!display || credits.length === 0) return display ? [{ kind: "text", text: display }] : [];
  if (formatArtistCredits(credits) === display) {
    return credits.flatMap((credit) => [
      { kind: "artist", text: credit.creditedName || credit.name, credit } as const,
      ...(credit.joinPhrase ? [{ kind: "text", text: credit.joinPhrase } as const] : []),
    ]);
  }

  const segments: ArtistCreditSegment[] = [];
  const foldedDisplay = display.toLocaleLowerCase();
  let cursor = 0;
  for (const credit of credits) {
    const creditedName = (credit.creditedName || credit.name).trim();
    if (!creditedName) continue;
    const index = foldedDisplay.indexOf(creditedName.toLocaleLowerCase(), cursor);
    if (index < cursor) {
      const legacy = legacyArtistCredit(display);
      return legacy ? [{ kind: "artist", text: display, credit: legacy }] : [];
    }
    if (index > cursor) segments.push({ kind: "text", text: display.slice(cursor, index) });
    segments.push({ kind: "artist", text: display.slice(index, index + creditedName.length), credit });
    cursor = index + creditedName.length;
  }
  if (cursor < display.length) segments.push({ kind: "text", text: display.slice(cursor) });
  return segments;
};
