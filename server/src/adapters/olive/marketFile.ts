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
  /** Total per-custody balances (owned) in the same units as the free values
   *  — lets consumers compute post-execution utilization (the borrow curve
   *  is convex near 100%, so fills move the pricing rate). */
  underlyingOwned: number | null;
  usdcOwnedUsd: number | null;
  /**
   * Live pricing rates (fractions) from the per-custody borrowRateCurve at
   * current utilization — what their UI shows as "Fixed Rate (L/S)" and what
   * their pricer uses (verified 2026-09-28: SOL curve at 20.8% util = 15.02%
   * vs UI 15.04%; BTC USDC custody 88% utilized = 42.15% short rate).
   * Null when custody/curve data is missing.
   */
  rates: { tokenApr: number; usdcApr: number } | null;
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
  const custodyBal = (c: unknown): { free: number | null; owned: number | null } => {
    if (!c || typeof c !== 'object') return { free: null, owned: null };
    const o = c as Record<string, unknown>;
    const owned = num(o.tokenOwned);
    const locked = num(o.tokenLocked) ?? 0;
    const decimals = num(o.decimals);
    if (owned == null || decimals == null || decimals < 0 || decimals > 18) return { free: null, owned: null };
    const scale = Math.pow(10, decimals);
    return { free: Math.max(0, (owned - locked) / scale), owned: owned / scale };
  };
  const raw = snap?.rawOnChainPoolSnapshot;
  const underlyingBal = custodyBal(raw?.underlyingCustody);
  const usdcBal = custodyBal(raw?.usdcCustody);
  const underlyingFree = underlyingBal.free;
  const usdcFreeUsd = usdcBal.free;
  const underlyingOwned = underlyingBal.owned;
  const usdcOwnedUsd = usdcBal.owned;

  /** Borrow rate (bps) at a utilization (bps) via piecewise-linear curve. */
  const curveRate = (custody: any): number | null => {
    const pts = Array.isArray(custody?.borrowRateCurve?.points) ? custody.borrowRateCurve.points : [];
    const byUtil = new Map<number, number>();
    for (const p of pts) {
      const x = num(p?.utilizationRateBps);
      const y = num(p?.borrowRateBps);
      if (x != null && y != null) byUtil.set(x, y);
    }
    const uniq = [...byUtil.entries()].sort((a, b) => a[0] - b[0]);
    if (uniq.length === 0) return null;
    const owned = num(custody?.tokenOwned);
    const locked = num(custody?.tokenLocked) ?? 0;
    if (owned == null || owned <= 0) return null;
    const util = Math.min(10_000, Math.max(0, (locked / owned) * 10_000));
    if (util <= uniq[0]![0]) return uniq[0]![1];
    for (let i = 1; i < uniq.length; i++) {
      const [x1, y1] = uniq[i]!;
      if (util <= x1) {
        const [x0, y0] = uniq[i - 1]!;
        return y0 + ((y1 - y0) * (util - x0)) / (x1 - x0);
      }
    }
    return uniq[uniq.length - 1]![1];
  };
  const tokenRateBps = raw?.underlyingCustody ? curveRate(raw.underlyingCustody) : null;
  const usdcRateBps = raw?.usdcCustody ? curveRate(raw.usdcCustody) : null;
  const rates =
    tokenRateBps != null && usdcRateBps != null
      ? { tokenApr: tokenRateBps / 10_000, usdcApr: usdcRateBps / 10_000 }
      : null;

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
    underlyingOwned,
    usdcOwnedUsd,
    rates,
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
