import { decodeErrorResult, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, formatUnits, getAddress, keccak256, pad, parseAbi, toHex } from "viem";
import { ABI, PERMIT2, PROTOCOLS, WARDEN, tokenByAddress } from "./config.js";
import { executeData } from "./intent.js";
import { SIM_PERMIT2_CODE, SIM_RUNNER_CODE } from "./sim-bytecode.js";

// Dry-runs the exact Warden.execute transaction against live Pacific state, before the user signs anything.
// One eth_call with state overrides:
//   - Permit2's code → SimPermit2 (moves the permitted tokens like Permit2, without a signature to check);
//   - the user's address code → SimRunner (calls Warden.execute as the user, reads the user's balances around it);
//   - optionally, the user's allowance to Permit2, their token balance, and their Warden policy, when the plan needs
//     a step the user has not taken yet — every such assumption is returned and shown to the user.
// Nothing is ever written: an eth_call cannot change the chain.

const RUNNER_ABI = parseAbi([
  "struct Result { bool ok; bytes revertData; uint256[] before; uint256[] afterwards; uint256 gasUsed; }",
  "function run(address warden, bytes executeCalldata, address[] tokens) returns (Result r)",
]);

const mapSlot = (key, slot) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [key, BigInt(slot)]));
const nestedSlot = (a, b, slot) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [b, mapSlot(a, slot)]));
const word = (v) => pad(toHex(BigInt(v)), { size: 32 });

// Warden storage (forge inspect Warden storageLayout): policyOf = slot 3, limitOf = slot 4.
const POLICY_SLOT = 3n;
const LIMIT_SLOT = 4n;
/** Policy packs into one word: expiry (uint64) | protocols (uint32) << 64 | paused << 96 | payeesOnly << 104 | exists << 112. */
export const packPolicy = ({ expiry = 0n, protocols, paused = false, payeesOnly = false }) =>
  BigInt(expiry) | (BigInt(protocols) << 64n) | (BigInt(paused ? 1 : 0) << 96n) | (BigInt(payeesOnly ? 1 : 0) << 104n) | (1n << 112n);
/** Limit packs into one word: perAction (uint128) | perDay << 128. */
export const packLimit = ({ perAction, perDay }) => BigInt(perAction) | (BigInt(perDay) << 128n);

/** Decodes a Warden (or Permit2) revert, including the reason a failing protocol call gave. */
export function explainRevert(data) {
  if (!data || data === "0x") return { name: "Reverted", text: "the transaction reverted without a reason" };
  try {
    const e = decodeErrorResult({ abi: ABI.warden, data });
    const args = e.args ?? [];
    const sym = (a) => tokenByAddress(a)?.symbol ?? a;
    const amt = (a, v) => `${formatUnits(BigInt(v), tokenByAddress(a)?.decimals ?? 18)} ${sym(a)}`;
    // built lazily: only the matching message is formatted
    const texts = {
      NotIntentUser: () => "only the wallet that signed can run this intent",
      IntentExpired: () => "the intent's deadline has passed — ask again for a fresh one",
      NoPolicy: () => "this wallet has no Warden policy yet — set your limits first",
      PolicyPaused: () => "your Warden policy is paused",
      PolicyExpired: () => "your Warden policy has expired — renew it",
      NoLimit: () => `there is no Warden limit for ${sym(args[0])} — add one first`,
      OverActionLimit: () => `${amt(args[0], args[1])} is above your per-action limit of ${amt(args[0], args[2])}`,
      OverDailyLimit: () => `${amt(args[0], args[2])} more today would pass your daily limit of ${amt(args[0], args[3])} (already spent ${amt(args[0], args[1])})`,
      TargetNotAllowed: () => "a call targets a contract outside Warden's allowlist",
      SpenderNotAllowed: () => "an approval targets a spender outside Warden's allowlist",
      ProtocolNotEnabled: () => `${PROTOCOLS[Number(args[0])]?.name ?? `protocol #${args[0]}`} is not enabled in your policy`,
      PayeeNotAllowed: () => `${args[0]} is not in your approved payees`,
      BadPayee: () => "the payee is not a valid recipient",
      NoGuarantee: () => "the intent guarantees nothing",
      SelectorNotAllowed: () => "a call tries to move tokens directly",
      OutBelowMinimum: () => `${sym(args[0])} delivered (${amt(args[0], args[2])}) would be below the signed minimum (${amt(args[0], args[1])})`,
      CallFailed: () => `protocol call #${args[0]} failed${args[1] && args[1] !== "0x" ? `: ${innerReason(args[1])}` : ""}`,
      TokenCallFailed: () => `a ${sym(args[0])} transfer failed`,
      InvalidNonce: () => "this signature was already used",
      InvalidSigner: () => "the signature does not match this intent",
      SignatureExpired: () => "the signature's deadline has passed",
    };
    return { name: e.errorName, args: args.map(String), text: texts[e.errorName]?.() ?? e.errorName };
  } catch {
    return { name: "Reverted", text: innerReason(data) };
  }
}

function innerReason(data) {
  // Error(string)
  if (data?.startsWith("0x08c379a0")) {
    try {
      return decodeErrorResult({ abi: parseAbi(["error Error(string)"]), data }).args[0];
    } catch {}
  }
  return `custom error ${String(data).slice(0, 10)}`;
}

/**
 * @param client viem public client on Pacific (an RPC that accepts eth_call state overrides).
 * @param assume { allowance?: true, balance?: {token: amount}, policy?: {protocols, limits:[{token, perAction, perDay}], payeesOnly, expiry} }
 */
export async function dryRun(client, { intent, permit, warden = WARDEN, assume = {} }) {
  const user = getAddress(intent.user);
  const tokens = [...new Set([...permit.permitted.map((p) => p.token), ...intent.outs.map((o) => o.token), ...intent.pays.map((p) => p.token)].map((a) => getAddress(a)))];
  const assumed = [];
  const overrides = new Map(); // address → { code?, stateDiff[] }
  const diff = (address, slot, value) => {
    const o = overrides.get(address) ?? { address, stateDiff: [] };
    o.stateDiff.push({ slot, value: word(value) });
    overrides.set(address, o);
  };
  overrides.set(PERMIT2, { address: PERMIT2, code: SIM_PERMIT2_CODE });
  overrides.set(user, { address: user, code: SIM_RUNNER_CODE });

  for (const p of permit.permitted) {
    const t = tokenByAddress(p.token);
    if (assume.allowance) {
      if (t?.allowanceSlot == null) throw new Error(`cannot assume a Permit2 allowance for ${p.token}`);
      const current = await client.readContract({ address: p.token, abi: ABI.erc20, functionName: "allowance", args: [user, PERMIT2] });
      if (current < p.amount) {
        diff(getAddress(p.token), nestedSlot(user, PERMIT2, t.allowanceSlot), p.amount);
        assumed.push({ kind: "allowance", symbol: t.symbol, text: `your ${t.symbol} approval to Permit2 (the one-time approval step)` });
      }
    }
    const bal = assume.balance?.[p.token];
    if (bal != null) {
      if (t?.balanceSlot == null) throw new Error(`cannot assume a ${t?.symbol ?? p.token} balance`);
      diff(getAddress(p.token), mapSlot(user, t.balanceSlot), bal);
      assumed.push({ kind: "balance", symbol: t.symbol, text: `a ${t.symbol} balance of the amount to spend` });
    }
  }
  if (assume.policy) {
    diff(warden, mapSlot(user, POLICY_SLOT), packPolicy(assume.policy));
    for (const l of assume.policy.limits) diff(warden, nestedSlot(user, getAddress(l.token), LIMIT_SLOT), packLimit(l));
    assumed.push({ kind: "policy", text: "the Warden policy proposed for you (not set yet)" });
  }

  const execCalldata = executeData({ intent, permit, signature: "0x" });
  const data = encodeFunctionData({ abi: RUNNER_ABI, functionName: "run", args: [warden, execCalldata, tokens] });
  const raw = await client.call({ to: user, data, stateOverride: [...overrides.values()], gas: 30_000_000n });
  const r = decodeFunctionResult({ abi: RUNNER_ABI, functionName: "run", data: raw.data });
  const deltas = tokens.map((token, i) => {
    const t = tokenByAddress(token);
    return { token, symbol: t?.symbol ?? token, decimals: t?.decimals ?? 18, before: r.before[i], after: r.afterwards[i], delta: r.afterwards[i] - r.before[i] };
  });
  const checks = intent.outs.map((o) => {
    const d = deltas.find((x) => x.token === getAddress(o.token));
    return { token: o.token, symbol: d.symbol, decimals: d.decimals, minDelta: o.minDelta, delta: d.delta, ok: d.delta >= o.minDelta };
  });
  return {
    ok: r.ok,
    error: r.ok ? null : explainRevert(r.revertData),
    deltas,
    checks,
    gas: r.gasUsed,
    assumed,
  };
}
