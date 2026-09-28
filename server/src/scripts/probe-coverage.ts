/**
 * Cross-venue asset coverage: which Olive pools have a Derive options chain?
 * Probes Derive's instrument list per candidate currency and reads the Olive
 * market file for each pool (vol / rates / liquidity).
 */
export {};

const CANDIDATES = ['ZEC', 'PAXG', 'JUP', 'NVDAX'];

async function deriveHasOptions(ccy: string): Promise<{ listed: boolean; expiries: number; sample: string | null }> {
  const body = { currency: ccy, expired: false, instrument_type: 'option', page: 1, page_size: 1000 };
  try {
    const res = await fetch('https://api.derive.xyz/v3/public/get_all_instruments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { listed: false, expiries: 0, sample: `HTTP ${res.status}` };
    const j: any = await res.json();
    const instruments = j?.result?.instruments ?? [];
    return {
      listed: instruments.length > 0,
      expiries: new Set(instruments.map((i: any) => i.expiration_date)).size,
      sample: instruments[0]?.instrument_name ?? null,
    };
  } catch (e) {
    return { listed: false, expiries: 0, sample: (e as Error).message };
  }
}

async function olivePool(sym: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`https://olive.exchange/public/market/${sym}%2FUSDC.json`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    const snap = j?.state?.payload?.snapshot;
    const tick = (Array.isArray(j.ticker) ? j.ticker : []).find((t: any) => t?.symbol === `${sym}/USD`);
    return {
      spot: tick?.price,
      vol: snap?.volatility?.volatility,
      aumUsd: snap?.poolSummary?.aumUsd,
      availableUsd: snap?.poolSummary?.aumUsd != null && snap?.poolSummary?.openPositionEntryClaimsUsd != null
        ? snap.poolSummary.aumUsd - snap.poolSummary.openPositionEntryClaimsUsd
        : null,
      ratesRaw: snap?.rawOnChainPoolSnapshot ? Object.keys(snap.rawOnChainPoolSnapshot).filter((k) => /rate/i.test(k)) : [],
    };
  } catch {
    return null;
  }
}

async function main() {
  for (const c of CANDIDATES) {
    const d = await deriveHasOptions(c);
    const o = await olivePool(c);
    const avail = typeof o?.availableUsd === 'number' ? o.availableUsd.toFixed(0) : 'n/a';
    console.log(
      `${c}: derive=${d.listed ? `${d.expiries} expiries (e.g. ${d.sample})` : `NO (${d.sample})`} | olive=${o ? `spot=${o.spot} vol=${o.vol == null ? null : (Number(o.vol) * 100).toFixed(1) + '%'} aum=$${o.aumUsd} avail=$${avail}` : 'no market file'}`,
    );
    await new Promise((r) => setTimeout(r, 400));
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
