import { decodeFunctionResult, encodeAbiParameters, formatUnits, getAddress, isAddress, keccak256, pad, parseAbi, toHex } from "viem";
import { ABI, PERMIT2, contractName, knownTokens, net, protocolByKey } from "./config.js";
import { mixSwapData } from "./intent.js";
import { prosUsd } from "./market.js";
import { pool } from "./pool.js";
import { prospilotProfile } from "./prospilot.js";

// What the agent reads before it proposes anything. Chain data comes from the Pharos Chain MCP (ChainReader);
// exact swap quotes come from a dry run of the real swap on the Pacific RPC (the Chain MCP's eth_call takes no
// state overrides, and a quote needs one: the quoting wallet may not hold the token yet).

const AAVE_POOL_ABI = parseAbi([
  "function getReserveNormalizedIncome(address asset) view returns (uint256)",
  "function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
]);
const USDC_BLACKLIST_ABI = parseAbi(["function isBlacklisted(address) view returns (bool)"]);

export const fmt = (v, decimals, max = 6) => {
  const s = formatUnits(BigInt(v), decimals);
  const [i, f = ""] = s.split(".");
  const fr = f.slice(0, max).replace(/0+$/, "");
  return fr ? `${i}.${fr}` : i;
};

// ─── Wallet ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Everything Warden cares about for one wallet: balances, positions, Permit2 approvals, Warden policy. */
export async function walletOverview(chain, user) {
  const u = getAddress(user);
  const tokens = knownTokens();
  const [pros, balances, allowances] = await Promise.all([
    chain.balance(u),
    Promise.all(tokens.map((t) => chain.read(t.address, ABI.erc20, "balanceOf", [u]))),
    Promise.all(tokens.map((t) => chain.read(t.address, ABI.erc20, "allowance", [u, PERMIT2]))),
  ]);
  const holdings = await Promise.all(
    tokens.map(async (t, i) => {
      const p = net().protocols.find((x) => x.vault === t.address);
      const valueUsdc = p && balances[i] > 0n ? await chain.read(p.vault, ABI.vaultV2, "convertToAssets", [balances[i]]) : null;
      return { symbol: t.symbol, token: t.address, decimals: t.decimals, balance: balances[i], permit2Allowance: allowances[i], ...(valueUsdc != null && { valueUsdc }) };
    }),
  );
  return { user: u, pros, holdings, warden: await wardenPolicy(chain, u) };
}

/** The user's Warden policy as stored on chain (null fields if Warden is not deployed yet). */
export async function wardenPolicy(chain, user) {
  if (/^0x0{40}$/i.test(net().warden)) return { deployed: false };
  const u = getAddress(user);
  const [expiry, protocols, paused, payeesOnly, exists] = await chain.read(net().warden, ABI.warden, "policyOf", [u]);
  const limits = await Promise.all(
    knownTokens().map(async (t) => {
      const [perAction, perDay] = await chain.read(net().warden, ABI.warden, "limitOf", [u, t.address]);
      if (perAction === 0n && perDay === 0n) return null;
      const [, today] = await chain.read(net().warden, ABI.warden, "remaining", [u, t.address]);
      return { symbol: t.symbol, token: t.address, decimals: t.decimals, perAction, perDay, remainingToday: today };
    }),
  );
  return {
    deployed: true,
    address: net().warden,
    exists,
    paused,
    payeesOnly,
    expiry: Number(expiry),
    protocols: net().protocols.filter((p) => (protocols >> p.id) & 1).map((p) => p.key),
    limits: limits.filter(Boolean),
  };
}

// ─── Yield ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** The block closest to `secondsAgo` before the latest one (two refinement steps from the average block time). */
async function blockSecondsAgo(chain, latest, secondsAgo) {
  let guess = latest.number - BigInt(Math.round(secondsAgo / net().blockTime));
  for (let i = 0; i < 2; i++) {
    const b = await chain.block(Number(guess));
    const err = Number(latest.timestamp - b.timestamp) - secondsAgo;
    if (Math.abs(err) < 600) return b;
    const rate = Number(latest.timestamp - b.timestamp) / Number(latest.number - b.number);
    guess = guess + BigInt(Math.round(err / rate));
  }
  return chain.block(Number(guess));
}

/**
 * Realised 7-day APY of each USDC venue: Morpho vaults from the change in their share price over the last 7 days
 * (what depositors actually earned), Avalon from its current supply rate. Also each venue's size.
 */
export async function vaultRates(chain) {
  const latest = await chain.block();
  const weekAgo = await blockSecondsAgo(chain, latest, 7 * 86_400);
  const days = Number(latest.timestamp - weekAgo.timestamp) / 86_400;
  const ONE = 10n ** 18n;
  const out = [];
  for (const p of net().protocols.filter((x) => x.kind === "morpho-vault-v2")) {
    const [now, then, tvl] = await Promise.all([
      chain.read(p.vault, ABI.vaultV2, "convertToAssets", [ONE]),
      chain.read(p.vault, ABI.vaultV2, "convertToAssets", [ONE], Number(weekAgo.number)),
      chain.read(p.vault, ABI.vaultV2, "totalAssets"),
    ]);
    const growth = Number(now) / Number(then);
    out.push({ key: p.key, name: p.name, apy: growth ** (365 / days) - 1, how: { kind: "share-price", from: fmt(then, 6, 6), to: fmt(now, 6, 6), days: Number(days.toFixed(1)) }, basis: `share price ${fmt(then, 6, 6)} → ${fmt(now, 6, 6)} USDC over ${days.toFixed(1)} days`, tvlUsdc: tvl });
  }
  // Avalon on the same basis: the reserve's income index (what suppliers actually earned) over the same 7 days,
  // plus the supply rate right now, which can differ (it follows borrowing).
  const av = protocolByKey("avalon");
  const [incomeNow, incomeThen, reserve, tvl] = await Promise.all([
    chain.read(av.pool, AAVE_POOL_ABI, "getReserveNormalizedIncome", [net().tokens.USDC.address]),
    chain.read(av.pool, AAVE_POOL_ABI, "getReserveNormalizedIncome", [net().tokens.USDC.address], Number(weekAgo.number)),
    chain.read(av.pool, AAVE_POOL_ABI, "getReserveData", [net().tokens.USDC.address]),
    chain.read(av.aToken, parseAbi(["function totalSupply() view returns (uint256)"]), "totalSupply"),
  ]);
  const rateNow = Number(reserve.currentLiquidityRate) / 1e27; // APR, ray
  out.push({
    key: "avalon",
    name: av.name,
    apy: (Number(incomeNow) / Number(incomeThen)) ** (365 / days) - 1,
    how: { kind: "income-index", days: Number(days.toFixed(1)), rateNowPct: Number((rateNow * 100).toFixed(2)) },
    basis: `income index over ${days.toFixed(1)} days; supply rate right now ${(rateNow * 100).toFixed(2)}% APR`,
    tvlUsdc: tvl,
  });
  return { block: Number(latest.number), at: new Date(Number(latest.timestamp) * 1000).toISOString(), venues: out.sort((a, b) => b.apy - a.apy) };
}

// ─── Swap quote ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Exact FaroSwap output for `amount` of `from` right now: the real Warden swap, dry-run with a balance and Permit2
 * approval assumed for the quoting wallet. The same route the intent will take, so the quote is what Warden would get.
 */
export async function quoteSwap(rpc, { from, amount }) {
  const tIn = net().tokens[from];
  const tOut = from === "USDC" ? net().tokens.WPROS : net().tokens.USDC;
  // a throwaway quoting address holding exactly `amount` and approving DODOApprove — inside the eth_call only
  const quoter = getAddress("0x00000000000000000000000000000000000Ed2E5");
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const data = mixSwapData({ direction: from === "WPROS" ? 0 : 1, amount, expReturn: 10n ** 30n, minReturn: 1n, deadline });
  const stateOverride = [
    {
      address: tIn.address,
      stateDiff: [
        { slot: mapSlot(quoter, tIn.balanceSlot), value: word(amount) },
        { slot: nestedSlot(quoter, net().faroswap.dodoApprove, tIn.allowanceSlot), value: word(amount) },
      ],
    },
  ];
  let raw;
  try {
    raw = await rpc.call({ account: quoter, to: net().faroswap.routeProxy, data, stateOverride });
  } catch (e) {
    throw new Error(`FaroSwap quote failed: ${String(e.shortMessage ?? e.message).split("\n")[0]}`);
  }
  const amountOut = decodeFunctionResult({ abi: ABI.routeProxy, functionName: "mixSwap", data: raw.data });
  return { from, to: tOut.symbol, amountIn: BigInt(amount), amountOut, route: `FaroSwap ${net().faroswap.poolFee / 10_000}% WPROS/USDC pool via DODORouteProxy (route fee included)` };
}

const mapSlot = (key, slot) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [key, BigInt(slot)]));
const nestedSlot = (a, b, slot) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [b, mapSlot(a, slot)]));
const word = (v) => pad(toHex(BigInt(v)), { size: 32 });

// ─── Payee ──────────────────────────────────────────────────────────────────────────────────────────────────────

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * Before paying an address: is it a contract (a token contract would swallow the money), never used, blocked by
 * USDC, or a look-alike of an address this wallet recently paid (address poisoning: same first and last
 * characters, different middle)? Reads the last `windows` × 1,000 blocks of this wallet's USDC transfers.
 */
export async function checkPayee(chain, { user, payee, windows = 12 }) {
  if (!isAddress(payee, { strict: false })) return { payee, verdict: "stop", reasons: ["not a valid address (0x followed by 40 hex characters)"] };
  // mixed case that is not the EIP-55 checksum: one character was changed somewhere (a typo or a tampered copy)
  if (!isAddress(payee) && payee !== payee.toLowerCase() && payee.slice(2) !== payee.slice(2).toUpperCase())
    return { payee, verdict: "stop", reasons: ["the address's capital letters do not match its checksum — one character is probably wrong (a typo or a tampered copy). Copy it again from a source you trust."] };
  const p = getAddress(payee);
  const u = getAddress(user);
  const reasons = [];
  let verdict = "go";
  const secondOpinion = net().key === "pacific" ? prospilotProfile(p) : Promise.resolve(null); // runs in parallel
  const [code, nonce, blacklisted, latest] = await Promise.all([chain.code(p), chain.nonce(p), chain.read(net().tokens.USDC.address, USDC_BLACKLIST_ABI, "isBlacklisted", [p]), chain.block()]);
  const known = contractName(p);
  if (known) {
    verdict = "stop";
    reasons.push(`this is the ${known} contract, not a person — tokens sent to it are lost`);
  } else if (code && code !== "0x") {
    if (code.startsWith("0xef0100")) reasons.push(`a wallet with an EIP-7702 delegation to ${getAddress(`0x${code.slice(8, 48)}`)}`);
    else {
      verdict = verdict === "stop" ? "stop" : "review";
      reasons.push("this is a smart contract, not a plain wallet");
    }
  }
  if (blacklisted) {
    verdict = "stop";
    reasons.push("USDC has blacklisted this address: the transfer would revert");
  }
  if (nonce === 0 && (!code || code === "0x")) {
    verdict = verdict === "stop" ? "stop" : "review";
    reasons.push("this address has never sent a transaction");
  }
  if (p === u) {
    verdict = "stop";
    reasons.push("this is your own address");
  }
  // this wallet's recent USDC counterparties
  const to = Number(latest.number);
  const ranges = Array.from({ length: windows }, (_, i) => [to - (i + 1) * 1000 + 1, to - i * 1000]);
  const fromTopic = pad(u, { size: 32 }).toLowerCase();
  const logs = (await pool(ranges, 3, ([a, b]) => chain.logs({ address: net().tokens.USDC.address, topics: [TRANSFER_TOPIC, fromTopic], fromBlock: a, toBlock: b }).catch(() => []))).flat();
  const counterparties = [...new Set(logs.map((l) => getAddress(`0x${l.topics[2].slice(26)}`)))];
  const paidBefore = counterparties.includes(p);
  const lookalike = counterparties.find((c) => c !== p && c.slice(2, 6).toLowerCase() === p.slice(2, 6).toLowerCase() && c.slice(-4).toLowerCase() === p.slice(-4).toLowerCase());
  if (lookalike) {
    verdict = "stop";
    reasons.push(`looks like ${lookalike}, which you paid recently — same first and last characters, different middle (address poisoning)`);
  }
  if (paidBefore) reasons.push("you have paid this address before (recent blocks)");
  if (!reasons.length) reasons.push("a plain wallet that has been used; no warning signs found");
  // a second opinion from another agent: ProsPilot's wallet profile (Pacific data; wallets only — it profiles wallets)
  const isWallet = !known && (!code || code === "0x" || code.startsWith("0xef0100"));
  const prospilot = isWallet ? await secondOpinion : null;
  return { payee: p, verdict, reasons, scanned: { blocks: windows * 1000, fromBlock: ranges.at(-1)[0], toBlock: to, transfers: logs.length }, ...(prospilot && { prospilot }) };
}

// ─── Swap safety (ProsPilot's swap-safety skill, on exact quotes) ──────────────────────────────────────────────

/**
 * How fair a FaroSwap quote is: price impact (this amount's rate vs a 1-unit reference quote on the same pool) and
 * the pool's PROS price vs the market (CoinGecko). Warnings come with the numbers; nothing here blocks a swap —
 * the signed minimum does that on chain.
 */
export async function swapSafety(rpc, { from, amount, amountOut, slippageBps }) {
  const tIn = net().tokens[from];
  const one = 10n ** BigInt(tIn.decimals);
  const warnings = [];
  let impactBps = 0;
  if (BigInt(amount) > one) {
    const ref = await quoteSwap(rpc, { from, amount: one });
    // rate = out per in, compared at 1e18 precision
    const rate = (BigInt(amountOut) * 10n ** 18n) / BigInt(amount);
    const refRate = (ref.amountOut * 10n ** 18n) / one;
    impactBps = refRate > 0n ? Number(((refRate - rate) * 10_000n) / refRate) : 0;
  }
  if (impactBps >= 300) warnings.push({ severity: "high", text: `price impact ${(impactBps / 100).toFixed(2)}%: this amount moves the pool a lot — split it or swap less` });
  else if (impactBps >= 100) warnings.push({ severity: "medium", text: `price impact ${(impactBps / 100).toFixed(2)}%` });
  // the pool's price of PROS in USDC (USDC ≈ 1 USD)
  const usdcSide = from === "USDC" ? Number(amount) / 1e6 : Number(amountOut) / 1e6;
  const prosSide = from === "USDC" ? Number(amountOut) / 1e18 : Number(amount) / 1e18;
  const poolPrice = prosSide > 0 ? usdcSide / prosSide : null;
  const market = await prosUsd();
  let deviationPct = null;
  if (poolPrice && market) {
    deviationPct = ((poolPrice - market) / market) * 100;
    const worse = from === "USDC" ? deviationPct > 0 : deviationPct < 0; // buying PROS above the market, or selling below it
    const where = deviationPct > 0 ? "above" : "below";
    if (Math.abs(deviationPct) >= 5 && worse) warnings.push({ severity: "high", text: `the pool prices PROS at ${poolPrice.toFixed(4)} USD, ${Math.abs(deviationPct).toFixed(1)}% ${where} the market (${market.toFixed(4)} USD on CoinGecko) — a worse deal than elsewhere` });
    else if (Math.abs(deviationPct) >= 2 && worse) warnings.push({ severity: "medium", text: `the pool price is ${Math.abs(deviationPct).toFixed(1)}% ${where} the market` });
  }
  if (slippageBps != null && slippageBps > 100) warnings.push({ severity: "medium", text: `slippage ${slippageBps / 100}% is generous for a 0.01% pool — 0.5% is usually enough` });
  const score = Math.max(0, 100 - warnings.reduce((s, w) => s + (w.severity === "high" ? 35 : 15), 0));
  return {
    impactPct: Number((impactBps / 100).toFixed(2)),
    poolPriceUsd: poolPrice ? Number(poolPrice.toFixed(5)) : null,
    marketPriceUsd: market,
    deviationPct: deviationPct == null ? null : Number(deviationPct.toFixed(2)),
    warnings,
    verdict: score >= 85 ? "good" : score >= 60 ? "caution" : "risky",
  };
}
