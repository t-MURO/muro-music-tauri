import { useCallback, useEffect, useRef } from "react";
import { useStickyState } from "./useStickyState";
import { parseDetailWidth } from "../utils";
import { useResizable } from "./useResizable";

const COLLAPSED_QUEUE_PANEL_WIDTH = 40;

export const useQueuePanel = () => {
  const [storedQueuePanelWidth, setQueuePanelWidth] = useStickyState(
    "muro-queue-panel-width",
    328,
    {
      parse: parseDetailWidth,
      serialize: (value) => String(value),
    }
  );
  const [queuePanelCollapsed, setQueuePanelCollapsed] = useStickyState(
    "muro-queue-panel-collapsed",
    false,
    {
      parse: (raw) => raw === "true",
      serialize: (value) => String(value),
    }
  );
  const [queuePanelExpanded, setQueuePanelExpanded] = useStickyState(
    "muro-queue-panel-expanded",
    false,
    {
      parse: (raw) => raw === "true",
      serialize: (value) => String(value),
    }
  );
  const widthRef = useRef(storedQueuePanelWidth);
  const { startResize } = useResizable();
  const queuePanelWidth = queuePanelCollapsed
    ? COLLAPSED_QUEUE_PANEL_WIDTH
    : storedQueuePanelWidth;

  useEffect(() => {
    if (queuePanelCollapsed || queuePanelExpanded) {
      return;
    }

    widthRef.current = storedQueuePanelWidth;
  }, [queuePanelCollapsed, queuePanelExpanded, storedQueuePanelWidth]);

  const toggleQueuePanelCollapsed = useCallback(() => {
    if (!queuePanelCollapsed) {
      widthRef.current = storedQueuePanelWidth;
      setQueuePanelCollapsed(true);
      setQueuePanelExpanded(false);
    } else {
      setQueuePanelWidth(widthRef.current || 328);
      setQueuePanelCollapsed(false);
    }
  }, [
    queuePanelCollapsed,
    setQueuePanelCollapsed,
    setQueuePanelExpanded,
    setQueuePanelWidth,
    storedQueuePanelWidth,
  ]);

  const toggleQueuePanelExpanded = useCallback(() => {
    if (queuePanelExpanded) {
      setQueuePanelWidth(Math.max(260, Math.min(420, widthRef.current || 328)));
      setQueuePanelExpanded(false);
      return;
    }
    widthRef.current = Math.max(260, Math.min(420, queuePanelWidth));
    const expandedWidth = Math.min(640, Math.max(480, Math.round(window.innerWidth * 0.4)));
    setQueuePanelWidth(expandedWidth);
    setQueuePanelExpanded(true);
  }, [queuePanelExpanded, queuePanelWidth, setQueuePanelExpanded, setQueuePanelWidth]);

  const startQueuePanelResize = useCallback(
    (event: React.MouseEvent) => {
      startResize(
        event,
        queuePanelWidth,
        (nextWidth) => {
          setQueuePanelWidth(Math.min(720, nextWidth));
        },
        { minSize: 240, maxSize: 720, direction: -1 }
      );
    },
    [queuePanelWidth, setQueuePanelWidth, startResize]
  );

  return {
    queuePanelCollapsed,
    queuePanelExpanded,
    queuePanelWidth,
    setQueuePanelWidth,
    startQueuePanelResize,
    toggleQueuePanelCollapsed,
    toggleQueuePanelExpanded,
  };
};
