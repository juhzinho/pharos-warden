// Builds lib/ecosystem.json:
// - the projects, descriptions and categories: the official Pharos Port directory (port.pharos.xyz/ecosystem, "Active"
//   tab, read on 2026-11-10 into scripts/port-ecosystem.txt; two typos of the page fixed: "Openzepplin", "Analaytics");
// - each project's link and Portuguese description: ProsPilot's curated directory (../pharos-agent/lib/knowledge.ts)
//   when the name matches, else the official ecosystem page;
// - where to trade PROS: ProsPilot's PROS_CEX_LINKS (../pharos-agent/lib/prices.ts).
//   node scripts/build-ecosystem.mjs
import { readFileSync, writeFileSync } from "node:fs";

const PORT_URL = "https://port.pharos.xyz/ecosystem";
const port = readFileSync(new URL("port-ecosystem.txt", import.meta.url), "utf8").trim().split("\n").map((l) => {
  const [name, desc, cats] = l.split("|");
  return { name, desc, categories: cats.split(",").map((c) => c.trim()) };
});
const knowledge = readFileSync(new URL("../../pharos-agent/lib/knowledge.ts", import.meta.url), "utf8");
const start = knowledge.indexOf("export const ECOSYSTEM_DAPPS");
const prospilot = [...knowledge.slice(start, knowledge.indexOf("\n};", start)).matchAll(/\{ name: "([^"]+)", url: "([^"]+)", desc: "([^"]+)", descPt: "([^"]+)" \}/g)].map((a) => ({ name: a[1], url: a[2], descPt: a[4] }));
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/security$|wallet$|labs$/, "");
const apps = port.map((p) => {
  const m = prospilot.find((x) => norm(x.name) === norm(p.name)) ?? prospilot.find((x) => norm(x.name).startsWith(norm(p.name)) || norm(p.name).startsWith(norm(x.name)));
  return { ...p, url: m?.url ?? PORT_URL, ...(m && { descPt: m.descPt }), linkFrom: m ? "ProsPilot directory" : "official ecosystem page" };
});
const categories = [...new Set(apps.flatMap((a) => a.categories))].map((name) => ({ name, apps: apps.filter((a) => a.categories.includes(name)).map((a) => a.name) }));
const prices = readFileSync(new URL("../../pharos-agent/lib/prices.ts", import.meta.url), "utf8");
const ps = prices.indexOf("PROS_CEX_LINKS");
const venues = [...prices.slice(ps, prices.indexOf("];", ps)).matchAll(/\{ name: "([^"]+)", url: "([^"]+)" \}/g)].map((v) => ({ name: v[1], url: v[2] }));
writeFileSync(new URL("../lib/ecosystem.json", import.meta.url), `${JSON.stringify({ source: `Official Pharos Port directory (${PORT_URL}), read 2026-11-10; links from ProsPilot's directory`, apps, categories, venues }, null, 1)}\n`);
console.log(`${apps.length} projects, ${categories.length} categories, ${apps.filter((a) => a.linkFrom === "ProsPilot directory").length} with a direct link; ${venues.length} PROS venues`);
