import { getAddress, parseAbi } from "viem";

// Pharos Pacific Mainnet (chain 1672). Every address below was checked on chain (docs/ADDRESSES.md):
// - USDC, WPROS: the official token registry (docs.pharos.xyz/getting-started/token-registry), the same entries as
//   SkillEngine's assets/tokens.json.
// - FaroSwap: DODORouteProxy, its UniV3 adapter and 0.01% WPROS/USDC pool, and DODOApprove (the approval target,
//   read from the proxy) — the route real FaroSwap swaps take.
// - Morpho Vault V2 (ERC-4626) USDC vaults RockawayX and SharpByte: asset() = USDC.
// - Avalon (Aave V3) pool and its USDC aToken: aToken.POOL() = the pool.
// - Permit2: the canonical deployment.
// Storage slots (balance / allowance mappings) were found on chain with eth_call state-override probes
// (scratch/probe-slots.mjs); they are used only to dry-run a plan for a wallet that has not approved yet.

export const CHAIN_ID = 1672;
export const PACIFIC_RPC = globalThis.process?.env?.PACIFIC_RPC_URL ?? "https://rpc.pharos.xyz";
export const EXPLORER = "https://www.pharosscan.xyz";
export const CHAIN_MCP_URL = "https://mcp.pharos.xyz/mcp";
export const DOCS_MCP_URL = "https://docs.pharos.xyz/~gitbook/mcp";
export const TOKEN_REGISTRY_URL = "https://docs.pharos.xyz/getting-started/token-registry";

/** Warden on Pacific Mainnet, deployed at block 22,647,574 (docs/ADDRESSES.md). WARDEN_ADDRESS overrides it, e.g. for a fork. */
export const WARDEN = getAddress(globalThis.process?.env?.WARDEN_ADDRESS ?? "0x02fa5869a0Abe62C97c1D1c65df878783Dc11418");

export const PERMIT2 = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");

export const TOKENS = {
  USDC: { symbol: "USDC", name: "USDC", address: getAddress("0xC879C018dB60520F4355C26eD1a6D572cdAC1815"), decimals: 6, balanceSlot: 9n, allowanceSlot: 10n },
  WPROS: { symbol: "WPROS", name: "Wrapped PROS", address: getAddress("0x52C48d4213107b20bC583832b0d951FB9CA8F0B0"), decimals: 18, balanceSlot: 3n, allowanceSlot: 4n },
};

export const FAROSWAP = {
  routeProxy: getAddress("0xA5cA5Fbe34e444F366B373170541ec6902b0F75c"),
  dodoApprove: getAddress("0xBF105f4ffBD3825f5433d074008B9A76237d849c"),
  adapter: getAddress("0x4fD44181839D24e7C8f4D1B9288379109Ec25FAE"),
  pool: getAddress("0x912c9aDe24D44d8922f0866D8Dcb079f1363f647"),
  poolFee: 100, // 0.01%
};

/** Protocol ids are the bit positions in a user's Warden policy (`setProtocols(mask)`). */
export const PROTOCOLS = [
  { id: 0, key: "faroswap", name: "FaroSwap", kind: "dex" },
  { id: 1, key: "rockawayx", name: "Morpho RockawayX USDC", kind: "morpho-vault-v2", vault: getAddress("0x047cD0a91E9B92ED979189a6C8A120bf280f02E5"), symbol: "roxUSDC", decimals: 18, balanceSlot: 12n, allowanceSlot: 13n },
  { id: 2, key: "sharpbyte", name: "Morpho SharpByte USDC", kind: "morpho-vault-v2", vault: getAddress("0x15c25ED222fc498f672af5c3adb5ED0a96E1AFf1"), symbol: "sbUSDC-ph-eco", decimals: 18, balanceSlot: 12n, allowanceSlot: 13n },
  { id: 3, key: "avalon", name: "Avalon USDC", kind: "aave-v3", pool: getAddress("0xD9B9E4F8257bFf9B1415d74c1EF88d8057f60cBa"), aToken: getAddress("0xE2ec2F3933aD2f83DE9a9dDa844558354384e87D"), symbol: "aPharosUSDC", decimals: 6, balanceSlot: null, allowanceSlot: 53n }, // aToken balances are scaled: no balance override
];
export const protocolByKey = (key) => PROTOCOLS.find((p) => p.key === key);
export const ALL_PROTOCOLS_MASK = PROTOCOLS.reduce((m, p) => m | (1 << p.id), 0);

export const ABI = {
  erc20: parseAbi([
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
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
  ]),
};

/** Every token Warden may show a balance for: the two base tokens, the vault shares, the aToken. */
export function knownTokens() {
  return [
    TOKENS.USDC,
    TOKENS.WPROS,
    ...PROTOCOLS.filter((p) => p.vault).map((p) => ({ symbol: p.symbol, name: p.name, address: p.vault, decimals: p.decimals, balanceSlot: p.balanceSlot, allowanceSlot: p.allowanceSlot })),
    ...PROTOCOLS.filter((p) => p.aToken).map((p) => ({ symbol: p.symbol, name: p.name, address: p.aToken, decimals: p.decimals, balanceSlot: p.balanceSlot, allowanceSlot: p.allowanceSlot })),
  ];
}
export const tokenByAddress = (a) => knownTokens().find((t) => t.address.toLowerCase() === String(a).toLowerCase());
export const tokenBySymbol = (s) => knownTokens().find((t) => t.symbol.toLowerCase() === String(s).toLowerCase());

export const explorerTx = (h) => `${EXPLORER}/tx/${h}`;
export const explorerAddress = (a) => `${EXPLORER}/address/${a}`;
