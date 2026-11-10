# Pharos Warden

**An AI agent for Pharos that can't make you lose more than you signed.**

Ask in plain words: *"pay 2 USDC to Ana and 1.5 USDC to Bruno"*, *"stake 10 PROS with Faroo"*, *"add liquidity to the 0.30% WPROS/USDC pool"*, *"is this transaction safe to sign?"*. The agent reads Pharos, decides and prepares one transaction. You sign its guarantees in your own wallet: *spend at most this, receive at least that, pay exactly these people*. The **Warden** contract then reverts the whole transaction if any guarantee fails. Before you sign anything on another dApp, Warden runs that dApp's transaction as you and tells you what it would really do.

- **Live dApp:** https://pharos-warden.vercel.app (opens on Atlantic Testnet; switch to Pacific Mainnet in the header), with the [Trade](https://pharos-warden.vercel.app/trade), [Network](https://pharos-warden.vercel.app/network), [Ecosystem](https://pharos-warden.vercel.app/ecosystem) and [News](https://pharos-warden.vercel.app/news) pages
- **Contract:** `0x58ad9DDF29D13328ceefAF70AFa42644E4D76766`, the same address on [Atlantic Testnet](https://atlantic.pharosscan.xyz/address/0x58ad9DDF29D13328ceefAF70AFa42644E4D76766) and [Pacific Mainnet](https://www.pharosscan.xyz/address/0x58ad9DDF29D13328ceefAF70AFa42644E4D76766)
- **Architecture:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Who it is for, and why

**It is for people who want an AI agent to handle their payments, swaps, staking and liquidity on Pharos without handing it their keys, and who shouldn't have to read calldata to stay safe.**

Agents are good at reading and deciding: which vault actually paid more this week, what a swap returns right now, whether an address is a look-alike of one you paid. They are not trustworthy enough to hold a wallet. A model can misread a pool, pick the wrong venue, or be talked into a bad trade. Warden splits the work:

| The agent | The contract |
|---|---|
| reads the chain, compares options, recommends, builds and dry-runs the transaction | pulls only what you signed, runs only allowlisted protocols, pays exactly who you signed, and **reverts unless you receive at least the minimum you signed** |

Each wallet also keeps its own **on-chain policy** in Warden: per-token limits per action and per day, the protocols allowed, approved payees, an expiry and a pause switch. The agent proposes the policy, and you sign it once.

Most losses do not happen inside a careful dApp. They happen when a user signs a drainer's approval or permit on some other site. So Warden's agent also works as a **wallet firewall**: it simulates other dApps' transactions, reads their signature requests, checks links, and finds and revokes risky approvals. These checks work before you connect a wallet; without one, the simulation runs from an empty address and says so.

## Two networks

| | Atlantic Testnet (688689), the default | Pacific Mainnet (1672) |
|---|---|---|
| Funds | test USDC, free from [faucet.circle.com](https://faucet.circle.com) (network "Pharos Testnet") | real |
| Guarded by Warden | USDC payments: one payee, or up to 10 in **one signature** | payments (USDC, WPROS), FaroSwap swaps, **FaroSwap V3 liquidity**, **Faroo staking**, USDC vaults (Morpho RockawayX, Morpho SharpByte, Avalon) |
| Also | wallet firewall, approvals, explainer, x402 data, news, ecosystem | the same, plus LP positions, RealFi / RWA positions, tx history |
| Chain reads | public RPC (the Chain MCP serves Pacific only) | **Pharos Chain MCP** |

Atlantic has no DEX or lending protocol, so its Warden allowlists no protocol and guards payments only. The contract is the same on both networks.

## What you can do

The page has a quick-action menu like ProsPilot's. Every item is a request to the agent.

| Ask | The agent does | Guarantee |
|---|---|---|
| "Pay 1 USDC to 0x… and 0.5 USDC to 0x…" | checks every payee (contract? never used? blacklisted? look-alike of someone you paid? broken checksum?), plus ProsPilot's wallet profile on Pacific | exactly these amounts to exactly these addresses, one signature, nothing else |
| "Stake 10 PROS with Faroo" (Pacific) | the realised 7-day stPROS yield, a wrap step when WPROS is short, a dry run | at least the previewed stPROS, straight to your wallet |
| "Add liquidity with 20 USDC, 0.30% pool, ±10%" (Pacific) | reads the four FaroSwap V3 pools, computes the other side, dry-runs the mint and sets the minimums from it | one more position NFT in **your** wallet, the pool takes at least the minimums, the rest comes back |
| "Show my LP positions" / "remove position #…" (Pacific) | range, in range or not, the tokens in it and the **exact** uncollected fees (simulated as the owner); a remove with minimums from a simulation | (the owner's own transaction) |
| "Swap 20 USDC to WPROS" (Pacific) | live FaroSwap quote, price impact, the pool price vs CoinGecko, a dry run | you receive ≥ the minimum WPROS and spend ≤ 20 USDC |
| "Deposit 50 USDC in the best vault" (Pacific) | realised 7-day APY from on-chain share prices, picks the venue, dry run | the shares / aUSDC land in your wallet, at least the minimum |
| "Is this safe to sign? to 0x… data 0x…" | decodes it and **runs it as you** against live state: tokens out and in, new allowances, would it fail | a verdict (do not sign / high risk / caution / looks OK) with the reasons |
| "Check this signature request: {…}" | reads Permit, Permit2, EIP-3009, Seaport and Warden typed data; flags a plain wallet as spender, unlimited amounts, no deadline, the wrong chain | the same verdict |
| "Is this link safe? https://…" | a static check (never visits it): official domain, typosquat by edit distance, homoglyphs, punycode, the "@" trick, free hosting, drainer paths | a verdict |
| "Scan my approvals" | live ERC-20 and Permit2 allowances: every known token × every known spender, plus anything you approved recently | a Revoke button for each one, which you sign |
| "Approve exactly 10 USDC for 0x…" / "how much can 0x… spend?" | exact amounts only; a plain wallet as spender is refused | (your own transaction) |
| "Score my wallet" | a 0–100 score: activity, holdings, protocol use, approval hygiene, account type, each with its on-chain evidence | n/a (read only) |
| "Show my RealFi positions" (Pacific) | Ember pAlpha, AquaFlux, Zona, OpenFi, R25 VRPC, TermMax, Janus Henderson / Anemoy, Faroo vaults; vault shares valued in their asset | n/a (read only) |
| "What happened in 0x…?" | the call, every decoded event, the fee, what it did to you, and why it failed (replayed on the block before) | n/a (read only) |
| "Buy the Pacific gas data over x402" | the paywall's 402, checked (our catalog only, Atlantic USDC, at most 0.01 USDC, the published payee) | you sign one exact EIP-3009 payment; the data and the settlement tx come back |
| "What's new on Pharos?" / "RWA market?" / "DeFi briefing" | official news, @pharos_network posts, Pharos Port campaigns, rwa.xyz figures, a Web3 briefing (through ProsPilot's API) | n/a (read only) |

And four pages beside the agent:
- **Trade:** PROS price, change, market cap and volume (CoinGecko), the price chart, and the price inside each FaroSwap pool against the market.
- **Network:** live health of both networks from the public RPC (height, block time, gas, TPS, recent blocks), the chain parameters, and daily Pacific charts.
- **Ecosystem:** the official Pharos Port directory, 43 active projects, searchable.
- **News:** blog, news, @pharos_network posts and live Pharos Port campaigns.

Every page ends in the agent.

## ProsPilot inside

The skills come from [ProsPilot](https://github.com/juhzinho/pharos-agent), our earlier Pharos agent: everything it does except bridges. In Warden they are rebuilt to check on chain instead of guessing:

| ProsPilot skill | In Warden | What is stronger |
|---|---|---|
| Add liquidity (FaroSwap V3) | `propose_add_liquidity` | guarded by Warden: the NFT goes straight to the user, and the minimums come from a dry run of the mint itself, not from float math |
| My LP positions | `lp_positions`, `propose_remove_liquidity` | exact uncollected fees by simulating `collect` as the owner; remove minimums from a simulation of the same multicall |
| Stake / unstake PROS (Faroo) | `propose_stake`, `propose_unstake`, `staking_info` | the stake is guarded (at least the previewed stPROS); yield realised from the share price; the 7-day unstake stated on the card |
| Send tokens | `propose_payment`, `propose_send_native` | up to 10 payees in **one** Warden signature, each paid exactly or none; every payee checked |
| Approve token / check allowance | `propose_approve`, `check_allowance` | exact amounts only, never to a plain wallet; Permit2 allowances too |
| Pre-sign risk check | `check_transaction` | the transaction is **simulated as the user** (SimProbe), so the verdict rests on real balance and allowance changes |
| Permit / drainer patterns | `check_signature` | Permit, Permit2, EIP-3009, Seaport and Warden's own witness each decoded, the spender looked up on chain |
| Link / scam scanner | `check_link` | ProsPilot's lists plus edit distance to every official domain, homoglyph folding and punycode decoding; never fetches the URL |
| Allowance checks | `scan_approvals`, `propose_revoke` | every known token × spender, Permit2, and the wallet's Approval events from any token |
| Explain tx | `explain_tx` | Warden's guarantee events decoded; Permit2's errors named; the revert replayed on the previous block |
| Swap safety | `quote_swap`, `propose_swap` | price impact on exact quotes, the pool price against CoinGecko |
| Wallet analysis / score | `wallet_overview`, `wallet_score` | USD totals; a score whose every part is read on chain now |
| RealFi positions | `realfi_positions` | ProsPilot's registry checked token by token on chain: 4 of its entries were wrong (3 AquaFlux tokens have 18 decimals, not 6; a Zona symbol differs), corrected from the contracts |
| Tx history, news, campaigns, RWA market, Web3 briefing | `tx_history`, `pharos_news`, `rwa_market`, `web3_briefing` | called live from ProsPilot's public API, agent to agent |
| Ecosystem Q&A | `ecosystem`, `docs_ask` | the official Pharos Port list (43 projects) and the Pharos Docs MCP |

Warden also asks ProsPilot directly, agent to agent: before a payment on Pacific, `check_payee` shows ProsPilot's wallet profile as a second opinion. Its data APIs feed the News and Network pages. Every call is read-only, and Warden goes on without it if ProsPilot does not answer.

## Requirements

| # | Requirement | How Warden meets it |
|---|---|---|
| 01 | Deployed on Pharos, a working UI anyone can open, contract addresses | Warden v2 at `0x58ad9DDF29D13328ceefAF70AFa42644E4D76766` on **Atlantic Testnet** (tx [`0xb290bc66…`](https://atlantic.pharosscan.xyz/tx/0xb290bc661ac97266de6c687a1bca341aff0342f1ac023cb66b8b770f110ee877), block 32,582,416) and **Pacific Mainnet** (tx [`0x4a146d67…`](https://www.pharosscan.xyz/tx/0x4a146d678df0786710097d0ad868aa8b652890214e6856ab5326a4f066cac864), block 22,670,035), see [docs/deployment.json](docs/deployment.json). The UI at https://pharos-warden.vercel.app needs no login: questions, checks and the pages work before you connect a wallet |
| 02 | The agent is central and uses ≥ 2 Pharos AI tools | The agent *is* the product: every action, check and page leads to it. It uses **all four** tools the task names: the **Chain MCP** (Pacific reads), the **Developer Docs MCP** (token registry, questions with sources), the **SkillEngine** (write rules, network and token config, forge deploy flow) and **x402** (it buys data per call, paid by the user's signature) |
| 03 | A clear user problem; the README says who and why | [Who it is for, and why](#who-it-is-for-and-why) |
| 04 | Safe: no keys in the agent or the frontend, fund moves signed by the user or behind policy limits, error handling | No private key anywhere in the app. Every fund move is signed in the user's wallet **and** bounded by their on-chain limits **and** guaranteed by the contract (or, for the few plain transactions, shown and checked first). Dry run before signing; refusals explained in words; [Safety](#safety) |
| 05 | Open source, setup instructions, a short architecture write-up | This repo (MIT), [Run it](#run-it), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 06 | Demo video of a real user flow | linked in the submission |

## Contracts

| | Atlantic Testnet (688689) | Pacific Mainnet (1672) |
|---|---|---|
| **Warden v2** (this project) | `0x58ad9DDF29D13328ceefAF70AFa42644E4D76766` | `0x58ad9DDF29D13328ceefAF70AFa42644E4D76766` |
| Protocols allowlisted | none (payments only) | FaroSwap, Morpho RockawayX USDC, Morpho SharpByte USDC, Avalon USDC, Faroo stPROS, FaroSwap V3 liquidity |
| Permit2 (canonical) | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| USDC (token registry) | `0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B` (Circle testnet USDC) | `0xC879C018dB60520F4355C26eD1a6D572cdAC1815` |
| WPROS | n/a | `0x52C48d4213107b20bC583832b0d951FB9CA8F0B0` |
| FaroSwap DODORouteProxy · DODOApprove | n/a | `0xA5cA5Fbe34e444F366B373170541ec6902b0F75c` · `0xBF105f4ffBD3825f5433d074008B9A76237d849c` |
| FaroSwap V3 positions (NPM) · factory | n/a | `0xc0479219f4FebA5A668cFF71BF96f4FFE124c3ab` · `0x2c90CcB0b989afA2433F499698451a25744A552b` |
| Faroo stPROS (ERC-4626, asset WPROS) | n/a | `0x6b0A44c64190279f7034b77c13a566E914FE5Ec4` |
| Morpho Vault V2 RockawayX · SharpByte | n/a | `0x047cD0a91E9B92ED979189a6C8A120bf280f02E5` · `0x15c25ED222fc498f672af5c3adb5ED0a96E1AFf1` |
| Avalon (Aave V3) pool · aUSDC | n/a | `0xD9B9E4F8257bFf9B1415d74c1EF88d8057f60cBa` · `0xE2ec2F3933aD2f83DE9a9dDa844558354384e87D` |

Warden has no owner. Its allowlist is fixed in the constructor, and nobody can change it. That is why adding Faroo and FaroSwap V3 meant a new deployment (v2). v1 (`0x02fa5869…1418`) is superseded, and its record is kept in `docs/deployment.json`.

## Proof

On **Atlantic Testnet**, with a test wallet (`0x1fe2…48Cc`) and Warden v2:

1. policy, 5 USDC per action and 20 per day: [`0xc263dcdd…`](https://atlantic.pharosscan.xyz/tx/0xc263dcdd13a877a512b5d91ca91791ca480f3219ac5e6e0b4f953355362d2864)
2. Permit2 approval for exactly 0.4 USDC: [`0x304777da…`](https://atlantic.pharosscan.xyz/tx/0x304777da9e296a9b4410db44c8caf0cae02ce943e1ae172ef4fa0731536d18ba)
3. one signed Warden intent paying 0.25 USDC and 0.15 USDC to two addresses: [`0x21986179…`](https://atlantic.pharosscan.xyz/tx/0x219861794d87800dd77b1bd4664b37abe525bf4096b64aaa965c03e3c99fcda4). The dry run said −0.4 USDC; each payee received exactly its amount; `Paid` events for both; no allowance left open afterwards
4. a Warden intent with a bad signature, which failed as it must: [`0x19b75778…`](https://atlantic.pharosscan.xyz/tx/0x19b757782f3ee719c37f77bfc3ef126b45263c1dedd013e85170ecd83fa7a30c). `explain_tx` replays it and says *"the signature is not valid for this intent (Permit2 rejected it)"*
5. a risky approval (1 USDC to a plain wallet): [`0x712b55c7…`](https://atlantic.pharosscan.xyz/tx/0x712b55c78aa2ca2cf5a7cb09370d875f281c7caa9e2c8e9370193fe336376bad), found by `scan_approvals` and marked critical, then revoked with the transaction Warden prepared: [`0xab3ca12b…`](https://atlantic.pharosscan.xyz/tx/0xab3ca12b8ccfef5d325be12478e9f15515007e61f896acee3fa7a76cf9c11612)
6. an x402 purchase (Pacific gas market, 0.002 USDC), paid with the user's EIP-3009 signature and settled on Atlantic: [`0x93ba1c5a…`](https://atlantic.pharosscan.xyz/tx/0x93ba1c5a3b8abb1aa4136f3e0b8989388d7d8d0958e6b3c6d6f86729f08e27a5)

On a **fork of Pacific Mainnet** (`npm run test:fork`), Warden v2 deployed with the same script as mainnet, 12 steps, each real result equal to its dry run:
- swap 20 USDC → WPROS;
- deposit into Morpho, supply to Avalon, redeem from Morpho;
- pay 5 USDC;
- **stake 5 WPROS with Faroo**;
- **add FaroSwap V3 liquidity** (the position read back: ~2 USDC in it);
- **remove the position** (the tokens back, above the simulated minimums);
- two refusals explained before signing.

## Safety

- **No keys.** The agent and the page never see a private key. The page asks the user's own wallet (EIP-1193, EIP-6963 discovery) to sign typed data and send transactions, and it checks that the wallet really is on the card's network first.
- **Exact inputs.** Funds move only through Permit2 signature transfers: exact tokens, exact amounts, a single-use nonce, a deadline. The user never approves Warden itself, and the Permit2 approval the page suggests is for the exact amount.
- **Guarantees signed and enforced.** The Permit2 witness *is* the intent (EIP-712). The wallet shows the minimums and payments, and changing any of them invalidates the signature. Warden checks every minimum against the user's real balance (tokens, vault shares, the LP NFT) and reverts otherwise.
- **Policy limits on chain.** Per-token limits per action and per day, protocol opt-in, payees-only mode, expiry, pause. A token without a limit cannot be spent through Warden.
- **Allowlisted protocols, no token or NFT tricks.** Calls go only to the fixed allowlist. Token-moving selectors (`transfer`, `approve`, `permit`…), NFT moves (`safeTransferFrom`, `setApprovalForAll`) and batch calls (`multicall`) are refused even on allowlisted contracts. Approvals are reset to zero, and leftovers are returned.
- **Dry run before signing.** The exact transaction runs against live state first (state-override `eth_call`). Any assumption is listed on the card, and so is the network fee.
- **Plain transactions are few and shown.** Unstaking (a 7-day Faroo request), removing liquidity (the NFT owner's call), revokes, exact approvals and native sends are ordinary transactions the user signs. Each is prepared by code, checked first (payee check, spender check, simulation), and labelled on the card.
- **x402 within bounds.** The server pays only resources of our catalog, in Atlantic USDC, up to 0.01 USDC per call, to the paywall's published payee. It recovers the signer and checks that it is the connected wallet before relaying.
- **Checks before signing elsewhere.** Other dApps' transactions are simulated as the user; signature requests are decoded; links are checked; risky approvals can be revoked.
- **Network warning** on every card: real funds on Pacific (SkillEngine's rule for mainnet writes), test funds on Atlantic.
- **Robust inputs and errors.** Every tool input is validated against its schema. Reverts are decoded into sentences ("150 USDC is above your per-action limit of 100 USDC"). MCP and RPC calls are retried briefly, bursts are throttled, and public data is cached for a few seconds. The conversation is HMAC-sealed and tied to one network, and visitors are rate-limited. The server never fetches a URL a user or a model supplies.

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
npm run web            # http://localhost:3200: the agent page, the four pages, the agent / data / x402 APIs
npm test               # 14 offline unit tests
npm run test:fork      # 12 steps end to end on an Anvil fork of Pacific: deploy, dry run, sign, execute, compare
npm run test:contracts # 31 Solidity tests on a Pacific fork (forge, installed by npm)
```

Deploying your own Warden (SkillEngine's forge flow; the key comes from the environment, never from code):

```bash
cd contracts
forge script script/DeployAtlantic.s.sol --rpc-url atlantic --private-key $PRIVATE_KEY --broadcast   # payments only
forge script script/Deploy.s.sol --rpc-url pacific --private-key $PRIVATE_KEY --broadcast            # with the Pacific protocols
```

Refreshing the data taken from other sources: `node scripts/build-realfi.mjs` (RealFi registry, checked on chain), `node scripts/build-ecosystem.mjs` (Pharos Port directory), `node scripts/build-links.mjs` (link-scanner lists).

## Layout

```
contracts/src/Warden.sol          the contract
contracts/test/Warden.t.sol       31 tests on a Pacific fork
contracts/src/test-doubles/       SimPermit2, SimRunner, SimProbe: used only inside eth_call simulations, never deployed
lib/config.js                     the two networks; each request runs inside one (withNetwork)
lib/agent.js, lib/agent-openai.js the agent: 38 tools on Pacific, 24 on Atlantic; system prompt; OpenAI and Claude loops
lib/intent.js                     intents, Permit2 witness typed data, calldata
lib/simulate.js                   the pre-signature dry run and revert explanations
lib/defi.js                       FaroSwap V3 liquidity and positions, Faroo staking, RealFi positions, allowances
lib/guard.js                      check_transaction, check_signature, scan_approvals, revokes, explain_tx
lib/links.js, lib/score.js        link scanner, wallet score
lib/x402.js                       x402 purchases signed by the user
lib/reads.js, lib/chain.js        wallet, yields, quotes, swap safety, payee checks; Chain MCP and RPC readers
lib/sources.js                    Docs MCP and SkillEngine
lib/prospilot.js, lib/market.js   ProsPilot's API (agent to agent), CoinGecko
api/agent.js, api/data.js, api/x402.js   the streaming agent API, the data API, the x402 relay
public/                           the agent page and the Trade, Network, Ecosystem and News pages (no framework)
```

## Notes

- The Chain MCP serves Pacific Mainnet only. On Atlantic, Warden reads the public RPC, and every read is labelled as such on the page.
- Simulations (dry runs, quotes, transaction checks, LP fees) use the RPC's `eth_call` state overrides and plain `eth_call`s, because the Chain MCP's `eth_call` takes no overrides.
- On Atlantic, SkillEngine's `tokens.json` lists a different USDC (`0xE0BE08c7…`) from the official token registry. Warden uses the registry's Circle USDC (the one the faucet gives), and `verify_tokens` reports the disagreement instead of hiding it.
- Source verification on Pharosscan: the explorer's verification backend answered `503 no healthy upstream` on both networks while this was built; `node scripts/verify-explorer.js atlantic|pacific` submits the exact build inputs when it is back.
- The agent is not a financial advisor. It shows its numbers and their sources, and the user decides.

MIT
