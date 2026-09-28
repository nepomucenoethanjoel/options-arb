/** Fraction (0.55) → "55.0%". */
export function pct(v: number | null | undefined, dp = 1): string {
  return v == null ? '–' : `${(v * 100).toFixed(dp)}%`;
}

export function num(v: number | null | undefined, dp = 2): string {
  return v == null ? '–' : v.toFixed(dp);
}

export function usd(v: number | null | undefined, dp = 2): string {
  return v == null ? '–' : `$${v.toFixed(dp)}`;
}

/** Contract count: whole units stay whole, fractional caps (e.g. custody
 * limits like 0.49 ZEC) keep a decimal instead of rounding to "0". */
export function fmtSize(v: number | null | undefined): string {
  if (v == null) return '–';
  return v >= 10 ? v.toFixed(0) : v.toFixed(1);
}

export function expiryLabel(expiryDate: string): string {
  return `${expiryDate.slice(0, 4)}-${expiryDate.slice(4, 6)}-${expiryDate.slice(6, 8)}`;
}

export function ago(ts: number | null | undefined): string {
  if (ts == null) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export function daysTo(ts: number): string {
  const d = (ts - Date.now()) / 86_400_000;
  if (d < 0) return 'expired';
  if (d < 1) return `${Math.round(d * 24)}h`;
  return `${d.toFixed(1)}d`;
}

export function pairLabel(pairKey: string): string {
  const [u, date, strike, kind] = pairKey.split('-');
  return `${u} ${expiryLabel(date)} ${Number(strike).toLocaleString()} ${kind === 'C' ? 'Call' : 'Put'}`;
}

export const HEALTH_COLORS: Record<string, string> = {
  ok: 'var(--ok)',
  stale: 'var(--warn)',
  degraded: 'var(--warn)',
  error: 'var(--bad)',
  unknown: 'var(--muted)',
};
