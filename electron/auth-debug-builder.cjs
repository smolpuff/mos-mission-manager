"use strict";

const pkg = require("../package.json");

// Private diagnostic artifacts only. Normal release metadata is unchanged.
module.exports = {
  ...pkg.build,
  directories: { ...pkg.build.directories, output: "release-auth-debug" },
  extraMetadata: { pbpAuthDiagnostics: true, version: `${pkg.version}-auth-debug.1` },
  mac: { ...pkg.build.mac, artifactName: "${productName}-${version}-${arch}-mac.${ext}" },
};
