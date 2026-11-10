import Anthropic from "@anthropic-ai/sdk";
import { createPublicClient, getAddress, http, isAddress, parseUnits } from "viem";
import { ABI, PERMIT2, allProtocolsMask, contractName, net, protocolByKey, tokenByAddress } from "./config.js";
import { checkSignature, checkTransaction, explainTx, revokeTx, scanApprovals, tokenMeta } from "./guard.js";
import { approvePermit2Tx, configureTx, depositIntent, payIntent, policyCallTx, swapIntent, toJSON, typedDataFor, withdrawIntent } from "./intent.js";
import { checkPayee, fmt, quoteSwap, swapSafety, vaultRates, walletOverview, wardenPolicy } from "./reads.js";
import { dryRun } from "./simulate.js";
import { skillEngineNetworks, skillEngineRules, verifyTokens } from "./sources.js";
import { verifyExecution } from "./verify.js";

// The Warden agent: a model in a streamed tool loop. The model reads (Chain MCP or RPC, Docs MCP, SkillEngine,
// ProsPilot) and decides; every proposal is built and dry-run by deterministic code, and the user signs its
// guarantees in their own wallet. Runs on the network of the request (lib/config.js `withNetwork`).

export const MODEL = "claude-opus-5-5";
const MAX_ROUNDS = 10;

const ADDRESS = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" };
const AMOUNT = { type: "string", pattern: "^[0-9]+(\\.[0-9]+)?$", description: "decimal amount in token units, e.g. \"25\" or \"0.5\"" };

const VENUE = { type: "string", enum: ["rockawayx", "sharpbyte", "avalon"] };
const TX_HASH = { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" };
const HEX = { type: "string", pattern: "^0x([0-9a-fA-F]{2})*$", maxLength: 40000, description: "0x-prefixed calldata" };

/** Every tool. `pacificOnly` tools need FaroSwap or the vaults, which exist on Pacific Mainnet only. */
export const TOOLS = [
  {
    name: "wallet_overview",
    description: "Balances (native coin, USDC, and on Pacific WPROS, vault shares with their USDC value, Avalon aUSDC), Permit2 approvals and the Warden policy of a wallet. Defaults to the connected wallet.",
    input_schema: { type: "object", properties: { address: ADDRESS }, additionalProperties: false },
  },
  {
    name: "vault_rates",
    pacificOnly: true,
    description: "Realised 7-day APY and size of each USDC venue Warden can use (Morpho RockawayX, Morpho SharpByte, Avalon), from on-chain share prices and income indexes 7 days apart, read through the Chain MCP.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "quote_swap",
    pacificOnly: true,
    description: "Exact FaroSwap output right now for swapping USDC↔WPROS (0.01% pool), by simulating the real swap, with a safety read: price impact and the pool's PROS price vs the market (CoinGecko).",
    input_schema: { type: "object", properties: { from: { type: "string", enum: ["USDC", "WPROS"] }, amount: AMOUNT }, required: ["from", "amount"], additionalProperties: false },
  },
  {
    name: "check_payee",
    description: "Before paying an address: contract or wallet, never used, USDC-blacklisted, a token/protocol contract, a look-alike of an address the wallet paid recently (address poisoning), a broken checksum. On Pacific it also asks ProsPilot (a second Pharos agent) for its wallet profile.",
    input_schema: { type: "object", properties: { payee: ADDRESS }, required: ["payee"], additionalProperties: false },
  },
  {
    name: "check_transaction",
    description: "Before the user signs a transaction from ANY other dApp: decodes it and runs it as the user against live state (a simulation, nothing is sent), then reports what it would really do — tokens and native coin out and in, new allowances — with risk flags (approval to a plain wallet, unlimited approval to an unknown contract, giving without receiving, a call that would fail…) and a verdict.",
    input_schema: { type: "object", properties: { to: ADDRESS, data: HEX, value_wei: { type: "string", pattern: "^[0-9]{1,40}$", description: "native value in wei, default 0" } }, required: ["to"], additionalProperties: false },
  },
  {
    name: "check_signature",
    description: "Before the user signs an EIP-712 signature request from another dApp (the JSON the wallet shows for eth_signTypedData_v4): recognises Permit, Permit2 allowances and transfers, EIP-3009 payments, Seaport listings and Warden's own intents, and flags drainer patterns (a plain wallet as spender, unlimited amounts, no deadline, another chain).",
    input_schema: { type: "object", properties: { typed_data: { type: "string", minLength: 20, maxLength: 20000 } }, required: ["typed_data"], additionalProperties: false },
  },
  {
    name: "scan_approvals",
    description: "Live token allowances of a wallet (ERC-20 and Permit2): every known token × every known spender, plus anything the wallet approved recently (Approval events). Each one with its risk. Defaults to the connected wallet.",
    input_schema: { type: "object", properties: { address: ADDRESS }, additionalProperties: false },
  },
  {
    name: "propose_revoke",
    description: "Prepare the transaction that revokes one allowance found by scan_approvals (ERC-20 approve(spender, 0), or Permit2 lockdown). The user signs it.",
    input_schema: { type: "object", properties: { token: ADDRESS, spender: ADDRESS, kind: { type: "string", enum: ["erc20", "permit2"] } }, required: ["token", "spender", "kind"], additionalProperties: false },
  },
  {
    name: "explain_tx",
    description: "Explain any transaction on the current network in plain words: the call, every decoded event (transfers, approvals, Warden guarantees), the fee, what it did to the connected wallet, and — if it failed — why (the call replayed on the block before).",
    input_schema: { type: "object", properties: { tx_hash: TX_HASH }, required: ["tx_hash"], additionalProperties: false },
  },
  {
    name: "verify_tokens",
    description: "Checks the token addresses Warden uses on this network against three sources: the official token registry (Docs MCP), SkillEngine's tokens.json, and the chain (symbol/decimals). Use it before the first proposal of a conversation.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "docs_ask",
    description: "Ask the Pharos Developer Docs MCP a question about Pharos (networks, tokens, protocols, canonical contracts, x402…). Returns the answer and its sources.",
    input_schema: { type: "object", properties: { question: { type: "string", minLength: 3, maxLength: 300 } }, required: ["question"], additionalProperties: false },
  },
  {
    name: "skill_engine",
    description: "Read the Pharos SkillEngine (official agent skill): its rules for write operations and key safety, or its config for the current network.",
    input_schema: { type: "object", properties: { topic: { type: "string", enum: ["rules", "network"] } }, required: ["topic"], additionalProperties: false },
  },
  {
    name: "propose_swap",
    pacificOnly: true,
    description: "Prepare a guarded FaroSwap swap for the connected wallet. Quotes, builds the Warden intent (minimum output = quote − slippage), checks the swap's safety and dry-runs the exact transaction. The user signs it in their wallet.",
    input_schema: { type: "object", properties: { from: { type: "string", enum: ["USDC", "WPROS"] }, amount: AMOUNT, slippage_bps: { type: "integer", minimum: 5, maximum: 300 } }, required: ["from", "amount", "slippage_bps"], additionalProperties: false },
  },
  {
    name: "propose_deposit",
    pacificOnly: true,
    description: "Prepare a guarded USDC deposit into a vault (shares / aUSDC go straight to the user's wallet), dry-run included.",
    input_schema: { type: "object", properties: { venue: VENUE, amount: AMOUNT }, required: ["venue", "amount"], additionalProperties: false },
  },
  {
    name: "propose_withdraw",
    pacificOnly: true,
    description: "Prepare a guarded withdrawal of USDC from a vault the user holds (amount in USDC, or \"all\"), dry-run included.",
    input_schema: { type: "object", properties: { venue: VENUE, amount: { type: "string", pattern: "^(all|[0-9]+(\\.[0-9]+)?)$" } }, required: ["venue", "amount"], additionalProperties: false },
  },
  {
    name: "propose_payment",
    description: "Prepare guarded USDC payments in ONE signature: exactly these amounts to exactly these payees and nothing else (1 to 10 payees; the same payee may not repeat). Every payee is checked first; a payee that fails the check stops the whole batch.",
    input_schema: {
      type: "object",
      properties: { payments: { type: "array", minItems: 1, maxItems: 10, items: { type: "object", properties: { payee: ADDRESS, amount: AMOUNT }, required: ["payee", "amount"], additionalProperties: false } } },
      required: ["payments"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_policy",
    description: "Prepare the user's Warden policy (one transaction the user signs): USDC limits per action and per day (and on Pacific WPROS limits and the protocols allowed), payees-only mode and an expiry. Required once before any guarded action.",
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
    description: "Prepare one policy change the user signs: pause / unpause everything, approve or remove a payee, or (Pacific) allow a vault's shares to be withdrawn (sets a limit for that share token).",
    input_schema: {
      type: "object",
      properties: { action: { type: "string", enum: ["pause", "unpause", "approve_payee", "remove_payee", "allow_withdraw"] }, payee: ADDRESS, venue: VENUE },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "verify_execution",
    description: "After the user sends a Warden transaction: read its receipt and check every guarantee (Delivered/Paid/Spent events) against what was signed.",
    input_schema: { type: "object", properties: { tx_hash: TX_HASH }, required: ["tx_hash"], additionalProperties: false },
  },
];

/** The tools of one network: Atlantic has no DEX or vault, so its policy has only USDC limits and no protocols. */
export function toolsFor(n = net()) {
  if (n.protocols.length) return TOOLS.map(({ pacificOnly, ...t }) => t);
  return TOOLS.filter((t) => !t.pacificOnly).map(({ pacificOnly, ...t }) => {
    if (t.name === "propose_policy") {
      const { wpros_per_action, wpros_per_day, protocols, ...properties } = t.input_schema.properties;
      return { ...t, input_schema: { ...t.input_schema, properties, required: t.input_schema.required.filter((r) => r !== "protocols") } };
    }
    if (t.name === "propose_policy_change") {
      const { venue, ...properties } = t.input_schema.properties;
      return { ...t, input_schema: { ...t.input_schema, properties: { ...properties, action: { type: "string", enum: ["pause", "unpause", "approve_payee", "remove_payee"] } } } };
    }
    return t;
  });
}

/** The system prompt of one network. */
export function systemFor(n = net()) {
  const what = n.protocols.length
    ? "swap on FaroSwap, earn on USDC vaults (Morpho RockawayX, Morpho SharpByte, Avalon) and pay people in USDC"
    : "pay people in USDC — one payee or a batch in a single signature — under on-chain limits (Atlantic has no DEX or lending protocol, so swaps and vaults live on Pacific Mainnet: tell the user to switch network in the page header for those)";
  const chainTools = n.chainSource === "mcp" ? "the Pharos Chain MCP" : `the ${n.short} RPC (the Pharos Chain MCP serves Pacific only)`;
  return `You are Warden, an AI agent for ${n.name} (chain ${n.chainId}) inside the Pharos Warden dApp. Your wallet-safety skills come from ProsPilot, another Pharos agent, made stronger with real simulation.

You help one user — the connected wallet — ${what}. You also keep them safe outside Warden: check any transaction or signature another dApp asks them to sign (check_transaction, check_signature), find and revoke risky token approvals (scan_approvals, propose_revoke) and explain any transaction (explain_tx). You never hold keys and you never send transactions. You prepare intents; the user signs their guarantees in their own wallet; the Warden contract (${n.warden}) enforces them on chain and reverts if any guarantee fails.

How you work:
- Read before you decide. Chain data comes from ${chainTools}. Use docs_ask (Pharos Developer Docs MCP) when a Pharos fact matters. Call verify_tokens once per conversation before your first proposal. Never state a balance, rate, price or address you did not get from a tool in this conversation.
- Decide like a careful advisor: say what you would do and why, with the numbers. If something is risky or pointless (a payee that looks like address poisoning, a swap with a large price impact, an amount above the user's balance), say so plainly and don't propose it.
- When the user pastes a transaction or a signature request from somewhere else, check it with check_transaction / check_signature before anything else and lead with the verdict in one sentence; never tell them to sign something the check marks do_not_sign.
- Propose only through the propose_* tools. They build the transaction and dry-run it; you never write calldata or addresses yourself.
- A first-time user needs a Warden policy before any guarded action. Use payees_only false unless the user asks for it (then also propose approve_payee for each payee). If wallet_overview shows none, explain it in one or two sentences and, in the same turn, call propose_policy with modest limits that fit the request AND the propose_* tool for what they asked: its dry run assumes that policy and its card tells the user to sign the policy first. The page also shows the one-time Permit2 approval step when needed.
${n.testnet ? `- This is a testnet: test USDC has no value (free from ${n.faucet}, network "Pharos Testnet"), gas is test ${n.native}. Say it is a testnet when you propose.` : "- Every proposal is on mainnet with real funds: say so before the user signs (SkillEngine's rule for mainnet writes)."}
- After the user says they sent a transaction, call verify_execution with its hash (explain_tx for any other transaction) and report what the chain says.
- Keep answers short: a few sentences or a short list. Use the user's language (Portuguese if they write in Portuguese). Amounts with their token symbol. No markdown tables.
- If a tool fails, say what failed and what the user can do; do not guess the missing data.`;
}

// ─── Tool execution ─────────────────────────────────────────────────────────────────────────────────────────────

const dec = (token) => (token === "WPROS" ? 18 : 6);
const units = (amount, token) => parseUnits(String(amount), dec(token));
/** A viem client on the current network's RPC (state-override eth_calls: dry runs, quotes, simulations). */
export const rpcClient = (n = net()) =>
  createPublicClient({ chain: { id: n.chainId, name: n.name, nativeCurrency: { name: n.native, symbol: n.native, decimals: 18 }, rpcUrls: { default: { http: [n.rpc] } } }, transport: http(n.rpc, { retryCount: 3, timeout: 20_000 }) });

function needUser(ctx) {
  if (!ctx.user) throw new UserError("no wallet is connected — ask the user to connect their wallet first");
  if (/^0x0{40}$/i.test(net().warden)) throw new UserError("Warden is not deployed yet on this deployment");
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
    notPayee: (a) => `${a} is not one of your approved payees (payees-only mode)`,
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
    payMany: (n, total) => `Pay ${n} people, ${total} USDC in total — one signature`,
    revoke: (s, who, kind) => `Revoke ${who}'s ${kind === "permit2" ? "Permit2 " : ""}allowance on your ${s}`,
  },
  pt: {
    policyFirst: "Defina antes sua política no Warden (o agente propõe uma)",
    paused: "sua política está pausada",
    notEnabled: (n) => `${n} não está habilitado na sua política`,
    noLimit: (s) => `sem limite para ${s}`,
    notPayee: (a) => `${a} não está entre os seus destinatários aprovados (modo só aprovados)`,
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
    payMany: (n, total) => `Pagar ${n} pessoas, ${total} USDC no total — uma assinatura`,
    revoke: (s, who, kind) => `Revogar a permissão ${kind === "permit2" ? "no Permit2 " : ""}de ${who} sobre o seu ${s}`,
  },
};
const say = (ctx) => CARD[ctx.lang === "pt" ? "pt" : "en"];

/** What the dry run needs to assume for a user who has not done the one-time steps yet, and those steps as txs. */
async function prerequisites(ctx, { permit, protocolKey, pays = [] }) {
  const user = ctx.user;
  const policy = await wardenPolicy(ctx.chain, user);
  const steps = [];
  const assume = { allowance: true };
  const p = protocolKey ? protocolByKey(protocolKey) : null;
  if (!policy.exists) {
    steps.push({ kind: "policy-missing", label: say(ctx).policyFirst });
    assume.policy = { protocols: allProtocolsMask(), limits: permit.permitted.map((t) => ({ token: t.token, perAction: t.amount, perDay: t.amount })) };
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
    if (policy.payeesOnly)
      for (const to of pays.map((x) => x.to)) if (!(await ctx.chain.read(net().warden, ABI.warden, "payeeAllowed", [user, to]))) reasons.push(say(ctx).notPayee(to));
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
  const pre = await prerequisites(ctx, { permit: plan.permit, protocolKey, pays: plan.intent.pays });
  const [sim, gasPrice] = await Promise.all([dryRun(ctx.rpc, { ...plan, assume: pre.assume }), ctx.rpc.getGasPrice().catch(() => null)]);
  // the network fee before signing (ProsPilot's gas skill): dry-run gas + the base transaction cost, with a margin
  const fee = gasPrice ? fmt(((sim.gas * 13n) / 10n + 21_000n) * gasPrice, 18, 6) : null;
  const card = {
    kind: "intent",
    action: kind,
    summary,
    network: networkLabel(),
    networkKey: net().key,
    chainId: net().chainId,
    ...(fee && { fee: `≈ ${fee} ${net().native}` }),
    warden: net().warden,
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
  return { proposed: sim.ok, network: networkLabel(), summary, needsFirst: pre.steps.map((s) => s.label), ...described, ...(fee && { networkFee: `≈ ${fee} ${net().native}` }), deadline: new Date(Number(plan.intent.deadline) * 1000).toISOString(), shownToUser: "a card with Sign / Send buttons is on the page" };
}

/** One payee check per payee per turn: check_payee and propose_payment share it (it reads 12,000 blocks of logs). */
function payeeCheck(ctx, payee) {
  const key = `payee:${String(payee).toLowerCase()}`;
  if (!ctx.cache?.has(key)) {
    const p = checkPayee(ctx.chain, { user: ctx.user ?? payee, payee });
    p.catch(() => ctx.cache?.delete(key)); // a failed read is not remembered
    ctx.cache?.set(key, p);
  }
  return ctx.cache?.get(key) ?? checkPayee(ctx.chain, { user: ctx.user ?? payee, payee });
}

const networkLabel = () => (net().testnet ? `${net().name} (test funds)` : `${net().name} (real funds)`);

/** A plain transaction card (policy, revoke…): network facts the page needs to switch chains and link the explorer. */
const txCard = (ctx, card) => ctx.emit({ type: "card", card: { kind: "tx", network: networkLabel(), networkKey: net().key, chainId: net().chainId, ...card } });

const handlers = {
  async wallet_overview(ctx, { address }) {
    const who = address ? getAddress(address) : ctx.user;
    if (!who) throw new UserError("no wallet connected and no address given");
    const w = await walletOverview(ctx.chain, who);
    return {
      wallet: w.user,
      [net().native]: fmt(w.pros, 18),
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
    const amt = units(amount, from);
    const q = await quoteSwap(ctx.rpc, { from, amount: amt });
    const safety = await swapSafety(ctx.rpc, { from, amount: amt, amountOut: q.amountOut });
    return { youPay: `${amount} ${from}`, youGet: `${fmt(q.amountOut, q.to === "WPROS" ? 18 : 6)} ${q.to}`, route: q.route, safety };
  },

  async check_payee(ctx, { payee }) {
    const r = await payeeCheck(ctx, payee);
    return { payee: r.payee, verdict: r.verdict, reasons: r.reasons, scanned: r.scanned ? `${r.scanned.transfers} of your USDC transfers in the last ${r.scanned.blocks} blocks` : undefined, ...(r.prospilot && { prospilotSecondOpinion: r.prospilot }) };
  },

  async check_transaction(ctx, { to, data = "0x", value_wei = "0" }) {
    const user = needUser(ctx);
    const r = await checkTransaction(ctx, { user, to, data, value: BigInt(value_wei) });
    const { raw, ...forModel } = r;
    ctx.emit({ type: "card", card: { kind: "check", what: "transaction", networkKey: net().key, verdict: r.verdict, target: r.target, call: r.call, simulation: r.simulation, flags: r.flags } });
    return forModel;
  },

  async check_signature(ctx, { typed_data }) {
    const r = await checkSignature(ctx, { user: ctx.user, typedData: typed_data });
    ctx.emit({ type: "card", card: { kind: "check", what: "signature", networkKey: net().key, verdict: r.verdict, request: r.request, verifyingContract: r.verifyingContract, flags: r.flags } });
    return r;
  },

  async scan_approvals(ctx, { address }) {
    const who = address ? getAddress(address) : ctx.user;
    if (!who) throw new UserError("no wallet connected and no address given");
    const r = await scanApprovals(ctx, { user: who });
    ctx.emit({ type: "card", card: { kind: "approvals", networkKey: net().key, wallet: r.wallet, approvals: r.approvals, coverage: r.coverage, own: who === ctx.user } });
    return r;
  },

  async propose_revoke(ctx, { token, spender, kind }) {
    const user = needUser(ctx);
    const t = getAddress(token);
    const s = getAddress(spender);
    const live = kind === "permit2" ? (await ctx.chain.read(PERMIT2, ABI.permit2, "allowance", [user, t, s]))[0] : await ctx.chain.read(t, ABI.erc20, "allowance", [user, s]);
    if (live === 0n) throw new UserError("there is no such allowance to revoke (it is already 0)");
    const m = await tokenMeta(ctx.chain, t);
    const summary = say(ctx).revoke(m.symbol, contractName(s) ?? `${s.slice(0, 6)}…${s.slice(-4)}`, kind);
    txCard(ctx, { action: "revoke", summary, lines: [summary], tx: toJSON(revokeTx({ kind, token: t, spender: s })) });
    return { proposed: true, summary, note: "one transaction the user signs; no funds move" };
  },

  async explain_tx(ctx, { tx_hash }) {
    return explainTx(ctx, { hash: tx_hash, user: ctx.user });
  },

  async verify_tokens(ctx) {
    const r = await verifyTokens(ctx.docs, ctx.chain);
    const out = { network: r.network, allAgree: r.allAgree, tokens: r.tokens.map((t) => ({ symbol: t.symbol, address: t.address, registry: t.registry === t.address, skillEngine: t.skillEngine === t.address ? true : t.skillEngine ? `lists ${t.skillEngine} instead` : "not listed", chain: `${t.chain.symbol}, ${t.chain.decimals} decimals` })), sources: r.sources };
    if (!r.allAgree) out.note = "Warden uses the official token registry's address; where SkillEngine lists another one, mention the disagreement to the user in one line.";
    return out;
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
    const safety = await swapSafety(ctx.rpc, { from, amount: amt, amountOut: q.amountOut, slippageBps: slippage_bps });
    const r = await proposeIntent(ctx, { kind: "swap", plan, protocolKey: "faroswap", summary, extra: { quote: `${fmt(q.amountOut, dec(to))} ${to}`, slippageBps: slippage_bps, safety } });
    return { ...r, swapSafety: safety };
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

  async propose_payment(ctx, { payments }) {
    const user = needUser(ctx);
    const seen = new Set();
    for (const p of payments) {
      if (!isAddress(p.payee, { strict: false })) throw new UserError(`${p.payee} is not a valid address`);
      const k = p.payee.toLowerCase();
      if (seen.has(k)) throw new UserError(`${p.payee} appears twice — merge it into one payment`);
      seen.add(k);
      if (units(p.amount, "USDC") === 0n) throw new UserError("every payment must be above 0");
    }
    // every payee checked (in parallel); one that must not be paid stops the whole batch
    const checks = await Promise.all(payments.map((p) => payeeCheck(ctx, p.payee)));
    const stopped = checks.map((c, i) => ({ c, p: payments[i] })).filter(({ c }) => c.verdict === "stop");
    if (stopped.length) return { proposed: false, refused: true, stopped: stopped.map(({ c, p }) => ({ payee: p.payee, reasons: c.reasons })) };
    const list = payments.map((p, i) => ({ to: checks[i].payee, amount: units(p.amount, "USDC") }));
    const total = list.reduce((s, p) => s + p.amount, 0n);
    const summary = list.length === 1 ? say(ctx).pay(payments[0].amount, list[0].to) : say(ctx).payMany(list.length, fmt(total, 6));
    const plan = payIntent({ user, payments: list, summary });
    const payeeChecks = checks.map((c) => ({ payee: c.payee, verdict: c.verdict, reasons: c.reasons, ...(c.prospilot && { prospilot: c.prospilot }) }));
    const r = await proposeIntent(ctx, { kind: "payment", plan, summary, extra: { payeeChecks, payments: list.map((p) => ({ to: p.to, amount: fmt(p.amount, 6) })) } });
    return { ...r, payeeChecks };
  },

  async propose_policy(ctx, a) {
    const user = needUser(ctx);
    const limits = [{ token: net().tokens.USDC.address, perAction: units(a.usdc_per_action, "USDC"), perDay: units(a.usdc_per_day, "USDC") }];
    if (a.wpros_per_action && a.wpros_per_day) limits.push({ token: net().tokens.WPROS.address, perAction: units(a.wpros_per_action, "WPROS"), perDay: units(a.wpros_per_day, "WPROS") });
    for (const l of limits) if (l.perAction > l.perDay) throw new UserError("a per-action limit cannot be above the daily limit");
    const mask = (a.protocols ?? []).reduce((m, k) => m | (1 << protocolByKey(k).id), 0); // Atlantic: no protocols
    const expiry = a.expiry_days ? BigInt(Math.floor(Date.now() / 1000) + a.expiry_days * 86_400) : 0n;
    const tx = configureTx({ limits, protocols: mask, payeesOnly: a.payees_only, expiry });
    const c = say(ctx);
    const day = expiry ? new Date(Number(expiry) * 1000).toISOString().slice(0, 10) : null;
    const lines = [
      c.usdcLine(a.usdc_per_action, a.usdc_per_day),
      ...(limits[1] ? [c.wprosLine(a.wpros_per_action, a.wpros_per_day)] : []),
      ...(a.protocols?.length ? [c.protocols(a.protocols.map((k) => protocolByKey(k).name).join(", "))] : []),
      a.payees_only ? c.payeesOnly : c.payeesAny,
      day ? c.expires(day) : c.noExpiry,
    ];
    txCard(ctx, { action: "policy", summary: c.policyTitle, lines, tx: toJSON(tx) });
    return {
      proposed: true,
      policy: { ...a, expires: day ?? "never" },
      note: "one transaction to Warden, signed by the user; no funds move",
      ...(a.payees_only && { payeesOnly: "with payees-only on, Warden pays only approved payees: each payee needs propose_policy_change approve_payee (one transaction each) before a payment to it can run — propose those too, or use payees_only false" }),
    };
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
    txCard(ctx, { action, summary, lines: [summary], tx: toJSON(tx) });
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
      if (s.maxItems && v.length > s.maxItems) return `"${k}" takes at most ${s.maxItems} item(s)`;
      if (s.uniqueItems && new Set(v).size !== v.length) return `"${k}" has duplicates`;
      if (s.items?.enum && v.some((x) => !s.items.enum.includes(x))) return `"${k}" items must be among ${s.items.enum.join(", ")}`;
      if (s.items?.type === "object") {
        for (let i = 0; i < v.length; i++) {
          const bad = validateInput(s.items, v[i]);
          if (bad) return `"${k}" item ${i + 1}: ${bad}`;
        }
      }
    }
  }
  return null;
}

export async function runTool(ctx, name, input) {
  const h = handlers[name];
  const tool = toolsFor().find((t) => t.name === name);
  if (!h || !tool) return { error: `${name} is not available on ${net().name}` };
  const invalid = validateInput(tool.input_schema, input ?? {});
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
  const ctx = { user: user ? getAddress(user) : null, lang, chain, docs, rpc: rpcClient(), emit, cache: new Map() };
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
        system: [{ type: "text", text: systemFor(), cache_control: { type: "ephemeral" } }],
        tools: toolsFor(),
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

export const explorer = { tx: (h) => `${net().explorer}/tx/${h}` };
