// ProsPilot — a second Pharos agent (github.com/juhzinho/pharos-agent) — consulted live over its public Skill API,
// agent to agent. Warden asks it for an independent wallet profile of a payee (Pacific Mainnet data from the public
// RPC). Read-only, no key; a slow or failed answer never blocks Warden (it is a second opinion, not a dependency).

export const PROSPILOT_URL = globalThis.process?.env?.PROSPILOT_URL ?? "https://pharos-agent-pi.vercel.app";

/** ProsPilot's wallet profile of `address` (Pacific Mainnet), or `{ available: false }`. */
export async function prospilotProfile(address) {
  try {
    const r = await fetch(`${PROSPILOT_URL}/api/skill/wallet-profile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!r.ok) return { available: false, error: `HTTP ${r.status}` };
    const j = await r.json();
    if (!j?.available) return { available: false, error: j?.error ?? "no profile" };
    return { available: true, txCount: j.tx_count, totalUsd: j.total_usd, tags: j.profile?.tags ?? [], summary: j.profile?.summary ?? null };
  } catch (e) {
    return { available: false, error: String(e.message).slice(0, 120) };
  }
}
