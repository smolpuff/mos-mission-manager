"use strict";

function hasRecordedAssignment(history, eventId) {
  return Boolean(eventId) && (Array.isArray(history) ? history : [])
    .some((entry) => entry?.eventId === eventId);
}

// Lease acquisition and assigning a rental to a mission are separate actions.
// Retained assignment history repairs existing counts without inventing events.
function countRentalAssignments(history) {
  const seen = new Set();
  let count = 0;
  for (const entry of Array.isArray(history) ? history : []) {
    if (entry?.source !== "rental") continue;
    if (entry.eventId) {
      if (seen.has(entry.eventId)) continue;
      seen.add(entry.eventId);
    }
    count += 1;
  }
  return count;
}

module.exports = { countRentalAssignments, hasRecordedAssignment };
