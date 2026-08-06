import { useCallback } from "react";
import { baseColumns } from "../data/library";
import { t } from "../i18n";
import type { ColumnConfig, Track } from "../types";
import { useStickyState } from "./useStickyState";
import { parseColumns } from "../utils";

type UseColumnsArgs = {
  tracks: Track[];
};

export const useColumns = ({ tracks }: UseColumnsArgs) => {
  const [columns, setColumns] = useStickyState("muro-columns", baseColumns, {
    parse: parseColumns,
    serialize: (value) => JSON.stringify(value),
  });

  const toggleColumn = useCallback(
    (key: ColumnConfig["key"]) => {
      setColumns((current) =>
        current.map((column) =>
          column.key === key
            ? { ...column, visible: !column.visible }
            : column
        )
      );
    },
    [setColumns]
  );

  const autoFitColumn = useCallback(
    (key: ColumnConfig["key"]) => {
      const column = columns.find((item) => item.key === key);
      if (!column) {
        return;
      }

      const maxLength = Math.max(
        t(column.labelKey as typeof column.labelKey).length,
        ...tracks.map((track) => {
          if (key === "format") {
            const pathParts = track.sourcePath.split(/[\\/]/);
            const filename = pathParts[pathParts.length - 1] ?? "";
            const extensionParts = filename.split(".");
            return filename.includes(".") ? (extensionParts[extensionParts.length - 1]?.length ?? 0) : 0;
          }
          const value = track[key as keyof Track];
          return value === undefined || value === null ? 0 : String(value).length;
        })
      );
      const nextWidth = Math.min(360, Math.max(120, maxLength * 8 + 48));

      setColumns((current) =>
        current.map((item) =>
          item.key === key ? { ...item, width: nextWidth } : item
        )
      );
    },
    [columns, setColumns, tracks]
  );

  const handleColumnResize = useCallback(
    (key: ColumnConfig["key"], width: number) => {
      setColumns((current) =>
        current.map((column) =>
          column.key === key ? { ...column, width } : column
        )
      );
    },
    [setColumns]
  );

  const reorderColumns = useCallback(
    (dragKey: ColumnConfig["key"], targetIndex: number) => {
      setColumns((current) => {
        const visibleKeys = current
          .filter((column) => column.visible)
          .map((column) => column.key);
        if (!visibleKeys.includes(dragKey)) {
          return current;
        }

        const nextVisible = visibleKeys.filter((key) => key !== dragKey);
        const clampedIndex = Math.max(
          0,
          Math.min(nextVisible.length, targetIndex)
        );
        nextVisible.splice(clampedIndex, 0, dragKey);

        const byKey = new Map(current.map((column) => [column.key, column]));
        let visibleIndex = 0;
        return current.map((column) => {
          if (!column.visible) {
            return column;
          }
          const key = nextVisible[visibleIndex];
          visibleIndex += 1;
          return key ? (byKey.get(key) ?? column) : column;
        });
      });
    },
    [setColumns]
  );

  return { autoFitColumn, columns, handleColumnResize, reorderColumns, toggleColumn };
};
