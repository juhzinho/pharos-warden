import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// Local Anvil fork of Pharos Pacific Mainnet, for tests and the offline demo. Anvil (not Hardhat): Pacific block
// headers have no excessBlobGas and the Morpho vaults need Cancun opcodes.

const PACIFIC_RPC = "https://rpc.pharos.xyz"; // literal: importing config.js here would freeze env-dependent values

/** A Foundry binary (anvil / forge): <NAME>_BIN, the platform package installed by npm, or the name on PATH. */
export function foundryBin(name) {
  const env = process.env[`${name.toUpperCase()}_BIN`];
  if (env) return env;
  const pkg = `@foundry-rs/${name}-${process.platform === "win32" ? "win32" : process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`;
  try {
    const require = createRequire(import.meta.url);
    const file = join(dirname(require.resolve(`${pkg}/package.json`)), "bin", process.platform === "win32" ? `${name}.exe` : name);
    if (existsSync(file)) return file;
  } catch {}
  return name;
}

async function rpcUp(url) {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "web3_clientVersion", params: [] }) });
    return /anvil/i.test((await res.json()).result ?? "");
  } catch {
    return false;
  }
}

export async function startFork({ port = 8547, block, rpc = PACIFIC_RPC } = {}) {
  const url = `http://127.0.0.1:${port}`;
  if (await rpcUp(url)) return { url, reused: true, stop: () => {} };
  const args = ["--fork-url", rpc, "--chain-id", "1672", "--port", String(port), "--host", "127.0.0.1", "--silent"];
  if (block) args.push("--fork-block-number", String(block));
  const child = spawn(foundryBin("anvil"), args, { stdio: "ignore", windowsHide: true });
  let failed = null;
  child.on("error", (e) => (failed = e));
  for (let i = 0; i < 120; i++) {
    if (failed) throw new Error(`could not start Anvil (${failed.message}). Run npm install.`);
    if (await rpcUp(url)) return { url, reused: false, stop: () => child.kill() };
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error("Anvil did not answer within 60 s");
}

/** Deploys Warden on a fork with forge (the same script as mainnet) and returns its address. */
export function deployWardenOnFork(url, privateKey) {
  const cwd = new URL("../contracts/", import.meta.url);
  // the fork also has chain id 1672: keep its broadcast and cache apart, or it would overwrite the mainnet records
  const r = spawnSync(foundryBin("forge"), ["script", "script/Deploy.s.sol", "--rpc-url", url, "--private-key", privateKey, "--broadcast", "--slow"], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, FOUNDRY_BROADCAST: "fork-broadcast", FOUNDRY_CACHE_PATH: "fork-cache" },
  });
  const m = `${r.stdout}\n${r.stderr}`.match(/Warden (0x[0-9a-fA-F]{40})/);
  if (!m) throw new Error(`forge deploy failed:\n${(r.stderr || r.stdout).slice(-1500)}`);
  return m[1];
}
