import { useMemo, useState } from 'react';
import type { MatchRowLite, Signal } from '@options-arb/shared';
import { useLiveOverview } from './api';
import { Header } from './components/Header';
import { CaveatBanner } from './components/CaveatBanner';
import { TopClips } from './components/OpportunityFeed';
import { ProfitTable, rowClass, type ShowPreset } from './components/ProfitTable';
import { DetailPanel } from './components/DetailPanel';
import { SmileView, type TermPoint } from './components/SmileView';
import { pairLabel, usd } from './format';

export default function App() {
  const { data, connected } = useLiveOverview();

  const [underlying, setUnderlying] = useState<string>('');
  const [expiry, setExpiry] = useState<string>('all');
  const [preset, setPreset] = useState<ShowPreset>('profitable');
  const [kind, setKind] = useState<'all' | 'call' | 'put'>('all');
  const [selectedPair, setSelectedPair] = useState<string | null>(null);
  const [tab, setTab] = useState<'profit' | 'analysis'>('profit');

  const signalsByPair = useMemo(() => {
    const map = new Map<string, Signal>();
    for (const s of data?.signals ?? []) map.set(s.pairKey, s);
    return map;
  }, [data]);

  const underlyings = useMemo(() => {
    const set = new Set<string>(data?.config?.underlyings ?? []);
    for (const r of data?.rows ?? []) set.add(r.underlying);
    return [...set].sort();
  }, [data]);

  const effectiveUnderlying = underlying || underlyings[0] || '';

  const expiries = useMemo(() => {
    const set = new Set<string>();
    for (const r of data?.rows ?? []) if (r.underlying === effectiveUnderlying) set.add(r.expiryDate);
    return [...set].sort();
  }, [data, effectiveUnderlying]);

  // GLOBAL profit search: executable clips first; LP-only rows can't be
  // captured by a user, so they only headline when nothing executable exists.
  const allProfitable = useMemo(
    () =>
      (data?.signals ?? [])
        .filter((s) => s.isProfitable && s.totalNetUsdc != null && s.netAfterCapitalUsdc != null)
        .sort((a, b) => (b.totalNetUsdc ?? 0) - (a.totalNetUsdc ?? 0)),
    [data],
  );
  const executableClips = useMemo(() => allProfitable.filter((s) => s.direction === 'buy_olive_sell_derive'), [allProfitable]);
  const clips = executableClips.length > 0 ? executableClips : allProfitable;
  const clipsAreLpOnly = executableClips.length === 0 && allProfitable.length > 0;

  const kpi = useMemo(() => {
    const best = clips[0] ?? null;
    const totalDollars = executableClips.reduce((a, s) => a + (s.totalNetUsdc ?? 0), 0);
    // Closest to profitable anywhere (executable direction, clean books).
    const closest = (data?.signals ?? [])
      .filter((s) => s.direction === 'buy_olive_sell_derive' && !s.flags.includes('price_distortion') && s.netAfterCapitalUsdc != null && !s.isProfitable)
      .sort((a, b) => (b.netAfterCapitalUsdc ?? -Infinity) - (a.netAfterCapitalUsdc ?? -Infinity))[0] ?? null;
    return { best, totalDollars, closest, profitableCount: executableClips.length };
  }, [clips, executableClips, data]);

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
      if (r.underlying !== effectiveUnderlying || r.kind !== 'call') continue;
      const cur = byExpiry.get(r.expiryDate);
      if (!cur || Math.abs(r.strike - spot) < Math.abs(cur.strike - spot)) byExpiry.set(r.expiryDate, r);
    }
    return [...byExpiry.values()]
      .map((r) => ({
        expiryDate: r.expiryDate,
        days: +((r.expiryTs - Date.now()) / 86_400_000).toFixed(1),
        atmIvPct: r.deriveIv != null ? +(r.deriveIv * 100).toFixed(1) : null,
      }))
      .filter((p) => p.atmIvPct != null && p.days >= 0)
      .sort((a, b) => a.days - b.days);
  }, [data, effectiveUnderlying]);

  if (!data) {
    return (
      <div className="app">
        <div className="loading">
          <h1>Olive × Derive — IV Arbitrage Dashboard</h1>
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
        {kpi.best && !clipsAreLpOnly ? (
          <div className="kpi main">
            <span className="k">Best executable clip</span>
            <span className="v total pos">{usd(kpi.best.totalNetUsdc, 0)}</span>
            <span className="sub">{pairLabel(kpi.best.pairKey)} · {usd(kpi.best.netAfterCapitalUsdc)}/ctr × {kpi.best.maxExecutableSize?.toFixed(0)}</span>
          </div>
        ) : (
          <div className="kpi main">
            <span className="k">Best executable clip</span>
            <span className="v muted">none</span>
            <span className="sub">
              {kpi.closest?.pairKey
                ? `closest: ${pairLabel(kpi.closest.pairKey)} at ${usd(kpi.closest.netAfterCapitalUsdc)}/ctr`
                : 'no executable rows'}
              {clipsAreLpOnly ? ` · ${allProfitable.length} LP-only rows exist (need pool access to capture)` : ''}
            </span>
          </div>
        )}
        <div className="kpi"><span className="k">Executable profitable rows</span><span className="v">{kpi.profitableCount}</span></div>
        <div className="kpi"><span className="k">Σ total $ (all assets)</span><span className="v">{usd(kpi.totalDollars, 0)}</span></div>
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
        {' '}Full-chain scan every cycle ({Math.round((data.config?.pollIntervalMs ?? 0) / 1000)}s+).
      </footer>
    </div>
  );
}
