import { getAddress } from "viem";

// The official token registry page, and the Pacific Mainnet rows read out of it (the build reads USDC from here).
export const TOKEN_REGISTRY_URL = "https://docs.pharos.xyz/getting-started/token-registry";

export function extractPacificRegistry(markdown) {
  const body = String(markdown ?? "");
  const pacific = body.split(/Pacific Mainnet/i)[1] ?? "";
  const hits = [];
  const re = /\b(WPROS|USDC|LINK|WETH)\b[\s\S]{0,160}?(0x[a-fA-F0-9]{40})/gi;
  let m;
  const seen = new Set();
  while ((m = re.exec(pacific))) {
    const symbol = m[1].toUpperCase();
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    hits.push({ symbol, address: getAddress(m[2]) });
  }
  return hits;
}
