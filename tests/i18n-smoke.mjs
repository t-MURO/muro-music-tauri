import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const localeDir = path.join(root, "src", "i18n");

const en = JSON.parse(fs.readFileSync(path.join(localeDir, "en.json"), "utf8"));
const de = JSON.parse(fs.readFileSync(path.join(localeDir, "de.json"), "utf8"));

const enKeys = Object.keys(en);
const deKeys = Object.keys(de);

// --- Key parity --------------------------------------------------------------
{
  const missingInDe = enKeys.filter((key) => !(key in de));
  const missingInEn = deKeys.filter((key) => !(key in en));
  assert.deepEqual(missingInDe, [], "every English key must have a German translation");
  assert.deepEqual(missingInEn, [], "German must not define keys English does not have");
  assert.deepEqual(enKeys, deKeys, "both locales must list their keys in the same order");
}

// --- Value sanity ------------------------------------------------------------
for (const [key, value] of Object.entries(en)) {
  assert.equal(typeof value, "string", `en.${key} must be a string`);
  assert.notEqual(value.trim(), "", `en.${key} must not be empty`);
}
for (const [key, value] of Object.entries(de)) {
  assert.equal(typeof value, "string", `de.${key} must be a string`);
  assert.notEqual(value.trim(), "", `de.${key} must not be empty`);
}

// --- Placeholder parity ------------------------------------------------------
// A translation that drops {count} renders a sentence with a hole in it, which
// no type check can catch.
const placeholders = (value) =>
  [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

for (const key of enKeys) {
  assert.deepEqual(
    placeholders(de[key]),
    placeholders(en[key]),
    `de.${key} must use exactly the placeholders en.${key} does`,
  );
}

// --- Every t() key in the source exists --------------------------------------
const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
};

const sourceFiles = walk(path.join(root, "src"));
const usedKeys = new Set();
for (const file of sourceFiles) {
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(/\bt\(\s*"([^"]+)"/g)) {
    usedKeys.add(match[1]);
  }
}

const unknown = [...usedKeys].filter((key) => !(key in en));
assert.deepEqual(unknown, [], "every t() key used in src must exist in en.json");

// --- German must actually be translated --------------------------------------
// Identical strings are legitimate for proper nouns and shared technical terms;
// anything else that matches English exactly is an untranslated leftover.
const ALLOWED_IDENTICAL = new Set([
  "app.name",
  "nav.playlists",
  "collection.genres",
  "collection.labels",
  "collection.bpm",
  "columns.bpm",
  "columns.album",
  "columns.genre",
  "columns.format",
  "columns.bitrate",
  "edit.field.album",
  "edit.field.bpm",
  "edit.field.genre",
  // Loanwords German music software uses unchanged.
  "edit.field.track",
  "edit.field.disc",
  "edit.field.label",
  "analysis.bpmRange",
  "playback.crossfade.seconds",
  "filters.field.album",
  "filters.field.genre",
  "filters.field.bpm",
  "filters.field.label",
  "selection.mix",
  "player.pause",
]);

const untranslated = enKeys.filter(
  (key) => en[key] === de[key] && !ALLOWED_IDENTICAL.has(key),
);
assert.deepEqual(
  untranslated,
  [],
  "these German values are still identical to English; translate them or allowlist them",
);

// --- The German file should not have lost its umlauts -------------------------
// The locale was written without them in places; these spellings are always
// wrong in German and must not come back.
const BAD_SPELLINGS = [
  "hinzugefugt",
  "prufen",
  "ubernehmen",
  "loschen",
  "ausgewahlt",
  "zuruck",
  "verfugbar",
  "konnen",
  "Grosse",
  "Lautstarke",
];
for (const [key, value] of Object.entries(de)) {
  for (const bad of BAD_SPELLINGS) {
    assert.ok(
      !value.toLowerCase().includes(bad.toLowerCase()),
      `de.${key} contains "${bad}", which is missing an umlaut`,
    );
  }
}

console.log(`i18n-smoke: ${enKeys.length} keys verified in 2 locales`);
