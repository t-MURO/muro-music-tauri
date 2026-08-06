import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@muro/desktop/runtime";
import { convertFileSrc } from "@muro/desktop/runtime";
import { open } from "@muro/desktop/dialogs";
import { ClipboardCopy, ClipboardPaste, Disc3, Download, ImagePlus, LoaderCircle } from "lucide-react";
import { t } from "../../i18n";
import { notify, useSettingsStore } from "../../stores";
import { artistSeparatorExceptionKey } from "../../lib/metadata/artistSeparators";
import type {
  AlbumCoverCandidate,
  Track,
  TrackMetadataUpdates,
} from "../../types";
import {
  albumArtistCredits,
  editedArtistCredits,
  explicitAlbumArtistDisplay,
  legacyArtistCredits,
  trackArtistCredits,
} from "../../utils/artistCredits";
import { cacheClipboardCoverArt, clipboardHasImage, copyImageToClipboard } from "../../desktop/clipboard";
import { AlbumCoverPickerModal } from "./AlbumCoverPickerModal";
import { Popover, PopoverHeader, PopoverItem } from "./Popover";

type FetchedCoverArt = {
  fullPath: string;
  thumbPath: string;
  sourceUrl?: string | null;
  provider?: "cover-art-archive" | "deezer" | "brave-search" | null;
};

type CoverArtLookupResult = FetchedCoverArt | {
  candidates: AlbumCoverCandidate[];
};

type EditTrackModalProps = {
  isOpen: boolean;
  tracks: Track[];
  libraryTracks: Track[];
  onClose: () => void;
  onSave: (trackIds: string[], updates: TrackMetadataUpdates) => Promise<void>;
  onFetchCoverArt: (
    trackId: string,
    metadata: { album?: string; artist?: string },
  ) => Promise<CoverArtLookupResult | null>;
  onCacheCoverCandidate: (candidate: AlbumCoverCandidate) => Promise<FetchedCoverArt>;
};

type FormState = {
  title: string;
  artist: string;
  artists: string;
  album: string;
  trackNumber: string;
  trackTotal: string;
  discNumber: string;
  discTotal: string;
  year: string;
  genre: string;
  bpm: string;
  key: string;
  rating: number | null;
  comment: string;
  label: string;
  coverArtPath: string | null;
  coverArtThumbPath: string | null;
};

const EMPTY_FORM: FormState = {
  title: "",
  artist: "",
  artists: "",
  album: "",
  trackNumber: "",
  trackTotal: "",
  discNumber: "",
  discTotal: "",
  year: "",
  genre: "",
  bpm: "",
  key: "",
  rating: null,
  comment: "",
  label: "",
  coverArtPath: null,
  coverArtThumbPath: null,
};

const trackToForm = (track: Track): FormState => ({
  title: track.title ?? "",
  artist: track.artist ?? "",
  artists: explicitAlbumArtistDisplay(track),
  album: track.album ?? "",
  trackNumber: track.trackNumber != null ? String(track.trackNumber) : "",
  trackTotal: track.trackTotal != null ? String(track.trackTotal) : "",
  discNumber: track.discNumber != null ? String(track.discNumber) : "",
  discTotal: track.discTotal != null ? String(track.discTotal) : "",
  year: track.year != null ? String(track.year) : "",
  genre: track.genre ?? "",
  bpm: track.bpm != null ? String(track.bpm) : "",
  key: track.key ?? "",
  rating: track.rating,
  comment: track.comment ?? "",
  label: track.label ?? "",
  coverArtPath: track.coverArtPath ?? null,
  coverArtThumbPath: track.coverArtThumbPath ?? null,
});

const FORM_FIELDS = Object.keys(EMPTY_FORM) as Array<keyof FormState>;

const sharedFormForTracks = (tracks: Track[]) => {
  const forms = tracks.map(trackToForm);
  const form = { ...EMPTY_FORM };
  const mixedFields = new Set<keyof FormState>();
  if (forms.length === 0) return { form, mixedFields };
  for (const field of FORM_FIELDS) {
    const firstValue = forms[0][field];
    if (forms.every((candidate) => Object.is(candidate[field], firstValue))) {
      Object.assign(form, { [field]: firstValue });
    } else {
      mixedFields.add(field);
    }
  }
  return { form, mixedFields };
};

const buildSuggestions = (values: Array<string | undefined>) => {
  const counts = new Map<string, { value: string; count: number }>();
  for (const candidate of values) {
    const value = candidate?.trim();
    if (!value) continue;
    const key = value.toLocaleLowerCase();
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { value, count: 1 });
  }
  return [...counts.values()]
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
    .slice(0, 500)
    .map(({ value }) => value);
};

export const EditTrackModal = ({
  isOpen,
  tracks,
  libraryTracks,
  onClose,
  onSave,
  onFetchCoverArt,
  onCacheCoverCandidate,
}: EditTrackModalProps) => {
  const isBatch = tracks.length > 1;
  const artistSeparatorExceptions = useSettingsStore(
    (state) => state.artistSeparatorExceptions,
  );
  const artistSeparatorExceptionKeys = useMemo(
    () => new Set(artistSeparatorExceptions.map(artistSeparatorExceptionKey)),
    [artistSeparatorExceptions],
  );
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [dirtyFields, setDirtyFields] = useState<Set<string>>(new Set());
  const [mixedFields, setMixedFields] = useState<Set<keyof FormState>>(new Set());
  const [isSaving, setIsSaving] = useState(false);
  const [coverPreview, setCoverPreview] = useState<string | null>(null);
  const [coverMenuPosition, setCoverMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [isFetchingCover, setIsFetchingCover] = useState(false);
  const [isPastingCover, setIsPastingCover] = useState(false);
  const [clipboardImageAvailable, setClipboardImageAvailable] = useState(false);
  const [coverCandidates, setCoverCandidates] = useState<AlbumCoverCandidate[]>([]);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const saveInFlightRef = useRef(false);
  const suggestions = useMemo(() => {
    const people = libraryTracks.flatMap((track) => [
      track.artist,
      ...trackArtistCredits(track).flatMap((credit) => [credit.name, credit.creditedName]),
      explicitAlbumArtistDisplay(track),
      ...albumArtistCredits(track, { fallbackToTrack: false })
        .flatMap((credit) => [credit.name, credit.creditedName]),
    ]);
    return {
      artist: buildSuggestions(people),
      albumArtist: buildSuggestions(people),
      album: buildSuggestions(libraryTracks.map((track) => track.album)),
      genre: buildSuggestions(libraryTracks.flatMap((track) => track.genre?.split(/\s*,\s*/g) ?? [])),
      label: buildSuggestions(libraryTracks.map((track) => track.label)),
    };
  }, [libraryTracks]);

  // Stable key: only re-init when the modal opens with new track IDs
  const trackIdKey = tracks.map((t) => t.id).join(",");

  // Initialize form when modal opens (or track selection changes)
  useEffect(() => {
    if (!isOpen || tracks.length === 0) return;

    if (isBatch) {
      const shared = sharedFormForTracks(tracks);
      setForm(shared.form);
      setMixedFields(shared.mixedFields);
      setDirtyFields(new Set());
    } else {
      setForm(trackToForm(tracks[0]));
      setMixedFields(new Set());
      setDirtyFields(new Set());
    }
    setCoverPreview(null);
    setCoverMenuPosition(null);
    setCoverCandidates([]);
    setIsFetchingCover(false);
    saveInFlightRef.current = false;
    setIsSaving(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, trackIdKey]);

  // Auto-focus title input
  useEffect(() => {
    if (!isOpen) return;
    const id = window.setTimeout(() => titleRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [isOpen]);

  // Escape key handler
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (coverCandidates.length > 0) {
          setCoverCandidates([]);
          return;
        }
        if (coverMenuPosition) {
          setCoverMenuPosition(null);
          return;
        }
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [coverCandidates.length, coverMenuPosition, isOpen, onClose]);

  const updateField = useCallback(
    (field: keyof FormState, value: string | number | null) => {
      setForm((prev) => ({ ...prev, [field]: value }));
      if (isBatch || field === "coverArtPath" || field === "coverArtThumbPath") {
        setDirtyFields((prev) => new Set(prev).add(field));
      }
      if (isBatch) {
        setMixedFields((prev) => {
          if (!prev.has(field)) return prev;
          const next = new Set(prev);
          next.delete(field);
          return next;
        });
      }
    },
    [isBatch]
  );

  // Cover art from current track(s) for display
  const existingCoverSrc = useMemo(() => {
    if (coverPreview) return coverPreview;
    if (form.coverArtPath) return convertFileSrc(form.coverArtPath);
    return null;
  }, [coverPreview, form.coverArtPath]);

  const handleCoverArtClick = useCallback(async () => {
    try {
      const result = await open({
        multiple: false,
        filters: [
          {
            name: "Images",
            extensions: ["jpg", "jpeg", "png", "webp", "gif"],
          },
        ],
      });

      if (!result) return;

      const filePath = Array.isArray(result) ? result[0] : result;
      const cached = await invoke<{ fullPath: string; thumbPath: string }>(
        "cache_cover_art_from_file",
        { filePath }
      );

      updateField("coverArtPath", cached.fullPath);
      updateField("coverArtThumbPath", cached.thumbPath);
      setCoverPreview(convertFileSrc(cached.fullPath));
    } catch (error) {
      console.error("Failed to cache cover art:", error);
    }
  }, [updateField]);

  const handleFetchCoverArt = useCallback(async () => {
    const track = tracks[0];
    if (!track || isFetchingCover) return;
    setCoverMenuPosition(null);
    setIsFetchingCover(true);
    try {
      const result = await onFetchCoverArt(track.id, {
        album: form.album.trim() || track.album,
        artist: form.artists.trim() || form.artist.trim() || explicitAlbumArtistDisplay(track) || track.artist,
      });
      if (!result) {
        notify.info(t("edit.coverArtFetchNotFound"));
        return;
      }
      if ("candidates" in result) {
        setCoverCandidates(result.candidates);
        return;
      }
      const cached = result;
      updateField("coverArtPath", cached.fullPath);
      updateField("coverArtThumbPath", cached.thumbPath);
      setCoverPreview(convertFileSrc(cached.fullPath));
      notify.success(cached.provider === "deezer"
        ? t("edit.coverArtFetchedFromDeezer")
        : t("edit.coverArtFetched"));
    } catch (error) {
      notify.error(error instanceof Error ? error.message : t("edit.coverArtFetchFailed"));
    } finally {
      setIsFetchingCover(false);
    }
  }, [form.album, form.artist, form.artists, isFetchingCover, onFetchCoverArt, tracks, updateField]);

  const handleCacheCoverCandidate = useCallback(async (candidate: AlbumCoverCandidate) => {
    const cached = await onCacheCoverCandidate(candidate);
    updateField("coverArtPath", cached.fullPath);
    updateField("coverArtThumbPath", cached.thumbPath);
    setCoverPreview(convertFileSrc(cached.fullPath));
    notify.success(t("toast.cover.selectedFromBrave"));
  }, [onCacheCoverCandidate, updateField]);

  const handlePasteCoverArt = useCallback(async () => {
    if (isPastingCover) return;
    setCoverMenuPosition(null);
    setIsPastingCover(true);
    try {
      const cached = await cacheClipboardCoverArt();
      if (!cached) {
        setClipboardImageAvailable(false);
        notify.info(t("edit.coverArtClipboardEmpty"));
        return;
      }
      updateField("coverArtPath", cached.fullPath);
      updateField("coverArtThumbPath", cached.thumbPath);
      setCoverPreview(convertFileSrc(cached.fullPath));
      notify.success(t("edit.coverArtPasted"));
    } catch (error) {
      notify.error(error instanceof Error ? error.message : t("edit.coverArtPasteFailed"));
    } finally {
      setIsPastingCover(false);
    }
  }, [isPastingCover, updateField]);

  const handleCopyCoverArt = useCallback(async () => {
    const coverArtPath = form.coverArtPath;
    if (!coverArtPath) return;
    setCoverMenuPosition(null);
    try {
      await copyImageToClipboard(coverArtPath);
      notify.success(t("edit.coverArtCopied"));
    } catch (error) {
      notify.error(error instanceof Error ? error.message : t("edit.coverArtCopyFailed"));
    }
  }, [form.coverArtPath]);

  const handleRatingClick = useCallback(
    (event: React.MouseEvent, star: number) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const isHalf = event.clientX - rect.left < rect.width / 2;
      const newRating = isHalf ? star - 0.5 : star;
      // Toggle off if clicking same value
      const currentRating = form.rating;
      updateField("rating", currentRating === newRating ? 0 : newRating);
    },
    [form.rating, updateField]
  );

  const handleSave = useCallback(async () => {
    if (saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    setIsSaving(true);

    try {
      const updates: TrackMetadataUpdates = {};

      if (isBatch) {
        // Only send dirty fields
        for (const field of dirtyFields) {
          assignUpdate(updates, field as keyof FormState, form);
        }
      } else {
        // Send all fields for single track
        assignUpdate(updates, "title", form);
        assignUpdate(updates, "artist", form);
        assignUpdate(updates, "artists", form);
        assignUpdate(updates, "album", form);
        assignUpdate(updates, "trackNumber", form);
        assignUpdate(updates, "trackTotal", form);
        assignUpdate(updates, "discNumber", form);
        assignUpdate(updates, "discTotal", form);
        assignUpdate(updates, "year", form);
        assignUpdate(updates, "genre", form);
        assignUpdate(updates, "bpm", form);
        assignUpdate(updates, "key", form);
        assignUpdate(updates, "rating", form);
        assignUpdate(updates, "comment", form);
        assignUpdate(updates, "label", form);
      }

      const firstTrack = tracks[0];
      const creditsForEditedValue = (
        value: string,
        previous = [] as ReturnType<typeof trackArtistCredits>,
      ) => artistSeparatorExceptionKeys.has(artistSeparatorExceptionKey(value))
        ? legacyArtistCredits(value)
        : editedArtistCredits(value, previous);
      if (isBatch) {
        if (dirtyFields.has("artist")) {
          updates.artistCredits = creditsForEditedValue(form.artist);
        }
        if (dirtyFields.has("artists")) {
          updates.albumArtistCredits = creditsForEditedValue(form.artists);
        }
      } else if (firstTrack) {
        updates.artistCredits = form.artist === firstTrack.artist
          ? firstTrack.artistCredits
          : creditsForEditedValue(form.artist, trackArtistCredits(firstTrack));
        updates.albumArtistCredits = form.artists === explicitAlbumArtistDisplay(firstTrack)
          ? firstTrack.albumArtistCredits
          : creditsForEditedValue(
              form.artists,
              albumArtistCredits(firstTrack, { fallbackToTrack: false }),
            );
      }

      // Cover art is embedded only when it was explicitly changed. This avoids
      // rewriting a large image when saving an unrelated text-field edit.
      if (dirtyFields.has("coverArtPath") && form.coverArtPath !== null) {
        updates.coverArtPath = form.coverArtPath;
        updates.coverArtThumbPath = form.coverArtThumbPath ?? undefined;
      }

      const trackIds = tracks.map((t) => t.id);
      await onSave(trackIds, updates);
      onClose();
    } catch (error) {
      console.error("Failed to save metadata:", error);
      notify.error(error instanceof Error ? error.message : "Could not save track metadata");
    } finally {
      saveInFlightRef.current = false;
      setIsSaving(false);
    }
  }, [
    artistSeparatorExceptionKeys,
    dirtyFields,
    form,
    isBatch,
    onClose,
    onSave,
    tracks,
  ]);

  if (!isOpen || typeof document === "undefined") {
    return null;
  }

  const displayRating = form.rating ?? 0;
  const placeholderFor = (field: keyof FormState, commonFallback = t("edit.placeholder.keep")) => {
    if (!isBatch) return "";
    return mixedFields.has(field) ? t("edit.placeholder.mixed") : commonFallback;
  };

  return createPortal(
    <div
      className="modal-overlay-animate fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-[var(--spacing-lg)] backdrop-blur-sm"
      data-edit-track-modal
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && event.button === 0) {
          onClose();
        }
      }}
    >
      <form
        className="modal-panel-animate flex max-h-[85vh] w-full max-w-[640px] flex-col rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] shadow-[var(--shadow-lg)]"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void handleSave();
        }}
      >
        {/* Header */}
        <div className="border-b border-[var(--color-border)] p-[var(--spacing-lg)]">
          <h2 className="text-[var(--font-size-md)] font-semibold text-[var(--color-text-primary)]">
            {isBatch
              ? t("edit.title.batch", { count: String(tracks.length) })
              : t("edit.title.single")}
          </h2>
          <p className="mt-[var(--spacing-xs)] text-[var(--font-size-xs)] text-[var(--color-text-muted)]">
            {isBatch
              ? t("edit.subtitle.batch")
              : t("edit.subtitle.single")}
          </p>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-[var(--spacing-lg)]">
          <div className="flex gap-[var(--spacing-lg)]">
            {/* Cover art (left column) */}
            <button
              type="button"
              className="group relative h-[140px] w-[140px] flex-shrink-0 overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)] transition-colors hover:border-[var(--color-accent)]"
              onClick={handleCoverArtClick}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setCoverMenuPosition({ x: event.clientX, y: event.clientY });
                setClipboardImageAvailable(false);
                void clipboardHasImage()
                  .then(setClipboardImageAvailable)
                  .catch(() => setClipboardImageAvailable(false));
              }}
              title={t("edit.coverArt")}
              data-cover-art-field
            >
              {existingCoverSrc ? (
                <img
                  src={existingCoverSrc}
                  alt="Cover art"
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full flex-col items-center justify-center gap-[var(--spacing-sm)] text-[var(--color-text-muted)]">
                  <Disc3 className="h-10 w-10 opacity-30" />
                  {isBatch && mixedFields.has("coverArtPath") && (
                    <span className="text-[10px]">{t("edit.placeholder.mixed")}</span>
                  )}
                </div>
              )}
              <div className={`absolute inset-0 flex items-center justify-center transition-colors ${isFetchingCover || isPastingCover ? "bg-black/45" : "bg-black/0 group-hover:bg-black/40"}`}>
                {isFetchingCover || isPastingCover ? (
                  <LoaderCircle className="h-6 w-6 animate-spin text-white" aria-label={t("edit.coverArtFetching")} />
                ) : (
                  <ImagePlus className="h-6 w-6 text-white opacity-0 transition-opacity group-hover:opacity-100" />
                )}
              </div>
            </button>

            {/* Right column: title, artist, album artist, album */}
            <div className="flex flex-1 flex-col gap-[var(--spacing-sm)]">
              <Field
                label={t("edit.field.title")}
                value={form.title}
                placeholder={placeholderFor("title")}
                onChange={(v) => updateField("title", v)}
                inputRef={titleRef}
              />
              <Field
                label={t("edit.field.artist")}
                value={form.artist}
                placeholder={placeholderFor("artist")}
                onChange={(v) => updateField("artist", v)}
                autocompleteName="artist"
                suggestions={suggestions.artist}
              />
              <Field
                label={t("edit.field.albumArtist")}
                value={form.artists}
                placeholder={placeholderFor("artists")}
                onChange={(v) => updateField("artists", v)}
                autocompleteName="albumArtist"
                suggestions={suggestions.albumArtist}
                actionLabel={t("edit.sameAsArtist")}
                actionDisabled={!form.artist.trim() || form.artists.trim() === form.artist.trim()}
                actionTestId="same-as-artist"
                onAction={() => updateField("artists", form.artist.trim())}
              />
              <Field
                label={t("edit.field.album")}
                value={form.album}
                placeholder={placeholderFor("album")}
                onChange={(v) => updateField("album", v)}
                autocompleteName="album"
                suggestions={suggestions.album}
              />
            </div>
          </div>

          {/* Grid of smaller fields */}
          <div className="mt-[var(--spacing-md)] grid grid-cols-2 gap-x-[var(--spacing-md)] gap-y-[var(--spacing-sm)]">
            <div className="flex gap-[var(--spacing-sm)]">
              <Field
                label={t("edit.field.track")}
                value={form.trackNumber}
                placeholder={placeholderFor("trackNumber", "--")}
                onChange={(v) => updateField("trackNumber", v)}
                type="number"
                className="flex-1"
              />
              <Field
                label={t("edit.field.of")}
                value={form.trackTotal}
                placeholder={placeholderFor("trackTotal", "--")}
                onChange={(v) => updateField("trackTotal", v)}
                type="number"
                className="flex-1"
              />
            </div>
            <div className="flex gap-[var(--spacing-sm)]">
              <Field
                label={t("edit.field.disc")}
                value={form.discNumber}
                placeholder={placeholderFor("discNumber", "--")}
                onChange={(v) => updateField("discNumber", v)}
                type="number"
                className="flex-1"
              />
              <Field
                label={t("edit.field.of")}
                value={form.discTotal}
                placeholder={placeholderFor("discTotal", "--")}
                onChange={(v) => updateField("discTotal", v)}
                type="number"
                className="flex-1"
              />
            </div>
            <Field
              label={t("edit.field.year")}
              value={form.year}
              placeholder={placeholderFor("year")}
              onChange={(v) => updateField("year", v)}
              type="number"
            />
            <Field
              label={t("edit.field.genre")}
              value={form.genre}
              placeholder={placeholderFor("genre")}
              onChange={(v) => updateField("genre", v)}
              autocompleteName="genre"
              suggestions={suggestions.genre}
            />
            <Field
              label={t("edit.field.bpm")}
              value={form.bpm}
              placeholder={placeholderFor("bpm")}
              onChange={(v) => updateField("bpm", v)}
              type="number"
            />
            <Field
              label={t("edit.field.key")}
              value={form.key}
              placeholder={placeholderFor("key")}
              onChange={(v) => updateField("key", v)}
            />
          </div>

          {/* Rating */}
          <div className="mt-[var(--spacing-sm)]">
            <div className="mb-[var(--spacing-xs)] flex items-center gap-2 text-[var(--font-size-xs)] font-medium text-[var(--color-text-secondary)]">
              <span>{t("edit.field.rating")}</span>
              {isBatch && mixedFields.has("rating") && (
                <span className="text-[9px] font-normal text-[var(--color-text-muted)]" data-mixed-field="rating">
                  {t("edit.placeholder.mixed")}
                </span>
              )}
            </div>
            <div
              className="flex items-center gap-1"
              onMouseLeave={() => {}}
            >
              {[1, 2, 3, 4, 5].map((star) => {
                const fill = Math.max(0, Math.min(1, displayRating - (star - 1)));
                const ratingActionLabel = displayRating === star
                  ? "Clear rating"
                  : `Set rating to ${star} stars`;
                return (
                  <button
                    key={star}
                    type="button"
                    className="relative h-6 w-6 select-none focus:outline-none"
                    onClick={(e) => handleRatingClick(e, star)}
                    aria-label={ratingActionLabel}
                    title={ratingActionLabel}
                  >
                    <svg className="h-6 w-6" viewBox="0 0 24 24" aria-hidden="true">
                      <path
                        d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"
                        fill="var(--color-text-muted)"
                        opacity="0.3"
                      />
                      <path
                        d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"
                        fill="var(--color-rating-star)"
                        data-edit-rating-fill
                        style={{ clipPath: `inset(0 ${(1 - fill) * 100}% 0 0)` }}
                      />
                    </svg>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Label */}
          <div className="mt-[var(--spacing-sm)]">
            <Field
              label={t("edit.field.label")}
              value={form.label}
              placeholder={placeholderFor("label")}
              onChange={(v) => updateField("label", v)}
              autocompleteName="label"
              suggestions={suggestions.label}
            />
          </div>

          {/* Comment */}
          <div className="mt-[var(--spacing-sm)]">
            <Field
              label={t("edit.field.comment")}
              value={form.comment}
              placeholder={placeholderFor("comment")}
              onChange={(v) => updateField("comment", v)}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-[var(--color-border)] p-[var(--spacing-lg)]">
          <div className="flex items-center justify-end gap-[var(--spacing-sm)]">
            <button
              className="rounded-[var(--radius-md)] px-[var(--spacing-md)] py-[var(--spacing-sm)] text-[var(--font-size-sm)] font-medium text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)]"
              onClick={onClose}
              type="button"
            >
              {t("edit.cancel")}
            </button>
            <button
              className="rounded-[var(--radius-md)] bg-[var(--color-accent)] px-[var(--spacing-md)] py-[var(--spacing-sm)] text-[var(--font-size-sm)] font-semibold text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isSaving}
              type="submit"
            >
              {isSaving ? t("edit.saving") : t("edit.save")}
            </button>
          </div>
        </div>
        <Popover
          isOpen={coverMenuPosition !== null}
          position={coverMenuPosition ?? { x: 0, y: 0 }}
          className="w-52 py-1"
          onClose={() => setCoverMenuPosition(null)}
        >
          <PopoverHeader>{t("edit.coverArtMenu")}</PopoverHeader>
          <PopoverItem
            onClick={() => { void handleCopyCoverArt(); }}
            disabled={!form.coverArtPath}
            className="disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            dataTestId="copy-cover-art-menu-item"
          >
            <ClipboardCopy className="h-4 w-4 opacity-60" />
            {t("edit.copyCoverArt")}
          </PopoverItem>
          <PopoverItem
            onClick={() => { void handlePasteCoverArt(); }}
            disabled={!clipboardImageAvailable || isPastingCover}
            className="disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            dataTestId="paste-cover-art-menu-item"
          >
            <ClipboardPaste className="h-4 w-4 opacity-60" />
            {t("edit.pasteCoverArt")}
          </PopoverItem>
          <PopoverItem
            onClick={() => { void handleFetchCoverArt(); }}
            dataTestId="fetch-cover-art-menu-item"
          >
            <Download className="h-4 w-4 opacity-60" />
            {t("edit.fetchCoverArt")}
          </PopoverItem>
        </Popover>
        {coverCandidates.length > 0 && (
          <AlbumCoverPickerModal
            album={form.album.trim() || tracks[0]?.album || ""}
            artist={form.artists.trim()
              || form.artist.trim()
              || (tracks[0] ? explicitAlbumArtistDisplay(tracks[0]) : "")
              || tracks[0]?.artist
              || ""}
            candidates={coverCandidates}
            onApply={handleCacheCoverCandidate}
            onClose={() => setCoverCandidates([])}
          />
        )}
      </form>
    </div>,
    document.body
  );
};

// ---------- Helpers ----------

type FieldProps = {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  type?: "text" | "number";
  className?: string;
  inputRef?: React.Ref<HTMLInputElement>;
  autocompleteName?: "artist" | "albumArtist" | "album" | "genre" | "label";
  suggestions?: string[];
  actionLabel?: string;
  actionDisabled?: boolean;
  actionTestId?: string;
  onAction?: () => void;
};

const Field = ({
  label,
  value,
  placeholder,
  onChange,
  type = "text",
  className,
  inputRef,
  autocompleteName,
  suggestions = [],
  actionLabel,
  actionDisabled = false,
  actionTestId,
  onAction,
}: FieldProps) => {
  const listId = autocompleteName && suggestions.length > 0
    ? `edit-${autocompleteName}-suggestions`
    : undefined;
  return (
    <div className={className}>
      <div className="mb-[var(--spacing-xs)] flex min-h-4 items-center justify-between gap-2">
        <label className="block text-[var(--font-size-xs)] font-medium text-[var(--color-text-secondary)]">
          {label}
        </label>
        {onAction && actionLabel && (
          <button
            className="rounded px-1.5 py-0.5 text-[9px] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-light)] disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
            data-testid={actionTestId}
            disabled={actionDisabled}
            onClick={onAction}
            type="button"
          >
            {actionLabel}
          </button>
        )}
      </div>
      <input
        ref={inputRef}
        autoComplete="off"
        className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-[var(--spacing-md)] py-[var(--spacing-sm)] text-[var(--font-size-sm)] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
        data-autocomplete-field={autocompleteName}
        list={listId}
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {listId && (
        <datalist id={listId}>
          {suggestions.map((suggestion) => <option key={suggestion} value={suggestion} />)}
        </datalist>
      )}
    </div>
  );
};

function assignUpdate(
  updates: TrackMetadataUpdates,
  field: keyof FormState,
  form: FormState
) {
  switch (field) {
    case "title":
      updates.title = form.title;
      break;
    case "artist":
      updates.artist = form.artist;
      break;
    case "artists":
      updates.albumArtist = form.artists;
      updates.artists = form.artists;
      break;
    case "album":
      updates.album = form.album;
      break;
    case "trackNumber":
      updates.trackNumber = form.trackNumber ? Number(form.trackNumber) : undefined;
      break;
    case "trackTotal":
      updates.trackTotal = form.trackTotal ? Number(form.trackTotal) : undefined;
      break;
    case "discNumber":
      updates.discNumber = form.discNumber ? Number(form.discNumber) : undefined;
      break;
    case "discTotal":
      updates.discTotal = form.discTotal ? Number(form.discTotal) : undefined;
      break;
    case "year":
      updates.year = form.year ? Number(form.year) : undefined;
      break;
    case "genre":
      updates.genre = form.genre;
      break;
    case "bpm":
      updates.bpm = form.bpm ? Number(form.bpm) : undefined;
      break;
    case "key":
      updates.key = form.key;
      break;
    case "rating":
      updates.rating = form.rating ?? undefined;
      break;
    case "comment":
      updates.comment = form.comment;
      break;
    case "label":
      updates.label = form.label;
      break;
    case "coverArtPath":
      if (form.coverArtPath !== null) {
        updates.coverArtPath = form.coverArtPath;
      }
      break;
    case "coverArtThumbPath":
      if (form.coverArtThumbPath !== null) {
        updates.coverArtThumbPath = form.coverArtThumbPath;
      }
      break;
  }
}
