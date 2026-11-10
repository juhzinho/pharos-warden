import { decodeEventLog, decodeFunctionData, decodeFunctionResult, encodeFunctionData, getAddress, isAddress, maxUint160, maxUint256, pad, parseAbi, toFunctionSelector } from "viem";
import { ABI, PERMIT2, contractName, knownTokens, net, tokenByAddress } from "./config.js";
import { pool } from "./pool.js";
import { fmt } from "./reads.js";
import { SIM_PROBE_CODE } from "./sim-bytecode.js";
import { explainRevert } from "./simulate.js";

// Wallet-safety skills, ported from ProsPilot (pre-sign risk, allowance scan, transaction explainer) and made stronger:
// - check_transaction runs the dApp's transaction AS THE USER against live state (SimProbe, an eth_call state
//   override) and reports what it would really do — balance changes and new allowances — instead of guessing from the
//   calldata alone;
// - check_signature reads an EIP-712 request (Permit, Permit2, EIP-3009, Seaport…): the off-chain signatures drainers
//   ask for, which no transaction simulator sees;
// - scan_approvals reads live allowances (ERC-20 and Permit2) for every token and spender Warden knows, plus any the
//   wallet approved recently (Approval events), and prepares revokes the user signs;
// - explain_tx decodes any transaction: call, events, fee, and — for a failed one — the revert reason, replayed.
// Everything is read-only; nothing is signed here.

const UNLIMITED = maxUint256 / 2n; // anything above is "unlimited" in practice
const UNLIMITED_160 = maxUint160 / 2n;

/** Calls a dApp may ask a wallet to make — decoded by name, with their risk meaning. */
const CALL_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
  "function increaseAllowance(address spender, uint256 addedValue) returns (bool)",
  "function decreaseAllowance(address spender, uint256 subtractedValue) returns (bool)",
  "function setApprovalForAll(address operator, bool approved)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
  "function deposit()",
  "function withdraw(uint256 wad)",
  "function multicall(bytes[] data) returns (bytes[])",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
]);
// Multicall3, at its canonical address on both Pharos networks (bytecode checked on Atlantic and Pacific 2026-11-10)
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL3_ABI = parseAbi(["struct Call3 { address target; bool allowFailure; bytes callData; }", "struct Result { bool success; bytes returnData; }", "function aggregate3(Call3[] calls) payable returns (Result[] returnData)"]);
const PERMIT2_ABI = parseAbi([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function lockdown((address token, address spender)[] approvals)",
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "event Approval(address indexed owner, address indexed token, address indexed spender, uint160 amount, uint48 expiration)",
  "event Permit(address indexed owner, address indexed token, address indexed spender, uint160 amount, uint48 expiration, uint48 nonce)",
  "event Lockdown(address indexed owner, address token, address spender)",
  "event UnorderedNonceInvalidation(address indexed owner, uint256 word, uint256 mask)",
]);
const EVENT_ABI = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
  "event ApprovalForAll(address indexed owner, address indexed operator, bool approved)",
  "event Deposit(address indexed dst, uint256 wad)",
  "event Withdrawal(address indexed src, uint256 wad)",
  "event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)",
  "event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)",
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
]);
const ALL_CALLS = [...CALL_ABI, ...ABI.warden.filter((x) => x.type === "function"), ...ABI.routeProxy, ...ABI.vaultV2.filter((x) => x.type === "function"), ...ABI.aavePool];
const META_ABI = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const PERMIT2_APPROVAL_TOPIC = "0xda9fa7c1b00402c17d0161b249b1ab8bbec047c5a52207b9c112deffd817036b";
const PERMIT2_PERMIT_TOPIC = "0xc6a377bfc4eb120024a8ac08eef205be16b817020812c73223e81d1bdb9708ec";

// ─── helpers ────────────────────────────────────────────────────────────────────────────────────────────────────

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;const SEV = { critical: 3, high: 2, medium: 1, info: 0 };
function verdictOf(flags) {
  const top = Math.max(-1, ...flags.map((f) => SEV[f.severity]));
  return top >= 3 ? "do_not_sign" : top === 2 ? "high_risk" : top === 1 ? "caution" : "looks_ok";
}

/** Function name of a selector: Warden's own ABIs first, then the OpenChain signature database (unverified). */
async function lookupSelector(selector) {
  try {
    const r = await fetch(`https://api.openchain.xyz/signature-database/v1/lookup?function=${selector}&filter=true`, { signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    return j?.result?.function?.[selector]?.[0]?.name ?? null;
  } catch {
    return null;
  }
}

/** Decodes calldata against the calls Warden knows; `{ name, args, signature, source }` or a database guess. */
export async function decodeCall(to, data) {
  if (!data || data === "0x") return { name: null, plain: true };
  const selector = data.slice(0, 10).toLowerCase();
  const abis = getAddress(to) === PERMIT2 ? [PERMIT2_ABI, ALL_CALLS] : [ALL_CALLS, PERMIT2_ABI];
  for (const abi of abis) {
    try {
      const d = decodeFunctionData({ abi, data });
      const item = abi.find((x) => x.type === "function" && x.name === d.functionName && toFunctionSelector(x) === selector);
      return { name: d.functionName, args: d.args ?? [], inputs: item?.inputs ?? [], selector, source: "known ABI" };
    } catch {}
  }
  const guess = await lookupSelector(selector);
  return { name: guess ? guess.split("(")[0] : null, signature: guess, selector, source: guess ? "OpenChain signature database (unverified)" : "unknown" };
}

const metaCache = new Map();
/** Symbol and decimals of any token (known ones from config; others read on chain, cached). */
export async function tokenMeta(chain, address) {
  const a = getAddress(address);
  const known = tokenByAddress(a);
  if (known) return { symbol: known.symbol, decimals: known.decimals, known: true };
  const key = `${net().key}:${a}`;
  if (metaCache.has(key)) return metaCache.get(key);
  const [symbol, decimals] = await Promise.all([chain.read(a, META_ABI, "symbol").catch(() => null), chain.read(a, META_ABI, "decimals").catch(() => null)]);
  const m = { symbol: symbol ?? short(a), decimals: decimals == null ? 18 : Number(decimals), known: false, isToken: symbol != null && decimals != null };
  metaCache.set(key, m);
  return m;
}

/** What an address is: a contract Warden knows, another contract, an EIP-7702 wallet, or a plain wallet. */
async function whoIs(chain, address) {
  const a = getAddress(address);
  const name = contractName(a);
  const code = await chain.code(a);
  const isContract = !!code && code !== "0x" && !code.startsWith("0xef0100");
  return { address: a, name, isContract, delegated: !!code?.startsWith("0xef0100"), label: name ?? (isContract ? "an unknown contract" : "a wallet (no code)"), labelPt: name ?? (isContract ? "um contrato desconhecido" : "uma carteira (sem código)") };
}

/** One decoded argument, short: MAX for "unlimited" numbers, lists by length, long bytes cut. */
const argText = (a) => {
  if (typeof a === "bigint") return a >= UNLIMITED_160 ? "MAX" : a.toString();
  if (Array.isArray(a)) return `[${a.length} item(s)]`;
  const s = String(a);
  return s.length > 42 ? `${s.slice(0, 10)}…` : s;
};

/** A revert in words: Warden's and Permit2's errors by name, else the error's name from the public database. */
async function revertText(data) {
  const e = explainRevert(data);
  if (!e.text.startsWith("custom error ")) return e.text;
  const name = await lookupSelector(String(data).slice(0, 10).toLowerCase());
  return name ? `${name} (error name from a public database)` : e.text;
}

const amountText = (v, meta) => (v >= UNLIMITED ? `UNLIMITED ${meta.symbol}` : `${fmt(v, meta.decimals)} ${meta.symbol}`);
const amountPt = (v, meta) => (v >= UNLIMITED ? `${meta.symbol} ILIMITADO` : `${fmt(v, meta.decimals)} ${meta.symbol}`);

// ─── check_transaction ──────────────────────────────────────────────────────────────────────────────────────────

const PROBE_ABI = parseAbi([
  "struct Result { bool ok; bytes revertData; uint256 nativeBefore; uint256 nativeAfter; uint256[] before; uint256[] afterwards; uint256[] allowanceBefore; uint256[] allowanceAfter; uint256 gasUsed; }",
  "function probe(address target, bytes data, uint256 value, address[] tokens, address[] allowTokens, address[] allowSpenders) returns (Result r)",
]);

/**
 * Before the user signs a transaction from ANY dApp: decode it, run it as the user against live state, and say what it
 * would do — tokens out and in, native coin out, allowances it would grant — with risk flags and a verdict.
 * @param rpc viem client on the current network (state overrides) · @param chain reader (MCP or RPC)
 */
export async function checkTransaction({ rpc, chain }, { user, to, data = "0x", value = 0n }) {
  const u = getAddress(user);
  const target = await whoIs(chain, to);
  const call = await decodeCall(target.address, data);
  const flags = [];
  const flag = (severity, text, pt) => flags.push({ severity, text, pt: pt ?? text });

  // tokens to watch: Warden's known tokens, the target itself if it is a token, and any address argument that is one
  const argAddrs = (call.args ?? []).flat(2).filter((x) => typeof x === "string" && isAddress(x)).map((x) => getAddress(x));
  const candidates = [...new Set([...knownTokens().map((t) => t.address), target.address, ...argAddrs])];
  const metas = await Promise.all(candidates.map((a) => tokenMeta(chain, a).catch(() => ({ isToken: false }))));
  const tokens = candidates.filter((a, i) => metas[i].known || metas[i].isToken);
  // allowance pairs: what the user's tokens would allow the target (and an approve's spender) to take
  const spenders = [...new Set([target.address, ...(call.name === "approve" || call.name === "increaseAllowance" ? [getAddress(call.args[0])] : [])])];
  const pairs = tokens.flatMap((t) => spenders.filter((s) => s !== t).map((s) => [t, s]));

  let sim = null;
  try {
    const raw = await rpc.call({
      to: u,
      data: encodeFunctionData({ abi: PROBE_ABI, functionName: "probe", args: [target.address, data, BigInt(value), tokens, pairs.map((p) => p[0]), pairs.map((p) => p[1])] }),
      stateOverride: [{ address: u, code: SIM_PROBE_CODE }],
      gas: 30_000_000n,
    });
    sim = decodeFunctionResult({ abi: PROBE_ABI, functionName: "probe", data: raw.data });
  } catch (e) {
    const why = String(e.shortMessage ?? e.message).split("\n")[0].slice(0, 120);
    flag("medium", `the simulation itself could not run (${why}) — judge from the decoded call only`, `a própria simulação não rodou (${why}) — avalie só pela chamada decodificada`);
  }

  const changes = [];
  const allowances = [];
  if (sim) {
    const nativeDelta = sim.nativeAfter - sim.nativeBefore;
    if (nativeDelta !== 0n) changes.push({ token: net().native, delta: nativeDelta, text: `${nativeDelta < 0n ? "−" : "+"}${fmt(nativeDelta < 0n ? -nativeDelta : nativeDelta, 18)} ${net().native}` });
    for (let i = 0; i < tokens.length; i++) {
      const d = sim.afterwards[i] - sim.before[i];
      if (d === 0n) continue;
      const m = await tokenMeta(chain, tokens[i]);
      changes.push({ token: m.symbol, address: tokens[i], delta: d, text: `${d < 0n ? "−" : "+"}${fmt(d < 0n ? -d : d, m.decimals)} ${m.symbol}` });
    }
    for (let i = 0; i < pairs.length; i++) {
      if (sim.allowanceAfter[i] <= sim.allowanceBefore[i]) continue;
      const m = await tokenMeta(chain, pairs[i][0]);
      const who = pairs[i][1] === target.address ? target : await whoIs(chain, pairs[i][1]);
      allowances.push({ token: m.symbol, spender: who.address, spenderIs: who.label, amount: sim.allowanceAfter[i], text: `${who.name ?? short(who.address)} may take ${amountText(sim.allowanceAfter[i], m)}`, pt: `${who.name ?? short(who.address)} poderá tirar ${amountPt(sim.allowanceAfter[i], m)}` });
    }
  }

  // ── risk flags ──
  if (!target.isContract && data !== "0x") flag("critical", `the target ${short(target.address)} has no contract code, but the transaction carries a contract call — a classic way to burn the fee or hide intent`, `o destino ${short(target.address)} não tem código de contrato, mas a transação leva uma chamada de contrato — jeito clássico de queimar a taxa ou esconder a intenção`);
  if (call.name === "approve" || call.name === "increaseAllowance") {
    const spender = await whoIs(chain, call.args[0]);
    const m = await tokenMeta(chain, target.address);
    const amt = BigInt(call.args[1]);
    if (!spender.isContract && amt > 0n) flag("critical", `it lets a plain wallet (${short(spender.address)}) take ${amountText(amt, m)} from you — approvals belong to protocol contracts; this is how drainers work`, `deixa uma carteira comum (${short(spender.address)}) tirar ${amountPt(amt, m)} de você — aprovações são para contratos de protocolo; é assim que drainers agem`);
    else if (amt >= UNLIMITED && !spender.name) flag("high", `UNLIMITED ${m.symbol} approval to ${spender.label} ${short(spender.address)} — if that contract is malicious or hacked, it can take all your ${m.symbol}, now and later`, `aprovação ILIMITADA de ${m.symbol} para ${spender.labelPt} ${short(spender.address)} — se esse contrato for malicioso ou hackeado, pode tirar todo o seu ${m.symbol}, agora e depois`);
    else if (amt >= UNLIMITED) flag("medium", `unlimited ${m.symbol} approval to ${spender.name} — a known contract, but an exact amount is safer`, `aprovação ilimitada de ${m.symbol} para ${spender.name} — contrato conhecido, mas um valor exato é mais seguro`);
  }
  if (call.name === "setApprovalForAll" && call.args[1] === true) {
    const op = await whoIs(chain, call.args[0]);
    flag(op.isContract && op.name ? "medium" : "critical", `it gives ${op.label} ${short(op.address)} control of ALL your NFTs in this collection`, `dá a ${op.labelPt} ${short(op.address)} controle de TODOS os seus NFTs desta coleção`);
  }
  if (call.name === "permit") flag("high", "it submits a token permit: check who the spender is and how much", "envia um permit de token: confira quem gasta e quanto");
  if (getAddress(target.address) === PERMIT2 && call.name === "approve") {
    const [tok, sp, amt] = call.args;
    const spender = await whoIs(chain, sp);
    const m = await tokenMeta(chain, tok);
    flag(spender.isContract ? (BigInt(amt) >= UNLIMITED_160 ? "high" : "medium") : "critical", `a Permit2 allowance: ${spender.label} ${short(spender.address)} may take ${BigInt(amt) >= UNLIMITED_160 ? `UNLIMITED ${m.symbol}` : `${fmt(amt, m.decimals)} ${m.symbol}`} through Permit2`, `uma permissão no Permit2: ${spender.labelPt} ${short(spender.address)} poderá tirar ${BigInt(amt) >= UNLIMITED_160 ? `${m.symbol} ILIMITADO` : `${fmt(amt, m.decimals)} ${m.symbol}`} pelo Permit2`);
  }
  if (call.name === "transfer" && target.isContract) {
    const dest = await whoIs(chain, call.args[0]);
    if (dest.name) flag("critical", `it sends tokens to the ${dest.name} contract — not a person: they would be lost`, `envia tokens para o contrato ${dest.name} — não é uma pessoa: eles se perderiam`);
  }
  if (sim && !sim.ok) {
    const why = await revertText(sim.revertData);
    flag("medium", `it would FAIL right now (${why}) — you would pay the fee for nothing`, `FALHARIA agora (${why}) — você pagaria a taxa à toa`);
  }
  if (sim?.ok) {
    const out = changes.filter((c) => c.delta < 0n);
    const inn = changes.filter((c) => c.delta > 0n);
    const isPayment = ["transfer", "transferWithAuthorization"].includes(call.name) || (call.plain && BigInt(value) > 0n);
    if (out.length && !inn.length && !isPayment && !allowances.length) flag("high", `you would give ${out.map((c) => c.text.slice(1)).join(" + ")} and receive nothing back that Warden can see`, `você daria ${out.map((c) => c.text.slice(1)).join(" + ")} e não receberia nada de volta que o Warden consiga ver`);
  }
  if (!call.name && data !== "0x") flag("medium", `unknown function ${call.selector}: nobody can say from the calldata what it does — rely on the simulation above`, `função desconhecida ${call.selector}: pela calldata ninguém sabe o que ela faz — confie na simulação acima`);
  else if (call.source?.startsWith("OpenChain")) flag("info", `function looked up by name only (${call.signature}) — the name is a guess from a public database`, `função identificada só pelo nome (${call.signature}) — o nome é um palpite de uma base pública`);
  if (target.delegated) flag("info", "the target is a wallet with an EIP-7702 delegation", "o destino é uma carteira com delegação EIP-7702");
  if (BigInt(value) > 0n) flag("info", `it sends ${fmt(value, 18)} ${net().native} with the call`, `envia ${fmt(value, 18)} ${net().native} junto com a chamada`);

  return {
    network: net().name,
    target: { address: target.address, is: target.label, isPt: target.labelPt },
    call: call.plain ? `plain ${net().native} transfer` : call.name ? `${call.name}(${(call.args ?? []).map(argText).join(", ")})` : `unknown ${call.selector}`,
    decodedFrom: call.source ?? "plain transfer",
    simulation: sim ? { ran: true, wouldSucceed: sim.ok, gas: Number(sim.gasUsed), changes: changes.map((c) => c.text), newAllowances: allowances.map((a) => a.text), newAllowancesPt: allowances.map((a) => a.pt) } : { ran: false },
    flags,
    verdict: verdictOf(flags),
    assumed: "simulated with your address running a probe contract (eth_call state override): contracts that refuse callers with code would behave differently",
    raw: { changes, allowances },
  };
}

// ─── check_signature ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * An EIP-712 signature request, read before the user signs it. Off-chain signatures move funds without a
 * transaction (Permit, Permit2, EIP-3009) — the drainer's favourite — and no simulator sees them.
 */
export async function checkSignature({ chain }, { user, typedData }) {
  let td = typedData;
  if (typeof td === "string") {
    try {
      td = JSON.parse(td);
    } catch {
      return { verdict: "caution", flags: [{ severity: "medium", text: "this is not valid JSON typed data — paste exactly what the wallet shows (eth_signTypedData_v4)", pt: "isto não é typed data em JSON válido — cole exatamente o que a carteira mostra (eth_signTypedData_v4)" }] };
    }
  }
  const flags = [];
  const flag = (severity, text, pt) => flags.push({ severity, text, pt: pt ?? text });
  const domain = td.domain ?? {};
  const msg = td.message ?? {};
  const type = td.primaryType ?? "?";
  const u = user ? getAddress(user) : null;
  const vc = domain.verifyingContract && isAddress(domain.verifyingContract) ? getAddress(domain.verifyingContract) : null;
  const deadlineText = (s) => {
    const t = Number(s);
    if (!t) return "no deadline";
    if (t > 1e11 || t > Date.now() / 1000 + 365 * 86400) return "no practical deadline (years)";
    return new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  };
  const untilText = (s) => (Number(s) === 0 ? "with no deadline" : `until ${deadlineText(s)}`);
  const deadlinePt = (s) => {
    const t = Number(s);
    if (!t) return "sem prazo";
    if (t > 1e11 || t > Date.now() / 1000 + 365 * 86400) return "sem prazo na prática (anos)";
    return new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  };
  const untilPt = (s) => (Number(s) === 0 ? "sem prazo" : `até ${deadlinePt(s)}`);
  let whatPt = null;
  const longLived = (s) => Number(s) === 0 || Number(s) > Date.now() / 1000 + 30 * 86400;
  if (domain.chainId != null && Number(domain.chainId) !== net().chainId) flag("critical", `it is for chain ${domain.chainId}, not ${net().name} (${net().chainId}) — a signature for another chain is a red flag`, `é para a chain ${domain.chainId}, não para a ${net().name} (${net().chainId}) — assinatura para outra chain é sinal de alerta`);
  let what = `${type} on ${vc ? contractName(vc) ?? short(vc) : domain.name ?? "an unknown contract"}`;

  const checkSpender = async (sp, amountLabel, unlimited) => {
    const s = await whoIs(chain, sp);
    if (s.address === net().warden) return;
    const labelPt = amountLabel.replace(/UNLIMITED (\S+)/, "$1 ILIMITADO");
    if (!s.isContract) flag("critical", `it lets a plain wallet (${short(s.address)}) take ${amountLabel} — approvals belong to protocol contracts; this is a drainer pattern`, `deixa uma carteira comum (${short(s.address)}) tirar ${labelPt} — aprovações são para contratos de protocolo; é padrão de drainer`);
    else if (unlimited && !s.name) flag("high", `${amountLabel} for ${s.label} ${short(s.address)}`, `${labelPt} para ${s.labelPt} ${short(s.address)}`);
    else if (unlimited) flag("medium", `${amountLabel} for ${s.name} — an exact amount is safer`, `${labelPt} para ${s.name} — um valor exato é mais seguro`);
    else if (!s.name) flag("medium", `the spender ${short(s.address)} is a contract Warden does not know`, `quem gasta (${short(s.address)}) é um contrato que o Warden não conhece`);
  };

  if (type === "Permit" && msg.spender != null) {
    // EIP-2612: the token itself is the verifying contract
    const m = vc ? await tokenMeta(chain, vc) : { symbol: "tokens", decimals: 18 };
    const v = BigInt(msg.value ?? 0);
    what = `Token permit: ${short(getAddress(msg.spender))} may spend ${amountText(v, m)} of yours, ${untilText(msg.deadline)}`;
    whatPt = `Permit de token: ${short(getAddress(msg.spender))} poderá gastar ${amountPt(v, m)} seus, ${untilPt(msg.deadline)}`;
    await checkSpender(msg.spender, amountText(v, m), v >= UNLIMITED);
    if (longLived(msg.deadline)) flag("medium", "the permit stays valid for a long time", "o permit fica válido por muito tempo");
    if (u && msg.owner && getAddress(msg.owner) !== u) flag("high", `the owner in the permit (${short(getAddress(msg.owner))}) is not your connected wallet`, `o dono no permit (${short(getAddress(msg.owner))}) não é a sua carteira conectada`);
  } else if (vc === PERMIT2 && (type === "PermitSingle" || type === "PermitBatch")) {
    const details = type === "PermitSingle" ? [msg.details] : msg.details ?? [];
    const parts = [];
    for (const d of details) {
      const m = await tokenMeta(chain, d.token);
      const a = BigInt(d.amount ?? 0);
      parts.push(a >= UNLIMITED_160 ? `UNLIMITED ${m.symbol}` : `${fmt(a, m.decimals)} ${m.symbol}`);
      await checkSpender(msg.spender, a >= UNLIMITED_160 ? `UNLIMITED ${m.symbol}` : `${fmt(a, m.decimals)} ${m.symbol}`, a >= UNLIMITED_160);
      if (longLived(d.expiration)) flag("medium", Number(d.expiration) === 0 ? `the ${m.symbol} allowance never expires` : `the ${m.symbol} allowance lasts until ${deadlineText(d.expiration)}`, Number(d.expiration) === 0 ? `a permissão de ${m.symbol} nunca expira` : `a permissão de ${m.symbol} dura até ${deadlinePt(d.expiration)}`);
    }
    what = `Permit2 allowance: ${short(getAddress(msg.spender))} may take ${parts.join(" + ")} whenever it wants, until the allowance expires`;
    whatPt = `Permissão no Permit2: ${short(getAddress(msg.spender))} poderá tirar ${parts.map((x) => x.replace(/UNLIMITED (\S+)/, "$1 ILIMITADO")).join(" + ")} quando quiser, até a permissão expirar`;
  } else if (vc === PERMIT2 && /^Permit(Batch)?(Witness)?TransferFrom$/.test(type)) {
    const permitted = Array.isArray(msg.permitted) ? msg.permitted : [msg.permitted];
    const parts = [];
    for (const p of permitted) {
      const m = await tokenMeta(chain, p.token);
      parts.push(`${fmt(BigInt(p.amount ?? 0), m.decimals)} ${m.symbol}`);
    }
    const spender = getAddress(msg.spender);
    if (spender === net().warden && msg.witness) {
      what = `A Warden intent: Warden may take exactly ${parts.join(" + ")}, once, and must deliver the guarantees you sign (outs and payments) or revert`;
      whatPt = `Uma intenção do Warden: o Warden pode tirar exatamente ${parts.join(" + ")}, uma vez, e precisa entregar as garantias que você assina (mínimos e pagamentos) ou reverter`;
      flag("info", "recognised: this is Warden's own signature format", "reconhecido: é o formato de assinatura do próprio Warden");
      if (u && msg.witness.user && getAddress(msg.witness.user) !== u) flag("critical", "the intent's user is not your connected wallet", "o usuário da intenção não é a sua carteira conectada");
    } else {
      what = `One-time Permit2 transfer: ${short(spender)} may take exactly ${parts.join(" + ")}, once, ${untilText(msg.deadline)}`;
      whatPt = `Transferência única pelo Permit2: ${short(spender)} pode tirar exatamente ${parts.join(" + ")}, uma vez, ${untilPt(msg.deadline)}`;
      await checkSpender(spender, parts.join(" + "), false);
    }
  } else if (type === "TransferWithAuthorization" || type === "ReceiveWithAuthorization") {
    const m = vc ? await tokenMeta(chain, vc) : { symbol: "tokens", decimals: 6 };
    const to = await whoIs(chain, msg.to);
    what = `A signed payment (EIP-3009): ${fmt(BigInt(msg.value ?? 0), m.decimals)} ${m.symbol} to ${to.name ?? short(to.address)}, valid ${untilText(msg.validBefore)}`;
    whatPt = `Um pagamento assinado (EIP-3009): ${fmt(BigInt(msg.value ?? 0), m.decimals)} ${m.symbol} para ${to.name ?? short(to.address)}, válido ${untilPt(msg.validBefore)}`;
    flag("info", "a payment signature moves the tokens as soon as anyone submits it — sign only if you mean to pay this exact amount to this address", "uma assinatura de pagamento move os tokens assim que alguém a enviar — assine só se quiser pagar exatamente este valor para este endereço");
    if (to.name) flag("critical", `the payee is the ${to.name} contract — not a person`, `o destinatário é o contrato ${to.name} — não é uma pessoa`);
    if (u && msg.from && getAddress(msg.from) !== u) flag("high", "the payer in the signature is not your connected wallet", "quem paga na assinatura não é a sua carteira conectada");
  } else if (type === "OrderComponents" || /seaport/i.test(domain.name ?? "")) {
    const consideration = msg.consideration ?? [];
    const toOthers = consideration.filter((c) => u && c.recipient && getAddress(c.recipient) !== u);
    what = `A marketplace order (Seaport): it lists ${(msg.offer ?? []).length} of your item(s)`;
    whatPt = `Uma ordem de marketplace (Seaport): ela anuncia ${(msg.offer ?? []).length} item(ns) seu(s)`;
    const allOthers = toOthers.length === consideration.length && consideration.length > 0;
    flag(allOthers ? "critical" : "high", allOthers ? "none of the payment goes to you — a classic fake-listing drain" : "check the price: a signed listing can be filled by anyone", allOthers ? "nada do pagamento vai para você — golpe clássico de anúncio falso" : "confira o preço: um anúncio assinado pode ser executado por qualquer um");
  } else {
    flag("medium", `an unrecognised signature (${type}) — it may authorise anything the contract ${vc ? short(vc) : ""} accepts; sign only if you know exactly what it does`, `uma assinatura não reconhecida (${type}) — pode autorizar qualquer coisa que o contrato ${vc ? short(vc) : ""} aceite; assine só se souber exatamente o que ela faz`);
  }
  return { network: net().name, request: what, requestPt: whatPt ?? what, verifyingContract: vc ? { address: vc, is: contractName(vc) ?? "not a contract Warden knows" } : null, flags, verdict: verdictOf(flags) };
}

// ─── scan_approvals / revoke ────────────────────────────────────────────────────────────────────────────────────

/** Spenders every scan checks: the ones Warden knows on this network. */
function knownSpenders() {
  const n = net();
  return [PERMIT2, n.warden, ...(n.faroswap ? [n.faroswap.dodoApprove, n.faroswap.routeProxy] : []), ...n.protocols.flatMap((p) => [p.vault, p.pool].filter(Boolean))];
}

/**
 * Live allowances of a wallet: every known token × every known spender, plus every (token, spender) the wallet
 * approved in the last `windows` × 1,000 blocks (ERC-20 Approval events from any token, Permit2 Approval/Permit).
 */
export async function scanApprovals({ chain }, { user, windows = 12 }) {
  const u = getAddress(user);
  const latest = Number((await chain.block()).number);
  const ownerTopic = pad(u, { size: 32 }).toLowerCase();
  const ranges = Array.from({ length: windows }, (_, i) => [latest - (i + 1) * 1000 + 1, latest - i * 1000]);
  const erc20Pairs = new Map(); // token|spender → source
  const permit2Pairs = new Map();
  for (const t of knownTokens()) for (const s of knownSpenders()) if (s !== t.address) erc20Pairs.set(`${t.address}|${s}`, "known");

  let scanned = 0;
  let failedWindows = 0;
  // One query per window: ERC-20 Approval from ANY token (the discovery part) and Permit2's Approval / Permit —
  // all three have the owner as their first indexed topic. A few at a time: public endpoints throttle bursts.
  const results = await pool(ranges, 3, async ([a, b]) => {
    try {
      const logs = await chain.logs({ topics: [[APPROVAL_TOPIC, PERMIT2_APPROVAL_TOPIC, PERMIT2_PERMIT_TOPIC], ownerTopic], fromBlock: a, toBlock: b });
      const fromPermit2 = (l) => getAddress(l.address) === PERMIT2 && l.topics[0] !== APPROVAL_TOPIC;
      return { erc20: logs.filter((l) => l.topics[0] === APPROVAL_TOPIC), p2: logs.filter(fromPermit2) };
    } catch {
      failedWindows++;
      return { erc20: [], p2: [] };
    }
  });
  {
    for (const r of results) {
      for (const l of r.erc20) {
        if (l.topics.length !== 3) continue; // ERC-721 Approval has the token id indexed too
        scanned++;
        erc20Pairs.set(`${getAddress(l.address)}|${getAddress(`0x${l.topics[2].slice(26)}`)}`, "recent Approval event");
      }
      for (const l of r.p2) {
        scanned++;
        permit2Pairs.set(`${getAddress(`0x${l.topics[2].slice(26)}`)}|${getAddress(`0x${l.topics[3].slice(26)}`)}`, "recent Permit2 event");
      }
    }
  }

  const live = [];
  const now = Math.floor(Date.now() / 1000);
  const calls = [
    ...[...erc20Pairs].map(([key, source]) => {
      const [token, spender] = key.split("|");
      return { kind: "erc20", token, spender, source, to: token, abi: ABI.erc20, args: [u, spender] };
    }),
    ...[...permit2Pairs].map(([key, source]) => {
      const [token, spender] = key.split("|");
      return { kind: "permit2", token, spender, source, to: PERMIT2, abi: PERMIT2_ABI, args: [u, token, spender] };
    }),
  ];
  const keep = (c, r) => {
    const [amount, expiration] = c.kind === "erc20" ? [r, null] : r;
    if (amount > 0n && (c.kind === "erc20" || Number(expiration) > now)) live.push({ kind: c.kind, token: c.token, spender: c.spender, amount, ...(c.kind === "permit2" && { expiration: Number(expiration) }), source: c.source });
  };
  // every allowance in one Multicall3 call per 60 (deployed on both Pharos networks); one by one if that fails
  let batched = true;
  for (let i = 0; i < calls.length && batched; i += 60) {
    const part = calls.slice(i, i + 60);
    try {
      const res = await chain.read(MULTICALL3, MULTICALL3_ABI, "aggregate3", [part.map((c) => ({ target: getAddress(c.to), allowFailure: true, callData: encodeFunctionData({ abi: c.abi, functionName: "allowance", args: c.args }) }))]);
      res.forEach(({ success, returnData }, k) => {
        if (success && returnData !== "0x") keep(part[k], decodeFunctionResult({ abi: part[k].abi, functionName: "allowance", data: returnData }));
      });
    } catch {
      batched = false;
      live.length = 0;
    }
  }
  if (!batched) {
    await pool(calls, 8, async (c) => {
      const r = await chain.read(c.to, c.abi, "allowance", c.args).catch(() => null);
      if (r != null) keep(c, r);
    });
  }

  const rows = [];
  for (const a of live) {
    const [m, who] = await Promise.all([tokenMeta(chain, a.token), whoIs(chain, a.spender)]);
    const unlimited = a.kind === "erc20" ? a.amount >= UNLIMITED : a.amount >= UNLIMITED_160;
    let risk = "low";
    let why = `${who.name ?? who.label}`;
    let whyPt = `${who.name ?? who.labelPt}`;
    if (!who.isContract) {
      risk = "critical";
      why = "a plain wallet can take these tokens — revoke now";
      whyPt = "uma carteira comum pode tirar estes tokens — revogue agora";
    } else if (!who.name && unlimited) {
      risk = "high";
      why = "unlimited, to a contract Warden does not know";
      whyPt = "ilimitada, para um contrato que o Warden não conhece";
    } else if (!who.name) {
      risk = "medium";
      why = "a contract Warden does not know";
      whyPt = "um contrato que o Warden não conhece";
    } else if (unlimited) {
      risk = "medium";
      why = `${who.name}, but unlimited`;
      whyPt = `${who.name}, mas ilimitada`;
    }
    if (a.spender === PERMIT2 && a.kind === "erc20") {
      risk = unlimited ? "medium" : "low";
      why = unlimited ? "Permit2 (canonical) with an unlimited approval: anything signed later through Permit2 can use it" : "Permit2 (canonical), exact amount — what Warden's one-time step sets";
      whyPt = unlimited ? "Permit2 (canônico) com aprovação ilimitada: qualquer coisa assinada depois pelo Permit2 pode usá-la" : "Permit2 (canônico), valor exato — o que o passo único do Warden define";
    }
    rows.push({
      kind: a.kind,
      token: m.symbol,
      tokenAddress: a.token,
      spender: a.spender,
      spenderIs: who.name ?? who.label,
      spenderIsPt: who.name ?? who.labelPt,
      amount: unlimited ? "unlimited" : fmt(a.amount, m.decimals),
      ...(a.expiration && { expires: new Date(a.expiration * 1000).toISOString().slice(0, 10) }),
      risk,
      why,
      whyPt,
      found: a.source,
    });
  }
  rows.sort((x, y) => SEV[y.risk === "low" ? "info" : y.risk] - SEV[x.risk === "low" ? "info" : x.risk]);
  const hours = Math.round((windows * 1000 * net().blockTime) / 3600);
  const from = ranges.at(-1)[0];
  return {
    network: net().name,
    wallet: u,
    approvals: rows,
    coverage: `${knownTokens().length} known token(s) × ${knownSpenders().length} known spender(s), plus ${scanned} Approval event(s) of yours in blocks ${from}–${latest} (the last ~${hours} h)${failedWindows ? `; ${failedWindows} window(s) could not be read` : ""}. Older approvals to unknown spenders are outside this scan.`,
    coveragePt: `${knownTokens().length} token(s) conhecido(s) × ${knownSpenders().length} spender(s) conhecido(s), mais ${scanned} evento(s) Approval seus nos blocos ${from}–${latest} (as últimas ~${hours} h)${failedWindows ? `; ${failedWindows} janela(s) não puderam ser lidas` : ""}. Aprovações mais antigas para spenders desconhecidos ficam fora desta varredura.`,
  };
}

/** The transaction that revokes one allowance: ERC-20 approve(spender, 0), or Permit2 lockdown for a Permit2 one. */
export function revokeTx({ kind, token, spender }) {
  return kind === "permit2"
    ? { to: PERMIT2, data: encodeFunctionData({ abi: PERMIT2_ABI, functionName: "lockdown", args: [[{ token: getAddress(token), spender: getAddress(spender) }]] }) }
    : { to: getAddress(token), data: encodeFunctionData({ abi: ABI.erc20, functionName: "approve", args: [getAddress(spender), 0n] }) };
}

// ─── explain_tx ─────────────────────────────────────────────────────────────────────────────────────────────────

const LOG_ABIS = [ABI.warden, PERMIT2_ABI, EVENT_ABI];

/** An ERC-4626 vault's assets in words: the vaults Warden knows hold USDC; any other vault's unit is not known here. */
const vaultAssets = (vault, assets) => (net().protocols.some((p) => p.vault === getAddress(vault)) ? `${fmt(assets, 6)} USDC` : `${assets} units of its asset`);

/** Decodes one log into a sentence, or null. */
async function describeLog(chain, log) {
  for (const abi of LOG_ABIS) {
    let ev;
    try {
      ev = decodeEventLog({ abi, data: log.data, topics: log.topics });
    } catch {
      continue;
    }
    const a = ev.args;
    const src = getAddress(log.address);
    const m = await tokenMeta(chain, src).catch(() => ({ symbol: short(src), decimals: 18 }));
    const tokMeta = async (t) => tokenMeta(chain, t).catch(() => ({ symbol: short(t), decimals: 18 }));
    const n = (x) => contractName(x) ?? short(getAddress(x));
    switch (ev.eventName) {
      case "Transfer":
        return { kind: "transfer", token: src, from: getAddress(a.from), to: getAddress(a.to), value: a.value, text: `${fmt(a.value, m.decimals)} ${m.symbol} from ${n(a.from)} to ${n(a.to)}` };
      case "Approval":
        if (src === PERMIT2) {
          const tm = await tokMeta(a.token);
          return { kind: "approval", text: `Permit2 allowance: ${n(a.spender)} may take ${a.amount >= UNLIMITED_160 ? "unlimited" : fmt(a.amount, tm.decimals)} ${tm.symbol}` };
        }
        return { kind: "approval", text: `${n(a.owner)} allowed ${n(a.spender)} to spend ${a.value >= UNLIMITED ? "UNLIMITED" : fmt(a.value, m.decimals)} ${m.symbol}` };
      case "ApprovalForAll":
        return { kind: "approval", text: `${n(a.owner)} ${a.approved ? "gave" : "removed"} ${n(a.operator)} control of all items of ${n(src)}` };
      case "Deposit":
        return a.wad != null ? { kind: "wrap", text: `wrapped ${fmt(a.wad, 18)} into ${m.symbol}` } : { kind: "deposit", text: `deposited ${vaultAssets(src, a.assets)} into ${n(src)} for ${fmt(a.shares, m.decimals)} shares` };
      case "Withdrawal":
        return { kind: "unwrap", text: `unwrapped ${fmt(a.wad, 18)} ${m.symbol}` };
      case "Withdraw":
        return { kind: "withdraw", text: `withdrew ${vaultAssets(src, a.assets)} from ${n(src)} (${fmt(a.shares, m.decimals)} shares burned)` };
      case "Spent": {
        const tm = await tokMeta(a.token);
        return { kind: "warden", text: `Warden took ${fmt(a.amount, tm.decimals)} ${tm.symbol} (signed input)` };
      }
      case "Paid": {
        const tm = await tokMeta(a.token);
        return { kind: "warden", text: `Warden paid exactly ${fmt(a.amount, tm.decimals)} ${tm.symbol} to ${short(getAddress(a.to))}` };
      }
      case "Delivered": {
        const tm = await tokMeta(a.token);
        return { kind: "warden", text: `guarantee kept: ${fmt(a.delta, tm.decimals)} ${tm.symbol} delivered (signed minimum ${fmt(a.minDelta, tm.decimals)})` };
      }
      case "Executed":
        return { kind: "warden", text: "Warden executed a signed intent" };
      case "Lockdown":
        return { kind: "revoke", text: `Permit2 allowance revoked for ${n(a.spender)}` };
      case "AuthorizationUsed":
        return { kind: "auth", text: `a signed EIP-3009 authorization of ${n(a.authorizer)} was used` };
      default:
        return { kind: "event", text: `${ev.eventName} on ${n(src)}` };
    }
  }
  return null;
}

/** Any transaction in plain words: who called what, every decoded event, the fee, and why it failed if it did. */
export async function explainTx({ chain }, { hash, user }) {
  const [tx, rc] = await Promise.all([chain.transaction(hash), chain.receipt(hash)]);
  if (!tx) return { found: false, network: net().name, text: `no transaction ${hash} on ${net().name} — wrong network, or not mined yet` };
  const from = getAddress(tx.from);
  const to = tx.to ? getAddress(tx.to) : null;
  const call = to ? await decodeCall(to, tx.input) : { name: "contract creation" };
  const status = !rc ? "pending" : BigInt(rc.status) === 1n ? "success" : "failed";
  const fee = rc ? BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice ?? tx.gasPrice ?? 0) : null;
  const events = [];
  for (const l of rc?.logs ?? []) {
    const d = await describeLog(chain, l);
    events.push(d ?? { kind: "unknown", text: `an event on ${contractName(l.address) ?? short(getAddress(l.address))} Warden cannot decode (${l.topics[0]?.slice(0, 10)})` });
  }
  let failure = null;
  if (status === "failed") {
    const replay = await chain.callRaw({ from, to, data: tx.input, value: BigInt(tx.value ?? 0), block: Number(BigInt(rc.blockNumber)) - 1 });
    failure = replay.ok ? "it did not revert when replayed on the previous block — it probably ran out of gas or depended on something earlier in its block" : await revertText(replay.revertData);
  }
  const u = user ? getAddress(user) : from;
  const mine = events.filter((e) => e.kind === "transfer" && (e.from === u || e.to === u));
  return {
    found: true,
    network: net().name,
    status,
    from,
    to: to ? `${contractName(to) ?? short(to)} (${to})` : null,
    call: call.name ? `${call.name}${call.source?.startsWith("OpenChain") ? " (name from a public database)" : ""}` : call.plain ? `plain ${net().native} transfer` : `unknown ${call.selector}`,
    value: `${fmt(BigInt(tx.value ?? 0), 18)} ${net().native}`,
    fee: fee != null ? `${fmt(fee, 18, 8)} ${net().native}` : null,
    block: rc ? Number(BigInt(rc.blockNumber)) : null,
    events: events.map((e) => e.text),
    forThisWallet: mine.map((e) => `${e.to === u ? "+" : "−"}${e.text.split(" from ")[0]}`),
    ...(failure && { whyItFailed: failure }),
    explorer: `${net().explorer}/tx/${hash}`,
  };
}
