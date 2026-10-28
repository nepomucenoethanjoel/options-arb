import { honestTotalNetUsdc, isTwoLegExecutable, type Signal } from '@options-arb/shared';
import { directionLabel } from '../venues';
import { fmtSize, pairLabel, usd } from '../format';

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
        const exec = isTwoLegExecutable(s);
        return (
          <button key={s.pairKey} className="clip-card" onClick={() => onSelect(s.pairKey)}>
            <div className={`clip-total ${exec ? 'pos' : 'muted-clip'}`}>{exec ? usd(honestTotalNetUsdc(s), 0) : `${usd(honestTotalNetUsdc(s), 0)} ⚠`}</div>
            <div className="opp-pair">{pairLabel(s.pairKey)}</div>
            <div className="opp-meta">
              {usd(s.netAfterCapitalUsdc)}/ctr × {fmtSize(s.maxExecutableSize)} · APY {s.roiApyPct != null ? `${s.roiApyPct > 0 ? '+' : ''}${s.roiApyPct.toFixed(0)}%` : '–'}
            </div>
            <div className={`opp-dir ${exec ? '' : 'warn'}`}>{exec ? directionLabel(s) : `${directionLabel(s)} · LP-only ⚠`}</div>
          </button>
        );
      })}
    </div>
  );
}
