import { useCallback, useEffect, useRef, type PointerEvent, type RefObject } from "react";

type WaveformSeekBarProps = {
  peaks: number[];
  progress: number;
  duration: number;
  displayPosition: number;
  onSeekStart: (event: PointerEvent<HTMLDivElement>) => void;
  onSeekMove: (event: PointerEvent<HTMLDivElement>) => void;
  onSeekEnd: (event: PointerEvent<HTMLDivElement>) => void;
  onSeekCancel: () => void;
  progressRef: RefObject<HTMLDivElement | null>;
};

export const WaveformSeekBar = ({
  peaks,
  progress,
  duration,
  displayPosition,
  onSeekStart,
  onSeekMove,
  onSeekEnd,
  onSeekCancel,
  progressRef,
}: WaveformSeekBarProps) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, width, height);
    if (peaks.length === 0) return;

    const styles = getComputedStyle(document.documentElement);
    const playedColor = styles.getPropertyValue("--color-accent").trim() || "#ef3340";
    const pendingColor = styles.getPropertyValue("--color-text-muted").trim() || "#68747b";
    const cssBarWidth = 1;
    const cssGap = 1.25;
    const step = (cssBarWidth + cssGap) * ratio;
    const barWidth = Math.max(1, cssBarWidth * ratio);
    const barCount = Math.max(1, Math.floor(width / step));
    const playedX = (Math.max(0, Math.min(100, progress)) / 100) * width;

    for (let index = 0; index < barCount; index += 1) {
      const start = Math.floor((index / barCount) * peaks.length);
      const end = Math.max(start + 1, Math.floor(((index + 1) / barCount) * peaks.length));
      let peak = 0;
      for (let peakIndex = start; peakIndex < Math.min(end, peaks.length); peakIndex += 1) {
        peak = Math.max(peak, Math.abs(Number(peaks[peakIndex]) || 0));
      }
      const x = index * step;
      const barHeight = Math.max(2 * ratio, Math.min(height - 2 * ratio, peak * (height - 3 * ratio)));
      const y = (height - barHeight) / 2;
      context.fillStyle = x + barWidth <= playedX ? playedColor : pendingColor;
      context.globalAlpha = x + barWidth <= playedX ? 1 : 0.58;
      context.fillRect(Math.round(x), Math.round(y), Math.ceil(barWidth), Math.max(1, Math.round(barHeight)));
    }
    context.globalAlpha = 1;
  }, [peaks, progress]);

  useEffect(() => {
    draw();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resizeObserver = new ResizeObserver(draw);
    resizeObserver.observe(canvas);
    const themeObserver = new MutationObserver(draw);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      resizeObserver.disconnect();
      themeObserver.disconnect();
    };
  }, [draw]);

  return (
    <div
      ref={progressRef}
      className="player-waveform relative h-5 flex-1 touch-none overflow-hidden"
      onPointerDown={onSeekStart}
      onPointerMove={onSeekMove}
      onPointerUp={onSeekEnd}
      onPointerCancel={onSeekCancel}
      role="slider"
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={duration}
      aria-valuenow={displayPosition}
      tabIndex={0}
    >
      <canvas ref={canvasRef} className="pointer-events-none h-full w-full" aria-hidden="true" />
      <span className="pointer-events-none absolute bottom-0 top-0 w-px bg-[var(--color-accent)]" style={{ left: `${progress}%` }} />
    </div>
  );
};
