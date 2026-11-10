import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// The conversation lives in the browser between turns, signed by the server: a page cannot forge tool results or
// rewrite what the agent said. Without WARDEN_SESSION_SECRET (local dev) a random per-process secret is used.

const SECRET = process.env.WARDEN_SESSION_SECRET?.trim() || randomBytes(32).toString("hex");
const MAX_BYTES = 180_000;
const sign = (body) => createHmac("sha256", SECRET).update(body).digest("base64url");

export function sealHistory(messages) {
  const body = Buffer.from(JSON.stringify(trim(messages))).toString("base64url");
  return `${body}.${sign(body)}`;
}

/** The history a page sent back, or [] for a new conversation. Throws if it was tampered with. */
export function openHistory(state) {
  if (!state) return [];
  const [body, mac] = String(state).split(".");
  const expected = Buffer.from(sign(body ?? ""));
  const given = Buffer.from(mac ?? "");
  if (!body || expected.length !== given.length || !timingSafeEqual(expected, given)) throw new Error("conversation state is invalid or from another server — start a new conversation");
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
}

/** Keeps the most recent whole turns under MAX_BYTES (a turn starts at a user message with text, not tool results). */
function trim(messages) {
  let m = messages;
  while (JSON.stringify(m).length > MAX_BYTES) {
    const starts = m.map((x, i) => (x.role === "user" && (typeof x.content === "string" || x.content.some?.((b) => b.type === "text")) ? i : -1)).filter((i) => i > 0);
    if (!starts.length) break;
    m = m.slice(starts[0]);
  }
  return m;
}

// Best-effort limits per server instance: protects the model budget from one visitor.
const hits = new Map();
export function rateLimit(key, { max = 20, windowMs = 10 * 60_000 } = {}) {
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (list.length >= max) return { ok: false, retryInSeconds: Math.ceil((windowMs - (now - list[0])) / 1000) };
  list.push(now);
  hits.set(key, list);
  return { ok: true };
}
