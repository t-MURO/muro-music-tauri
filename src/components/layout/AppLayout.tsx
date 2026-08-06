import type { ReactNode } from "react";

type AppLayoutProps = {
  onSidebarResizeStart: (event: React.MouseEvent) => void;
  onQueuePanelResizeStart: (event: React.MouseEvent) => void;
  sidebarCollapsed: boolean;
  detailCollapsed: boolean;
  sidebar: ReactNode;
  main: ReactNode;
  detail: ReactNode;
};

export const AppLayout = ({
  onSidebarResizeStart,
  onQueuePanelResizeStart,
  sidebarCollapsed,
  detailCollapsed,
  sidebar,
  main,
  detail,
}: AppLayoutProps) => {
  return (
    <>
      {/* Sidebar - grid-column: 1, grid-row: 1 / 3 */}
      <div className="col-start-1 row-span-2 row-start-1 relative">
        {sidebar}
        <div
          className={`panel-resize-handle absolute right-0 top-0 h-full w-1 cursor-col-resize ${sidebarCollapsed ? "hidden" : ""}`}
          role="separator"
          aria-orientation="vertical"
          onMouseDown={onSidebarResizeStart}
        />
      </div>

      {/* Main content - grid-column: 2, grid-row: 1 / 3 */}
      <div className="col-start-2 row-span-2 row-start-1 flex flex-col overflow-hidden">
        {main}
      </div>

      {/* Queue/Detail panel - grid-column: 3, grid-row: 1 / 3 */}
      <div className="col-start-3 row-span-2 row-start-1 relative">
        {detail}
        <div
          className={`panel-resize-handle absolute left-0 top-0 h-full w-1 cursor-col-resize ${detailCollapsed ? "hidden" : ""}`}
          role="separator"
          aria-orientation="vertical"
          onMouseDown={onQueuePanelResizeStart}
        />
      </div>
    </>
  );
};
