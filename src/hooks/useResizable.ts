import { useCallback } from "react";

type ResizeOptions = {
  minSize?: number;
  maxSize?: number;
  direction?: 1 | -1;
  stopPropagation?: boolean;
};

export const useResizable = () => {
  const startResize = useCallback(
    (
      event: React.MouseEvent,
      initialSize: number,
      onResize: (newSize: number) => void,
      options: ResizeOptions = {}
    ) => {
      event.preventDefault();
      if (options.stopPropagation) {
        event.stopPropagation();
      }

      const startX = event.clientX;
      const direction = options.direction ?? 1;
      const minSize = options.minSize ?? 50;
      const maxSize = options.maxSize ?? 500;
      document.documentElement.dataset.panelResizing = "true";

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const delta = (moveEvent.clientX - startX) * direction;
        const nextSize = Math.max(
          minSize,
          Math.min(maxSize, initialSize + delta)
        );
        onResize(nextSize);
      };

      const handleMouseUp = () => {
        delete document.documentElement.dataset.panelResizing;
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
        window.removeEventListener("blur", handleMouseUp);
      };

      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
      window.addEventListener("blur", handleMouseUp);
    },
    []
  );

  return { startResize };
};
