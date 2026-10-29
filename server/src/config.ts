import 'dotenv/config';

function str(name: string, def: string): string {
  const v = process.env[name];
  return v != null && v.trim() !== '' ? v.trim() : def;
}

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v == null || v.trim() === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v == null || v.trim() === '') return def;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function list(name: string, def: string[]): string[] {
  const v = process.env[name];
  if (v == null || v.trim() === '') return def;
  return v
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
}

/** Venues with an adapter that can be enabled via VENUES (Bybit/Binance:
 *  deferred — geo-blocked from the US host, see DATA_SOURCES row 32). */
export const EXTRA_VENUES = ['coincall', 'hypercall', 'callput', 'deribit'] as const;
export type ExtraVenue = (typeof EXTRA_VENUES)[number];

function extraVenueList(): ExtraVenue[] {
  const requested = list('VENUES', ['COINCALL', 'HYPERCALL', 'CALLPUT', 'DERIBIT']).map((v) => v.toLowerCase());
  const known = requested.filter((v): v is ExtraVenue => (EXTRA_VENUES as readonly string[]).includes(v));
  for (const v of requested) {
    if (!known.includes(v as ExtraVenue) && v !== 'derive' && v !== 'olive') console.warn(`[config] VENUES: no adapter for "${v}" — ignored`);
  }
  return known;
}

export interface AppConfig {
  port: number;
  host: string;
  underlyings: string[];
  pollIntervalMs: number;
  /** Listed venues polled alongside Derive/Olive (VENUES). */
  extraVenues: ExtraVenue[];
  coincallBaseUrl: string;
  hypercallBaseUrl: string;
  callputFeedUrl: string;
  deribitBaseUrl: string;

  deriveBaseUrl: string;
  deriveLegacyUrl: string;
  deriveBookSource: 'merge' | 'v3' | 'legacy';
  deriveMaxExpiries: number;
  deriveTakerFeeBps: number;

  oliveApiBase: string;
  oliveApiKey: string;
  oliveMode: 'auto' | 'rest' | 'onchain';
  oliveStaleMs: number;
  solanaRpcUrl: string;
  oliveTokenRateApr: number;
  oliveUsdcRateApr: number;
  /** Manual per-asset vol overrides (JSON), used when on-chain decode is unavailable. */
  oliveVolOverrides: Record<string, number>;
  /** Per-asset fixed rates (JSON {"SOL":{"token":0.1507,"usdc":0.02}}) — rates
   * are per-custody on Olive (verified via their UI 2026-09-27). */
  oliveRateOverrides: Record<string, { token: number; usdc: number }>;
  /** Per-pool AVAILABLE liquidity in USD (JSON {"SOL":4195}), read from
   * Olive's UI pool page. Caps executable size: each call locks 1 underlying,
   * each put locks K USDC of pool collateral. Missing asset = uncapped (flagged). */
  olivePoolLiquidityUsd: Record<string, number>;

  matchExpiryToleranceDays: number;
  matchMaxStrikeRelDist: number;
  oliveMaxTenorDays: number;
  /** Olive strike-band width in sigmas around spot. Docs: K_L = S·e^(−r_USDC·T
   * − n·σ√T), K_U = S·e^(r_TOKEN·T + m·σ√T), n=m=1 — and the live UI DOES
   * enforce it (verified 2026-09-29 against a UI rejection: implied exactly
   * 1.000σ from the upper bound). The 2026-09-28 "not enforced" probe
   * conclusion was wrong; do not disable. */
  oliveStrikeBoundSigmas: number;

  /** Subscribe to Olive's socket.io ticker stream (~1 s Stork spot, vs ~5 s
   * for the market file). One passive connection, like a browser tab. */
  oliveRealtimeEnabled: boolean;
  oliveRealtimeUrl: string;
  /** Re-price early when realtime spot moves ≥ this % from the last cycle's
   * print (0 = disabled). Guarded by a cooldown; Derive's rate limiter still
   * serializes the extra calls. */
  oliveRealtimeSpotTriggerPct: number;
  /** Realtime ticks older than this fall back to the market-file spot. */
  oliveRealtimeMaxSpotAgeMs: number;

  ivSpreadThresholdVols: number;
  minBookSize: number;
  maxRelBookWidth: number;
  nearExpiryDays: number;
  solanaFeeUsdc: number;
  capitalBorrowRateApr: number;

  dataDir: string;
  historyRetentionDays: number;
  alertsEnabled: boolean;
  alertWebhookUrl: string;
  alertCooldownMs: number;
  /** Only alert on the two-leg-executable direction (buy Olive / sell Derive). */
  alertsExecutableOnly: boolean;
  /** Telegram Bot API transport (preferred for phone use): both set →
   *  messages post as {chat_id, text}. Create the bot via @BotFather. */
  telegramBotToken: string;
  telegramChatId: string;
  /** Discord channel webhook (Integrations → Webhooks → Copy URL) —
   *  one credential, no bot setup. Preferred transport when set. */
  discordWebhookUrl: string;
  /** Minimum HONEST clip total (USDC — expected/marginal-fill aware, the
   *  same basis the KPI Σ uses) before an opportunity alert fires.
   *  0 = alert on any isOpportunity row (legacy behavior). */
  alertMinTotalUsdc: number;
}

export function loadConfig(): AppConfig {
  let oliveVolOverrides: Record<string, number> = {};
  const raw = process.env.OLIVE_VOL_OVERRIDES;
  if (raw && raw.trim() !== '') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'number' && Number.isFinite(v)) oliveVolOverrides[k.toUpperCase()] = v;
        }
      }
    } catch {
      // leave overrides empty; heuristic vol will be used and flagged
    }
  }

  let oliveRateOverrides: Record<string, { token: number; usdc: number }> = {};
  const rawRates = process.env.OLIVE_RATE_OVERRIDES;
  if (rawRates && rawRates.trim() !== '') {
    try {
      const parsed = JSON.parse(rawRates);
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          const r = v as { token?: unknown; usdc?: unknown };
          if (typeof r?.token === 'number' && typeof r?.usdc === 'number') {
            oliveRateOverrides[k.toUpperCase()] = { token: r.token, usdc: r.usdc };
          }
        }
      }
    } catch {
      // fall back to the global rate pair
    }
  }

  let olivePoolLiquidityUsd: Record<string, number> = {};
  const rawLiq = process.env.OLIVE_POOL_LIQUIDITY_USD;
  if (rawLiq && rawLiq.trim() !== '') {
    try {
      const parsed = JSON.parse(rawLiq);
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'number' && Number.isFinite(v) && v > 0) olivePoolLiquidityUsd[k.toUpperCase()] = v;
        }
      }
    } catch {
      // leave empty; sizes stay uncapped and flagged
    }
  }

  const bookSource = str('DERIVE_BOOK_SOURCE', 'merge');
  const oliveMode = str('OLIVE_MODE', 'auto');

  return {
    port: num('PORT', 8799),
    host: str('HOST', '127.0.0.1'),
    underlyings: list('UNDERLYINGS', ['SOL', 'BTC', 'ETH']),
    pollIntervalMs: Math.max(5000, num('POLL_INTERVAL_MS', 15000)),
    extraVenues: extraVenueList(),
    coincallBaseUrl: str('COINCALL_BASE_URL', 'https://api.coincall.com'),
    hypercallBaseUrl: str('HYPERCALL_BASE_URL', 'https://api.hypercall.xyz'),
    deribitBaseUrl: str('DERIBIT_BASE_URL', 'https://www.deribit.com/api/v2'),
    callputFeedUrl: str('CALLPUT_FEED_URL', 'https://app-data-base.s3.ap-southeast-1.amazonaws.com/market-data.json'),

    deriveBaseUrl: str('DERIVE_BASE_URL', 'https://api.derive.xyz/v3'),
    deriveLegacyUrl: str('DERIVE_LEGACY_URL', 'https://api.lyra.finance'),
    deriveBookSource: bookSource === 'v3' || bookSource === 'legacy' ? bookSource : 'merge',
    // 0 = scan every listed expiry (full-chain profit search). A cycle then
    // makes ~2 calls per expiry per asset through the rate limiter (~20-25s).
    deriveMaxExpiries: Math.max(0, Math.round(num('DERIVE_MAX_EXPIRIES', 0))),
    deriveTakerFeeBps: num('DERIVE_TAKER_FEE_BPS', 3),

    oliveApiBase: str('OLIVE_API_BASE', 'https://olive.exchange/api/v1'),
    oliveApiKey: str('OLIVE_API_KEY', 'options-arb-analytics'),
    oliveMode: oliveMode === 'rest' || oliveMode === 'onchain' ? oliveMode : 'auto',
    oliveStaleMs: num('OLIVE_STALE_MS', 60000),
    solanaRpcUrl: str('SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com'),
    oliveTokenRateApr: num('OLIVE_TOKEN_RATE_APR', 0),
    oliveUsdcRateApr: num('OLIVE_USDC_RATE_APR', 0),
    oliveVolOverrides,
    oliveRateOverrides,
    olivePoolLiquidityUsd,

    matchExpiryToleranceDays: Math.max(0, num('MATCH_EXPIRY_TOLERANCE_DAYS', 1)),
    matchMaxStrikeRelDist: num('MATCH_MAX_STRIKE_REL_DIST', 0.02),
    oliveMaxTenorDays: num('OLIVE_MAX_TENOR_DAYS', 365),
    oliveStrikeBoundSigmas: Math.max(1, num('OLIVE_STRIKE_BOUND_SIGMAS', 1)),

    oliveRealtimeEnabled: bool('OLIVE_REALTIME', true),
    oliveRealtimeUrl: str('OLIVE_REALTIME_URL', 'wss://olive.exchange/socket.io/?EIO=4&transport=websocket'),
    oliveRealtimeSpotTriggerPct: Math.max(0, num('OLIVE_REALTIME_SPOT_TRIGGER_PCT', 1)),
    oliveRealtimeMaxSpotAgeMs: Math.max(1000, num('OLIVE_REALTIME_MAX_SPOT_AGE_MS', 10000)),

    ivSpreadThresholdVols: num('IV_SPREAD_THRESHOLD_VOLS', 3),
    minBookSize: num('MIN_BOOK_SIZE', 0.1),
    maxRelBookWidth: num('MAX_REL_BOOK_WIDTH', 0.2),
    nearExpiryDays: num('NEAR_EXPIRY_DAYS', 2),
    solanaFeeUsdc: num('SOLANA_FEE_USDC', 0.05),
    capitalBorrowRateApr: num('CAPITAL_BORROW_RATE_APR', 0.08),

    dataDir: str('DATA_DIR', './data'),
    historyRetentionDays: Math.max(1, num('HISTORY_RETENTION_DAYS', 7)),
    alertsEnabled: bool('ALERTS_ENABLED', false),
    alertWebhookUrl: str('ALERT_WEBHOOK_URL', ''),
    alertCooldownMs: num('ALERT_COOLDOWN_MS', 300000),
    alertsExecutableOnly: bool('ALERTS_EXECUTABLE_ONLY', true),
    telegramBotToken: str('TELEGRAM_BOT_TOKEN', ''),
    telegramChatId: str('TELEGRAM_CHAT_ID', ''),
    discordWebhookUrl: str('DISCORD_WEBHOOK_URL', ''),
    alertMinTotalUsdc: num('ALERT_MIN_TOTAL_USDC', 0),
  };
}
