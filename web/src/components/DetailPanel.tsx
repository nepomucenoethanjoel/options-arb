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
import type { MatchRow, Signal } from '@options-arb/shared';
import { fetchHistory, fetchPair, type HistoryResponse } from '../api';
import { daysTo, expiryLabel, num, pairLabel, pct, usd } from '../format';

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
    deriveIv: p.deriveIv != null ? +(p.deriveIv * 100).toFixed(2) : null,
    oliveIv: p.oliveIv != null ? +(p.oliveIv * 100).toFixed(2) : null,
  }));

  const dq = row?.derive.quote ?? null;
  const oq = row?.olive.quote ?? null;

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2>{pairLabel(pairKey)}</h2>
          <button className="close" onClick={onClose}>✕</button>
        </div>

        <div className="kv-grid">
          <div><span className="k">Derive IV</span><span className="v mono">{pct(dq?.iv)}</span></div>
          <div><span className="k">Olive model vol</span><span className="v mono">{pct(oq?.iv)}</span></div>
          <div><span className="k">Spread</span><span className="v mono">{signal ? `${signal.ivSpreadVols} vol pts / ${signal.ivSpreadBps} bps` : '–'}</span></div>
          <div><span className="k">Tenor</span><span className="v mono">{row ? daysTo(row.expiryTs) : '–'} → {row ? expiryLabel(row.expiryDate) : ''}</span></div>
          <div><span className="k">Derive bid/ask</span><span className="v mono">{dq?.bid?.toFixed(1) ?? '–'} / {dq?.ask?.toFixed(1) ?? '–'}</span></div>
          <div><span className="k">Olive premium (AMM)</span><span className="v mono">{usd(oq?.mark)}</span></div>
          {row?.olive.note && (
            <div className="kv-wide"><span className="k">Olive leg</span><span className="v small">{row.olive.note}</span></div>
          )}
          {row?.matchType === 'unmatched_no_counterpart' && row.unmatchedReason && (
            <div className="kv-wide"><span className="k">Unmatched</span><span className="v small">{row.unmatchedReason}</span></div>
          )}
        </div>

        {signal && (
          <>
            <h3>Profit estimate — held to expiry</h3>
            <div className="kv-grid">
              <div><span className="k">Direction</span><span className="v small">{signal.direction ?? '–'}{signal.direction === 'buy_derive_sell_olive' ? ' (writing to the Olive pool is an LP role)' : ''}</span></div>
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
              <div><span className="k">Size cap (Derive touch / pool custody)</span><span className="v mono">{signal.maxExecutableSize != null ? `${signal.maxExecutableSize.toFixed(1)} ctr` : '– (no two-sided book)'}</span></div>
              <div><span className="k">Total (size-capped)</span><span className="v mono">{signal.totalNetUsdc != null ? usd(signal.totalNetUsdc, 0) : '–'}</span></div>
              <div><span className="k">ROI APY on collateral</span><span className="v mono">{signal.roiApyPct != null ? `${signal.roiApyPct > 0 ? '+' : ''}${signal.roiApyPct.toFixed(1)}%` : '–'}</span></div>
              <div><span className="k">Settlement basis σ</span><span className="v mono" title="~1σ divergence between Derive's 30-min TWAP settlement and Olive's Stork print">{signal.settlementBasisUsdc != null ? `± ${usd(signal.settlementBasisUsdc)}` : '–'}</span></div>
              <div className="kv-wide">
                <span className="k">BS cross-check</span>
                <span className="v small">
                  Derive mark − same leg repriced at Olive vol = {usd(signal.syntheticCrossCheckUsdc)}
                  {signal.crossCheckDeviationUsdc != null && <> · vs vega×Δσ: {usd(signal.crossCheckDeviationUsdc)}</>}
                  {signal.bookVsMarkUsdc != null && <> · book mid − mark: {usd(signal.bookVsMarkUsdc)}
                    {signal.flags.includes('price_distortion') ? ' ⚠ price_distortion — the quoted edge is mostly book dislocation, not vol mispricing' : ''}</>}
                </span>
              </div>
              {signal.flags.length > 0 && (
                <div className="kv-wide"><span className="k">Flags</span><span className="v flags">{signal.flags.join(' · ')}</span></div>
              )}
            </div>
            <div className="muted small" style={{ marginTop: 8 }}>
              Assumes both legs held to expiry, where the European payoffs converge and the price difference
              locks in; settlement prints differ (TWAP vs Stork — the basis σ above), and the Olive AMM's
              depth for the size cap is unknown. Read-only estimate, not executable advice.
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
                <Line yAxisId="r" type="monotone" dataKey="deriveIv" name="Derive IV %" stroke="var(--derive)" dot={false} isAnimationActive={false} />
                <Line yAxisId="r" type="monotone" dataKey="oliveIv" name="Olive model vol %" stroke="var(--olive)" strokeDasharray="5 3" dot={false} isAnimationActive={false} />
                <ReferenceLine yAxisId="l" y={0} stroke="var(--muted)" strokeDasharray="2 4" />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}
