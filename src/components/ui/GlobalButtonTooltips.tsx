import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type TooltipTarget = {
  button: HTMLButtonElement;
  label: string;
};

type TooltipPosition = {
  left: number;
  top: number;
  placement: "top" | "bottom";
};

const TOOLTIP_ID = "muro-global-button-tooltip";
const VIEWPORT_MARGIN = 8;
const TOOLTIP_GAP = 8;
const HOVER_DELAY_MS = 250;

const getTooltipTarget = (target: EventTarget | null): TooltipTarget | null => {
  if (!(target instanceof Element)) return null;
  const button = target.closest("button");
  if (!(button instanceof HTMLButtonElement)) return null;
  if (button.textContent?.trim()) return null;

  const label = button.getAttribute("aria-label")?.trim()
    || button.getAttribute("title")?.trim();
  return label ? { button, label } : null;
};

export const GlobalButtonTooltips = () => {
  const [target, setTarget] = useState<TooltipTarget | null>(null);
  const [position, setPosition] = useState<TooltipPosition | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const pendingRef = useRef<TooltipTarget | null>(null);
  const hoverTimerRef = useRef<number | null>(null);

  const clearHoverTimer = () => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    pendingRef.current = null;
  };

  useEffect(() => {
    const show = (nextTarget: TooltipTarget, delayed: boolean) => {
      clearHoverTimer();
      if (!delayed) {
        setTarget(nextTarget);
        return;
      }
      pendingRef.current = nextTarget;
      hoverTimerRef.current = window.setTimeout(() => {
        setTarget(nextTarget);
        pendingRef.current = null;
        hoverTimerRef.current = null;
      }, HOVER_DELAY_MS);
    };

    const hide = (button?: HTMLButtonElement) => {
      if (!button || pendingRef.current?.button === button) clearHoverTimer();
      setTarget((current) => (
        !button || current?.button === button ? null : current
      ));
    };

    const handlePointerOver = (event: PointerEvent) => {
      const nextTarget = getTooltipTarget(event.target);
      if (!nextTarget) return;
      if (
        event.relatedTarget instanceof Node
        && nextTarget.button.contains(event.relatedTarget)
      ) return;
      show(nextTarget, true);
    };

    const handlePointerOut = (event: PointerEvent) => {
      const currentTarget = getTooltipTarget(event.target);
      if (!currentTarget) return;
      if (
        event.relatedTarget instanceof Node
        && currentTarget.button.contains(event.relatedTarget)
      ) return;
      hide(currentTarget.button);
    };

    const handleFocusIn = (event: FocusEvent) => {
      const nextTarget = getTooltipTarget(event.target);
      if (nextTarget) show(nextTarget, false);
    };

    const handleFocusOut = (event: FocusEvent) => {
      const currentTarget = getTooltipTarget(event.target);
      if (currentTarget) hide(currentTarget.button);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };

    document.addEventListener("pointerover", handlePointerOver);
    document.addEventListener("pointerout", handlePointerOut);
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("focusout", handleFocusOut);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      clearHoverTimer();
      document.removeEventListener("pointerover", handlePointerOver);
      document.removeEventListener("pointerout", handlePointerOut);
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("focusout", handleFocusOut);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    if (!target) return;
    const previousDescribedBy = target.button.getAttribute("aria-describedby");
    const describedBy = new Set((previousDescribedBy ?? "").split(/\s+/).filter(Boolean));
    describedBy.add(TOOLTIP_ID);
    target.button.setAttribute("aria-describedby", [...describedBy].join(" "));
    return () => {
      if (previousDescribedBy) target.button.setAttribute("aria-describedby", previousDescribedBy);
      else target.button.removeAttribute("aria-describedby");
    };
  }, [target]);

  useLayoutEffect(() => {
    if (!target || !tooltipRef.current) {
      setPosition(null);
      return;
    }

    const updatePosition = () => {
      const tooltip = tooltipRef.current;
      if (!tooltip || !target.button.isConnected) {
        setTarget(null);
        return;
      }

      const buttonRect = target.button.getBoundingClientRect();
      const tooltipRect = tooltip.getBoundingClientRect();
      const centeredLeft = buttonRect.left + buttonRect.width / 2 - tooltipRect.width / 2;
      const left = Math.min(
        Math.max(VIEWPORT_MARGIN, centeredLeft),
        Math.max(VIEWPORT_MARGIN, window.innerWidth - VIEWPORT_MARGIN - tooltipRect.width),
      );
      const topPosition = buttonRect.top - TOOLTIP_GAP - tooltipRect.height;
      const placement = topPosition >= VIEWPORT_MARGIN ? "top" : "bottom";
      const top = placement === "top"
        ? topPosition
        : Math.min(
            buttonRect.bottom + TOOLTIP_GAP,
            window.innerHeight - VIEWPORT_MARGIN - tooltipRect.height,
          );
      setPosition({ left, top: Math.max(VIEWPORT_MARGIN, top), placement });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    document.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      document.removeEventListener("scroll", updatePosition, true);
    };
  }, [target]);

  if (!target || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={tooltipRef}
      id={TOOLTIP_ID}
      className={`pointer-events-none fixed z-[1000] max-w-[260px] rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2.5 py-1.5 text-center text-[10px] font-medium leading-snug text-[var(--color-text-primary)] shadow-[var(--shadow-md)] transition-opacity duration-100 ${
        position ? "opacity-100" : "opacity-0"
      }`}
      role="tooltip"
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
      }}
      data-global-button-tooltip
      data-tooltip-placement={position?.placement}
    >
      {target.label}
    </div>,
    document.body,
  );
};
