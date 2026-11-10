import { getAddress } from "viem";
import { ABI, DOCS_MCP_URL, net } from "./config.js";
import { askDocs, getDocsPage, parseAnswer, searchDocs } from "./docs.js";
import { connect } from "./mcp.js";
import { extractRegistry, TOKEN_REGISTRY_URL } from "./registry.js";

// The agent's knowledge sources besides the chain: the Pharos Developer Docs MCP and the Pharos SkillEngine,
// both read live (SkillEngine from its official GitHub repository, which has no license to vendor it here).

export const SKILL_ENGINE_REPO = "https://github.com/PharosNetwork/pharos-skill-engine";
const SKILL_RAW = "https://raw.githubusercontent.com/PharosNetwork/pharos-skill-engine/main";

export class DocsReader {
  constructor(client) {
    this.client = client;
    this.log = [];
  }

  static async open() {
    return new DocsReader(await connect(DOCS_MCP_URL, "pharos-warden"));
  }

  child() {
    const c = new DocsReader(this.client);
    c.parent = this;
    return c;
  }

  async #logged(tool, args, fn) {
    const entry = { server: "docs", tool, args, ms: 0, ok: true };
    this.log.push(entry);
    this.parent?.log.push(entry);
    const t = Date.now();
    try {
      return await fn();
    } catch (e) {
      entry.ok = false;
      entry.error = String(e.message).slice(0, 200);
      throw e;
    } finally {
      entry.ms = Date.now() - t;
    }
  }

  async ask(question) {
    const text = await this.#logged("askQuestion", { question }, () => askDocs(this.client, question));
    return parseAnswer(text);
  }

  search(query) {
    return this.#logged("searchDocumentation", { query }, () => searchDocs(this.client, query, 5));
  }

  page(url) {
    return this.#logged("getPage", { url }, () => getDocsPage(this.client, url));
  }

  close() {
    return this.client.close?.().catch(() => {});
  }
}

const skillCache = new Map();
/** A file from the SkillEngine repository (cached per server instance). */
export async function skillEngineFile(path) {
  if (skillCache.has(path)) return skillCache.get(path);
  const res = await fetch(`${SKILL_RAW}/${path}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`SkillEngine ${path}: HTTP ${res.status}`);
  const text = await res.text();
  skillCache.set(path, text);
  return text;
}

/** SkillEngine's own rules for write operations: the parts an agent preparing transactions must follow. */
export async function skillEngineRules() {
  const md = await skillEngineFile("SKILL.md");
  const pick = (heading) => md.split(new RegExp(`^## ${heading}`, "m"))[1]?.split(/^## /m)[0]?.trim() ?? "";
  return { source: `${SKILL_ENGINE_REPO}/blob/main/SKILL.md`, securityReminders: pick("Security Reminders"), writePrechecks: pick("Write Operation Pre-checks").slice(0, 2500) };
}

/** SkillEngine's config for the current network. */
export async function skillEngineNetworks() {
  const all = JSON.parse(await skillEngineFile("assets/networks.json"));
  const n = net();
  return { source: `${SKILL_ENGINE_REPO}/blob/main/assets/networks.json`, network: all.networks.find((x) => x.name === n.skillEngineKey) ?? all.networks.find((x) => Number(x.chainId) === n.chainId) ?? null };
}

/**
 * The tokens Warden moves on the current network, checked against three independent sources: the official token
 * registry (Docs MCP getPage), SkillEngine's tokens.json, and the chain itself (symbol() and decimals()).
 * Warden uses the registry's token: when SkillEngine lists another address, the disagreement is reported, not hidden.
 */
export async function verifyTokens(docs, chain) {
  const n = net();
  const [registryMd, skillTokens] = await Promise.all([docs.page(TOKEN_REGISTRY_URL), skillEngineFile("assets/tokens.json").then((t) => JSON.parse(t)[n.skillEngineKey] ?? [])]);
  const registry = extractRegistry(registryMd, n.key);
  const rows = [];
  for (const t of Object.values(net().tokens)) {
    const reg = registry.find((r) => r.symbol === t.symbol);
    const skill = skillTokens.find((r) => r.symbol === t.symbol);
    const [symbol, decimals] = await Promise.all([chain.read(t.address, ABI.erc20, "symbol"), chain.read(t.address, ABI.erc20, "decimals")]);
    const agree = reg?.address === t.address && skill && getAddress(skill.address) === t.address && symbol === t.symbol && Number(decimals) === t.decimals;
    rows.push({ symbol: t.symbol, address: t.address, registry: reg?.address ?? null, skillEngine: skill ? getAddress(skill.address) : null, chain: { symbol, decimals: Number(decimals) }, agree });
  }
  const chainSource = n.chainSource === "mcp" ? "Chain MCP eth_call symbol() / decimals()" : `${n.short} RPC eth_call symbol() / decimals() (the Chain MCP serves Pacific only)`;
  return { network: n.name, sources: { registry: TOKEN_REGISTRY_URL, skillEngine: `${SKILL_ENGINE_REPO}/blob/main/assets/tokens.json`, chain: chainSource }, tokens: rows, allAgree: rows.every((r) => r.agree) };
}
