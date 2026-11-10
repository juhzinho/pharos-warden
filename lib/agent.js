import Anthropic from "@anthropic-ai/sdk";
import { createPublicClient, encodeFunctionData, getAddress, http, isAddress, parseUnits } from "viem";
import { ABI, NETWORKS, PERMIT2, allProtocolsMask, contractName, net, protocolByKey, tokenByAddress } from "./config.js";
import { RpcReader } from "./chain.js";
import { VAULT_ABI, allowanceOf, farooState, liquidityIntent, lpPositions, pairAmounts, poolState, poolStates, rangeTicks, realfiPositions, removeLiquidityTx, unstakeTx } from "./defi.js";
import ECOSYSTEM from "./ecosystem.json" with { type: "json" };
import { checkLink } from "./links.js";
import { prospilotData } from "./prospilot.js";
import { walletScore } from "./score.js";
import { CATALOG as X402_CATALOG, prepare as x402Prepare } from "./x402.js";
import { checkSignature, checkTransaction, explainTx, revokeTx, scanApprovals, tokenMeta } from "./guard.js";
import { approvePermit2Tx, base as baseIntent, configureTx, depositIntent, payIntent, permitFor, policyCallTx, stakeIntent, swapIntent, toJSON, typedDataFor, withdrawIntent, wrapTx } from "./intent.js";
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
    input_schema: { type: "object", properties: { to: ADDRESS, data: HEX, value_wei: { type: "string", pattern: "^[0-9]{1,40}$", description: "native value in wei, default 0" }, as_address: { ...ADDRESS, description: "simulate as this address instead of the connected wallet" } }, required: ["to"], additionalProperties: false },
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
    description: "Prepare guarded USDC (or, on Pacific, WPROS) payments in ONE signature: exactly these amounts to exactly these payees and nothing else (1 to 10 payees; the same payee may not repeat). Every payee is checked first; a payee that fails the check stops the whole batch.",
    input_schema: {
      type: "object",
      properties: { token: { type: "string", enum: ["USDC", "WPROS"], description: "default USDC" }, payments: { type: "array", minItems: 1, maxItems: 10, items: { type: "object", properties: { payee: ADDRESS, amount: AMOUNT }, required: ["payee", "amount"], additionalProperties: false } } },
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
        protocols: { type: "array", items: { type: "string", enum: ["faroswap", "rockawayx", "sharpbyte", "avalon", "faroo", "faroswap_lp"] }, minItems: 1, uniqueItems: true },
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
  {
    name: "pool_info",
    pacificOnly: true,
    description: "The four FaroSwap V3 WPROS/USDC pools (0.01%, 0.05%, 0.30%, 1.00%): current price, tick and liquidity, read on chain. Use it before proposing liquidity.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "propose_add_liquidity",
    pacificOnly: true,
    description: "Prepare a guarded FaroSwap V3 WPROS/USDC liquidity position: the user gives one side (an amount of USDC or WPROS), a fee tier and a range; the other side is computed at the live price, the mint is dry-run through Warden, its minimums are set from that dry run minus the slippage, and the position NFT goes straight to the user. Whatever the pool does not take comes back.",
    input_schema: {
      type: "object",
      properties: {
        token: { type: "string", enum: ["USDC", "WPROS"], description: "the side the user gave" },
        amount: AMOUNT,
        fee_tier: { type: "string", enum: ["0.01", "0.05", "0.30", "1.00"], description: "percent" },
        range: { type: "string", enum: ["full", "percent", "prices"] },
        range_percent: { type: "integer", minimum: 1, maximum: 90, description: "for range=percent: ± this percent around the price" },
        min_price: { ...AMOUNT, description: "for range=prices: USDC per WPROS" },
        max_price: { ...AMOUNT, description: "for range=prices: USDC per WPROS" },
        slippage_bps: { type: "integer", minimum: 10, maximum: 500 },
      },
      required: ["token", "amount", "fee_tier", "range", "slippage_bps"],
      additionalProperties: false,
    },
  },
  {
    name: "lp_positions",
    pacificOnly: true,
    description: "The wallet's FaroSwap V3 positions: pair, fee tier, price range, in range or not, the tokens in each position now and the exact uncollected fees (both simulated as the owner). Defaults to the connected wallet.",
    input_schema: { type: "object", properties: { address: ADDRESS }, additionalProperties: false },
  },
  {
    name: "propose_remove_liquidity",
    pacificOnly: true,
    description: "Prepare removing a share of a FaroSwap V3 position and collecting everything it owes (one transaction the owner signs; minimums from a simulation minus the slippage). percent 0 = collect fees only.",
    input_schema: { type: "object", properties: { token_id: { type: "string", pattern: "^[0-9]{1,20}$" }, percent: { type: "integer", minimum: 0, maximum: 100 }, slippage_bps: { type: "integer", minimum: 10, maximum: 500 } }, required: ["token_id", "percent", "slippage_bps"], additionalProperties: false },
  },
  {
    name: "staking_info",
    pacificOnly: true,
    description: "Faroo liquid staking (stPROS): realised 7-day staking yield from the share price, size, the 7-day unstake period, and the wallet's stake with its WPROS value. Defaults to the connected wallet.",
    input_schema: { type: "object", properties: { address: ADDRESS }, additionalProperties: false },
  },
  {
    name: "propose_stake",
    pacificOnly: true,
    description: "Prepare a guarded Faroo stake: WPROS → stPROS, the shares go straight to the user (at least the previewed amount). If the wallet has PROS but not enough WPROS, the card adds a wrap step first.",
    input_schema: { type: "object", properties: { amount: AMOUNT }, required: ["amount"], additionalProperties: false },
  },
  {
    name: "propose_unstake",
    pacificOnly: true,
    description: "Prepare unstaking stPROS with Faroo (amount of stPROS or \"all\"): a request the user signs; Faroo releases the PROS after its 7-day unstake period, claimed on app.faroo.xyz. Not a Warden action (nothing arrives immediately to guarantee).",
    input_schema: { type: "object", properties: { amount: { type: "string", pattern: "^(all|[0-9]+(\\.[0-9]+)?)$" } }, required: ["amount"], additionalProperties: false },
  },
  {
    name: "realfi_positions",
    pacificOnly: true,
    description: "The wallet's RealFi / RWA positions on Pacific (Ember pAlpha, AquaFlux, Zona, OpenFi, R25 VRPC, TermMax, Janus Henderson / Anemoy, Faroo vaults), from a registry whose every token was checked on chain, vault shares valued in their asset. Defaults to the connected wallet.",
    input_schema: { type: "object", properties: { address: ADDRESS }, additionalProperties: false },
  },
  {
    name: "check_allowance",
    description: "How much a spender may take of a token from the wallet: the token's own allowance and the Permit2 one, with who the spender is.",
    input_schema: { type: "object", properties: { token: ADDRESS, spender: ADDRESS }, required: ["token", "spender"], additionalProperties: false },
  },
  {
    name: "propose_approve",
    description: "Prepare an EXACT token approval for a spender contract (never unlimited; a plain wallet as spender is refused). One transaction the user signs.",
    input_schema: { type: "object", properties: { token: ADDRESS, spender: ADDRESS, amount: AMOUNT }, required: ["token", "spender", "amount"], additionalProperties: false },
  },
  {
    name: "propose_send_native",
    description: "Prepare sending the network's native coin (PROS on Pacific, PHRS on Atlantic) to one address, after the payee check. A plain transfer the user signs (Warden guards ERC-20 payments; native coin goes straight from the wallet).",
    input_schema: { type: "object", properties: { payee: ADDRESS, amount: AMOUNT }, required: ["payee", "amount"], additionalProperties: false },
  },
  {
    name: "buy_data",
    description: "Buy premium Pharos data over x402 (pay per call, Circle USDC on Atlantic, at most 0.01 USDC): atlantic_block, pacific_gas (fee market of the last 64 blocks), pacific_wallet (a wallet profile; needs address). The user signs the exact payment in their wallet; the card shows the data and the settlement transaction.",
    input_schema: { type: "object", properties: { item: { type: "string", enum: ["atlantic_block", "pacific_gas", "pacific_wallet"] }, address: ADDRESS }, required: ["item"], additionalProperties: false },
  },
  {
    name: "wallet_score",
    description: "A 0–100 score of a wallet on this network with its parts (activity, holdings, protocol use, approval hygiene, account type), each with the evidence read on chain. Defaults to the connected wallet.",
    input_schema: { type: "object", properties: { address: ADDRESS }, additionalProperties: false },
  },
  {
    name: "tx_history",
    pacificOnly: true,
    description: "Recent transactions of a wallet on Pacific Mainnet, from ProsPilot's indexer API (agent to agent). Defaults to the connected wallet.",
    input_schema: { type: "object", properties: { address: ADDRESS }, additionalProperties: false },
  },
  {
    name: "pharos_news",
    description: "Latest official Pharos announcements, blog posts and @pharos_network posts, and the live campaigns from Pharos Port (through ProsPilot's API).",
    input_schema: { type: "object", properties: { what: { type: "string", enum: ["news", "campaigns"] } }, required: ["what"], additionalProperties: false },
  },
  {
    name: "rwa_market",
    description: "Live global RWA tokenization figures (rwa.xyz aggregates, through ProsPilot's API): distributed and represented asset value, holders, by asset class and network.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "web3_briefing",
    description: "A short live briefing on one Web3 topic (through ProsPilot's API): defi, layer2, security, regulation or airdrops.",
    input_schema: { type: "object", properties: { topic: { type: "string", enum: ["defi", "layer2", "security", "regulation", "airdrops"] } }, required: ["topic"], additionalProperties: false },
  },
  {
    name: "ecosystem",
    description: "The official Pharos ecosystem directory (Pharos Port: 43 active projects — wallets, DEX, RWA, lending, bridges, oracles, RPC, security, identity…), searchable by name, category or words.",
    input_schema: { type: "object", properties: { query: { type: "string", minLength: 2, maxLength: 60 } }, additionalProperties: false },
  },
  {
    name: "check_link",
    description: "Before the user opens or connects a wallet to a link: a static check of the URL (no visit) — official Pharos/ecosystem domain or not, look-alike (typosquat, homoglyph, punycode), free-hosting, URL shortener, raw IP, risky TLD, drainer-style paths (claim, airdrop, connect, seed).",
    input_schema: { type: "object", properties: { url: { type: "string", minLength: 4, maxLength: 500 } }, required: ["url"], additionalProperties: false },
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
    if (t.name === "propose_payment") {
      const { token, ...properties } = t.input_schema.properties;
      return { ...t, input_schema: { ...t.input_schema, properties } };
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
    ? "swap on FaroSwap, provide FaroSwap V3 liquidity, stake PROS with Faroo, earn on USDC vaults (Morpho RockawayX, Morpho SharpByte, Avalon), follow RealFi / RWA positions, and pay people in USDC, WPROS or PROS"
    : "pay people in USDC — one payee or a batch in a single signature — under on-chain limits (Atlantic has no DEX or lending protocol, so swaps and vaults live on Pacific Mainnet: tell the user to switch network in the page header for those)";
  const chainTools = n.chainSource === "mcp" ? "the Pharos Chain MCP" : `the ${n.short} RPC (the Pharos Chain MCP serves Pacific only)`;
  return `You are Warden, an AI agent for ${n.name} (chain ${n.chainId}) inside the Pharos Warden dApp. Your wallet-safety skills come from ProsPilot, another Pharos agent, made stronger with real simulation.

You help one user — the connected wallet — ${what}. You can also buy premium Pharos data over x402 (buy_data: the user signs the exact payment), and answer about Pharos news, campaigns, the RWA market and the ecosystem directory (ProsPilot's data). You also keep them safe outside Warden: check any transaction or signature another dApp asks them to sign (check_transaction, check_signature), find and revoke risky token approvals (scan_approvals, propose_revoke), check links before they open them (check_link), score a wallet (wallet_score) and explain any transaction (explain_tx). You never hold keys and you never send transactions. You prepare intents; the user signs their guarantees in their own wallet; the Warden contract (${n.warden}) enforces them on chain and reverts if any guarantee fails.

How you work:
- Read before you decide. Chain data comes from ${chainTools}. Use docs_ask (Pharos Developer Docs MCP) when a Pharos fact matters. Call verify_tokens once per conversation before your first proposal. Never state a balance, rate, price or address you did not get from a tool in this conversation.
- Decide like a careful advisor: say what you would do and why, with the numbers. If something is risky or pointless (a payee that looks like address poisoning, a swap with a large price impact, an amount above the user's balance), say so plainly and don't propose it.
- When the user pastes a transaction or a signature request from somewhere else, check it with check_transaction / check_signature before anything else and lead with the verdict in one sentence; never tell them to sign something the check marks do_not_sign.
- Propose only through the propose_* tools. They build the transaction and dry-run it; you never write calldata or addresses yourself.
- A first-time user needs a Warden policy before any guarded action. Use payees_only false unless the user asks for it (then also propose approve_payee for each payee). If wallet_overview shows none, explain it in one or two sentences and, in the same turn, call propose_policy with modest limits that fit the request AND the propose_* tool for what they asked: its dry run assumes that policy and its card tells the user to sign the policy first. The page also shows the one-time Permit2 approval step when needed.
${n.testnet ? `- This is a testnet: test USDC has no value (free from ${n.faucet}, network "Pharos Testnet"), gas is test ${n.native}. Say it is a testnet when you propose.` : "- Every proposal is on mainnet with real funds: say so before the user signs (SkillEngine's rule for mainnet writes)."}
- After the user says they sent a transaction, call verify_execution with its hash (explain_tx for any other transaction) and report what the chain says.
- Never name your tools to the user (say "I can scan your approvals", not the tool's name).
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
    pay: (a, to, s = "USDC") => `Pay exactly ${a} ${s} to ${to}`,
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
    payMany: (n, total, s = "USDC") => `Pay ${n} people, ${total} ${s} in total — one signature`,
    wrap: (a) => `Wrap ${a} PROS into WPROS first (one transaction)`,
    addLiquidity: (w, u, f, r) => `Add liquidity: up to ${w} WPROS + ${u} USDC, FaroSwap ${f}% pool, range ${r}`,
    fullRange: "full range",
    removeLiquidity: (p, id, e) => `Remove ${p}% of position #${id} and collect its fees (≈ ${e})`,
    collectFees: (id, e) => `Collect the fees of position #${id} (≈ ${e})`,
    atLeast: (x) => `At least ${x}, or the transaction reverts`,
    stake: (a, s) => `Stake ${a} WPROS with Faroo → at least ${s} stPROS`,
    unstake: (s, w) => `Unstake ${s} stPROS with Faroo (≈ ${w} WPROS)`,
    unstakeWait: "Faroo releases the PROS after 7 days; claim it on app.faroo.xyz",
    approveExact: (a, s, who) => `Approve exactly ${a} ${s} for ${who}`,
    sendNative: (a, n, to) => `Send ${a} ${n} to ${to}`,
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
    pay: (a, to, s = "USDC") => `Pagar exatamente ${a} ${s} para ${to}`,
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
    payMany: (n, total, s = "USDC") => `Pagar ${n} pessoas, ${total} ${s} no total — uma assinatura`,
    wrap: (a) => `Converter antes ${a} PROS em WPROS (uma transação)`,
    addLiquidity: (w, u, f, r) => `Adicionar liquidez: até ${w} WPROS + ${u} USDC, pool ${f}% da FaroSwap, faixa ${r}`,
    fullRange: "faixa completa",
    removeLiquidity: (p, id, e) => `Retirar ${p}% da posição #${id} e coletar as taxas (≈ ${e})`,
    collectFees: (id, e) => `Coletar as taxas da posição #${id} (≈ ${e})`,
    atLeast: (x) => `No mínimo ${x}, ou a transação reverte`,
    stake: (a, s) => `Fazer stake de ${a} WPROS na Faroo → no mínimo ${s} stPROS`,
    unstake: (s, w) => `Tirar do stake ${s} stPROS na Faroo (≈ ${w} WPROS)`,
    unstakeWait: "A Faroo libera o PROS depois de 7 dias; resgate em app.faroo.xyz",
    approveExact: (a, s, who) => `Aprovar exatamente ${a} ${s} para ${who}`,
    sendNative: (a, n, to) => `Enviar ${a} ${n} para ${to}`,
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
    if (balance < t.amount) {
      // WPROS short but native PROS enough: wrap the difference first (one plain transaction), assumed in the dry run
      const short = t.amount - balance;
      const native = tok.symbol === "WPROS" ? await ctx.chain.balance(user) : 0n;
      if (tok.symbol === "WPROS" && native >= short + 10n ** 16n) {
        steps.push({ kind: "wrap", label: say(ctx).wrap(fmt(short, 18)), tx: toJSON(wrapTx(short)) });
        assume.balance = { ...(assume.balance ?? {}), [t.token]: t.amount };
      } else throw new UserError(`the wallet holds ${fmt(balance, tok.decimals)} ${tok.symbol}${tok.symbol === "WPROS" ? ` and ${fmt(native, 18)} PROS` : ""}, less than the ${fmt(t.amount, tok.decimals)} ${tok.symbol} needed`);
    }
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

/** What the model reads: the English texts only (the Portuguese ones are for the page's cards). */
const english = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === "pt" || k.endsWith("Pt") ? undefined : typeof x === "bigint" ? x.toString() : x)));

/** A sender with nothing in it, for simulations before a wallet is connected. */
const EMPTY_SENDER = getAddress("0x000000000000000000000000000000000000c0de");

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
      holdings: w.holdings.filter((h) => h.balance > 0n).map((h) => ({ token: h.symbol, balance: fmt(h.balance, h.decimals), ...(h.value != null && { worth: `${fmt(h.value, h.valueDecimals)} ${h.valueSymbol}` }), permit2Approved: h.permit2Allowance > 0n ? fmt(h.permit2Allowance, h.decimals) : "no" })),
      ...(w.usd != null && { totalUsd: w.usd.toFixed(2), prosPriceUsd: w.prosUsd }),
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

  async check_transaction(ctx, { to, data = "0x", value_wei = "0", as_address }) {
    // as the connected wallet, or the address the user names; with neither, from an empty address (decoding and flags
    // still hold, but the balance changes are not the user's — said so in the result)
    const user = as_address ? getAddress(as_address) : ctx.user ?? EMPTY_SENDER;
    const r = await checkTransaction(ctx, { user, to, data, value: BigInt(value_wei) });
    const { raw, ...forModel } = r;
    if (user === EMPTY_SENDER) forModel.simulatedAs = "no wallet connected: simulated from an empty address, so balance changes are not the user's — ask them to connect for an exact simulation";
    ctx.emit({ type: "card", card: { kind: "check", what: "transaction", networkKey: net().key, verdict: r.verdict, target: r.target, call: r.call, simulation: r.simulation, flags: r.flags, as: user === EMPTY_SENDER ? "empty" : user === ctx.user ? "you" : user } });
    return english(forModel);
  },

  async check_signature(ctx, { typed_data }) {
    const r = await checkSignature(ctx, { user: ctx.user, typedData: typed_data });
    ctx.emit({ type: "card", card: { kind: "check", what: "signature", networkKey: net().key, verdict: r.verdict, request: r.request, requestPt: r.requestPt, verifyingContract: r.verifyingContract, flags: r.flags } });
    return english(r);
  },

  async scan_approvals(ctx, { address }) {
    const who = address ? getAddress(address) : ctx.user;
    if (!who) throw new UserError("no wallet connected and no address given");
    const r = await scanApprovals(ctx, { user: who });
    ctx.emit({ type: "card", card: { kind: "approvals", networkKey: net().key, wallet: r.wallet, approvals: r.approvals, coverage: r.coverage, coveragePt: r.coveragePt, own: who === ctx.user } });
    return english(r);
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

  async propose_payment(ctx, { payments, token = "USDC" }) {
    const user = needUser(ctx);
    const seen = new Set();
    for (const p of payments) {
      if (!isAddress(p.payee, { strict: false })) throw new UserError(`${p.payee} is not a valid address`);
      const k = p.payee.toLowerCase();
      if (seen.has(k)) throw new UserError(`${p.payee} appears twice — merge it into one payment`);
      seen.add(k);
      if (units(p.amount, token) === 0n) throw new UserError("every payment must be above 0");
    }
    // every payee checked (in parallel); one that must not be paid stops the whole batch
    const checks = await Promise.all(payments.map((p) => payeeCheck(ctx, p.payee)));
    const stopped = checks.map((c, i) => ({ c, p: payments[i] })).filter(({ c }) => c.verdict === "stop");
    if (stopped.length) return { proposed: false, refused: true, stopped: stopped.map(({ c, p }) => ({ payee: p.payee, reasons: c.reasons })) };
    const list = payments.map((p, i) => ({ to: checks[i].payee, amount: units(p.amount, token) }));
    const total = list.reduce((s, p) => s + p.amount, 0n);
    const summary = list.length === 1 ? say(ctx).pay(payments[0].amount, list[0].to, token) : say(ctx).payMany(list.length, fmt(total, dec(token)), token);
    const plan = payIntent({ user, token, payments: list, summary });
    const payeeChecks = checks.map((c) => ({ payee: c.payee, verdict: c.verdict, reasons: c.reasons, ...(c.prospilot && { prospilot: c.prospilot }) }));
    const r = await proposeIntent(ctx, { kind: "payment", plan, summary, extra: { payeeChecks, payments: list.map((p) => ({ to: p.to, amount: fmt(p.amount, dec(token)), token })) } });
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

  async pool_info(ctx) {
    const pools = await poolStates(ctx.chain);
    return { pools: pools.map((p) => ({ feeTier: p.label, pool: p.address, priceUsdcPerWpros: Number(p.price.toFixed(6)), tick: p.tick, liquidity: p.liquidity.toString() })), note: "WPROS is token0 on every tier; deeper liquidity means a position earns a smaller share of fees but the price moves less" };
  },

  async propose_add_liquidity(ctx, a) {
    const user = needUser(ctx);
    const fee = { "0.01": 100, "0.05": 500, "0.30": 3000, "1.00": 10000 }[a.fee_tier];
    const st = await poolState(ctx.chain, fee);
    if (!st) throw new UserError(`there is no ${a.fee_tier}% WPROS/USDC pool on FaroSwap`);
    if (a.range === "percent" && !a.range_percent) throw new UserError("range_percent is needed for a ± range");
    if (a.range === "prices" && !(a.min_price && a.max_price && Number(a.min_price) < Number(a.max_price))) throw new UserError("min_price below max_price is needed for a price range");
    const r = rangeTicks({ mode: a.range, percent: a.range_percent, minPrice: Number(a.min_price), maxPrice: Number(a.max_price), price: st.price, fee });
    const given = units(a.amount, a.token);
    const need = pairAmounts({ sqrtPriceX96: st.sqrtPriceX96, ...r, ...(a.token === "WPROS" ? { wpros: given } : { usdc: given }) });
    if (need.wpros === 0n && need.usdc === 0n) throw new UserError("this range needs only the other token — give the amount in it");
    const c = say(ctx);
    const summary = c.addLiquidity(fmt(need.wpros, 18, 4), fmt(need.usdc, 6, 4), a.fee_tier, a.range === "full" ? c.fullRange : `${r.minPrice.toFixed(4)}–${r.maxPrice.toFixed(4)}`);
    // pass 1: mins at 0, dry-run to learn exactly what the pool takes; pass 2: mins = that minus the slippage
    const build = (min0, min1) => liquidityIntent({ base: baseIntent({ user, summary }), user, fee, tickLower: r.tickLower, tickUpper: r.tickUpper, wpros: need.wpros, usdc: need.usdc, min0, min1, permitFor });
    const first = build(0n, 0n);
    const pre = await prerequisites(ctx, { permit: first.permit, protocolKey: "faroswap_lp" });
    const sim = await dryRun(ctx.rpc, { ...first, assume: pre.assume });
    if (!sim.ok) throw new UserError(`the position would not mint: ${sim.error.text}`);
    const used = (sym) => -(sim.deltas.find((d) => d.symbol === sym)?.delta ?? 0n);
    const keep = BigInt(10_000 - a.slippage_bps);
    const plan = build((used("WPROS") * keep) / 10_000n, (used("USDC") * keep) / 10_000n);
    const r2 = await proposeIntent(ctx, { kind: "liquidity", plan, protocolKey: "faroswap_lp", summary, extra: { range: { min: r.minPrice, max: r.maxPrice, priceNow: st.price, feeTier: a.fee_tier }, uses: { WPROS: fmt(used("WPROS"), 18), USDC: fmt(used("USDC"), 6) } } });
    return { ...r2, range: { minPrice: r.minPrice, maxPrice: r.maxPrice, priceNow: st.price, inRange: need.side === "both" }, poolTakes: { WPROS: fmt(used("WPROS"), 18), USDC: fmt(used("USDC"), 6) }, signedIn: { WPROS: fmt(need.wpros, 18), USDC: fmt(need.usdc, 6) }, leftoverGoesBack: true };
  },

  async lp_positions(ctx, { address }) {
    const who = address ? getAddress(address) : ctx.user;
    if (!who) throw new UserError("no wallet connected and no address given");
    const r = await lpPositions(ctx.chain, ctx.rpc, who);
    ctx.emit({ type: "card", card: { kind: "lp", networkKey: net().key, wallet: who, own: who === ctx.user, ...r } });
    return r;
  },

  async propose_remove_liquidity(ctx, { token_id, percent, slippage_bps }) {
    const user = needUser(ctx);
    const r = await removeLiquidityTx(ctx.chain, ctx.rpc, { user, tokenId: token_id, percent, slippageBps: slippage_bps });
    const exp = r.expected ? `${fmt(r.expected[0], 18, 4)} WPROS + ${fmt(r.expected[1], 6, 4)} USDC` : "?";
    const summary = r.onlyFees ? say(ctx).collectFees(token_id, exp) : say(ctx).removeLiquidity(percent, token_id, exp);
    txCard(ctx, { action: "liquidity", summary, lines: [summary, ...(r.minimum ? [say(ctx).atLeast(`${fmt(r.minimum[0], 18, 4)} WPROS + ${fmt(r.minimum[1], 6, 4)} USDC`)] : [])], tx: toJSON(r.tx) });
    return { proposed: true, summary, expected: exp, note: "one transaction from the position's owner (the NFT stays in the wallet; its fees are collected too)" };
  },

  async staking_info(ctx, { address }) {
    const who = address ? getAddress(address) : ctx.user;
    const latest = await ctx.chain.block();
    const weekAgo = Number(latest.number) - Math.round((7 * 86_400) / net().blockTime);
    const r = await farooState(ctx.chain, who, weekAgo);
    return { ...r, apy7d: r.apy7d != null ? `${(r.apy7d * 100).toFixed(2)}%` : "n/a", note: "realised: from the stPROS share price 7 days apart; unstaking takes 7 days (claimed on app.faroo.xyz)" };
  },

  async propose_stake(ctx, { amount }) {
    const user = needUser(ctx);
    const amt = units(amount, "WPROS");
    const f = protocolByKey("faroo");
    const shares = await ctx.chain.read(f.vault, VAULT_ABI, "previewDeposit", [amt]);
    const summary = say(ctx).stake(amount, fmt(shares, 18, 4));
    const plan = stakeIntent({ user, amount: amt, expectedShares: shares, summary });
    return proposeIntent(ctx, { kind: "stake", plan, protocolKey: "faroo", summary, extra: { unstakeDays: 7 } });
  },

  async propose_unstake(ctx, { amount }) {
    const user = needUser(ctx);
    const f = protocolByKey("faroo");
    const held = await ctx.chain.read(f.vault, VAULT_ABI, "balanceOf", [user]);
    if (held === 0n) throw new UserError("the wallet holds no stPROS");
    const shares = amount === "all" ? held : units(amount, "WPROS");
    if (shares > held) throw new UserError(`the wallet holds only ${fmt(held, 18)} stPROS`);
    const value = await ctx.chain.read(f.vault, VAULT_ABI, "convertToAssets", [shares]);
    const summary = say(ctx).unstake(fmt(shares, 18, 4), fmt(value, 18, 4));
    txCard(ctx, { action: "unstake", summary, lines: [summary, say(ctx).unstakeWait], tx: toJSON(unstakeTx({ user, shares })) });
    return { proposed: true, summary, note: "a Faroo request: the PROS is released after 7 days and claimed on app.faroo.xyz; nothing arrives right away" };
  },

  async realfi_positions(ctx, { address }) {
    const who = address ? getAddress(address) : ctx.user;
    if (!who) throw new UserError("no wallet connected and no address given");
    const r = await realfiPositions(ctx.chain, who);
    ctx.emit({ type: "card", card: { kind: "realfi", networkKey: net().key, wallet: who, ...r } });
    return r;
  },

  async check_allowance(ctx, { token, spender }) {
    const user = needUser(ctx);
    const [a, m, who] = await Promise.all([allowanceOf(ctx.chain, { user, token, spender }), tokenMeta(ctx.chain, token), ctx.chain.code(spender)]);
    const unl = (v, cap) => (v >= cap / 2n ? "unlimited" : fmt(v, m.decimals));
    return { token: m.symbol, spender: getAddress(spender), spenderIs: contractName(spender) ?? (who && who !== "0x" ? "a contract Warden does not know" : "a plain wallet"), erc20Allowance: unl(a.erc20, 2n ** 256n), permit2Allowance: a.permit2.amount > 0n ? `${unl(a.permit2.amount, 2n ** 160n)} until ${new Date(a.permit2.expiration * 1000).toISOString().slice(0, 10)}` : "none" };
  },

  async propose_approve(ctx, { token, spender, amount }) {
    const user = needUser(ctx);
    const m = await tokenMeta(ctx.chain, token);
    if (!m.known && !m.isToken) throw new UserError("that address is not a token");
    const code = await ctx.chain.code(spender);
    if (!code || code === "0x") throw new UserError("the spender is a plain wallet — Warden never prepares an approval to a wallet (that is how drainers take funds)");
    const amt = parseUnits(String(amount), m.decimals);
    if (amt === 0n) throw new UserError("use propose_revoke to set an approval to 0");
    const tx = { to: getAddress(token), data: encodeFunctionData({ abi: ABI.erc20, functionName: "approve", args: [getAddress(spender), amt] }) };
    const summary = say(ctx).approveExact(fmt(amt, m.decimals), m.symbol, contractName(spender) ?? `${spender.slice(0, 6)}…${spender.slice(-4)}`);
    txCard(ctx, { action: "approve", summary, lines: [summary], tx: toJSON(tx) });
    return { proposed: true, summary, note: "exact amount only; unlimited approvals are not offered" };
  },

  async propose_send_native(ctx, { payee, amount }) {
    const user = needUser(ctx);
    const check = await payeeCheck(ctx, payee);
    if (check.verdict === "stop") return { proposed: false, refused: true, reasons: check.reasons };
    const value = parseUnits(String(amount), 18);
    const bal = await ctx.chain.balance(user);
    if (bal < value + 10n ** 15n) throw new UserError(`the wallet holds ${fmt(bal, 18)} ${net().native}, not enough for ${amount} plus gas`);
    const summary = say(ctx).sendNative(amount, net().native, check.payee);
    txCard(ctx, { action: "payment", summary, lines: [summary, ...check.reasons.slice(0, 2)], tx: toJSON({ to: check.payee, value, data: "0x" }) });
    return { proposed: true, summary, payeeCheck: { verdict: check.verdict, reasons: check.reasons } };
  },

  async buy_data(ctx, { item, address }) {
    const user = needUser(ctx);
    const r = await x402Prepare({ item, address, user });
    if (r.refused) return { proposed: false, refused: true, reason: r.reason };
    const bal = await (net().key === "atlantic" ? ctx.chain : new RpcReader(NETWORKS.atlantic)).read(r.asset, ABI.erc20, "balanceOf", [user]);
    if (bal < BigInt(r.price)) throw new UserError(`the wallet holds ${fmt(bal, 6)} Atlantic USDC, less than the ${fmt(r.price, 6)} USDC price (free test USDC at faucet.circle.com)`);
    ctx.emit({ type: "card", card: { kind: "x402", networkKey: "atlantic", item, address: address ?? null, label: X402_CATALOG[item].label, price: fmt(r.price, 6), payTo: r.payTo, typedData: r.typedData, payment: r.payment } });
    return { proposed: true, item, price: `${fmt(r.price, 6)} USDC`, payTo: r.payTo, shownToUser: "a card asks the user to sign the exact payment; the data appears on the card once it settles" };
  },

  async wallet_score(ctx, { address }) {
    const who = address ? getAddress(address) : ctx.user;
    if (!who) throw new UserError("no wallet connected and no address given");
    const r = await walletScore(ctx, who);
    ctx.emit({ type: "card", card: { kind: "score", networkKey: net().key, ...r } });
    return r;
  },

  async tx_history(ctx, { address }) {
    const who = address ? getAddress(address) : ctx.user;
    if (!who) throw new UserError("no wallet connected and no address given");
    const r = await prospilotData(`txhistory?address=${who}`, { ttl: 60_000 });
    if (!r.available) throw new UserError(`ProsPilot's history API did not answer (${r.error}) — try explain_tx with a hash`);
    return { source: "ProsPilot txhistory API (SocialScan indexer)", wallet: who, total: r.total, txs: (r.txs ?? []).slice(0, 12) };
  },

  async pharos_news(ctx, { what }) {
    if (what === "campaigns") {
      const r = await prospilotData("campaigns");
      if (!r.available) throw new UserError(`campaigns are not available now (${r.error})`);
      return { source: "Pharos Port, through ProsPilot", campaigns: (r.campaigns ?? []).slice(0, 15) };
    }
    const [news, tweets] = await Promise.all([prospilotData("news"), prospilotData("tweets")]);
    if (!news.available && !tweets.available) throw new UserError("news are not available now");
    return { source: "pharos.xyz and @pharos_network, through ProsPilot", news: (news.items ?? []).slice(0, 8), posts: (tweets.tweets ?? []).slice(0, 8).map((t) => ({ text: String(t.text).slice(0, 280), date: t.date ?? t.created_at ?? null, url: t.url ?? null })) };
  },

  async rwa_market() {
    const r = await prospilotData("rwa");
    if (!r.available) throw new UserError(`RWA figures are not available now (${r.error})`);
    return { source: "rwa.xyz, through ProsPilot", aggregates: r.aggregates, groups: (r.groups ?? []).slice(0, 8), networks: (r.networks ?? []).slice(0, 8), fetchedAt: r.fetchedAt };
  },

  async web3_briefing(ctx, { topic }) {
    const r = await prospilotData(`web3-radar?topic=${topic}&lang=${ctx.lang === "pt" ? "pt" : "en"}`, { ttl: 900_000 });
    if (!r.available) throw new UserError(`the briefing is not available now (${r.error})`);
    return { source: "ProsPilot Web3 radar", topic, text: String(r.text).slice(0, 3000) };
  },

  async ecosystem(ctx, { query }) {
    const q = (query ?? "").toLowerCase();
    const hits = ECOSYSTEM.apps.filter((a) => !q || a.name.toLowerCase().includes(q) || a.desc.toLowerCase().includes(q) || a.categories.some((c) => c.toLowerCase().includes(q)));
    return { source: ECOSYSTEM.source, total: ECOSYSTEM.apps.length, matches: hits.length, projects: hits.map((a) => ({ name: a.name, categories: a.categories, what: a.desc, url: a.url })) };
  },

  async check_link(ctx, { url }) {
    const r = checkLink(url);
    ctx.emit({ type: "card", card: { kind: "check", what: "link", networkKey: net().key, verdict: r.verdict, request: r.host + (r.displaysAs ? ` (${r.displaysAs})` : ""), requestPt: r.host + (r.displaysAs ? ` (${r.displaysAs})` : ""), flags: r.flags } });
    return english(r);
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
