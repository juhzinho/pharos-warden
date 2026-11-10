import { isAddress } from "viem";
import { openChain } from "../lib/chain.js";
import { MODEL } from "../lib/agent.js";
import { OPENAI_MODEL } from "../lib/agent-openai.js";
import { provider } from "./agent.js";
import { DEFAULT_NETWORK, NETWORKS, PERMIT2, explorerAddress, knownTokens, net, withNetwork } from "../lib/config.js";
import { vaultRates, walletOverview } from "../lib/reads.js";
import { verifyExecution } from "../lib/verify.js";

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
      protocols: n.protocols.map((p) => ({ id: p.id, key: p.key, name: p.name, address: p.vault ?? p.pool ?? n.faroswap.routeProxy })),
    };
  });

export default async function handler(req, res) {
  const q = new URL(req.url, "http://x").searchParams;
  const kind = q.get("kind");
  if (kind === "info") {
    const model = provider() === "openai" ? OPENAI_MODEL : provider() === "anthropic" ? MODEL : null;
    return json(res, 200, { defaultNetwork: DEFAULT_NETWORK, networks: Object.keys(NETWORKS).map(networkInfo), permit2: PERMIT2, model, agentOnline: Boolean(provider()) }, "public, s-maxage=60");
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
      return json(res, 400, { error: "kind must be wallet, rates, verify or info" });
    } catch (e) {
      const source = net().chainSource === "mcp" ? "The Pharos Chain MCP" : `The ${net().short} RPC`;
      return json(res, 502, { error: `${source} did not answer: ${String(e.message).split("\n")[0].slice(0, 200)}` });
    } finally {
      await chain?.close();
    }
  });
}
