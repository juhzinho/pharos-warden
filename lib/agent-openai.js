import OpenAI from "openai";
import { getAddress } from "viem";
import { rpcClient, runTool, systemFor, toolsFor } from "./agent.js";

// The Warden agent on the OpenAI API (Chat Completions with streamed function calls). Same tools, same system
// prompt and the same safety model as the Claude loop in agent.js: the model reads and decides; every proposal is
// built and dry-run by deterministic code; the user signs its guarantees in their own wallet.

export const OPENAI_MODEL = process.env.OPENAI_MODEL?.trim() || "gpt-5.5";
const MAX_ROUNDS = 10;

/** Warden's tool schemas (of the current network) in OpenAI's function-tool shape. */
export const openaiTools = () => toolsFor().map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));

const json = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

/**
 * One user turn: stream the model, run the functions it calls, loop until it answers. `messages` is the history in
 * Chat Completions format without the system prompt; the updated history is returned for the next turn.
 */
export async function openaiTurn({ client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY?.trim() }), messages, user, lang = "en", chain, docs, emit, signal }) {
  const ctx = { user: user ? getAddress(user) : null, lang, chain, docs, rpc: rpcClient(), emit, cache: new Map() };
  const history = [...messages];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const stream = await client.chat.completions.create(
      {
        model: OPENAI_MODEL,
        stream: true,
        stream_options: { include_usage: true },
        tools: openaiTools(),
        parallel_tool_calls: true,
        messages: [
          { role: "system", content: systemFor() },
          ...history,
          { role: "system", content: `Connected wallet: ${ctx.user ?? "none (the user has not connected a wallet yet)"}. Today: ${new Date().toISOString().slice(0, 10)}.` },
        ],
      },
      { signal },
    );
    let text = "";
    let finish = null;
    const calls = new Map(); // index → { id, name, args }
    for await (const chunk of stream) {
      if (chunk.usage) emit({ type: "usage", usage: chunk.usage });
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (delta.content) {
        text += delta.content;
        emit({ type: "text", delta: delta.content });
      }
      for (const tc of delta.tool_calls ?? []) {
        const c = calls.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) c.args += tc.function.arguments;
        calls.set(tc.index, c);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    const toolCalls = [...calls.values()];
    history.push({ role: "assistant", content: text || null, ...(toolCalls.length && { tool_calls: toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args } })) }) });
    if (finish === "length") throw new Error("the answer was cut off");
    if (finish === "content_filter") {
      emit({ type: "text", delta: "\n\n(The model declined this request.)" });
      return history;
    }
    if (!toolCalls.length) return history;

    const results = await Promise.all(
      toolCalls.map(async (c) => {
        let input;
        try {
          input = c.args ? JSON.parse(c.args) : {};
        } catch {
          return { role: "tool", tool_call_id: c.id, content: json({ error: "the arguments were not valid JSON — call the tool again" }) };
        }
        emit({ type: "tool_start", id: c.id, name: c.name, input });
        const own = { chain: chain.child(), docs: docs.child() };
        const t = Date.now();
        const result = await runTool({ ...ctx, ...own }, c.name, input);
        const mcp = [...own.chain.log, ...own.docs.log];
        emit({ type: "tool_end", id: c.id, name: c.name, ok: !result?.error, ms: Date.now() - t, result: result?.error ? { error: result.error } : undefined, calls: mcp.map((x) => ({ server: x.server, tool: x.tool, ms: x.ms, ok: x.ok })) });
        return { role: "tool", tool_call_id: c.id, content: json(result) };
      }),
    );
    history.push(...results);
  }
  emit({ type: "text", delta: "\n\n(Stopped after too many steps — please ask again more specifically.)" });
  return history;
}
