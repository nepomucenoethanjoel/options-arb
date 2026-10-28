import { useMemo, useState } from 'react';
import { honestTotalNetUsdc, type MatchRowLite, type Signal } from '@options-arb/shared';
import { useLiveOverview } from './api';
import { Header } from './components/Header';
import { CaveatBanner } from './components/CaveatBanner';
import { TopClips } from './components/OpportunityFeed';
import { ProfitTable, rowClass, type ShowPreset } from './components/ProfitTable';
import { DetailPanel } from './components/DetailPanel';
import { SmileView, type TermPoint } from './components/SmileView';
import { pairLabel, usd, fmtSize } from './format';

export default function App() {
  const [underlying, setUnderlying] = useState<string>('');
  const [expiry, setExpiry] = useState<string>('all');
  const [preset, setPreset] = useState<ShowPreset>('profitable');
  const [kind, setKind] = useState<'all' | 'call' | 'put'>('all');
  const [selectedPair, setSelectedPair] = useState<string | null>(null);
  const [tab, setTab] = useState<'profit' | 'analysis'>('profit');

  // The hook fetches/subscribes to ONE underlying ('' → the server picks the
  // first configured); it ships only that underlying's rows/signals plus the
  // global KPI digest (header, KPI strip, top clips).
  const { data, connected } = useLiveOverview(underlying);

  const underlyings = useMemo(() => [...new Set(data?.config?.underlyings ?? [])], [data]);

  // Default to the subscription the server actually served (it normalizes
  // '' to the first configured underlying) so the dropdown never disagrees
  // with the data in the table.
  const effectiveUnderlying = underlying || data?.underlying || underlyings[0] || '';

  const signalsByPair = useMemo(() => {
    const map = new Map<string, Signal>();
    for (const s of data?.signals ?? []) map.set(s.pairKey, s);
    return map;
  }, [data]);

  const expiries = useMemo(() => {
    const set = new Set<string>();
    for (const r of data?.rows ?? []) if (r.underlying === effectiveUnderlying) set.add(r.expiryDate);
    return [...set].sort();
  }, [data, effectiveUnderlying]);

  // GLOBAL profit view from the server-side KPI digest: executable clips
  // first; LP-only rows can't be captured by a user, so they only headline
  // when nothing executable exists.
  const kpi = data?.kpi ?? null;
  const clips = kpi ? (kpi.topExecutable.length > 0 ? kpi.topExecutable : kpi.topAny) : [];
  const clipsAreLpOnly = !!kpi && kpi.topExecutable.length === 0 && kpi.lpOnlyProfitableCount > 0;
  const kpiSummary = useMemo(
    () => ({
      best: clips[0] ?? null,
      totalDollars: kpi?.totalExecutableUsd ?? 0,
      closest: kpi?.closest ?? null,
      profitableCount: kpi?.executableProfitableCount ?? 0,
    }),
    [kpi, clips],
  );

  const rows = useMemo(() => {
    let list: MatchRowLite[] = (data?.rows ?? []).filter((r) => r.underlying === effectiveUnderlying);
    if (expiry !== 'all') list = list.filter((r) => r.expiryDate === expiry);
    if (kind !== 'all') list = list.filter((r) => r.kind === kind);
    return list;
  }, [data, effectiveUnderlying, expiry, kind]);

  const term = useMemo<TermPoint[]>(() => {
    const spot = data?.spots?.[effectiveUnderlying] ?? null;
    if (spot == null) return [];
    const byExpiry = new Map<string, MatchRowLite>();
    for (const r of data?.rows ?? []) {
      if (r.underlying !== effectiveUnderlying || r.kind !== 'call' || r.venues.derive?.iv == null) continue;
      const cur = byExpiry.get(r.expiryDate);
      if (!cur || Math.abs(r.strike - spot) < Math.abs(cur.strike - spot)) byExpiry.set(r.expiryDate, r);
    }
    return [...byExpiry.values()]
      .map((r) => ({
        expiryDate: r.expiryDate,
        days: +((r.expiryTs - Date.now()) / 86_400_000).toFixed(1),
        atmIvPct: r.venues.derive?.iv != null ? +(r.venues.derive.iv * 100).toFixed(1) : null,
      }))
      .filter((p) => p.atmIvPct != null && p.days >= 0)
      .sort((a, b) => a.days - b.days);
  }, [data, effectiveUnderlying]);

  if (!data) {
    return (
      <div className="app">
        <div className="loading">
          <h1>Options IV Arbitrage Monitor</h1>
          <p>Connecting to the local server… (start it with `npm run dev:server`)</p>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <Header data={data} connected={connected} />
      <CaveatBanner caveats={data.oliveCaveats} />

      <div className="kpi-strip">
        {kpiSummary.best && !clipsAreLpOnly ? (
          <div className="kpi main">
            <span className="k">Best executable clip</span>
            <span className="v total pos">{usd(honestTotalNetUsdc(kpiSummary.best), 0)}</span>
            <span className="sub">{pairLabel(kpiSummary.best.pairKey)} · {usd(kpiSummary.best.netAfterCapitalUsdc)} × {fmtSize(kpiSummary.best.maxExecutableSize)}</span>
          </div>
        ) : (
          <div className="kpi main">
            <span className="k">Best executable clip</span>
            <span className="v muted">none</span>
            <span className="sub">
              {kpiSummary.closest?.pairKey
                ? `closest: ${pairLabel(kpiSummary.closest.pairKey)} at ${usd(kpiSummary.closest.netAfterCapitalUsdc)}/ctr`
                : 'no executable rows'}
              {clipsAreLpOnly ? ` · ${kpi?.lpOnlyProfitableCount ?? 0} LP-only rows exist (need pool access to capture)` : ''}
            </span>
          </div>
        )}
        <div className="kpi"><span className="k">Executable profitable rows</span><span className="v">{kpiSummary.profitableCount}</span></div>
        <div className="kpi"><span className="k">Σ best clip $ (per pool)</span><span className="v" title="Best single executable clip per underlying, summed across pools. When the clip's own fill moves the pool's borrow rate, the marginal-fill (expected) total is used — see Expected total in the row detail.">{usd(kpiSummary.totalDollars, 0)}</span></div>
        <div className="tabs">
          <button className={tab === 'profit' ? 'active' : ''} onClick={() => setTab('profit')}>Profit</button>
          <button className={tab === 'analysis' ? 'active' : ''} onClick={() => setTab('analysis')}>Analysis</button>
        </div>
      </div>

      {tab === 'profit' ? (
        <>
          <TopClips clips={clips.slice(0, 3)} onSelect={setSelectedPair} />
          <div className="controls">
            <label>
              Underlying{' '}
              <select value={effectiveUnderlying} onChange={(e) => { setUnderlying(e.target.value); setExpiry('all'); }}>
                {underlyings.map((u) => <option key={u}>{u}</option>)}
              </select>
            </label>
            <label>
              Expiry{' '}
              <select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
                <option value="all">All expiries</option>
                {expiries.map((e) => <option key={e} value={e}>{e}</option>)}
              </select>
            </label>
            <label>
              Show{' '}
              <select value={preset} onChange={(e) => setPreset(e.target.value as ShowPreset)}>
                <option value="profitable">Profitable only</option>
                <option value="opportunities">Opportunities (≥ {data.config?.ivSpreadThresholdVols ?? 3} pts)</option>
                <option value="all">Everything</option>
              </select>
            </label>
            <div className="kind-toggle">
              {(['all', 'call', 'put'] as const).map((k) => (
                <button key={k} className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>
                  {k === 'all' ? 'C+P' : k === 'call' ? 'Calls' : 'Puts'}
                </button>
              ))}
            </div>
          </div>
          <ProfitTable rows={rows} signalsByPair={signalsByPair} preset={preset} onSelect={setSelectedPair} />
        </>
      ) : (
        <SmileView underlying={effectiveUnderlying} expiry={expiry !== 'all' ? expiry : term[0]?.expiryDate ?? ''} rows={rows} term={term} />
      )}

      {selectedPair && (
        <DetailPanel
          pairKey={selectedPair}
          initialSignal={signalsByPair.get(selectedPair) ?? null}
          onClose={() => setSelectedPair(null)}
        />
      )}

      <footer>
        Read-only signal tool — no execution. Estimates held-to-expiry after fees, capital drag, and pool-capacity sizing.
        {' '}Olive settlement relies on their keeper being alive (observed inactive at times).
        {' '}Full-chain scan every cycle ({Math.round((data.config?.pollIntervalMs ?? 0) / 1000)}s+).
      </footer>
    </div>
  );
}
