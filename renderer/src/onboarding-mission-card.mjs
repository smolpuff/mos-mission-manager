export function resolveOnboardingMissionCard(selectedName, catalogEntry, assigned) {
  const key = (name) => String(name || "").trim().toLowerCase();
  if (!selectedName) return assigned || null;
  if (key(selectedName) === key(assigned?.name || assigned?.missionName)) {
    return { ...catalogEntry, ...assigned };
  }
  return catalogEntry || null;
}
