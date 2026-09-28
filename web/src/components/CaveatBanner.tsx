import { useState } from 'react';

/**
 * The brief requires these warnings to be visible in the UI, not just code
 * comments. Collapsible so regular use isn't drowned in text.
 */
export function CaveatBanner({ caveats }: { caveats: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="caveat-banner">
      <button className="caveat-toggle" onClick={() => setOpen((v) => !v)}>
        ⚠ Not risk-equivalent venues — read before acting on any signal {open ? '▲' : '▼'}
      </button>
      {open && (
        <ul>
          <li>
            <strong>Collateral vs margin:</strong> Olive is fully collateralized (calls backed by
            underlying, puts by USDC, locked for the full tenor); Derive is margin-based. Capital
            efficiency, yield drag, and liquidation mechanics differ — each signal carries a capital
            cost line for the lock-up.
          </li>
          <li>
            <strong>Settlement differs:</strong> Derive settles to a 30-minute TWAP of the underlying;
            Olive's keeper exercises ITM options at the Stork oracle print. Same economics on paper
            can differ by realized settlement.
          </li>
          <li>
            <strong>Market IV vs model vol:</strong> Derive's IV is order-book-implied; Olive's is
            their own EWMA realized-vol oracle (per-asset, flat across strikes — the flat "smile" is
            by construction, not a data gap).
          </li>
          <li>
            <strong>Direction:</strong> options are bought from the Olive pool; writing fresh shorts
            to it is an LP role. "Sell vol on Olive" directions are flagged{' '}
            <code>direction_limited</code>.
          </li>
          <li>
            <strong>On-chain freshness:</strong> Olive data comes from on-chain oracles/indexers and
            can lag; check the health badges.{' '}
            {caveats.length > 0 && <>Active caveats: {caveats.join(', ')}.</>}
          </li>
          <li>
            <strong>Signal tool only</strong> — this dashboard does not route or execute orders.
          </li>
        </ul>
      )}
    </div>
  );
}
