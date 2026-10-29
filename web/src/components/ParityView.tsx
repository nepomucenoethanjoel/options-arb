import { useEffect, useState } from 'react';
import type { ParitySignal } from '@options-arb/shared';
import { fetchParity } from '../api';
import { expiryLabel, fmtSize, num, usd } from '../format';
import { venueLabel } from '../venues';

/**
 * Cross-venue put-call parity hedged with the dated future at the same
 * expiry. Informational: the hedge leg is on a reference-only venue and its
 * size is not read, so these never reach the headline.
 */
export function ParityView({ underlying }: { underlying: string }) {
  const [rows, setRows] = useState<ParitySignal[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      fetchParity(underlying)
        .then((d) => live && (setRows(d.parity), setError(null)))
        .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [underlying]);

  const shown = (rows ?? []).slice(0, 60);
  return (
    <div className="parity">
      <p className="muted small">
        Conversion = buy call + sell put + sell future (locks F − K); reversal = sell call + buy put + buy future (locks K − F).
        Option legs at their best venue after per-contract fees; the future pays taker + delivery; minus collateral drag on the short option.
        The hedge is a Deribit dated future (reference only, size not read) — informational, never headline. BTC/ETH only (no liquid SOL dated future).
      </p>
      {error && <p className="muted">Could not load: {error}</p>}
      {rows && rows.length === 0 && <p className="muted">No parity rows for {underlying} (needs a dated future at the option expiry).</p>}
      {shown.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Contract</th><th>Strategy</th><th>Call</th><th className="num">Call eff.</th><th>Put</th><th className="num">Put eff.</th>
                <th className="num">Future eff.</th><th className="num">Drag</th><th className="num">Net / ctr</th><th className="num">Size</th><th className="num">Total</th><th>Flags</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.key}>
                  <td className="mono">{expiryLabel(p.expiryDate)} {num(p.strike, Number.isInteger(p.strike) ? 0 : 2)}</td>
                  <td>{p.strategy}</td>
                  <td>{p.strategy === 'conversion' ? 'buy' : 'sell'} {venueLabel(p.callVenue)}</td>
                  <td className="num mono">{usd(p.callPriceUsdc)}</td>
                  <td>{p.strategy === 'conversion' ? 'sell' : 'buy'} {venueLabel(p.putVenue)}</td>
                  <td className="num mono">{usd(p.putPriceUsdc)}</td>
                  <td className="num mono" title={p.futureId}>{usd(p.futurePriceUsdc)}</td>
                  <td className="num mono">{usd(p.capitalCostUsdc)}</td>
                  <td className={`num mono ${p.netPerUnitUsdc > 0 ? 'pos-val' : 'neg-val'}`}>{usd(p.netPerUnitUsdc)}</td>
                  <td className="num mono">{fmtSize(p.size)}</td>
                  <td className="num mono">{usd(p.totalNetUsdc)}</td>
                  <td className="small muted">{p.flags.join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows && rows.length > shown.length && <p className="muted small">Showing the best {shown.length} of {rows.length}.</p>}
    </div>
  );
}
