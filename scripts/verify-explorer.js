// Verifies Warden's source on Pharosscan (SocialScan, Etherscan-compatible v1 API) with the exact build inputs:
// Foundry's standard JSON input, solc v0.8.28+commit.7893614a, and the constructor arguments taken from the
// deployment transaction itself. Forge 1.7's own `verify-contract` speaks the Etherscan v2 API, which SocialScan
// rejects ("the action is error"), hence this script.
//   node scripts/verify-explorer.js <address>
import { readFileSync } from "node:fs";

const API = "https://api.socialscan.io/pharos-mainnet/v1/explorer/command_api/contract";
const address = process.argv[2];
if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? "")) throw new Error("usage: node scripts/verify-explorer.js <address>");
const run = JSON.parse(readFileSync(new URL("../contracts/broadcast/Deploy.s.sol/1672/run-latest.json", import.meta.url), "utf8"));
const tx = run.transactions.find((t) => t.contractName === "Warden" && t.contractAddress.toLowerCase() === address.toLowerCase());
if (!tx) throw new Error("no Warden deployment of that address in the broadcast log");
const creation = JSON.parse(readFileSync(new URL("../contracts/out/Warden.sol/Warden.json", import.meta.url), "utf8")).bytecode.object;
if (!tx.transaction.input.startsWith(creation)) throw new Error("the local build does not match the deployed creation code");
const args = tx.transaction.input.slice(creation.length);
const input = readFileSync(process.argv[3] ?? new URL("../scratch/warden-standard-input.json", import.meta.url), "utf8");

const post = async (params) => {
  const res = await fetch(API, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
  return res.json();
};
const submit = await post({ apikey: "pharos", module: "contract", action: "verifysourcecode", contractaddress: address, sourceCode: input, codeformat: "solidity-standard-json-input", contractname: "src/Warden.sol:Warden", compilerversion: "v0.8.28+commit.7893614a", constructorArguements: args });
console.log("submit:", JSON.stringify(submit));
if (String(submit.status) !== "1") process.exit(/already verified/i.test(JSON.stringify(submit)) ? 0 : 1);
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const st = await (await fetch(`${API}?${new URLSearchParams({ apikey: "pharos", module: "contract", action: "checkverifystatus", guid: submit.result })}`)).json();
  console.log("status:", JSON.stringify(st));
  if (!/pending|queue/i.test(st.result ?? "")) process.exit(/pass|verified/i.test(st.result ?? "") ? 0 : 1);
}
