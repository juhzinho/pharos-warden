# Pharos Warden

**An AI agent for Pharos that can't make you lose more than you signed.**

Ask in plain words: *"pay 2 USDC to Ana and 1.5 USDC to Bruno"*, *"is this transaction safe to sign?"*, *"swap 20 USDC to WPROS"*, *"put 50 USDC where it earns most"*. The agent reads Pharos, decides and prepares one transaction. You sign its guarantees in your own wallet: *spend at most this, receive at least that, pay exactly these people*. The **Warden** contract then reverts the whole transaction if any guarantee fails. Before you sign anything on another dApp, Warden runs that dApp's transaction as you and tells you what it would really do.

- **Live dApp:** https://pharos-warden.vercel.app (opens on Atlantic Testnet; switch to Pacific Mainnet in the header)
- **Contract:** `0x02fa5869a0Abe62C97c1D1c65df878783Dc11418`, the same address on [Atlantic Testnet](https://atlantic.pharosscan.xyz/address/0x02fa5869a0Abe62C97c1D1c65df878783Dc11418) and [Pacific Mainnet](https://www.pharosscan.xyz/address/0x02fa5869a0Abe62C97c1D1c65df878783Dc11418)
- **Architecture:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Who it is for, and why

**It is for people who want an AI agent to handle payments and DeFi on Pharos without handing it their keys, and who shouldn't have to read calldata to stay safe.**

Agents are good at reading and deciding: which vault actually paid more this week, what a swap returns right now, whether an address is a look-alike of one you paid. They are not trustworthy enough to hold a wallet. A model can misread a pool, pick the wrong venue, or be talked into a bad trade. Warden splits the work:

| The agent | The contract |
|---|---|
| reads the chain, compares options, recommends, builds and dry-runs the transaction | pulls only what you signed, runs only allowlisted protocols, pays exactly who you signed, and **reverts unless you receive at least the minimum you signed** |

Each wallet also keeps its own **on-chain policy** in Warden: per-token limits per action and per day, the protocols allowed, approved payees, an expiry and a pause switch. The agent proposes the policy, and you sign it once.

Most losses do not happen inside a careful dApp. They happen when a user signs a drainer's approval or permit on some other site. So Warden's agent also checks what other dApps ask you to sign: it simulates their transactions, reads their signature requests, and finds and revokes risky approvals.

## Two networks

| | Atlantic Testnet (688689), the default | Pacific Mainnet (1672) |
|---|---|---|
| Funds | test USDC, free from [faucet.circle.com](https://faucet.circle.com) (network "Pharos Testnet") | real |
| Guarded actions | USDC payments: one payee, or up to 10 in **one signature** | payments, FaroSwap swaps, USDC vaults (Morpho RockawayX, Morpho SharpByte, Avalon) |
| Wallet safety | transaction check, signature check, approval scan and revoke, transaction explainer | same |
| Chain reads | public RPC (the Chain MCP serves Pacific only) | **Pharos Chain MCP** |

Atlantic has no DEX or lending protocol, so its Warden allowlists no protocol and guards payments only. The contract is the same on both networks.

## What you can do

| Ask | The agent does | Guarantee |
|---|---|---|
| "Pay 1 USDC to 0x… and 0.5 USDC to 0x…" | checks every payee (contract? never used? blacklisted? look-alike of someone you paid? broken checksum?), plus ProsPilot's wallet profile on Pacific | exactly these amounts to exactly these addresses, one signature, nothing else |
| "Is this safe to sign? to 0x… data 0x…" | decodes it and **runs it as you** against live state: tokens out and in, new allowances, would it fail | a verdict (do not sign / high risk / caution / looks OK) with the reasons |
| "Check this signature request: {…}" | reads Permit, Permit2, EIP-3009, Seaport and Warden typed data; flags a plain wallet as spender, unlimited amounts, no deadline, the wrong chain | the same verdict |
| "Scan my approvals" | live ERC-20 and Permit2 allowances: every known token × every known spender, plus anything you approved recently | a Revoke button for each one, which you sign |
| "What happened in 0x…?" | the call, every decoded event, the fee, what it did to you, and why it failed (replayed on the block before) | n/a (read only) |
| "Swap 20 USDC to WPROS" (Pacific) | live FaroSwap quote, price impact, the pool price vs CoinGecko, then a dry run | you receive ≥ the minimum WPROS and spend ≤ 20 USDC |
| "Deposit 50 USDC in the best vault" (Pacific) | realised 7-day APY from on-chain share prices, picks the venue, dry run | the shares / aUSDC land in **your** wallet, at least the minimum |
| "Set up my limits" / "pause" | proposes a policy that fits | enforced on every execution |

## ProsPilot inside

The wallet-safety skills come from [ProsPilot](https://github.com/juhzinho/pharos-agent), our earlier Pharos agent. In Warden they are rebuilt to check on chain instead of guessing:

| ProsPilot skill | In Warden | What is stronger |
|---|---|---|
| pre-sign risk (calldata patterns) | `check_transaction` | the transaction is **simulated as the user** (SimProbe, an `eth_call` state override), so the verdict rests on real balance and allowance changes, not on the selector alone |
| permit / drainer patterns | `check_signature` | Permit, Permit2 (allowance and transfer), EIP-3009, Seaport and Warden's own witness are each decoded, with the spender looked up on chain |
| allowance check (one spender) | `scan_approvals` + `propose_revoke` | every known token × every known spender, Permit2's internal allowances, and Approval events of the wallet from any token |
| transaction explainer | `explain_tx` | Warden's guarantee events decoded; the revert reason replayed on the previous block; both networks |
| swap safety | `quote_swap` / `propose_swap` | price impact measured on exact quotes, plus the pool price checked against CoinGecko |
| gas estimate | every intent card | the fee comes from the dry run's own gas |
| batch transfers | `propose_payment` | up to 10 payees in **one** Warden signature, each paid exactly or none |

Warden also asks ProsPilot directly, agent to agent: before a payment on Pacific, `check_payee` calls ProsPilot's public Skill API (`/api/skill/wallet-profile`) and shows its wallet profile as a second opinion. It is read-only, and Warden goes on without it if ProsPilot does not answer.

## Requirements

| # | Requirement | How Warden meets it |
|---|---|---|
| 01 | Deployed on Pharos, a working UI anyone can open, contract addresses | Warden on **Atlantic Testnet** (tx [`0x7b9e89e6…`](https://atlantic.pharosscan.xyz/tx/0x7b9e89e669edcad5e521ddb5790499a87c05776757be7af864d7d93e8c78cc6b), block 32,572,244) and **Pacific Mainnet** (tx [`0x46478472…`](https://www.pharosscan.xyz/tx/0x4647847216c5619ab9e109a0dd1ce13d443b96d3a2a76bc5dc802642b4c2944b), block 22,647,574), both at `0x02fa5869a0Abe62C97c1D1c65df878783Dc11418` ([docs/deployment.json](docs/deployment.json)). The UI at https://pharos-warden.vercel.app needs no login: questions and checks work before you connect a wallet |
| 02 | The agent is central and uses ≥ 2 Pharos AI tools | The agent *is* the product: it reads, decides and prepares every action. It uses the **Chain MCP** (Pacific: balances, calls at past blocks, logs, receipts, transactions), the **Developer Docs MCP** (token registry page, questions with sources) and the **SkillEngine** (its write rules, its network and token config, its forge deploy flow) |
| 03 | A clear user problem; the README says who and why | [Who it is for, and why](#who-it-is-for-and-why) |
| 04 | Safe: no keys in the agent or the frontend, fund moves signed by the user or behind policy limits, error handling | No private key anywhere in the app. Every fund move is signed in the user's wallet **and** bounded by their on-chain limits **and** guaranteed by the contract. Dry run before signing; refusals explained in words; [Safety](#safety) |
| 05 | Open source, setup instructions, a short architecture write-up | This repo (MIT), [Run it](#run-it), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 06 | Demo video of a real user flow | linked in the submission |

## Contracts

| | Atlantic Testnet (688689) | Pacific Mainnet (1672) |
|---|---|---|
| **Warden** (this project) | `0x02fa5869a0Abe62C97c1D1c65df878783Dc11418` | `0x02fa5869a0Abe62C97c1D1c65df878783Dc11418` |
| Protocols allowlisted | none (payments only) | FaroSwap, Morpho RockawayX USDC, Morpho SharpByte USDC, Avalon USDC |
| Permit2 (canonical) | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| USDC (token registry) | `0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B` (Circle testnet USDC) | `0xC879C018dB60520F4355C26eD1a6D572cdAC1815` |
| WPROS | n/a | `0x52C48d4213107b20bC583832b0d951FB9CA8F0B0` |
| FaroSwap DODORouteProxy · DODOApprove | n/a | `0xA5cA5Fbe34e444F366B373170541ec6902b0F75c` · `0xBF105f4ffBD3825f5433d074008B9A76237d849c` |
| Morpho Vault V2 RockawayX · SharpByte | n/a | `0x047cD0a91E9B92ED979189a6C8A120bf280f02E5` · `0x15c25ED222fc498f672af5c3adb5ED0a96E1AFf1` |
| Avalon (Aave V3) pool · aUSDC | n/a | `0xD9B9E4F8257bFf9B1415d74c1EF88d8057f60cBa` · `0xE2ec2F3933aD2f83DE9a9dDa844558354384e87D` |

Warden has no owner. Its allowlist is fixed in the constructor, and nobody can change it.

## Proof on Atlantic

A batch payment run end to end on Atlantic Testnet with a test wallet (`0x1fe2…48Cc`):

1. policy, 5 USDC per action and 20 per day: [`0xa37997fc…`](https://atlantic.pharosscan.xyz/tx/0xa37997fc4c6c0d87e0f787c6ea971cded49b521d915c8e3cf8733c172b62cccc)
2. Permit2 approval for exactly 0.4 USDC: [`0x376eb783…`](https://atlantic.pharosscan.xyz/tx/0x376eb78319bf53e214b1454a62a33104ffaf5fed03f806c426fb453b5e034f5d)
3. one signed Warden intent paying 0.25 USDC and 0.15 USDC to two addresses: [`0x46adb742…`](https://atlantic.pharosscan.xyz/tx/0x46adb7428eab8b482f26a7f053b4f81cbfaf508719ebdf2d0854870293d5d158). The dry run said −0.4 USDC; each payee received exactly its amount; `Paid` events for both; no allowance left open afterwards

## Safety

- **No keys.** The agent and the page never see a private key. The page asks the user's own wallet (EIP-1193, EIP-6963 discovery) to sign typed data and send transactions, and it checks that the wallet really is on the card's network first.
- **Exact inputs.** Funds move only through Permit2 signature transfers: exact tokens, exact amounts, a single-use nonce, a deadline. The user never approves Warden itself, and the Permit2 approval the page suggests is for the exact amount.
- **Guarantees signed and enforced.** The Permit2 witness *is* the intent (EIP-712). The wallet shows the minimums and payments, and changing any of them invalidates the signature. Warden checks every minimum against the user's real balance and reverts otherwise.
- **Policy limits on chain.** Per-token limits per action and per day, protocol opt-in, payees-only mode, expiry, pause. A token without a limit cannot be spent through Warden.
- **Allowlisted protocols, no token tricks.** Calls go only to the fixed allowlist. Token-moving selectors (`transfer`, `approve`, `permit`…) are refused even on allowlisted contracts, because vault shares are tokens too. Approvals are reset to zero, and leftovers are returned.
- **Dry run before signing.** The exact transaction runs against live state first (state-override `eth_call`). Any assumption is listed on the card, and so is the network fee.
- **Checks before paying.** Contract or wallet, a never-used address, the USDC blacklist, a token or protocol contract, a look-alike of a recent counterparty, a broken checksum, and ProsPilot's profile on Pacific.
- **Checks before signing elsewhere.** Other dApps' transactions are simulated as the user; signature requests are decoded; risky approvals can be revoked.
- **Network warning** on every card: real funds on Pacific (SkillEngine's rule for mainnet writes), test funds on Atlantic.
- **Robust inputs and errors.** Every tool input is validated against its schema. Reverts are decoded into sentences ("150 USDC is above your per-action limit of 100 USDC"). MCP and RPC timeouts and rate limits are retried briefly, and bursts are throttled. The conversation is HMAC-sealed and tied to one network, and visitors are rate-limited.

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
npm run web            # http://localhost:3200: page, agent API, data API
npm test               # 14 offline unit tests
npm run test:fork      # end to end on an Anvil fork of Pacific: deploy, dry run, sign, execute, compare
npm run test:contracts # 28 Solidity tests on a Pacific fork (forge, installed by npm)
```

Deploying your own Warden (SkillEngine's forge flow; the key comes from the environment, never from code):

```bash
cd contracts
forge script script/DeployAtlantic.s.sol --rpc-url atlantic --private-key $PRIVATE_KEY --broadcast   # payments only
forge script script/Deploy.s.sol --rpc-url pacific --private-key $PRIVATE_KEY --broadcast            # with the Pacific protocols
```

## Layout

```
contracts/src/Warden.sol          the contract
contracts/test/Warden.t.sol       28 tests on a Pacific fork
contracts/src/test-doubles/       SimPermit2, SimRunner, SimProbe: used only inside eth_call simulations, never deployed
lib/config.js                     the two networks; each request runs inside one (withNetwork)
lib/agent.js, lib/agent-openai.js the agent: tools per network, system prompt, OpenAI and Claude loops
lib/intent.js                     intents, Permit2 witness typed data, calldata
lib/simulate.js                   the pre-signature dry run and revert explanations
lib/guard.js                      check_transaction, check_signature, scan_approvals, revokes, explain_tx
lib/reads.js, lib/chain.js        wallet, yields, quotes, swap safety, payee checks; Chain MCP and RPC readers
lib/sources.js                    Docs MCP and SkillEngine
lib/prospilot.js, lib/market.js   ProsPilot's Skill API (second opinion), CoinGecko PROS price
api/agent.js, api/data.js         the streaming agent API and the data API
public/                           the page (no framework)
```

## Notes

- The Chain MCP serves Pacific Mainnet only. On Atlantic, Warden reads the public RPC, and every read is labelled as such on the page.
- Simulations (dry runs, quotes, transaction checks) use the RPC's `eth_call` state overrides, because the Chain MCP's `eth_call` takes none.
- On Atlantic, SkillEngine's `tokens.json` lists a different USDC (`0xE0BE08c7…`) from the official token registry. Warden uses the registry's Circle USDC (the one the faucet gives), and `verify_tokens` reports the disagreement instead of hiding it.
- Source verification on Pharosscan: the explorer's verification backend answered `503 no healthy upstream` on both networks at the time of writing; `node scripts/verify-explorer.js atlantic|pacific` submits the exact build inputs when it is back.
- The agent is not a financial advisor. It shows its numbers and their sources, and the user decides.

MIT
