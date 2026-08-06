import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

type PopoverProps = {
  isOpen: boolean;
  position: { x: number; y: number };
  children: ReactNode;
  className?: string;
  onClose: () => void;
};

const VIEWPORT_MARGIN = 8;

type ResolvedPosition = {
  left: number;
  top: number;
  horizontal: "left" | "right";
  vertical: "up" | "down";
};

export const Popover = ({
  isOpen,
  position,
  children,
  className = "",
  onClose,
}: PopoverProps) => {
  const [shouldRender, setShouldRender] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [resolvedPosition, setResolvedPosition] = useState<ResolvedPosition>({
    left: position.x,
    top: position.y,
    horizontal: "right",
    vertical: "down",
  });
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && panelRef.current?.contains(target)) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  useEffect(() => {
    if (isOpen) {
      setShouldRender(true);
    } else if (shouldRender) {
      setIsVisible(false);
      const timer = setTimeout(() => {
        setShouldRender(false);
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [isOpen, shouldRender]);

  useLayoutEffect(() => {
    if (!shouldRender || !isOpen || !panelRef.current) return;

    const updatePosition = () => {
      const panel = panelRef.current;
      if (!panel) return;
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - VIEWPORT_MARGIN - width);
      const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - VIEWPORT_MARGIN - height);
      const horizontal = position.x + width > window.innerWidth - VIEWPORT_MARGIN ? "left" : "right";
      const vertical = position.y + height > window.innerHeight - VIEWPORT_MARGIN ? "up" : "down";
      const left = Math.min(
        Math.max(VIEWPORT_MARGIN, horizontal === "left" ? position.x - width : position.x),
        maxLeft,
      );
      const top = Math.min(
        Math.max(VIEWPORT_MARGIN, vertical === "up" ? position.y - height : position.y),
        maxTop,
      );
      setResolvedPosition((current) => (
        current.left === left
        && current.top === top
        && current.horizontal === horizontal
        && current.vertical === vertical
          ? current
          : { left, top, horizontal, vertical }
      ));
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    return () => window.removeEventListener("resize", updatePosition);
  }, [children, isOpen, position.x, position.y, shouldRender]);

  // Trigger enter animation after mount
  useLayoutEffect(() => {
    if (shouldRender && isOpen) {
      requestAnimationFrame(() => {
        setIsVisible(true);
      });
    }
  }, [shouldRender, isOpen]);

  if (!shouldRender || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      ref={panelRef}
      className={`fixed z-50 overflow-x-hidden overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--panel-border)] bg-[var(--panel-bg)]/95 text-sm shadow-[var(--shadow-lg)] backdrop-blur-xl transition-all duration-150 ease-out ${
        isVisible ? "scale-100 opacity-100" : "scale-95 opacity-0"
      } ${className}`}
      onClick={(event) => event.stopPropagation()}
      style={{
        left: resolvedPosition.left,
        top: resolvedPosition.top,
        maxWidth: `calc(100vw - ${VIEWPORT_MARGIN * 2}px)`,
        maxHeight: `calc(100vh - ${VIEWPORT_MARGIN * 2}px)`,
        transformOrigin: `${resolvedPosition.horizontal === "left" ? "right" : "left"} ${resolvedPosition.vertical === "up" ? "bottom" : "top"}`,
      }}
      data-popover
      data-popover-horizontal={resolvedPosition.horizontal}
      data-popover-vertical={resolvedPosition.vertical}
    >
      {children}
    </div>,
    document.body
  );
};

type PopoverItemProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  children: ReactNode;
  variant?: "default" | "danger";
  dataTestId?: string;
};

export const PopoverItem = ({
  children,
  variant = "default",
  dataTestId,
  className = "",
  ...buttonProps
}: PopoverItemProps) => {
  const baseClass =
    "flex w-full items-center gap-3 px-3 py-2 text-left transition-colors duration-100";
  const variantClass =
    variant === "danger"
      ? "text-red-500 hover:bg-red-500/10"
      : "text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]";

  return (
    <button
      {...buttonProps}
      className={`${baseClass} ${variantClass} ${className}`}
      data-testid={dataTestId}
      type={buttonProps.type ?? "button"}
    >
      {children}
    </button>
  );
};

export const PopoverDivider = () => (
  <div className="mx-2 my-1 h-px bg-[var(--panel-border)]" />
);

export const PopoverHeader = ({ children }: { children: ReactNode }) => (
  <div className="mx-2 mb-1 rounded-[var(--radius-md)] bg-[var(--accent-soft)] px-2 py-1 text-xs font-medium text-[var(--accent)]">
    {children}
  </div>
);
