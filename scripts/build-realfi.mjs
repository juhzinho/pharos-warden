// Builds lib/realfi.json from ProsPilot's RealFi registry (../pharos-agent/lib/realfi.ts), checking every token on
// Pacific Mainnet: contract code present, symbol() and decimals() read from the contract (a registry value that differs
// is corrected and recorded), and for vaults the asset() they hold. Re-run to refresh:  node scripts/build-realfi.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, getAddress, http, parseAbi } from "viem";

const src = readFileSync(new URL("../../pharos-agent/lib/realfi.ts", import.meta.url), "utf8");
const block = src.slice(src.indexOf("REALFI_PROTOCOLS"), src.indexOf("\n];", src.indexOf("REALFI_PROTOCOLS")));
const protocols = [];
for (const m of block.matchAll(/name: "([^"]+)", type: "([^"]+)", url: "([^"]+)",\s*tokens: \[([\s\S]*?)\n    \]/g)) {
  const tokens = [...m[4].matchAll(/symbol: "([^"]+)",\s*address: "(0x[0-9a-fA-F]{40})", decimals: (\d+)(, vault: true)?(?:, note: "([^"]+)")?/g)].map((t) => ({ symbol: t[1], address: getAddress(t[2]), decimals: Number(t[3]), vault: Boolean(t[4]), note: t[5] ?? null }));
  protocols.push({ name: m[1], type: m[2], url: m[3], tokens });
}
const c = createPublicClient({ transport: http("https://rpc.pharos.xyz", { retryCount: 3 }) });
const abi = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)", "function asset() view returns (address)"]);
const out = [];
let dropped = 0;
for (const p of protocols) {
  const kept = [];
  for (const t of p.tokens) {
    const [code, symbol, decimals, asset] = await Promise.all([
      c.getCode({ address: t.address }).catch(() => "0x"),
      c.readContract({ address: t.address, abi, functionName: "symbol" }).catch(() => null),
      c.readContract({ address: t.address, abi, functionName: "decimals" }).catch(() => null),
      c.readContract({ address: t.address, abi, functionName: "asset" }).catch(() => null),
    ]);
    if (!code || code === "0x" || symbol == null || decimals == null) {
      dropped++;
      console.log(`drop ${p.name} ${t.symbol} ${t.address}: no token there`);
      continue;
    }
    // the chain wins: a registry symbol or decimals that differ from the contract are corrected, and recorded
    const fixes = [symbol !== t.symbol && `symbol ${t.symbol} → ${symbol}`, Number(decimals) !== t.decimals && `decimals ${t.decimals} → ${decimals}`].filter(Boolean);
    if (fixes.length) console.log(`fix  ${p.name} ${t.address}: ${fixes.join(", ")}`);
    kept.push({ ...t, symbol, decimals: Number(decimals), ...(asset && { asset: getAddress(asset) }), ...(fixes.length && { correctedFromProsPilot: fixes.join(", ") }) });
  }
  if (kept.length) out.push({ name: p.name, type: p.type, url: p.url, tokens: kept });
}
writeFileSync(new URL("../lib/realfi.json", import.meta.url), `${JSON.stringify({ source: "ProsPilot RealFi registry (github.com/juhzinho/pharos-agent, lib/realfi.ts), each token checked on Pacific Mainnet", checkedAt: new Date().toISOString().slice(0, 10), protocols: out }, null, 1)}\n`);
console.log(`kept ${out.reduce((s, p) => s + p.tokens.length, 0)} tokens in ${out.length} protocols, dropped ${dropped}`);
