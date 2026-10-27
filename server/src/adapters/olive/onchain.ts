import { Connection, PublicKey, type AccountInfo } from '@solana/web3.js';
import { oliveStrikeBounds } from '@options-arb/shared';
import { fetchWithTimeout } from '../../util';

export { oliveStrikeBounds };

/**
 * Permissionless on-chain reads for Olive (fallback data path).
 *
 * No IDL is published, so the volatility-oracle account layout was reverse-
 * engineered from live mainnet accounts (DATA_SOURCES.md §2c):
 *
 *   0x00  8   Anchor discriminator
 *   0x08  32  pubkey (price account)
 *   0x28  32  pubkey (authority)
 *   0x48  32  opaque/hash-like state
 *   0x68  u64 tau window, seconds (observed 1,296,000 = 15d — matches docs)
 *   0x70  u64 min refresh interval, seconds (observed 900 — matches docs)
 *   0x78  u64 last update unix seconds
 *   0x80  u64 last oracle price × 1e6
 *   0x88  u64 variance floor/seed × 1e8 (observed 100,000 → 0.001)
 *   0x90  u8  flags
 *
 * As of 2026-09-27 the volatility keeper is inactive since the 2026-09-19
 * redeploy (all oracle timestamps are 11–209 h old; SOL's underlying oracle is
 * closed). We therefore expose lastPrice + timestamp, treat model vol as
 * unavailable unless the account is fresh or an override is configured, and
 * flag the state explicitly.
 */

export const OLIVE_PROGRAM_ID = 'ELfKgKXLdcnLaq3oHzJJHRCKUat9q2tJsxvr3NMbELbB';

export const OLIVE_POOLS: Record<string, string> = {
  SOL: '8K1JCw3bb1WKh6wcw8ehZW8UUPJti6quqNuDa7gMQRFZ',
  BTC: 'Cu5SM3wBGbzgEcYt4PqiQPC8NgsowL6eegWx7KaV91wH',
  ETH: '6NsPFDcRzih2CuJyDTLmD3DcLgxrMt2sCJQJGmWzb4yJ',
  PAXG: 'DiTdbnG5wQxVdw38zXt46Kf6hbqQ3dFHtENy51e67nkN',
  JUP: '5UoG1xiy8Kh1PqncYm9qfTmGLVaFK9c8oGdEmXN1zsTD',
  NVDAX: 'C5pLamu5reyo3fAeycTEPBXaorGK8TaESYzYhQPGSkeL',
  ZEC: '2EKB39dNctokhTeE7XLLeJcTCWhs71qZ4FKXufSpEiJL',
};

/** Underlying-custody volatility-oracle accounts (deployment manifest 2026-09-19). */
export const OLIVE_VOL_ORACLES: Record<string, string> = {
  SOL: '94Qdd6omWrybikFNvuREMTxFLaGL8L6MLzDukQJbBYjg',
  BTC: '7S4AU2vvBTSfXmaHdky1FpepPJttPp8FLZtPbsoLXkBG',
  ETH: '43ydXzwdaWmiAAPWAbQA2iAKjpPxqFXkw34Yxsw8YWZD',
  PAXG: 'GrepgKevNmJqCvW2qPqHDqjsP92NCQakVsjA7nSTUm98',
  JUP: 'GCuGWHCP2KeAgpdbc5sGPECPDLQ3RjEZF1xpwZxVEVwW',
  NVDAX: '7y1E7tDYJNrEPrsrLvnatppJsYDQLM4cKMDs8GrnDJBd',
  ZEC: 'CXr4JBnZdMLqSkqycRMPMo6Pu2CDvLuem6PHETp3w6J6',
};

/** Oracle reads older than this are treated as keeper-inactive. */
export const VOL_ORACLE_MAX_AGE_SEC = 6 * 3600;

export interface VolOracleState {
  exists: boolean;
  /** Last keeper/oracle update, unix seconds. */
  ts: number | null;
  /** Last oracle price for the asset (6-dp fixed point). */
  lastPrice: number | null;
  tauSec: number | null;
  minIntervalSec: number | null;
  /** Raw floor/seed variance word × 1e8 (not live vol). */
  seedVarRaw: number | null;
  fresh: boolean;
}

export interface IdlProbeResult {
  found: boolean;
  address: string;
  idl?: unknown;
  dataLen?: number;
}

export class OliveOnChainReader {
  private readonly conn: Connection;
  private idlProbed: IdlProbeResult | null = null;

  constructor(rpcUrl: string) {
    this.conn = new Connection(rpcUrl, {
      commitment: 'confirmed',
      fetch: (input, init) => fetchWithTimeout(input as string, init as RequestInit),
    });
  }

  async getAccountInfo(address: string): Promise<AccountInfo<Buffer> | null> {
    return this.conn.getAccountInfo(new PublicKey(address));
  }

  async programExists(): Promise<boolean> {
    const info = await this.getAccountInfo(OLIVE_PROGRAM_ID);
    return info != null && info.executable;
  }

  /**
   * Anchor stores the IDL at PDA(["anchor:idl", programId], programId) with
   * layout: 8-byte discriminator + 32-byte authority + borsh Vec<u8> of the
   * IDL JSON (4-byte LE length + bytes). Verified absent for Olive today.
   */
  async probeIdl(): Promise<IdlProbeResult> {
    if (this.idlProbed) return this.idlProbed;
    const programId = new PublicKey(OLIVE_PROGRAM_ID);
    const [idlAddress] = PublicKey.findProgramAddressSync(
      [Buffer.from('anchor:idl'), programId.toBuffer()],
      programId,
    );
    const result: IdlProbeResult = { found: false, address: idlAddress.toBase58() };
    try {
      const info = await this.getAccountInfo(idlAddress.toBase58());
      if (info != null && info.data.length > 44) {
        result.dataLen = info.data.length;
        const len = info.data.readUInt32LE(8 + 32);
        if (len > 0 && 8 + 32 + 4 + len <= info.data.length) {
          const jsonBytes = info.data.subarray(8 + 32 + 4, 8 + 32 + 4 + len);
          result.idl = JSON.parse(jsonBytes.toString('utf8'));
          result.found = true;
        }
      }
    } catch {
      // leave found=false
    }
    this.idlProbed = result;
    return result;
  }

  /** Decode the underlying custody's volatility-oracle account. */
  async readVolOracle(underlying: string): Promise<VolOracleState> {
    const empty: VolOracleState = {
      exists: false, ts: null, lastPrice: null, tauSec: null, minIntervalSec: null, seedVarRaw: null, fresh: false,
    };
    const address = OLIVE_VOL_ORACLES[underlying.toUpperCase()];
    if (!address) return empty;
    const info = await this.getAccountInfo(address);
    if (info == null || info.data.length < 144) return empty;
    const b = info.data;
    const safe = (off: number): number | null => {
      try {
        const v = Number(b.readBigUInt64LE(off));
        return Number.isFinite(v) && v > 0 ? v : null;
      } catch {
        return null;
      }
    };
    const ts = safe(120);
    return {
      exists: true,
      ts,
      lastPrice: safe(128) != null ? safe(128)! / 1e6 : null,
      tauSec: safe(104),
      minIntervalSec: safe(112),
      seedVarRaw: safe(136),
      fresh: ts != null && Date.now() / 1000 - ts < VOL_ORACLE_MAX_AGE_SEC,
    };
  }

  /**
   * Model vol: explicit override only for now — the on-chain variance is not
   * maintained while the keeper is inactive (see module doc). The `fresh`
   * oracle state is returned so callers can flag appropriately.
   */
  async readModelVol(
    underlying: string,
    override?: number,
  ): Promise<
    | { vol: number; source: 'override'; oracle: VolOracleState }
    | { vol: null; reason: 'keeper_inactive' | 'no_account' | 'no_override'; oracle: VolOracleState }
  > {
    const oracle = await this.readVolOracle(underlying);
    if (typeof override === 'number' && override > 0 && override < 10) {
      return { vol: override, source: 'override', oracle };
    }
    if (!oracle.exists) return { vol: null, reason: 'no_account', oracle };
    if (!oracle.fresh) return { vol: null, reason: 'keeper_inactive', oracle };
    // Fresh oracle but layout's live-variance word is unverified — still
    // require an override; revisit when the keeper runs.
    return { vol: null, reason: 'no_override', oracle };
  }
}

/** Canonical Pyth mainnet feed IDs (public constants; lookup API is flaky here). */
const PYTH_FEED_IDS: Record<string, string> = {
  SOL: '0xef0d8b6fda2cecc473066a8db5f54548ddadacfcce5222504b2ed18aa2f5bbb1',
  BTC: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  ETH: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
};

const HERMES_BASES = ['https://hermes.pyth.network', 'https://pyth.dourolabs.app'];

/** Live spot via Pyth Hermes (best-effort; several bases). */
export async function getPythSpot(symbol: string): Promise<number | null> {
  const feedId = PYTH_FEED_IDS[symbol.toUpperCase()];
  if (!feedId) return null;
  for (const base of HERMES_BASES) {
    try {
      const res = await fetchWithTimeout(`${base}/v2/updates/price/latest?ids[]=${feedId}`);
      if (!res.ok) continue;
      const json = (await res.json()) as {
        parsed?: Array<{ price?: { price?: string | number; expo?: number } }>;
      };
      const p = json.parsed?.[0]?.price;
      if (!p || typeof p.price === 'undefined' || typeof p.expo === 'undefined') continue;
      const spot = Number(p.price) * Math.pow(10, p.expo);
      if (Number.isFinite(spot) && spot > 0) return spot;
    } catch {
      // try next base
    }
  }
  return null;
}
