import type { ColumnConfig, Track } from "../types";

export const themes = [
  { id: "system", label: "System" },
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
] as const;

export const baseColumns: ColumnConfig[] = [
  { key: "title", labelKey: "columns.title", visible: true, width: 180 },
  { key: "artist", labelKey: "columns.artist", visible: true, width: 160 },
  { key: "artists", labelKey: "columns.artists", visible: false, width: 220 },
  { key: "album", labelKey: "columns.album", visible: true, width: 120 },
  { key: "trackNumber", labelKey: "columns.trackNumber", visible: false, width: 120 },
  { key: "trackTotal", labelKey: "columns.trackTotal", visible: false, width: 120 },
  { key: "discNumber", labelKey: "columns.discNumber", visible: false, width: 90 },
  { key: "key", labelKey: "columns.key", visible: true, width: 65 },
  { key: "bpm", labelKey: "columns.bpm", visible: true, width: 70 },
  { key: "genre", labelKey: "columns.genre", visible: false, width: 140 },
  { key: "year", labelKey: "columns.year", visible: false, width: 110 },
  { key: "date", labelKey: "columns.date", visible: false, width: 160 },
  { key: "dateAdded", labelKey: "columns.dateAdded", visible: false, width: 170 },
  { key: "dateModified", labelKey: "columns.dateModified", visible: false, width: 180 },
  { key: "lastPlayedAt", labelKey: "columns.lastPlayed", visible: false, width: 180 },
  { key: "playCount", labelKey: "columns.playCount", visible: false, width: 100 },
  { key: "rating", labelKey: "columns.rating", visible: true, width: 110 },
  { key: "duration", labelKey: "columns.duration", visible: true, width: 75 },
  { key: "format", labelKey: "columns.format", visible: true, width: 85 },
  { key: "bitrate", labelKey: "columns.bitrate", visible: false, width: 90 },
  { key: "sampleRate", labelKey: "columns.sampleRate", visible: false, width: 110 },
  { key: "bitDepth", labelKey: "columns.bitDepth", visible: false, width: 95 },
  { key: "fileSize", labelKey: "columns.fileSize", visible: false, width: 100 },
  { key: "comment", labelKey: "columns.comment", visible: false, width: 240 },
  { key: "sourcePath", labelKey: "columns.filePath", visible: false, width: 320 },
];

export const initialTracks: Track[] = [];

export const initialInboxTracks: Track[] = [];
