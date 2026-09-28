import { useMemo, useState } from 'react';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from '@tanstack/react-table';
import type { MatchRowLite, Signal } from '@options-arb/shared';
import { daysTo, expiryLabel } from '../format';

const col = createColumnHelper<MatchRowLite & { signal?: Signal }>();

export type ShowPreset = 'profitable' | 'opportunities' | 'all';

/** Classify a row for the profit-first presets. */
export function rowClass(row: { signal?: Signal }): 'profitable' | 'opportunity' | 'noise' {
  const s = row.signal;
  if (!s) return 'noise';
  if (s.isProfitable && s.netAfterCapitalUsdc != null && s.totalNetUsdc != null) return 'profitable';
  if (s.isOpportunity) return 'opportunity';
  return 'noise';
}

function DirectionBadge({ signal }: { signal?: Signal }) {
  if (!signal?.direction) return <span className="muted">–</span>;
  const exec = signal.direction === 'buy_olive_sell_derive';
  return (
    <span className={exec ? 'chip ok' : 'chip warn'} title={exec ? 'Buy on Olive AMM, sell on Derive — both legs executable' : 'Requires writing to the Olive pool (LP-only) — not executable as a user'}>
      {exec ? '2-LEG' : 'LP-ONLY'}
    </span>
  );
}

function RiskIcon({ signal }: { signal?: Signal }) {
  const flags = (signal?.flags ?? []).filter((f) => f !== 'amm_pool_depth_unknown');
  if (flags.length === 0) return <span className="muted">✓</span>;
  const bad = flags.includes('price_distortion');
  return (
    <span className={bad ? 'risk bad' : 'risk warn'} title={flags.join(' · ')}>
      {bad ? '⚠⚠' : '⚠'}
    </span>
  );
}

export function ProfitTable({
  rows,
  signalsByPair,
  preset,
  onSelect,
}: {
  rows: MatchRowLite[];
  signalsByPair: Map<string, Signal>;
  preset: ShowPreset;
  onSelect: (pairKey: string) => void;
}) {
  const [sorting, setSorting] = useState<SortingState>([{ id: 'total', desc: true }]);
  const [showHidden, setShowHidden] = useState(false);

  const data = useMemo(() => {
    const enriched = rows.map((r) => ({ ...r, signal: signalsByPair.get(r.pairKey) }));
    if (preset === 'all' || showHidden) return enriched;
    return enriched.filter((r) => (preset === 'profitable' ? rowClass(r) === 'profitable' : rowClass(r) !== 'noise'));
  }, [rows, signalsByPair, preset, showHidden]);

  const hiddenCount = useMemo(() => {
    const enriched = rows.map((r) => ({ ...r, signal: signalsByPair.get(r.pairKey) }));
    return enriched.filter((r) => rowClass(r) === 'noise').length;
  }, [rows, signalsByPair]);

  const columns = useMemo(
    () => [
      // Sort chronologically by expiry while rendering the full contract label.
      col.accessor('expiryTs', {
        header: 'Contract',
        cell: (c) => (
          <div>
            <div className="contract">
              <span className="sym">{c.row.original.underlying}</span>{' '}
              {c.row.original.strike.toLocaleString()}{' '}
              <span className={c.row.original.kind === 'call' ? 'k-c' : 'k-p'}>{c.row.original.kind === 'call' ? 'C' : 'P'}</span>
            </div>
            <div className="sub">
              {expiryLabel(c.row.original.expiryDate)} · {daysTo(c.row.original.expiryTs)}
            </div>
          </div>
        ),
      }),
      col.display({
        id: 'direction',
        header: 'Legs',
        cell: (c) => <DirectionBadge signal={c.row.original.signal} />,
      }),
      col.accessor((r) => r.signal?.ivSpreadVols ?? -Infinity, {
        id: 'spread',
        header: 'Spread',
        cell: (c) => {
          const v = c.row.original.signal?.ivSpreadVols;
          if (v == null) return <span className="muted">–</span>;
          return <span className={`mono ${v >= 0 ? 'pos' : 'neg'}`}>{v > 0 ? '+' : ''}{v.toFixed(1)}</span>;
        },
      }),
      col.accessor((r) => r.signal?.netAfterCapitalUsdc ?? -Infinity, {
        id: 'net',
        header: 'Net $/ctr',
        cell: (c) => {
          const v = c.row.original.signal?.netAfterCapitalUsdc;
          if (v == null) return <span className="muted">–</span>;
          return <span className={`mono ${v >= 0 ? 'pos' : 'neg'}`}>{v >= 0 ? '+' : ''}{v.toFixed(2)}</span>;
        },
      }),
      col.accessor((r) => r.signal?.maxExecutableSize ?? -1, {
        id: 'size',
        header: 'Size',
        cell: (c) => {
          const v = c.row.original.signal?.maxExecutableSize;
          return <span className="mono">{v != null ? v.toFixed(0) : '–'}</span>;
        },
      }),
      col.accessor((r) => r.signal?.totalNetUsdc ?? -Infinity, {
        id: 'total',
        header: 'TOTAL $',
        cell: (c) => {
          const v = c.row.original.signal?.totalNetUsdc;
          if (v == null) return <span className="muted">–</span>;
          return (
            <span className={`total ${v >= 0 ? 'pos' : 'neg'}`} title="Estimated total profit after fees, capital drag, capped at executable/pool size — held to expiry">
              {v >= 0 ? '+' : ''}{v.toFixed(0)}
            </span>
          );
        },
      }),
      col.accessor((r) => r.signal?.roiApyPct ?? -Infinity, {
        id: 'apy',
        header: 'APY',
        cell: (c) => {
          const v = c.row.original.signal?.roiApyPct;
          return <span className="mono">{v == null ? '–' : `${v > 0 ? '+' : ''}${v.toFixed(0)}%`}</span>;
        },
      }),
      col.display({
        id: 'risk',
        header: '',
        cell: (c) => <RiskIcon signal={c.row.original.signal} />,
      }),
    ],
    [],
  );

  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <div className="table-wrap">
      <table>
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => (
                <th key={h.id} onClick={h.column.getToggleSortingHandler()} className="sortable">
                  {flexRender(h.column.columnDef.header, h.getContext())}
                  {{ asc: ' ↑', desc: ' ↓' }[h.column.getIsSorted() as string] ?? ''}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => {
            const cls = rowClass(row.original);
            return (
              <tr key={row.id} className={`clickable ${cls}`} onClick={() => onSelect(row.original.pairKey)}>
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                ))}
              </tr>
            );
          })}
          {table.getRowModel().rows.length === 0 && (
            <tr>
              <td colSpan={8} className="muted" style={{ textAlign: 'center', padding: '28px' }}>
                {preset === 'profitable'
                  ? 'No profitable rows right now — every spread is negative after fees, capital drag, and pool capacity.'
                  : 'No rows for this filter.'}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {preset !== 'all' && hiddenCount > 0 && !showHidden && (
        <button className="show-hidden" onClick={() => setShowHidden(true)}>
          {hiddenCount} non-profitable rows hidden (LP-only · unprofitable · unmatched) — show
        </button>
      )}
      {showHidden && (
        <button className="show-hidden" onClick={() => setShowHidden(false)}>
          hide non-profitable rows
        </button>
      )}
    </div>
  );
}
