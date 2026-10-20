export const MISSION_COMPETITION_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export function shouldShowCompetitionNotification({
  competitionNumber,
  active,
  suppressedThroughNumber,
  shownThisSession,
}) {
  const number = Number(competitionNumber);
  if (active !== true || !Number.isInteger(number) || number <= 0) return false;
  if (shownThisSession.has(number)) return false;
  const suppressed = Number(suppressedThroughNumber);
  return !Number.isFinite(suppressed) || number > suppressed;
}

export async function closeCompetitionNotificationModal({
  competitionNumber,
  suppressCheckedRef,
  setModal,
  updateConfig,
  onClosed,
}) {
  const suppressChecked = suppressCheckedRef?.current === true;
  if (
    suppressChecked &&
    typeof updateConfig === "function" &&
    Number.isFinite(Number(competitionNumber))
  ) {
    await updateConfig({
      missionCompetitionPopupSuppressedThroughNumber: Math.floor(
        Number(competitionNumber),
      ),
    });
  }
  if (typeof onClosed === "function") {
    onClosed({ competitionNumber, suppressChecked });
  }
  setModal(null);
}

export function formatCompetitionDateTime(value, { locale, timeZone } = {}) {
  const text = String(value || "").trim();
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime())) return text || "Unknown";
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    ...(timeZone ? { timeZone } : {}),
  }).format(parsed);
}

export function startCompetitionChecks(check) {
  let cancelled = false;
  let timer;
  const schedule = (delay) => {
    timer = setTimeout(async () => {
      if (cancelled) return;
      try {
        await check();
      } finally {
        if (!cancelled) schedule(MISSION_COMPETITION_CHECK_INTERVAL_MS);
      }
    }, delay);
  };
  schedule(700);
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}
