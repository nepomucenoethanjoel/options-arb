import type { OptionKind, Venue } from './types';

/** How a venue's quote becomes a fill. */
export type QuoteKind =
  /** Resting order book (bid/ask with sizes). */
  | 'book'
  /** Computed by us from the venue's pricing model (Olive AMM). */
  | 'amm_synthetic'
  /** Published mark ± spread, filled later by a keeper — not firm. */
  | 'indicative'
  /** Market-maker RFQ quotes with max sizes. */
  | 'rfq';

export type SettlementAsset = 'USDC' | 'USDT' | 'underlying';

/**
 * Static per-venue facts the engines need. Every value here is a venue
 * assumption with a DATA_SOURCES.md row (§3.0 matrix); change it only with
 * new evidence.
 */
export interface VenueSpec {
  label: string;
  quoteKind: QuoteKind;
  /** Whether a user can open a SHORT on this venue for this underlying
   *  (false → selling there is an LP role; pairs flag direction_limited). */
  canSell(underlying: string): boolean;
  /** Quotes inside this window before expiry are not tradable (trading halt / request cutoff). */
  tradingCutoffMs: number;
  settlementAsset(kind: OptionKind): SettlementAsset;
  /** Settlement averaging window, hours (0 = single print). */
  settlementWindowHours: number;
}

const always = () => true;

export const VENUE_SPECS: Record<Venue, VenueSpec> = {
  derive: { label: 'Derive', quoteKind: 'book', canSell: always, tradingCutoffMs: 0, settlementAsset: () => 'USDC', settlementWindowHours: 0.5 },
  olive: { label: 'Olive', quoteKind: 'amm_synthetic', canSell: () => false, tradingCutoffMs: 0, settlementAsset: () => 'USDC', settlementWindowHours: 0 },
  coincall: { label: 'Coincall', quoteKind: 'book', canSell: always, tradingCutoffMs: 15 * 60_000, settlementAsset: () => 'USDT', settlementWindowHours: 0.5 },
  hypercall: { label: 'Hypercall', quoteKind: 'rfq', canSell: always, tradingCutoffMs: 0, settlementAsset: () => 'USDC', settlementWindowHours: 0.5 },
  callput: {
    label: 'Callput',
    quoteKind: 'indicative',
    canSell: always,
    tradingCutoffMs: 30 * 60_000,
    settlementAsset: (kind) => (kind === 'call' ? 'underlying' : 'USDC'),
    settlementWindowHours: 0.5,
  },
  bybit: { label: 'Bybit', quoteKind: 'book', canSell: always, tradingCutoffMs: 0, settlementAsset: () => 'USDT', settlementWindowHours: 0.5 },
  binance: {
    label: 'Binance',
    quoteKind: 'book',
    canSell: (u) => u === 'BTC' || u === 'ETH',
    tradingCutoffMs: 0,
    settlementAsset: () => 'USDT',
    settlementWindowHours: 0.5,
  },
};

/** Fixed venue order: deterministic pair enumeration and display. */
export const VENUE_ORDER: Venue[] = ['derive', 'olive', 'coincall', 'hypercall', 'callput', 'bybit', 'binance'];
