import { isAddress } from "viem";
import { rateLimit } from "../lib/session.js";
import { CATALOG, settle } from "../lib/x402.js";

// POST /api/x402  { item, address?, user, payment, typedData, signature }
// Completes an x402 purchase the agent prepared: the user's own signature (made in their wallet) goes into the payment,
// the paid request is made to the catalog's resource only, and the data and the settlement transaction come back.
// No key here: the server only relays what the user signed, after checking it is exactly what was prepared.

async function body(req) {
  if (req.body != null) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  let s = "";
  for await (const d of req) {
    s += d;
    if (s.length > 50_000) throw new Error("request too large");
  }
  return s ? JSON.parse(s) : {};
}

export default async function handler(req, res) {
  const send = (status, b) => res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify(b));
  if (req.method !== "POST") return send(405, { error: "POST" });
  const ip = String(req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "local").split(",")[0].trim();
  if (!rateLimit(`x402:${ip}`, { max: 10 }).ok) return send(429, { error: "Too many payments — wait a minute." });
  let b;
  try {
    b = await body(req);
  } catch (e) {
    return send(400, { error: e.message });
  }
  if (!CATALOG[b.item]) return send(400, { error: "unknown item" });
  if (!isAddress(String(b.user ?? ""))) return send(400, { error: "user must be the connected wallet's address" });
  try {
    const r = await settle(b);
    return send(r.paid ? 200 : 402, r);
  } catch (e) {
    return send(400, { error: String(e.message).split("\n")[0].slice(0, 200) });
  }
}
