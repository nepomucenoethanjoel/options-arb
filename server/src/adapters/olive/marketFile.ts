/**
 * Olive's market-state file — THE live data source, discovered 2026-09-27 by
 * hooking their frontend's fetches (DATA_SOURCES.md §2d-ter):
 *
 *   GET https://olive.exchange/public/market/{SYM}%2FUSDC.json
 *
 * Plain CDN file, no auth, regenerated every ~5s by their reader-2 service.
 * Carries: all Stork ticker prices, the projected EWMA model vol
 * (`snapshot.volatility` — their backend blends the on-chain state forward
 * with live prices, which is why the UI vol ticks while chain state is
 * stale), pool AUM / entry claims (liquidity capacity), perp borrow curves,
 * recent trades, and the full on-chain pool snapshot.
 */
import type { Venue } from '@options-arb/shared';

export const OLIVE_MARKET_FILE_BASE = 'https://olive.exchange/public/market';

export interface OliveMarketFileData {
  venue: Venue;
  underlying: string;
  spot: number | null;
  /** Live projected model vol (fraction). */
  vol: number | null;
  /** Available-liquidity proxy: aumUsd − openPositionEntryClaimsUsd. */
  liquidityUsd: number | null;
  aumUsd: number | null;
  entryClaimsUsd: number | null;
  /**
   * Free per-custody collateral from the raw on-chain snapshot: calls lock
   * the underlying custody (1 underlying each), puts the USDC custody (K
   * USDC each). These are the real per-kind capacity limits — the pool's
   * total AUM overstates both. Null when the snapshot omits them.
   */
  underlyingFree: number | null;
  usdcFreeUsd: number | null;
  /** File generation time (ms). */
  asOfMs: number;
  /** Last on-chain EWMA write (ms) — the projection base. */
  volOnChainMs: number | null;
  projectionBranch: string | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function parseOliveMarketFile(json: any, underlying: string): OliveMarketFileData | null {
  const u = underlying.toUpperCase();
  if (!json || typeof json !== 'object') return null;
  const num = (v: unknown): number | null => {
    const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
    return Number.isFinite(n) ? n : null;
  };
  const ticker = (json.ticker ?? []).find((t: any) => t?.symbol === `${u}/USD`);
  const spot = num(ticker?.price);

  const snap = json.state?.payload?.snapshot;
  const volObj = snap?.volatility;
  const vol = num(volObj?.volatility);
  const volOnChainMs = num(volObj?.timestamp) != null ? num(volObj.timestamp)! * 1000 : null;

  const summary = snap?.poolSummary ?? {};
  // poolSummary carries decimal USD; the raw on-chain projection (poolAccount)
  // carries E6-scaled strings — different fields, not interchangeable.
  const aumUsd = num(summary?.aumUsd) ?? (num(snap?.poolAccount?.aumUsd) != null ? num(snap.poolAccount.aumUsd)! / 1e6 : null);
  const entryClaimsUsd =
    num(summary?.openPositionEntryClaimsUsd) ??
    (num(snap?.poolAccount?.openPositionEntryClaimsUsd) != null
      ? num(snap.poolAccount.openPositionEntryClaimsUsd)! / 1e6
      : null);

  // Per-custody free balances: owned − locked, scaled by the custody's mint
  // decimals (underlying 9 for SOL, 6 for USDC). Layout verified live
  // 2026-09-28 — see DATA_SOURCES.md.
  const custodyFree = (c: unknown): number | null => {
    if (!c || typeof c !== 'object') return null;
    const o = c as Record<string, unknown>;
    const owned = num(o.tokenOwned);
    const locked = num(o.tokenLocked) ?? 0;
    const decimals = num(o.decimals);
    if (owned == null || decimals == null || decimals < 0 || decimals > 18) return null;
    return Math.max(0, (owned - locked) / Math.pow(10, decimals));
  };
  const raw = snap?.rawOnChainPoolSnapshot;
  const underlyingFree = custodyFree(raw?.underlyingCustody);
  const usdcFreeUsd = custodyFree(raw?.usdcCustody);

  // Olive's UI "Available Liquidity" is free-underlying × spot + free-USDC
  // (verified live 2026-09-28: 23.7 SOL × $118.5 + $1,296 ≈ $4,105); the
  // AUM − entry-claims form is only the fallback when custody data is absent.
  const liquidityUsd =
    underlyingFree != null && usdcFreeUsd != null && spot != null
      ? underlyingFree * spot + usdcFreeUsd
      : aumUsd != null && entryClaimsUsd != null
        ? Math.max(0, aumUsd - entryClaimsUsd)
        : aumUsd;

  const asOfMs = num(json.asOf ? Date.parse(json.asOf) : NaN) ?? Date.now();

  if (spot == null && vol == null) return null;
  return {
    venue: 'olive',
    underlying: u,
    spot,
    vol,
    liquidityUsd,
    aumUsd,
    entryClaimsUsd,
    underlyingFree,
    usdcFreeUsd,
    asOfMs,
    volOnChainMs,
    projectionBranch: volObj?.projectionBranch ?? null,
  };
}

export async function fetchOliveMarketFile(
  base: string,
  underlying: string,
  timeoutMs = 8000,
): Promise<OliveMarketFileData | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/${underlying.toUpperCase()}%2FUSDC.json`, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return parseOliveMarketFile(await res.json(), underlying);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
