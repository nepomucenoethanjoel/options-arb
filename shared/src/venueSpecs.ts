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
  settlementAsset(kind: OptionKind, underlying: string): SettlementAsset;
  /** Settlement averaging window, hours (0 = single print); per underlying where the venue differs by product. */
  settlementWindowHours: number | ((underlying: string) => number);
  /** The venue publishes no quote size (vault-filled requests): pairs carry
   *  `size_unknown` instead of `thin_book`, and their size is null, not 0. */
  sizeUnpublished?: boolean;
}

const always = () => true;

export const VENUE_SPECS: Record<Venue, VenueSpec> = {
  // Docs settlement.md (row 95): crypto 30-min TWAP of spot to 08:00 UTC; NVDA a 2-min
  // spot TWAP and WTI a 2-min futures VWAP; US500/US100 a 30-s VWAP of the assigned future.
  derive: {
    label: 'Derive',
    quoteKind: 'book',
    canSell: always,
    tradingCutoffMs: 0,
    settlementAsset: () => 'USDC',
    settlementWindowHours: (u) => (u === 'US500' || u === 'US100' ? 30 / 3600 : u === 'NVDA' || u === 'WTI' ? 2 / 60 : 0.5),
  },
  // An Olive option can be opened only while its expiry is more than one day away (docs
  // open-option "must exceed one day"; DATA_SOURCES rows 6, 81). The app's Olive leg is always a buy.
  olive: { label: 'Olive', quoteKind: 'amm_synthetic', canSell: () => false, tradingCutoffMs: 24 * 3_600_000, settlementAsset: () => 'USDC', settlementWindowHours: 0 },
  coincall: { label: 'Coincall', quoteKind: 'book', canSell: always, tradingCutoffMs: 15 * 60_000, settlementAsset: () => 'USDT', settlementWindowHours: 0.5 },
  hypercall: { label: 'Hypercall', quoteKind: 'rfq', canSell: always, tradingCutoffMs: 0, settlementAsset: () => 'USDC', settlementWindowHours: 0.5 },
  callput: {
    label: 'Callput',
    quoteKind: 'indicative',
    canSell: always,
    tradingCutoffMs: 30 * 60_000,
    settlementAsset: (kind) => (kind === 'call' ? 'underlying' : 'USDC'),
    settlementWindowHours: 0.5,
    // The OLP vault fills whatever the keeper accepts; no size is published (rows 40, 86).
    sizeUnpublished: true,
  },
  // Tradeable since 2026-11-05 (row 48); REFERENCE_VENUES can make it reference-only.
  // BTC/ETH read from the inverse book (coin-settled); SOL from the USDC-linear book.
  deribit: {
    label: 'Deribit',
    quoteKind: 'book',
    canSell: always,
    tradingCutoffMs: 0,
    settlementAsset: (_kind, underlying) => (underlying === 'BTC' || underlying === 'ETH' ? 'underlying' : 'USDC'),
    settlementWindowHours: 0.5,
  },
  // Coin-margined BTC/ETH (settleCcy BTC/ETH); SOL, HYPE and gold (XAU) from the
  // USD-margined _UM families (settleCcy USD — treated as USDT, row 92). Settlement
  // averaging and any pre-expiry halt are not documented in what we could read:
  // 0.5 h and a conservative 30 min cutoff are assumptions (DATA_SOURCES row 56).
  okx: {
    label: 'OKX',
    quoteKind: 'book',
    canSell: always,
    tradingCutoffMs: 30 * 60_000,
    settlementAsset: (_kind, underlying) => (underlying === 'BTC' || underlying === 'ETH' ? 'underlying' : 'USDT'),
    settlementWindowHours: 0.5,
  },
  // Cash-settled in USDC at 08:00 UTC on Aevo's spot index (docs, row 91). The
  // settlement averaging window and any pre-expiry halt are not documented: a
  // single print (largest basis estimate) and a 30 min cutoff are assumptions.
  aevo: { label: 'Aevo', quoteKind: 'book', canSell: always, tradingCutoffMs: 30 * 60_000, settlementAsset: () => 'USDC', settlementWindowHours: 0 },
  // USDT-margined (one {U}_USDT family per underlying). Settlement averaging
  // and any pre-expiry halt are not documented in what we could read: 0.5 h
  // and a conservative 30 min cutoff are assumptions (DATA_SOURCES row 60).
  gate: { label: 'Gate', quoteKind: 'book', canSell: always, tradingCutoffMs: 30 * 60_000, settlementAsset: () => 'USDT', settlementWindowHours: 0.5 },
  // Dated options, cash-settled in USDC on a 30-min TWAP of Paradex's spot
  // oracle (docs). No pre-expiry halt is documented: 30 min is a
  // conservative assumption (DATA_SOURCES row 67).
  paradex: { label: 'Paradex', quoteKind: 'book', canSell: always, tradingCutoffMs: 30 * 60_000, settlementAsset: () => 'USDC', settlementWindowHours: 0.5 },
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
/** A venue's settlement averaging window for one underlying, hours. */
export function settlementWindowHours(venue: Venue, underlying: string): number {
  const w = VENUE_SPECS[venue].settlementWindowHours;
  return typeof w === 'function' ? w(underlying) : w;
}

export const VENUE_ORDER: Venue[] = ['derive', 'olive', 'coincall', 'hypercall', 'callput', 'deribit', 'okx', 'gate', 'paradex', 'aevo', 'bybit', 'binance'];
