"use strict";

// Run after packaging; no release upload or network access occurs here.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { releaseAssetUrl, selectArtifact } = require("../update-download");
const { version } = require("../../package.json");

async function main([mode, output, ...inputs]) {
  const manifest = { schemaVersion: 1, version, artifacts: {} };
  if (mode === "artifact") {
    const [arch, file] = inputs;
    if (!["arm64", "x64"].includes(arch) || !/\.(zip|exe)$/i.test(file || "")) throw new Error("Expected architecture and ZIP/portable EXE path.");
    const platform = file.toLowerCase().endsWith(".exe") ? "win32" : "darwin";
    const hash = crypto.createHash("sha256");
    const md5 = crypto.createHash("md5");
    for await (const chunk of fs.createReadStream(file)) { hash.update(chunk); md5.update(chunk); }
    manifest.artifacts[`${platform}-${arch}`] = {
      url: releaseAssetUrl(version, path.basename(file)),
      size: fs.statSync(file).size, sha256: hash.digest("hex"), md5: md5.digest("hex"),
    };
    selectArtifact(manifest, version, platform, arch);
  } else if (mode === "merge") {
    for (const file of inputs) {
      const fragment = JSON.parse(fs.readFileSync(file, "utf8"));
      if (fragment.version !== version || fragment.schemaVersion !== 1) throw new Error("Release versions do not match.");
      for (const [key, value] of Object.entries(fragment.artifacts || {})) {
        if (manifest.artifacts[key]) throw new Error(`Duplicate artifact: ${key}`);
        manifest.artifacts[key] = value;
      }
    }
    for (const arch of ["arm64", "x64"]) selectArtifact(manifest, version, "darwin", arch);
    selectArtifact(manifest, version, "win32", "x64");
  } else throw new Error("Usage: create-update-manifest.js artifact OUTPUT ARCH ZIP_OR_EXE | merge OUTPUT FRAGMENTS...");
  fs.writeFileSync(output, JSON.stringify(manifest, null, 2) + "\n");
}

if (require.main === module) main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
