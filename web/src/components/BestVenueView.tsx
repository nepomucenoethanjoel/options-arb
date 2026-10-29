import { useMemo } from 'react';
import { pickBestVenues, VENUE_SPECS, type BestVenueQuote, type MatchRowLite } from '@options-arb/shared';
import { expiryLabel, fmtSize, num, pct, usd } from '../format';
import { venueLabel } from '../venues';

const CAVEATS: Record<string, string> = {
  reference_venue: 'ref only',
  indicative_quote: 'indicative',
  single_maker: '1 maker',
  execution_fee_unknown: 'fee?',
};

function Side({ q }: { q: BestVenueQuote | null }) {
  if (!q) return <td colSpan={4} className="muted">–</td>;
  const amm = VENUE_SPECS[q.venue].quoteKind === 'amm_synthetic';
  const tags = [amm ? 'AMM' : null, ...q.flags.map((f) => CAVEATS[f] ?? null)].filter(Boolean);
  return (
    <>
      <td>
        <span className="venue-dot" style={{ background: `var(--${q.venue})` }} /> {venueLabel(q.venue)}
        {tags.length > 0 && <span className="tag"> {tags.join(' · ')}</span>}
      </td>
      <td className="num mono" title={`quoted ${usd(q.price)}`}>{usd(q.effectivePrice)}</td>
      <td className="num mono">{pct(q.iv)}</td>
      <td className="num mono">{q.size != null ? fmtSize(q.size) : '–'}</td>
    </>
  );
}

/**
 * Where to buy and where to sell each contract, after per-contract fees.
 * Useful whether or not a cross-venue arb exists: it is the cheapest place
 * to put on a trade you already want.
 */
export function BestVenueView({ rows }: { rows: MatchRowLite[] }) {
  const lines = useMemo(
    () =>
      rows
        .map((r) => ({ r, ...pickBestVenues(r.venues) }))
        .filter((l) => l.bestBuy || l.bestSell)
        .sort((a, b) => a.r.expiryTs - b.r.expiryTs || a.r.strike - b.r.strike || a.r.kind.localeCompare(b.r.kind)),
    [rows],
  );
  return (
    <div className="best-venue">
      <p className="muted small">
        Price per contract after each venue&apos;s per-contract fees (ask + fee to buy, bid − fee to sell; per-order fees excluded).
        Sell side only lists venues where users can short. &quot;ref only&quot; = a venue you cannot trade; &quot;indicative&quot; /
        &quot;1 maker&quot; = fills not yet proven. Hover a price for the raw quote.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Contract</th>
              <th>Buy at</th><th className="num">Eff. ask</th><th className="num">IV</th><th className="num">Size</th>
              <th>Sell at</th><th className="num">Eff. bid</th><th className="num">IV</th><th className="num">Size</th>
              <th className="num" title="Effective bid − effective ask: > 0 means the two best venues cross after fees (before collateral drag and per-order fees)">Cross</th>
            </tr>
          </thead>
          <tbody>
            {lines.map(({ r, bestBuy, bestSell }) => {
              const cross = bestBuy && bestSell ? bestSell.effectivePrice - bestBuy.effectivePrice : null;
              return (
                <tr key={r.pairKey}>
                  <td className="mono">{expiryLabel(r.expiryDate)} {num(r.strike, Number.isInteger(r.strike) ? 0 : 2)} {r.kind === 'call' ? 'C' : 'P'}</td>
                  <Side q={bestBuy} />
                  <Side q={bestSell} />
                  <td className={`num mono ${cross != null && cross > 0 ? 'pos-val' : 'muted'}`}>{cross != null ? usd(cross) : '–'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {lines.length === 0 && <p className="muted">No tradable quotes for this selection.</p>}
    </div>
  );
}
