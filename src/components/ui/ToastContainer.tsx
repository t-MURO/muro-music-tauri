import { useEffect } from "react";
import { X, CheckCircle, AlertCircle, Info } from "lucide-react";
import { useNotificationStore, type Notification } from "../../stores";

const TOAST_DURATION = 4000;

type ToastProps = {
  notification: Notification;
  onDismiss: (id: string) => void;
};

const Toast = ({ notification, onDismiss }: ToastProps) => {
  useEffect(() => {
    const timer = setTimeout(() => {
      onDismiss(notification.id);
    }, TOAST_DURATION);

    return () => clearTimeout(timer);
  }, [notification.id, onDismiss]);

  const Icon =
    notification.type === "success"
      ? CheckCircle
      : notification.type === "error"
        ? AlertCircle
        : Info;

  const iconColor =
    notification.type === "success"
      ? "text-green-500"
      : notification.type === "error"
        ? "text-red-500"
        : "text-blue-500";

  return (
    <div className="flex items-start gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-4 py-3 shadow-lg">
      <Icon className={`h-5 w-5 shrink-0 ${iconColor}`} />
      <p className="flex-1 text-sm text-[var(--color-text-primary)]">
        {notification.message}
      </p>
      <button
        onClick={() => onDismiss(notification.id)}
        className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
        aria-label="Dismiss notification"
        title="Dismiss notification"
        type="button"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
};

export const ToastContainer = () => {
  const notifications = useNotificationStore((s) => s.notifications);
  const removeNotification = useNotificationStore((s) => s.removeNotification);

  if (notifications.length === 0) {
    return null;
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {notifications.map((notification) => (
        <Toast
          key={notification.id}
          notification={notification}
          onDismiss={removeNotification}
        />
      ))}
    </div>
  );
};
