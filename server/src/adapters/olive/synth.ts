import { bsPrice, yearsBetween, type OptionKind, type OptionQuote } from '@options-arb/shared';

export interface OlivePricingInputs {
  underlying: string;
  strike: number;
  expiryTs: number;
  kind: OptionKind;
  spot: number;
  /** Olive's per-asset EWMA realized vol (their BS pricing input). */
  vol: number;
  tokenRateApr: number;
  usdcRateApr: number;
  now: number;
}

export function synthInstrumentId(
  underlying: string,
  expiryDate: string,
  strike: number,
  kind: OptionKind,
): string {
  return `OLIVE-SYNTH-${underlying}-${expiryDate}-${strike}-${kind === 'call' ? 'C' : 'P'}`;
}

/**
 * Deterministic AMM quote in Olive's pricing convention (docs.olive.exchange):
 * Black-Scholes with their own vol oracle; calls use r_TOKEN, puts use
 * −r_USDC; no published discounting → df = 1. Bid/ask are null by design —
 * the pool quotes one premium, there is no order book.
 */
export function buildSyntheticAmmQuote(inputs: OlivePricingInputs): OptionQuote {
  const { underlying, strike, expiryTs, kind, spot, vol, tokenRateApr, usdcRateApr, now } = inputs;
  const tau = yearsBetween(now, expiryTs);
  const r = kind === 'call' ? tokenRateApr : -usdcRateApr;
  const forward = spot * Math.exp(r * tau);
  const mark = bsPrice({ forward, strike, tauYears: tau, vol, discountFactor: 1, kind });
  const expiryDate = new Date(expiryTs).toISOString().slice(0, 10).replace(/-/g, '');
  return {
    venue: 'olive',
    instrumentId: synthInstrumentId(underlying, expiryDate, strike, kind),
    ts: now,
    bid: null,
    bidSize: null,
    ask: null,
    askSize: null,
    mark,
    indexPrice: spot,
    iv: vol,
    ivSource: 'model',
    forward,
    discountFactor: 1,
    source: 'olive:synthetic-amm',
  };
}
