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
