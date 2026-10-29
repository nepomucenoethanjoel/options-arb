import { useCallback, useState } from 'react';
import { type MatchRowLite, type Signal, type Venue } from '@options-arb/shared';

const STORAGE_KEY = 'options-arb.hiddenVenues';

function readHidden(): Venue[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed.filter((v) => typeof v === 'string') as Venue[]) : [];
  } catch {
    return [];
  }
}

/** Per-viewer venue filter. Stores the HIDDEN venues so a newly added venue shows by default. */
export function useVenueFilter(): { hidden: ReadonlySet<Venue>; toggle: (v: Venue) => void; showAll: () => void } {
  const [hidden, setHidden] = useState<ReadonlySet<Venue>>(() => new Set(readHidden()));
  const save = (next: Set<Venue>) => {
    setHidden(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
    } catch {
      // storage blocked: the filter still works for this page view
    }
  };
  const toggle = useCallback(
    (v: Venue) => {
      const next = new Set(hidden);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      save(next);
    },
    [hidden],
  );
  const showAll = useCallback(() => save(new Set()), []);
  return { hidden, toggle, showAll };
}

/** Rows with hidden venues' quotes removed. */
export function filterRows(rows: MatchRowLite[], hidden: ReadonlySet<Venue>): MatchRowLite[] {
  if (hidden.size === 0) return rows;
  return rows.map((r) => ({
    ...r,
    venues: Object.fromEntries(Object.entries(r.venues).filter(([v]) => !hidden.has(v as Venue))) as MatchRowLite['venues'],
  }));
}

/**
 * The row's best pair among visible venues: the server's choice when both
 * its venues are visible, else the best visible runner-up from
 * `alternatives` (which carries prices, size and totals but not the full
 * cost breakdown — those fields are nulled rather than shown stale).
 * Null when no visible pair exists.
 */
export function visibleSignal(s: Signal, hidden: ReadonlySet<Venue>): Signal | null {
  const visible = (b: Venue | null, v: Venue | null) => b != null && v != null && !hidden.has(b) && !hidden.has(v);
  if (hidden.size === 0 || visible(s.buyVenue, s.sellVenue)) return s;
  const alt = (s.alternatives ?? []).find((a) => visible(a.buyVenue, a.sellVenue));
  if (!alt) return null;
  return {
    ...s,
    buyVenue: alt.buyVenue,
    sellVenue: alt.sellVenue,
    ivSpreadVols: alt.ivSpreadVols,
    ivSpreadBps: null,
    entryPriceUsdc: alt.entryPriceUsdc,
    exitPriceUsdc: alt.exitPriceUsdc,
    edgeUsdc: alt.entryPriceUsdc != null && alt.exitPriceUsdc != null ? alt.exitPriceUsdc - alt.entryPriceUsdc : null,
    netEdgeUsdc: null,
    netAfterCapitalUsdc: alt.netAfterCapitalUsdc,
    // Not carried by alternatives: NaN renders as "–" (format.usd), never as a stale number.
    costsUsdc: Number.NaN,
    capitalCostUsdc: Number.NaN,
    maxExecutableSize: alt.maxExecutableSize,
    totalNetUsdc: alt.totalNetUsdc,
    // The alternative's honest total, carried so honestTotalNetUsdc(min) returns it.
    expectedTotalNetUsdc: alt.honestTotalNetUsdc,
    expectedEntryUsdc: null,
    expectedNetAfterCapitalUsdc: null,
    bestClipSize: null,
    bestClipExpectedTotalUsdc: null,
    maxProfitableSize: null,
    roiApyPct: null,
    settlementBasisUsdc: null,
    syntheticCrossCheckUsdc: null,
    crossCheckDeviationUsdc: null,
    bookVsMarkUsdc: null,
    isProfitable: alt.netAfterCapitalUsdc != null && alt.netAfterCapitalUsdc > 0,
    flags: alt.flags,
    alternatives: (s.alternatives ?? []).filter((a) => a !== alt && visible(a.buyVenue, a.sellVenue)),
  };
}

