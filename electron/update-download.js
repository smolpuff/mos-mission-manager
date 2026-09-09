"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const REPOSITORY = "smolpuff/mos-mission-manager";
const MAX_DOWNLOAD_BYTES = 2 * 1024 ** 3;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function releaseAssetUrl(version, name) {
  if (!VERSION_PATTERN.test(version)) throw new Error("Unsupported update version.");
  return `https://github.com/${REPOSITORY}/releases/download/v${version}/${encodeURIComponent(name)}`;
}

function validateAssetUrl(value, version) {
  const url = new URL(value);
  const prefix = `/` + REPOSITORY + `/releases/download/v${version}/`;
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port ||
      url.username || url.password || url.search || url.hash ||
      !url.pathname.startsWith(prefix) ||
      !url.pathname.slice(prefix.length) || url.pathname.slice(prefix.length).includes("/")) {
    throw new Error("Update download is not a tagged release from this repository.");
  }
  return url.href;
}

async function fetchReleaseAsset(url, { signal, fetchImpl = globalThis.fetch } = {}) {
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.port || parsed.username || parsed.password ||
        !["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(parsed.hostname)) {
      throw new Error("Untrusted update redirect.");
    }
    const response = await fetchImpl(parsed.href, { signal, redirect: "manual", cache: "no-store" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("Missing update redirect location.");
      url = new URL(location, parsed).href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Update download failed (HTTP ${response.status}).`);
    }
    return response;
  }
  throw new Error("Too many update redirects.");
}

async function readLimitedJson(response, maxBytes = 1024 * 1024) {
  if (!response.body) throw new Error("Empty update metadata.");
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("Update metadata is too large.");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function selectArtifact(manifest, version, platform, arch) {
  if (!VERSION_PATTERN.test(version) || manifest?.schemaVersion !== 1 || manifest.version !== version) {
    throw new Error("Update metadata does not match the offered version.");
  }
  const artifact = manifest.artifacts?.[`${platform}-${arch}`];
  if (!artifact || !Number.isSafeInteger(artifact.size) || artifact.size <= 0 ||
      artifact.size > MAX_DOWNLOAD_BYTES || !/^[a-f0-9]{64}$/i.test(artifact.sha256 || "") ||
      !/^[a-f0-9]{32}$/i.test(artifact.md5 || "")) {
    throw new Error("No valid update download is available for this computer.");
  }
  const url = validateAssetUrl(artifact.url, version);
  if (platform === "darwin" && !new URL(url).pathname.endsWith(".zip")) {
    throw new Error("The Mac update must be a ZIP archive.");
  }
  if (platform === "win32" && !new URL(url).pathname.toLowerCase().endsWith(".exe")) {
    throw new Error("The Windows update must be a portable EXE.");
  }
  return { url, size: artifact.size, sha256: artifact.sha256.toLowerCase(), md5: artifact.md5.toLowerCase() };
}

async function getReleaseArtifact(version, platform, arch, fetchImpl) {
  const response = await fetchReleaseAsset(releaseAssetUrl(version, "desktop-update.json"), {
    fetchImpl, signal: AbortSignal.timeout(8000),
  });
  return selectArtifact(await readLimitedJson(response), version, platform, arch);
}

async function downloadArtifact(artifact, destination, { fetchImpl, onProgress = () => {}, signal } = {}) {
  signal = signal || AbortSignal.timeout(10 * 60 * 1000);
  const response = await fetchReleaseAsset(artifact.url, { fetchImpl, signal });
  if (!response.body) throw new Error("Empty update download.");
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) !== artifact.size) {
    await response.body.cancel();
    throw new Error("Update download size does not match its metadata.");
  }
  const hash = crypto.createHash("sha256");
  const md5 = crypto.createHash("md5");
  let received = 0;
  const check = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > artifact.size) return callback(new Error("Update download exceeds expected size."));
      hash.update(chunk);
      md5.update(chunk);
      onProgress({ received, total: artifact.size, percent: Math.floor(received / artifact.size * 100) });
      callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), check,
      fs.createWriteStream(destination, { flags: "wx", mode: 0o600 }), { signal });
    if (received !== artifact.size || hash.digest("hex") !== artifact.sha256) {
      throw new Error("Update size or SHA-256 verification failed. The app has not been replaced.");
    }
    if (md5.digest("hex") !== artifact.md5) {
      throw new Error("Update MD5 verification failed. The app has not been replaced.");
    }
  } catch (error) {
    await fs.promises.rm(destination, { force: true });
    throw error;
  }
}

module.exports = { REPOSITORY, VERSION_PATTERN, releaseAssetUrl, validateAssetUrl,
  fetchReleaseAsset, readLimitedJson, selectArtifact, getReleaseArtifact, downloadArtifact };
