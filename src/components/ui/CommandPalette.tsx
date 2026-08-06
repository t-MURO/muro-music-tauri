import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search } from "lucide-react";

export type CommandPaletteItem = {
  id: string;
  label: string;
  keywords?: string;
  shortcut?: string;
  run: () => void;
};

type CommandPaletteProps = {
  isOpen: boolean;
  commands: CommandPaletteItem[];
  onClose: () => void;
};

export const CommandPalette = ({ isOpen, commands, onClose }: CommandPaletteProps) => {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return commands;
    return commands.filter((command) =>
      `${command.label} ${command.keywords ?? ""}`.toLocaleLowerCase().includes(normalized));
  }, [commands, query]);

  useEffect(() => {
    if (!isOpen) return;
    setQuery("");
    setActiveIndex(0);
    queueMicrotask(() => inputRef.current?.focus());
  }, [isOpen]);

  if (!isOpen || typeof document === "undefined") return null;
  const run = (command: CommandPaletteItem | undefined) => {
    if (!command) return;
    onClose();
    command.run();
  };

  return createPortal(
    <div className="modal-overlay-animate fixed inset-0 z-[70] flex items-start justify-center bg-black/45 px-4 pt-[12vh] backdrop-blur-sm" onClick={onClose}>
      <div
        className="modal-panel-animate w-full max-w-[620px] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] shadow-[var(--shadow-lg)]"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <label className="relative block border-b border-[var(--color-border)]">
          <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <input
            ref={inputRef}
            className="h-14 w-full bg-transparent pl-11 pr-4 text-[15px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)]"
            placeholder="Type a command…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex((value) => Math.min(results.length - 1, value + 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((value) => Math.max(0, value - 1));
              } else if (event.key === "Enter") {
                event.preventDefault();
                run(results[activeIndex]);
              }
            }}
          />
        </label>
        <div className="max-h-[50vh] overflow-y-auto p-2">
          {results.map((command, index) => (
            <button
              key={command.id}
              className={`flex w-full items-center justify-between gap-4 rounded-[var(--radius-md)] px-3 py-2.5 text-left text-[13px] ${
                index === activeIndex ? "bg-[var(--color-bg-active)] text-[var(--color-text-primary)]" : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
              }`}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => run(command)}
              type="button"
            >
              <span>{command.label}</span>
              {command.shortcut && <kbd className="text-[10px] text-[var(--color-text-muted)]">{command.shortcut}</kbd>}
            </button>
          ))}
          {results.length === 0 && <p className="px-3 py-8 text-center text-[12px] text-[var(--color-text-muted)]">No matching commands</p>}
        </div>
      </div>
    </div>,
    document.body,
  );
};
