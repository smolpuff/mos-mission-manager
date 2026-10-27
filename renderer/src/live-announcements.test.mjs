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
 const display = createAnnouncementDisplay({ check: async () => { calls++; return f.items; }, markSeen: async id => { seen.push(id); }, onChange: value => shown.push(value?.id || null) });
 t.after(() => display.dispose()); return { ...f, display };
}
test("no checks or popups during setup; deferred popup after setup; ID marked once", async t => {
 const f = fixture(t); t.mock.timers.tick(1000); await settle(); assert.equal(f.calls(), 0); assert.equal(f.shown.filter(Boolean).length, 0);
 f.display.setBlocked(false); await settle(); assert.equal(f.shown.at(-1), "contest"); assert.deepEqual(f.seen, ["contest"]);
 f.display.setBlocked(true); assert.equal(f.shown.at(-1), null);
 f.display.setBlocked(false); await settle(); assert.deepEqual(f.seen, ["contest"]);
 f.display.dismiss(); t.mock.timers.tick(ANNOUNCEMENT_CHECK_MS); await settle(); assert.equal(f.shown.at(-1), null);
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
 const f = fixture(t, [item(), item({ id: "second" })]); f.display.setBlocked(false); await settle(); f.display.dismiss(); await settle(); assert.equal(f.shown.at(-1), null); assert.deepEqual(f.seen, ["contest"]);
 t.mock.timers.tick(ANNOUNCEMENT_CHECK_MS); await settle(); assert.equal(f.shown.at(-1), "second");
});
test("a feed arriving during setup stays hidden until setup is finished", async t => {
 t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: start });
 let resolve; const shown = [], seen = [];
 const display = createAnnouncementDisplay({ check: () => new Promise(done => { resolve = done; }), markSeen: id => seen.push(id), onChange: value => shown.push(value) }); t.after(() => display.dispose());
 display.setBlocked(false); display.setBlocked(true); resolve([item()]); await settle(); assert.equal(shown.at(-1), null); assert.deepEqual(seen, []);
 display.setBlocked(false); await settle(); assert.equal(shown.at(-1)?.id, "contest");
});
test("disposed controllers ignore late requests and never display or mark messages", async t => {
 let resolve; const shown = [], seen = [];
 const display = createAnnouncementDisplay({ check: () => new Promise(done => { resolve = done; }), markSeen: id => seen.push(id), onChange: value => shown.push(value) });
 display.setBlocked(false); display.dispose(); resolve([item()]); await settle(); assert.ok(shown.every(x => x === null)); assert.deepEqual(seen, []);
});
