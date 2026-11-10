import { isAddress } from "viem";
import { ChainReader } from "../lib/chain.js";
import { MODEL } from "../lib/agent.js";
import { OPENAI_MODEL } from "../lib/agent-openai.js";
import { provider } from "./agent.js";
import { CHAIN_ID, FAROSWAP, PERMIT2, PROTOCOLS, WARDEN, explorerAddress, knownTokens } from "../lib/config.js";
import { vaultRates, walletOverview } from "../lib/reads.js";
import { verifyExecution } from "../lib/verify.js";

// GET /api/data?kind=wallet&address=0x…   balances, positions, Permit2 approvals, Warden policy
// GET /api/data?kind=rates                realised 7-day yields of the USDC venues
// GET /api/data?kind=verify&hash=0x…&user=0x…   a Warden transaction checked against its guarantees
// GET /api/data?kind=info                 deployment facts
// All chain reads go through the Pharos Chain MCP. No model call, no key.

const json = (res, status, body, cache = "no-store") =>
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": cache }).end(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

export default async function handler(req, res) {
  const q = new URL(req.url, "http://x").searchParams;
  const kind = q.get("kind");
  if (kind === "info") {
    return json(res, 200, { chainId: CHAIN_ID, warden: WARDEN, wardenExplorer: explorerAddress(WARDEN), deployed: !/^0x0{40}$/i.test(WARDEN), model: provider() === "openai" ? OPENAI_MODEL : provider() === "anthropic" ? MODEL : null, agentOnline: Boolean(provider()), permit2: PERMIT2, tokens: knownTokens().map((t) => ({ symbol: t.symbol, address: t.address, decimals: t.decimals })), protocols: PROTOCOLS.map((p) => ({ id: p.id, key: p.key, name: p.name, address: p.vault ?? p.pool ?? FAROSWAP.routeProxy })) }, "public, s-maxage=60");
  }
  let chain;
  try {
    chain = await ChainReader.open();
    if (kind === "wallet") {
      const address = q.get("address") ?? "";
      if (!isAddress(address)) return json(res, 400, { error: "address must be a 0x… address" });
      return json(res, 200, await walletOverview(chain, address));
    }
    if (kind === "rates") return json(res, 200, await vaultRates(chain), "public, s-maxage=120, stale-while-revalidate=300");
    if (kind === "verify") {
      const hash = q.get("hash") ?? "";
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return json(res, 400, { error: "hash must be a transaction hash" });
      const user = q.get("user");
      return json(res, 200, await verifyExecution(chain, hash, user && isAddress(user) ? user : null));
    }
    return json(res, 400, { error: "kind must be wallet, rates, verify or info" });
  } catch (e) {
    return json(res, 502, { error: `The Pharos Chain MCP did not answer: ${String(e.message).split("\n")[0].slice(0, 200)}` });
  } finally {
    await chain?.close();
  }
}
