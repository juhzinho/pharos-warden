import { encodeAbiParameters, encodeFunctionData, getAddress, keccak256, toHex } from "viem";
import { ABI, CHAIN_ID, FAROSWAP, PERMIT2, TOKENS, WARDEN, protocolByKey } from "./config.js";

// Builds Warden intents with deterministic code — the model chooses *what* to do, never the calldata.
// Mirrors Warden.sol exactly: actionsHash, witnessOf, and the Permit2 typed data the user signs.

const ZERO = "0x0000000000000000000000000000000000000000";

// ─── Witness (must match Warden.sol) ──────────────────────────────────────────────────────────────────────────────

const APPROVAL_TUPLE = { type: "tuple[]", components: [{ name: "token", type: "address" }, { name: "spender", type: "address" }, { name: "amount", type: "uint256" }] };
const CALL_TUPLE = { type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "data", type: "bytes" }] };

/** keccak256(abi.encode(approvals, calls)) — the part of the intent the wallet shows as one hash. */
export function actionsHash(intent) {
  return keccak256(encodeAbiParameters([APPROVAL_TUPLE, CALL_TUPLE], [intent.approvals, intent.calls]));
}

/** EIP-712 types for Permit2's permitWitnessTransferFrom with Warden's Intent as the witness. */
export const PERMIT_TYPES = {
  PermitBatchWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions[]" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "Intent" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  Intent: [
    { name: "user", type: "address" },
    { name: "actionsHash", type: "bytes32" },
    { name: "outs", type: "Out[]" },
    { name: "pays", type: "Pay[]" },
    { name: "deadline", type: "uint256" },
    { name: "planId", type: "bytes32" },
  ],
  Out: [
    { name: "token", type: "address" },
    { name: "minDelta", type: "uint256" },
  ],
  Pay: [
    { name: "token", type: "address" },
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
  ],
};

/** What the wallet asks the user to sign: the inputs (TokenPermissions) and the guarantees (outs, pays). */
export function typedDataFor({ intent, permit, warden = WARDEN }) {
  return {
    domain: { name: "Permit2", chainId: CHAIN_ID, verifyingContract: PERMIT2 },
    types: PERMIT_TYPES,
    primaryType: "PermitBatchWitnessTransferFrom",
    message: {
      permitted: permit.permitted,
      spender: warden,
      nonce: permit.nonce,
      deadline: permit.deadline,
      witness: { user: intent.user, actionsHash: actionsHash(intent), outs: intent.outs, pays: intent.pays, deadline: intent.deadline, planId: intent.planId },
    },
  };
}

/** Calldata for Warden.execute(intent, permit, signature). */
export function executeData({ intent, permit, signature }) {
  return encodeFunctionData({ abi: ABI.warden, functionName: "execute", args: [intent, permit, signature] });
}

/** A Permit2 unordered nonce: random, so two intents never collide (Permit2 rejects a used one). */
export function randomNonce() {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return BigInt(toHex(bytes));
}

// ─── Building blocks ──────────────────────────────────────────────────────────────────────────────────────────────

/** FaroSwap mixSwap calldata for the 0.01% WPROS/USDC pool (direction 0 = WPROS→USDC, 1 = USDC→WPROS). */
export function mixSwapData({ direction, amount, expReturn, minReturn = 1n, deadline }) {
  const tokenIn = direction === 0 ? TOKENS.WPROS.address : TOKENS.USDC.address;
  const tokenOut = direction === 0 ? TOKENS.USDC.address : TOKENS.WPROS.address;
  const moreInfo = encodeAbiParameters(
    [{ type: "uint256" }, { type: "bytes" }],
    [0n, encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }], [tokenIn, tokenOut, FAROSWAP.poolFee])],
  );
  const feeData = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [ZERO, 0n]);
  return encodeFunctionData({
    abi: ABI.routeProxy,
    functionName: "mixSwap",
    args: [tokenIn, tokenOut, BigInt(amount), BigInt(expReturn), BigInt(minReturn), [FAROSWAP.adapter], [FAROSWAP.pool], [FAROSWAP.adapter, FAROSWAP.routeProxy], BigInt(direction), [moreInfo], feeData, BigInt(deadline)],
  });
}

export const applySlippage = (amount, bps) => (BigInt(amount) * BigInt(10_000 - bps)) / 10_000n;

/** A plan id the user can find again in Warden's Executed event: hash of the human summary and a timestamp. */
export const planIdOf = (summary, at = Date.now()) => keccak256(toHex(`${summary}|${at}`));

function base({ user, ttlSeconds = 600, now = Math.floor(Date.now() / 1000), summary }) {
  return { user: getAddress(user), approvals: [], calls: [], outs: [], pays: [], deadline: BigInt(now + ttlSeconds), planId: planIdOf(summary) };
}

function permitFor(inputs, deadline, nonce = randomNonce()) {
  return { permitted: inputs.map(([token, amount]) => ({ token: getAddress(token), amount: BigInt(amount) })), nonce, deadline };
}

// ─── Intents ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Swap on FaroSwap. `quote` is the exact output simulated right now; the guarantee is quote − slippage.
 * expReturn = quote: the route proxy pays out at most expReturnAmount (anything above is its positive slippage).
 */
export function swapIntent({ user, from, amount, quote, slippageBps, summary, now }) {
  const direction = from === "WPROS" ? 0 : 1;
  const tokenIn = direction === 0 ? TOKENS.WPROS : TOKENS.USDC;
  const tokenOut = direction === 0 ? TOKENS.USDC : TOKENS.WPROS;
  const intent = base({ user, summary, now });
  const minOut = applySlippage(quote, slippageBps);
  intent.approvals = [{ token: tokenIn.address, spender: FAROSWAP.dodoApprove, amount: BigInt(amount) }];
  // the route proxy rejects minReturnAmount = 0 (RETURN_AMOUNT_ZERO); Warden's own guarantee is the real check
  intent.calls = [{ target: FAROSWAP.routeProxy, data: mixSwapData({ direction, amount, expReturn: quote, minReturn: minOut > 0n ? minOut : 1n, deadline: intent.deadline }) }];
  intent.outs = [{ token: tokenOut.address, minDelta: minOut }];
  return { intent, permit: permitFor([[tokenIn.address, amount]], intent.deadline) };
}

/** Deposit USDC into a Morpho Vault V2 or supply it to Avalon; the shares / aTokens go straight to the user. */
export function depositIntent({ user, venue, amount, expectedOut, toleranceBps = 1, summary, now }) {
  const p = protocolByKey(venue);
  if (!p || p.kind === "dex") throw new Error(`unknown venue ${venue}`);
  const intent = base({ user, summary, now });
  if (p.kind === "morpho-vault-v2") {
    intent.approvals = [{ token: TOKENS.USDC.address, spender: p.vault, amount: BigInt(amount) }];
    intent.calls = [{ target: p.vault, data: encodeFunctionData({ abi: ABI.vaultV2, functionName: "deposit", args: [BigInt(amount), intent.user] }) }];
    intent.outs = [{ token: p.vault, minDelta: applySlippage(expectedOut, toleranceBps) }];
  } else {
    intent.approvals = [{ token: TOKENS.USDC.address, spender: p.pool, amount: BigInt(amount) }];
    intent.calls = [{ target: p.pool, data: encodeFunctionData({ abi: ABI.aavePool, functionName: "supply", args: [TOKENS.USDC.address, BigInt(amount), intent.user, 0] }) }];
    // aTokens are minted 1:1 with a possible 1-unit rounding loss
    intent.outs = [{ token: p.aToken, minDelta: BigInt(amount) > 1n ? BigInt(amount) - 1n : 0n }];
  }
  return { intent, permit: permitFor([[TOKENS.USDC.address, amount]], intent.deadline) };
}

/** Withdraw from a vault (redeem shares) or from Avalon (aTokens back to USDC); the USDC goes to the user. */
export function withdrawIntent({ user, venue, shares, expectedUsdc, toleranceBps = 1, summary, now }) {
  const p = protocolByKey(venue);
  if (!p || p.kind === "dex") throw new Error(`unknown venue ${venue}`);
  const intent = base({ user, summary, now });
  if (p.kind === "morpho-vault-v2") {
    intent.calls = [{ target: p.vault, data: encodeFunctionData({ abi: ABI.vaultV2, functionName: "redeem", args: [BigInt(shares), intent.user, WARDEN] }) }];
    intent.outs = [{ token: TOKENS.USDC.address, minDelta: applySlippage(expectedUsdc, toleranceBps) }];
    return { intent, permit: permitFor([[p.vault, shares]], intent.deadline) };
  }
  // Avalon: aTokens are 1:1 with USDC; withdraw exactly `shares` USDC worth of aTokens
  intent.calls = [{ target: p.pool, data: encodeFunctionData({ abi: ABI.aavePool, functionName: "withdraw", args: [TOKENS.USDC.address, BigInt(shares), intent.user] }) }];
  intent.outs = [{ token: TOKENS.USDC.address, minDelta: BigInt(shares) }];
  return { intent, permit: permitFor([[p.aToken, shares]], intent.deadline) };
}

/** Pay exactly `amount` of a token to `to`. Nothing else is pulled; the guarantee is the payment itself. */
export function payIntent({ user, token = "USDC", to, amount, summary, now }) {
  const t = TOKENS[token];
  if (!t) throw new Error(`unknown token ${token}`);
  const intent = base({ user, summary, now });
  intent.pays = [{ token: t.address, to: getAddress(to), amount: BigInt(amount) }];
  return { intent, permit: permitFor([[t.address, amount]], intent.deadline) };
}

// ─── Plain transactions the user may need first (no Warden involved) ─────────────────────────────────────────────

export const approvePermit2Tx = (token, amount) => ({ to: getAddress(token), data: encodeFunctionData({ abi: ABI.erc20, functionName: "approve", args: [PERMIT2, BigInt(amount)] }) });

export function configureTx({ limits, protocols, payeesOnly = false, expiry = 0n, warden = WARDEN }) {
  return {
    to: warden,
    data: encodeFunctionData({
      abi: ABI.warden,
      functionName: "configure",
      args: [limits.map((l) => getAddress(l.token)), limits.map((l) => BigInt(l.perAction)), limits.map((l) => BigInt(l.perDay)), Number(protocols), Boolean(payeesOnly), BigInt(expiry)],
    }),
  };
}

export const policyCallTx = (functionName, args = [], warden = WARDEN) => ({ to: warden, data: encodeFunctionData({ abi: ABI.warden, functionName, args }) });

export const wrapTx = (amount) => ({ to: TOKENS.WPROS.address, value: BigInt(amount), data: encodeFunctionData({ abi: ABI.wpros, functionName: "deposit" }) });

/** JSON-safe copy (bigints → strings) for sending intents to the browser and back. */
export const toJSON = (v) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));

/** Inverse of toJSON for an {intent, permit} pair coming back from the browser. */
export function fromJSON({ intent, permit }) {
  const big = (x) => BigInt(x);
  return {
    intent: {
      user: getAddress(intent.user),
      approvals: intent.approvals.map((a) => ({ token: getAddress(a.token), spender: getAddress(a.spender), amount: big(a.amount) })),
      calls: intent.calls.map((c) => ({ target: getAddress(c.target), data: c.data })),
      outs: intent.outs.map((o) => ({ token: getAddress(o.token), minDelta: big(o.minDelta) })),
      pays: intent.pays.map((p) => ({ token: getAddress(p.token), to: getAddress(p.to), amount: big(p.amount) })),
      deadline: big(intent.deadline),
      planId: intent.planId,
    },
    permit: { permitted: permit.permitted.map((t) => ({ token: getAddress(t.token), amount: big(t.amount) })), nonce: big(permit.nonce), deadline: big(permit.deadline) },
  };
}
