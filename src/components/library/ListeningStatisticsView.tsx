import { useEffect, useMemo, useState } from "react";
import { loadListeningStatistics, type ListeningStatistics } from "../../utils";

type ListeningStatisticsViewProps = {
  dbPath: string;
};

const formatDuration = (seconds: number) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
};

const Ranking = ({
  title,
  items,
}: {
  title: string;
  items: ListeningStatistics["topArtists"];
}) => {
  const max = Math.max(1, ...items.map((item) => item.listeningSeconds));
  return (
    <section className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4">
      <h3 className="text-[13px] font-semibold text-[var(--color-text-primary)]">{title}</h3>
      <div className="mt-3 space-y-3">
        {items.length === 0 && <p className="text-[12px] text-[var(--color-text-muted)]">No listening data yet.</p>}
        {items.map((item) => (
          <div key={item.name}>
            <div className="mb-1 flex justify-between gap-3 text-[11px]">
              <span className="truncate text-[var(--color-text-secondary)]">{item.name}</span>
              <span className="shrink-0 tabular-nums text-[var(--color-text-muted)]">
                {formatDuration(item.listeningSeconds)} · {item.plays} plays
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-[var(--color-bg-tertiary)]">
              <div className="h-full rounded-full bg-[var(--color-accent)]" style={{ width: `${(item.listeningSeconds / max) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
};

export const ListeningStatisticsView = ({ dbPath }: ListeningStatisticsViewProps) => {
  const [statistics, setStatistics] = useState<ListeningStatistics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    loadListeningStatistics(dbPath).then((result) => {
      if (!cancelled) setStatistics(result);
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => {
      cancelled = true;
    };
  }, [dbPath]);

  const monthlyMax = useMemo(
    () => Math.max(1, ...(statistics?.monthly.map((item) => item.listeningSeconds) ?? [])),
    [statistics],
  );

  if (error) return <div className="p-6 text-[13px] text-red-500">{error}</div>;
  if (!statistics) return <div className="p-6 text-[13px] text-[var(--color-text-muted)]">Loading listening statistics…</div>;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5" data-listening-statistics>
      <div className="grid gap-3 sm:grid-cols-4">
        {[
          ["Listening time", formatDuration(statistics.listeningSeconds)],
          ["Recorded plays", statistics.plays.toLocaleString()],
          ["Unique tracks", statistics.uniqueTracks.toLocaleString()],
          ["Discovery rate", `${statistics.discoveryRate.toFixed(1)}%`],
        ].map(([label, value]) => (
          <section key={label} className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">{label}</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums text-[var(--color-text-primary)]">{value}</p>
          </section>
        ))}
      </div>
      <p className="mt-2 text-[10px] text-[var(--color-text-muted)]">
        Discovery rate is the share of recorded plays heard within 30 days of adding the track.
        Detailed listening time starts accumulating after this feature is installed.
      </p>
      <section className="mt-4 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4">
        <h3 className="text-[13px] font-semibold text-[var(--color-text-primary)]">Monthly listening history</h3>
        <div className="mt-4 flex h-44 items-end gap-2">
          {statistics.monthly.map((month) => (
            <div key={month.month} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-2">
              <span className="text-[9px] tabular-nums text-[var(--color-text-muted)]">{formatDuration(month.listeningSeconds)}</span>
              <div
                className="min-h-1 w-full rounded-t bg-[var(--color-accent)]"
                style={{ height: `${Math.max(2, (month.listeningSeconds / monthlyMax) * 120)}px` }}
                title={`${month.month}: ${formatDuration(month.listeningSeconds)}`}
              />
              <span className="text-[9px] text-[var(--color-text-muted)]">{month.month.slice(5)}</span>
            </div>
          ))}
        </div>
      </section>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Ranking title="Top artists" items={statistics.topArtists} />
        <Ranking title="Top albums" items={statistics.topAlbums} />
      </div>
      <section className="mt-4 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4">
        <h3 className="text-[13px] font-semibold text-[var(--color-text-primary)]">Neglected tracks</h3>
        <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">Never played, or not played in at least 180 days.</p>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {statistics.neglectedTracks.map((track) => (
            <div key={track.id} className="min-w-0 rounded border border-[var(--color-border-light)] px-3 py-2">
              <p className="truncate text-[12px] font-medium text-[var(--color-text-primary)]">{track.title}</p>
              <p className="truncate text-[10px] text-[var(--color-text-muted)]">{track.artist} · {track.album}</p>
            </div>
          ))}
          {statistics.neglectedTracks.length === 0 && <p className="text-[12px] text-[var(--color-text-muted)]">Nothing is being neglected.</p>}
        </div>
      </section>
    </div>
  );
};
