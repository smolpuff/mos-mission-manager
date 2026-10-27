"use strict";
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { ANNOUNCEMENTS_URL, ANNOUNCEMENTS_BRANCH } = require("../../lib/announcements");
const { prepareFeed, publish, githubApi, IMAGE_FILE } = require("./publish.cjs");
const { createIdAllocator } = require("./next-id.cjs");
const dataDir = process.env.MISSIONS_ANNOUNCEMENT_EDITOR_DATA || path.join(__dirname, ".local");
const draftFile = path.join(dataDir, "draft.json");
const token = crypto.randomBytes(32).toString("hex");
async function readBody(request, limit) {
  let size = 0; const chunks = [];
  for await (const chunk of request) { size += chunk.length; if (size > limit) throw new Error("File or request too large."); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "png";
  if (bytes.subarray(0, 3).equals(Buffer.from([255,216,255]))) return "jpg";
  if (["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return "gif";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
  throw new Error("Choose a PNG, JPEG, WebP or GIF image (up to 5 MB).");
}
async function main() {
  const nextId = createIdAllocator(dataDir);
  const { createServer } = await import("vite");
  const { default: react } = await import("@vitejs/plugin-react");
  const { default: tailwind } = await import("@tailwindcss/vite");
  const vite = await createServer({ configFile: false, root: __dirname, plugins: [react(), tailwind()], server: { middlewareMode: true, hmr: false, fs: { allow: [path.resolve(__dirname, "../..")] } }, appType: "spa" });
  let origin, publishing = false;
  const server = http.createServer(async (request, response) => {
    const json = (value, status = 200) => { response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify(value)); };
    // Loopback only, exact Host, and a per-session token on writes. No browser credentials or public admin endpoint.
    if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)) return json({ error: "Local access only." }, 403);
    const url = new URL(request.url, origin);
    if (!url.pathname.startsWith("/api/")) return vite.middlewares(request, response);
    try {
      if (request.method === "GET" && url.pathname === "/api/session") {
        const draft = await fs.readFile(draftFile, "utf8").then(JSON.parse).catch(error => { if (error.code !== "ENOENT") throw error; return { announcements: [] }; });
        return json({ token, draft, destination: ANNOUNCEMENTS_URL, branch: ANNOUNCEMENTS_BRANCH });
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/images/")) {
        const name = url.pathname.slice("/api/images/".length);
        if (!IMAGE_FILE.test(name)) throw new Error("Invalid image.");
        const bytes = await fs.readFile(path.join(dataDir, "images", name));
        response.writeHead(200, { "Content-Type": `image/${name.endsWith(".jpg") ? "jpeg" : name.split(".").at(-1)}`, "X-Content-Type-Options": "nosniff" }); response.end(bytes); return;
      }
      if (request.method !== "POST" || request.headers["x-announcement-token"] !== token) return json({ error: "Invalid editor session. Reload this page." }, 403);
      if (url.pathname === "/api/image") {
        const bytes = await readBody(request, 5 * 1024 * 1024);
        const name = crypto.createHash("sha256").update(bytes).digest("hex") + "." + imageType(bytes);
        await fs.mkdir(path.join(dataDir, "images"), { recursive: true });
        await fs.writeFile(path.join(dataDir, "images", name), bytes, { mode: 0o600 });
        return json({ imageFile: name });
      }
      if (url.pathname === "/api/load-published") {
        let file;
        try { file = await githubApi(`contents/announcements.json?ref=${ANNOUNCEMENTS_BRANCH}`); }
        catch (error) {
          if (/HTTP 404/.test(error.message)) throw new Error("No announcements have been published yet. Your local draft is unchanged.");
          throw error;
        }
        const draft = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
        prepareFeed(draft);
        return json({ draft: { ...draft, announcements: draft.announcements.map(item => ({ ...item, publishedId: item.id })) } });
      }
      const body = JSON.parse((await readBody(request, 256 * 1024)).toString("utf8"));
      if (url.pathname === "/api/publish" || url.pathname === "/api/remove") {
        if (publishing) throw new Error("A publish or removal is already in progress.");
        publishing = true;
        try { return json(await publish(body.announcement, { dataDir, publishedId: body.publishedId || null, remove: url.pathname === "/api/remove" })); }
        finally { publishing = false; }
      }
      if (!Array.isArray(body?.announcements) || body.announcements.length > 20) throw new Error("Use at most 20 announcements.");
      if (url.pathname === "/api/new") {
        return json({ id: await nextId(body.announcements), startsAt: new Date().toISOString() });
      }
      if (url.pathname === "/api/save") {
        await fs.mkdir(dataDir, { recursive: true });
        await fs.writeFile(draftFile + ".next", JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
        await fs.rename(draftFile + ".next", draftFile);
        return json({ saved: true });
      }
      return json({ error: "Not found." }, 404);
    } catch (error) { return json({ error: error.message }, 400); }
  });
  server.listen(Number(process.env.MISSIONS_ANNOUNCEMENT_EDITOR_PORT || 0), "127.0.0.1", () => { origin = `http://127.0.0.1:${server.address().port}`; console.log(`\nAnnouncement editor: ${origin}\nDrafts stay local. Publish and Remove affect only the selected announcement.\n`); });
  const stop = () => { server.closeAllConnections(); server.close(); void vite.close().then(() => process.exit(0)); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { imageType };
