import { isAddress } from "viem";
import { ChainReader } from "../lib/chain.js";
import { openHistory, rateLimit, sealHistory } from "../lib/session.js";
import { DocsReader } from "../lib/sources.js";

// POST /api/agent  { message, user?, state? }  →  text/event-stream of agent events, ending with { type: "state" }.
// The model runs on OpenAI (OPENAI_API_KEY) or Anthropic (ANTHROPIC_API_KEY); the key stays on the server.
// No private key exists anywhere in this app.

export const provider = () => (process.env.OPENAI_API_KEY?.trim() ? "openai" : process.env.ANTHROPIC_API_KEY?.trim() ? "anthropic" : null);

async function body(req) {
  if (req.body != null) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  let s = "";
  for await (const d of req) {
    s += d;
    if (s.length > 400_000) throw new Error("request too large");
  }
  return s ? JSON.parse(s) : {};
}

/** Maps a model-provider error to a sentence for the user (no stack, no key, no request body). */
function explain(e, aborted) {
  if (aborted) return "Stopped.";
  const status = e?.status;
  if (status === 429) return "The model is busy right now — try again in a minute.";
  if (status === 401 || status === 403) return "The agent's model key is not valid on this deployment.";
  if (status === 404) return "The configured model is not available for this key.";
  if (typeof status === "number") return `The model service returned an error (${status}).`;
  return `Something failed: ${String(e?.message ?? e).split("\n")[0].slice(0, 200)}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.writeHead(405, { "content-type": "application/json" }).end(JSON.stringify({ error: "POST" }));
  const ip = String(req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "local").split(",")[0].trim();
  const fail = (status, error) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error }));
  const which = provider();
  if (!which) return fail(503, "The agent is offline on this deployment (no model key configured).");
  const limit = rateLimit(ip);
  if (!limit.ok) return fail(429, `Too many messages — try again in ${limit.retryInSeconds} s.`);

  let input;
  let history;
  try {
    input = await body(req);
    const [tag, sealed] = String(input.state ?? "").split(/:(.*)/s);
    // a conversation started on the other provider cannot continue here: its history format differs
    history = tag === which ? openHistory(sealed) : [];
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
    const args = { messages: history, user: input.user ?? null, chain, docs, emit, signal: abort.signal };
    const next = which === "openai" ? await (await import("../lib/agent-openai.js")).openaiTurn(args) : await (await import("../lib/agent.js")).agentTurn(args);
    emit({ type: "state", state: `${which}:${sealHistory(next)}`, mcp: { chain: chain.log.length, docs: docs.log.length } });
    emit({ type: "done" });
  } catch (e) {
    emit({ type: "error", message: explain(e, abort.signal.aborted) });
  } finally {
    await Promise.all([chain?.close(), docs?.close()]);
    res.end();
  }
}
