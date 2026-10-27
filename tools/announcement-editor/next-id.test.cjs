"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createIdAllocator } = require("./next-id.cjs");

test("IDs increase across new drafts, deletion, concurrent requests and editor restarts", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "announcement-ids-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const allocate = createIdAllocator(directory);
  assert.equal(await allocate([]), "announcement-1");
  assert.deepEqual(await Promise.all([allocate([]), allocate([])]), ["announcement-2", "announcement-3"]);
  assert.equal(await createIdAllocator(directory)([]), "announcement-4");
});

test("existing saved, unsaved and imported IDs advance the sequence without changing them", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "announcement-ids-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "draft.json"), JSON.stringify({ announcements: [{ id: "announcement-8" }] }));
  const allocate = createIdAllocator(directory);
  const items = [{ id: "renamed", publishedId: "announcement-12" }, { id: "15" }, { id: "contest" }];
  assert.equal(await allocate(items), "announcement-16");
  assert.deepEqual(items, [{ id: "renamed", publishedId: "announcement-12" }, { id: "15" }, { id: "contest" }]);
  await fs.writeFile(path.join(directory, "draft.json"), JSON.stringify({ announcements: [] }));
  assert.equal(await createIdAllocator(directory)([]), "announcement-17");
});
