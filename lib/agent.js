import Anthropic from "@anthropic-ai/sdk";
import { createPublicClient, getAddress, http, isAddress, parseUnits } from "viem";
import { ABI, ALL_PROTOCOLS_MASK, CHAIN_ID, EXPLORER, PACIFIC_RPC, PERMIT2, TOKENS, WARDEN, protocolByKey, tokenByAddress } from "./config.js";
import { approvePermit2Tx, configureTx, depositIntent, payIntent, policyCallTx, swapIntent, toJSON, typedDataFor, withdrawIntent } from "./intent.js";
import { checkPayee, fmt, quoteSwap, vaultRates, walletOverview, wardenPolicy } from "./reads.js";
import { dryRun } from "./simulate.js";
import { skillEngineNetworks, skillEngineRules, verifyTokens } from "./sources.js";
import { verifyExecution } from "./verify.js";

// The Warden agent: Claude in a streamed tool loop. The model reads (Chain MCP, Docs MCP, SkillEngine) and decides;
// every proposal is built and dry-run by deterministic code, and the user signs its guarantees in their own wallet.

export const MODEL = "claude-opus-5-5";
const MAX_ROUNDS = 10;

const ADDRESS = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" };
const AMOUNT = { type: "string", pattern: "^[0-9]+(\\.[0-9]+)?$", description: "decimal amount in token units, e.g. \"25\" or \"0.5\"" };

export const TOOLS = [
  {
    name: "wallet_overview",
    description: "Balances (PROS, USDC, WPROS, vault shares with their USDC value, Avalon aUSDC), Permit2 approvals and the Warden policy of a wallet, read through the Pharos Chain MCP. Defaults to the connected wallet.",
    input_schema: { type: "object", properties: { address: ADDRESS }, additionalProperties: false },
  },
  {
    name: "vault_rates",
    description: "Realised 7-day APY and size of each USDC venue Warden can use (Morpho RockawayX, Morpho SharpByte, Avalon), from on-chain share prices and income indexes 7 days apart, read through the Chain MCP.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "quote_swap",
    description: "Exact FaroSwap output right now for swapping USDC↔WPROS (0.01% pool), by simulating the real swap.",
    input_schema: { type: "object", properties: { from: { type: "string", enum: ["USDC", "WPROS"] }, amount: AMOUNT }, required: ["from", "amount"], additionalProperties: false },
  },
  {
    name: "check_payee",
    description: "Before paying an address: contract or wallet, never used, USDC-blacklisted, a token/protocol contract, or a look-alike of an address the wallet paid recently (address poisoning). Reads through the Chain MCP.",
    input_schema: { type: "object", properties: { payee: ADDRESS }, required: ["payee"], additionalProperties: false },
  },
  {
    name: "verify_tokens",
    description: "Confirms USDC and WPROS addresses with three sources: the official token registry (Docs MCP), SkillEngine's tokens.json, and the chain (symbol/decimals via Chain MCP). Use it before the first proposal of a conversation.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "docs_ask",
    description: "Ask the Pharos Developer Docs MCP a question about Pharos (network, tokens, protocols, canonical contracts, x402…). Returns the answer and its sources.",
    input_schema: { type: "object", properties: { question: { type: "string", minLength: 3, maxLength: 300 } }, required: ["question"], additionalProperties: false },
  },
  {
    name: "skill_engine",
    description: "Read the Pharos SkillEngine (official agent skill): its rules for write operations and key safety, or its mainnet network config.",
    input_schema: { type: "object", properties: { topic: { type: "string", enum: ["rules", "network"] } }, required: ["topic"], additionalProperties: false },
  },
  {
    name: "propose_swap",
    description: "Prepare a guarded FaroSwap swap for the connected wallet. Quotes, builds the Warden intent (minimum output = quote − slippage) and dry-runs the exact transaction. The user signs it in their wallet.",
    input_schema: { type: "object", properties: { from: { type: "string", enum: ["USDC", "WPROS"] }, amount: AMOUNT, slippage_bps: { type: "integer", minimum: 5, maximum: 300 } }, required: ["from", "amount", "slippage_bps"], additionalProperties: false },
  },
  {
    name: "propose_deposit",
    description: "Prepare a guarded USDC deposit into a vault (shares / aUSDC go straight to the user's wallet), dry-run included.",
    input_schema: { type: "object", properties: { venue: { type: "string", enum: ["rockawayx", "sharpbyte", "avalon"] }, amount: AMOUNT }, required: ["venue", "amount"], additionalProperties: false },
  },
  {
    name: "propose_withdraw",
    description: "Prepare a guarded withdrawal of USDC from a vault the user holds (amount in USDC, or \"all\"), dry-run included.",
    input_schema: { type: "object", properties: { venue: { type: "string", enum: ["rockawayx", "sharpbyte", "avalon"] }, amount: { type: "string", pattern: "^(all|[0-9]+(\\.[0-9]+)?)$" } }, required: ["venue", "amount"], additionalProperties: false },
  },
  {
    name: "propose_payment",
    description: "Prepare a guarded USDC payment: exactly this amount to this payee and nothing else. Run check_payee first.",
    input_schema: { type: "object", properties: { payee: ADDRESS, amount: AMOUNT }, required: ["payee", "amount"], additionalProperties: false },
  },
  {
    name: "propose_policy",
    description: "Prepare the user's Warden policy (one transaction the user signs): USDC/WPROS limits per action and per day, the protocols allowed, payees-only mode and an expiry. Required once before any guarded action.",
    input_schema: {
      type: "object",
      properties: {
        usdc_per_action: AMOUNT,
        usdc_per_day: AMOUNT,
        wpros_per_action: AMOUNT,
        wpros_per_day: AMOUNT,
        protocols: { type: "array", items: { type: "string", enum: ["faroswap", "rockawayx", "sharpbyte", "avalon"] }, minItems: 1, uniqueItems: true },
        payees_only: { type: "boolean" },
        expiry_days: { type: "integer", minimum: 0, maximum: 365, description: "0 = no expiry" },
      },
      required: ["usdc_per_action", "usdc_per_day", "protocols", "payees_only", "expiry_days"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_policy_change",
    description: "Prepare one policy change the user signs: pause / unpause everything, approve or remove a payee, or allow a vault's shares to be withdrawn (sets a limit for that share token).",
    input_schema: {
      type: "object",
      properties: { action: { type: "string", enum: ["pause", "unpause", "approve_payee", "remove_payee", "allow_withdraw"] }, payee: ADDRESS, venue: { type: "string", enum: ["rockawayx", "sharpbyte", "avalon"] } },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "verify_execution",
    description: "After the user sends a Warden transaction: read its receipt through the Chain MCP and check every guarantee (Delivered/Paid/Spent events) against what was signed.",
    input_schema: { type: "object", properties: { tx_hash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" } }, required: ["tx_hash"], additionalProperties: false },
  },
];

export const SYSTEM = `You are Warden, an AI agent for Pharos Pacific Mainnet (chain 1672) inside the Pharos Warden dApp.

You help one user — the connected wallet — swap on FaroSwap, earn on USDC vaults (Morpho RockawayX, Morpho SharpByte, Avalon) and pay people in USDC, in plain words. You never hold keys and you never send transactions. You prepare intents; the user signs their guarantees in their own wallet; the Warden contract (${WARDEN}) enforces them on chain and reverts if any guarantee fails.

How you work:
- Read before you decide. Use wallet_overview, vault_rates, quote_swap and check_payee (Pharos Chain MCP). Use docs_ask (Pharos Developer Docs MCP) when a Pharos fact matters. Call verify_tokens once per conversation before your first proposal. Never state a balance, rate, price or address you did not get from a tool in this conversation.
- Decide like a careful advisor: say what you would do and why, with the numbers. If something is risky or pointless (a payee that looks like address poisoning, a vault that pays less than where the money is, an amount above the user's balance), say so plainly and don't propose it.
- Propose only through the propose_* tools. They build the transaction and dry-run it; you never write calldata or addresses yourself.
- A first-time user needs a Warden policy before any guarded action. If wallet_overview shows none, explain it in one or two sentences and, in the same turn, call propose_policy with modest limits that fit the request AND the propose_* tool for what they asked: its dry run assumes that policy and its card tells the user to sign the policy first. The page also shows the one-time Permit2 approval step when needed.
- Every proposal is on mainnet with real funds: say so before the user signs (SkillEngine's rule for mainnet writes).
- After the user says they sent a transaction, call verify_execution with its hash and report what the chain says.
- Keep answers short: a few sentences or a short list. Use the user's language (Portuguese if they write in Portuguese). Amounts with their token symbol. No markdown tables.
- If a tool fails, say what failed and what the user can do; do not guess the missing data.`;

// ─── Tool execution ─────────────────────────────────────────────────────────────────────────────────────────────

const dec = (token) => (token === "WPROS" ? 18 : 6);
const units = (amount, token) => parseUnits(String(amount), dec(token));
const rpcClient = () => createPublicClient({ chain: { id: CHAIN_ID, name: "Pharos Pacific", nativeCurrency: { name: "PROS", symbol: "PROS", decimals: 18 }, rpcUrls: { default: { http: [PACIFIC_RPC] } } }, transport: http(PACIFIC_RPC, { retryCount: 3, timeout: 20_000 }) });

function needUser(ctx) {
  if (!ctx.user) throw new UserError("no wallet is connected — ask the user to connect their wallet first");
  if (/^0x0{40}$/i.test(WARDEN)) throw new UserError("Warden is not deployed yet on this deployment");
  return ctx.user;
}

class UserError extends Error {}

// What the user reads on the cards, in the page's language. (What the model reads stays in English.)
const CARD = {
  en: {
    policyFirst: "Set your Warden policy first (the agent proposes one)",
    paused: "your policy is paused",
    notEnabled: (n) => `${n} is not enabled in your policy`,
    noLimit: (s) => `no limit for ${s}`,
    overAction: (s, l) => `${s} amount is above your per-action limit (${l})`,
    overToday: (s, l) => `${s} amount is above what is left of your daily limit today (${l})`,
    approve: (a, s) => `Allow Permit2 to move ${a} ${s} (one transaction, exact amount)`,
    swap: (a, f, m, t) => `Swap ${a} ${f} → at least ${m} ${t} on FaroSwap`,
    deposit: (a, v) => `Deposit ${a} USDC into ${v}`,
    withdraw: (x, v, u) => `Withdraw ${x} from ${v} (≈ ${u} USDC)`,
    everything: "everything",
    pay: (a, to) => `Pay exactly ${a} USDC to ${to}`,
    policyTitle: "Set your Warden policy",
    usdcLine: (a, d) => `USDC: up to ${a} per action, ${d} per day`,
    wprosLine: (a, d) => `WPROS: up to ${a} per action, ${d} per day`,
    protocols: (l) => `Protocols: ${l}`,
    payeesOnly: "Payments only to payees you approve",
    payeesAny: "Payments to any address (checked by the agent first)",
    expires: (d) => `Expires ${d}`,
    noExpiry: "No expiry",
    pause: "Pause Warden for your wallet (nothing can run until you unpause)",
    unpause: "Unpause Warden for your wallet",
    approvePayee: (a) => `Approve payee ${a}`,
    removePayee: (a) => `Remove payee ${a}`,
    allowWithdraw: (x, s, v) => `Allow withdrawing up to your current ${x} ${s} from ${v} through Warden`,
  },
  pt: {
    policyFirst: "Defina antes sua política no Warden (o agente propõe uma)",
    paused: "sua política está pausada",
    notEnabled: (n) => `${n} não está habilitado na sua política`,
    noLimit: (s) => `sem limite para ${s}`,
    overAction: (s, l) => `o valor em ${s} passa do seu limite por ação (${l})`,
    overToday: (s, l) => `o valor em ${s} passa do que resta do seu limite diário hoje (${l})`,
    approve: (a, s) => `Permitir que o Permit2 mova ${a} ${s} (uma transação, valor exato)`,
    swap: (a, f, m, t) => `Trocar ${a} ${f} → no mínimo ${m} ${t} na FaroSwap`,
    deposit: (a, v) => `Depositar ${a} USDC em ${v}`,
    withdraw: (x, v, u) => `Sacar ${x} de ${v} (≈ ${u} USDC)`,
    everything: "tudo",
    pay: (a, to) => `Pagar exatamente ${a} USDC para ${to}`,
    policyTitle: "Definir sua política no Warden",
    usdcLine: (a, d) => `USDC: até ${a} por ação, ${d} por dia`,
    wprosLine: (a, d) => `WPROS: até ${a} por ação, ${d} por dia`,
    protocols: (l) => `Protocolos: ${l}`,
    payeesOnly: "Pagamentos só para destinatários que você aprovar",
    payeesAny: "Pagamentos para qualquer endereço (conferido antes pelo agente)",
    expires: (d) => `Vale até ${d}`,
    noExpiry: "Sem validade",
    pause: "Pausar o Warden para a sua carteira (nada roda até você retomar)",
    unpause: "Retomar o Warden para a sua carteira",
    approvePayee: (a) => `Aprovar o destinatário ${a}`,
    removePayee: (a) => `Remover o destinatário ${a}`,
    allowWithdraw: (x, s, v) => `Permitir sacar até os seus ${x} ${s} atuais de ${v} pelo Warden`,
  },
};
const say = (ctx) => CARD[ctx.lang === "pt" ? "pt" : "en"];

/** What the dry run needs to assume for a user who has not done the one-time steps yet, and those steps as txs. */
async function prerequisites(ctx, { permit, protocolKey, perActionHint }) {
  const user = ctx.user;
  const policy = await wardenPolicy(ctx.chain, user);
  const steps = [];
  const assume = { allowance: true };
  const p = protocolKey ? protocolByKey(protocolKey) : null;
  if (!policy.exists) {
    steps.push({ kind: "policy-missing", label: say(ctx).policyFirst });
    assume.policy = { protocols: ALL_PROTOCOLS_MASK, limits: permit.permitted.map((t) => ({ token: t.token, perAction: t.amount, perDay: t.amount })) };
  } else {
    const reasons = [];
    if (policy.paused) reasons.push(say(ctx).paused);
    if (p && !policy.protocols.includes(p.key)) reasons.push(say(ctx).notEnabled(p.name));
    for (const t of permit.permitted) {
      const l = policy.limits.find((x) => x.token === getAddress(t.token));
      const sym = tokenByAddress(t.token)?.symbol;
      if (!l) reasons.push(say(ctx).noLimit(sym));
      else if (t.amount > l.perAction) reasons.push(say(ctx).overAction(sym, fmt(l.perAction, l.decimals)));
      else if (t.amount > l.remainingToday) reasons.push(say(ctx).overToday(sym, fmt(l.remainingToday, l.decimals)));
    }
    if (reasons.length) steps.push({ kind: "policy-insufficient", label: reasons.join("; ") });
  }
  for (const t of permit.permitted) {
    const tok = tokenByAddress(t.token);
    const [allowance, balance] = await Promise.all([
      ctx.chain.read(t.token, ABI.erc20, "allowance", [user, PERMIT2]),
      ctx.chain.read(t.token, ABI.erc20, "balanceOf", [user]),
    ]);
    if (balance < t.amount) throw new UserError(`the wallet holds ${fmt(balance, tok.decimals)} ${tok.symbol}, less than the ${fmt(t.amount, tok.decimals)} ${tok.symbol} needed`);
    if (allowance < t.amount) steps.push({ kind: "approve", label: say(ctx).approve(fmt(t.amount, tok.decimals), tok.symbol), tx: toJSON(approvePermit2Tx(t.token, t.amount)), token: tok.symbol });
  }
  return { steps, assume, policy };
}

function describeSim(sim) {
  return {
    dryRun: sim.ok ? "passed" : `would fail: ${sim.error.text}`,
    youGet: sim.deltas.filter((d) => d.delta > 0n).map((d) => `${fmt(d.delta, d.decimals)} ${d.symbol}`),
    youSpend: sim.deltas.filter((d) => d.delta < 0n).map((d) => `${fmt(-d.delta, d.decimals)} ${d.symbol}`),
    guarantees: sim.checks.map((c) => `at least ${fmt(c.minDelta, c.decimals)} ${c.symbol} (dry run: ${fmt(c.delta, c.decimals)})`),
    gas: Number(sim.gas),
    assumed: sim.assumed.map((a) => a.text),
  };
}

async function proposeIntent(ctx, { kind, plan, protocolKey, summary, extra = {} }) {
  const pre = await prerequisites(ctx, { permit: plan.permit, protocolKey });
  const sim = await dryRun(ctx.rpc, { ...plan, assume: pre.assume });
  const card = {
    kind: "intent",
    action: kind,
    summary,
    network: "Pharos Pacific Mainnet (real funds)",
    warden: WARDEN,
    plan: toJSON(plan),
    typedData: toJSON(typedDataFor(plan)),
    steps: pre.steps,
    simulation: toJSON({ ok: sim.ok, error: sim.error, deltas: sim.deltas, checks: sim.checks, gas: sim.gas, assumed: sim.assumed }),
    ...extra,
  };
  ctx.emit({ type: "card", card });
  const described = describeSim(sim);
  // exact payments are guarantees too: Warden pays exactly these or reverts
  for (const p of plan.intent.pays) {
    const t = tokenByAddress(p.token);
    described.guarantees.push(`pays exactly ${fmt(p.amount, t.decimals)} ${t.symbol} to ${p.to}`);
  }
  return { proposed: sim.ok, summary, needsFirst: pre.steps.map((s) => s.label), ...described, deadline: new Date(Number(plan.intent.deadline) * 1000).toISOString(), shownToUser: "a card with Sign / Send buttons is on the page" };
}

const handlers = {
  async wallet_overview(ctx, { address }) {
    const who = address ? getAddress(address) : ctx.user;
    if (!who) throw new UserError("no wallet connected and no address given");
    const w = await walletOverview(ctx.chain, who);
    return {
      wallet: w.user,
      PROS: fmt(w.pros, 18),
      holdings: w.holdings.filter((h) => h.balance > 0n).map((h) => ({ token: h.symbol, balance: fmt(h.balance, h.decimals), ...(h.valueUsdc != null && { valueUsdc: fmt(h.valueUsdc, 6) }), permit2Approved: h.permit2Allowance > 0n ? fmt(h.permit2Allowance, h.decimals) : "no" })),
      warden: w.warden.deployed
        ? w.warden.exists
          ? { policy: "set", paused: w.warden.paused, payeesOnly: w.warden.payeesOnly, protocols: w.warden.protocols, expiry: w.warden.expiry ? new Date(w.warden.expiry * 1000).toISOString() : "none", limits: w.warden.limits.map((l) => ({ token: l.symbol, perAction: fmt(l.perAction, l.decimals), perDay: fmt(l.perDay, l.decimals), leftToday: fmt(l.remainingToday, l.decimals) })) }
          : { policy: "none yet" }
        : { deployed: false },
    };
  },

  async vault_rates(ctx) {
    const r = await vaultRates(ctx.chain);
    return { block: r.block, at: r.at, venues: r.venues.map((v) => ({ venue: v.key, name: v.name, apy7d: `${(v.apy * 100).toFixed(2)}%`, basis: v.basis, sizeUsdc: fmt(v.tvlUsdc, 6, 0) })) };
  },

  async quote_swap(ctx, { from, amount }) {
    const q = await quoteSwap(ctx.rpc, { from, amount: units(amount, from) });
    return { youPay: `${amount} ${from}`, youGet: `${fmt(q.amountOut, q.to === "WPROS" ? 18 : 6)} ${q.to}`, route: q.route };
  },

  async check_payee(ctx, { payee }) {
    const r = await checkPayee(ctx.chain, { user: ctx.user ?? payee, payee });
    return { payee: r.payee, verdict: r.verdict, reasons: r.reasons, scanned: r.scanned ? `${r.scanned.transfers} of your USDC transfers in the last ${r.scanned.blocks} blocks` : undefined };
  },

  async verify_tokens(ctx) {
    const r = await verifyTokens(ctx.docs, ctx.chain);
    return { allAgree: r.allAgree, tokens: r.tokens.map((t) => ({ symbol: t.symbol, address: t.address, registry: t.registry === t.address, skillEngine: t.skillEngine === t.address, chain: `${t.chain.symbol}, ${t.chain.decimals} decimals` })), sources: r.sources };
  },

  async docs_ask(ctx, { question }) {
    const a = await ctx.docs.ask(question);
    return { found: a.found, answer: a.answer.slice(0, 2500), sources: a.sources.map((s) => s.url) };
  },

  async skill_engine(ctx, { topic }) {
    return topic === "rules" ? skillEngineRules() : skillEngineNetworks();
  },

  async propose_swap(ctx, { from, amount, slippage_bps }) {
    const user = needUser(ctx);
    const amt = units(amount, from);
    const q = await quoteSwap(ctx.rpc, { from, amount: amt });
    const to = from === "USDC" ? "WPROS" : "USDC";
    const summary = say(ctx).swap(amount, from, fmt((q.amountOut * BigInt(10_000 - slippage_bps)) / 10_000n, dec(to)), to);
    const plan = swapIntent({ user, from, amount: amt, quote: q.amountOut, slippageBps: slippage_bps, summary });
    return proposeIntent(ctx, { kind: "swap", plan, protocolKey: "faroswap", summary, extra: { quote: `${fmt(q.amountOut, dec(to))} ${to}`, slippageBps: slippage_bps } });
  },

  async propose_deposit(ctx, { venue, amount }) {
    const user = needUser(ctx);
    const p = protocolByKey(venue);
    const amt = units(amount, "USDC");
    const expected = p.kind === "morpho-vault-v2" ? await ctx.chain.read(p.vault, ABI.vaultV2, "previewDeposit", [amt]) : amt;
    const summary = say(ctx).deposit(amount, p.name);
    const plan = depositIntent({ user, venue, amount: amt, expectedOut: expected, summary });
    return proposeIntent(ctx, { kind: "deposit", plan, protocolKey: venue, summary });
  },

  async propose_withdraw(ctx, { venue, amount }) {
    const user = needUser(ctx);
    const p = protocolByKey(venue);
    let shares;
    let expected;
    if (p.kind === "morpho-vault-v2") {
      const held = await ctx.chain.read(p.vault, ABI.vaultV2, "balanceOf", [user]);
      if (held === 0n) throw new UserError(`the wallet holds no ${p.symbol}`);
      if (amount === "all") shares = held;
      else {
        const want = units(amount, "USDC");
        const total = await ctx.chain.read(p.vault, ABI.vaultV2, "convertToAssets", [held]);
        if (want > total) throw new UserError(`only ${fmt(total, 6)} USDC is in ${p.name}`);
        shares = (held * want) / total;
      }
      expected = await ctx.chain.read(p.vault, ABI.vaultV2, "previewRedeem", [shares]);
    } else {
      const held = await ctx.chain.read(p.aToken, ABI.erc20, "balanceOf", [user]);
      if (held === 0n) throw new UserError("the wallet holds no Avalon aUSDC");
      shares = amount === "all" ? held : units(amount, "USDC");
      if (shares > held) throw new UserError(`only ${fmt(held, 6)} USDC is in Avalon`);
      expected = shares;
    }
    const summary = say(ctx).withdraw(amount === "all" ? say(ctx).everything : `${amount} USDC`, p.name, fmt(expected, 6));
    const plan = withdrawIntent({ user, venue, shares, expectedUsdc: expected, summary });
    return proposeIntent(ctx, { kind: "withdraw", plan, protocolKey: venue, summary });
  },

  async propose_payment(ctx, { payee, amount }) {
    const user = needUser(ctx);
    const check = await checkPayee(ctx.chain, { user, payee });
    if (check.verdict === "stop") return { proposed: false, refused: true, reasons: check.reasons };
    const amt = units(amount, "USDC");
    const summary = say(ctx).pay(amount, getAddress(payee));
    const plan = payIntent({ user, to: payee, amount: amt, summary });
    return proposeIntent(ctx, { kind: "payment", plan, summary, extra: { payeeCheck: check } });
  },

  async propose_policy(ctx, a) {
    const user = needUser(ctx);
    const limits = [{ token: TOKENS.USDC.address, perAction: units(a.usdc_per_action, "USDC"), perDay: units(a.usdc_per_day, "USDC") }];
    if (a.wpros_per_action && a.wpros_per_day) limits.push({ token: TOKENS.WPROS.address, perAction: units(a.wpros_per_action, "WPROS"), perDay: units(a.wpros_per_day, "WPROS") });
    for (const l of limits) if (l.perAction > l.perDay) throw new UserError("a per-action limit cannot be above the daily limit");
    const mask = a.protocols.reduce((m, k) => m | (1 << protocolByKey(k).id), 0);
    const expiry = a.expiry_days ? BigInt(Math.floor(Date.now() / 1000) + a.expiry_days * 86_400) : 0n;
    const tx = configureTx({ limits, protocols: mask, payeesOnly: a.payees_only, expiry });
    const c = say(ctx);
    const day = expiry ? new Date(Number(expiry) * 1000).toISOString().slice(0, 10) : null;
    const lines = [
      c.usdcLine(a.usdc_per_action, a.usdc_per_day),
      ...(limits[1] ? [c.wprosLine(a.wpros_per_action, a.wpros_per_day)] : []),
      c.protocols(a.protocols.map((k) => protocolByKey(k).name).join(", ")),
      a.payees_only ? c.payeesOnly : c.payeesAny,
      day ? c.expires(day) : c.noExpiry,
    ];
    ctx.emit({ type: "card", card: { kind: "tx", action: "policy", summary: c.policyTitle, lines, network: "Pharos Pacific Mainnet", tx: toJSON(tx) } });
    return { proposed: true, policy: { ...a, expires: day ?? "never" }, note: "one transaction to Warden, signed by the user; no funds move" };
  },

  async propose_policy_change(ctx, { action, payee, venue }) {
    needUser(ctx);
    let tx;
    let summary;
    if (action === "pause" || action === "unpause") {
      tx = policyCallTx(action);
      summary = action === "pause" ? say(ctx).pause : say(ctx).unpause;
    } else if (action === "approve_payee" || action === "remove_payee") {
      if (!payee || !isAddress(payee)) throw new UserError("a payee address is needed");
      tx = policyCallTx("setPayee", [getAddress(payee), action === "approve_payee"]);
      summary = action === "approve_payee" ? say(ctx).approvePayee(getAddress(payee)) : say(ctx).removePayee(getAddress(payee));
    } else {
      const p = venue && protocolByKey(venue);
      if (!p) throw new UserError("a venue is needed");
      const token = p.vault ?? p.aToken;
      const held = await ctx.chain.read(token, ABI.erc20, "balanceOf", [ctx.user]);
      if (held === 0n) throw new UserError(`the wallet holds no ${p.symbol}`);
      tx = policyCallTx("setLimit", [token, held, held]);
      summary = say(ctx).allowWithdraw(fmt(held, p.decimals), p.symbol, p.name);
    }
    ctx.emit({ type: "card", card: { kind: "tx", action, summary, lines: [summary], network: "Pharos Pacific Mainnet", tx: toJSON(tx) } });
    return { proposed: true, summary };
  },

  async verify_execution(ctx, { tx_hash }) {
    return verifyExecution(ctx.chain, tx_hash, ctx.user);
  },
};

/** Checks a tool input against its JSON schema (required, types, enums, patterns, bounds, no extra fields). */
export function validateInput(schema, input) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "the input must be an object";
  const props = schema.properties ?? {};
  for (const k of schema.required ?? []) if (input[k] === undefined) return `missing "${k}"`;
  for (const [k, v] of Object.entries(input)) {
    const s = props[k];
    if (!s) return `unexpected field "${k}"`;
    if (s.type === "string") {
      if (typeof v !== "string") return `"${k}" must be a string`;
      if (s.enum && !s.enum.includes(v)) return `"${k}" must be one of ${s.enum.join(", ")}`;
      if (s.pattern && !new RegExp(s.pattern).test(v)) return `"${k}" has the wrong format (${s.description ?? s.pattern})`;
      if (s.minLength && v.length < s.minLength) return `"${k}" is too short`;
      if (s.maxLength && v.length > s.maxLength) return `"${k}" is too long`;
    } else if (s.type === "integer") {
      if (!Number.isInteger(v)) return `"${k}" must be an integer`;
      if (s.minimum != null && v < s.minimum) return `"${k}" must be at least ${s.minimum}`;
      if (s.maximum != null && v > s.maximum) return `"${k}" must be at most ${s.maximum}`;
    } else if (s.type === "boolean") {
      if (typeof v !== "boolean") return `"${k}" must be true or false`;
    } else if (s.type === "array") {
      if (!Array.isArray(v)) return `"${k}" must be a list`;
      if (s.minItems && v.length < s.minItems) return `"${k}" needs at least ${s.minItems} item(s)`;
      if (s.uniqueItems && new Set(v).size !== v.length) return `"${k}" has duplicates`;
      if (s.items?.enum && v.some((x) => !s.items.enum.includes(x))) return `"${k}" items must be among ${s.items.enum.join(", ")}`;
    }
  }
  return null;
}

export async function runTool(ctx, name, input) {
  const h = handlers[name];
  if (!h) return { error: `unknown tool ${name}` };
  const invalid = validateInput(TOOLS.find((t) => t.name === name).input_schema, input ?? {});
  if (invalid) return { error: `invalid input for ${name}: ${invalid}` };
  try {
    return await h(ctx, input ?? {});
  } catch (e) {
    return { error: e instanceof UserError ? e.message : `${name} failed: ${String(e.shortMessage ?? e.message).split("\n")[0].slice(0, 300)}` };
  }
}

// ─── The loop ───────────────────────────────────────────────────────────────────────────────────────────────────

const json = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

/**
 * One user turn: stream Claude, run the tools it asks for, loop until it answers. `emit` sends events to the page.
 * Returns the updated message history (Anthropic format) for the next turn.
 */
export async function agentTurn({ client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY?.trim() }), messages, user, lang = "en", chain, docs, emit, signal }) {
  const ctx = { user: user ? getAddress(user) : null, lang, chain, docs, rpc: rpcClient(), emit };
  const history = [...messages];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const stream = client.beta.messages.stream(
      {
        model: MODEL,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "medium" },
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        tools: TOOLS,
        // operator context after the history: keeps the cached prefix (tools + system) stable across users
        messages: [...history, { role: "system", content: `Connected wallet: ${ctx.user ?? "none (the user has not connected a wallet yet)"}. Today: ${new Date().toISOString().slice(0, 10)}.` }],
      },
      { signal },
    );
    stream.on("text", (delta) => emit({ type: "text", delta }));
    stream.on("thinking", (delta) => emit({ type: "thinking", delta }));
    const message = await stream.finalMessage();
    history.push({ role: "assistant", content: message.content });
    emit({ type: "usage", usage: message.usage });

    if (message.stop_reason === "refusal") {
      emit({ type: "text", delta: "\n\n(The model declined this request.)" });
      return history;
    }
    const uses = message.content.filter((b) => b.type === "tool_use");
    // a tool input cut off at max_tokens must never run
    if (message.stop_reason === "max_tokens") throw new Error("the answer was cut off");
    if (message.stop_reason !== "tool_use" || uses.length === 0) return history;

    const results = await Promise.all(
      uses.map(async (u) => {
        emit({ type: "tool_start", id: u.id, name: u.name, input: u.input });
        const own = { chain: chain.child(), docs: docs.child() };
        const t = Date.now();
        const result = await runTool({ ...ctx, ...own }, u.name, u.input);
        const calls = [...own.chain.log, ...own.docs.log];
        emit({ type: "tool_end", id: u.id, name: u.name, ok: !result?.error, ms: Date.now() - t, result: result?.error ? { error: result.error } : undefined, calls: calls.map((c) => ({ server: c.server, tool: c.tool, ms: c.ms, ok: c.ok })) });
        return { type: "tool_result", tool_use_id: u.id, content: json(result), ...(result?.error && { is_error: true }) };
      }),
    );
    history.push({ role: "user", content: results });
  }
  emit({ type: "text", delta: "\n\n(Stopped after too many steps — please ask again more specifically.)" });
  return history;
}

export const explorer = { tx: (h) => `${EXPLORER}/tx/${h}` };
