import { useSyncExternalStore } from "react";
import { getLocaleVersion, subscribeToLocale } from "../i18n";

/**
 * Re-renders on a language change and returns a value that changes with it.
 *
 * Anything that memoizes translated text needs this in its dependency array;
 * `t` reads module state, so React has no other way to know the strings moved.
 */
export const useLocaleVersion = () =>
  useSyncExternalStore(subscribeToLocale, getLocaleVersion, getLocaleVersion);
