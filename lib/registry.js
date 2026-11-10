import { getAddress } from "viem";

// The official token registry page, and the rows of one network read out of it.
export const TOKEN_REGISTRY_URL = "https://docs.pharos.xyz/getting-started/token-registry";

/** Registry rows of `network` ("pacific" | "atlantic"): the page lists Atlantic Testnet first, then Pacific Mainnet. */
export function extractRegistry(markdown, network = "pacific") {
  const body = String(markdown ?? "");
  const [before, after = ""] = body.split(/Pacific Mainnet/i);
  const section = network === "pacific" ? after : before;
  const hits = [];
  const re = /\b(WPROS|WPHRS|USDC|USDT|LINK|WETH|WBTC)\b[\s\S]{0,160}?(0x[a-fA-F0-9]{40})/gi;
  let m;
  const seen = new Set();
  while ((m = re.exec(section))) {
    const symbol = m[1].toUpperCase();
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    hits.push({ symbol, address: getAddress(m[2]) });
  }
  return hits;
}
export const extractPacificRegistry = (markdown) => extractRegistry(markdown, "pacific");
