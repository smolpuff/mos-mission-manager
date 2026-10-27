import { useEffect, useRef, useState, useCallback } from "react";
import { createAnnouncementDisplay } from "./live-announcements.mjs";

// Keep session dismissals when the control page unmounts and mounts again.
const announcementSession = { seen: new Set(), checked: false };

export function useLiveAnnouncements(bridge, blocked) {
  const [announcement, setAnnouncement] = useState(null);
  const controller = useRef(null);
  useEffect(() => {
    if (!bridge?.checkAnnouncements || !bridge?.markAnnouncementSeen) return;
    const display = createAnnouncementDisplay({
      check: () => bridge.checkAnnouncements(),
      markSeen: (id, automatic = false) => bridge.markAnnouncementSeen(id, automatic),
      onChange: setAnnouncement,
      session: announcementSession,
    });
    controller.current = display;
    return () => { display.dispose(); controller.current = null; };
  }, [bridge]);
  useEffect(() => {
    const refresh = () => controller.current?.setBlocked(blocked);
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [bridge, blocked]);
  const dismiss = useCallback((permanent = false) => controller.current?.dismiss(permanent), []);
  return { announcement: blocked ? null : announcement, dismiss };
}
