import { useEffect, useState } from 'react';
import { fetchEpisodeSummary, type EpisodeSummaryResponse, type EpisodeTier } from '../api';
import { ago, pairLabel, usd } from '../format';
import { venueLabel } from '../venues';

const TIER_LABEL: Record<EpisodeTier, string> = {
  headline: 'Executable (headline)',
  parity: 'Put-call parity',
  reference: 'Needs a reference-only venue',
  quote_only: 'Quoted only — fill model erases it',
};

const TIER_HELP: Record<EpisodeTier, string> = {
  headline: 'Honest clip total > 0 on clean books, both legs user-executable — what the KPI counts.',
  parity: 'Conversion / reversal across venues with a dated-future hedge (reference only). Measured per contract — the future size is not read.',
  reference: 'Would be headline, but a leg is on a venue you cannot trade (Deribit).',
  quote_only: 'Quoted clip total > 0, but the marginal-fill (expected) total is ≤ 0 — the gap your own trade closes.',
};

function duration(cycles: number, pollMs: number): string {
  const s = (cycles * pollMs) / 1000;
  if (s < 90) return `~${Math.round(s)}s`;
  if (s < 5400) return `~${Math.round(s / 60)}m`;
  return `~${(s / 3600).toFixed(1)}h`;
}

/** "Did arb ever exist?" — gap episodes measured live at cycle resolution. */
export function EpisodesPanel() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<EpisodeSummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      fetchEpisodeSummary(days)
        .then((d) => live && (setData(d), setError(null)))
        .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [days]);

  const poll = data?.pollIntervalMs ?? 15_000;
  const tiers = (['headline', 'parity', 'reference', 'quote_only'] as const).filter((t) => data?.rows.some((r) => r.tier === t));

  return (
    <div className="episodes">
      <div className="controls">
        <label>
          Window{' '}
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[1, 7, 30, 90].map((d) => <option key={d} value={d}>{d === 1 ? '24 hours' : `${d} days`}</option>)}
          </select>
        </label>
        {data && (
          <span className="muted">
            Measuring since {data.trackingSinceTs ? ago(data.trackingSinceTs) : '–'} (this process; restarts lose only open episodes) · {data.openCount} open now
          </span>
        )}
      </div>
      {error && <p className="muted">Could not load: {error}</p>}
      {data && data.rows.length === 0 && <p className="muted">No gap of any tier seen in this window.</p>}
      {tiers.map((tier) => (
        <section key={tier}>
          <h3 title={TIER_HELP[tier]}>{TIER_LABEL[tier]}</h3>
          <p className="muted small">{TIER_HELP[tier]}</p>
          <div className="table-wrap"><table>
            <thead>
              <tr>
                <th>Underlying</th><th>Pair</th><th className="num" title="Contract-level episodes">Episodes</th><th className="num" title="Overlapping or back-to-back episodes merged: one clip per window">Windows</th>
                <th className="num">Median</th><th className="num">p90</th><th className="num">Longest</th>
                <th className="num">{tier === 'quote_only' ? 'Best quoted' : tier === 'parity' ? 'Σ best / window / ctr' : 'Σ best / window'}</th><th>Best episode</th>
              </tr>
            </thead>
            <tbody>
              {data!.rows.filter((r) => r.tier === tier).map((r) => (
                <tr key={`${r.underlying}|${r.buyVenue}|${r.sellVenue}`}>
                  <td>{r.underlying}</td>
                  <td>buy {venueLabel(r.buyVenue)} · sell {venueLabel(r.sellVenue)}</td>
                  <td className="num">{r.count}</td>
                  <td className="num">{r.windows}</td>
                  <td className="num">{duration(r.medianCycles, poll)}</td>
                  <td className="num">{duration(r.p90Cycles, poll)}</td>
                  <td className="num">{duration(r.maxCycles, poll)}</td>
                  <td className="num">{tier === 'quote_only' ? usd(r.best.peakQuotedUsdc) : usd(r.sumWindowPeakUsdc)}</td>
                  <td>
                    {pairLabel(r.best.pairKey)} · {tier === 'quote_only' ? `${usd(r.best.peakQuotedUsdc)} quoted / ${usd(r.best.peakHonestUsdc)} expected` : usd(r.best.peakHonestUsdc)} · {ago(r.best.startTs)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </section>
      ))}
    </div>
  );
}
