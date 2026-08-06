import de from "./de.json";
import en from "./en.json";

export const localeOptions = [
  { id: "en", label: "English" },
  { id: "de", label: "Deutsch" },
] as const;

const localeMessages = {
  en,
  de,
} as const;

export type Locale = keyof typeof localeMessages;
export type Messages = (typeof localeMessages)[Locale];
export type MessageKey = keyof Messages;

let currentLocale: Locale = "en";
let currentMessages: Messages = localeMessages[currentLocale];

// `t` is a plain function so it can be called from anywhere, including outside
// React. Memoized values built from it would otherwise keep the old language
// after a switch, so listeners get a chance to invalidate.
let localeVersion = 0;
const localeListeners = new Set<() => void>();

export const isLocale = (value: string): value is Locale =>
  Object.prototype.hasOwnProperty.call(localeMessages, value);

export const setLocale = (locale: Locale) => {
  if (locale === currentLocale) return;
  currentLocale = locale;
  currentMessages = localeMessages[locale] ?? localeMessages.en;
  localeVersion += 1;
  for (const listener of localeListeners) listener();
};

export const getLocale = () => currentLocale;

/** Bumped on every language change; use as a memo dependency. */
export const getLocaleVersion = () => localeVersion;

export const subscribeToLocale = (listener: () => void) => {
  localeListeners.add(listener);
  return () => {
    localeListeners.delete(listener);
  };
};

export const t = (key: MessageKey, params?: Record<string, string>) => {
  let message: string = currentMessages[key] ?? key;
  if (params) {
    for (const [placeholder, value] of Object.entries(params)) {
      message = message.replace(new RegExp(`\\{${placeholder}\\}`, "g"), value);
    }
  }
  return message;
};
