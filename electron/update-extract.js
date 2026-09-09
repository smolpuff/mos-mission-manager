"use strict";

// Electron's fs wrapper interprets *.asar as virtual directories. Incoming app.asar
// must be written as an ordinary file, including while it is incomplete.
const rawFs = process.versions.electron ? require("original-fs") : require("node:fs");
const fs = rawFs.promises;
const { createWriteStream } = rawFs;
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const yauzl = require("yauzl");

const MAX_EXPANDED_BYTES = 6 * 1024 ** 3;
const MAX_ENTRIES = 40000;

function safeEntryName(name, bundleName) {
  if (typeof name !== "string" || /[\\\x00-\x1f\x7f:]/.test(name) ||
      name.startsWith("/") || name.split("/").some((part) => part === ".." || part === ".") ||
      name.includes("//") || (name !== `${bundleName}/` && !name.startsWith(`${bundleName}/`))) {
    throw new Error("The update ZIP contains an unsafe file path.");
  }
  return name.replace(/\/$/, "");
}

async function extractAppZip(archive, destination, bundleName, { maxBytes = MAX_EXPANDED_BYTES } = {}) {
  await fs.mkdir(destination, { mode: 0o700 });
  const zip = await new Promise((resolve, reject) => yauzl.open(archive,
    { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
    (error, result) => error ? reject(error) : resolve(result)));
  const entries = [];
  const names = new Map();
  let expandedBytes = 0;
  // Read all metadata first so no file can be written through an archive symlink.
  try {
    await new Promise((resolve, reject) => {
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry) => {
        try {
          const name = safeEntryName(entry.fileName, bundleName);
          const key = name.normalize("NFD").toLowerCase();
          if (names.has(key)) throw new Error("The update ZIP has duplicate file paths.");
          const mode = entry.externalFileAttributes >>> 16;
          const type = mode & 0o170000;
          if (entry.isEncrypted() || ![0, 0o040000, 0o100000, 0o120000].includes(type)) {
            throw new Error("The update ZIP contains an unsupported entry.");
          }
          expandedBytes += entry.uncompressedSize;
          if (expandedBytes > maxBytes || entries.length >= MAX_ENTRIES) throw new Error("The extracted update is too large.");
          const item = { entry, name, key, mode, symlink: type === 0o120000,
            directory: entry.fileName.endsWith("/") };
          if (item.directory && item.symlink) throw new Error("Invalid ZIP directory.");
          names.set(key, item);
          entries.push(item);
          zip.readEntry();
        } catch (error) { reject(error); }
      });
      zip.readEntry();
    });
  } finally { zip.close(); }
  for (const item of entries) {
    const segments = item.key.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const parent = names.get(segments.slice(0, index).join("/"));
      if (parent && !parent.directory) throw new Error("The update ZIP writes through a file or symlink.");
    }
  }
  // Reopen after the metadata pass (yauzl automatically closes on end).
  const reader = await new Promise((resolve, reject) => yauzl.open(archive,
    { lazyEntries: true, autoClose: false, strictFileNames: true },
    (error, result) => error ? reject(error) : resolve(result)));
  const streamFor = (entry) => new Promise((resolve, reject) => reader.openReadStream(entry,
    (error, stream) => error ? reject(error) : resolve(stream)));
  const links = [];
  try {
    for (const item of entries) {
      const target = path.join(destination, item.name);
      if (item.directory) {
        await fs.mkdir(target, { recursive: true, mode: 0o755 });
      } else if (item.symlink) {
        if (item.entry.uncompressedSize > 4096) throw new Error("Invalid update symlink.");
        const chunks = [];
        for await (const chunk of await streamFor(item.entry)) chunks.push(chunk);
        const link = Buffer.concat(chunks).toString("utf8");
        if (!link || /[\\\x00-\x1f\x7f]/.test(link) || path.posix.isAbsolute(link)) throw new Error("Unsafe update symlink.");
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(item.name), link));
        if (!resolved.startsWith(`${bundleName}/`)) throw new Error("Update symlink escapes the application.");
        links.push({ target, link });
      } else {
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
        await pipeline(await streamFor(item.entry), createWriteStream(target, {
          flags: "wx", mode: (item.mode & 0o111) ? 0o755 : 0o644,
        }));
      }
    }
    for (const { target, link } of links) {
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
      await fs.symlink(link, target);
    }
    const root = await fs.realpath(path.join(destination, bundleName));
    for (const { target } of links) {
      const resolved = await fs.realpath(target);
      if (!resolved.startsWith(root + path.sep)) throw new Error("Update symlink resolves outside the application.");
    }
    return root;
  } finally { reader.close(); }
}

module.exports = { safeEntryName, extractAppZip };
