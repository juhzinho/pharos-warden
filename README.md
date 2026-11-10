# Pharos Warden

**An AI agent for Pharos that can't make you lose more than you signed.**

Ask in plain words — *"put 50 USDC where it earns most"*, *"swap 20 USDC to WPROS"*, *"pay 15 USDC to 0x…"*. The agent reads Pacific through the **Pharos Chain MCP**, checks facts with the **Developer Docs MCP**, follows the **SkillEngine**, decides, and prepares one transaction. You sign its guarantees — *spend at most this, receive at least that* — in your own wallet, and the **Warden** contract on Pharos reverts the whole transaction if any guarantee fails.

- **Live dApp:** https://pharos-warden.vercel.app
- **Contract (Pacific Mainnet):** [`0x02fa5869a0Abe62C97c1D1c65df878783Dc11418`](https://www.pharosscan.xyz/address/0x02fa5869a0Abe62C97c1D1c65df878783Dc11418)
- **Architecture:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Who it is for, and why

**For people who want an AI agent to handle their DeFi and payments on Pharos, but won't hand it their keys** — and shouldn't have to check calldata to stay safe.

Agents are good at the reading and deciding: which vault actually pays more this week, what a swap returns right now, whether an address is a look-alike of the one you meant. They are not trustworthy enough to hold a wallet: a model can misread a pool, pick the wrong venue or be talked into a bad trade. Warden splits the work:

| The agent | The contract |
|---|---|
| reads the chain, compares options, recommends, builds and dry-runs the transaction | pulls only what you signed, runs only allowlisted protocols, and **reverts unless you receive at least the minimum you signed** |

On top, each wallet keeps its own **on-chain policy** in Warden: per-token limits per action and per day, the protocols allowed, approved payees, an expiry and a pause switch. The agent proposes it; you sign it once.

## What you can do

| Ask | Agent does | Warden guarantees |
|---|---|---|
| "Where does USDC earn the most?" | realised 7-day APY of Morpho RockawayX, Morpho SharpByte and Avalon, from on-chain share prices and income indexes | — (read only) |
| "Swap 20 USDC to WPROS" | live FaroSwap quote, intent with min-out = quote − slippage, dry run | you receive ≥ the minimum WPROS, spend ≤ 20 USDC |
| "Deposit 50 USDC in the best vault" | picks the venue, previews shares, dry run | the shares / aUSDC land in **your** wallet, ≥ the minimum |
| "Withdraw everything from RockawayX" | reads your shares, previews USDC, dry run | you receive ≥ the minimum USDC |
| "Pay 15 USDC to 0x…" | checks the payee (contract? never used? blacklisted? look-alike of someone you paid? broken checksum?) | exactly 15 USDC to exactly that address, nothing else |
| "Set up my limits" / "pause" | proposes a policy that fits | enforced on every execution |

## Requirements

| # | Requirement | How Warden meets it |
|---|---|---|
| 01 | Deployed on Pharos, working UI anyone can open, contract addresses | Warden on **Pacific Mainnet** at `0x02fa5869a0Abe62C97c1D1c65df878783Dc11418` (tx [`0x46478472…`](https://www.pharosscan.xyz/tx/0x4647847216c5619ab9e109a0dd1ce13d443b96d3a2a76bc5dc802642b4c2944b), block 22,647,574 — [docs/deployment.json](docs/deployment.json)); UI at https://pharos-warden.vercel.app (no login needed: the yields and the agent's answers work before you connect a wallet) |
| 02 | Agent central, ≥ 2 Pharos AI tools | The agent *is* the product: it reads, decides and prepares every action. Uses the **Chain MCP** (balances, calls at past blocks, logs, receipts), the **Developer Docs MCP** (token registry page, questions with sources) and the **SkillEngine** (its rules for writes, network and token config, and its forge deploy flow) |
| 03 | Clear user problem; README says who and why | [Who it is for, and why](#who-it-is-for-and-why) |
| 04 | Safe: no keys in agent or frontend, fund moves signed by the user or behind policy limits, error handling | No private key anywhere in the app; every fund move is signed in the user's wallet **and** bounded by their on-chain limits **and** guaranteed by the contract. Dry run before signing; refusals explained in words; [Safety](#safety) |
| 05 | Open source, setup instructions, short architecture write-up | This repo (MIT), [Run it](#run-it), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 06 | Demo video of a real user flow | linked in the submission |

## Contracts

| | Address (Pacific Mainnet, chain 1672) |
|---|---|
| **Warden** (this project) | [`0x02fa5869a0Abe62C97c1D1c65df878783Dc11418`](https://www.pharosscan.xyz/address/0x02fa5869a0Abe62C97c1D1c65df878783Dc11418) |
| Permit2 (canonical) | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| USDC · WPROS (token registry) | `0xC879C018dB60520F4355C26eD1a6D572cdAC1815` · `0x52C48d4213107b20bC583832b0d951FB9CA8F0B0` |
| FaroSwap DODORouteProxy · DODOApprove | `0xA5cA5Fbe34e444F366B373170541ec6902b0F75c` · `0xBF105f4ffBD3825f5433d074008B9A76237d849c` |
| Morpho Vault V2 RockawayX USDC · SharpByte USDC | `0x047cD0a91E9B92ED979189a6C8A120bf280f02E5` · `0x15c25ED222fc498f672af5c3adb5ED0a96E1AFf1` |
| Avalon (Aave V3) pool · aUSDC | `0xD9B9E4F8257bFf9B1415d74c1EF88d8057f60cBa` · `0xE2ec2F3933aD2f83DE9a9dDa844558354384e87D` |

Warden has no owner: the allowlist above is fixed in its constructor, and nobody can change it.

## Safety

- **No keys.** The agent and the page never see a private key. The page asks the user's own wallet (EIP-1193, EIP-6963 discovery) to sign typed data and send transactions.
- **Exact inputs.** Funds move only through Permit2 signature transfers: exact tokens, exact amounts, a single-use nonce, a deadline. The user never approves Warden itself; the Permit2 approval the page suggests is for the exact amount.
- **Guarantees signed and enforced.** The Permit2 witness *is* the intent (EIP-712): the wallet shows the minimums and payments, and changing any of them invalidates the signature. Warden checks every minimum against the user's real balance and reverts otherwise.
- **Policy limits on chain.** Per-token limits per action and per day, protocol opt-in, payees-only mode, expiry, pause. A token without a limit cannot be spent through Warden.
- **Allowlisted protocols, no token tricks.** Calls go only to the fixed allowlist; token-moving selectors (`transfer`, `approve`, `permit`…) are refused even on allowlisted contracts (vault shares are tokens too); approvals are reset to zero; leftovers are returned.
- **Dry run before signing.** The exact transaction runs against live Pacific state first (state-override `eth_call`); assumptions are listed on the card.
- **Checks before paying.** Contract vs wallet, never-used address, USDC blacklist, token/protocol contract, look-alike of a recent counterparty, broken checksum.
- **Mainnet warning** on every card (SkillEngine's rule for mainnet writes).
- **Robust inputs and errors.** Every tool input is validated against its schema; reverts are decoded into sentences ("150 USDC is above your per-action limit of 100 USDC"); MCP timeouts and rate limits are retried briefly; the conversation is HMAC-sealed; visitors are rate-limited.

## Run it

Node.js 20.12+.

```bash
git clone https://github.com/juhzinho/pharos-warden && cd pharos-warden
npm install
```

Create `.env` (never committed):

```bash
OPENAI_API_KEY=sk-...            # or ANTHROPIC_API_KEY=sk-ant-... (Claude Opus 5.5)
WARDEN_SESSION_SECRET=<random>   # seals conversations; any long random string
# OPENAI_MODEL=gpt-5.5           # default
```

```bash
npm run web            # http://localhost:3200 — page, agent API, data API
npm test               # offline unit tests
npm run test:fork      # end to end on an Anvil fork of Pacific: deploy, dry run, sign, execute, compare
npm run test:contracts # 28 Solidity tests on a Pacific fork (forge, installed by npm)
```

Deploying your own Warden (SkillEngine's forge flow — the key comes from the environment, never from code):

```bash
cd contracts
forge script script/Deploy.s.sol --rpc-url pacific --private-key $PRIVATE_KEY --broadcast
```

## Layout

```
contracts/src/Warden.sol          the contract
contracts/test/Warden.t.sol       28 tests on a Pacific fork
contracts/src/test-doubles/       SimPermit2 + SimRunner: used only inside dry-run eth_calls, never deployed
lib/agent.js, lib/agent-openai.js the agent: tools, system prompt, Claude and OpenAI loops
lib/intent.js                     intents, Permit2 witness typed data, calldata
lib/simulate.js                   the pre-signature dry run and revert explanations
lib/reads.js, lib/chain.js        wallet, yields, quotes, payee checks — through the Chain MCP
lib/sources.js                    Docs MCP and SkillEngine
api/agent.js, api/data.js         the streaming agent API and the data API
public/                           the page (no framework)
```

## Notes

- The Chain MCP serves Pacific Mainnet, which is why Warden lives there and not on Atlantic.
- Exact swap quotes use the Pacific RPC with an `eth_call` state override: the Chain MCP's `eth_call` has no override parameter.
- The agent is not a financial advisor; it shows its numbers and their source, and the user decides.

MIT
