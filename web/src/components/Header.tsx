import { VENUE_ORDER, VENUE_SPECS } from '@options-arb/shared';
import type { OverviewResponse } from '../api';
import { ago, HEALTH_COLORS } from '../format';

function Badge({ label, source, status, detail }: { label: string; source: string; status: string; detail?: string | null }) {
  const color = HEALTH_COLORS[status] ?? 'var(--muted)';
  return (
    <div className="badge" title={`${source}${detail ? ` — ${detail}` : ''} (${status})`}>
      <span className="dot" style={{ background: color }} />
      <span className="badge-label">{label}</span>
      <span className="badge-sub" style={{ color }}>{status}</span>
    </div>
  );
}

function pinAge(pinnedAt: number | null | undefined): string {
  if (pinnedAt == null) return '';
  const h = (Date.now() - pinnedAt) / 3_600_000;
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${Math.round(h / 24)}d`;
}

export function Header({ data, connected }: { data: OverviewResponse; connected: boolean }) {
  const h = data.health;
  const pin = pinAge(data.config?.volPinnedAt as number | null);
  return (
    <header>
      <div className="title-block">
        <h1>Options IV Arbitrage Monitor</h1>
        <div className="subtitle">
          Cross-venue implied-volatility comparison ({Object.keys(h?.venues ?? {}).map((v) => VENUE_SPECS[v as keyof typeof VENUE_SPECS]?.label ?? v).join(' · ') || '…'}) · read-only signal tool for manual review
        </div>
      </div>
      <div className="health-block">
        {h && (
          <>
            {VENUE_ORDER.map((v) => {
              const vh = h.venues[v];
              return vh ? <Badge key={v} label={VENUE_SPECS[v].label} source={vh.source} status={vh.status} detail={vh.lastError ?? vh.detail} /> : null;
            })}
            {data.realtime && (
              <Badge
                label="Olive RT"
                source="olive:socket.io(tickerPriceSnapshot ~1s)"
                status={data.realtime.status === 'live' ? 'ok' : 'degraded'}
                detail={`${data.realtime.assets.join(', ') || 'no feeds yet'} · last frame ${
                  data.realtime.lastFrameAgeMs == null ? '—' : `${Math.round(data.realtime.lastFrameAgeMs / 1000)}s ago`
                }`}
              />
            )}
          </>
        )}
        <div className="meta">
          <span title="Live WebSocket connection to the local server">
            {connected ? '● live' : '○ polling'} · cycle {ago(data.ts)}
          </span>
          {pin && (
            <span className="pin-age" title="Olive model vols are static pins read from their UI — re-read after big moves">
              vol pin: {pin} old
            </span>
          )}
          {!pin && data.health?.venues.olive?.status === 'ok' && (
            <span className="vol-live" title="Olive vol/liquidity/spot stream live from their market-state file (~5s)">
              Olive vol: live
            </span>
          )}
        </div>
      </div>
    </header>
  );
}
