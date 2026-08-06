export type PlayableMedia = {
  play(): Promise<void>;
  pause(): void;
};

export const retryMediaLoadOnce = async <T>(
  load: () => Promise<T>,
  reset: () => Promise<void> | void,
): Promise<T> => {
  try {
    return await load();
  } catch {
    await reset();
    return load();
  }
};

export const playWithTimeout = async (
  media: PlayableMedia,
  timeoutMs: number,
  label = "Playback",
): Promise<void> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });

  try {
    await Promise.race([media.play(), timeout]);
  } catch (error) {
    media.pause();
    throw error;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
};
