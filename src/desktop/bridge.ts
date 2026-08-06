import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { appDataDir as resolveAppDataDir } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  confirm as showConfirmDialog,
  open as showOpenDialog,
  save as showSaveDialog,
  type ConfirmDialogOptions,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from "@tauri-apps/plugin-dialog";

export type BridgeEvent = { payload: unknown };
export type WindowControlAction = "minimize" | "toggleMaximize" | "close";

export type MuroBridge = {
  platform: string;
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  on(event: string, listener: (payload: unknown) => void): () => void;
  appDataDir(): Promise<string>;
  clipboardHasImage(): Promise<boolean>;
  cacheClipboardCoverArt(): Promise<{ fullPath: string; thumbPath: string } | null>;
  copyImageToClipboard(filePath: string): Promise<boolean>;
  windowControl(action: WindowControlAction): Promise<boolean>;
  isWindowMaximized(): Promise<boolean>;
  openDialog(options: Record<string, unknown>): Promise<string | string[] | null>;
  saveDialog(options: Record<string, unknown>): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  showItemInFolder(filePath: string): Promise<void>;
  startFileDrag(filePaths: string[]): void;
  confirmDialog(message: string, options?: Record<string, unknown>): Promise<boolean>;
};

declare global {
  interface Window {
    muro?: MuroBridge;
  }
}

const currentWindow = getCurrentWindow();
const platform = /Mac|iPhone|iPad/.test(navigator.platform)
  ? "darwin"
  : /Win/.test(navigator.platform)
    ? "win32"
    : "linux";

const localListeners = new Map<string, Set<(payload: unknown) => void>>();

const emitLocal = (event: string, payload: unknown) => {
  for (const listener of localListeners.get(event) ?? []) listener(payload);
};

void currentWindow.onResized(async () => {
  emitLocal("muro://window-maximized", { maximized: await currentWindow.isMaximized() });
});

const normalizeOpenOptions = (options: Record<string, unknown>): OpenDialogOptions => {
  const normalized = { ...options } as OpenDialogOptions & { properties?: unknown };
  if (Array.isArray(normalized.properties)) {
    const properties = normalized.properties as string[];
    normalized.directory = properties.includes("openDirectory");
    normalized.multiple = properties.includes("multiSelections");
    delete normalized.properties;
  }
  return normalized;
};

const bridgeImpl: MuroBridge = {
  platform,
  invoke: (command, args = {}) => tauriInvoke(command, args),
  on(event, listener) {
    let active = true;
    let unlisten: (() => void) | undefined;
    const local = localListeners.get(event) ?? new Set();
    local.add(listener);
    localListeners.set(event, local);
    void listen(event, ({ payload }) => {
      if (active) listener(payload);
    }).then((remove) => {
      if (active) unlisten = remove;
      else remove();
    });
    return () => {
      active = false;
      unlisten?.();
      local.delete(listener);
      if (local.size === 0) localListeners.delete(event);
    };
  },
  appDataDir: resolveAppDataDir,
  clipboardHasImage: () => tauriInvoke("clipboard_has_image"),
  cacheClipboardCoverArt: () => tauriInvoke("cache_clipboard_cover_art"),
  copyImageToClipboard: (filePath) => tauriInvoke("copy_image_to_clipboard", { filePath }),
  async windowControl(action) {
    if (action === "minimize") {
      await currentWindow.minimize();
    } else if (action === "close") {
      await currentWindow.close();
    } else if (await currentWindow.isMaximized()) {
      await currentWindow.unmaximize();
    } else {
      await currentWindow.maximize();
    }
    return currentWindow.isMaximized();
  },
  isWindowMaximized: () => currentWindow.isMaximized(),
  openDialog: (options) => showOpenDialog(normalizeOpenOptions(options)),
  saveDialog: (options) => showSaveDialog(options as SaveDialogOptions),
  openExternal: (url) => tauriInvoke("open_external", { url }),
  showItemInFolder: (filePath) => tauriInvoke("show_item_in_folder", { filePath }),
  startFileDrag(filePaths) {
    void tauriInvoke("start_file_drag", { filePaths }).catch(() => undefined);
  },
  confirmDialog: (message, options = {}) =>
    showConfirmDialog(message, options as ConfirmDialogOptions),
};

window.muro = bridgeImpl;

export const bridge = (): MuroBridge => bridgeImpl;