/**
 * Olive Exchange backend REST client.
 *
 * Undocumented (see DATA_SOURCES.md §2a): requires X-API-Key (any non-empty
 * value) + X-Request-ID headers, else 400 "Missing required security headers".
 * Known routes: /health, /status, /pools. Keep request rates polite (≤1 rps).
 */
import { fetchWithTimeout } from '../../util';

export class OliveRestClient {
  constructor(
    private readonly base: string,
    private readonly apiKey: string,
  ) {}

  private async request<T>(path: string): Promise<T> {
    const res = await fetchWithTimeout(`${this.base}${path}`, {
      headers: {
        'X-API-Key': this.apiKey,
        'X-Request-ID': crypto.randomUUID(),
        Accept: 'application/json',
      },
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Olive REST ${path}: non-JSON response (${res.status})`);
    }
    if (!res.ok) {
      const message =
        (json as { message?: string } | null)?.message ?? text.slice(0, 200);
      throw new Error(`Olive REST ${path}: ${res.status} ${message}`);
    }
    return json as T;
  }

  health(): Promise<{ status?: string; version?: string; runtimeRole?: string }> {
    return this.request('/health');
  }

  status(): Promise<Record<string, unknown>> {
    return this.request('/status');
  }

  pools(): Promise<{ success?: boolean; data?: unknown[] }> {
    return this.request('/pools');
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>(path);
  }
}

/** Candidate market-data routes to probe during discovery (probe-olive.ts). */
export const OLIVE_PROBE_PATHS = [
  '/markets',
  '/options',
  '/options/chain',
  '/chain',
  '/instruments',
  '/quotes',
  '/tickers',
  '/option-chain',
  '/pricing',
  '/volatility',
];
