import { bridge } from "./bridge";

export const appDataDir = (): Promise<string> => bridge().appDataDir();

export const join = async (...parts: string[]): Promise<string> => {
  const separator = navigator.userAgent.includes("Windows") ? "\\" : "/";
  return parts
    .filter(Boolean)
    .map((part, index) =>
      index === 0
        ? part.replace(/[\\/]+$/, "")
        : part.replace(/^[\\/]+|[\\/]+$/g, "")
    )
    .join(separator);
};
