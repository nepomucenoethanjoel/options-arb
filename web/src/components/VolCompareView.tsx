import { useMemo } from 'react';
import { VENUE_ORDER, VENUE_SPECS, type MatchRowLite, type Venue } from '@options-arb/shared';
import { expiryLabel, num, pct } from '../format';

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

const FLAG_MARK: Record<string, string> = { smile_outlier: '◆', calendar_inversion: '⧗' };

/** Diverging cell colour: venue IV above the cross-venue median = rich (red), below = cheap (green). */
function cellStyle(dVols: number): React.CSSProperties {
  const a = Math.min(1, Math.abs(dVols) / 10) * 0.45;
  return { background: dVols > 0 ? `rgba(248, 81, 73, ${a})` : `rgba(63, 185, 80, ${a})` };
}

/**
 * Each venue's IV minus the cross-venue median for the same contract, in vol
 * points — which venue is rich or cheap where. Needs ≥ 2 venues on a
 * contract. ◆ = the venue's own smile kinks at this strike; ⧗ = its total
 * variance falls vs the previous expiry (informational, never headline).
 */
export function VolCompareView({ rows }: { rows: MatchRowLite[] }) {
  const { lines, venues } = useMemo(() => {
    const seen = new Set<Venue>();
    const lines = rows
      .map((r) => {
        const ivs = VENUE_ORDER.flatMap((v) => (r.venues[v]?.iv != null && r.venues[v]!.iv! > 0 ? [[v, r.venues[v]!.iv!] as const] : []));
        const m = median(ivs.map(([, iv]) => iv));
        for (const [v] of ivs) seen.add(v);
        return { r, ivs: new Map(ivs), median: m };
      })
      .filter((l) => l.ivs.size >= 2)
      .sort((a, b) => a.r.expiryTs - b.r.expiryTs || a.r.strike - b.r.strike || a.r.kind.localeCompare(b.r.kind));
    return { lines, venues: VENUE_ORDER.filter((v) => seen.has(v)) };
  }, [rows]);

  return (
    <div className="vol-compare">
      <p className="muted small">
        Venue IV − median IV across venues for the same contract, in vol points (red = rich: a place to sell; green = cheap: a place to buy).
        IVs are each venue&apos;s mark IV; Olive is one model vol per expiry. ◆ smile kink on that venue · ⧗ calendar inversion on that venue.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Contract</th>
              <th className="num">Median IV</th>
              {venues.map((v) => (
                <th key={v} className="num"><span className="venue-dot" style={{ background: `var(--${v})` }} />{VENUE_SPECS[v].label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lines.map(({ r, ivs, median: m }) => (
              <tr key={r.pairKey}>
                <td className="mono">{expiryLabel(r.expiryDate)} {num(r.strike, Number.isInteger(r.strike) ? 0 : 2)} {r.kind === 'call' ? 'C' : 'P'}</td>
                <td className="num mono">{pct(m)}</td>
                {venues.map((v) => {
                  const iv = ivs.get(v);
                  if (iv == null || m == null) return <td key={v} className="num muted">–</td>;
                  const d = (iv - m) * 100;
                  const marks = (r.venues[v]?.flags ?? []).map((f) => FLAG_MARK[f]).filter(Boolean).join('');
                  return (
                    <td key={v} className="num mono" style={cellStyle(d)} title={`${VENUE_SPECS[v].label} IV ${pct(iv)}${marks ? ` · ${(r.venues[v]?.flags ?? []).join(', ')}` : ''}`}>
                      {d > 0 ? '+' : ''}{d.toFixed(1)}{marks && ` ${marks}`}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {lines.length === 0 && <p className="muted">No contract quoted on two or more venues for this selection.</p>}
    </div>
  );
}
