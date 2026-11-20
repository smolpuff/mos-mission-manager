import competitions from "../../src/analytics-competitions.json" with { type: "json" };

// Keep early preview disabled for the scheduled competition.
const RESET_COMPETITION_PREVIEW = false;

function easternOffset(at) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "longOffset" })
    .formatToParts(at).find(part => part.type === "timeZoneName").value;
  const [, sign, hours, minutes] = name.match(/GMT([+-])(\d{2}):(\d{2})/);
  return (sign === "+" ? 1 : -1) * (Number(hours) * 60 + Number(minutes));
}

export function resetCompetitionDisplayWindow() {
  const endsAt = Date.parse(competitions.resetCompetition.end);
  const nextWeek = endsAt + 7 * 24 * 60 * 60 * 1000;
  return {
    startsAt: Date.parse(competitions.resetCompetition.start),
    hidesAt: nextWeek + (easternOffset(endsAt) - easternOffset(nextWeek)) * 60 * 1000,
  };
}

export function resetCompetitionIsVisible(now = Date.now(), preview = RESET_COMPETITION_PREVIEW) {
  const { startsAt, hidesAt } = resetCompetitionDisplayWindow();
  return (preview || now >= startsAt) && now < hidesAt;
}
