import { useEffect, useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { VENUE_ORDER, VENUE_SPECS, type MatchRow, type Signal } from '@options-arb/shared';
import { fetchHistory, fetchPair, type HistoryResponse } from '../api';
import { daysTo, expiryLabel, num, pairLabel, pct, usd } from '../format';
import { directionLabel, venueLabel } from '../venues';

export function DetailPanel({
  pairKey,
  initialSignal,
  onClose,
}: {
  pairKey: string;
  initialSignal: Signal | null;
  onClose: () => void;
}) {
  const [hours, setHours] = useState(24);
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [row, setRow] = useState<MatchRow | null>(null);
  const [signal, setSignal] = useState<Signal | null>(initialSignal);

  // Full detail (quotes, greeks) lives server-side — fetch on open.
  useEffect(() => {
    let live = true;
    fetchPair(pairKey)
      .then((p) => {
        if (live) {
          setRow(p.row);
          if (p.signal) setSignal(p.signal);
        }
      })
      .catch(() => {
        // drawer still shows the lite signal if the fetch fails
      });
    return () => {
      live = false;
    };
  }, [pairKey]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    fetchHistory(pairKey, hours)
      .then((h) => {
        if (live) setHistory(h);
      })
      .catch(() => {
        if (live) setHistory(null);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [pairKey, hours]);

  const chartData = (history?.points ?? []).map((p) => ({
    ts: p.ts,
    time: new Date(p.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    spread: p.spreadVols,
    ...Object.fromEntries(
      Object.entries(p.ivs ?? { derive: p.deriveIv, olive: p.oliveIv }).map(([v, iv]) => [`iv_${v}`, iv != null ? +(iv * 100).toFixed(2) : null]),
    ),
  }));
  const historyVenues = VENUE_ORDER.filter((v) => chartData.some((d) => (d as Record<string, unknown>)[`iv_${v}`] != null));
  const legVenues = VENUE_ORDER.filter((v) => row?.legs[v]);
  // The book leg whose mark the cross-check reprices (first non-AMM venue in the pair).
  const refVenue = signal
    ? VENUE_ORDER.find((v) => (v === signal.buyVenue || v === signal.sellVenue) && VENUE_SPECS[v].quoteKind !== 'amm_synthetic')
    : undefined;
  const otherVenue = refVenue === signal?.buyVenue ? signal?.sellVenue : signal?.buyVenue;

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2>{pairLabel(pairKey)}</h2>
          <button className="close" onClick={onClose}>✕</button>
        </div>

        <table className="venue-quotes">
          <thead>
            <tr><th>Venue</th><th>IV</th><th>Bid</th><th>Ask</th><th>Mark / premium</th></tr>
          </thead>
          <tbody>
            {legVenues.map((v) => {
              const leg = row!.legs[v]!;
              const q = leg.quote;
              const role = signal?.buyVenue === v ? 'buy' : signal?.sellVenue === v ? 'sell' : null;
              return (
                <tr key={v}>
                  <td>
                    <span className="venue-dot" style={{ background: `var(--${v})` }} />
                    {venueLabel(v)} {role && <span className={`chip ${role === 'buy' ? 'ok' : 'warn'}`}>{role}</span>}
                    {leg.note && <span className="muted small"> · {leg.note}</span>}
                  </td>
                  <td className="mono">{pct(q?.iv)}{q?.ivSource === 'model' ? ' (model)' : ''}</td>
                  <td className="mono">{q?.bid != null ? q.bid.toFixed(2) : '–'}{q?.bidSize != null ? <span className="muted small"> ×{num(q.bidSize, 1)}</span> : null}</td>
                  <td className="mono">{q?.ask != null ? q.ask.toFixed(2) : '–'}{q?.askSize != null ? <span className="muted small"> ×{num(q.askSize, 1)}</span> : null}</td>
                  <td className="mono">{usd(q?.mark)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="kv-grid">
          <div><span className="k">Spread</span><span className="v mono">{signal ? `${signal.ivSpreadVols} vol pts / ${signal.ivSpreadBps} bps` : '–'}</span></div>
          <div><span className="k">Tenor</span><span className="v mono">{row ? daysTo(row.expiryTs) : '–'} → {row ? expiryLabel(row.expiryDate) : ''}</span></div>
          {row?.matchType === 'unmatched_no_counterpart' && row.unmatchedReason && (
            <div className="kv-wide"><span className="k">Unmatched</span><span className="v small">{row.unmatchedReason}</span></div>
          )}
        </div>

        {signal && (
          <>
            <h3>Profit estimate — held to expiry</h3>
            <div className="kv-grid">
              <div><span className="k">Direction</span><span className="v small">{directionLabel(signal)}{signal.flags.includes('direction_limited') ? ` (shorting on ${venueLabel(signal.sellVenue)} is an LP role)` : ''}</span></div>
              <div><span className="k">Entry (pay)</span><span className="v mono">{usd(signal.entryPriceUsdc)}</span></div>
              <div><span className="k">Exit (receive)</span><span className="v mono">{usd(signal.exitPriceUsdc)}</span></div>
              <div><span className="k">Gross edge</span><span className="v mono">{usd(signal.edgeUsdc)}</span></div>
              <div><span className="k">− Fees + gas</span><span className="v mono">{usd(signal.costsUsdc)}</span></div>
              <div><span className="k">− Collateral drag</span><span className="v mono">{usd(signal.capitalCostUsdc)}</span></div>
              <div>
                <span className="k">= Net / contract</span>
                <span className={`v mono ${signal.netAfterCapitalUsdc != null && signal.netAfterCapitalUsdc >= 0 ? 'pos-val' : 'neg-val'}`}>
                  {signal.netAfterCapitalUsdc != null ? usd(signal.netAfterCapitalUsdc) : '–'} {signal.isProfitable ? '✓' : '✗'}
                </span>
              </div>
              <div><span className="k">Size cap (book touch / pool capacity)</span><span className="v mono">{signal.maxExecutableSize != null ? `${signal.maxExecutableSize.toFixed(1)} ctr` : '– (no two-sided book)'}</span></div>
              <div><span className="k">Total (size-capped)</span><span className="v mono">{signal.totalNetUsdc != null ? usd(signal.totalNetUsdc, 0) : '–'}</span></div>
              {signal.expectedEntryUsdc != null && signal.expectedTotalNetUsdc != null && (
                <>
                  <div><span className="k">Expected avg fill</span><span className="v mono" title="The clip's own size pushes the pool's borrow curve, repricing the AMM as you fill — this is the utilization-integrated average entry, not the first quote">{usd(signal.expectedEntryUsdc)} vs {usd(signal.entryPriceUsdc)} quoted</span></div>
                  <div>
                    <span className="k">= Expected total</span>
                    <span className={`v mono ${signal.expectedTotalNetUsdc >= 0 ? 'pos-val' : 'neg-val'}`}>
                      {usd(signal.expectedTotalNetUsdc, 0)}
                      {signal.expectedTotalNetUsdc < (signal.totalNetUsdc ?? 0) ? ' (rate impact priced in)' : ''}
                    </span>
                  </div>
                </>
              )}
              <div><span className="k">ROI APY on collateral</span><span className="v mono">{signal.roiApyPct != null ? `${signal.roiApyPct > 0 ? '+' : ''}${signal.roiApyPct.toFixed(1)}%` : '–'}</span></div>
              <div><span className="k">Settlement basis σ</span><span className="v mono" title="~1σ divergence between the two venues' settlement prices (averaging windows / oracle sources differ)">{signal.settlementBasisUsdc != null ? `± ${usd(signal.settlementBasisUsdc)}` : '–'}</span></div>
              <div className="kv-wide">
                <span className="k">BS cross-check</span>
                <span className="v small">
                  {venueLabel(refVenue)} mark − same leg repriced at {venueLabel(otherVenue)} vol = {usd(signal.syntheticCrossCheckUsdc)}
                  {signal.crossCheckDeviationUsdc != null && <> · vs vega×Δσ: {usd(signal.crossCheckDeviationUsdc)}</>}
                  {signal.bookVsMarkUsdc != null && <> · book mid − mark: {usd(signal.bookVsMarkUsdc)}
                    {signal.flags.includes('price_distortion') ? ' ⚠ price_distortion — the quoted edge is mostly book dislocation, not vol mispricing' : ''}</>}
                </span>
              </div>
              {signal.flags.length > 0 && (
                <div className="kv-wide"><span className="k">Flags</span><span className="v flags">{signal.flags.join(' · ')}</span></div>
              )}
            </div>
            {signal.alternatives && signal.alternatives.length > 0 && (
              <>
                <h3>Other venue pairs</h3>
                <table className="venue-quotes">
                  <thead>
                    <tr><th>Pair</th><th>Spread</th><th>Entry → exit</th><th>Net/ctr</th><th>Total (honest)</th></tr>
                  </thead>
                  <tbody>
                    {signal.alternatives.map((a) => (
                      <tr key={`${a.buyVenue}-${a.sellVenue}`} title={a.flags.join(' · ')}>
                        <td>{directionLabel(a)}{a.flags.includes('direction_limited') ? ' ⚠' : ''}</td>
                        <td className="mono">{a.ivSpreadVols ?? '–'}</td>
                        <td className="mono">{usd(a.entryPriceUsdc)} → {usd(a.exitPriceUsdc)}</td>
                        <td className="mono">{usd(a.netAfterCapitalUsdc)}</td>
                        <td className="mono">{a.honestTotalNetUsdc != null ? usd(a.honestTotalNetUsdc, 0) : '–'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
            <div className="muted small" style={{ marginTop: 8 }}>
              Assumes both legs held to expiry, where the European payoffs converge and the price difference
              locks in; venues' settlement prices differ (the basis σ above), and AMM / RFQ depth beyond the
              size cap is unknown. Read-only estimate, not executable advice.
            </div>
          </>
        )}

        <div className="history-controls">
          <h3>Spread history</h3>
          <div>
            {[6, 24, 168].map((h) => (
              <button key={h} className={hours === h ? 'active' : ''} onClick={() => setHours(h)}>
                {h < 24 ? `${h}h` : `${Math.round(h / 24)}d`}
              </button>
            ))}
          </div>
        </div>
        <div className="chart">
          {loading && !history ? (
            <div className="muted">Loading history…</div>
          ) : chartData.length === 0 ? (
            <div className="muted">
              No stored history yet — points accumulate one per poll cycle. Score {signal ? num(signal.score, 1) : '–'}.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={chartData} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="time" stroke="var(--muted)" fontSize={11} />
                <YAxis stroke="var(--muted)" fontSize={11} yAxisId="l" label={{ value: 'vol pts', angle: -90, position: 'insideLeft', fill: 'var(--muted)', fontSize: 11 }} />
                <YAxis orientation="right" stroke="var(--muted)" fontSize={11} yAxisId="r" label={{ value: 'IV %', angle: 90, position: 'insideRight', fill: 'var(--muted)', fontSize: 11 }} />
                <Tooltip
                  contentStyle={{ background: 'var(--panel2)', border: '1px solid var(--border)', borderRadius: 8 }}
                  labelStyle={{ color: 'var(--text)' }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line yAxisId="l" type="monotone" dataKey="spread" name="Spread (vol pts)" stroke="var(--accent)" strokeWidth={2} dot={false} isAnimationActive={false} />
                {historyVenues.map((v) => (
                  <Line
                    key={v}
                    yAxisId="r"
                    type="monotone"
                    dataKey={`iv_${v}`}
                    name={`${venueLabel(v)} ${VENUE_SPECS[v].quoteKind === 'amm_synthetic' ? 'model vol' : 'IV'} %`}
                    stroke={`var(--${v})`}
                    strokeDasharray={VENUE_SPECS[v].quoteKind === 'amm_synthetic' ? '5 3' : undefined}
                    dot={false}
                    isAnimationActive={false}
                    connectNulls
                  />
                ))}
                <ReferenceLine yAxisId="l" y={0} stroke="var(--muted)" strokeDasharray="2 4" />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}
