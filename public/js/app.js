import { Wallet, availableWallets, executeCalldata } from "./wallet.js";

// ─── i18n ──────────────────────────────────────────────────────────────────────────────────────────────────────
const T = {
  en: {},
  pt: {
    connect: "Conectar carteira",
    h1: "Um agente de IA que não consegue te fazer perder mais do que você assinou.",
    lead: "Peça em palavras simples. O Warden lê a Pharos, decide e prepara uma transação. Você assina as garantias dela — <em>gastar no máximo isto, receber no mínimo aquilo</em> — na sua própria carteira, e o contrato Warden reverte tudo se alguma garantia falhar. Antes de você assinar qualquer coisa em outro dApp, ele simula para você.",
    f1t: "Pedir", f1: "“Pague 3 pessoas numa assinatura” · “Isto é seguro de assinar?”",
    f2t: "O agente lê e decide", f2: "Chain MCP · Docs MCP · SkillEngine · ProsPilot",
    f3t: "Simulação", f3: "a transação exata, antes de você assinar",
    f4t: "Você assina as garantias", f4: "na sua carteira · nenhuma chave sai dela",
    f5t: "O Warden garante", f5: "on-chain · ou nada se move",
    agentTitle: "Agente Warden", newChat: "Nova conversa", send: "Enviar",
    placeholder: "Pergunte ao Warden… ex.: “Pague 2 USDC para 0x…”",
    walletTitle: "Sua carteira", walletEmpty: "Conecte uma carteira para ver saldos, posições e seus limites no Warden.",
    ratesTitle: "Rendimento em USDC na Pacific Mainnet · últimos 7 dias", ratesNote: "Realizado: preços de cota e índices de renda on-chain com 7 dias de diferença, lidos pelo Pharos Chain MCP.",
    contractTitle: "O contrato", arch: "Arquitetura",
    spendMax: "Você gasta no máximo", getMin: "Você recebe no mínimo",
  },
};
const DYN = {
  en: {
    chips: {
      atlantic: ["What's in my wallet?", "Set up my Warden limits", "Pay 1 USDC to 0x08cd62babd8Dac7404504792Df30C12fC5384Df5 and 0.5 USDC to 0xBBAE53F01f89C0075Ac780c35a7c7D3fB7C0ab33", "Scan my token approvals", "Is this safe to sign? to 0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B data 0x095ea7b300000000000000000000000008cd62babd8dac7404504792df30c12fc5384df5ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"],
      pacific: ["What's in my wallet?", "Where does USDC earn the most right now?", "Swap 5 USDC to WPROS", "Scan my token approvals", "Is 0x08cd62babd8Dac7404504792Df30C12fC5384Df5 safe to pay?"],
    },
    connectFirst: "Connect your wallet to let the agent prepare transactions for you. You can still ask questions.",
    noWallet: "No browser wallet found. Install MetaMask, Rabby or OKX Wallet.",
    pays: "Pays exactly", guaranteed: "Guaranteed", dryOk: "Dry run of the exact transaction passed", dryBad: "Dry run failed", gas: "gas", assumed: "Assumed in the dry run", fee: "Network fee",
    approve: "Approve", sign: "Sign the guarantees", sendWarden: "Send to Warden", sendTx: "Send in wallet", askPolicy: "Ask the agent to set it up",
    signed: "Signed", sent: "Sent", waiting: "Waiting for the receipt…", verified: "Verified on chain", reverted: "Reverted on chain — nothing moved",
    rejected: "You rejected it in the wallet.", expired: "This proposal has expired — ask the agent again for fresh numbers.",
    guaranteesHeld: "Every guarantee held", guaranteeFailed: "A guarantee did not hold", explorer: "explorer",
    verifyMsg: (h) => `I sent the transaction ${h}. Please verify it.`, received: "received", minimum: "minimum",
    gasLabel: (n) => `${n} (gas)`, limits: "Warden limits", leftToday: "left today", perAction: "per action", noPolicy: "No Warden policy yet — ask the agent to set one up.", paused: "Paused", pause: "Pause Warden", unpause: "Unpause", protocols: "Protocols", none: "none",
    offline: "The agent is offline on this deployment (no model key). The wallet and yields panels still work.",
    stopped: "Stopped.", policyNeeded: "Needs your Warden policy first", calls: "reads",
    warn: { pacific: "Pharos Pacific Mainnet · real funds. Check what your wallet shows before you sign.", atlantic: "Pharos Atlantic Testnet · test funds with no value. Your wallet will switch to Atlantic to sign." },
    fine: { pacific: "Pacific Mainnet, real funds. The agent never holds a key; every transaction is signed by you, and Warden reverts it unless every guarantee holds.", atlantic: "Atlantic Testnet: free test USDC from faucet.circle.com (network “Pharos Testnet”). The agent never holds a key; every transaction is signed by you, and Warden reverts it unless every guarantee holds." },
    switched: (n) => `Now on ${n}. New conversation.`,
    assume: { allowance: (s) => `your ${s} approval to Permit2 (the one-time step below)`, balance: (s) => `a ${s} balance of the amount to spend`, policy: () => "the Warden policy proposed above (not set yet)" },
    verdict: { do_not_sign: "Do not sign", high_risk: "High risk", caution: "Caution", looks_ok: "Looks OK" },
    risk: { critical: "critical", high: "high", medium: "medium", low: "low" },
    checkTx: "Transaction check", checkSig: "Signature check", simRan: "Simulated as you", wouldFail: "would fail", noChange: "no balance change", newAllowance: "new allowance",
    approvalsTitle: "Your token approvals", noApprovals: "No open approvals found.", revoke: "Revoke", revokeAsk: (t, s, k) => `Revoke the ${t} allowance of ${s} (${k})`,
  },
  pt: {
    chips: {
      atlantic: ["O que tem na minha carteira?", "Configure meus limites no Warden", "Pague 1 USDC para 0x08cd62babd8Dac7404504792Df30C12fC5384Df5 e 0,5 USDC para 0xBBAE53F01f89C0075Ac780c35a7c7D3fB7C0ab33", "Verifique minhas aprovações de tokens", "Isto é seguro de assinar? to 0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B data 0x095ea7b300000000000000000000000008cd62babd8dac7404504792df30c12fc5384df5ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"],
      pacific: ["O que tem na minha carteira?", "Onde o USDC rende mais agora?", "Troque 5 USDC por WPROS", "Verifique minhas aprovações de tokens", "É seguro pagar 0x08cd62babd8Dac7404504792Df30C12fC5384Df5?"],
    },
    connectFirst: "Conecte sua carteira para o agente preparar transações para você. Você ainda pode fazer perguntas.",
    noWallet: "Nenhuma carteira encontrada no navegador. Instale MetaMask, Rabby ou OKX Wallet.",
    pays: "Paga exatamente", guaranteed: "Garantido", dryOk: "Simulação da transação exata passou", dryBad: "A simulação falhou", gas: "gás", assumed: "Suposto na simulação", fee: "Taxa da rede",
    approve: "Aprovar", sign: "Assinar as garantias", sendWarden: "Enviar ao Warden", sendTx: "Enviar na carteira", askPolicy: "Pedir ao agente para configurar",
    signed: "Assinado", sent: "Enviado", waiting: "Aguardando o recibo…", verified: "Verificado na chain", reverted: "Revertida na chain — nada se moveu",
    rejected: "Você recusou na carteira.", expired: "Esta proposta expirou — peça de novo ao agente para números atualizados.",
    guaranteesHeld: "Todas as garantias se cumpriram", guaranteeFailed: "Uma garantia não se cumpriu", explorer: "explorador",
    verifyMsg: (h) => `Enviei a transação ${h}. Por favor, verifique.`, received: "recebido", minimum: "mínimo",
    gasLabel: (n) => `${n} (gás)`, limits: "Limites no Warden", leftToday: "restam hoje", perAction: "por ação", noPolicy: "Ainda sem política no Warden — peça ao agente para configurar.", paused: "Pausado", pause: "Pausar o Warden", unpause: "Retomar", protocols: "Protocolos", none: "nenhum",
    offline: "O agente está desligado neste deploy (sem chave do modelo). Os painéis de carteira e rendimento continuam funcionando.",
    stopped: "Interrompido.", policyNeeded: "Precisa da sua política no Warden antes", calls: "leituras",
    warn: { pacific: "Pharos Pacific Mainnet · fundos reais. Confira o que a carteira mostrar antes de assinar.", atlantic: "Pharos Atlantic Testnet · fundos de teste, sem valor. Sua carteira vai trocar para a Atlantic para assinar." },
    fine: { pacific: "Pacific Mainnet, fundos reais. O agente nunca guarda chave; toda transação é assinada por você, e o Warden reverte se alguma garantia não se cumprir.", atlantic: "Atlantic Testnet: USDC de teste grátis em faucet.circle.com (rede “Pharos Testnet”). O agente nunca guarda chave; toda transação é assinada por você, e o Warden reverte se alguma garantia não se cumprir." },
    switched: (n) => `Agora na ${n}. Nova conversa.`,
    assume: { allowance: (s) => `sua aprovação de ${s} ao Permit2 (o passo único abaixo)`, balance: (s) => `um saldo de ${s} no valor a gastar`, policy: () => "a política do Warden proposta acima (ainda não definida)" },
    verdict: { do_not_sign: "Não assine", high_risk: "Risco alto", caution: "Atenção", looks_ok: "Parece OK" },
    risk: { critical: "crítico", high: "alto", medium: "médio", low: "baixo" },
    checkTx: "Checagem de transação", checkSig: "Checagem de assinatura", simRan: "Simulado como você", wouldFail: "falharia", noChange: "nenhuma mudança de saldo", newAllowance: "nova permissão",
    approvalsTitle: "Suas aprovações de tokens", noApprovals: "Nenhuma aprovação aberta encontrada.", revoke: "Revogar", revokeAsk: (t, s, k) => `Revogue a permissão de ${t} de ${s} (${k})`,
  },
};
let lang = (() => {
  try { return localStorage.getItem("lang") || (navigator.language?.startsWith("pt") ? "pt" : "en"); } catch { return "en"; }
})();
const d = (k) => DYN[lang][k] ?? DYN.en[k];
const EN = {};
document.querySelectorAll("[data-i]").forEach((el) => (EN[el.dataset.i] = el.innerHTML));
const enPlaceholder = document.getElementById("input").placeholder;
function applyLang() {
  document.documentElement.lang = lang === "pt" ? "pt-BR" : "en";
  document.querySelectorAll("[data-i]").forEach((el) => (el.innerHTML = (lang === "pt" && T.pt[el.dataset.i]) || EN[el.dataset.i] || el.innerHTML));
  $("input").placeholder = lang === "pt" ? T.pt.placeholder : enPlaceholder;
  document.querySelectorAll("[data-lang]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lang === lang)));
  applyNetwork();
  if (lastRates) renderRates(lastRates);
  if (!wallet) $("connect").textContent = lang === "pt" ? T.pt.connect : EN.connect;
}
document.querySelectorAll("[data-lang]").forEach((b) => b.addEventListener("click", () => { lang = b.dataset.lang; try { localStorage.setItem("lang", lang); } catch {} applyLang(); }));

// ─── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
let info = { networks: [], defaultNetwork: "atlantic" };
const netInfo = (key = network) => info.networks.find((n) => n.key === key) ?? { key, tokens: [], protocols: [], native: key === "pacific" ? "PROS" : "PHRS", explorer: key === "pacific" ? "https://www.pharosscan.xyz" : "https://atlantic.pharosscan.xyz", name: key === "pacific" ? "Pharos Pacific Mainnet" : "Pharos Atlantic Testnet" };
const tokenOf = (addr, key) => netInfo(key).tokens.find((t) => t.address.toLowerCase() === String(addr).toLowerCase()) ?? { symbol: short(addr), decimals: 18 };
function units(v, decimals, max = 6) {
  const neg = BigInt(v) < 0n;
  const x = neg ? -BigInt(v) : BigInt(v);
  const base = 10n ** BigInt(decimals);
  const i = x / base;
  const f = (x % base).toString().padStart(decimals, "0").slice(0, max).replace(/0+$/, "");
  return `${neg ? "-" : ""}${i.toLocaleString(lang === "pt" ? "pt-BR" : "en-US")}${f ? (lang === "pt" ? "," : ".") + f : ""}`;
}
const BADGE = {
  en: { swap: "swap", deposit: "deposit", withdraw: "withdraw", payment: "payment", policy: "policy", pause: "pause", unpause: "unpause", approve_payee: "payee", remove_payee: "payee", allow_withdraw: "limit", revoke: "revoke" },
  pt: { swap: "troca", deposit: "depósito", withdraw: "saque", payment: "pagamento", policy: "política", pause: "pausa", unpause: "retomar", approve_payee: "destinatário", remove_payee: "destinatário", allow_withdraw: "limite", revoke: "revogar" },
};
const badge = (action) => BADGE[lang]?.[action] ?? action;
const amt = (token, v, key) => `${units(v, tokenOf(token, key).decimals)} ${tokenOf(token, key).symbol}`;
const explorerTx = (h, key = network) => `${netInfo(key).explorer}/tx/${h}`;
const explorerAddr = (a, key = network) => `${netInfo(key).explorer}/address/${a}`;

/** Minimal, safe markdown: paragraphs, bullet lists, **bold**, `code`, links. Escapes everything first. */
function md(text) {
  const inline = (s) =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  return text
    .trim()
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split("\n");
      if (lines.every((l) => /^\s*[-*•]\s+/.test(l) || !l.trim())) return `<ul>${lines.filter((l) => l.trim()).map((l) => `<li>${inline(l.replace(/^\s*[-*•]\s+/, ""))}</li>`).join("")}</ul>`;
      if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l) || !l.trim())) return `<ol>${lines.filter((l) => l.trim()).map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ""))}</li>`).join("")}</ol>`;
      return `<p>${lines.map(inline).join("<br>")}</p>`;
    })
    .join("");
}

// ─── state ─────────────────────────────────────────────────────────────────────────────────────────────────────
let wallet = null;
let state = null;
let busy = false;
let lastWallet = null;
let lastRates = null;
let controller = null;
let network = (() => {
  try { return localStorage.getItem("network") || "atlantic"; } catch { return "atlantic"; }
})();
if (!["atlantic", "pacific"].includes(network)) network = "atlantic";

// ─── network ───────────────────────────────────────────────────────────────────────────────────────────────────
function applyNetwork() {
  document.querySelectorAll("[data-net]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.net === network)));
  $("fine").textContent = d("fine")[network];
  $("footExplorer").href = netInfo().explorer;
  renderChips();
  renderContract();
  if (lastWallet?.network === network) renderWallet(lastWallet);
  else if (!wallet) $("wallet").innerHTML = esc(lang === "pt" ? T.pt.walletEmpty : EN.walletEmpty);
}
document.querySelectorAll("[data-net]").forEach((b) =>
  b.addEventListener("click", async () => {
    if (b.dataset.net === network || busy) return;
    network = b.dataset.net;
    try { localStorage.setItem("network", network); } catch {}
    controller?.abort();
    state = null; // a conversation belongs to one network
    $("log").innerHTML = "";
    lastWallet = null;
    applyNetwork();
    agentNote(d("switched")(netInfo().name));
    if (wallet) {
      wallet.network = network;
      wallet.ensureChain().catch(() => {}); // the wallet follows; a refusal is fine until the user signs something
      refreshWallet();
    }
  }),
);

// ─── wallet ────────────────────────────────────────────────────────────────────────────────────────────────────
$("connect").addEventListener("click", async () => {
  if (wallet) return refreshWallet();
  const list = availableWallets();
  if (!list.length) return agentNote(d("noWallet"), "err");
  const pick = list.length === 1 ? list[0] : list.find((w) => /metamask/i.test(w.name)) ?? list[0];
  try {
    const w = new Wallet(pick.provider, pick.name);
    await w.connect(network);
    wallet = w;
    $("connect").textContent = short(w.address);
    pick.provider.on?.("accountsChanged", (a) => { if (a?.[0]) { wallet.address = a[0]; $("connect").textContent = short(a[0]); refreshWallet(); } });
    refreshWallet();
  } catch (e) {
    agentNote(e?.code === 4001 ? d("rejected") : String(e.message ?? e), "err");
  }
});

async function refreshWallet() {
  if (!wallet) return;
  const key = network;
  try {
    const r = await fetch(`/api/data?kind=wallet&network=${key}&address=${wallet.address}`);
    const w = await r.json();
    if (!r.ok) throw new Error(w.error);
    if (key !== network) return; // the user switched while it loaded
    lastWallet = w;
    renderWallet(w);
  } catch (e) {
    $("wallet").innerHTML = `<span class="muted">${esc(e.message)}</span>`;
  }
}

function renderWallet(w) {
  const rows = [`<div><span>${esc(d("gasLabel")(netInfo(w.network).native))}</span><b>${units(w.pros, 18, 4)}</b></div>`];
  for (const h of w.holdings) if (BigInt(h.balance) > 0n) rows.push(`<div><span>${esc(h.symbol)}</span><b>${units(h.balance, h.decimals, 4)}${h.valueUsdc ? ` <span class="muted">≈ ${units(h.valueUsdc, 6, 2)} USDC</span>` : ""}</b></div>`);
  let pol = "";
  const p = w.warden;
  if (p?.deployed && p.exists) {
    const lim = p.limits
      .map((l) => {
        const used = BigInt(l.perDay) - BigInt(l.remainingToday);
        const pct = BigInt(l.perDay) > 0n ? Number((used * 100n) / BigInt(l.perDay)) : 0;
        return `<div style="display:block"><div style="display:flex;justify-content:space-between"><span>${esc(l.symbol)} · ${units(l.perAction, l.decimals, 2)} ${d("perAction")}</span><b>${units(l.remainingToday, l.decimals, 2)} ${d("leftToday")}</b></div><div class="bar"><i style="width:${pct}%"></i></div></div>`;
      })
      .join("");
    const protos = netInfo(w.network).protocols.length ? `<div><span>${d("protocols")}</span><b style="font-family:inherit">${esc(p.protocols.join(", ") || d("none"))}</b></div>` : "";
    pol = `<div class="limits kv"><div><span><b style="font-family:inherit">${d("limits")}</b>${p.paused ? ` · <span style="color:var(--bad)">${d("paused")}</span>` : ""}</span><button class="btn small" id="pauseBtn">${p.paused ? d("unpause") : d("pause")}</button></div>${lim}${protos}</div>`;
  } else if (p?.deployed) pol = `<div class="limits muted" style="font-size:13px">${d("noPolicy")}</div>`;
  $("wallet").className = "kv";
  $("wallet").innerHTML = `<div><span>${lang === "pt" ? "Carteira" : "Wallet"}</span><b><a href="${esc(explorerAddr(w.user, w.network))}" target="_blank" rel="noopener">${short(w.user)}</a></b></div>${rows.join("")}${pol}`;
  $("pauseBtn")?.addEventListener("click", () => sendSimple({ to: netInfo(w.network).warden, data: p.paused ? "0x3f4ba83a" : "0x8456cb59" }, $("pauseBtn"), w.network));
}

async function sendSimple(tx, btn, key) {
  try {
    btn.disabled = true;
    const hash = await wallet.send(tx, key);
    await wallet.waitForReceipt(hash);
    await refreshWallet();
  } catch (e) {
    agentNote(e?.code === 4001 ? d("rejected") : String(e.message ?? e), "err");
    btn.disabled = false;
  }
}

// ─── rates & contract ──────────────────────────────────────────────────────────────────────────────────────────
async function loadRates() {
  try {
    const r = await fetch("/api/data?kind=rates&network=pacific");
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    lastRates = j;
    renderRates(j);
  } catch (e) {
    $("rates").textContent = e.message;
  }
}
function renderRates(j) {
  $("rates").className = "";
  const num = (x, digits) => Number(x).toLocaleString(lang === "pt" ? "pt-BR" : "en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const basis = (h) =>
    h.kind === "share-price"
      ? lang === "pt" ? `preço da cota ${num(h.from, 6)} → ${num(h.to, 6)} USDC em ${num(h.days, 1)} dias` : `share price ${num(h.from, 6)} → ${num(h.to, 6)} USDC over ${num(h.days, 1)} days`
      : lang === "pt" ? `índice de renda em ${num(h.days, 1)} dias; taxa de supply agora ${num(h.rateNowPct, 2)}% a.a.` : `income index over ${num(h.days, 1)} days; supply rate right now ${num(h.rateNowPct, 2)}% APR`;
  $("rates").innerHTML = j.venues.map((v) => `<div class="rate"><span>${esc(v.name)}</span><b>${num(v.apy * 100, 2)}%</b><small>${esc(basis(v.how))} · ${units(v.tvlUsdc, 6, 0)} USDC</small></div>`).join("");
}

function renderContract() {
  const n = netInfo();
  if (!n.warden) return;
  const link = (a) => `<a href="${esc(explorerAddr(a))}" target="_blank" rel="noopener">${short(a)}</a>`;
  $("contract").innerHTML = [
    `<div><span>${lang === "pt" ? "Rede" : "Network"}</span><b style="font-family:inherit">${esc(n.short)} · ${n.chainId}</b></div>`,
    `<div><span>Warden</span><b>${link(n.warden)}</b></div>`,
    `<div><span>Permit2</span><b>${link(info.permit2)}</b></div>`,
    ...n.tokens.filter((t) => !n.protocols.length || ["USDC", "WPROS"].includes(t.symbol)).map((t) => `<div><span>${esc(t.symbol)}</span><b>${link(t.address)}</b></div>`),
    ...n.protocols.map((p) => `<div><span>${esc(p.name)}</span><b>${link(p.address)}</b></div>`),
    `<div><span>${lang === "pt" ? "Leituras da chain" : "Chain reads"}</span><b style="font-family:inherit">${esc(n.chainSource)}</b></div>`,
  ].join("");
}

async function loadInfo() {
  info = await (await fetch("/api/data?kind=info")).json();
  $("modelName").textContent = info.model ?? "—";
  applyNetwork();
  if (!info.agentOnline) agentNote(d("offline"), "err");
}

// ─── chat ──────────────────────────────────────────────────────────────────────────────────────────────────────
function renderChips() {
  $("chips").innerHTML = d("chips")[network].map((c) => `<button type="button" title="${esc(c)}">${esc(c.length > 70 ? `${c.slice(0, 64)}…` : c)}</button>`).join("");
  $("chips").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => ask(b.title)));
}

function bubble(cls, html) {
  const el = document.createElement("div");
  el.className = `msg ${cls}`;
  el.innerHTML = html;
  $("log").appendChild(el);
  $("log").scrollTop = $("log").scrollHeight;
  return el;
}
const agentNote = (text, cls = "agent") => bubble(cls, md(text));

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("input").value.trim();
  if (v) ask(v);
});
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("composer").requestSubmit();
  }
});
$("reset").addEventListener("click", () => {
  controller?.abort();
  state = null;
  $("log").innerHTML = "";
});

const SERVER = { chain: "Chain MCP", docs: "Docs MCP", rpc: "RPC" };

async function ask(prompt) {
  if (busy) return;
  busy = true;
  $("send").disabled = true;
  $("input").value = "";
  bubble("user", esc(prompt));
  if (!wallet) agentNote(d("connectFirst"));
  const msg = bubble("agent", `<div class="thinking"></div><div class="tools"></div><div class="text"></div><div class="cards"></div>`);
  const parts = { thinking: msg.querySelector(".thinking"), tools: msg.querySelector(".tools"), text: msg.querySelector(".text"), cards: msg.querySelector(".cards") };
  let text = "";
  let thought = "";
  const toolEls = new Map();
  const askedOn = network;
  controller = new AbortController();
  try {
    const res = await fetch("/api/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: prompt, user: wallet?.address ?? null, lang, network: askedOn, state }), signal: controller.signal });
    if (!res.ok || !res.body) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error ?? `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (!line.startsWith("data: ")) continue;
        const ev = JSON.parse(line.slice(6));
        if (ev.type === "text") {
          text += ev.delta;
          parts.text.innerHTML = md(text);
        } else if (ev.type === "thinking") {
          thought += ev.delta;
          parts.thinking.textContent = thought.slice(-400);
        } else if (ev.type === "tool_start") {
          const el = document.createElement("span");
          el.className = "tool run";
          el.innerHTML = `<b>${esc(ev.name)}</b>`;
          parts.tools.appendChild(el);
          toolEls.set(ev.id, el);
        } else if (ev.type === "tool_end") {
          const el = toolEls.get(ev.id);
          if (el) {
            el.className = `tool${ev.ok ? "" : " bad"}`;
            const names = (ev.calls ?? []).map((c) => `${SERVER[c.server] ?? c.server}·${c.tool}`).filter((v, k, a) => a.indexOf(v) === k);
            const calls = names.length ? ` <span class="calls">${esc(names.slice(0, 3).join(" "))}${names.length > 3 ? ` +${names.length - 3}` : ""}</span>` : "";
            el.innerHTML = `<b>${esc(ev.name)}</b> ${(ev.ms / 1000).toFixed(1)}s${calls}`;
            el.title = ev.result?.error ?? `${ev.calls?.length ?? 0} ${d("calls")}`;
          }
        } else if (ev.type === "card") {
          parts.cards.appendChild(renderCard(ev.card));
        } else if (ev.type === "state") {
          if (askedOn === network) state = ev.state;
        } else if (ev.type === "error") {
          parts.text.innerHTML += `<p class="msg err">${esc(ev.message)}</p>`;
        }
        $("log").scrollTop = $("log").scrollHeight;
      }
    }
    parts.thinking.remove(); // the reasoning summary is shown only while the agent works
    if (lastWallet) refreshWallet();
  } catch (e) {
    parts.text.innerHTML += `<p class="msg err">${esc(e.name === "AbortError" ? d("stopped") : e.message)}</p>`;
  } finally {
    busy = false;
    $("send").disabled = false;
  }
}

// ─── cards ─────────────────────────────────────────────────────────────────────────────────────────────────────
function stepRow(label, buttonLabel, onClick) {
  const li = document.createElement("li");
  li.innerHTML = `<span>${esc(label)}</span>`;
  if (buttonLabel) {
    const b = document.createElement("button");
    b.className = "btn small primary";
    b.textContent = buttonLabel;
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await onClick(li, b);
      } catch (e) {
        b.disabled = false;
        li.querySelector("span").textContent = `${label} — ${e?.code === 4001 ? d("rejected") : String(e.shortMessage ?? e.message ?? e).split("\n")[0]}`;
      }
    });
    li.appendChild(b);
  }
  return li;
}

const warnBox = (key) => `<div class="mainnet${netInfo(key).testnet ? " testnet" : ""}">${esc(d("warn")[key] ?? "")}</div>`;

function renderCard(card) {
  if (card.kind === "check") return renderCheck(card);
  if (card.kind === "approvals") return renderApprovals(card);
  const key = card.networkKey ?? network;
  if (card.kind === "tx") {
    const el = document.createElement("div");
    el.className = "proposal";
    el.innerHTML = `<div class="p-head"><span class="badge">${esc(badge(card.action))}</span><b>${esc(card.summary)}</b></div><ul class="lines">${card.lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>${warnBox(key)}<ol class="steps"></ol><div class="p-result"></div>`;
    el.querySelector(".steps").appendChild(
      stepRow(card.summary, d("sendTx"), async (li) => {
        requireWallet();
        const hash = await wallet.send(card.tx, key);
        await afterSend(el, li, hash, false, key);
      }),
    );
    return el;
  }
  const el = $("tpl-intent").content.firstElementChild.cloneNode(true);
  if (lang === "pt") el.querySelectorAll("[data-i]").forEach((x) => (x.innerHTML = T.pt[x.dataset.i] ?? x.innerHTML));
  const box = el.querySelector(".mainnet");
  box.textContent = d("warn")[key] ?? "";
  if (netInfo(key).testnet) box.classList.add("testnet");
  if (card.fee) el.querySelector(".fee").textContent = `${d("fee")}: ${card.fee}`;
  const { plan, simulation: sim } = card;
  el.querySelector(".badge").textContent = badge(card.action);
  el.querySelector(".p-sum").textContent = card.summary;
  if (!plan.intent.outs.length) el.querySelector(".get span").textContent = d("guaranteed");
  el.querySelector(".spend b").textContent = plan.permit.permitted.map((t) => amt(t.token, t.amount, key)).join(" + ");
  el.querySelector(".get b").innerHTML = [
    ...plan.intent.outs.map((o) => esc(amt(o.token, o.minDelta, key))),
    ...plan.intent.pays.map((p) => `${esc(d("pays"))} ${esc(amt(p.token, p.amount, key))} → <a class="mono" href="${esc(explorerAddr(p.to, key))}" target="_blank" rel="noopener">${esc(short(p.to))}</a>`),
  ].join("<br>");
  const simEl = el.querySelector(".sim");
  if (sim.ok) {
    simEl.className = "sim ok";
    const gets = sim.deltas.filter((x) => BigInt(x.delta) > 0n).map((x) => `${units(x.delta, x.decimals)} ${x.symbol}`);
    simEl.innerHTML = `${d("dryOk")}${gets.length ? `: ${esc(gets.join(", "))}` : ""} · ~${Number(sim.gas).toLocaleString(lang === "pt" ? "pt-BR" : "en-US")} ${d("gas")}${sim.assumed.length ? `<span class="assumed">${d("assumed")}: ${esc(sim.assumed.map((a) => d("assume")[a.kind]?.(a.symbol) ?? a.text).join("; "))}</span>` : ""}`;
  } else {
    simEl.className = "sim bad";
    simEl.textContent = `${d("dryBad")}: ${sim.error?.text ?? ""}`;
  }
  if (card.safety?.warnings?.length) {
    const ul = document.createElement("ul");
    ul.className = "flags";
    ul.innerHTML = card.safety.warnings.map((w) => `<li class="${esc(w.severity)}">${esc(w.text)}</li>`).join("");
    simEl.after(ul);
  }
  const steps = el.querySelector(".steps");
  const deadline = Number(plan.intent.deadline) * 1000;
  for (const s of card.steps) {
    if (s.kind === "approve") steps.appendChild(stepRow(s.label, d("approve"), async (li) => { requireWallet(); const h = await wallet.send(s.tx, key); li.querySelector("span").textContent = `${s.label} — ${d("waiting")}`; await wallet.waitForReceipt(h); li.className = "done"; li.querySelector("span").textContent = s.label; }));
    else steps.appendChild(stepRow(`${d("policyNeeded")}: ${s.label}`, d("askPolicy"), async (li, b) => { b.disabled = false; ask(lang === "pt" ? "Configure meus limites no Warden para esta proposta" : "Set up my Warden policy for this proposal"); }));
  }
  let signature = null;
  const signLi = stepRow(d("sign"), d("sign"), async (li) => {
    requireWallet();
    if (Date.now() > deadline) throw new Error(d("expired"));
    signature = await wallet.signTypedData(card.typedData, key);
    li.className = "done";
    li.querySelector("span").textContent = d("signed");
    sendLi.querySelector("button").disabled = false;
  });
  const sendLi = stepRow(d("sendWarden"), d("sendWarden"), async (li) => {
    requireWallet();
    if (Date.now() > deadline) throw new Error(d("expired"));
    const hash = await wallet.send({ to: card.warden, data: executeCalldata(plan, signature) }, key);
    await afterSend(el, li, hash, true, key);
  });
  sendLi.querySelector("button").disabled = true;
  steps.append(signLi, sendLi);
  if (!sim.ok) signLi.querySelector("button").disabled = true;
  return el;
}

/** A transaction or signature check: the verdict first, then what the simulation saw, then every flag. */
function renderCheck(card) {
  const el = document.createElement("div");
  el.className = "check";
  const head = `<div class="p-head"><span class="verdict ${esc(card.verdict)}">${esc(d("verdict")[card.verdict] ?? card.verdict)}</span> <b>${esc(card.what === "signature" ? d("checkSig") : d("checkTx"))}</b></div>`;
  let body = "";
  if (card.what === "transaction") {
    body += `<div class="what"><span class="mono">${esc(card.call)}</span> → <a class="mono" href="${esc(explorerAddr(card.target.address, card.networkKey))}" target="_blank" rel="noopener">${esc(short(card.target.address))}</a> <span class="muted">(${esc(card.target.is)})</span></div>`;
    const s = card.simulation;
    if (s?.ran) {
      const changes = [...(s.changes ?? []), ...(s.newAllowances ?? []).map((a) => `${d("newAllowance")}: ${a}`)];
      body += `<div class="simline">${esc(d("simRan"))}: ${s.wouldSucceed ? "" : `<b style="color:var(--bad)">${esc(d("wouldFail"))}</b> · `}${esc(changes.length ? changes.join(" · ") : d("noChange"))}</div>`;
    }
  } else {
    body += `<div class="what">${esc(card.request)}</div>`;
  }
  const flags = (card.flags ?? []).map((f) => `<li class="${esc(f.severity)}">${esc(f.text)}</li>`).join("");
  el.innerHTML = `${head}${body}${flags ? `<ul class="flags">${flags}</ul>` : ""}`;
  return el;
}

/** Live approvals of the wallet, riskiest first; Revoke asks the agent, which prepares the revoke the user signs. */
function renderApprovals(card) {
  const el = document.createElement("div");
  el.className = "check";
  const rows = card.approvals
    .map((a, i) => `<div><span><span class="verdict ${esc(a.risk)}">${esc(d("risk")[a.risk] ?? a.risk)}</span> <b>${esc(a.amount === "unlimited" ? (lang === "pt" ? "ilimitado" : "unlimited") : a.amount)} ${esc(a.token)}</b> → ${esc(a.spenderIs)} <a class="mono" href="${esc(explorerAddr(a.spender, card.networkKey))}" target="_blank" rel="noopener">${esc(short(a.spender))}</a>${a.kind === "permit2" ? " · Permit2" : ""}</span><small>${esc(a.why)}</small>${card.own ? `<button class="btn small" data-i="${i}">${esc(d("revoke"))}</button>` : ""}</div>`)
    .join("");
  el.innerHTML = `<div class="p-head"><b>${esc(d("approvalsTitle"))}</b></div><div class="appr">${rows || `<p class="muted" style="margin:0">${esc(d("noApprovals"))}</p>`}</div><p class="fine">${esc(card.coverage)}</p>`;
  el.querySelectorAll("button[data-i]").forEach((b) =>
    b.addEventListener("click", () => {
      const a = card.approvals[Number(b.dataset.i)];
      ask(d("revokeAsk")(`${a.token} (${a.tokenAddress})`, a.spender, a.kind));
    }),
  );
  return el;
}

function requireWallet() {
  if (!wallet) throw new Error(lang === "pt" ? "Conecte a carteira primeiro." : "Connect your wallet first.");
}

async function afterSend(el, li, hash, askAgent, key) {
  const out = el.querySelector(".p-result");
  li.querySelector("span").innerHTML = `${esc(d("sent"))} · <a href="${esc(explorerTx(hash, key))}" target="_blank" rel="noopener">${short(hash)}</a>`;
  out.textContent = d("waiting");
  const rc = await wallet.waitForReceipt(hash);
  const okTx = rc.status === "0x1" || rc.status === 1;
  li.className = okTx ? "done" : "";
  const v = await (await fetch(`/api/data?kind=verify&network=${key}&hash=${hash}&user=${wallet.address}`)).json().catch(() => null);
  let html = okTx ? `<span class="ok">${d("verified")}</span>` : `<span class="bad">${d("reverted")}</span>`;
  if (v?.guarantees) html += ` · ${v.allGuaranteesHeld ? `<span class="ok">${d("guaranteesHeld")}</span>` : `<span class="bad">${d("guaranteeFailed")}</span>`}: ${v.guarantees.map((g) => `${esc(g.received)} ${esc(g.token)} ${d("received")} (${d("minimum")} ${esc(g.minimum)})`).join(", ")}`;
  if (v?.paid) html += ` · ${v.paid.map((p) => `${esc(p.amount)} ${esc(p.token)} → ${esc(short(p.to))}`).join(", ")}`;
  html += ` · <a href="${esc(explorerTx(hash, key))}" target="_blank" rel="noopener">${d("explorer")}</a>`;
  out.innerHTML = html;
  refreshWallet();
  if (askAgent && okTx && key === network) ask(d("verifyMsg")(hash));
}

// ─── boot ──────────────────────────────────────────────────────────────────────────────────────────────────────
applyLang();
loadInfo().catch(() => {});
loadRates();
