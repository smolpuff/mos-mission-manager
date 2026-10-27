"use strict";

const ANNOUNCEMENTS_BRANCH = "announcements";
const ANNOUNCEMENTS_URL = `https://raw.githubusercontent.com/smolpuff/mos-mission-manager/${ANNOUNCEMENTS_BRANCH}/announcements.json`;
const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const MAX_FEED_BYTES = 128 * 1024;

function httpsUrl(value, walletTemplate = false) {
  if (!value) return "";
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Links and images must use HTTPS.");
  return walletTemplate ? url.href.replace(/%7Bwallet%7D/gi, "{wallet}") : url.href;
}
function text(value, limit) {
  if (value == null) return "";
  if (typeof value !== "string" || value.length > limit) throw new Error(`Text must be at most ${limit} characters.`);
  return value.trim();
}
function normalizeAnnouncement(value) {
  if (!value || typeof value !== "object") throw new Error("Invalid announcement.");
  const id = text(value.id, 100);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) throw new Error("Give each announcement a unique ID using letters, numbers, dots, dashes or underscores.");
  const dates = [value.startsAt, value.endsAt];
  if (dates.some(date => typeof date !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/.test(date) || !Number.isFinite(Date.parse(date))) || Date.parse(dates[1]) <= Date.parse(dates[0])) {
    throw new Error("Set start and end times with a time zone. End must be after start.");
  }
  const title = text(value.title, 160), body = text(value.text, 8000), info = text(value.info, 8000);
  const imageUrl = httpsUrl(text(value.imageUrl, 2048));
  const imageWidth = value.imageWidth == null ? 100 : value.imageWidth;
  if (!Number.isInteger(imageWidth) || imageWidth < 1 || imageWidth > 100) throw new Error("Image width must be between 1 and 100 percent.");
  if (!title && !body && !info && !imageUrl) throw new Error("Add an image or message before publishing.");
  if (value.prizes != null && (!Array.isArray(value.prizes) || value.prizes.length > 20)) throw new Error("Use at most 20 prize rows.");
  const prizes = (value.prizes || []).map(row => {
    const place = text(row?.place, 80), prize = text(row?.prize, 500);
    if (!place || !prize) throw new Error("Each prize needs a placement and a prize.");
    return { place, prize };
  });
  return { id, enabled: value.enabled === true, startsAt: new Date(dates[0]).toISOString(), endsAt: new Date(dates[1]).toISOString(),
    title, text: body, info, imageUrl, imageWidth, imageAlt: text(value.imageAlt, 200), prizes,
    linkUrl: httpsUrl(text(value.linkUrl, 2048), true), linkLabel: text(value.linkLabel, 100) };
}
function normalizeFeed(payload) {
  if (payload?.schemaVersion !== 1 || !Array.isArray(payload.announcements) || payload.announcements.length > 20) throw new Error("Invalid announcement feed (maximum 20 messages).");
  const ids = new Set();
  const announcements = payload.announcements.map(value => {
    const announcement = normalizeAnnouncement(value);
    if (ids.has(announcement.id)) throw new Error("Announcement IDs must be unique.");
    ids.add(announcement.id);
    return announcement;
  });
  return { schemaVersion: 1, announcements };
}
function isActive(announcement, now = Date.now()) {
  return announcement.enabled === true && Date.parse(announcement.startsAt) <= now && now < Date.parse(announcement.endsAt);
}
module.exports = { ANNOUNCEMENTS_BRANCH, ANNOUNCEMENTS_URL, CHECK_INTERVAL_MS, MAX_FEED_BYTES, normalizeAnnouncement, normalizeFeed, isActive };
