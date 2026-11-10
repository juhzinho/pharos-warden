import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// The hosted Chain MCP rate-limits each IP (120 requests/minute by default) and drops connections under load.
// Retries are short: this runs inside a web request that must answer within a minute.
const MAX_CONCURRENT = 4;
const RETRIES = 3;
const CALL_TIMEOUT_MS = 45_000;

const TRANSIENT = /fetch failed|network|socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|UND_ERR|timed? ?out|aborted|\b(429|500|502|503|504)\b|rate limit|too many requests/i;

/** Network or server hiccup, as opposed to a tool that answered with an error. */
export class TransientError extends Error {}

export const isTransient = (error) => error instanceof TransientError || TRANSIENT.test(`${error?.message} ${error?.cause?.message ?? ""} ${error?.cause?.code ?? ""}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RATE_LIMITED = /\b429\b|too many requests|rate limit/i;

async function withRetry(fn, label) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= RETRIES || !isTransient(error)) {
        if (isTransient(error)) throw new TransientError(`${label}: the network or server failed ${RETRIES + 1} times in a row (${error.message})`);
        throw error;
      }
      const wait = RATE_LIMITED.test(error.message) ? Math.min(4000 * (attempt + 1), 12_000) : Math.min(500 * 2 ** attempt, 4000);
      await sleep(wait + Math.random() * 400);
    }
  }
}


function limiter(max) {
  let active = 0;
  const queue = [];
  return async (fn) => {
    if (active >= max) await new Promise((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

const limits = new WeakMap();
const callLogs = new WeakMap();

/** Tool names called on this client since the last call to this function. */
export function takeCallLog(client) {
  const log = callLogs.get(client) ?? [];
  callLogs.set(client, []);
  return log;
}

export async function connect(url, name = "pharos-warden") {
  return withRetry(async () => {
    const client = new Client({ name, version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)), { timeout: CALL_TIMEOUT_MS });
    limits.set(client, limiter(MAX_CONCURRENT));
    return client;
  }, `connect to ${url}`);
}

export async function listTools(client) {
  const { tools } = await withRetry(() => client.listTools(undefined, { timeout: CALL_TIMEOUT_MS }), "list tools");
  return tools;
}

export function toolText(result) {
  return (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

export async function callTool(client, name, args = {}) {
  const limit = limits.get(client) ?? ((fn) => fn());
  if (!callLogs.has(client)) callLogs.set(client, []);
  callLogs.get(client).push(name);
  const result = await limit(() =>
    withRetry(async () => {
      const r = await client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
      if (r.isError && TRANSIENT.test(toolText(r))) throw new TransientError(toolText(r));
      return r;
    }, name)
  );
  const text = toolText(result);
  if (result.isError) throw new Error(`${name} failed: ${text}`);
  return text;
}

// Chain MCP tools return JSON encoded as text.
export async function callJson(client, name, args = {}) {
  return JSON.parse(await callTool(client, name, args));
}
