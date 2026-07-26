// SPDX-License-Identifier: MIT
import {
  type ButtonHTMLAttributes,
  type MouseEvent,
  useCallback,
  useEffect,
  useState,
} from "react";

import {
  type NotificationPreference,
  LEGACY_NOTIFICATIONS_STORAGE_KEY,
  NOTIFICATIONS_STORAGE_KEY,
  notificationPreference,
  toggleNotificationPreference,
} from "../notifications";
import { Icon } from "./Icon";

export interface NotificationBellProps
  extends Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "aria-label" | "aria-pressed" | "children" | "onClick" | "title" | "type"
  > {
  readonly iconSize?: number;
  readonly onPreferenceChange?: (preference: NotificationPreference) => void;
}

export function notificationPreferenceLabel(preference: NotificationPreference): string {
  if (preference === "enabled") return "Disable notifications";
  if (preference === "denied") return "Notifications blocked in browser settings";
  if (preference === "unsupported") return "Notifications unavailable";
  return "Enable notifications";
}

export function NotificationBell({
  className,
  disabled,
  iconSize = 15,
  onPreferenceChange,
  ...buttonProps
}: NotificationBellProps) {
  const [preference, setPreference] = useState<NotificationPreference>(notificationPreference);
  const [updating, setUpdating] = useState(false);

  const refresh = useCallback(() => {
    const next = notificationPreference();
    setPreference(next);
    onPreferenceChange?.(next);
  }, [onPreferenceChange]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (
        event.key === null
        || event.key === NOTIFICATIONS_STORAGE_KEY
        || event.key === LEGACY_NOTIFICATIONS_STORAGE_KEY
      ) {
        refresh();
      }
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, [refresh]);

  const onClick = useCallback(async (_event: MouseEvent<HTMLButtonElement>) => {
    if (preference === "denied") {
      window.dispatchEvent(new CustomEvent("mono-agent:notice", {
        detail: {
          message: "Notifications are blocked. Allow them in this browser’s site settings.",
        },
      }));
      return;
    }
    setUpdating(true);
    try {
      const next = await toggleNotificationPreference();
      setPreference(next);
      onPreferenceChange?.(next);
    } finally {
      setUpdating(false);
    }
  }, [onPreferenceChange, preference]);

  const label = notificationPreferenceLabel(preference);
  const unavailable = preference === "unsupported";
  const classes = [
    "notification-bell",
    preference === "enabled" ? "is-enabled" : "",
    className ?? "",
  ].filter(Boolean).join(" ");

  return (
    <button
      {...buttonProps}
      type="button"
      className={classes}
      aria-label={label}
      aria-pressed={preference === "enabled"}
      title={label}
      data-notification-preference={preference}
      data-notification-pending={updating || undefined}
      disabled={disabled === true || unavailable || updating}
      onClick={onClick}
    >
      <Icon name="bell" size={iconSize} />
    </button>
  );
}
