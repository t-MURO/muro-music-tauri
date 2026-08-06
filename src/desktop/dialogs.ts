import { bridge } from "./bridge";

export type OpenDialogOptions = Record<string, unknown>;

export const open = (
  options: OpenDialogOptions = {}
): Promise<string | string[] | null> => bridge().openDialog(options);

export const save = (
  options: Record<string, unknown> = {}
): Promise<string | null> => bridge().saveDialog(options);

export const confirm = (
  message: string,
  options: Record<string, unknown> = {}
): Promise<boolean> => bridge().confirmDialog(message, options);
