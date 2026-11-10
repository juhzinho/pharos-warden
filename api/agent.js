import Anthropic from "@anthropic-ai/sdk";
import { isAddress } from "viem";
import { agentTurn } from "../lib/agent.js";
import { ChainReader } from "../lib/chain.js";
import { openHistory, rateLimit, sealHistory } from "../lib/session.js";
import { DocsReader } from "../lib/sources.js";

// POST /api/agent  { message, user?, state? }  →  text/event-stream of agent events, ending with { type: "state" }.
// The model key (ANTHROPIC_API_KEY) stays on the server. No private key exists anywhere in this app.

export const config = { maxDuration: 120 };

async function body(req) {
  if (req.body != null) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  let s = "";
  for await (const d of req) {
    s += d;
    if (s.length > 400_000) throw new Error("request too large");
  }
  return s ? JSON.parse(s) : {};
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.writeHead(405, { "content-type": "application/json" }).end(JSON.stringify({ error: "POST" }));
  const ip = String(req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "local").split(",")[0].trim();
  const limit = rateLimit(ip);
  const fail = (status, error) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error }));
  if (!limit.ok) return fail(429, `Too many messages — try again in ${limit.retryInSeconds} s.`);
  if (!process.env.ANTHROPIC_API_KEY) return fail(503, "The agent is offline on this deployment (no model key configured).");

  let input;
  let history;
  try {
    input = await body(req);
    history = openHistory(input.state);
  } catch (e) {
    return fail(400, e.message);
  }
  const message = String(input.message ?? "").trim();
  if (!message || message.length > 2000) return fail(400, "Write a message (up to 2,000 characters).");
  if (input.user != null && !isAddress(String(input.user))) return fail(400, "The connected wallet address is not valid.");

  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
  const emit = (event) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event, (_, v) => (typeof v === "bigint" ? v.toString() : v))}\n\n`);
  };
  const abort = new AbortController();
  req.on("close", () => abort.abort());

  let chain;
  let docs;
  try {
    [chain, docs] = await Promise.all([ChainReader.open(), DocsReader.open()]);
    history.push({ role: "user", content: message });
    const next = await agentTurn({ client: new Anthropic(), messages: history, user: input.user ?? null, chain, docs, emit, signal: abort.signal });
    emit({ type: "state", state: sealHistory(next), mcp: { chain: chain.log.length, docs: docs.log.length } });
    emit({ type: "done" });
  } catch (e) {
    const msg =
      e instanceof Anthropic.RateLimitError ? "The model is busy right now — try again in a minute."
      : e instanceof Anthropic.AuthenticationError ? "The agent's model key is not valid on this deployment."
      : e instanceof Anthropic.APIError ? `The model service returned an error (${e.status}).`
      : abort.signal.aborted ? "Stopped."
      : `Something failed: ${String(e.message).split("\n")[0].slice(0, 200)}`;
    emit({ type: "error", message: msg });
  } finally {
    await Promise.all([chain?.close(), docs?.close()]);
    res.end();
  }
}
