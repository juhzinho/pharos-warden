import { decodeEventLog, getAddress } from "viem";
import { ABI, explorerTx, net, tokenByAddress } from "./config.js";
import { fmt } from "./reads.js";

/**
 * Reads a Warden transaction back (Chain MCP on Pacific, RPC on Atlantic) and checks it: success, sent by the user, and every
 * guarantee as Warden itself recorded it (Delivered = minimum vs real, Paid, Spent). `user` is the connected wallet.
 */
export async function verifyExecution(chain, hash, user) {
  const rc = await chain.receipt(hash);
  if (!rc) return { found: false, note: "no receipt yet — the transaction may still be pending; try again in a few seconds" };
  const status = rc.status === "0x1" || rc.status === 1 || rc.status === "success" ? "success" : "reverted";
  const from = getAddress(rc.from);
  const to = rc.to ? getAddress(rc.to) : null;
  const events = [];
  for (const log of rc.logs ?? []) {
    if (getAddress(log.address) !== getAddress(net().warden)) continue;
    try {
      events.push(decodeEventLog({ abi: ABI.warden, data: log.data, topics: log.topics }));
    } catch {}
  }
  const t = (a) => tokenByAddress(a) ?? { symbol: a, decimals: 18 };
  const delivered = events
    .filter((e) => e.eventName === "Delivered")
    .map((e) => {
      const k = t(e.args.token);
      return { token: k.symbol, minimum: fmt(e.args.minDelta, k.decimals), received: fmt(e.args.delta, k.decimals), ok: e.args.delta >= e.args.minDelta };
    });
  const paid = events.filter((e) => e.eventName === "Paid").map((e) => ({ token: t(e.args.token).symbol, to: e.args.to, amount: fmt(e.args.amount, t(e.args.token).decimals) }));
  const spent = events.filter((e) => e.eventName === "Spent").map((e) => ({ token: t(e.args.token).symbol, amount: fmt(e.args.amount, t(e.args.token).decimals) }));
  const policy = events.filter((e) => /Set$/.test(e.eventName)).map((e) => e.eventName);
  const executed = events.find((e) => e.eventName === "Executed");
  return {
    found: true,
    status,
    block: Number(rc.blockNumber),
    from,
    to,
    sentByConnectedWallet: user ? from === getAddress(user) : null,
    toWarden: to === getAddress(net().warden),
    gasUsed: Number(rc.gasUsed),
    explorer: explorerTx(hash),
    ...(executed && { planId: executed.args.planId }),
    ...(spent.length && { spent }),
    ...(delivered.length && { guarantees: delivered, allGuaranteesHeld: delivered.every((d) => d.ok) }),
    ...(paid.length && { paid }),
    ...(policy.length && { policyChanges: policy }),
  };
}
