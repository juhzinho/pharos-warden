// Browser wallet (EIP-1193), discovered with EIP-6963 so MetaMask, Rabby, OKX… can coexist. The private key never
// leaves the wallet: this page only asks it to sign typed data and send transactions the user approves.
import { encodeFunctionData } from "https://esm.sh/viem@2.21.55";

/** The two Pharos networks, as wallet_addEthereumChain wants them. */
export const CHAINS = {
  atlantic: {
    chainId: "0xa8231", // 688689
    chainName: "Pharos Atlantic Testnet",
    nativeCurrency: { name: "PHRS", symbol: "PHRS", decimals: 18 },
    rpcUrls: ["https://atlantic.dplabs-internal.com"],
    blockExplorerUrls: ["https://atlantic.pharosscan.xyz"],
  },
  pacific: {
    chainId: "0x688", // 1672
    chainName: "Pharos Pacific Mainnet",
    nativeCurrency: { name: "PROS", symbol: "PROS", decimals: 18 },
    rpcUrls: ["https://rpc.pharos.xyz"],
    blockExplorerUrls: ["https://www.pharosscan.xyz"],
  },
};

const providers = new Map();
window.addEventListener("eip6963:announceProvider", (e) => providers.set(e.detail.info.uuid, e.detail));
window.dispatchEvent(new Event("eip6963:requestProvider"));

export function availableWallets() {
  const list = [...providers.values()].map((p) => ({ id: p.info.uuid, name: p.info.name, icon: p.info.icon, provider: p.provider }));
  if (!list.length && window.ethereum) list.push({ id: "injected", name: "Browser wallet", icon: null, provider: window.ethereum });
  return list;
}

export class Wallet {
  constructor(provider, name) {
    this.provider = provider;
    this.name = name;
    this.address = null;
    this.network = "atlantic"; // the page's network: every send and signature happens on it
  }

  request(method, params) {
    return this.provider.request({ method, ...(params && { params }) });
  }

  async connect(network = this.network) {
    const [address] = await this.request("eth_requestAccounts");
    this.address = address;
    this.network = network;
    await this.ensureChain();
    return address;
  }

  /** Puts the wallet on `network` (adding the chain if the wallet does not know it yet). */
  async ensureChain(network = this.network) {
    const target = CHAINS[network];
    if (!target) throw new Error(`unknown network ${network}`);
    const chainId = await this.request("eth_chainId");
    if (chainId?.toLowerCase() === target.chainId) return;
    try {
      await this.request("wallet_switchEthereumChain", [{ chainId: target.chainId }]);
    } catch (e) {
      if (e?.code !== 4902 && !/unrecognized|not added|unknown chain/i.test(e?.message ?? "")) throw e;
      await this.request("wallet_addEthereumChain", [target]);
    }
    // a wallet that silently stays on another chain must never get the request
    const now = await this.request("eth_chainId");
    if (now?.toLowerCase() !== target.chainId) throw new Error(`switch your wallet to ${target.chainName} first`);
  }

  async send(tx, network = this.network) {
    await this.ensureChain(network);
    const params = { from: this.address, to: tx.to, data: tx.data };
    if (tx.value && BigInt(tx.value) > 0n) params.value = `0x${BigInt(tx.value).toString(16)}`;
    return this.request("eth_sendTransaction", [params]);
  }

  /**
   * EIP-712 v4. EIP712Domain lists exactly the fields the domain has, in the standard order: Permit2's has no version,
   * USDC's (EIP-3009, for x402) has one.
   */
  async signTypedData(td, network = this.network) {
    await this.ensureChain(network);
    const FIELDS = [["name", "string"], ["version", "string"], ["chainId", "uint256"], ["verifyingContract", "address"], ["salt", "bytes32"]];
    const { EIP712Domain, ...types } = td.types;
    const payload = {
      domain: td.domain,
      types: { EIP712Domain: FIELDS.filter(([k]) => td.domain[k] !== undefined).map(([name, type]) => ({ name, type })), ...types },
      primaryType: td.primaryType,
      message: td.message,
    };
    return this.request("eth_signTypedData_v4", [this.address, JSON.stringify(payload)]);
  }

  async waitForReceipt(hash, { timeoutMs = 120_000 } = {}) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const rc = await this.request("eth_getTransactionReceipt", [hash]).catch(() => null);
      if (rc) return rc;
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error("no receipt after 2 minutes — check the explorer");
  }
}

// Warden.execute(intent, permit, signature), encoded here so the page sends exactly the plan the user signed.
const EXECUTE_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "intent",
        type: "tuple",
        components: [
          { name: "user", type: "address" },
          { name: "approvals", type: "tuple[]", components: [{ name: "token", type: "address" }, { name: "spender", type: "address" }, { name: "amount", type: "uint256" }] },
          { name: "calls", type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "data", type: "bytes" }] },
          { name: "outs", type: "tuple[]", components: [{ name: "token", type: "address" }, { name: "minDelta", type: "uint256" }] },
          { name: "pays", type: "tuple[]", components: [{ name: "token", type: "address" }, { name: "to", type: "address" }, { name: "amount", type: "uint256" }] },
          { name: "deadline", type: "uint256" },
          { name: "planId", type: "bytes32" },
        ],
      },
      {
        name: "permit",
        type: "tuple",
        components: [
          { name: "permitted", type: "tuple[]", components: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }] },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
];

export function executeCalldata({ intent, permit }, signature) {
  const b = (x) => BigInt(x);
  return encodeFunctionData({
    abi: EXECUTE_ABI,
    functionName: "execute",
    args: [
      {
        user: intent.user,
        approvals: intent.approvals.map((a) => ({ token: a.token, spender: a.spender, amount: b(a.amount) })),
        calls: intent.calls.map((c) => ({ target: c.target, data: c.data })),
        outs: intent.outs.map((o) => ({ token: o.token, minDelta: b(o.minDelta) })),
        pays: intent.pays.map((p) => ({ token: p.token, to: p.to, amount: b(p.amount) })),
        deadline: b(intent.deadline),
        planId: intent.planId,
      },
      { permitted: permit.permitted.map((t) => ({ token: t.token, amount: b(t.amount) })), nonce: b(permit.nonce), deadline: b(permit.deadline) },
      signature,
    ],
  });
}
