// The four pages beside the agent: Trade, Network, Ecosystem, News. Every number comes from a live source named on
// the page (Pharos RPC, CoinGecko, the official Pharos Port directory, ProsPilot's public API); every page ends in the
// agent, which is where things get done.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
let lang = (() => {
  try {
    return localStorage.getItem("lang") || (navigator.language?.startsWith("pt") ? "pt" : "en");
  } catch {
    return "en";
  }
})();
const L = (en, pt) => (lang === "pt" ? pt : en);
const loc = () => (lang === "pt" ? "pt-BR" : "en-US");
const n = (x, d = 2) => Number(x).toLocaleString(loc(), { maximumFractionDigits: d, minimumFractionDigits: Math.min(d, 2) > 0 && Math.abs(x) < 1000 ? Math.min(d, 2) : 0 });
const usd = (x) => (x >= 1e9 ? `$${n(x / 1e9, 2)}B` : x >= 1e6 ? `$${n(x / 1e6, 2)}M` : x >= 1e3 ? `$${n(x / 1e3, 1)}K` : `$${n(x, 4)}`);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const agentLink = (q, net) => `/?${new URLSearchParams({ ask: q, ...(net && { net }) })}`;
const page = document.body.dataset.page;
const get = (q) => fetch(`/api/data?${q}`, { signal: AbortSignal.timeout(45_000) }).then(async (r) => {
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
});

// ─── header ────────────────────────────────────────────────────────────────────────────────────────────────────
function header() {
  const links = [["/", L("Agent", "Agente"), "agent"], ["/trade", "Trade", "trade"], ["/network", L("Network", "Rede"), "network"], ["/ecosystem", L("Ecosystem", "Ecossistema"), "ecosystem"], ["/news", L("News", "Notícias"), "news"]];
  $("top").innerHTML = `<div class="wrap top-row">
    <a class="brand" href="/" aria-label="Pharos Warden"><svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true"><rect width="32" height="32" rx="7" fill="var(--brand)"/><path d="M16 6l8 3v6c0 5.5-3.4 9.6-8 11-4.6-1.4-8-5.5-8-11V9z" fill="none" stroke="#d9f2e6" stroke-width="2.2" stroke-linejoin="round"/><path d="M12.5 16l2.6 2.6 4.6-5" fill="none" stroke="#d9f2e6" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Pharos <b>Warden</b></span></a>
    <nav class="nav" aria-label="Pages">${links.map(([h, t, k]) => `<a href="${h}"${k === page ? ' aria-current="page"' : ""}>${esc(t)}</a>`).join("")}</nav>
    <div class="top-actions"><div class="lang" role="group" aria-label="Language"><button data-lang="en" aria-pressed="${lang === "en"}">EN</button><button data-lang="pt" aria-pressed="${lang === "pt"}">PT</button></div><a class="btn primary" href="/">${esc(L("Open the agent", "Abrir o agente"))}</a></div>
  </div>`;
  document.querySelectorAll("[data-lang]").forEach((b) =>
    b.addEventListener("click", () => {
      lang = b.dataset.lang;
      try {
        localStorage.setItem("lang", lang);
      } catch {}
      document.documentElement.lang = lang === "pt" ? "pt-BR" : "en";
      header();
      render();
    }),
  );
}

/** A simple line chart (SVG, no library): values over time, the last value labelled. */
function lineChart(points, { height = 160, format = (v) => n(v) } = {}) {
  if (!points?.length) return `<p class="muted">${esc(L("No data.", "Sem dados."))}</p>`;
  const W = 640;
  const H = height;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const X = (x) => ((x - x0) / (x1 - x0 || 1)) * (W - 8) + 4;
  const Y = (y) => H - 18 - ((y - y0) / (y1 - y0 || 1)) * (H - 36);
  const d = points.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("");
  const area = `${d}L${X(x1).toFixed(1)},${H - 18}L${X(x0).toFixed(1)},${H - 18}Z`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(L("chart", "gráfico"))}"><path d="${area}" class="area"/><path d="${d}" class="line"/><text x="${W - 4}" y="12" text-anchor="end">${esc(format(ys.at(-1)))}</text><text x="4" y="${H - 4}">${esc(new Date(x0).toLocaleDateString(loc()))}</text><text x="${W - 4}" y="${H - 4}" text-anchor="end">${esc(new Date(x1).toLocaleDateString(loc()))}</text><text x="4" y="12">${esc(L("min", "mín"))} ${esc(format(y0))} · ${esc(L("max", "máx"))} ${esc(format(y1))}</text></svg>`;
}

const fail = (e) => `<p class="msg err">${esc(e.message ?? e)}</p>`;

// ─── Trade ─────────────────────────────────────────────────────────────────────────────────────────────────────
let days = 7;
async function trade() {
  $("main").innerHTML = `<section class="page-hero wrap"><p class="eyebrow">Trade</p><h1>${esc(L("$PROS, live", "$PROS, ao vivo"))}</h1><p class="lead">${esc(L("The market price from CoinGecko next to the price inside each FaroSwap pool on Pharos — and the agent to trade with a guarantee.", "O preço de mercado da CoinGecko ao lado do preço dentro de cada pool da FaroSwap na Pharos — e o agente para negociar com garantia."))}</p></section>
  <div class="wrap pagegrid"><section class="card pad"><div id="price">…</div><div class="tabs" id="ranges"></div><div id="chart"></div></section>
  <section class="card pad"><h2>${esc(L("FaroSwap WPROS/USDC pools", "Pools WPROS/USDC da FaroSwap"))}</h2><div id="pools" class="muted">…</div><p class="fine">${esc(L("Read on chain (Pacific RPC). A pool far from the market price means a worse deal there.", "Lido na chain (RPC da Pacific). Um pool longe do preço de mercado significa um negócio pior ali."))}</p></section>
  <section class="card pad"><h2>${esc(L("Trade & track $PROS", "Negocie e acompanhe $PROS"))}</h2><div id="venues" class="venues"></div></section>
  <section class="card pad"><h2>${esc(L("Trade on chain with the agent", "Negocie na chain com o agente"))}</h2><p class="muted">${esc(L("Quote, price impact, the pool vs the market, a dry run — then one signature, and Warden reverts unless you receive at least the minimum.", "Cotação, impacto de preço, pool vs mercado, simulação — depois uma assinatura, e o Warden reverte se você não receber no mínimo o combinado."))}</p><div class="chips">${[L("Swap 5 USDC to WPROS", "Troque 5 USDC por WPROS"), L("Stake 10 PROS with Faroo", "Faça stake de 10 PROS na Faroo"), L("Add liquidity to the 0.30% WPROS/USDC pool", "Adicione liquidez no pool WPROS/USDC de 0,30%")].map((q) => `<a class="chip" href="${esc(agentLink(q, "pacific"))}">${esc(q)}</a>`).join("")}</div></section></div>`;
  $("ranges").innerHTML = [[1, "24H"], [7, "7D"], [30, "30D"]].map(([d, t]) => `<button data-d="${d}" aria-pressed="${d === days}">${t}</button>`).join("");
  $("ranges").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { days = Number(b.dataset.d); trade(); }));
  get(`kind=market&days=${days}`).then((j) => {
    const m = j.market;
    $("price").innerHTML = m.available ? `<div class="stat-row"><div><span class="muted">PROS / USD</span><b class="big">$${n(m.price, 4)}</b></div><div><span class="muted">24h</span><b class="${m.change24h >= 0 ? "up" : "down"}">${m.change24h >= 0 ? "+" : ""}${n(m.change24h, 2)}%</b></div><div><span class="muted">${esc(L("Market cap", "Market cap"))}</span><b>${usd(m.marketCap)}</b></div><div><span class="muted">${esc(L("24h volume", "Volume 24h"))}</span><b>${usd(m.volume24h)}</b></div></div><p class="fine">CoinGecko · ${esc(new Date(m.updatedAt).toLocaleString(loc()))}</p>` : fail(m.error);
    $("chart").innerHTML = j.history.available ? lineChart(j.history.points, { format: (v) => `$${n(v, 4)}` }) : fail(j.history.error);
    $("venues").innerHTML = j.venues.map((v) => `<a class="venue" href="${esc(v.url)}" target="_blank" rel="noopener">${esc(v.name)} ↗</a>`).join("");
    get("kind=pools").then((p) => {
      $("pools").className = "";
      const total = p.pools.reduce((s, x) => s + Number(x.liquidity), 0) || 1;
      $("pools").innerHTML = `<div class="rows">${p.pools.map((x) => { const dev = m.available ? ((x.price - m.price) / m.price) * 100 : null; const share = (Number(x.liquidity) / total) * 100; return `<div><span><b>${esc(x.fee)}</b> · $${n(x.price, 4)} ${dev != null ? `<span class="verdict ${Math.abs(dev) >= 3 ? "caution" : "looks_ok"}">${dev >= 0 ? "+" : ""}${n(dev, 2)}% ${esc(L("vs market", "vs mercado"))}</span>` : ""}</span><small><a href="https://www.pharosscan.xyz/address/${esc(x.address)}" target="_blank" rel="noopener">${esc(short(x.address))}</a> · ${esc(L(`${n(share, 1)}% of the pair's liquidity`, `${n(share, 1)}% da liquidez do par`))}</small><span class="btns" style="width:110px"><span class="scorebar" style="width:100%"><i style="width:${Math.max(2, Math.round(share))}%"></i></span></span></div>`; }).join("")}</div>`;
    }).catch((e) => ($("pools").innerHTML = fail(e)));
  }).catch((e) => ($("price").innerHTML = fail(e)));
}

// ─── Network ───────────────────────────────────────────────────────────────────────────────────────────────────
let netKey = new URLSearchParams(location.search).get("net") === "atlantic" ? "atlantic" : "pacific";
let timer = null;
async function network() {
  clearInterval(timer);
  $("main").innerHTML = `<section class="page-hero wrap"><p class="eyebrow">${esc(L("Network", "Rede"))}</p><h1>${esc(L("Pharos network health", "Saúde da rede Pharos"))}</h1><p class="lead">${esc(L("Live from the public RPC, every 10 seconds — verifiable on the explorer at any time.", "Ao vivo do RPC público, a cada 10 segundos — verificável no explorador a qualquer hora."))}</p><div class="tabs" id="nets"><button data-n="pacific" aria-pressed="${netKey === "pacific"}">Pacific Mainnet</button><button data-n="atlantic" aria-pressed="${netKey === "atlantic"}">Atlantic Testnet</button></div></section>
  <div class="wrap pagegrid"><section class="card pad"><div id="stats">…</div></section><section class="card pad"><h2>${esc(L("Recent blocks", "Blocos recentes"))}</h2><div id="blocks" class="muted">…</div></section><section class="card pad"><h2>${esc(L("Chain parameters", "Parâmetros da chain"))}</h2><div id="params" class="kv"></div></section><section class="card pad wide"><h2>${esc(L("Charts & statistics · Pacific", "Gráficos e estatísticas · Pacific"))}</h2><div id="charts" class="charts muted">…</div><p class="fine" id="chartsrc"></p></section></div>`;
  $("nets").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { netKey = b.dataset.n; history.replaceState(null, "", `/network?net=${netKey}`); network(); }));
  const info = await get("kind=info").catch(() => null);
  const ni = info?.networks.find((x) => x.key === netKey);
  if (ni) $("params").innerHTML = [[L("Network", "Rede"), ni.name], ["Chain ID", ni.chainId], [L("Native token", "Token nativo"), ni.native], ["RPC", ni.rpc], [L("Explorer", "Explorador"), `<a href="${esc(ni.explorer)}" target="_blank" rel="noopener">${esc(new URL(ni.explorer).host)}</a>`], ["Warden", `<a href="${esc(ni.wardenExplorer)}" target="_blank" rel="noopener">${esc(short(ni.warden))}</a>`], [L("Chain reads", "Leituras"), ni.chainSource]].map(([k, v]) => `<div><span>${esc(k)}</span><b>${typeof v === "string" && v.startsWith("<a") ? v : esc(v)}</b></div>`).join("");
  const tick = () => get(`kind=health&network=${netKey}`).then((h) => {
    if (page !== "network") return;
    $("stats").innerHTML = `<div class="stat-row"><div><span class="muted">${esc(L("Block height", "Altura do bloco"))}</span><b class="big">${n(h.blockNumber, 0)}</b></div><div><span class="muted">${esc(L("Avg block time", "Tempo médio de bloco"))}</span><b>${h.blockTime != null ? `${n(h.blockTime, 2)} s` : "—"}</b><small class="muted">${esc(L("last 10 blocks", "últimos 10 blocos"))}</small></div><div><span class="muted">${esc(L("Gas price", "Preço do gás"))}</span><b>${n(h.gasPriceGwei, 2)} gwei</b></div><div><span class="muted">TPS</span><b>${h.tps != null ? n(h.tps, 2) : "—"}</b><small class="muted">${esc(L("recent sample", "amostra recente"))}</small></div></div>`;
    $("blocks").className = "";
    $("blocks").innerHTML = `<div class="rows">${h.recent.map((b) => `<div><span><a href="${esc(h.explorer)}/block/${b.number}" target="_blank" rel="noopener">#${n(b.number, 0)}</a> · ${b.txs} tx</span><small>${esc(new Date(b.time * 1000).toLocaleTimeString(loc()))} · ${esc(L("gas used", "gás usado"))} ${n(b.gasUsed, 0)}</small></div>`).join("")}</div>`;
  }).catch((e) => ($("stats").innerHTML = fail(e)));
  tick();
  timer = setInterval(tick, 10_000);
  get("kind=charts").then((c) => {
    const pick = ["daily_txns", "active_addresses", "defi_tvl", "avg_txn_fee", "block_time", "total_addresses"];
    const series = (c.charts.series ?? []).filter((s) => pick.includes(s.id));
    $("charts").className = "charts";
    $("charts").innerHTML = series.map((s) => `<div><h3>${esc(s.title)}${s.unit ? ` <span class="muted">(${esc(s.unit)})</span>` : ""}</h3>${lineChart(s.points.slice(-90).map((p) => [Date.parse(p.date), p.value]), { height: 120, format: (v) => (s.unit === "USD" ? usd(v) : n(v, s.unit === "PROS" ? 6 : 2)) })}</div>`).join("");
    $("chartsrc").textContent = L("Daily metrics of Pacific Mainnet (SocialScan charts, DeFi TVL from DefiLlama), through ProsPilot's public API · last 90 days.", "Métricas diárias da Pacific Mainnet (gráficos SocialScan, TVL DeFi do DefiLlama), pela API pública do ProsPilot · últimos 90 dias.");
  }).catch((e) => ($("charts").innerHTML = fail(e)));
}

// ─── Ecosystem ─────────────────────────────────────────────────────────────────────────────────────────────────
let eco = null;
let cat = "all";
let query = "";
async function ecosystem() {
  eco ??= await get("kind=ecosystem").catch((e) => ({ error: e }));
  if (eco.error) return ($("main").innerHTML = fail(eco.error));
  const shown = eco.apps.filter((a) => (cat === "all" || a.categories.includes(cat)) && (!query || `${a.name} ${a.desc}`.toLowerCase().includes(query)));
  $("main").innerHTML = `<section class="page-hero wrap"><p class="eyebrow">${esc(L("Ecosystem", "Ecossistema"))}</p><h1>${esc(L("Everything built on Pharos", "Tudo o que é construído na Pharos"))}</h1><p class="lead">${esc(L(`${eco.apps.length} active projects from the official Pharos Port directory — the same list the agent answers from.`, `${eco.apps.length} projetos ativos do diretório oficial do Pharos Port — a mesma lista que o agente usa.`))}</p></section>
  <div class="wrap"><div class="filters"><input id="q" type="search" placeholder="${esc(L("Search projects…", "Buscar projetos…"))}" value="${esc(query)}"><div class="tabs wrapgap"><button data-c="all" aria-pressed="${cat === "all"}">${esc(L("All", "Todos"))} ${eco.apps.length}</button>${eco.categories.map((c) => `<button data-c="${esc(c.name)}" aria-pressed="${cat === c.name}">${esc(c.name)} ${c.apps.length}</button>`).join("")}</div></div>
  <div class="apps">${shown.map((a) => `<article class="card app"><div class="app-head"><span class="logo" aria-hidden="true">${a.logo ? `<img src="${esc(a.logo)}" alt="" loading="lazy">` : esc(a.name[0])}</span><div><b>${esc(a.name)}</b><small>${esc(a.categories.join(" · "))}</small></div></div><p>${esc(lang === "pt" && a.descPt ? a.descPt : a.desc)}</p><div class="app-foot"><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(L("Visit", "Visitar"))} ↗</a><a href="${esc(agentLink(L(`What is ${a.name} on Pharos, and is ${new URL(a.url).hostname} its official link?`, `O que é ${a.name} na Pharos, e ${new URL(a.url).hostname} é o link oficial?`)))}">${esc(L("Ask the agent", "Perguntar ao agente"))}</a></div></article>`).join("") || `<p class="muted">${esc(L("No project matches.", "Nenhum projeto encontrado."))}</p>`}</div>
  <p class="fine">${esc(L("Source: port.pharos.xyz/ecosystem (official), read on 2026-11-10; links from ProsPilot's directory where it lists the project.", "Fonte: port.pharos.xyz/ecosystem (oficial), lido em 10/11/2026; links do diretório do ProsPilot onde ele lista o projeto."))}</p></div>`;
  $("q").addEventListener("input", (e) => { query = e.target.value.toLowerCase(); const pos = e.target.selectionStart; ecosystem().then(() => { $("q").focus(); $("q").setSelectionRange(pos, pos); }); });
  document.querySelectorAll("[data-c]").forEach((b) => b.addEventListener("click", () => { cat = b.dataset.c; ecosystem(); }));
}

// ─── News & campaigns ──────────────────────────────────────────────────────────────────────────────────────────
let feed = null;
let tab = new URLSearchParams(location.search).get("tab") ?? "all";
function campaignState(c) {
  const now = Date.now();
  const s = Date.parse(c.startTime);
  const e = Date.parse(c.endTime);
  return now < s ? "upcoming" : now > e ? "ended" : "active";
}
// The posts read through ProsPilot's API show at once; X's own embedded timeline (platform.twitter.com) loads hidden
// behind them and takes their place only if X actually fills it (X does that for visitors signed in to X).
const X_HANDLE = "pharos_network";
let feedAt = 0;
let refreshTimer = null;
function xTimeline(postsHtml) {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  return `<div class="xlive" id="xlive"><div class="xlive-head"><b>@${X_HANDLE}</b><span class="live-dot">${esc(L("latest posts", "últimos posts"))}</span><a href="https://x.com/${X_HANDLE}" target="_blank" rel="noopener">${esc(L("Open on X", "Abrir no X"))} ↗</a></div><div class="xfallback" id="xfallback">${postsHtml}</div><div class="xwidget" id="xwidget"><a class="twitter-timeline" data-dnt="true" data-chrome="noheader nofooter transparent" data-height="900" data-theme="${dark ? "dark" : "light"}" data-lang="${lang === "pt" ? "pt" : "en"}" href="https://twitter.com/${X_HANDLE}"></a></div></div>`;
}
function mountX() {
  const box = $("xlive");
  if (!box) return;
  if (window.twttr?.widgets) window.twttr.widgets.load($("xwidget"));
  else if (!document.getElementById("x-widgets")) {
    const s = document.createElement("script");
    s.id = "x-widgets";
    s.async = true;
    s.src = "https://platform.twitter.com/widgets.js";
    document.head.append(s);
  }
  let tries = 0;
  const watch = setInterval(() => {
    const frame = box.isConnected && box.querySelector("#xwidget iframe");
    if (frame && frame.offsetHeight > 120) {
      $("xfallback").remove();
      $("xwidget").classList.add("on");
      box.querySelector(".live-dot").textContent = L("live from X", "ao vivo do X");
    }
    if (!box.isConnected || $("xwidget")?.classList.contains("on") || ++tries > 40) clearInterval(watch);
  }, 500);
}
async function news(force = false) {
  if (force || !feed || Date.now() - feedAt > 300_000) {
    const fresh = await get("kind=feed").catch((e) => ({ error: e }));
    if (!fresh.error || !feed) [feed, feedAt] = [fresh, Date.now()];
  }
  if (feed.error) return ($("main").innerHTML = fail(feed.error));
  clearTimeout(refreshTimer);
  // keep the page current without a reload: news, blog and campaigns re-read every 5 minutes (the X timeline is live)
  refreshTimer = setTimeout(() => news(true), 300_000);
  const tabs = [["all", L("All", "Tudo")], ["x", "X / Twitter"], ["news", L("News & blog", "Notícias e blog")], ["campaigns", L("Campaigns", "Campanhas")]];
  const tweet = (t) => `<article class="card post"><small class="muted">X · ${esc(new Date(t.createdAt).toLocaleString(loc()))}</small><p>${esc(t.text)}</p>${t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(L("Open on X", "Abrir no X"))} ↗</a>` : ""}</article>`;
  const newestTweet = feed.tweets[0]?.createdAt;
  const day = newestTweet ? new Date(newestTweet).toLocaleDateString(loc()) : "—";
  // fresh posts (≤ 2 days) are shown as they are; older ones get a note and a link to the live profile
  const fresh = newestTweet && Date.now() - Date.parse(newestTweet) < 2 * 86_400_000;
  const note = fresh ? "" : `<div class="xnote"><p>${esc(L("X shows its live timeline here only when you're signed in to X.", "O X só mostra a timeline ao vivo aqui quando você está logado no X."))}</p><a class="btn small primary" href="https://x.com/${X_HANDLE}" target="_blank" rel="noopener">${esc(L(`See the latest on @${X_HANDLE}`, `Ver o mais recente no @${X_HANDLE}`))} ↗</a><small class="muted">${esc(L(`Below: the last posts we could read (newest ${day}).`, `Abaixo: os últimos posts que conseguimos ler (o mais novo de ${day}).`))}</small></div>`;
  const posts = (n) => `${note}${feed.tweets.slice(0, n).map(tweet).join("")}`;
  const item = (i) => `<article class="card post">${i.image ? `<img src="${esc(i.image)}" alt="" loading="lazy">` : ""}<small class="muted">${esc(i.kind === "blog" ? "Blog" : L("News", "Notícia"))} · ${esc(i.date)}</small><p><b>${esc(i.title)}</b></p><a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(L("Read", "Ler"))} ↗</a></article>`;
  const camp = (c) => { const st = campaignState(c); return `<article class="card post"><span class="verdict ${st === "active" ? "looks_ok" : st === "upcoming" ? "caution" : "low"}">${esc({ active: L("active", "ativa"), upcoming: L("upcoming", "em breve"), ended: L("ended", "encerrada") }[st])}</span><p><b>${esc(c.name)}</b> <span class="muted">${esc(c.kind ?? "")}</span></p><small class="muted">${esc(new Date(c.startTime).toLocaleDateString(loc()))} → ${esc(new Date(c.endTime).toLocaleDateString(loc()))}</small><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(L("Open", "Abrir"))} ↗</a></article>`; };
  const order = { active: 0, upcoming: 1, ended: 2 };
  const campaigns = [...feed.campaigns].sort((a, b) => order[campaignState(a)] - order[campaignState(b)] || Date.parse(b.startTime) - Date.parse(a.startTime));
  const newsSorted = [...feed.news].sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  const noCamp = `<p class="muted">${esc(L("No campaign listed right now.", "Nenhuma campanha listada agora."))}</p>`;
  let body;
  if (tab === "campaigns") body = `<div class="feed">${campaigns.length ? campaigns.map(camp).join("") : noCamp}</div>`;
  else if (tab === "x") body = `<div class="xsolo">${xTimeline(posts(16))}</div>`;
  else if (tab === "news") body = `<div class="feed">${newsSorted.map(item).join("")}</div>`;
  else {
    const live = campaigns.filter((c) => campaignState(c) !== "ended");
    body = `<div class="news-split"><div>${live.length ? `<h2 class="feed-h">${esc(L("Live campaigns", "Campanhas ativas"))}</h2><div class="feed">${live.map(camp).join("")}</div>` : ""}<h2 class="feed-h">${esc(L("News & blog", "Notícias e blog"))}</h2><div class="feed">${newsSorted.slice(0, 18).map(item).join("")}</div></div><aside>${xTimeline(posts(8))}</aside></div>`;
  }
  const updated = new Date(feedAt).toLocaleTimeString(loc(), { hour: "2-digit", minute: "2-digit" });
  $("main").innerHTML = `<section class="page-hero wrap"><p class="eyebrow">${esc(L("Updates", "Novidades"))}</p><h1>${esc(L("Latest from Pharos", "O mais recente da Pharos"))}</h1><p class="lead">${esc(L("Blog, news, @pharos_network and live campaigns.", "Blog, notícias, @pharos_network e campanhas ativas."))}</p><div class="tabs">${tabs.map(([k, t]) => `<button data-t="${k}" aria-pressed="${tab === k}">${esc(t)}</button>`).join("")}<a class="btn small" href="${esc(agentLink(L("What's new on Pharos, and which campaigns are live?", "O que há de novo na Pharos e quais campanhas estão ativas?")))}">${esc(L("Ask the agent for a summary", "Pedir um resumo ao agente"))}</a></div></section><div class="wrap">${body}</div><div class="wrap"><p class="fine">${esc(L(`Updated ${updated} · refreshes every 5 min · sources: @${X_HANDLE}, pharos.xyz, Pharos Port`, `Atualizado às ${updated} · atualiza a cada 5 min · fontes: @${X_HANDLE}, pharos.xyz, Pharos Port`))}</p></div>`;
  mountX();
  document.querySelectorAll("[data-t]").forEach((b) => b.addEventListener("click", () => { tab = b.dataset.t; history.replaceState(null, "", `/news?tab=${tab}`); news(); }));
}

/** The same footer as the agent page. */
function footer() {
  const logo = `<svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true"><rect width="32" height="32" rx="8" fill="var(--brand)"/><path d="M16 6l8 3v6c0 5.5-3.4 9.6-8 11-4.6-1.4-8-5.5-8-11V9z" fill="none" stroke="#d9f2e6" stroke-width="2.2" stroke-linejoin="round"/><path d="M12.5 16l2.6 2.6 4.6-5" fill="none" stroke="#d9f2e6" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const ext = (h, t) => `<a href="${h}" target="_blank" rel="noopener">${esc(t)}</a>`;
  $("foot").innerHTML = `<div><a class="brand" href="/">${logo}<span>Pharos <b>Warden</b></span></a><p>${esc(L("An AI agent for Pharos that prepares every action and a contract that guarantees it. Built for the Pharos Season of AI.", "Um agente de IA para a Pharos que prepara cada ação e um contrato que a garante. Feito para a Pharos Season of AI."))}</p></div>
  <div><h4>${esc(L("Product", "Produto"))}</h4><a href="/">${esc(L("Agent", "Agente"))}</a><a href="/trade">Trade</a><a href="/network">${esc(L("Network", "Rede"))}</a><a href="/ecosystem">${esc(L("Ecosystem", "Ecossistema"))}</a><a href="/news">${esc(L("News", "Notícias"))}</a></div>
  <div><h4>${esc(L("Build", "Construção"))}</h4>${ext("https://github.com/juhzinho/pharos-warden", "GitHub")}${ext("https://github.com/juhzinho/pharos-warden/blob/master/docs/ARCHITECTURE.md", L("Architecture", "Arquitetura"))}${ext("https://docs.pharos.xyz", "Pharos docs")}${ext("https://ai.pharos.xyz", "ai.pharos.xyz")}</div>
  <div><h4>${esc(L("On chain", "Na chain"))}</h4>${ext("https://www.pharosscan.xyz", "Pharosscan")}${ext("https://atlantic.pharosscan.xyz/address/0x58ad9DDF29D13328ceefAF70AFa42644E4D76766", "Warden · Atlantic")}${ext("https://www.pharosscan.xyz/address/0x58ad9DDF29D13328ceefAF70AFa42644E4D76766", "Warden · Pacific")}${ext("https://faucet.circle.com", L("Test USDC faucet", "Faucet de USDC de teste"))}</div>
  <div class="foot-bottom"><span>© 2026 Pharos Warden · MIT</span><span>${esc(L("Not financial advice. The agent shows its numbers and sources; you decide and you sign.", "Não é recomendação financeira. O agente mostra os números e as fontes; você decide e assina."))}</span></div>`;
}

function render() {
  ({ trade, network, ecosystem, news })[page]?.();
  footer();
}
document.documentElement.lang = lang === "pt" ? "pt-BR" : "en";
header();
render();
