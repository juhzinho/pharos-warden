import { isAddress } from "viem";
import { RpcReader, openChain } from "../lib/chain.js";
import { poolStates } from "../lib/defi.js";
import { MODEL } from "../lib/agent.js";
import { OPENAI_MODEL } from "../lib/agent-openai.js";
import { provider } from "./agent.js";
import { DEFAULT_NETWORK, NETWORKS, PERMIT2, explorerAddress, knownTokens, net, withNetwork } from "../lib/config.js";
import { vaultRates, walletOverview } from "../lib/reads.js";
import { verifyExecution } from "../lib/verify.js";
import { createPublicClient, http } from "viem";
import ECOSYSTEM from "../lib/ecosystem.json" with { type: "json" };
import LOGOS from "../lib/logos.json" with { type: "json" };
import { prosHistory, prosMarket } from "../lib/market.js";
import { pool } from "../lib/pool.js";
import { prospilotData } from "../lib/prospilot.js";

const memo = new Map();
/** A short server-side cache: one RPC round per window for every visitor (public RPCs throttle bursts). */
async function cached(key, ttl, fn) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await fn();
  memo.set(key, { at: Date.now(), value });
  return value;
}

/** Live network stats straight from the public RPC: head, block time and TPS over the last 10 blocks, gas price. */
async function networkHealth(n) {
  const c = createPublicClient({ transport: http(n.rpc, { retryCount: 2, timeout: 15_000 }) });
  const head = await c.getBlock();
  const blocks = [head, ...(await pool(Array.from({ length: 10 }, (_, i) => head.number - BigInt(i + 1)), 4, (n) => c.getBlock({ blockNumber: n })))];
  const span = Number(blocks[0].timestamp - blocks.at(-1).timestamp);
  const txs = blocks.slice(0, -1).reduce((s, b) => s + b.transactions.length, 0);
  const gasPrice = await c.getGasPrice();
  return {
    network: n.name, chainId: n.chainId, native: n.native, rpc: n.rpc, explorer: n.explorer, blockNumber: Number(head.number),
    blockTime: span > 0 ? Number((span / (blocks.length - 1)).toFixed(3)) : null, tps: span > 0 ? Number((txs / span).toFixed(2)) : null,
    gasPriceGwei: Number(gasPrice) / 1e9, baseFeeGwei: head.baseFeePerGas != null ? Number(head.baseFeePerGas) / 1e9 : null,
    recent: blocks.slice(0, 10).map((b) => ({ number: Number(b.number), time: Number(b.timestamp), txs: b.transactions.length, gasUsed: Number(b.gasUsed), hash: b.hash })),
  };
}

// GET /api/data?kind=info                                both networks: Warden, tokens, protocols, explorer; the model
// GET /api/data?kind=wallet&address=0x…&network=…       balances, positions, Permit2 approvals, Warden policy
// GET /api/data?kind=rates                               realised 7-day yields of the USDC venues (Pacific Mainnet)
// GET /api/data?kind=verify&hash=0x…&user=0x…&network=…  a Warden transaction checked against its guarantees
// Chain reads go through the Pharos Chain MCP on Pacific and the public RPC on Atlantic. No model call, no key.

const json = (res, status, body, cache = "no-store") =>
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": cache }).end(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

const networkInfo = (key) =>
  withNetwork(key, () => {
    const n = net();
    return {
      key,
      name: n.name,
      short: n.short,
      chainId: n.chainId,
      native: n.native,
      testnet: n.testnet,
      rpc: n.rpc,
      explorer: n.explorer,
      chainSource: n.chainSource === "mcp" ? "Pharos Chain MCP" : `${n.short} RPC`,
      warden: n.warden,
      wardenExplorer: explorerAddress(n.warden),
      deployBlock: n.deployBlock,
      faucet: n.faucet ?? null,
      tokens: knownTokens().map((t) => ({ symbol: t.symbol, address: t.address, decimals: t.decimals })),
      protocols: n.protocols.map((p) => ({ id: p.id, key: p.key, name: p.name, address: p.vault ?? p.pool ?? (p.key === "faroswap_lp" ? n.faroswapV3.npm : n.faroswap.routeProxy) })),
    };
  });

export default async function handler(req, res) {
  const q = new URL(req.url, "http://x").searchParams;
  const kind = q.get("kind");
  if (kind === "info") {
    const model = provider() === "openai" ? OPENAI_MODEL : provider() === "anthropic" ? MODEL : null;
    return json(res, 200, { defaultNetwork: DEFAULT_NETWORK, networks: Object.keys(NETWORKS).map(networkInfo), permit2: PERMIT2, model, agentOnline: Boolean(provider()) }, "public, s-maxage=60");
  }
  // ── the pages (Trade, Network, Ecosystem, News): public data, no wallet ──
  if (kind === "market") {
    const [market, history] = await Promise.all([prosMarket(), prosHistory(q.get("days") ?? 7)]);
    return json(res, 200, { market, history, venues: ECOSYSTEM.venues }, "public, s-maxage=60");
  }
  if (kind === "ecosystem") {
    // each project's own icon, served by this site (scripts/fetch-logos.mjs)
    const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return json(res, 200, { ...ECOSYSTEM, apps: ECOSYSTEM.apps.map((a) => ({ ...a, logo: LOGOS[slug(a.name)] ?? null })) }, "public, s-maxage=3600");
  }
  if (kind === "pools") {
    return withNetwork("pacific", async () => {
      const chain = new RpcReader(net());
      try {
        const pools = await cached("pools", 30_000, () => poolStates(chain));
        return json(res, 200, { network: net().name, pools: pools.map((p) => ({ fee: p.label, address: p.address, price: p.price, tick: p.tick, liquidity: p.liquidity.toString() })) }, "public, s-maxage=30");
      } catch (e) {
        return json(res, 502, { error: `the Pacific RPC did not answer: ${String(e.shortMessage ?? e.message).split("\n")[0].slice(0, 160)}` });
      }
    });
  }
  if (kind === "feed") {
    const [news, tweets, campaigns] = await Promise.all([prospilotData("news"), prospilotData("tweets"), prospilotData("campaigns")]);
    return json(res, 200, { source: "ProsPilot's public API (pharos.xyz blog and news, @pharos_network, Pharos Port campaigns)", news: news.items ?? [], tweets: tweets.tweets ?? [], campaigns: campaigns.campaigns ?? [], available: { news: news.available, tweets: tweets.available, campaigns: campaigns.available } }, "public, s-maxage=300");
  }
  if (kind === "charts") {
    const [charts, rwa] = await Promise.all([prospilotData("charts"), prospilotData("rwa")]);
    return json(res, 200, { charts, rwa }, "public, s-maxage=600");
  }
  if (kind === "health") {
    const key = q.get("network") ?? DEFAULT_NETWORK;
    if (!NETWORKS[key]) return json(res, 400, { error: "network must be atlantic or pacific" });
    try {
      return json(res, 200, await cached(`health:${key}`, 8_000, () => networkHealth(NETWORKS[key])), "public, s-maxage=5");
    } catch (e) {
      return json(res, 502, { error: `the ${NETWORKS[key].short} RPC did not answer: ${String(e.shortMessage ?? e.message).split("\n")[0].slice(0, 160)}` });
    }
  }
  const network = q.get("network") ?? (kind === "rates" ? "pacific" : DEFAULT_NETWORK);
  if (!NETWORKS[network]) return json(res, 400, { error: "network must be atlantic or pacific" });
  if (kind === "rates" && network !== "pacific") return json(res, 400, { error: "the USDC vaults are on Pacific Mainnet" });
  return withNetwork(network, async () => {
    let chain;
    try {
      chain = await openChain(net());
      if (kind === "wallet") {
        const address = q.get("address") ?? "";
        if (!isAddress(address)) return json(res, 400, { error: "address must be a 0x… address" });
        return json(res, 200, { network, ...(await walletOverview(chain, address)) });
      }
      if (kind === "rates") return json(res, 200, await vaultRates(chain), "public, s-maxage=120, stale-while-revalidate=300");
      if (kind === "verify") {
        const hash = q.get("hash") ?? "";
        if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return json(res, 400, { error: "hash must be a transaction hash" });
        const user = q.get("user");
        return json(res, 200, { network, ...(await verifyExecution(chain, hash, user && isAddress(user) ? user : null)) });
      }
      return json(res, 400, { error: "kind must be info, wallet, rates, verify, market, ecosystem, pools, feed, charts or health" });
    } catch (e) {
      const source = net().chainSource === "mcp" ? "The Pharos Chain MCP" : `The ${net().short} RPC`;
      return json(res, 502, { error: `${source} did not answer: ${String(e.message).split("\n")[0].slice(0, 200)}` });
    } finally {
      await chain?.close();
    }
  });
}
