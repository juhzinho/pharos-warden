import { domainToUnicode } from "node:url";
import { DRAINER_PATH_RE, FREE_HOST_SUFFIXES, HOMOGLYPH_MAP, OFFICIAL_WEB3_SUFFIXES, PERMIT_SIGN_RE, SCAM_HOST_FRAGMENTS, SEED_PATH_RE, SHORTENERS, SUSPICIOUS_TLDS, TYPO_SQUAT_TARGETS, WEB3_BRAND_RE } from "./link-domains.js";

// ProsPilot's link / scam scanner, static part, made sharper: the URL is analysed, never visited (a server that fetched
// whatever a user or a model pastes could be pointed at internal addresses). On top of ProsPilot's lists it measures
// edit distance to every official domain, folds homoglyphs, decodes punycode, and recognises Warden's own domains.

const OWN = ["pharos-warden.vercel.app", "pharos-x402-paywall.vercel.app", "pharos-contract-reader.vercel.app"];
const OFFICIAL = [...OFFICIAL_WEB3_SUFFIXES, ...OWN];

const isOfficial = (host) => OFFICIAL.some((d) => host === d || host.endsWith(`.${d}`));

/** Levenshtein distance (small strings: hostnames). */
function distance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

const fold = (s) => Object.entries(HOMOGLYPH_MAP).reduce((x, [from, to]) => x.split(from).join(to), s);
const registrable = (host) => host.split(".").slice(-2).join(".");

/** A verdict on a URL with the reasons (both languages), without visiting it. */
export function checkLink(raw) {
  const flags = [];
  const flag = (severity, text, pt) => flags.push({ severity, text, pt });
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    return { url: raw, verdict: "caution", flags: [{ severity: "medium", text: "this is not a valid URL", pt: "isto não é uma URL válida" }] };
  }
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  const unicode = domainToUnicode(host);
  if (!/^https?:$/.test(u.protocol)) flag("high", `the link uses ${u.protocol} — not a web page`, `o link usa ${u.protocol} — não é uma página web`);
  else if (u.protocol === "http:") flag("medium", "no HTTPS: anyone on the network can change the page", "sem HTTPS: qualquer um na rede pode alterar a página");
  if (u.username || u.password) flag("critical", "the URL hides a different destination after an @ — a classic trick", "a URL esconde outro destino depois de um @ — truque clássico");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[")) flag("high", "a raw IP address instead of a domain", "um IP cru em vez de um domínio");
  const official = isOfficial(host);
  if (host.includes("xn--")) flag(official ? "info" : "high", `internationalised domain: it displays as "${unicode}" — letters from other alphabets can imitate a real name`, `domínio internacionalizado: aparece como "${unicode}" — letras de outros alfabetos imitam nomes reais`);
  if (official) flag("info", `${host} is on the official list (Pharos, its ecosystem and well-known Web3 sites)`, `${host} está na lista oficial (Pharos, seu ecossistema e sites Web3 conhecidos)`);
  else {
    const label = registrable(host);
    const folded = fold(label);
    const near = TYPO_SQUAT_TARGETS.map((t) => ({ t, d: Math.min(distance(label, registrable(t)), distance(folded, registrable(t))) })).filter((x) => x.d > 0 && x.d <= 2).sort((a, b) => a.d - b.d)[0];
    if (near) flag("critical", `looks like ${near.t} (${near.d} character${near.d > 1 ? "s" : ""} away) — a typosquat`, `parece ${near.t} (a ${near.d} caractere${near.d > 1 ? "s" : ""} de distância) — typosquat`);
    const brand = host.match(WEB3_BRAND_RE)?.[0];
    if (brand && !near) flag("high", `uses the name "${brand}" but is not that project's domain`, `usa o nome "${brand}" mas não é o domínio desse projeto`);
    if (SCAM_HOST_FRAGMENTS.some((f) => host.includes(f))) flag("critical", "the host matches a known scam pattern", "o host bate com um padrão de golpe conhecido");
    const free = FREE_HOST_SUFFIXES.find((s) => host.endsWith(`.${s}`));
    if (free) flag(brand ? "high" : "medium", `hosted on a free service (${free}): anyone can publish there`, `hospedado num serviço gratuito (${free}): qualquer um publica ali`);
    const tld = host.split(".").at(-1);
    if (SUSPICIOUS_TLDS.has(tld)) flag("medium", `.${tld} is a domain ending often used by scams`, `.${tld} é um final de domínio muito usado em golpes`);
    if (SHORTENERS.has(host)) flag("medium", "a link shortener: the real destination is hidden", "um encurtador de link: o destino real fica escondido");
    if (host.split(".").length > 4) flag("medium", "an unusually deep subdomain", "um subdomínio fora do comum");
  }
  const path = decodeURIComponent(`${u.pathname}${u.search}${u.hash}`);
  if (SEED_PATH_RE.test(path)) flag("critical", "the page asks about a seed phrase or private key — no real dApp ever does", "a página fala de frase-semente ou chave privada — nenhum dApp de verdade pede isso");
  if (DRAINER_PATH_RE.test(path) && !official) flag("high", "a drainer-style path (claim / airdrop / connect / verify wallet)", "um caminho típico de drainer (claim / airdrop / connect / verify wallet)");
  if (PERMIT_SIGN_RE.test(path)) flag("high", "the link talks about signing permits or approvals", "o link fala em assinar permits ou aprovações");
  const top = Math.max(-1, ...flags.map((f) => ({ critical: 3, high: 2, medium: 1, info: 0 })[f.severity]));
  const verdict = top >= 3 ? "do_not_open" : top === 2 ? "high_risk" : top === 1 ? "caution" : official ? "official" : "no_known_risk";
  return { url: u.href, host, ...(unicode !== host && { displaysAs: unicode }), verdict, flags, note: "static check: the page was not visited; an unknown domain can still be malicious" };
}
