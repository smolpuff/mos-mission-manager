"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { normalizeFeed, isActive, CHECK_INTERVAL_MS } = require("./announcements");
const { createAnnouncementService } = require("../electron/announcements");
const { prepareFeed, publish } = require("../tools/announcement-editor/publish.cjs");
const { imageType } = require("../tools/announcement-editor/server.cjs");
const time = Date.parse("2026-11-01T12:00:00Z");
const entry = (patch = {}) => ({ id: "reset-rush", enabled: true, startsAt: "2026-11-01T12:00:00Z", endsAt: "2026-11-02T12:00:00Z", text: "Most automatic resets wins", ...patch });
const feed = (...announcements) => ({ schemaVersion: 1, announcements });
async function directory(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), "announcement-test-")); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }

test("time boundaries, disabled messages and explicit time zones", () => {
 const item = normalizeFeed(feed(entry())).announcements[0];
 assert.equal(isActive(item, time - 1), false); assert.equal(isActive(item, time), true);
 assert.equal(isActive(item, Date.parse(item.endsAt)), false);
 assert.equal(isActive({ ...item, enabled: false }, time), false);
 for (const patch of [{ startsAt: "2026-11-01T12:00" }, { endsAt: item.startsAt }, { endsAt: "bad" }]) assert.throws(() => normalizeFeed(feed(entry(patch))));
});
test("optional sections, image-only messages and flexible prize placements", () => {
 const item = normalizeFeed(feed(entry({ text: "", imageUrl: "https://example.com/prize.png", prizes: [{ place: "1st", prize: "NFT" }, { place: "5th–10th", prize: "Bonus" }] }))).announcements[0];
 assert.equal(item.title, ""); assert.equal(item.info, ""); assert.equal(item.linkUrl, ""); assert.equal(item.prizes[1].place, "5th–10th");
 assert.equal(item.imageWidth, 100);
 assert.equal(normalizeFeed(feed(entry({ imageWidth: 60 }))).announcements[0].imageWidth, 60);
 for (const imageWidth of [0, 101, -1, 1.5, "60"]) assert.throws(() => normalizeFeed(feed(entry({ imageWidth }))));
 assert.throws(() => normalizeFeed(feed(entry({ text: "", imageUrl: "" }))));
 assert.throws(() => normalizeFeed(feed(entry({ linkUrl: "javascript:alert(1)" }))));
 assert.throws(() => normalizeFeed(feed(entry({ imageUrl: "https://user:password@example.com/img" }))));
 assert.throws(() => normalizeFeed(feed(entry(), entry())));
 assert.throws(() => normalizeFeed(feed(entry({ prizes: [{ place: "1st", prize: "" }] }))));
});
test("feed checks coalesce, cache for 30 minutes, and preserve seen IDs across restarts", async t => {
 const userData = await directory(t); let calls = 0, clock = time;
 const fetchImpl = async (_url, options) => { calls++; assert.ok(options.signal); return Response.json(feed(entry())); };
 const service = createAnnouncementService({ userData, fetchImpl, now: () => clock });
 const responses = await Promise.all([service.check(), service.check(), service.check()]);
 assert.equal(calls, 1); assert.ok(responses.every(r => r.length === 1));
 await service.markSeen("reset-rush"); assert.equal((await service.check()).length, 0);
 const restarted = createAnnouncementService({ userData, fetchImpl, now: () => clock }); assert.equal((await restarted.check()).length, 0);
 clock += CHECK_INTERVAL_MS; await service.check(); assert.equal(calls, 3);
 assert.equal(await service.markSeen("not-in-feed"), false);
});
test("future messages are retained for scheduling; expired and disabled messages are excluded", async t => {
 const userData = await directory(t);
 const service = createAnnouncementService({ userData, now: () => time, fetchImpl: async () => Response.json(feed(entry({ id: "future", startsAt: "2026-11-02T00:00:00Z" }), entry({ id: "expired", startsAt: "2026-10-01T00:00:00Z", endsAt: "2026-11-01T12:00:00Z" }), entry({ id: "disabled", enabled: false }))) });
 assert.deepEqual((await service.check()).map(x => x.id), ["future"]); assert.equal(await service.markSeen("future"), false);
});
test("automatic delivery history survives restart without suppressing startup", async t => {
 const userData = await directory(t);
 const options = { userData, now: () => time, fetchImpl: async () => Response.json(feed(entry())) };
 const service = createAnnouncementService(options);
 assert.equal((await service.check())[0].automaticSeen, false);
 await service.markSeen("reset-rush", true);
 const restarted = createAnnouncementService(options);
 const messages = await restarted.check();
 assert.equal(messages.length, 1); assert.equal(messages[0].automaticSeen, true);
 await restarted.markSeen("reset-rush");
 assert.deepEqual(await createAnnouncementService(options).check(), []);
});
test("refreshes use fresh URLs and remove deleted announcements", async t => {
 const userData = await directory(t); let clock = time; const urls = [];
 const service = createAnnouncementService({ userData, now: () => clock, fetchImpl: async (url, options) => {
   urls.push(url); assert.equal(options.cache, "no-store");
   assert.equal(options.headers["If-None-Match"], undefined);
   return Response.json(urls.length === 1 ? feed(entry()) : feed());
 } });
 assert.equal((await service.check()).length, 1); clock += CHECK_INTERVAL_MS;
 assert.deepEqual(await service.check(), []); assert.notEqual(urls[0], urls[1]);
 assert.equal(new URL(urls[1]).searchParams.get("check"), String(clock));
 const restarted = createAnnouncementService({ userData, now: () => clock, fetchImpl: async () => Response.json(feed()) });
 assert.deepEqual(await restarted.check(), []);
});
test("a failed refresh cannot resurrect the previous feed on a cached check", async t => {
 const userData = await directory(t); let clock = time, calls = 0;
 const service = createAnnouncementService({ userData, now: () => clock, fetchImpl: async () => {
   if (++calls === 1) return Response.json(feed(entry()));
   throw Error("offline");
 } });
 assert.equal((await service.check()).length, 1); clock += CHECK_INTERVAL_MS;
 assert.deepEqual(await service.check(), []); assert.deepEqual(await service.check(), []);
});
test("missing, invalid, oversized or unavailable feeds fail quietly", async t => {
 for (const fetchImpl of [async () => new Response(null, { status: 404 }), async () => { throw Error("offline"); }, async () => Response.json({}), async () => new Response("x".repeat(128 * 1024 + 1))]) {
  const userData = await directory(t); const service = createAnnouncementService({ userData, fetchImpl }); assert.deepEqual(await service.check(), []);
 }
});
test("editor drafts do not publish disabled messages; uploaded image paths are content-addressed", () => {
 const name = "a".repeat(64) + ".png";
 const result = prepareFeed({ announcements: [entry({ imageFile: name }), { id: "draft", enabled: false }] });
 assert.equal(result.announcements.length, 1); assert.match(result.announcements[0].imageUrl, /\/announcements\/images\/a{64}\.png$/);
 assert.throws(() => prepareFeed({ announcements: [entry({ imageFile: "../../secret.png" })] }));
 assert.equal(imageType(Buffer.from([137,80,78,71,13,10,26,10])), "png");
 assert.throws(() => imageType(Buffer.from("<svg><script></script></svg>")));
});
for (const exists of [false, true]) test(`publish writes only the announcement branch (${exists ? "existing" : "new"})`, async t => {
 const calls = [], dataDir = await directory(t);
 const api = async (endpoint, body, method) => {
   calls.push({ endpoint, body, method });
   if (endpoint === "git/ref/heads/announcements") { if (!exists) throw Error("HTTP 404"); return { object: { sha: "old-commit" } }; }
   if (endpoint === "git/commits/old-commit") return { tree: { sha: "old-tree" } };
   if (endpoint === "contents/announcements.json?ref=old-commit") return { content: Buffer.from(JSON.stringify(feed())).toString("base64") };
   if (endpoint === "git/blobs") return { sha: "feed-blob" };
   if (endpoint === "git/trees") return { sha: "new-tree" };
   if (endpoint === "git/commits") return { sha: "new-commit" };
   return {};
 };
 const result = await publish(entry(), { dataDir, api }); assert.equal(result.commit, "new-commit");
 const update = calls.at(-1); if (exists) { assert.equal(update.endpoint, "git/refs/heads/announcements"); assert.equal(update.body.force, false); } else assert.equal(update.body.ref, "refs/heads/announcements");
 const tree = calls.find(call => call.endpoint === "git/trees").body; assert.deepEqual(tree.tree.map(x => x.path), ["announcements.json"]);
 assert.ok(!calls.some(call => /main|beta|version\.json|releases/.test(call.endpoint)));
 const published = JSON.parse(calls.find(call => call.endpoint === "git/blobs").body.content); assert.equal(published.announcements[0].text, entry().text);
});
test("publish validates everything before any GitHub writes", async () => {
 let calls = 0; await assert.rejects(publish(entry({ endsAt: "bad" }), { dataDir: "/unused", api: async () => { calls++; } })); assert.equal(calls, 0);
});

for (const operation of ["add", "edit", "rename", "remove"]) test(`selected-message ${operation} preserves every other published announcement`, async t => {
 const dataDir = await directory(t), calls = [];
 const other = entry({ id: "other", text: "Leave this alone", extraFutureField: "preserve" });
 const original = entry({ id: "original", text: "Original text" });
 const api = async (endpoint, body) => {
  calls.push({ endpoint, body });
  if (endpoint === "git/ref/heads/announcements") return { object: { sha: "old" } };
  if (endpoint === "git/commits/old") return { tree: { sha: "old-tree" } };
  if (endpoint === "contents/announcements.json?ref=old") return { content: Buffer.from(JSON.stringify(feed(other, original))).toString("base64") };
  return { sha: "new" };
 };
 const selected = entry({ id: operation === "edit" || operation === "remove" ? "original" : "new-id", text: "New text" });
 await publish(selected, { dataDir, api, publishedId: operation === "add" ? null : "original", remove: operation === "remove" });
 const result = JSON.parse(calls.find(call => call.endpoint === "git/blobs").body.content);
 assert.deepEqual(result.announcements.find(item => item.id === "other"), other);
 assert.equal(result.announcements.length, operation === "add" ? 3 : operation === "remove" ? 1 : 2);
 if (operation === "rename" || operation === "remove") assert.ok(!result.announcements.some(item => item.id === "original"));
 if (operation === "edit") assert.equal(result.announcements.find(item => item.id === "original").text, "New text");
 if (operation === "add") assert.deepEqual(result.announcements.find(item => item.id === "original"), original);
});
test("a colliding ID cannot overwrite a different live announcement", async t => {
 const calls = [];
 const api = async (endpoint, body) => {
  calls.push({ endpoint, body });
  if (endpoint === "git/ref/heads/announcements") return { object: { sha: "old" } };
  if (endpoint === "git/commits/old") return { tree: { sha: "tree" } };
  if (endpoint === "contents/announcements.json?ref=old") return { content: Buffer.from(JSON.stringify(feed(entry({ id: "taken" })))).toString("base64") };
  return {};
 };
 await assert.rejects(publish(entry({ id: "taken" }), { dataDir: await directory(t), api, publishedId: "original" }), /already published/);
 assert.ok(calls.every(call => !call.body));
});
test("removing an already-absent message performs no GitHub writes", async t => {
 const calls = [];
 const api = async endpoint => { calls.push(endpoint); if (endpoint === "git/ref/heads/announcements") throw Error("HTTP 404"); };
 const result = await publish({ id: "missing" }, { dataDir: await directory(t), api, remove: true });
 assert.equal(result.unchanged, true); assert.deepEqual(calls, ["git/ref/heads/announcements"]);
});
