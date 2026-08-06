import { convertFileSrc as tauriConvertFileSrc } from "@tauri-apps/api/core";
import { bridge } from "./bridge";

export type MediaControlPayload = {
  action: "play" | "pause" | "toggle" | "next" | "previous";
  source: "media-session" | "global-shortcut" | string;
};

const cleanRemoteError = (error: unknown) => {
  if (!(error instanceof Error)) return error;
  const message = error.message
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^(?:Error|TypeError):\s*/i, "");
  return message === error.message
    ? error
    : Object.assign(new Error(message), { cause: error });
};

/**
 * Invoke the Tauri command directly. Playback is intentionally handled by the
 * Rust actor; the WebView never creates an HTMLAudioElement or AudioContext.
 */
export const invoke = <T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> => bridge().invoke<T>(command, args).catch((error) => {
  throw cleanRemoteError(error);
});

type AuthorizedLocalMedia = {
  url: string;
  expiresInSeconds: number;
};

/**
 * Grant one exact canonical file to a callback, then revoke its unguessable
 * loopback capability as soon as the response body has been consumed.
 */
export const withAuthorizedLocalMedia = async <T>(
  filePath: string,
  callback: (url: string) => Promise<T>,
): Promise<T> => {
  const grant = await invoke<AuthorizedLocalMedia>("authorize_local_media", { filePath });
  try {
    return await callback(grant.url);
  } finally {
    await invoke<boolean>("revoke_local_media", { urlOrToken: grant.url })
      .catch(() => false);
  }
};
export const convertFileSrc = (filePath: string): string => tauriConvertFileSrc(filePath);

export const startFileDrag = (filePaths: string[]): void => {
  bridge().startFileDrag(filePaths);
};