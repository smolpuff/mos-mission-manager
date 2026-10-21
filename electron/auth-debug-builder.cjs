"use strict";

const pkg = require("../package.json");
const numericBeta = /^\d+\.\d+\.\d+$/.test(pkg.version) && process.env.PBP_AUTH_BETA_VERSION === `v${pkg.version}`;
const betaTag = process.env.PBP_AUTH_BETA_VERSION || (/^\d+\.\d+\.\d+b[1-9]\d*$/.test(pkg.version) ? pkg.version : null);
const beta = betaTag?.match(/^v?(\d+\.\d+\.\d+)b([1-9]\d*)$/);
if (betaTag && !numericBeta && (!beta || ![beta[1], `${beta[1]}b${beta[2]}`].includes(pkg.version))) {
  throw new Error("Expected a beta version matching package.json, such as 3.3.0b1.");
}
const betaVersion = numericBeta ? pkg.version : beta ? `${beta[1]}b${beta[2]}` : null;

// Diagnostic beta artifacts; numeric betas also work with the existing updater.
module.exports = {
  ...pkg.build,
  directories: { ...pkg.build.directories, output: "release-auth-debug" },
  extraMetadata: { pbpAuthDiagnostics: true, version: numericBeta ? pkg.version : beta ? `${beta[1]}-beta.${beta[2]}` : `${pkg.version}-auth-debug.1` },
  ...(betaVersion ? { publish: null } : {}),
  mac: { ...pkg.build.mac, artifactName: `\${productName}-${betaVersion || "${version}"}-\${arch}-mac.\${ext}` },
  win: { ...pkg.build.win, ...(beta ? { artifactName: `\${productName}.${betaVersion}.\${ext}` } : {}) },
};
