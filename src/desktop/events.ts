import { bridge } from "./bridge";

export type UnlistenFn = () => void;
export type Event<T> = { payload: T };
export type EventCallback<T> = (event: Event<T>) => void;

const localListeners = new Map<string, Set<(payload: unknown) => void>>();

export const emitLocal = (event: string, payload: unknown): void => {
  for (const listener of localListeners.get(event) ?? []) {
    listener(payload);
  }
};

export const listen = async <T>(
  event: string,
  handler: EventCallback<T>
): Promise<UnlistenFn> => {
  const localHandler = (payload: unknown) => handler({ payload: payload as T });
  const listeners = localListeners.get(event) ?? new Set();
  listeners.add(localHandler);
  localListeners.set(event, listeners);

  const removeBridgeListener = bridge().on(event, localHandler);
  return () => {
    removeBridgeListener();
    listeners.delete(localHandler);
    if (listeners.size === 0) localListeners.delete(event);
  };
};
