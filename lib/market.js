// Market price of PROS from CoinGecko (the "pharos-network" id — the bare "pharos" id is an unrelated dead token;
// ProsPilot's verified mapping). Used only as an outside reference to sanity-check FaroSwap quotes: a pool price far
// from the market means a thin or manipulated pool. Cached 60 s; never throws.

let cache = null;

/** USD price of PROS, or null when CoinGecko cannot be reached. */
export async function prosUsd() {
  if (cache && Date.now() - cache.at < 60_000) return cache.value;
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=pharos-network&vs_currencies=usd", { signal: AbortSignal.timeout(6000), headers: { accept: "application/json" } });
    const v = (await r.json())?.["pharos-network"]?.usd;
    cache = { at: Date.now(), value: typeof v === "number" && v > 0 ? v : null };
  } catch {
    cache = { at: Date.now(), value: null };
  }
  return cache.value;
}

let marketCache = null;
/** PROS market data for the Trade page: price, 24 h change, market cap, volume (CoinGecko, cached 60 s). */
export async function prosMarket() {
  if (marketCache && Date.now() - marketCache.at < 60_000) return marketCache.value;
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=pharos-network&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true&include_last_updated_at=true", { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } });
    const j = (await r.json())?.["pharos-network"];
    if (!j?.usd) throw new Error("no price");
    const value = { available: true, price: j.usd, marketCap: j.usd_market_cap ?? null, volume24h: j.usd_24h_vol ?? null, change24h: j.usd_24h_change ?? null, updatedAt: j.last_updated_at ? new Date(j.last_updated_at * 1000).toISOString() : null, source: "CoinGecko (pharos-network)" };
    marketCache = { at: Date.now(), value };
    return value;
  } catch (e) {
    return marketCache?.value ?? { available: false, error: String(e.message).slice(0, 100) };
  }
}

const historyCache = new Map();
/** PROS price history in USD over `days` (1, 7 or 30), for the chart (CoinGecko, cached 5 min). */
export async function prosHistory(days) {
  const d = [1, 7, 30].includes(Number(days)) ? Number(days) : 7;
  const hit = historyCache.get(d);
  if (hit && Date.now() - hit.at < 300_000) return hit.value;
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/coins/pharos-network/market_chart?vs_currency=usd&days=${d}`, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
    const j = await r.json();
    if (!Array.isArray(j?.prices)) throw new Error("no history");
    const value = { available: true, days: d, points: j.prices.map(([t, p]) => [t, Number(p.toFixed(6))]) };
    historyCache.set(d, { at: Date.now(), value });
    return value;
  } catch (e) {
    return hit?.value ?? { available: false, error: String(e.message).slice(0, 100) };
  }
}
