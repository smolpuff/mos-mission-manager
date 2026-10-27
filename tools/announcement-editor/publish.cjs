"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { normalizeFeed, ANNOUNCEMENTS_BRANCH } = require("../../lib/announcements");
const run = promisify(execFile);
const REPO = "smolpuff/mos-mission-manager";
const IMAGE_FILE = /^[a-f0-9]{64}\.(?:png|jpg|webp|gif)$/;

async function githubApi(endpoint, body, method = body ? "POST" : "GET") {
  let directory;
  try {
    const args = ["api", `repos/${REPO}/${endpoint}`, "--method", method];
    if (body) {
      directory = await fs.mkdtemp(path.join(os.tmpdir(), "missions-announcement-"));
      const input = path.join(directory, "request.json");
      await fs.writeFile(input, JSON.stringify(body), { mode: 0o600 });
      args.push("--input", input);
    }
    return JSON.parse((await run("gh", args, { maxBuffer: 12 * 1024 * 1024, timeout: 60000 })).stdout);
  } finally { if (directory) await fs.rm(directory, { recursive: true, force: true }); }
}
function prepareFeed(draft) {
  if (!Array.isArray(draft?.announcements) || draft.announcements.length > 20) throw new Error("Use at most 20 announcements.");
  return normalizeFeed({ schemaVersion: 1, announcements: draft.announcements.filter(item => item.enabled === true).map(item => {
    if (item.imageFile && !IMAGE_FILE.test(item.imageFile)) throw new Error("Invalid uploaded image.");
    return { ...item, prizes: (item.prizes || []).filter(row => row.place || row.prize),
      imageUrl: item.imageFile ? `https://raw.githubusercontent.com/${REPO}/${ANNOUNCEMENTS_BRANCH}/images/${item.imageFile}` : item.imageUrl };
  }) });
}
async function publish(announcement, { dataDir, api = githubApi, remove = false, publishedId = null }) {
  const id = remove ? (publishedId || announcement?.id) : announcement?.id;
  for (const value of [id, publishedId].filter(value => value !== null)) {
    if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value)) throw new Error("Invalid announcement ID.");
  }
  const selected = remove ? null : prepareFeed({ announcements: [{ ...announcement, enabled: true }] }).announcements[0];
  let previous;
  try { previous = await api(`git/ref/heads/${ANNOUNCEMENTS_BRANCH}`); }
  catch (error) { if (!/HTTP 404/.test(error.message)) throw error; }
  const parent = previous?.object?.sha;
  const base = parent ? (await api(`git/commits/${parent}`)).tree.sha : undefined;
  let current = { schemaVersion: 1, announcements: [] };
  if (parent) {
    const file = await api(`contents/announcements.json?ref=${parent}`);
    current = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
    normalizeFeed(current);
  }
  if (selected && current.announcements.some(item => item.id === id && item.id !== publishedId)) {
    throw new Error("That ID is already published. Load the published message to edit it, or use a new ID.");
  }
  const others = current.announcements.filter(item => item.id !== id && item.id !== publishedId);
  if (remove && others.length === current.announcements.length) return { id, removed: true, unchanged: true };
  const feed = { schemaVersion: 1, announcements: selected ? [...others, selected] : others };
  normalizeFeed(feed);
  const contents = JSON.stringify(feed, null, 2) + "\n";
  if (Buffer.byteLength(contents) > 128 * 1024) throw new Error("Announcement feed is too large.");
  const tree = [];
  const files = new Set(!remove && announcement.imageFile ? [announcement.imageFile] : []);
  for (const name of files) {
    const bytes = await fs.readFile(path.join(dataDir, "images", name));
    if (bytes.length > 5 * 1024 * 1024) throw new Error("Images must be at most 5 MB.");
    const blob = await api("git/blobs", { content: bytes.toString("base64"), encoding: "base64" });
    tree.push({ path: `images/${name}`, mode: "100644", type: "blob", sha: blob.sha });
  }
  const blob = await api("git/blobs", { content: contents, encoding: "utf-8" });
  tree.push({ path: "announcements.json", mode: "100644", type: "blob", sha: blob.sha });
  const createdTree = await api("git/trees", { ...(base ? { base_tree: base } : {}), tree });
  const commit = await api("git/commits", { message: `${remove ? "Remove" : "Publish"} announcement ${id}`, tree: createdTree.sha, parents: parent ? [parent] : [] });
  if (parent) await api(`git/refs/heads/${ANNOUNCEMENTS_BRANCH}`, { sha: commit.sha, force: false }, "PATCH");
  else await api("git/refs", { ref: `refs/heads/${ANNOUNCEMENTS_BRANCH}`, sha: commit.sha });
  return { commit: commit.sha, id, removed: remove };
}
module.exports = { prepareFeed, publish, githubApi, IMAGE_FILE };
