import type { ArtistCredit } from "../../types";
import {
  artistCreditSegments,
  type ArtistTarget,
} from "../../utils/artistCredits";

type ArtistCreditLinksProps = {
  display: string;
  credits: ArtistCredit[];
  onOpenArtist: (artist: ArtistTarget) => void;
  kind?: "track" | "album";
};

export const ArtistCreditLinks = ({
  display,
  credits,
  onOpenArtist,
  kind = "track",
}: ArtistCreditLinksProps) => (
  <span className="block min-w-0 max-w-full truncate whitespace-nowrap" title={display}>
    {artistCreditSegments(display, credits).map((segment, index) => (
      segment.kind === "artist" ? (
        <button
          key={`${segment.credit.artistId}:${index}`}
          type="button"
          className="inline text-left transition-colors hover:text-[var(--color-accent)] hover:underline focus-visible:text-[var(--color-accent)] focus-visible:underline focus-visible:outline-none"
          title={`Open artist ${segment.credit.name}`}
          onClick={(event) => {
            event.stopPropagation();
            onOpenArtist(segment.credit);
          }}
          onDoubleClick={(event) => event.stopPropagation()}
          data-track-artist-link="true"
          data-track-album-artist-link={kind === "album" ? "true" : undefined}
        >
          {segment.text}
        </button>
      ) : (
        <span key={`text:${index}`}>{segment.text}</span>
      )
    ))}
  </span>
);
