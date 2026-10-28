import { useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { VENUE_ORDER, VENUE_SPECS, type MatchRowLite } from '@options-arb/shared';
import { fetchSurface, type SurfaceResponse } from '../api';
import { expiryLabel } from '../format';

/** Listed venues beyond the Derive smile / Olive flat line this view is built around. */
const EXTRA_VENUES = VENUE_ORDER.filter((v) => v !== 'derive' && v !== 'olive');

export interface TermPoint {
  expiryDate: string;
  days: number;
  atmIvPct: number | null;
}

/**
 * The crossover view: Derive's smile vs Olive's flat model vol. Green dots =
 * strikes where Derive IV is above Olive's line (the executable
 * buy-Olive/sell-Derive side); shaded bands show where those profitable
 * strikes intersect Olive's ±1σ quotable bounds. Below it, an ATM
 * term-structure strip against the same flat line.
 */
export function SmileView({
  underlying,
  expiry,
  rows,
  term,
}: {
  underlying: string;
  expiry: string;
  rows: MatchRowLite[];
  term: TermPoint[];
}) {
  const [kind, setKind] = useState<'call' | 'put'>('call');
  const [surface, setSurface] = useState<SurfaceResponse | null>(null);

  useEffect(() => {
    let live = true;
    if (!underlying) return;
    fetchSurface(underlying, expiry || undefined)
      .then((s) => {
        if (live) setSurface(s);
      })
      .catch(() => {
        if (live) setSurface(null);
      });
    return () => {
      live = false;
    };
  }, [underlying, expiry]);

  const flatVol = surface?.oliveModelVol != null ? +(surface.oliveModelVol * 100).toFixed(2) : null;
  const spot = surface?.oliveSpot ?? null;
  const bounds = surface?.oliveBounds ?? null;

  const data = useMemo(() => {
    const quotes = (surface?.deriveQuotes ?? []).filter((q) => q.kind === kind && q.iv != null);
    const byStrike = new Map<number, { strike: number; quoteIv?: number; sviIv?: number } & Record<string, number | undefined>>();
    for (const q of quotes) byStrike.set(q.strike, { strike: q.strike, quoteIv: +(q.iv! * 100).toFixed(2) });
    for (const p of surface?.deriveSvi ?? []) {
      const e = byStrike.get(Math.round(p.strike));
      if (e) e.sviIv = +(p.iv * 100).toFixed(2);
    }
    // Other listed venues' quoted IVs on the same expiry, one dot series each.
    const exp = surface?.expiryDate ?? expiry;
    for (const r of rows) {
      if (r.kind !== kind || (exp && r.expiryDate !== exp)) continue;
      for (const v of EXTRA_VENUES) {
        const iv = r.venues[v]?.iv;
        if (iv == null) continue;
        const e = byStrike.get(r.strike) ?? { strike: r.strike };
        e[`${v}Iv`] = +(iv * 100).toFixed(2);
        byStrike.set(r.strike, e);
      }
    }
    return [...byStrike.values()].sort((a, b) => a.strike - b.strike);
  }, [surface, kind, rows, expiry]);
  const extraVenuesShown = EXTRA_VENUES.filter((v) => data.some((d) => d[`${v}Iv`] != null));

  // Split quote dots into above/below the flat line + profitable bands.
  const { above, below, bands } = useMemo(() => {
    if (flatVol == null) return { above: new Map<number, number>(), below: new Map<number, number>(), bands: [] as Array<{ from: number; to: number }> };
    const above = new Map<number, number>();
    const below = new Map<number, number>();
    const sorted = [...data].filter((d) => d.quoteIv != null);
    for (const d of sorted) {
      if ((d.quoteIv ?? 0) > flatVol) above.set(d.strike, d.quoteIv!);
      else below.set(d.strike, d.quoteIv!);
    }
    // Contiguous runs of above-strikes → profitable bands.
    const bands: Array<{ from: number; to: number }> = [];
    let run: number[] = [];
    for (const d of sorted) {
      if (above.has(d.strike)) {
        run.push(d.strike);
      } else if (run.length > 0) {
        bands.push({ from: run[0], to: run[run.length - 1] });
        run = [];
      }
    }
    if (run.length > 0) bands.push({ from: run[0], to: run[run.length - 1] });
    return { above, below, bands };
  }, [data, flatVol]);

  const withSplit = useMemo(
    () => data.map((d) => ({ ...d, aboveIv: above.get(d.strike) ?? null, belowIv: below.get(d.strike) ?? null })),
    [data, above, below],
  );

  const xDomain = useMemo<[number, number]>(() => {
    const strikes = data.map((d) => d.strike);
    if (strikes.length === 0 && spot != null) return [spot * 0.9, spot * 1.1];
    const lo = Math.min(...strikes, bounds?.lower ?? Infinity);
    const hi = Math.max(...strikes, bounds?.upper ?? -Infinity);
    const pad = (hi - lo) * 0.03 || 1;
    return [Number.isFinite(lo) ? lo - pad : 0, Number.isFinite(hi) ? hi + pad : 1];
  }, [data, bounds, spot]);

  const nearestQuoteIv = useMemo(
    () =>
      spot
        ? data.reduce<{ best: number; dist: number } | null>((acc, d) => {
            const dist = Math.abs(d.strike - spot);
            return !acc || dist < acc.dist ? { best: d.quoteIv ?? 0, dist } : acc;
          }, null)?.best ?? null
        : null,
    [data, spot],
  );

  return (
    <div className="smile-view">
      <div className="history-controls">
        <h3>
          IV smile — {underlying} {expiry ? expiryLabel(expiry) : ''}
          {flatVol != null && <span className="muted small"> · Olive flat {flatVol}% · green = Derive above (executable side)</span>}
        </h3>
        <div>
          {(['call', 'put'] as const).map((k) => (
            <button key={k} className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>
              {k === 'call' ? 'Calls' : 'Puts'}
            </button>
          ))}
        </div>
      </div>
      <div className="chart">
        {data.length === 0 && flatVol == null ? (
          <div className="muted">No surface data yet.</div>
        ) : (
          <ResponsiveContainer width="100%" height={340}>
            <LineChart data={withSplit} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              {bounds && (
                <ReferenceArea x1={bounds.lower} x2={bounds.upper} fill="var(--muted)" fillOpacity={0.06}
                  label={{ value: 'Olive quotable ±1σ', fill: 'var(--muted)', fontSize: 10, position: 'insideTop' }} />
              )}
              {flatVol != null && bounds != null &&
                bands
                  .map((b) => ({
                    from: Math.max(b.from, bounds.lower),
                    to: Math.min(b.to, bounds.upper),
                  }))
                  .filter((b) => b.to > b.from)
                  .map((b, i) => (
                    <ReferenceArea key={i} x1={b.from} x2={b.to} fill="var(--ok)" fillOpacity={0.14} />
                  ))}
              <XAxis
                dataKey="strike"
                type="number"
                domain={xDomain}
                stroke="var(--muted)"
                fontSize={11}
                tickFormatter={(v: number) => v.toLocaleString()}
                label={{ value: 'strike', position: 'insideBottom', offset: -4, fill: 'var(--muted)', fontSize: 11 }}
              />
              <YAxis stroke="var(--muted)" fontSize={11} domain={['auto', 'auto']} tickFormatter={(v: number) => `${v}%`} />
              <Tooltip
                contentStyle={{ background: 'var(--panel2)', border: '1px solid var(--border)', borderRadius: 8 }}
                labelFormatter={(v) => `strike ${Number(v).toLocaleString()}`}
                formatter={(value: number | string, name) => [typeof value === 'number' ? `${value}%` : value, name]}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="aboveIv" name="Derive IV > Olive (executable)" stroke="var(--ok)" strokeWidth={0} dot={{ r: 3, fill: 'var(--ok)' }} isAnimationActive={false} />
              <Line type="monotone" dataKey="belowIv" name="Derive IV < Olive" stroke="var(--neg)" strokeWidth={0} dot={{ r: 2.5, fill: 'var(--neg)' }} isAnimationActive={false} />
              <Line type="monotone" dataKey="sviIv" name="Derive SVI feed" stroke="var(--derive)" strokeWidth={1} dot={false} isAnimationActive={false} connectNulls />
              {extraVenuesShown.map((v) => (
                <Line key={v} type="monotone" dataKey={`${v}Iv`} name={`${VENUE_SPECS[v].label} IV`} stroke={`var(--${v})`} strokeWidth={0} dot={{ r: 2.5, fill: `var(--${v})` }} isAnimationActive={false} />
              ))}
              {flatVol != null && (
                <Line
                  type="monotone"
                  dataKey={() => flatVol}
                  name="Olive model vol (flat)"
                  stroke="var(--olive)"
                  strokeWidth={2}
                  strokeDasharray="6 3"
                  dot={false}
                  isAnimationActive={false}
                />
              )}
              {spot != null && <ReferenceLine x={spot} stroke="var(--muted)" strokeDasharray="2 4" label={{ value: 'spot', fill: 'var(--muted)', fontSize: 10, position: 'top' }} />}
              {flatVol != null && (
                <ReferenceLine y={flatVol} stroke="var(--olive)" strokeDasharray="2 4" strokeOpacity={0.5} />
              )}
              {nearestQuoteIv != null && flatVol != null && (
                <ReferenceLine
                  y={(nearestQuoteIv + flatVol) / 2}
                  stroke="transparent"
                  label={{ value: `Δ ATM ${nearestQuoteIv - flatVol > 0 ? '+' : ''}${(nearestQuoteIv - flatVol).toFixed(1)} pts`, fill: 'var(--accent)', fontSize: 10, position: 'insideTopRight' }}
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="history-controls" style={{ marginTop: 14 }}>
        <h3>
          ATM term structure vs Olive flat
          {flatVol != null && <span className="muted small"> — crossings here flip the whole surface executable</span>}
        </h3>
      </div>
      <div className="chart">
        {term.length === 0 ? (
          <div className="muted small">No term data.</div>
        ) : (
          <ResponsiveContainer width="100%" height={150}>
            <LineChart data={term} margin={{ top: 6, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="days" stroke="var(--muted)" fontSize={11}
                label={{ value: 'days to expiry', position: 'insideBottom', offset: -2, fill: 'var(--muted)', fontSize: 10 }} />
              <YAxis stroke="var(--muted)" fontSize={11} domain={['auto', 'auto']} tickFormatter={(v: number) => `${v}%`} />
              <Tooltip
                contentStyle={{ background: 'var(--panel2)', border: '1px solid var(--border)', borderRadius: 8 }}
                labelFormatter={(v) => `${v} days out`}
                formatter={(value: number | string, name) => [typeof value === 'number' ? `${value}%` : value, name]}
              />
              <Line type="monotone" dataKey="atmIvPct" name="Derive ATM IV" stroke="var(--derive)" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} connectNulls />
              {flatVol != null && (
                <ReferenceLine y={flatVol} stroke="var(--olive)" strokeDasharray="6 3"
                  label={{ value: `Olive ${flatVol}%`, fill: 'var(--olive)', fontSize: 10, position: 'right' }} />
              )}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
      <div className="muted small smile-note">
        Green dots/strike bands = Derive smile above Olive's flat vol (buy Olive wing, sell Derive wing — both legs
        executable). Darker shading marks the portion inside Olive's ±1σ quotable bounds. Rows matched this expiry: {rows.length}.
      </div>
    </div>
  );
}
