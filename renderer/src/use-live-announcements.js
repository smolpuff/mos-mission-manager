import { useEffect, useRef, useState, useCallback } from "react";
import { createAnnouncementDisplay } from "./live-announcements.mjs";

export function useLiveAnnouncements(bridge, blocked) {
  const [announcement, setAnnouncement] = useState(null);
  const controller = useRef(null);
  useEffect(() => {
    if (!bridge?.checkAnnouncements || !bridge?.markAnnouncementSeen) return;
    const display = createAnnouncementDisplay({
      check: () => bridge.checkAnnouncements(),
      markSeen: id => bridge.markAnnouncementSeen(id),
      onChange: setAnnouncement,
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
  const dismiss = useCallback(() => controller.current?.dismiss(), []);
  return { announcement: blocked ? null : announcement, dismiss };
}
