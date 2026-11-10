import { decodeFunctionResult, encodeFunctionData, getAddress } from "viem";
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

  async tool(name, args = {}) {
    const started = Date.now();
    const entry = { server: "chain", tool: name, args, ms: 0, ok: true };
    this.log.push(entry);
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
