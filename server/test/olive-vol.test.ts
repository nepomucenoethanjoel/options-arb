import { describe, expect, it } from 'vitest';
import { LAST_LIVE_VOL_MAX_AGE_MS, pickModelVol } from '../src/adapters/olive';

describe('Olive model vol fallback order', () => {
  const now = 1_800_000_000_000;
  const pinned = { vol: 0.53, source: 'override' as const };

  it('uses the live market-file vol when present', () => {
    expect(pickModelVol(0.465, { vol: 0.46, ts: now - 1000 }, pinned, now)).toEqual({ vol: 0.465, caveat: 'model_vol_live' });
  });

  it('a brief file outage reuses the last live vol, not the pinned override', () => {
    expect(pickModelVol(null, { vol: 0.465, ts: now - 60_000 }, pinned, now)).toEqual({ vol: 0.465, caveat: 'model_vol_last_live' });
  });

  it('falls back to the pin once the last live vol is too old', () => {
    expect(pickModelVol(null, { vol: 0.465, ts: now - LAST_LIVE_VOL_MAX_AGE_MS - 1 }, pinned, now)).toEqual({ vol: 0.53, caveat: 'model_vol_manual_override' });
  });

  it('no vol at all names the reason', () => {
    expect(pickModelVol(undefined, undefined, { vol: null, reason: 'keeper_inactive' }, now)).toEqual({ vol: null, caveat: 'model_vol_unavailable_keeper_inactive' });
    expect(pickModelVol(undefined, undefined, null, now)).toEqual({ vol: null, caveat: 'model_vol_unavailable_oracle_error' });
  });
});
