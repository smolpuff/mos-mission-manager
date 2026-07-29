export function competitionOptionValue(competition, index = 0) {
  const start = String(competition?.start || "").trim();
  const end = String(competition?.end || "").trim();
  const datesText = String(competition?.datesText || "").trim();
  const dateKey = start || end ? `${start}__${end}` : datesText;

  return String(
    dateKey ||
      competition?.competitionNumber ||
      competition?.scrapedAt ||
      index,
  );
}

export function competitionOptionLabel(competition, index = 0) {
  const start = String(competition?.start || "").trim();
  const end = String(competition?.end || "").trim();
  const datesText = String(competition?.datesText || "").trim();

  if (start && end && start !== end) return `${start} – ${end}`;
  if (start || end) return start || end;
  if (datesText) return datesText;
  if (competition?.competitionNumber) {
    return `Competition ${competition.competitionNumber}`;
  }
  return `Event ${index + 1}`;
}
