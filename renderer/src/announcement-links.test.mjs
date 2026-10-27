import test from "node:test";
import assert from "node:assert/strict";
import { announcementLinkUrl, announcementTextParts } from "./announcement-links.mjs";
import announcements from "../../lib/announcements.js";

test("wallet templates survive publishing and resolve in path and query URLs", () => {
 const item = announcements.normalizeAnnouncement({ id: "test", enabled: true, startsAt: "2026-11-01T00:00:00Z", endsAt: "2026-11-16T00:00:00Z", text: "Stats", linkUrl: "https://example.com/{wallet}?wallet={wallet}" });
 assert.equal(item.linkUrl, "https://example.com/{wallet}?wallet={wallet}");
 assert.equal(announcementLinkUrl(item.linkUrl, "myWallet"), "https://example.com/myWallet?wallet=myWallet");
 assert.equal(announcementLinkUrl(item.linkUrl), null);
 assert.equal(announcementLinkUrl("https://example.com/%7Bwallet%7D", "myWallet"), "https://example.com/myWallet");
 for (const url of ["javascript:alert(1)", "http://example.com", "https://user:pass@example.com"]) assert.equal(announcementLinkUrl(url, "wallet"), null);
});

test("message and info text support labeled and plain links, without interpreting HTML", () => {
 assert.deepEqual(announcementTextParts("See [my stats](https://example.com/{wallet})\nRules: https://example.com/rules.", "abc"), [
   { text: "See " }, { text: "my stats", href: "https://example.com/abc" },
   { text: "\nRules: " }, { text: "https://example.com/rules", href: "https://example.com/rules" }, { text: "." },
 ]);
 assert.deepEqual(announcementTextParts("<script>alert(1)</script> [bad](javascript:alert)"), [{ text: "<script>alert(1)</script> [bad](javascript:alert)" }]);
 assert.equal(announcementTextParts("[stats](https://example.com/{wallet})")[0].href, null);
});
