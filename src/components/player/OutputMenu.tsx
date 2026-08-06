import { useRef } from "react";
import { Cast, Loader2 } from "lucide-react";
import { t } from "../../i18n";
import {
  useRemoteOutputStore,
  selectRemoteOutputActive,
} from "../../stores/remoteOutputStore";
import { OutputPickerPopover, useOutputPickerToggle } from "./OutputPicker";

// Player-bar trigger for the shared output picker.
export const OutputMenu = () => {
  const sessionState = useRemoteOutputStore((state) => state.sessionState);
  const deviceName = useRemoteOutputStore((state) => state.deviceName);
  const lastError = useRemoteOutputStore((state) => state.lastError);
  const outputActive = useRemoteOutputStore(selectRemoteOutputActive);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const { open, setOpen } = useOutputPickerToggle(containerRef);

  const isConnecting = sessionState === "connecting" || sessionState === "loading";
  const hasSessionError = sessionState === "error" && lastError !== null;

  const buttonTitle = outputActive && deviceName
    ? t("player.output.playingOn", { name: deviceName })
    : t("player.output.tooltip");
  const buttonTone = outputActive
    ? "text-[var(--color-accent)]"
    : hasSessionError
      ? "text-red-500"
      : "text-[var(--color-text-secondary)]";

  return (
    <div ref={containerRef} className="relative">
      <button
        className={`player-bar-button flex h-8 w-8 items-center justify-center rounded-[var(--radius-md)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] ${buttonTone}`}
        onClick={() => setOpen((current) => !current)}
        title={buttonTitle}
        aria-label={buttonTitle}
        aria-haspopup="menu"
        aria-expanded={open}
        type="button"
        data-output-button
        data-output-state={sessionState}
      >
        {isConnecting
          ? <Loader2 className="h-4 w-4 animate-spin" />
          : <Cast className="h-4 w-4" />}
      </button>
      {open && <OutputPickerPopover className="bottom-[calc(100%+10px)] right-0" />}
    </div>
  );
};
