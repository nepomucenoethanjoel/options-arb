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
 * Deterministic AMM quote in Olive's pricing convention (docs.olive.exchange,
 * verified live against their production UI at 7d AND 269d tenors — see
 * DATA_SOURCES.md §2d and verify-pricing.ts):
 *   call: F = S·e^(r_TOKEN·T), df = e^(−r_TOKEN·T)   (classic BS at the long rate)
 *   put:  F = S·e^(−r_USDC·T), df = e^(+r_USDC·T)   (strike accretes at the short rate)
 * At short tenors both discount factors ≈ 1. Bid/ask are null by design —
 * the pool quotes one premium, there is no order book.
 */
export function buildSyntheticAmmQuote(inputs: OlivePricingInputs): OptionQuote {
  const { underlying, strike, expiryTs, kind, spot, vol, tokenRateApr, usdcRateApr, now } = inputs;
  const tau = yearsBetween(now, expiryTs);
  const r = kind === 'call' ? tokenRateApr : -usdcRateApr;
  const forward = spot * Math.exp(r * tau);
  const discountFactor =
    kind === 'call' ? Math.exp(-tokenRateApr * tau) : Math.exp(usdcRateApr * tau);
  const mark = bsPrice({ forward, strike, tauYears: tau, vol, discountFactor, kind });
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
    discountFactor,
    source: 'olive:synthetic-amm',
  };
}
