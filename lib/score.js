import { getAddress } from "viem";
import { net } from "./config.js";
import { lpPositions, realfiPositions } from "./defi.js";
import { scanApprovals } from "./guard.js";
import { walletOverview } from "./reads.js";

// A wallet score in the spirit of ProsPilot's wallet-score skill, but every point backed by something read on chain
// now (no explorer indexer needed): activity, holdings, protocol use, approval hygiene, account type.

export async function walletScore(ctx, user) {
  const u = getAddress(user);
  const [w, nonce, code, approvals, lp, realfi] = await Promise.all([
    walletOverview(ctx.chain, u),
    ctx.chain.nonce(u),
    ctx.chain.code(u),
    scanApprovals(ctx, { user: u }).catch(() => null),
    net().faroswapV3 ? lpPositions(ctx.chain, ctx.rpc, u).catch(() => null) : null,
    net().protocols.length ? realfiPositions(ctx.chain, u).catch(() => null) : null,
  ]);
  const parts = [];
  const part = (name, points, max, evidence) => parts.push({ name, points: Math.round(points), max, evidence });

  part("activity", nonce >= 100 ? 25 : nonce >= 25 ? 20 : nonce >= 5 ? 14 : nonce >= 1 ? 7 : 0, 25, `${nonce} transaction(s) sent`);
  const usd = w.usd ?? null;
  const usdc = w.holdings.find((h) => h.symbol === "USDC");
  const worth = usd ?? (usdc ? Number(usdc.balance) / 1e6 : 0);
  part("holdings", worth >= 1000 ? 20 : worth >= 100 ? 15 : worth >= 10 ? 10 : worth > 0 ? 5 : 0, 20, usd != null ? `≈ ${usd.toFixed(2)} USD on chain` : `${(worth).toFixed(2)} test USDC`);
  const used = [
    w.warden.exists && "Warden policy",
    ...w.holdings.filter((h) => h.balance > 0n && !["USDC", "WPROS"].includes(h.symbol)).map((h) => h.symbol),
    lp?.count ? `${lp.count} FaroSwap position(s)` : null,
    ...(realfi?.positions ?? []).map((p) => p.protocol),
  ].filter(Boolean);
  const distinct = [...new Set(used)];
  part("protocol use", Math.min(25, distinct.length * 7), 25, distinct.length ? distinct.join(", ") : "no DeFi or RWA position found");
  if (approvals) {
    const worst = approvals.approvals.reduce((m, a) => Math.max(m, { critical: 3, high: 2, medium: 1, low: 0 }[a.risk]), 0);
    part("approval hygiene", [20, 12, 5, 0][worst], 20, approvals.approvals.length ? `${approvals.approvals.length} open approval(s), worst: ${["low", "medium", "high", "critical"][worst]}` : "no open approvals found");
  } else part("approval hygiene", 10, 20, "approvals could not be read now");
  const delegated = code?.startsWith("0xef0100");
  const contract = code && code !== "0x" && !delegated;
  part("account", contract ? 6 : delegated ? 7 : 10, 10, contract ? "a smart-contract account" : delegated ? "a wallet with an EIP-7702 delegation" : "a plain wallet (EOA)");
  const score = parts.reduce((s, p) => s + p.points, 0);
  const level = score >= 80 ? "power user" : score >= 60 ? "active" : score >= 35 ? "getting started" : "new or inactive";
  return { network: net().name, wallet: u, score, level, parts, note: "every part is read on chain now; it describes activity and hygiene, not identity" };
}
