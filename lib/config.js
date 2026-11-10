import { AsyncLocalStorage } from "node:async_hooks";
import { getAddress, parseAbi } from "viem";

// Warden runs on two Pharos networks. Every address below was checked on chain:
// - Pacific Mainnet (1672): USDC and WPROS from the official token registry (docs.pharos.xyz/getting-started/
//   token-registry, also SkillEngine's assets/tokens.json); FaroSwap's DODORouteProxy, UniV3 adapter, 0.01%
//   WPROS/USDC pool and DODOApprove (read from the proxy); Morpho Vault V2 USDC vaults RockawayX and SharpByte
//   (asset() = USDC); Avalon (Aave V3) pool and its USDC aToken (aToken.POOL() = the pool).
// - Atlantic Testnet (688689): USDC = Circle's testnet USDC from the token registry (FiatToken: EIP-3009,
//   isBlacklisted). Atlantic has no DEX or lending protocol, so its Warden guards payments only.
// - Permit2: the canonical deployment, on both.
// Storage slots (balance / allowance mappings) were found with eth_call state-override probes; they are used only
// to dry-run a plan for a wallet that has not approved yet.
//
// Each request runs inside one network (`withNetwork`); `net()` returns it. Scripts and tests default to Pacific
// (WARDEN_NETWORK overrides).

export const DOCS_MCP_URL = "https://docs.pharos.xyz/~gitbook/mcp";
export const CHAIN_MCP_URL = "https://mcp.pharos.xyz/mcp";
export const TOKEN_REGISTRY_URL = "https://docs.pharos.xyz/getting-started/token-registry";
export const PERMIT2 = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");

const env = (k) => globalThis.process?.env?.[k];
/**
 * Warden v2 (Faroo staking + FaroSwap V3 liquidity in the Pacific allowlist, NFT moves and batch calls refused): the
 * same deployer at nonce 1 on both networks gives the same address (docs/deployment.json). WARDEN_ADDRESS overrides
 * it (a fork); WARDEN_PACIFIC keeps v1 on Pacific until v2 is deployed there.
 */
const WARDEN_V2 = "0x58ad9DDF29D13328ceefAF70AFa42644E4D76766";
const WARDEN_ADDRESS = getAddress(env("WARDEN_ADDRESS") ?? WARDEN_V2);
const WARDEN_PACIFIC = getAddress(env("WARDEN_ADDRESS") ?? env("WARDEN_PACIFIC") ?? "0x02fa5869a0Abe62C97c1D1c65df878783Dc11418");

export const NETWORKS = {
  atlantic: {
    key: "atlantic",
    name: "Pharos Atlantic Testnet",
    short: "Atlantic Testnet",
    chainId: 688689,
    native: "PHRS",
    testnet: true,
    rpc: env("ATLANTIC_RPC_URL") ?? "https://atlantic.dplabs-internal.com",
    explorer: "https://atlantic.pharosscan.xyz",
    chainSource: "rpc", // the Chain MCP serves Pacific only
    skillEngineKey: "atlantic-testnet",
    blockTime: 1.58, // seconds, measured over 50,000 blocks on 2026-11-10
    warden: WARDEN_ADDRESS,
    deployBlock: 32_582_416,
    tokens: {
      USDC: { symbol: "USDC", name: "USDC (Circle testnet)", address: getAddress("0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B"), decimals: 6, balanceSlot: 9n, allowanceSlot: 10n },
    },
    faroswap: null,
    faroswapV3: null,
    protocols: [],
    faucet: "https://faucet.circle.com",
  },
  pacific: {
    key: "pacific",
    name: "Pharos Pacific Mainnet",
    short: "Pacific Mainnet",
    chainId: 1672,
    native: "PROS",
    testnet: false,
    rpc: env("PACIFIC_RPC_URL") ?? "https://rpc.pharos.xyz",
    explorer: "https://www.pharosscan.xyz",
    chainSource: "mcp",
    skillEngineKey: "mainnet",
    blockTime: 0.94, // seconds, measured over 50,000 blocks on 2026-11-10
    warden: WARDEN_PACIFIC,
    deployBlock: 22_647_574,
    tokens: {
      USDC: { symbol: "USDC", name: "USDC", address: getAddress("0xC879C018dB60520F4355C26eD1a6D572cdAC1815"), decimals: 6, balanceSlot: 9n, allowanceSlot: 10n },
      WPROS: { symbol: "WPROS", name: "Wrapped PROS", address: getAddress("0x52C48d4213107b20bC583832b0d951FB9CA8F0B0"), decimals: 18, balanceSlot: 3n, allowanceSlot: 4n },
    },
    faroswap: {
      routeProxy: getAddress("0xA5cA5Fbe34e444F366B373170541ec6902b0F75c"),
      dodoApprove: getAddress("0xBF105f4ffBD3825f5433d074008B9A76237d849c"),
      adapter: getAddress("0x4fD44181839D24e7C8f4D1B9288379109Ec25FAE"),
      pool: getAddress("0x912c9aDe24D44d8922f0866D8Dcb079f1363f647"),
      poolFee: 100, // 0.01%
    },
    /** Protocol ids are the bit positions in a user's Warden policy (`setProtocols(mask)`). */
    protocols: [
      { id: 0, key: "faroswap", name: "FaroSwap", kind: "dex" },
      { id: 1, key: "rockawayx", name: "Morpho RockawayX USDC", kind: "morpho-vault-v2", vault: getAddress("0x047cD0a91E9B92ED979189a6C8A120bf280f02E5"), symbol: "roxUSDC", decimals: 18, balanceSlot: 12n, allowanceSlot: 13n },
      { id: 2, key: "sharpbyte", name: "Morpho SharpByte USDC", kind: "morpho-vault-v2", vault: getAddress("0x15c25ED222fc498f672af5c3adb5ED0a96E1AFf1"), symbol: "sbUSDC-ph-eco", decimals: 18, balanceSlot: 12n, allowanceSlot: 13n },
      { id: 3, key: "avalon", name: "Avalon USDC", kind: "aave-v3", pool: getAddress("0xD9B9E4F8257bFf9B1415d74c1EF88d8057f60cBa"), aToken: getAddress("0xE2ec2F3933aD2f83DE9a9dDa844558354384e87D"), symbol: "aPharosUSDC", decimals: 6, balanceSlot: null, allowanceSlot: 53n }, // aToken balances are scaled: no balance override
      // Faroo liquid staking: ERC-4626, asset() = WPROS; unstaking is a 7-day request, so only staking runs through Warden
      { id: 4, key: "faroo", name: "Faroo stPROS", kind: "erc4626-stake", vault: getAddress("0x6b0A44c64190279f7034b77c13a566E914FE5Ec4"), asset: "WPROS", symbol: "stPROS", decimals: 18, balanceSlot: null, allowanceSlot: null },
      // FaroSwap V3 liquidity: positions are NFTs of the NonfungiblePositionManager, minted straight to the user
      { id: 5, key: "faroswap_lp", name: "FaroSwap V3 liquidity", kind: "v3-lp" },
    ],
    faroswapV3: {
      npm: getAddress("0xc0479219f4FebA5A668cFF71BF96f4FFE124c3ab"),
      factory: getAddress("0x2c90CcB0b989afA2433F499698451a25744A552b"),
      // factory.getPool(WPROS, USDC, fee), read on chain; WPROS is token0 in all four
      pools: {
        100: getAddress("0x912c9aDe24D44d8922f0866D8Dcb079f1363f647"),
        500: getAddress("0x9e1Ec11D25F65aE5e7f9aAaA6f73b41eb4df651D"),
        3000: getAddress("0x4146D192Da6428c9e1C243D2A953c625B5765623"),
        10000: getAddress("0xfc5f8974a7E94504f8D3aC20FBDC67daDff75049"),
      },
    },
  },
};
export const DEFAULT_NETWORK = "atlantic"; // the page opens on the testnet: free to try

const store = new AsyncLocalStorage();
/** Runs `fn` with `key` as the current network. */
export const withNetwork = (key, fn) => {
  const n = NETWORKS[key];
  if (!n) throw new Error(`unknown network ${key}`);
  return store.run(n, fn);
};
/** The current network (Pacific outside a request, unless WARDEN_NETWORK says otherwise). */
export const net = () => store.getStore() ?? NETWORKS[env("WARDEN_NETWORK") ?? "pacific"];
export const protocolByKey = (key) => net().protocols.find((p) => p.key === key);
export const allProtocolsMask = () => net().protocols.reduce((m, p) => m | (1 << p.id), 0);

export const ABI = {
  erc20: parseAbi([
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function transfer(address to, uint256 amount) returns (bool)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "event Transfer(address indexed from, address indexed to, uint256 value)",
  ]),
  wpros: parseAbi(["function deposit() payable", "function withdraw(uint256 wad)"]),
  routeProxy: parseAbi([
    "function mixSwap(address fromToken, address toToken, uint256 fromTokenAmount, uint256 expReturnAmount, uint256 minReturnAmount, address[] mixAdapters, address[] mixPairs, address[] assetTo, uint256 directions, bytes[] moreInfos, bytes feeData, uint256 deadLine) payable returns (uint256)",
  ]),
  vaultV2: parseAbi([
    "function asset() view returns (address)",
    "function totalAssets() view returns (uint256)",
    "function totalSupply() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function convertToAssets(uint256 shares) view returns (uint256)",
    "function previewDeposit(uint256 assets) view returns (uint256)",
    "function previewRedeem(uint256 shares) view returns (uint256)",
    "function deposit(uint256 assets, address onBehalf) returns (uint256 shares)",
    "function redeem(uint256 shares, address receiver, address onBehalf) returns (uint256 assets)",
  ]),
  aavePool: parseAbi([
    "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
    "function withdraw(address asset, uint256 amount, address to) returns (uint256)",
  ]),
  permit2: parseAbi([
    "function nonceBitmap(address owner, uint256 wordPos) view returns (uint256)",
    "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
    "function DOMAIN_SEPARATOR() view returns (bytes32)",
  ]),
  warden: parseAbi([
    "struct Approval { address token; address spender; uint256 amount; }",
    "struct Call { address target; bytes data; }",
    "struct Out { address token; uint256 minDelta; }",
    "struct Pay { address token; address to; uint256 amount; }",
    "struct Intent { address user; Approval[] approvals; Call[] calls; Out[] outs; Pay[] pays; uint256 deadline; bytes32 planId; }",
    "struct TokenPermissions { address token; uint256 amount; }",
    "struct PermitBatchTransferFrom { TokenPermissions[] permitted; uint256 nonce; uint256 deadline; }",
    "function execute(Intent intent, PermitBatchTransferFrom permit, bytes signature)",
    "function witnessOf(Intent intent) pure returns (bytes32)",
    "function configure(address[] tokens, uint128[] perAction, uint128[] perDay, uint32 protocols, bool payeesOnly, uint64 expiry)",
    "function setLimit(address token, uint128 perAction, uint128 perDay)",
    "function setProtocols(uint32 protocols)",
    "function setPayee(address payee, bool allowed)",
    "function setPayeesOnly(bool payeesOnly)",
    "function setExpiry(uint64 expiry)",
    "function pause()",
    "function unpause()",
    "function policyOf(address) view returns (uint64 expiry, uint32 protocols, bool paused, bool payeesOnly, bool exists)",
    "function limitOf(address user, address token) view returns (uint128 perAction, uint128 perDay)",
    "function remaining(address user, address token) view returns (uint256 action, uint256 today)",
    "function payeeAllowed(address user, address payee) view returns (bool)",
    "function protocolNames(uint256) view returns (string)",
    "function WITNESS_TYPE_STRING() view returns (string)",
    "event LimitSet(address indexed user, address indexed token, uint128 perAction, uint128 perDay)",
    "event ProtocolsSet(address indexed user, uint32 protocols)",
    "event PayeeSet(address indexed user, address indexed payee, bool allowed)",
    "event PayeesOnlySet(address indexed user, bool payeesOnly)",
    "event ExpirySet(address indexed user, uint64 expiry)",
    "event PausedSet(address indexed user, bool paused)",
    "event Spent(address indexed user, address indexed token, uint256 amount)",
    "event Paid(address indexed user, address indexed token, address indexed to, uint256 amount)",
    "event Delivered(address indexed user, address indexed token, uint256 minDelta, uint256 delta)",
    "event Executed(address indexed user, bytes32 indexed planId, bytes32 witness)",
    "error NotIntentUser()",
    "error IntentExpired(uint256 deadline)",
    "error NoPolicy()",
    "error PolicyPaused()",
    "error PolicyExpired(uint64 expiry)",
    "error NoLimit(address token)",
    "error OverActionLimit(address token, uint256 amount, uint256 limit)",
    "error OverDailyLimit(address token, uint256 spentToday, uint256 amount, uint256 limit)",
    "error TargetNotAllowed(address target)",
    "error SpenderNotAllowed(address spender)",
    "error ProtocolNotEnabled(uint8 protocol)",
    "error PayeeNotAllowed(address payee)",
    "error BadPayee(address payee)",
    "error NoGuarantee()",
    "error SelectorNotAllowed(bytes4 selector)",
    "error OutBelowMinimum(address token, uint256 minDelta, uint256 delta)",
    "error CallFailed(uint256 index, bytes reason)",
    "error TokenCallFailed(address token)",
    "error Reentrancy()",
    // Permit2 errors a user can hit
    "error InvalidNonce()",
    "error InvalidSigner()",
    "error SignatureExpired(uint256 signatureDeadline)",
    "error InvalidSignature()",
    "error InvalidSignatureLength()",
    "error InvalidContractSignature()",
    "error InvalidAmount(uint256 maxAmount)",
    "error LengthMismatch()",
  ]),
};

/** Every token Warden may show a balance for on the current network: base tokens, vault shares, aTokens. */
export function knownTokens() {
  const n = net();
  return [
    ...Object.values(n.tokens),
    ...n.protocols.filter((p) => p.vault).map((p) => ({ symbol: p.symbol, name: p.name, address: p.vault, decimals: p.decimals, balanceSlot: p.balanceSlot, allowanceSlot: p.allowanceSlot })),
    ...n.protocols.filter((p) => p.aToken).map((p) => ({ symbol: p.symbol, name: p.name, address: p.aToken, decimals: p.decimals, balanceSlot: p.balanceSlot, allowanceSlot: p.allowanceSlot })),
  ];
}
export const tokenByAddress = (a) => knownTokens().find((t) => t.address.toLowerCase() === String(a).toLowerCase());
export const tokenBySymbol = (s) => knownTokens().find((t) => t.symbol.toLowerCase() === String(s).toLowerCase());

/** Contracts Warden knows by name on the current network (for approvals, transaction checks and explanations). */
export function knownContracts() {
  const n = net();
  const m = new Map([[PERMIT2, "Permit2"], [n.warden, "Warden"]]);
  for (const t of knownTokens()) m.set(t.address, t.symbol);
  if (n.faroswap) {
    m.set(n.faroswap.routeProxy, "FaroSwap DODORouteProxy");
    m.set(n.faroswap.dodoApprove, "FaroSwap DODOApprove");
    m.set(n.faroswap.pool, "FaroSwap WPROS/USDC pool");
  }
  if (n.faroswapV3) {
    m.set(n.faroswapV3.npm, "FaroSwap V3 positions (NPM)");
    m.set(n.faroswapV3.factory, "FaroSwap V3 factory");
  }
  for (const p of n.protocols) {
    if (p.vault) m.set(p.vault, p.kind === "erc4626-stake" ? p.name : `${p.name} vault`);
    if (p.pool) m.set(p.pool, `${p.name} pool`);
  }
  return m;
}
export const contractName = (a) => knownContracts().get(getAddress(a)) ?? null;

export const explorerTx = (h) => `${net().explorer}/tx/${h}`;
export const explorerAddress = (a) => `${net().explorer}/address/${a}`;
