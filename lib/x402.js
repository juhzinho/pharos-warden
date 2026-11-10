import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { createPublicClient, getAddress, hashTypedData, http, isAddress, recoverTypedDataAddress } from "viem";
import { NETWORKS } from "./config.js";

// x402 on Pharos, with the USER as the payer. The agent picks paid data from a catalog; the payment is an EIP-3009
// authorization (Circle USDC on Atlantic) that the user signs in their own wallet — no key on the server.
// Two phases, both through the official @x402 client so the payment is exactly what the protocol expects:
//   prepare(): GET → 402, check the offer (host, network, token, payTo, price cap), then let @x402 build the payment
//              with a recording signer: it captures the EIP-712 typed data instead of signing it;
//   settle():  the user's signature goes into that same payment, the header is encoded and the paid request is made;
//              the settlement transaction comes back and is checked on chain.

export const X402_HOST = globalThis.process?.env?.X402_URL ?? "https://pharos-x402-paywall.vercel.app";
const NETWORK = "eip155:688689";
/** The most Warden lets the agent spend on one call: 0.01 USDC. */
export const MAX_PRICE = 10_000n;

/** The only resources the agent may buy (no arbitrary URLs: the server never fetches what a model or page invents). */
export const CATALOG = {
  atlantic_block: { path: "/api/atlantic/block", label: "Atlantic head block" },
  pacific_gas: { path: "/api/pacific/gas", label: "Pacific gas market (64 blocks)" },
  pacific_wallet: { path: "/api/pacific/wallet", label: "Pacific wallet profile", needsAddress: true },
};

const usdc = () => NETWORKS.atlantic.tokens.USDC;
const resourceUrl = (item, address) => {
  const c = CATALOG[item];
  if (!c) throw new Error(`unknown item ${item}`);
  if (c.needsAddress && !isAddress(address ?? "")) throw new Error(`${item} needs an address`);
  return `${X402_HOST}${c.path}${c.needsAddress ? `?address=${getAddress(address)}` : ""}`;
};

/** An @x402 client whose "signer" records the typed data and returns a placeholder signature. */
function recordingClient(user, rpc) {
  const seen = {};
  const account = {
    address: getAddress(user),
    type: "local",
    async signTypedData(td) {
      seen.typedData = td;
      return `0x${"00".repeat(65)}`;
    },
  };
  const chain = createPublicClient({ transport: http(rpc ?? NETWORKS.atlantic.rpc, { retryCount: 2, timeout: 20_000 }) });
  const core = new x402Client();
  core.register(NETWORK, new ExactEvmScheme(toClientEvmSigner(account, chain)));
  core.setSpendControls({ allowedAssets: [{ network: NETWORK, asset: usdc().address, maxAmountPerPayment: MAX_PRICE.toString() }] });
  return { http: new x402HTTPClient(core), seen };
}

const big = (v) => (typeof v === "bigint" ? v.toString() : v);
const plain = (v) => JSON.parse(JSON.stringify(v, (_, x) => big(x)));

/**
 * Phase 1. Returns what the user signs (EIP-712 typed data), the payment to complete, and the offer, or a refusal.
 * Checks: a 402 from our paywall, on Atlantic, in Circle USDC, at most MAX_PRICE, payTo the catalog's seller.
 */
export async function prepare({ item, address, user }) {
  const url = resourceUrl(item, address);
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  const body = await res.json().catch(() => ({}));
  if (res.status !== 402) return { refused: true, reason: `the paywall answered ${res.status}, not 402 Payment Required` };
  const c = recordingClient(user);
  const required = c.http.getPaymentRequiredResponse((n) => res.headers.get(n), body);
  const offer = required.accepts.find((a) => a.network === NETWORK && getAddress(a.asset) === usdc().address);
  if (!offer) return { refused: true, reason: "the paywall does not offer Circle USDC on Atlantic" };
  if (BigInt(offer.amount) > MAX_PRICE) return { refused: true, reason: `price ${Number(offer.amount) / 1e6} USDC is above Warden's cap of ${Number(MAX_PRICE) / 1e6} USDC per call` };
  // the catalog is read twice at most: a network hiccup is not a reason to refuse, and not a payee mismatch either
  const readCatalog = () => fetch(`${X402_HOST}/catalog`, { signal: AbortSignal.timeout(10_000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const catalog = (await readCatalog()) ?? (await readCatalog());
  if (!catalog?.payTo) return { refused: true, reason: "the paywall's published catalog could not be read right now, so the payee can't be checked — try again in a moment" };
  if (getAddress(catalog.payTo) !== getAddress(offer.payTo)) return { refused: true, reason: "the payee in the 402 does not match the paywall's published catalog" };
  // only Circle USDC: the payment @x402 builds is then the EIP-3009 one
  const payment = await c.http.createPaymentPayload({ ...required, accepts: [offer] });
  if (!c.seen.typedData) return { refused: true, reason: "the payment needs no signature — not something Warden handles" };
  return { url, item, price: offer.amount, payTo: getAddress(offer.payTo), asset: getAddress(offer.asset), typedData: plain(c.seen.typedData), payment: plain(payment), validBefore: c.seen.typedData.message?.validBefore?.toString?.() ?? null };
}

/**
 * Phase 2. Puts the user's signature into the prepared payment, re-checks everything the server can check (the
 * signature recovers to the user and signs exactly this payment; still our paywall; still under the cap), makes the
 * paid request, and checks the settlement transaction on Atlantic.
 */
export async function settle({ item, address, user, payment, typedData, signature }) {
  const url = resourceUrl(item, address);
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature ?? "")) throw new Error("the signature is not a 65-byte hex string");
  const auth = payment?.payload?.authorization;
  if (!auth) throw new Error("not an EIP-3009 payment");
  const m = typedData?.message ?? {};
  const same = ["from", "to", "value", "validAfter", "validBefore", "nonce"].every((k) => String(m[k]).toLowerCase() === String(auth[k]).toLowerCase());
  if (!same) throw new Error("the signed authorization does not match the payment");
  if (getAddress(auth.from) !== getAddress(user)) throw new Error("the payer is not the connected wallet");
  if (BigInt(auth.value) > MAX_PRICE) throw new Error("above Warden's price cap");
  if (getAddress(typedData.domain.verifyingContract) !== usdc().address || Number(typedData.domain.chainId) !== 688689) throw new Error("not Circle USDC on Atlantic");
  const signer = await recoverTypedDataAddress({ ...typedData, signature });
  if (getAddress(signer) !== getAddress(user)) throw new Error("the signature was not made by the connected wallet");
  const c = recordingClient(user);
  const paid = { ...payment, payload: { ...payment.payload, signature } };
  const headers = c.http.encodePaymentSignatureHeader(paid);
  const res = await fetch(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(60_000) });
  const body = await res.json().catch(() => ({}));
  if (res.status !== 200) return { paid: false, status: res.status, error: body?.error ?? `HTTP ${res.status}` };
  const settleInfo = c.http.getPaymentSettleResponse((n) => res.headers.get(n));
  return { paid: true, data: body, transaction: settleInfo?.transaction ?? null, explorer: settleInfo?.transaction ? `${NETWORKS.atlantic.explorer}/tx/${settleInfo.transaction}` : null, digest: hashTypedData(typedData) };
}
