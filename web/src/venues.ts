import { VENUE_SPECS, type Signal, type Venue } from '@options-arb/shared';

export function venueLabel(v: Venue | null | undefined): string {
  return v ? VENUE_SPECS[v].label : '–';
}

/** "buy Olive · sell Derive" */
export function directionLabel(s: Pick<Signal, 'buyVenue' | 'sellVenue'>): string {
  return s.buyVenue && s.sellVenue ? `buy ${venueLabel(s.buyVenue)} · sell ${venueLabel(s.sellVenue)}` : '–';
}
