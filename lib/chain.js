import { createPublicClient, decodeFunctionResult, encodeFunctionData, getAddress, http } from "viem";
import { CHAIN_MCP_URL } from "./config.js";
import { callTool, connect } from "./mcp.js";

// Reads Pacific through the official Pharos Chain MCP — the agent's source of chain data. Every call is recorded
// (tool, arguments, time) so the page can show exactly what the agent looked at.

export class ChainReader {
  constructor(client) {
    this.client = client;
    this.log = [];
  }

  static async open() {
    return new ChainReader(await connect(CHAIN_MCP_URL, "pharos-warden"));
  }

  /** Same connection, its own call log (also recorded in this one): one per tool call, so parallel tools don't mix. */
  child() {
    const c = new ChainReader(this.client);
    c.parent = this;
    return c;
  }

  async tool(name, args = {}) {
    const started = Date.now();
    const entry = { server: "chain", tool: name, args, ms: 0, ok: true };
    this.log.push(entry);
    this.parent?.log.push(entry);
    try {
      const text = await callTool(this.client, name, args);
      const json = JSON.parse(text);
      if (json && typeof json === "object" && json.error) throw new Error(json.error.message ?? JSON.stringify(json.error));
      return json;
    } catch (e) {
      entry.ok = false;
      entry.error = String(e.message).slice(0, 200);
      throw e;
    } finally {
      entry.ms = Date.now() - started;
    }
  }

  /** eth_call through the Chain MCP, decoded with the given ABI. */
  async read(address, abi, functionName, args = [], block = "latest") {
    const data = encodeFunctionData({ abi, functionName, args });
    const { result } = await this.tool("eth_call", { transaction: { to: getAddress(address), data }, block });
    return decodeFunctionResult({ abi, functionName, data: result });
  }

  chainInfo() {
    return this.tool("get_chain_info");
  }

  async balance(address) {
    return BigInt((await this.tool("get_balance", { address })).balanceWei);
  }

  async nonce(address) {
    return Number((await this.tool("get_transaction_count", { address })).nonce);
  }

  async code(address) {
    return (await this.tool("get_code", { address })).code ?? "0x";
  }

  async block(block = "latest") {
    const b = await this.tool("get_block", { block });
    return { number: BigInt(b.number), timestamp: BigInt(b.timestamp), baseFee: b.baseFeePerGas ? BigInt(b.baseFeePerGas) : 0n, hash: b.hash };
  }

  receipt(hash) {
    return this.tool("get_transaction_receipt", { hash });
  }

  transaction(hash) {
    return this.tool("get_transaction", { hash });
  }

  /** A raw eth_call (from, value allowed): `{ ok, data }`, or `{ ok: false, revertData }` when it reverts. */
  async callRaw({ from, to, data, value, block = "latest" }) {
    try {
      const { result } = await this.tool("eth_call", { transaction: { ...(from && { from }), to, data, ...(value && { value: `0x${BigInt(value).toString(16)}` }) }, block });
      return { ok: true, data: result };
    } catch (e) {
      return { ok: false, revertData: revertDataOf(e), message: String(e.message).slice(0, 300) };
    }
  }

  async logs({ address, topics, fromBlock, toBlock }) {
    return (await this.tool("get_logs", { address, topics, fromBlock: Number(fromBlock), toBlock: Number(toBlock) })) ?? [];
  }

  async gasPrice() {
    return BigInt((await this.tool("get_gas_price")).gasPriceWei);
  }

  close() {
    return this.client.close?.().catch(() => {});
  }
}

/**
 * The same interface over a plain JSON-RPC endpoint, for networks the Chain MCP does not serve (Atlantic Testnet).
 * Calls are logged with server "rpc" so the page shows honestly where each read came from.
 */
export class RpcReader {
  constructor(network, client) {
    this.network = network;
    this.client = client ?? createPublicClient({ transport: http(network.rpc, { retryCount: 3, timeout: 20_000 }) });
    this.log = [];
  }

  child() {
    const c = new RpcReader(this.network, this.client);
    c.parent = this;
    return c;
  }

  async #logged(tool, args, fn) {
    const started = Date.now();
    const entry = { server: "rpc", tool, args, ms: 0, ok: true };
    this.log.push(entry);
    this.parent?.log.push(entry);
    try {
      return await fn();
    } catch (e) {
      entry.ok = false;
      entry.error = String(e.shortMessage ?? e.message).slice(0, 200);
      throw e;
    } finally {
      entry.ms = Date.now() - started;
    }
  }

  async read(address, abi, functionName, args = [], block = "latest") {
    const data = encodeFunctionData({ abi, functionName, args });
    const blockArg = block === "latest" ? {} : { blockNumber: BigInt(block) };
    const { data: result } = await this.#logged("eth_call", { to: address, data, block }, () => this.client.call({ to: getAddress(address), data, ...blockArg }));
    return decodeFunctionResult({ abi, functionName, data: result ?? "0x" });
  }

  chainInfo() {
    return this.#logged("eth_chainId", {}, async () => ({ chainId: await this.client.getChainId() }));
  }

  balance(address) {
    return this.#logged("eth_getBalance", { address }, () => this.client.getBalance({ address: getAddress(address) }));
  }

  nonce(address) {
    return this.#logged("eth_getTransactionCount", { address }, () => this.client.getTransactionCount({ address: getAddress(address) }));
  }

  async code(address) {
    return (await this.#logged("eth_getCode", { address }, () => this.client.getCode({ address: getAddress(address) }))) ?? "0x";
  }

  async block(block = "latest") {
    const b = await this.#logged("eth_getBlockByNumber", { block }, () => this.client.getBlock(block === "latest" ? {} : { blockNumber: BigInt(block) }));
    return { number: b.number, timestamp: b.timestamp, baseFee: b.baseFeePerGas ?? 0n, hash: b.hash };
  }

  /** Same raw shape as the Chain MCP: hex strings, null when unknown. */
  receipt(hash) {
    return this.#logged("eth_getTransactionReceipt", { hash }, () => this.client.request({ method: "eth_getTransactionReceipt", params: [hash] }));
  }

  transaction(hash) {
    return this.#logged("eth_getTransactionByHash", { hash }, () => this.client.request({ method: "eth_getTransactionByHash", params: [hash] }));
  }

  async callRaw({ from, to, data, value, block = "latest" }) {
    try {
      const blockArg = block === "latest" ? {} : { blockNumber: BigInt(block) };
      const r = await this.#logged("eth_call", { from, to, data, block }, () => this.client.call({ ...(from && { account: getAddress(from) }), to: getAddress(to), data, ...(value && { value: BigInt(value) }), ...blockArg }));
      return { ok: true, data: r.data ?? "0x" };
    } catch (e) {
      return { ok: false, revertData: revertDataOf(e), message: String(e.shortMessage ?? e.message).slice(0, 300) };
    }
  }

  async logs({ address, topics, fromBlock, toBlock }) {
    const params = [{ address, topics, fromBlock: `0x${BigInt(fromBlock).toString(16)}`, toBlock: `0x${BigInt(toBlock).toString(16)}` }];
    return (await this.#logged("eth_getLogs", params[0], () => this.client.request({ method: "eth_getLogs", params }))) ?? [];
  }

  gasPrice() {
    return this.#logged("eth_gasPrice", {}, () => this.client.getGasPrice());
  }

  close() {}
}

/** The chain reader for the current network: the Pharos Chain MCP where it serves, the public RPC elsewhere. */
export async function openChain(network) {
  return network.chainSource === "mcp" ? ChainReader.open() : new RpcReader(network);
}

/** The revert data inside an eth_call error (viem's error chain, or an MCP / JSON-RPC error message). */
export function revertDataOf(e) {
  let x = e;
  for (let i = 0; x && i < 8; i++, x = x.cause) {
    const d = x.data?.data ?? x.data;
    if (typeof d === "string" && /^0x[0-9a-fA-F]*$/.test(d)) return d;
  }
  const m = String(e?.message ?? "").match(/0x[0-9a-fA-F]{8,}/);
  return m ? m[0] : "0x";
}
