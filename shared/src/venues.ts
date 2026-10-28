import type { SviSlice } from './math/svi';
import type {
  IVSurfacePoint,
  OptionInstrument,
  OptionQuote,
  Venue,
  VenueHealth,
  VenueMarketState,
} from './types';

/**
 * Venue-agnostic options data source. Downstream code (matching, signals,
 * scheduler, API) only ever sees this interface — never venue specifics.
 */
export interface OptionsVenueAdapter {
  readonly venue: Venue;

  /** All active option instruments for an underlying. May be empty when the
   * venue is a quoting continuum (Olive AMM) with no discrete chain. */
  getInstruments(underlying: string): Promise<OptionInstrument[]>;

  /** Latest quote for one instrument by venue-native id, or null. */
  getTicker(instrumentId: string): Promise<OptionQuote | null>;

  /** Optional whole-chain read (instruments + quotes in one go) — how
   *  additional listed venues are polled. */
  getChain?(underlying: string): Promise<{ instruments: OptionInstrument[]; quotes: OptionQuote[] }>;

  /** Optional batch form: all quotes for one underlying+expiry. */
  getTickers?(underlying: string, expiryDate: string): Promise<OptionQuote[]>;

  /** Smoothed IV surface sample points for an underlying. */
  getIVSurface(underlying: string): Promise<IVSurfacePoint[]>;

  /** Optional raw SVI slices (Derive) for evaluating IV at arbitrary strikes. */
  getSVISlices?(underlying: string): Promise<SviSlice[]>;

  /** Optional live market context (spot, model vol, bounds). */
  getMarketState?(underlying: string): Promise<VenueMarketState | null>;

  /** Health of this adapter's active data path. */
  getHealth(): VenueHealth;
}
