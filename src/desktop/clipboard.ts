import { bridge } from "./bridge";

export type CachedClipboardCover = {
  fullPath: string;
  thumbPath: string;
};

export const clipboardHasImage = () => bridge().clipboardHasImage();

export const cacheClipboardCoverArt = () => bridge().cacheClipboardCoverArt();

export const copyImageToClipboard = (filePath: string) => bridge().copyImageToClipboard(filePath);
