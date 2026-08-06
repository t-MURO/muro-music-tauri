import { baseColumns } from "../data/library";
import type { ColumnConfig } from "../types";

export const parseColumns = (raw: string): ColumnConfig[] => {
  try {
    const parsed = JSON.parse(raw) as ColumnConfig[];
    const savedByKey = new Map(parsed.map((column) => [column.key, column]));
    const hasFormatColumn = savedByKey.has("format");
    const ordered = parsed
      .map((column) => {
        const base = baseColumns.find((item) => item.key === column.key);
        if (!base) {
          return null;
        }
        const merged = { ...base, ...column, labelKey: base.labelKey };
        return !hasFormatColumn && merged.key === "bitrate"
          ? { ...merged, visible: false }
          : merged;
      })
      .filter((column): column is ColumnConfig => column !== null);
    const missing = baseColumns.filter((column) => !savedByKey.has(column.key));
    const merged = [...ordered, ...missing];
    if (!hasFormatColumn) {
      const formatIndex = merged.findIndex((column) => column.key === "format");
      if (formatIndex >= 0) {
        const [formatColumn] = merged.splice(formatIndex, 1);
        const bitrateIndex = merged.findIndex((column) => column.key === "bitrate");
        merged.splice(bitrateIndex >= 0 ? bitrateIndex : merged.length, 0, formatColumn);
      }
    }
    return merged;
  } catch {
    return baseColumns;
  }
};

export const parseNumber = (fallback: number) => (raw: string) => {
  const parsed = Number(raw);
  return Number.isNaN(parsed) ? fallback : parsed;
};

export const parseDetailWidth = (raw: string) => {
  const parsed = Number(raw);
  const saved = Number.isNaN(parsed) ? 320 : parsed;
  return saved <= 56 ? 320 : saved;
};
