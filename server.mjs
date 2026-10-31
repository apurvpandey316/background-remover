// Local background-removal app. Runs entirely on this machine.
//   POST /api/upload   raw image bytes -> { id, width, height }   (runs the AI model once)
//   GET  /api/render   ?id=..&scale=..&rescue=..  -> PNG          (fast clean-up, re-run per tweak)
import http from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { removeBackground } from "@imgly/background-removal-node";
import { renderCutout, DEFAULTS, clampScale } from "./process.mjs";

const PORT = Number(process.env.PORT) || 5178;
const MAX_UPLOAD = 25 * 1024 * 1024;
const MAX_SOURCE_SIDE = 4000;
const CACHE_SIZE = 8;

const cache = new Map(); // id -> { original, mask, width, height }

function remember(id, entry) {
  cache.set(id, entry);
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_UPLOAD) { reject(Object.assign(new Error("Image is larger than 25 MB"), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handleUpload(req, res) {
  const body = await readBody(req);
  let png;
  try {
    // Normalise any format to an upright PNG, capped so 4x output stays manageable.
    png = await sharp(body).rotate()
      .resize(MAX_SOURCE_SIDE, MAX_SOURCE_SIDE, { fit: "inside", withoutEnlargement: true })
      .png().toBuffer();
  } catch {
    throw Object.assign(new Error("That file isn't an image I can read"), { status: 400 });
  }
  const { width, height } = await sharp(png).metadata();

  const t0 = Date.now();
  const cutout = await removeBackground(new Blob([png], { type: "image/png" }), {
    model: "medium",
    output: { format: "image/png" },
  });
  const mask = await sharp(Buffer.from(await cutout.arrayBuffer()))
    .ensureAlpha().extractChannel(3).raw().toBuffer();
  console.log(`model: ${width}x${height} in ${Date.now() - t0} ms`);

  const id = randomUUID();
  remember(id, { original: png, mask, width, height });
  json(res, 200, { id, width, height, maxScale: clampScale(4, width, height) });
}

async function handleRender(url, res) {
  const entry = cache.get(url.searchParams.get("id"));
  if (!entry) throw Object.assign(new Error("Image expired, please upload it again"), { status: 404 });

  const opts = {};
  for (const key of Object.keys(DEFAULTS)) {
    const v = url.searchParams.get(key);
    if (v === null) continue;
    opts[key] = typeof DEFAULTS[key] === "boolean" ? v === "true" : Number(v);
  }
  const t0 = Date.now();
  const out = await renderCutout(entry.original, entry.mask, entry.width, entry.height, opts);
  res.writeHead(200, {
    "Content-Type": "image/png",
    "X-Width": out.width,
    "X-Height": out.height,
    "X-Render-Ms": Date.now() - t0,
    "Cache-Control": "no-store",
  });
  res.end(out.png);
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const indexHtml = new URL("./index.html", import.meta.url);

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(await readFile(indexHtml));
    } else if (req.method === "POST" && url.pathname === "/api/upload") {
      await handleUpload(req, res);
    } else if (req.method === "GET" && url.pathname === "/api/render") {
      await handleRender(url, res);
    } else if (req.method === "GET" && url.pathname === "/api/defaults") {
      json(res, 200, DEFAULTS);
    } else {
      json(res, 404, { error: "Not found" });
    }
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, err.status || 500, { error: err.message || "Something went wrong" });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`Background remover running at http://localhost:${PORT}`));
