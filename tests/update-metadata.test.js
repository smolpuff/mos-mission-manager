"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getReleaseArtifact, releaseAssetUrl, VERSION_JSON_URL } = require("../electron/update-download");
const { UPDATE_JSON_URL } = require("../electron/update-checker");

test("artifact lookup requests only the same version.json used by the update checker", async () => {
  const requests = [];
  const artifact = {
    url: releaseAssetUrl("3.2.19", "missions-v3-mcp.3.2.19.exe"),
    size: 100, sha256: "a".repeat(64), md5: "b".repeat(32),
  };
  const selected = await getReleaseArtifact("3.2.19", "win32", "x64", async (url) => {
    requests.push(url);
    return Response.json({ schemaVersion: 1, version: "3.2.19", artifacts: { "win32-x64": artifact } });
  });
  assert.equal(VERSION_JSON_URL, UPDATE_JSON_URL);
  assert.deepEqual(requests, [UPDATE_JSON_URL]);
  assert.deepEqual(selected, artifact);
});

test("invalid version.json never falls back to release metadata", async () => {
  const requests = [];
  await assert.rejects(getReleaseArtifact("3.2.19", "win32", "x64", async (url) => {
    requests.push(url);
    return Response.json({ version: "3.2.18" });
  }), /does not match/);
  assert.deepEqual(requests, [UPDATE_JSON_URL]);
});
