// End to end on an Anvil fork of Pacific Mainnet: deploy Warden with the mainnet script, then for each kind of
// intent: dry-run it (before any approval or signature), approve Permit2, sign the EIP-712 witness exactly as a
// wallet would, send Warden.execute, and check the real result equals the dry run. Proves the JS intent builder,
// the witness and the typed data match the contract byte for byte.
//   node test/fork-e2e.js
import assert from "node:assert/strict";
import { createPublicClient, createWalletClient, encodeAbiParameters, http, keccak256, pad, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { deployWardenOnFork, startFork } from "../lib/fork.js";

const ANVIL_KEY_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // Anvil's public test key #0
const fork = await startFork({ port: 8547 });
let failed = 0;
const ok = (name) => console.log(`OK    ${name}`);
const step = async (name, fn) => {
  try {
    await fn();
    ok(name);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${String(e.message).split("\n").slice(0, 3).join("\n      ")}`);
  }
};

try {
  const raw = createPublicClient({ transport: http(fork.url) });
  const rpc = (method, params) => raw.request({ method, params });
  await rpc("anvil_setBalance", [privateKeyToAccount(ANVIL_KEY_0).address, "0x56BC75E2D63100000"]);
  const wardenAddr = deployWardenOnFork(fork.url, ANVIL_KEY_0);
  process.env.WARDEN_ADDRESS = wardenAddr; // before importing config.js
  const { ABI, ALL_PROTOCOLS_MASK, CHAIN_ID, PERMIT2, TOKENS, protocolByKey } = await import("../lib/config.js");
  const I = await import("../lib/intent.js");
  const { dryRun } = await import("../lib/simulate.js");
  console.log(`fork ${fork.url} · Warden ${wardenAddr}`);

  const chain = { id: CHAIN_ID, name: "Pacific fork", nativeCurrency: { name: "PROS", symbol: "PROS", decimals: 18 }, rpcUrls: { default: { http: [fork.url] } } };
  const pub = createPublicClient({ chain, transport: http(fork.url) });
  const userKey = generatePrivateKey();
  const user = privateKeyToAccount(userKey);
  const wallet = createWalletClient({ account: user, chain, transport: http(fork.url) });
  const slot = (a, s) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [a, s]));
  await rpc("anvil_setBalance", [user.address, "0x8AC7230489E80000"]);
  await rpc("anvil_setStorageAt", [TOKENS.USDC.address, slot(user.address, 9n), pad(toHex(1_000_000_000n))]); // 1,000 USDC
  const bal = (token) => pub.readContract({ address: token, abi: ABI.erc20, functionName: "balanceOf", args: [user.address] });
  const send = async (tx) => {
    const hash = await wallet.sendTransaction(tx);
    const rc = await pub.waitForTransactionReceipt({ hash });
    assert.equal(rc.status, "success", `tx ${hash} reverted`);
    return rc;
  };
  const policy = { protocols: ALL_PROTOCOLS_MASK, limits: [{ token: TOKENS.USDC.address, perAction: 100_000_000n, perDay: 250_000_000n }] };

  /** Dry-run as a brand-new wallet (no approval, no policy), then do it for real and compare. */
  async function roundTrip({ intent, permit }, assume, measure) {
    const sim = await dryRun(pub, { intent, permit, assume });
    assert.ok(sim.ok, `dry run failed: ${sim.error?.text}`);
    for (const t of permit.permitted) {
      const allowance = await pub.readContract({ address: t.token, abi: ABI.erc20, functionName: "allowance", args: [user.address, PERMIT2] });
      if (allowance < t.amount) await send(I.approvePermit2Tx(t.token, t.amount));
    }
    const signature = await user.signTypedData(I.typedDataFor({ intent, permit }));
    const before = await bal(measure);
    const rc = await send({ to: wardenAddr, data: I.executeData({ intent, permit, signature }) });
    const real = (await bal(measure)) - before;
    const simDelta = sim.deltas.find((d) => d.token === measure).delta;
    // a vault's share price moves a hair between blocks (interest accrues), so allow 1 part in 10^6
    const diff = real > simDelta ? real - simDelta : simDelta - real;
    assert.ok(diff * 1_000_000n <= simDelta, `real ${real} vs dry run ${simDelta}`);
    return { sim, rc, real };
  }

  await step("dry run works for a wallet with no approval and no policy (both assumed, and said so)", async () => {
    const quoteRun = await dryRun(pub, { ...I.swapIntent({ user: user.address, from: "USDC", amount: 20_000_000n, quote: 10n ** 30n, slippageBps: 10_000, summary: "quote" }), assume: { allowance: true, policy } });
    assert.ok(quoteRun.ok, quoteRun.error?.text);
    assert.deepEqual(quoteRun.assumed.map((a) => a.kind).sort(), ["allowance", "policy"]);
  });

  await step("policy set by the user's own transaction", async () => {
    await send(I.configureTx({ limits: policy.limits, protocols: policy.protocols }));
    const p = await pub.readContract({ address: wardenAddr, abi: ABI.warden, functionName: "policyOf", args: [user.address] });
    assert.equal(p[1], ALL_PROTOCOLS_MASK);
  });

  let wprosOut = 0n;
  await step("swap 20 USDC → WPROS: quote by dry run, guarantee = quote − 0.5%, real result = dry run", async () => {
    const q = await dryRun(pub, { ...I.swapIntent({ user: user.address, from: "USDC", amount: 20_000_000n, quote: 10n ** 30n, slippageBps: 10_000, summary: "quote" }), assume: { allowance: true } });
    const quote = q.deltas.find((d) => d.token === TOKENS.WPROS.address).delta;
    assert.ok(quote > 0n);
    const plan = I.swapIntent({ user: user.address, from: "USDC", amount: 20_000_000n, quote, slippageBps: 50, summary: "swap 20 USDC to WPROS" });
    const { real } = await roundTrip(plan, { allowance: true }, TOKENS.WPROS.address);
    assert.ok(real >= plan.intent.outs[0].minDelta);
    wprosOut = real;
  });

  await step("deposit 30 USDC into Morpho RockawayX: shares go to the user, real = dry run", async () => {
    const v = protocolByKey("rockawayx");
    const shares = await pub.readContract({ address: v.vault, abi: ABI.vaultV2, functionName: "previewDeposit", args: [30_000_000n] });
    await roundTrip(I.depositIntent({ user: user.address, venue: "rockawayx", amount: 30_000_000n, expectedOut: shares, summary: "deposit" }), { allowance: true }, v.vault);
  });

  await step("supply 10 USDC to Avalon: aTokens go to the user", async () => {
    const v = protocolByKey("avalon");
    const before = await bal(v.aToken);
    const plan = I.depositIntent({ user: user.address, venue: "avalon", amount: 10_000_000n, expectedOut: 10_000_000n, summary: "supply" });
    const sim = await dryRun(pub, { ...plan, assume: { allowance: true } });
    assert.ok(sim.ok, sim.error?.text);
    await send(I.approvePermit2Tx(TOKENS.USDC.address, 10_000_000n));
    const signature = await user.signTypedData(I.typedDataFor(plan));
    await send({ to: wardenAddr, data: I.executeData({ ...plan, signature }) });
    assert.ok((await bal(v.aToken)) - before >= 9_999_999n);
  });

  await step("pay 5 USDC to a payee: exactly 5 arrive", async () => {
    const payee = privateKeyToAccount(generatePrivateKey()).address;
    const plan = I.payIntent({ user: user.address, to: payee, amount: 5_000_000n, summary: "pay" });
    const sim = await dryRun(pub, { ...plan, assume: { allowance: true } });
    assert.ok(sim.ok, sim.error?.text);
    await send(I.approvePermit2Tx(TOKENS.USDC.address, 5_000_000n));
    const signature = await user.signTypedData(I.typedDataFor(plan));
    await send({ to: wardenAddr, data: I.executeData({ ...plan, signature }) });
    assert.equal(await pub.readContract({ address: TOKENS.USDC.address, abi: ABI.erc20, functionName: "balanceOf", args: [payee] }), 5_000_000n);
  });

  await step("redeem the Morpho shares back to USDC (shares limit added first)", async () => {
    const v = protocolByKey("rockawayx");
    const shares = await bal(v.vault);
    const usdc = await pub.readContract({ address: v.vault, abi: ABI.vaultV2, functionName: "previewRedeem", args: [shares] });
    await send(I.policyCallTx("setLimit", [v.vault, shares, shares], wardenAddr));
    await roundTrip(I.withdrawIntent({ user: user.address, venue: "rockawayx", shares, expectedUsdc: usdc, summary: "withdraw" }), { allowance: true }, TOKENS.USDC.address);
  });

  await step("a dry run over the per-action limit explains the refusal before anything is signed", async () => {
    const sim = await dryRun(pub, { ...I.payIntent({ user: user.address, to: "0x000000000000000000000000000000000000dEaD", amount: 150_000_000n, summary: "too much" }), assume: { allowance: true } });
    assert.equal(sim.ok, false);
    assert.equal(sim.error.name, "OverActionLimit", JSON.stringify(sim.error));
    assert.equal(sim.error.text, "150 USDC is above your per-action limit of 100 USDC");
  });

  await step("a dry run asking for more than the market explains which guarantee fails", async () => {
    const plan = I.swapIntent({ user: user.address, from: "USDC", amount: 10_000_000n, quote: wprosOut * 10n, slippageBps: 0, summary: "greedy" });
    const sim = await dryRun(pub, { ...plan, assume: { allowance: true } });
    assert.equal(sim.ok, false);
    assert.match(sim.error.text, /WPROS delivered would be below the signed minimum|protocol call #0 failed/);
  });
} finally {
  fork.stop();
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
