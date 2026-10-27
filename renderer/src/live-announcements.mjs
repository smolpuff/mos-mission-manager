export const ANNOUNCEMENT_CHECK_MS = 30 * 60 * 1000;
export function announcementIsActive(item, now = Date.now()) {
  return item?.enabled === true && Date.parse(item.startsAt) <= now && now < Date.parse(item.endsAt);
}

// No polling of the DOM, mission state, or wallet. Only the small announcement feed.
export function createAnnouncementDisplay({ check, markSeen, onChange, session = { seen: new Set(), checked: false }, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let blocked = true, disposed = false, active = null, feed = [], timer, pending = false, nextCheck = 0;
  let allowNext = true;
  const seen = session.seen;
  let startupIds = new Set();
  function render() {
    onChange(!blocked && active && announcementIsActive(active, now()) ? active : null);
  }
  function schedule() {
    clearTimer(timer);
    if (disposed || blocked) return;
    const time = now();
    const boundaries = feed.flatMap(item => [Date.parse(item.startsAt), Date.parse(item.endsAt)]).filter(at => at > time);
    const due = Math.min(nextCheck || time, ...boundaries);
    timer = setTimer(() => { void tick(); }, Math.max(1, Math.min(ANNOUNCEMENT_CHECK_MS, due - time)));
  }
  async function tick() {
    if (disposed || blocked || pending) return;
    pending = true;
    try {
      if (now() >= nextCheck) {
        nextCheck = now() + ANNOUNCEMENT_CHECK_MS;
        allowNext = true;
        try { feed = await check(); } catch { feed = []; }
        if (disposed) return;
        if (!Array.isArray(feed)) feed = [];
        if (!session.checked) {
          startupIds = new Set(feed.filter(item => announcementIsActive(item, now())).map(item => item.id));
          session.checked = true;
        }
        if (active && !feed.some(item => item.id === active.id)) active = null;
      }
      if (disposed) return;
      if (active && !announcementIsActive(active, now())) active = null;
      if (!blocked && !active && allowNext) {
        active = feed.find(item => !seen.has(item.id) && (!item.automaticSeen || startupIds.has(item.id)) && announcementIsActive(item, now())) || null;
        if (active) {
          active = { ...active, canSuppress: startupIds.has(active.id) };
          startupIds.clear();
          seen.add(active.id);
          const id = active.id;
          void Promise.resolve().then(() => markSeen(id, true)).catch(() => {});
          allowNext = false; // Never stack announcements back-to-back after Dismiss.
        }
      }
      render();
    } finally { pending = false; schedule(); }
  }
  return {
    setBlocked(value) {
      blocked = Boolean(value);
      render();
      if (blocked) clearTimer(timer);
      else void tick();
    },
    dismiss(permanent = false) {
      const id = active?.id;
      const canSuppress = active?.canSuppress;
      active = null;
      render();
      schedule();
      if (permanent === true && canSuppress && id) void Promise.resolve().then(() => markSeen(id)).catch(() => {});
    },
    dispose() { disposed = true; clearTimer(timer); },
  };
}
