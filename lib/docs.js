import { callTool } from "./mcp.js";

export const DOCS_ORIGIN = "https://docs.pharos.xyz";

// searchDocumentation returns blocks of "Title: / Link: / Content:".
export function parseResults(text) {
  return text
    .split(/\n(?=Title: )/)
    .map((block) => {
      const title = block.match(/^Title: (.*)$/m)?.[1]?.trim();
      const link = block.match(/^Link: (.*)$/m)?.[1]?.trim();
      const content = block.split(/^Content: /m)[1]?.trim() ?? "";
      return title ? { title, link, content } : null;
    })
    .filter(Boolean);
}

export function snippet(content, max = 240) {
  const flat = content.replace(/\s+/g, " ");
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

/** Accepts full docs URLs and site paths like /getting-started/token-registry. */
export function resolveDocsUrl(input) {
  let url;
  try {
    url = new URL(input, DOCS_ORIGIN);
  } catch {
    return { error: "invalid" };
  }
  if (url.origin !== DOCS_ORIGIN) return { error: "foreign" };
  return { url: url.href };
}

/** Search results with duplicate pages removed. */
export async function searchDocs(client, query, limit = 5) {
  const seen = new Set();
  return parseResults(await callTool(client, "searchDocumentation", { query }))
    .filter((r) => !seen.has(r.link) && seen.add(r.link))
    .slice(0, limit);
}

export function askDocs(client, question, goal) {
  return callTool(client, "askQuestion", { question, ...(goal && { goal }) });
}

const NO_ANSWER = /\b(cannot|can't|could not|couldn't|unable to) find\b|\bno (relevant )?information\b|\bnão (encontrei|há informaç)/i;

/**
 * Splits an askQuestion reply into the answer and its sources (pages cited in the answer first).
 * `found` is false when the docs have nothing on the topic, so callers can say so instead of passing it off as an answer.
 */
export function parseAnswer(text, maxSources = 5) {
  const [body, sourcesPart = ""] = String(text).split(/^#+\s*(?:Sources|Fontes)\s*$/im);
  const answer = body.trim().replace(/\]\((\/[^)\s]*)\)/g, (_, path) => `](${DOCS_ORIGIN}${path})`);
  const cited = new Set([...answer.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]));
  const seen = new Set();
  const sources = [...sourcesPart.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)]
    .map(([, title, url]) => ({ title, url }))
    .filter((s) => !seen.has(s.url) && seen.add(s.url))
    .sort((a, b) => cited.has(b.url) - cited.has(a.url))
    .slice(0, maxSources);
  const sentences = answer.split(/[.!?](?:\s|$)/).filter((s) => s.trim()).length;
  const found = sources.length > 0 && !(NO_ANSWER.test(answer) && sentences <= 1);
  return { answer, sources, found };
}

export function getDocsPage(client, url) {
  return callTool(client, "getPage", { url });
}
