// Fetches each project's own published icon (the apple-touch-icon / icon its homepage declares, else /favicon.ico) for
// the ecosystem directory and the wallet picker, and stores them under public/img/logos/ so the site serves them
// itself. Only images are kept (content-type image/*, ≤ 256 KB). Writes lib/logos.json { slug: "/img/logos/…" }.
//   node scripts/fetch-logos.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const OUT = new URL("../public/img/logos/", import.meta.url);
mkdirSync(OUT, { recursive: true });
const eco = JSON.parse(readFileSync(new URL("../lib/ecosystem.json", import.meta.url), "utf8"));
const PORT = "https://port.pharos.xyz/ecosystem";
export const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const targets = [
  ...eco.apps.filter((a) => a.url !== PORT).map((a) => ({ key: slug(a.name), url: a.url })),
  { key: "wallet-metamask", url: "https://metamask.io/" },
  { key: "wallet-okx-wallet", url: "https://web3.okx.com/" },
  { key: "wallet-rabby", url: "https://rabby.io/" },
];
const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36", accept: "text/html,*/*" };
const EXT = { "image/png": "png", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico", "image/svg+xml": "svg", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

/** The icon links a page declares, best first (apple-touch-icon, then the largest sized icon, then any icon). */
function iconLinks(html, base) {
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
  const out = [];
  for (const l of links) {
    const rel = (l.match(/rel=["']([^"']+)["']/i)?.[1] ?? "").toLowerCase();
    const href = l.match(/href=["']([^"']+)["']/i)?.[1];
    if (!href || !/icon/.test(rel)) continue;
    const size = Number(l.match(/sizes=["'](\d+)x\d+["']/i)?.[1] ?? 0);
    const score = (rel.includes("apple-touch-icon") ? 1000 : 0) + size + (/\.svg(\?|$)/i.test(href) ? 300 : 0);
    try {
      out.push({ url: new URL(href, base).href, score });
    } catch {}
  }
  return out.sort((a, b) => b.score - a.score).map((x) => x.url);
}

async function get(url, accept) {
  const r = await fetch(url, { headers: { ...UA, ...(accept && { accept }) }, redirect: "follow", signal: AbortSignal.timeout(15_000) });
  return r;
}

const result = {};
for (const t of targets) {
  let saved = null;
  try {
    const page = await get(t.url);
    const html = page.ok ? await page.text() : "";
    const candidates = [...iconLinks(html, page.url || t.url), new URL("/favicon.ico", page.url || t.url).href];
    for (const c of candidates) {
      if (c.startsWith("data:")) continue;
      try {
        const r = await get(c, "image/*");
        const type = (r.headers.get("content-type") ?? "").split(";")[0].trim();
        const buf = Buffer.from(await r.arrayBuffer());
        if (!r.ok || !EXT[type] || buf.length < 100 || buf.length > 256_000) continue;
        const file = `${t.key}.${EXT[type]}`;
        writeFileSync(new URL(file, OUT), buf);
        saved = `/img/logos/${file}`;
        break;
      } catch {}
    }
  } catch {}
  result[t.key] = saved;
  console.log(saved ? "ok  " : "none", t.key, saved ?? t.url);
}
writeFileSync(new URL("../lib/logos.json", import.meta.url), `${JSON.stringify(result, null, 1)}\n`);
console.log(`${Object.values(result).filter(Boolean).length} of ${targets.length} logos`);
