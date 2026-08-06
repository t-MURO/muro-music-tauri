import { useCallback, useEffect, useRef } from "react";
import { useResizable } from "./useResizable";
import { useStickyState } from "./useStickyState";
import { parseNumber } from "../utils";

export const useSidebarPanel = () => {
  const [sidebarWidth, setSidebarWidth] = useStickyState(
    "muro-sidebar-width",
    228,
    {
      parse: parseNumber(228),
      serialize: (value) => String(value),
    }
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useStickyState(
    "muro-sidebar-collapsed",
    false,
    {
      parse: (raw) => raw === "true",
      serialize: (value) => String(value),
    }
  );
  const widthRef = useRef(sidebarWidth);
  const { startResize } = useResizable();

  useEffect(() => {
    if (!sidebarCollapsed) widthRef.current = sidebarWidth;
  }, [sidebarCollapsed, sidebarWidth]);

  const toggleSidebarCollapsed = useCallback(() => {
    if (sidebarCollapsed) {
      setSidebarWidth(Math.max(200, widthRef.current || 228));
      setSidebarCollapsed(false);
      return;
    }
    widthRef.current = sidebarWidth;
    setSidebarWidth(56);
    setSidebarCollapsed(true);
  }, [setSidebarCollapsed, setSidebarWidth, sidebarCollapsed, sidebarWidth]);

  const startSidebarResize = useCallback(
    (event: React.MouseEvent) => {
      if (sidebarCollapsed) return;
      startResize(
        event,
        sidebarWidth,
        (nextWidth) => {
          setSidebarWidth(Math.min(360, nextWidth));
        },
        { minSize: 200, maxSize: 360 }
      );
    },
    [sidebarCollapsed, sidebarWidth, setSidebarWidth, startResize]
  );

  return {
    sidebarCollapsed,
    sidebarWidth,
    startSidebarResize,
    toggleSidebarCollapsed,
  };
};
