// Verifies Warden's source on Pharosscan (SocialScan, Etherscan-compatible v1 API) with the exact build inputs:
// Foundry's standard JSON input, solc v0.8.28+commit.7893614a, and the constructor arguments recorded from the
// deployment transaction (docs/deployment.json). Forge 1.7's own `verify-contract` speaks the Etherscan v2 API, which SocialScan
// rejects ("the action is error"), hence this script.
//   cd contracts && forge verify-contract <address> src/Warden.sol:Warden --show-standard-json-input > ../scratch/warden-standard-input.json
//   node scripts/verify-explorer.js
import { readFileSync } from "node:fs";

const API = "https://api.socialscan.io/pharos-mainnet/v1/explorer/command_api/contract";
const deployment = JSON.parse(readFileSync(new URL("../docs/deployment.json", import.meta.url), "utf8"));
const address = deployment.address;
const args = deployment.constructorArguments.replace(/^0x/, "");
const input = readFileSync(process.argv[2] ?? new URL("../scratch/warden-standard-input.json", import.meta.url), "utf8");

const post = async (params) => {
  const res = await fetch(API, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { status: "0", message: `HTTP ${res.status}: ${text.slice(0, 200)}` }; // the explorer API is down or answered HTML
  }
};
const submit = await post({ apikey: "pharos", module: "contract", action: "verifysourcecode", contractaddress: address, sourceCode: input, codeformat: "solidity-standard-json-input", contractname: "src/Warden.sol:Warden", compilerversion: "v0.8.28+commit.7893614a", constructorArguements: args });
console.log("submit:", JSON.stringify(submit));
if (String(submit.status) !== "1") process.exit(/already verified/i.test(JSON.stringify(submit)) ? 0 : 1);
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const st = await fetch(`${API}?${new URLSearchParams({ apikey: "pharos", module: "contract", action: "checkverifystatus", guid: submit.result })}`).then((r) => r.json()).catch((e) => ({ result: `pending (status read failed: ${e.message})` }));
  console.log("status:", JSON.stringify(st));
  if (!/pending|queue/i.test(st.result ?? "")) process.exit(/pass|verified/i.test(st.result ?? "") ? 0 : 1);
}
