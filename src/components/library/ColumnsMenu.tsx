import { t } from "../../i18n";
import type { ColumnConfig } from "../../types";
import { Popover } from "../ui/Popover";

type ColumnsMenuProps = {
  isOpen: boolean;
  position: { x: number; y: number };
  columns: ColumnConfig[];
  onToggleColumn: (key: ColumnConfig["key"]) => void;
  onClose: () => void;
};

export const ColumnsMenu = ({
  isOpen,
  position,
  columns,
  onToggleColumn,
  onClose,
}: ColumnsMenuProps) => {
  const sortedColumns = [...columns].sort((a, b) =>
    t(a.labelKey).localeCompare(t(b.labelKey), undefined, { sensitivity: "base" })
  );

  return (
    <Popover isOpen={isOpen} position={position} className="w-60 p-3" onClose={onClose}>
      <div className="mb-2 text-xs font-bold uppercase tracking-wider text-[var(--text-muted)]">
        {t("columns.visible")}
      </div>
      <div className="max-h-[min(65vh,560px)] space-y-0.5 overflow-y-auto pr-1" data-columns-list>
        {sortedColumns.map((column) => (
          <label
            key={column.key}
            className="flex cursor-pointer items-center gap-3 rounded-[var(--radius-md)] px-2 py-1.5 text-sm transition-colors duration-100 hover:bg-[var(--color-bg-hover)]"
          >
            <input
              checked={column.visible}
              className="h-4 w-4 cursor-pointer rounded accent-[var(--accent)]"
              onChange={() => onToggleColumn(column.key)}
              type="checkbox"
            />
            <span className="font-medium">{t(column.labelKey)}</span>
          </label>
        ))}
      </div>
    </Popover>
  );
};
