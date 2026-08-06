import { bridge } from "./bridge";

export const openExternal = (url: string): Promise<void> => bridge().openExternal(url);

export const showItemInFolder = (filePath: string): Promise<void> =>
  bridge().showItemInFolder(filePath);
