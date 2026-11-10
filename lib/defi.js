import { decodeFunctionResult, encodeFunctionData, getAddress, maxUint128, parseAbi } from "viem";
import { ABI, PERMIT2, net } from "./config.js";
import { pool } from "./pool.js";
import { fmt } from "./reads.js";
import REALFI from "./realfi.json" with { type: "json" };

// ProsPilot's DeFi skills on Pacific Mainnet — FaroSwap V3 liquidity, Faroo liquid staking, RealFi positions,
// approvals — rebuilt on exact reads and simulations:
// - a new LP position's amounts come from simulating the mint itself (inside the Warden dry run), not from float math;
// - a position's uncollected fees come from simulating collect() as its owner (exact, including fees not yet poked);
// - removing liquidity sets its minimums from a simulation of the same multicall, minus the user's slippage;
// - every RealFi token was checked on chain when the registry was built (scripts/build-realfi.mjs).

export const NPM_ABI = parseAbi([
  "struct MintParams { address token0; address token1; uint24 fee; int24 tickLower; int24 tickUpper; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; address recipient; uint256 deadline; }",
  "struct DecreaseLiquidityParams { uint256 tokenId; uint128 liquidity; uint256 amount0Min; uint256 amount1Min; uint256 deadline; }",
  "struct CollectParams { uint256 tokenId; address recipient; uint128 amount0Max; uint128 amount1Max; }",
  "function mint(MintParams params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function decreaseLiquidity(DecreaseLiquidityParams params) payable returns (uint256 amount0, uint256 amount1)",
  "function collect(CollectParams params) payable returns (uint256 amount0, uint256 amount1)",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
]);
const FACTORY_ABI = parseAbi(["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)"]);
const POOL_ABI = parseAbi(["function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint32, bool)", "function liquidity() view returns (uint128)"]);
const VAULT_ABI = parseAbi(["function convertToAssets(uint256 shares) view returns (uint256)", "function previewDeposit(uint256 assets) view returns (uint256)", "function previewRedeem(uint256 shares) view returns (uint256)", "function balanceOf(address) view returns (uint256)", "function totalAssets() view returns (uint256)", "function redeem(uint256 shares, address receiver, address owner) returns (uint256)", "function deposit(uint256 assets, address receiver) returns (uint256)"]);

export const FEE_TIERS = { 100: { label: "0.01%", spacing: 1 }, 500: { label: "0.05%", spacing: 10 }, 3000: { label: "0.30%", spacing: 60 }, 10000: { label: "1.00%", spacing: 200 } };
const MAX_TICK = 887272;
const Q96 = 2 ** 96;

// ─── FaroSwap V3 ────────────────────────────────────────────────────────────────────────────────────────────────

/** A WPROS/USDC pool's live state; WPROS is token0 on every tier (checked on chain). Price is USDC per WPROS. */
export async function poolState(chain, fee) {
  const f = net().faroswapV3;
  const address = f.pools?.[fee] ?? (await chain.read(f.factory, FACTORY_ABI, "getPool", [net().tokens.WPROS.address, net().tokens.USDC.address, fee]));
  if (/^0x0{40}$/i.test(address)) return null;
  const [[sqrtPriceX96, tick], liquidity] = await Promise.all([chain.read(address, POOL_ABI, "slot0"), chain.read(address, POOL_ABI, "liquidity")]);
  const s = Number(sqrtPriceX96) / Q96;
  return { fee, label: FEE_TIERS[fee].label, address: getAddress(address), sqrtPriceX96, tick: Number(tick), liquidity, price: s * s * 1e12 };
}

/** Every tier at once, for the agent to compare (deeper liquidity = less slippage for the position's swaps). */
export async function poolStates(chain) {
  return (await pool(Object.keys(FEE_TIERS), 4, (f) => poolState(chain, Number(f)))).filter(Boolean);
}

const priceToTick = (price) => Math.log(price / 1e12) / Math.log(1.0001);
const tickToPrice = (tick) => 1.0001 ** tick * 1e12;
const snap = (tick, spacing, up) => (up ? Math.ceil(tick / spacing) : Math.floor(tick / spacing)) * spacing;

/** Ticks for a range: "full", ±percent around the price, or explicit USDC-per-WPROS prices. */
export function rangeTicks({ mode, percent, minPrice, maxPrice, price, fee }) {
  const spacing = FEE_TIERS[fee].spacing;
  const top = Math.floor(MAX_TICK / spacing) * spacing;
  let lo;
  let hi;
  if (mode === "full") [lo, hi] = [-top, top];
  else if (mode === "percent") [lo, hi] = [snap(priceToTick(price * (1 - percent / 100)), spacing, false), snap(priceToTick(price * (1 + percent / 100)), spacing, true)];
  else [lo, hi] = [snap(priceToTick(minPrice), spacing, false), snap(priceToTick(maxPrice), spacing, true)];
  lo = Math.max(-top, lo);
  hi = Math.min(top, hi);
  if (hi <= lo) hi = lo + spacing;
  return { tickLower: lo, tickUpper: hi, minPrice: tickToPrice(lo), maxPrice: tickToPrice(hi) };
}

/**
 * The other side of a position from one side (raw units), at the current price — an estimate with a small margin;
 * the exact amounts used come from the dry run of the mint, and whatever the pool does not take goes back to the user.
 */
export function pairAmounts({ sqrtPriceX96, tickLower, tickUpper, wpros, usdc }) {
  const s = Number(sqrtPriceX96) / Q96;
  const sa = Math.sqrt(1.0001 ** tickLower);
  const sb = Math.sqrt(1.0001 ** tickUpper);
  if (s <= sa) return { wpros: wpros ?? 0n, usdc: 0n, side: "wpros-only" };
  if (s >= sb) return { wpros: 0n, usdc: usdc ?? 0n, side: "usdc-only" };
  const margin = 1.003; // the estimate rounds against the user's wallet balance, never against the position
  if (wpros != null) {
    const L = (Number(wpros) * s * sb) / (sb - s);
    return { wpros: BigInt(wpros), usdc: BigInt(Math.ceil(L * (s - sa) * margin)), side: "both" };
  }
  const L = Number(usdc) / (s - sa);
  return { wpros: BigInt(Math.ceil(((L * (sb - s)) / (s * sb)) * margin)), usdc: BigInt(usdc), side: "both" };
}

/** The Warden intent that mints a position NFT straight to the user (out: one more NFT in the user's wallet). */
export function liquidityIntent({ base, user, fee, tickLower, tickUpper, wpros, usdc, min0 = 0n, min1 = 0n, permitFor }) {
  const npm = net().faroswapV3.npm;
  const intent = base;
  intent.approvals = [];
  const permits = [];
  if (wpros > 0n) {
    intent.approvals.push({ token: net().tokens.WPROS.address, spender: npm, amount: wpros });
    permits.push([net().tokens.WPROS.address, wpros]);
  }
  if (usdc > 0n) {
    intent.approvals.push({ token: net().tokens.USDC.address, spender: npm, amount: usdc });
    permits.push([net().tokens.USDC.address, usdc]);
  }
  const params = { token0: net().tokens.WPROS.address, token1: net().tokens.USDC.address, fee, tickLower, tickUpper, amount0Desired: wpros, amount1Desired: usdc, amount0Min: min0, amount1Min: min1, recipient: getAddress(user), deadline: intent.deadline };
  intent.calls = [{ target: npm, data: encodeFunctionData({ abi: NPM_ABI, functionName: "mint", args: [params] }) }];
  intent.outs = [{ token: npm, minDelta: 1n }];
  return { intent, permit: permitFor(permits, intent.deadline) };
}

/** The user's FaroSwap V3 positions: range, in-range or not, amounts now, and exact uncollected fees (simulated). */
export async function lpPositions(chain, rpc, user) {
  const npm = net().faroswapV3.npm;
  const u = getAddress(user);
  const n = Number(await chain.read(npm, NPM_ABI, "balanceOf", [u]));
  const ids = await pool(Array.from({ length: Math.min(n, 20) }, (_, i) => i), 4, (i) => chain.read(npm, NPM_ABI, "tokenOfOwnerByIndex", [u, BigInt(i)]));
  const states = {};
  const out = await pool(ids, 4, async (id) => {
    const p = await chain.read(npm, NPM_ABI, "positions", [id]);
    const [, , token0, token1, fee, tickLower, tickUpper, liquidity, , , owed0, owed1] = p;
    const isPair = getAddress(token0) === net().tokens.WPROS.address && getAddress(token1) === net().tokens.USDC.address;
    const pos = { tokenId: id.toString(), fee: Number(fee), feeLabel: FEE_TIERS[Number(fee)]?.label ?? `${Number(fee) / 10_000}%`, token0, token1, pair: isPair ? "WPROS/USDC" : "other pair", tickLower: Number(tickLower), tickUpper: Number(tickUpper), liquidity: liquidity.toString(), minPrice: tickToPrice(Number(tickLower)), maxPrice: tickToPrice(Number(tickUpper)) };
    if (!isPair) return pos;
    states[fee] ??= await poolState(chain, Number(fee));
    const st = states[fee];
    pos.inRange = st.tick >= pos.tickLower && st.tick < pos.tickUpper;
    pos.priceNow = st.price;
    // exact amounts and fees: simulate, as the owner, removing all liquidity and collecting (nothing is sent)
    if (liquidity > 0n) {
      const [amounts, fees] = await Promise.all([
        simulate(rpc, u, npm, encodeFunctionData({ abi: NPM_ABI, functionName: "decreaseLiquidity", args: [{ tokenId: id, liquidity, amount0Min: 0n, amount1Min: 0n, deadline: BigInt(Math.floor(Date.now() / 1000) + 600) }] }), "decreaseLiquidity"),
        simulate(rpc, u, npm, encodeFunctionData({ abi: NPM_ABI, functionName: "collect", args: [{ tokenId: id, recipient: u, amount0Max: maxUint128, amount1Max: maxUint128 }] }), "collect"),
      ]);
      pos.wpros = amounts ? fmt(amounts[0], 18) : null;
      pos.usdc = amounts ? fmt(amounts[1], 6) : null;
      pos.feesWpros = fees ? fmt(fees[0], 18) : fmt(owed0, 18);
      pos.feesUsdc = fees ? fmt(fees[1], 6) : fmt(owed1, 6);
    } else {
      pos.wpros = "0";
      pos.usdc = "0";
      pos.feesWpros = fmt(owed0, 18);
      pos.feesUsdc = fmt(owed1, 6);
      pos.closed = true;
    }
    return pos;
  });
  return { network: net().name, positions: out, count: n, shown: out.length, npm };
}

async function simulate(rpc, from, to, data, fn) {
  try {
    const r = await rpc.call({ account: from, to, data });
    return decodeFunctionResult({ abi: NPM_ABI, functionName: fn, data: r.data });
  } catch {
    return null;
  }
}

/**
 * Removing liquidity (a share of a position, in percent) and collecting everything it owes — one multicall the
 * position's owner signs. The minimums are the simulated amounts minus the slippage.
 */
export async function removeLiquidityTx(chain, rpc, { user, tokenId, percent, slippageBps }) {
  const npm = net().faroswapV3.npm;
  const u = getAddress(user);
  const id = BigInt(tokenId);
  const p = await chain.read(npm, NPM_ABI, "positions", [id]);
  const liquidity = (p[7] * BigInt(percent)) / 100n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
  const collect = encodeFunctionData({ abi: NPM_ABI, functionName: "collect", args: [{ tokenId: id, recipient: u, amount0Max: maxUint128, amount1Max: maxUint128 }] });
  if (liquidity === 0n) return { tx: { to: npm, data: collect }, expected: await simulate(rpc, u, npm, collect, "collect"), liquidity: 0n, onlyFees: true };
  const decrease0 = encodeFunctionData({ abi: NPM_ABI, functionName: "decreaseLiquidity", args: [{ tokenId: id, liquidity, amount0Min: 0n, amount1Min: 0n, deadline }] });
  const sim = await simulate(rpc, u, npm, decrease0, "decreaseLiquidity");
  if (!sim) throw new Error("the removal does not simulate: is this wallet the position's owner?");
  const keep = BigInt(10_000 - slippageBps);
  const decrease = encodeFunctionData({ abi: NPM_ABI, functionName: "decreaseLiquidity", args: [{ tokenId: id, liquidity, amount0Min: (sim[0] * keep) / 10_000n, amount1Min: (sim[1] * keep) / 10_000n, deadline }] });
  const data = encodeFunctionData({ abi: NPM_ABI, functionName: "multicall", args: [[decrease, collect]] });
  return { tx: { to: npm, data }, expected: sim, minimum: [(sim[0] * keep) / 10_000n, (sim[1] * keep) / 10_000n], liquidity };
}

// ─── Faroo liquid staking ───────────────────────────────────────────────────────────────────────────────────────

/** stPROS: share price now and 7 days ago (realised staking yield), size, and the user's stake. */
export async function farooState(chain, user, weekAgoBlock) {
  const f = net().protocols.find((p) => p.key === "faroo");
  const ONE = 10n ** 18n;
  const [now, then, tvl] = await Promise.all([
    chain.read(f.vault, VAULT_ABI, "convertToAssets", [ONE]),
    weekAgoBlock ? chain.read(f.vault, VAULT_ABI, "convertToAssets", [ONE], weekAgoBlock).catch(() => null) : null,
    chain.read(f.vault, VAULT_ABI, "totalAssets"),
  ]);
  const out = { vault: f.vault, sharePrice: fmt(now, 18, 6), tvlWpros: fmt(tvl, 18, 0), unstakeDays: 7 };
  if (then) out.apy7d = (Number(now) / Number(then)) ** (365 / 7) - 1;
  if (user) {
    const shares = await chain.read(f.vault, VAULT_ABI, "balanceOf", [getAddress(user)]);
    out.stPROS = fmt(shares, 18);
    out.valueWpros = fmt(shares > 0n ? await chain.read(f.vault, VAULT_ABI, "convertToAssets", [shares]) : 0n, 18);
  }
  return out;
}

/** Unstaking is Faroo's own 7-day request (redeem registers it; PROS is claimed on app.faroo.xyz when it matures). */
export function unstakeTx({ user, shares }) {
  const f = net().protocols.find((p) => p.key === "faroo");
  return { to: f.vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "redeem", args: [BigInt(shares), getAddress(user), getAddress(user)] }) };
}

export { VAULT_ABI };

// ─── RealFi positions ───────────────────────────────────────────────────────────────────────────────────────────

/** Every RealFi / RWA token of the verified registry the wallet holds, with vault shares valued in their asset. */
export async function realfiPositions(chain, user) {
  const u = getAddress(user);
  const all = REALFI.protocols.flatMap((p) => p.tokens.map((t) => ({ ...t, protocol: p.name, type: p.type, url: p.url })));
  const rows = await pool(all, 6, async (t) => {
    const bal = await chain.read(t.address, ABI.erc20, "balanceOf", [u]).catch(() => 0n);
    if (bal === 0n) return null;
    const row = { protocol: t.protocol, type: t.type, url: t.url, token: t.symbol, address: t.address, balance: fmt(bal, t.decimals), ...(t.note && { note: t.note }) };
    if (t.asset) {
      const assets = await chain.read(t.address, VAULT_ABI, "convertToAssets", [bal]).catch(() => null);
      const a = REALFI.protocols.flatMap((p) => p.tokens).find((x) => x.address === t.asset) ?? Object.values(net().tokens).find((x) => x.address === t.asset);
      if (assets != null && a) row.worth = `${fmt(assets, a.decimals)} ${a.symbol}`;
    }
    return row;
  });
  return { network: net().name, positions: rows.filter(Boolean), checked: all.length, registry: `${REALFI.source}, checked ${REALFI.checkedAt}` };
}

// ─── approvals ──────────────────────────────────────────────────────────────────────────────────────────────────

/** An allowance in both places a dApp can spend from: the token itself, and Permit2. */
export async function allowanceOf(chain, { user, token, spender }) {
  const [erc20, p2] = await Promise.all([
    chain.read(token, ABI.erc20, "allowance", [getAddress(user), getAddress(spender)]),
    chain.read(PERMIT2, ABI.permit2, "allowance", [getAddress(user), getAddress(token), getAddress(spender)]).catch(() => [0n, 0, 0]),
  ]);
  return { erc20, permit2: { amount: p2[0], expiration: Number(p2[1]) } };
}
