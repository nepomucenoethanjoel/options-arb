import type { Signal } from '@options-arb/shared';
import { pairLabel, usd } from '../format';

/** Top profitable clips — TOTAL $ is the headline, one line of context. */
export function TopClips({
  clips,
  onSelect,
}: {
  clips: Signal[];
  onSelect: (pairKey: string) => void;
}) {
  if (clips.length === 0) {
    return (
      <div className="feed empty">
        No profitable clip right now — every spread is negative after fees, capital drag, and pool capacity. Check back after a vol move.
      </div>
    );
  }
  return (
    <div className="feed">
      {clips.map((s) => {
        const exec = s.direction === 'buy_olive_sell_derive';
        return (
          <button key={s.pairKey} className="clip-card" onClick={() => onSelect(s.pairKey)}>
            <div className={`clip-total ${exec ? 'pos' : 'muted-clip'}`}>{exec ? usd(s.totalNetUsdc, 0) : `${usd(s.totalNetUsdc, 0)} ⚠`}</div>
            <div className="opp-pair">{pairLabel(s.pairKey)}</div>
            <div className="opp-meta">
              {usd(s.netAfterCapitalUsdc)}/ctr × {s.maxExecutableSize?.toFixed(0)} · APY {s.roiApyPct != null ? `${s.roiApyPct > 0 ? '+' : ''}${s.roiApyPct.toFixed(0)}%` : '–'}
            </div>
            <div className={`opp-dir ${exec ? '' : 'warn'}`}>{exec ? 'buy Olive · sell Derive' : 'LP-only direction ⚠'}</div>
          </button>
        );
      })}
    </div>
  );
}
