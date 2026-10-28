import type { Venue } from '@options-arb/shared';

/** What a leg's fee depends on. */
export interface FeeContext {
  /** Premium this leg trades at, per contract (null when unknown). */
  legPrice: number | null;
  /** Notional base, per contract (spot, or strike when spot is unknown). */
  notional: number;
  underlying: string;
  kind: 'call' | 'put';
  strike: number;
  /** Days to expiry (some venues waive settlement fees on dailies). */
  tteDays: number;
}

/**
 * One venue's trading costs. Every formula is a venue assumption with a
 * DATA_SOURCES.md matrix row — change it only with new evidence.
 */
export interface VenueFeeModel {
  /** Taker fee per contract for opening this leg, USDC. */
  perContract(ctx: FeeContext): number;
  /** Fixed cost per order/transaction (charged once per clip), USDC. */
  perOrder: number;
}

export interface FeeConfig {
  deriveTakerFeeBps: number;
  oliveFeeNotionalBps: number;
  oliveFeePremiumPct: number;
  solanaFeeUsdc: number;
}

/** Derive taker base fee, per ORDER regardless of size (docs trading-fees,
 *  verified 2026-09-29) — charged once per clip, not per contract. */
export const DERIVE_TAKER_ORDER_FEE_USDC = 0.5;

/** Fee models for the venues that can appear in a pair. */
export function feeModels(cfg: FeeConfig): Partial<Record<Venue, VenueFeeModel>> {
  return {
    // Derive (docs trading-fees, verified 2026-09-29): $0.50 per ORDER +
    // min(0.03% × notional, 12.5% × premium). Notional ≈ qty × index.
    derive: {
      perContract: ({ legPrice, notional }) => {
        const fee = notional * (cfg.deriveTakerFeeBps / 10_000);
        return legPrice != null && legPrice > 0 ? Math.min(fee, legPrice * 0.125) : fee;
      },
      perOrder: DERIVE_TAKER_ORDER_FEE_USDC,
    },
    // Olive (docs option-fees + a live fill 2026-09-29): min(2.5bps × qty ×
    // ORACLE SPOT, 10% × premium); one Solana tx opens the whole clip.
    olive: {
      perContract: ({ legPrice, notional }) =>
        legPrice != null && legPrice > 0
          ? Math.min(notional * (cfg.oliveFeeNotionalBps / 10_000), legPrice * (cfg.oliveFeePremiumPct / 100))
          : 0,
      perOrder: cfg.solanaFeeUsdc,
    },
    // Coincall (fee page updated 2026-10-14 + contract specs): taker 0.03%
    // of index notional for BTC/ETH, 0.06% for altcoins, capped at 12.5% of
    // premium; held to expiry, a delivery fee of min(0.015% × index, 12.5% ×
    // intrinsic) applies except on dailies — estimated at today's intrinsic.
    coincall: {
      perContract: ({ legPrice, notional, underlying, kind, strike, tteDays }) => {
        const rate = underlying === 'BTC' || underlying === 'ETH' ? 0.0003 : 0.0006;
        const trade = legPrice != null && legPrice > 0 ? Math.min(notional * rate, legPrice * 0.125) : notional * rate;
        const intrinsic = Math.max(0, kind === 'call' ? notional - strike : strike - notional);
        const delivery = tteDays < 1 ? 0 : Math.min(notional * 0.00015, intrinsic * 0.125);
        return trade + delivery;
      },
      perOrder: 0,
    },
  };
}
