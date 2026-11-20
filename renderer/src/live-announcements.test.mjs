import test from "node:test";
import assert from "node:assert/strict";
import { createAnnouncementDisplay, ANNOUNCEMENT_CHECK_MS } from "./live-announcements.mjs";
const start = Date.parse("2026-11-01T12:00:00Z");
const item = patch => ({ id: "contest", enabled: true, startsAt: new Date(start).toISOString(), endsAt: new Date(start + 3600000).toISOString(), text: "Contest", ...patch });
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function fixture(t, items = [item()]) {
 t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: start });
 const shown = [], seen = []; let calls = 0, resolve;
 const f = { items, shown, seen, calls: () => calls };
 const display = createAnnouncementDisplay({ check: async () => { calls++; return f.items; }, markSeen: async (id, automatic) => { if (!automatic) seen.push(id); }, onChange: value => shown.push(value?.id || null) });
 t.after(() => display.dispose()); return { ...f, display };
}
test("no checks or popups during setup; deferred popup after setup; normal dismissal lasts this session", async t => {
 const f = fixture(t); t.mock.timers.tick(1000); await settle(); assert.equal(f.calls(), 0); assert.equal(f.shown.filter(Boolean).length, 0);
 f.display.setBlocked(false); await settle(); assert.equal(f.shown.at(-1), "contest"); assert.deepEqual(f.seen, []);
 f.display.setBlocked(true); assert.equal(f.shown.at(-1), null);
 f.display.setBlocked(false); await settle(); assert.deepEqual(f.seen, []);
 f.display.dismiss(); t.mock.timers.tick(ANNOUNCEMENT_CHECK_MS); await settle(); assert.equal(f.shown.at(-1), null);
});

test("a setup lasting multiple check intervals never fetches, displays or marks an announcement", async t => {
 t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: start });
 let checks = 0; const shown = [], marked = [];
 const display = createAnnouncementDisplay({
   check: async () => { checks++; return [item({ endsAt: new Date(start + 10 * ANNOUNCEMENT_CHECK_MS).toISOString() })]; },
   markSeen: (...args) => marked.push(args), onChange: value => shown.push(value),
 });
 t.after(() => display.dispose());
 display.setBlocked(true);
 for (let i = 0; i < 3; i++) { t.mock.timers.tick(ANNOUNCEMENT_CHECK_MS); await settle(); }
 assert.equal(checks, 0); assert.ok(shown.every(value => value === null)); assert.deepEqual(marked, []);
 display.setBlocked(false); await settle();
 assert.equal(checks, 1); assert.equal(shown.at(-1).canSuppress, true);
});
test("scheduled announcement starts on time and disappears exactly at expiry", async t => {
 const f = fixture(t, [item({ startsAt: new Date(start + 1000).toISOString(), endsAt: new Date(start + 2000).toISOString() })]);
 f.display.setBlocked(false); await settle(); assert.equal(f.shown.at(-1), null);
 t.mock.timers.tick(1000); await settle(); assert.equal(f.shown.at(-1), "contest");
 t.mock.timers.tick(1000); await settle(); assert.equal(f.shown.at(-1), null);
});
test("expiry while another dialog is open prevents the delayed announcement", async t => {
 const f = fixture(t, [item({ endsAt: new Date(start + 1000).toISOString() })]);
 f.display.setBlocked(false); await settle(); f.display.setBlocked(true);
 t.mock.timers.tick(1000); f.display.setBlocked(false); await settle(); assert.equal(f.shown.at(-1), null);
});
test("multiple messages do not stack or show back-to-back on dismissal", async t => {
 const f = fixture(t, [item(), item({ id: "second" })]); f.display.setBlocked(false); await settle(); f.display.dismiss(); await settle(); assert.equal(f.shown.at(-1), null); assert.deepEqual(f.seen, []);
 t.mock.timers.tick(ANNOUNCEMENT_CHECK_MS); await settle(); assert.equal(f.shown.at(-1), "second");
});
test("a feed arriving during setup stays hidden until setup is finished", async t => {
 t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: start });
 let resolve; const shown = [], seen = [];
 const display = createAnnouncementDisplay({ check: () => new Promise(done => { resolve = done; }), markSeen: (id, automatic) => { if (!automatic) seen.push(id); }, onChange: value => shown.push(value) }); t.after(() => display.dispose());
 display.setBlocked(false); display.setBlocked(true); resolve([item()]); await settle(); assert.equal(shown.at(-1), null); assert.deepEqual(seen, []);
 display.setBlocked(false); await settle(); assert.equal(shown.at(-1)?.id, "contest");
});
test("disposed controllers ignore late requests and never display or mark messages", async t => {
 let resolve; const shown = [], seen = [];
 const display = createAnnouncementDisplay({ check: () => new Promise(done => { resolve = done; }), markSeen: (id, automatic) => { if (!automatic) seen.push(id); }, onChange: value => shown.push(value) });
 display.setBlocked(false); display.dispose(); resolve([item()]); await settle(); assert.ok(shown.every(x => x === null)); assert.deepEqual(seen, []);
});

test("normal dismissal allows the announcement on the next launch; permanent dismissal survives it", async t => {
 t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: start });
 const persisted = new Set(), shown = [];
 const create = () => createAnnouncementDisplay({ check: async () => persisted.has("contest") ? [] : [item()], markSeen: async (id, automatic) => { if (!automatic) persisted.add(id); }, onChange: value => shown.push(value?.id || null) });
 const first = create(); first.setBlocked(false); await settle(); assert.equal(shown.at(-1), "contest");
 first.dismiss(); await settle(); assert.equal(persisted.size, 0); first.dispose();
 const second = create(); second.setBlocked(false); await settle(); assert.equal(shown.at(-1), "contest");
 second.dismiss(true); await settle(); assert.ok(persisted.has("contest")); second.dispose();
 const third = create(); third.setBlocked(false); await settle(); assert.equal(shown.at(-1), null); third.dispose();
});
test("dismissing after expiry cannot permanently dismiss a different queued message", async t => {
 const f = fixture(t, [item({ endsAt: new Date(start + 1000).toISOString() }), item({ id: "next", startsAt: new Date(start + ANNOUNCEMENT_CHECK_MS).toISOString() })]);
 f.display.setBlocked(false); await settle(); t.mock.timers.tick(1000); await settle();
 f.display.dismiss(true); await settle(); assert.deepEqual(f.seen, []);
 t.mock.timers.tick(ANNOUNCEMENT_CHECK_MS); await settle(); assert.equal(f.shown.at(-1), "next");
});

test("startup and periodic announcements stay seen across controller remounts", async t => {
 t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: start });
 const session = { seen: new Set(), checked: false }, shown = [], persisted = [];
 let feed = [item({ endsAt: new Date(start + 10 * ANNOUNCEMENT_CHECK_MS).toISOString() })];
 const create = () => createAnnouncementDisplay({ session, check: async () => feed, markSeen: id => persisted.push(id), onChange: value => shown.push(value) });
 const first = create(); first.setBlocked(false); await settle();
 assert.equal(shown.at(-1).canSuppress, true);
 first.dismiss(); first.dispose();
 const second = create(); t.after(() => second.dispose()); second.setBlocked(false); await settle();
 assert.equal(shown.at(-1), null);
 feed = [...feed, item({ id: "new", endsAt: new Date(start + 10 * ANNOUNCEMENT_CHECK_MS).toISOString() })];
 t.mock.timers.tick(ANNOUNCEMENT_CHECK_MS); await settle();
 assert.equal(shown.at(-1).id, "new"); assert.equal(shown.at(-1).canSuppress, false);
 second.dismiss(true); await settle(); assert.deepEqual(persisted, ["contest", "new"]);
 for (let i = 0; i < 3; i++) { t.mock.timers.tick(ANNOUNCEMENT_CHECK_MS); await settle(); assert.equal(shown.at(-1), null); }
});

test("an open popup closes when the feed deletes it", async t => {
 t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: start });
 let feed = [item()]; const shown = [];
 const display = createAnnouncementDisplay({ check: async () => feed, markSeen: () => {}, onChange: value => shown.push(value) });
 t.after(() => display.dispose()); display.setBlocked(false); await settle(); assert.equal(shown.at(-1).id, "contest");
 feed = []; t.mock.timers.tick(ANNOUNCEMENT_CHECK_MS); await settle(); assert.equal(shown.at(-1), null);
});

test("only the initial popup offers permanent suppression, even with multiple startup messages", async t => {
 t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: start });
 const shown = [];
 const display = createAnnouncementDisplay({ check: async () => [item(), item({ id: "second" })], markSeen: () => {}, onChange: value => shown.push(value) });
 t.after(() => display.dispose()); display.setBlocked(false); await settle();
 assert.equal(shown.at(-1).canSuppress, true); display.dismiss();
 t.mock.timers.tick(ANNOUNCEMENT_CHECK_MS); await settle();
 assert.equal(shown.at(-1).id, "second"); assert.equal(shown.at(-1).canSuppress, false);
});

test("automatic delivery happens once; startup still shows it until explicitly suppressed", async t => {
 t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: start });
 const automaticSeen = new Set(), suppressed = new Set(), shown = [];
 let feed = [];
 const create = () => createAnnouncementDisplay({
   check: async () => feed.filter(item => !suppressed.has(item.id)).map(item => ({ ...item, automaticSeen: automaticSeen.has(item.id) })),
   markSeen: async (id, automatic) => (automatic ? automaticSeen : suppressed).add(id),
   onChange: value => shown.push(value),
 });
 const first = create(); first.setBlocked(false); await settle();
 feed = [item({ endsAt: new Date(start + 10 * ANNOUNCEMENT_CHECK_MS).toISOString() })];
 t.mock.timers.tick(ANNOUNCEMENT_CHECK_MS); await settle();
 assert.equal(shown.at(-1).id, "contest"); assert.equal(shown.at(-1).canSuppress, false);
 assert.ok(automaticSeen.has("contest")); assert.equal(suppressed.size, 0);
 first.dispose();
 const restarted = create(); restarted.setBlocked(false); await settle();
 assert.equal(shown.at(-1).id, "contest"); assert.equal(shown.at(-1).canSuppress, true);
 restarted.dismiss(); t.mock.timers.tick(ANNOUNCEMENT_CHECK_MS); await settle(); assert.equal(shown.at(-1), null);
 restarted.dispose();
 // If absent at the next startup, it still cannot auto-deliver again later.
 feed = [];
 const later = create(); later.setBlocked(false); await settle();
 feed = [item({ endsAt: new Date(start + 10 * ANNOUNCEMENT_CHECK_MS).toISOString() })];
 t.mock.timers.tick(ANNOUNCEMENT_CHECK_MS); await settle(); assert.equal(shown.at(-1), null); later.dispose();
 const startup = create(); startup.setBlocked(false); await settle(); assert.equal(shown.at(-1).id, "contest");
 startup.dismiss(true); await settle(); assert.ok(suppressed.has("contest")); startup.dispose();
 const final = create(); t.after(() => final.dispose()); final.setBlocked(false); await settle(); assert.equal(shown.at(-1), null);
});
