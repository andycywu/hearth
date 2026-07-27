#!/usr/bin/env node
/**
 * Zero-dependency static file server for local development.
 *
 *   node tools/serve.mjs <dir> [port]
 *
 * Used by `pnpm dev` to serve the bundled dev harness at http://localhost:5173.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, join, normalize } from "node:path";

const dir = resolve(process.cwd(), process.argv[2] ?? ".");
const port = Number(process.argv[3] ?? 5173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const rel = normalize(urlPath === "/" ? "/index.html" : urlPath).replace(/^(\.\.[/\\])+/, "");
    const file = join(dir, rel);
    if (!file.startsWith(dir)) { res.writeHead(403).end("Forbidden"); return; }
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
});

server.listen(port, () => {
  console.log(`Serving ${dir} at http://localhost:${port}`);
});
