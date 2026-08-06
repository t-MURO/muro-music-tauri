import { Plus, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  SmartCrate,
  SmartCrateField,
  SmartCrateOperator,
  SmartCrateRule,
} from "../../types";

type SmartCrateInput = Omit<SmartCrate, "id">;

type SmartCrateModalProps = {
  isOpen: boolean;
  crate: SmartCrate | null;
  onClose: () => void;
  onSave: (crate: SmartCrateInput) => void;
};

type FieldDefinition = {
  label: string;
  input: "number" | "text";
  operators: SmartCrateOperator[];
  placeholder?: string;
};

const FIELD_DEFINITIONS: Record<SmartCrateField, FieldDefinition> = {
  bpm: { label: "BPM", input: "number", operators: ["between", "atLeast", "atMost", "equals"] },
  key: { label: "Key", input: "text", operators: ["equals", "contains"], placeholder: "8A or Am" },
  genre: { label: "Genre", input: "text", operators: ["contains", "equals"], placeholder: "House" },
  rating: { label: "Rating", input: "number", operators: ["atLeast", "atMost", "equals", "between"] },
  artist: { label: "Artist", input: "text", operators: ["contains", "equals"] },
  album: { label: "Album", input: "text", operators: ["contains", "equals"] },
  year: { label: "Year", input: "number", operators: ["between", "atLeast", "atMost", "equals"] },
  dateAdded: { label: "Date added", input: "number", operators: ["withinDays"], placeholder: "30" },
  playCount: { label: "Play count", input: "number", operators: ["atLeast", "atMost", "equals", "between"] },
  comment: { label: "Comment", input: "text", operators: ["contains", "equals"] },
};

const OPERATOR_LABELS: Record<SmartCrateOperator, string> = {
  equals: "is",
  contains: "contains",
  atLeast: "at least",
  atMost: "at most",
  between: "between",
  withinDays: "within the last (days)",
};

const createRuleId = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const createRule = (field: SmartCrateField = "bpm"): SmartCrateRule => ({
  id: createRuleId(),
  field,
  operator: FIELD_DEFINITIONS[field].operators[0],
  value: field === "bpm" ? "118" : field === "rating" ? "3" : "",
  secondaryValue: field === "bpm" ? "124" : undefined,
});

export const SmartCrateModal = ({
  isOpen,
  crate,
  onClose,
  onSave,
}: SmartCrateModalProps) => {
  const [name, setName] = useState("");
  const [match, setMatch] = useState<"all" | "any">("all");
  const [rules, setRules] = useState<SmartCrateRule[]>([createRule()]);
  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setName(crate?.name ?? "");
    setMatch(crate?.match ?? "all");
    setRules(crate?.rules.length ? crate.rules.map((rule) => ({ ...rule })) : [createRule()]);
    const focusId = window.setTimeout(() => nameRef.current?.focus(), 0);
    return () => window.clearTimeout(focusId);
  }, [crate, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  const canSave = useMemo(
    () => name.trim().length > 0 && rules.length > 0 && rules.every((rule) => rule.value.trim().length > 0),
    [name, rules],
  );

  const updateRule = (id: string, updates: Partial<SmartCrateRule>) => {
    setRules((current) => current.map((rule) => rule.id === id ? { ...rule, ...updates } : rule));
  };

  if (!isOpen || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="modal-overlay-animate fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-[var(--spacing-lg)] backdrop-blur-sm"
      onClick={onClose}
      data-smart-crate-modal
    >
      <div
        className="modal-panel-animate flex max-h-[82vh] w-full max-w-[760px] flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] shadow-[var(--shadow-lg)]"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="smart-crate-title"
      >
        <div className="flex items-start gap-3 border-b border-[var(--color-border)] px-6 py-5">
          <div className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius-md)] bg-[var(--color-accent-light)] text-[var(--color-accent)]">
            <Sparkles className="h-[18px] w-[18px]" />
          </div>
          <div>
            <h2 id="smart-crate-title" className="text-[16px] font-semibold text-[var(--color-text-primary)]">
              {crate ? "Edit Smart Crate" : "New Smart Crate"}
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
              Tracks enter and leave this crate automatically as their metadata changes.
            </p>
          </div>
        </div>

        <form
          className="min-h-0 overflow-y-auto px-6 py-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSave) return;
            onSave({ name: name.trim(), match, rules });
          }}
        >
          <label className="block">
            <span className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-secondary)]">Name</span>
            <input
              ref={nameRef}
              className="h-10 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 text-[13px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-light)]"
              placeholder="e.g. Warm-up house"
              value={name}
              onChange={(event) => setName(event.target.value)}
              data-smart-crate-name
            />
          </label>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <span className="text-[12px] font-medium text-[var(--color-text-secondary)]">Match</span>
            <div className="inline-flex rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-0.5">
              {(["all", "any"] as const).map((mode) => (
                <button
                  key={mode}
                  className={`rounded-[calc(var(--radius-md)-2px)] px-3 py-1.5 text-[11px] font-medium transition-colors ${match === mode ? "bg-[var(--color-bg-active)] text-[var(--color-text-primary)] shadow-sm" : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"}`}
                  onClick={() => setMatch(mode)}
                  aria-pressed={match === mode}
                  type="button"
                >
                  {mode === "all" ? "All rules" : "Any rule"}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-5 space-y-2.5" data-smart-crate-rules>
            {rules.map((rule, index) => {
              const definition = FIELD_DEFINITIONS[rule.field];
              return (
                <div
                  key={rule.id}
                  className="grid grid-cols-[24px_minmax(120px,0.9fr)_minmax(140px,1fr)_minmax(110px,1fr)_32px] items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-light)] bg-[var(--color-bg-secondary)] p-3"
                  data-smart-crate-rule
                >
                  <span className="text-center text-[10px] tabular-nums text-[var(--color-text-muted)]">{index + 1}</span>
                  <select
                    className="h-9 min-w-0 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 text-[12px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
                    value={rule.field}
                    onChange={(event) => {
                      const field = event.target.value as SmartCrateField;
                      const next = createRule(field);
                      updateRule(rule.id, {
                        field,
                        operator: next.operator,
                        value: next.value,
                        secondaryValue: next.secondaryValue,
                      });
                    }}
                    aria-label={`Rule ${index + 1} field`}
                  >
                    {(Object.keys(FIELD_DEFINITIONS) as SmartCrateField[]).map((field) => (
                      <option key={field} value={field}>{FIELD_DEFINITIONS[field].label}</option>
                    ))}
                  </select>
                  <select
                    className="h-9 min-w-0 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 text-[12px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
                    value={rule.operator}
                    onChange={(event) => updateRule(rule.id, {
                      operator: event.target.value as SmartCrateOperator,
                      secondaryValue: event.target.value === "between" ? rule.secondaryValue ?? "" : undefined,
                    })}
                    aria-label={`Rule ${index + 1} operator`}
                  >
                    {definition.operators.map((operator) => (
                      <option key={operator} value={operator}>{OPERATOR_LABELS[operator]}</option>
                    ))}
                  </select>
                  <div className={`grid min-w-0 ${rule.operator === "between" ? "grid-cols-[1fr_auto_1fr] items-center gap-1.5" : "grid-cols-1"}`}>
                    <input
                      className="h-9 min-w-0 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 text-[12px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)]"
                      type={definition.input}
                      placeholder={definition.placeholder}
                      value={rule.value}
                      onChange={(event) => updateRule(rule.id, { value: event.target.value })}
                      aria-label={`Rule ${index + 1} value`}
                    />
                    {rule.operator === "between" && (
                      <>
                        <span className="text-[10px] text-[var(--color-text-muted)]">and</span>
                        <input
                          className="h-9 min-w-0 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 text-[12px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
                          type="number"
                          value={rule.secondaryValue ?? ""}
                          onChange={(event) => updateRule(rule.id, { secondaryValue: event.target.value })}
                          aria-label={`Rule ${index + 1} maximum value`}
                        />
                      </>
                    )}
                  </div>
                  <button
                    className="toolbar-icon-button h-8 w-8"
                    onClick={() => setRules((current) => current.filter((item) => item.id !== rule.id))}
                    title="Remove rule"
                    aria-label={`Remove rule ${index + 1}`}
                    type="button"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>

          <button
            className="mt-3 inline-flex h-9 items-center gap-2 rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] px-3 text-[12px] font-medium text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-text-primary)]"
            onClick={() => setRules((current) => [...current, createRule("genre")])}
            data-smart-crate-add-rule
            type="button"
          >
            <Plus className="h-3.5 w-3.5" />
            Add rule
          </button>

          <div className="mt-6 flex items-center justify-end gap-2 border-t border-[var(--color-border-light)] pt-4">
            <button className="h-9 rounded-[var(--radius-md)] px-4 text-[12px] font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]" onClick={onClose} type="button">
              Cancel
            </button>
            <button
              className="h-9 rounded-[var(--radius-md)] bg-[var(--color-accent)] px-4 text-[12px] font-semibold text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!canSave}
              data-smart-crate-save
              type="submit"
            >
              {crate ? "Save changes" : "Create Smart Crate"}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
};
