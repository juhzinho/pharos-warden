// Local stand-in for Vercel: serves public/ and routes /api/* to the same handlers. Loads .env (git-ignored).
//   npm run web        http://localhost:3200
import http from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ENV = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(ENV)) process.loadEnvFile(ENV);
const routes = { "/api/agent": (await import("../api/agent.js")).default, "/api/data": (await import("../api/data.js")).default, "/api/x402": (await import("../api/x402.js")).default };
const PORT = Number(process.env.PORT ?? 3200);
const ROOT = fileURLToPath(new URL("../public/", import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

http
  .createServer(async (req, res) => {
    const { pathname } = new URL(req.url, "http://localhost");
    if (routes[pathname]) return routes[pathname](req, res);
    // clean URLs like Vercel's cleanUrls: /trade → trade.html
    const asked = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
    const file = normalize(extname(asked) ? asked : `${asked}.html`);
    if (file.startsWith("..")) return res.writeHead(403).end();
    try {
      const body = await readFile(join(ROOT, file));
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  })
  .listen(PORT, () => console.log(`http://localhost:${PORT}`));
