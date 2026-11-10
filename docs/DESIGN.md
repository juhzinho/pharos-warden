# Pharos Warden — design

## The problem

AI agents are good at reading a chain and deciding what to do. They are not trustworthy enough to hold a wallet: a model can misread a pool, pick a look-alike address, or be talked into a bad trade. Today a user has two bad options: give the agent a key (and hope), or check every calldata by hand (and stop using the agent).

## The idea

**The agent proposes; the user signs the outcome; the contract enforces it.**

1. The user asks in plain words: "swap 20 USDC to WPROS", "put 100 USDC in the best vault but keep 50 liquid", "pay 15 USDC to 0x…".
2. The agent (Claude) reads Pacific through the **Pharos Chain MCP**, checks canonical addresses and protocol facts through the **Developer Docs MCP**, follows the **SkillEngine** network and token config, quotes and simulates, then builds one *intent* with deterministic code — the model never writes calldata.
3. The intent states its guarantees in plain numbers: *spend at most these amounts, receive at least these amounts, pay exactly these payees*.
4. The user signs those guarantees in their own wallet (a Permit2 signature whose witness is the intent — the wallet shows the minimum amounts) and sends one transaction to **Warden**.
5. **Warden** (our contract on Pacific) pulls only the signed amounts, runs only allowlisted protocol calls, and **reverts the whole transaction** unless every guarantee holds. It also enforces the user's own **on-chain policy**: a per-token limit per action and per day, the protocols they opted into, payees they approved, an expiry and a pause switch.
6. The agent reads the receipt back through the Chain MCP and reports what happened, with the explorer link.

Nothing in the agent or the frontend holds a private key. A wrong plan can fail; it cannot cost the user more than they signed.

## Contract: `Warden`

- No owner, no admin, no upgrade. The protocol allowlist is fixed at deployment.
- **Allowlist (Pacific):** FaroSwap DODORouteProxy (target) + DODOApprove (approval spender) · Morpho Vault V2 RockawayX USDC · Morpho Vault V2 SharpByte USDC · Avalon (Aave V3) pool.
- **Inputs** come only through Permit2 `permitWitnessTransferFrom`: exact tokens and amounts, one-time nonce, deadline. The user never approves Warden itself.
- **Witness** `Intent(address user,bytes32 actionsHash,Out[] outs,Pay[] pays,uint256 deadline,bytes32 planId)` — outs are minimum balance increases of the user, pays are exact payments.
- **Execution:** only `msg.sender == intent.user`; policy checks; record the user's balances; pull inputs; approve exact amounts to allowlisted spenders; run allowlisted calls; reset approvals; make payments; return every leftover to the user; check every guarantee against the user's real balances; emit `Executed`.
- **Policy** is per user and set by the user: `setLimit(token, perAction, perDay)`, `setProtocols(mask)`, `setPayee(payee, allowed)`, `setPayeesOnly`, `setExpiry`, `pause`/`unpause`. A token without a limit cannot be spent through Warden.

## Agent

Claude (`claude-opus-5-5`) in a streamed tool loop on the server. Tools are thin, typed wrappers:

| Tool | Backed by |
|---|---|
| `chain_*` (balances, calls, logs, receipts, gas) | Pharos Chain MCP |
| `docs_ask`, `docs_search`, `docs_page`, `token_registry` | Pharos Developer Docs MCP |
| `skill_network` | SkillEngine `assets/networks.json` + `tokens.json` |
| `quote_swap`, `vault_rates`, `check_payee` | deterministic code over Chain MCP reads |
| `propose_intent` | deterministic planner → intent + guarantees (no model-written calldata) |
| `warden_policy`, `warden_history` | Warden contract via Chain MCP |

The model decides *which* tools to call and *what* to propose; the guarantees are computed by code and enforced by the contract.
