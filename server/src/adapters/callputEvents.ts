/**
 * Callput PositionManager (Base) event decoding — read-only evidence tooling
 * (DATA_SOURCES rows 85, 87). Layouts were read from live receipts, checked
 * against the owner's own 2026-09-27 requests (test/fixtures/callput-pm-logs.json):
 *
 *  - optionTokenId (docs developers/option-token-id-and-state-machine):
 *    [255:240] underlyingAssetIndex · [239:200] expiry (s) · [199:196] strategy ·
 *    [195:194] legs − 1 · then 48-bit legs from bit 193 down: isBuy (1) ·
 *    strike (46) · isCall (1) · [1:0] vaultIndex.
 *  - Option-token sizes: BTC 8 decimals (WBTC), every other underlying 18 —
 *    observed (a BTC fill of 0.01045202 = 1045202), not documented.
 *  - USDC amounts: 6 decimals.
 */

export const CALLPUT_POSITION_MANAGER = '0x83B04701B227B045CBBAF921377137fF595a54af';

export const CALLPUT_TOPICS = {
  requestKey: '0xd829e644',
  openRequest: '0xf75a855b',
  openExecuted: '0x3622edc8',
  openCancelled: '0x91a06f66',
  closeRequest: '0x88ea9077',
  closeExecuted: '0xe00e5d5c',
} as const;

export interface CallputLeg {
  isBuy: boolean;
  strike: number;
  isCall: boolean;
}

export interface CallputTokenId {
  underlyingIndex: number;
  expiryTs: number;
  strategy: number;
  legs: CallputLeg[];
  vaultIndex: number;
}

export function decodeCallputTokenId(word: string): CallputTokenId {
  const x = BigInt(word.startsWith('0x') ? word : `0x${word}`);
  const legCount = Number((x >> 194n) & 3n) + 1;
  const legs: CallputLeg[] = [];
  for (let i = 0; i < legCount; i++) {
    const leg = (x >> (194n - 48n * BigInt(i + 1))) & ((1n << 48n) - 1n);
    legs.push({ isBuy: (leg >> 47n) === 1n, strike: Number((leg >> 1n) & ((1n << 46n) - 1n)), isCall: (leg & 1n) === 1n });
  }
  return {
    underlyingIndex: Number(x >> 240n),
    expiryTs: Number((x >> 200n) & ((1n << 40n) - 1n)) * 1000,
    strategy: Number((x >> 196n) & 15n),
    legs,
    vaultIndex: Number(x & 3n),
  };
}

/** One-line label, e.g. `buy 85000C / sell 85500C`. */
export function describeLegs(legs: CallputLeg[]): string {
  return legs.map((l) => `${l.isBuy ? 'buy' : 'sell'} ${l.strike}${l.isCall ? 'C' : 'P'}`).join(' / ');
}

export function sizeDecimals(underlying: string | undefined): number {
  return underlying === 'BTC' ? 8 : 18;
}

export interface RawLog {
  blockNumber: string;
  /** Seconds; hex string when an RPC includes it on logs. */
  blockTimestamp?: number | string;
  transactionHash: string;
  topics: string[];
  data: string;
}

export type CallputEvent =
  | { type: 'requestKey'; account: string; key: string; isOpen: boolean }
  | { type: 'openRequest'; account: string; token: CallputTokenId; minSizeRaw: bigint; amountInRaw: bigint }
  | { type: 'openExecuted'; account: string; token: CallputTokenId; sizeRaw: bigint; amountInRaw: bigint }
  | { type: 'openCancelled'; account: string; token: CallputTokenId; amountInRaw: bigint }
  | { type: 'closeRequest'; account: string; token: CallputTokenId; sizeRaw: bigint }
  | { type: 'closeExecuted'; account: string; token: CallputTokenId; sizeRaw: bigint; amountOutRaw: bigint };

const words = (data: string): string[] => {
  const out: string[] = [];
  for (let i = 2; i + 64 <= data.length; i += 64) out.push(data.slice(i, i + 64));
  return out;
};
const addr = (topic: string | undefined) => `0x${(topic ?? '').slice(26)}`.toLowerCase();
const big = (w: string | undefined) => (w ? BigInt(`0x${w}`) : 0n);

/** Null for event types this tooling does not read. */
export function decodeCallputLog(log: RawLog): CallputEvent | null {
  const t0 = log.topics[0]?.slice(0, 10).toLowerCase();
  const w = words(log.data);
  const account = addr(log.topics[1]);
  switch (t0) {
    case CALLPUT_TOPICS.requestKey:
      return { type: 'requestKey', account, key: log.topics[2] ?? '', isOpen: big(log.topics[3]?.slice(2)) === 1n };
    case CALLPUT_TOPICS.openRequest:
      return { type: 'openRequest', account, token: decodeCallputTokenId(w[4]!), minSizeRaw: big(w[5]), amountInRaw: big(w[7]) };
    case CALLPUT_TOPICS.openExecuted:
      return { type: 'openExecuted', account, token: decodeCallputTokenId(w[0]!), sizeRaw: big(w[1]), amountInRaw: big(w[3]) };
    case CALLPUT_TOPICS.openCancelled:
      return { type: 'openCancelled', account, token: decodeCallputTokenId(w[4]!), amountInRaw: big(w[6]) };
    case CALLPUT_TOPICS.closeRequest:
      return { type: 'closeRequest', account, token: decodeCallputTokenId(w[0]!), sizeRaw: big(w[1]) };
    case CALLPUT_TOPICS.closeExecuted:
      return { type: 'closeExecuted', account, token: decodeCallputTokenId(w[0]!), sizeRaw: big(w[1]), amountOutRaw: big(w[3]) };
    default:
      return null;
  }
}

export const toUnits = (raw: bigint, decimals: number): number => Number(raw) / 10 ** decimals;

const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad32 = (a: string) => `0x${a.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;

/**
 * A credit spread from its strikes: calls sold below the bought strike (bear
 * call), puts sold above it (bull put). Matches every credit open in two weeks
 * of fills (row 88); a debit spread's open never pays the account.
 */
export function isCreditSpread(legs: CallputLeg[]): boolean {
  const sold = legs.find((l) => !l.isBuy);
  const bought = legs.find((l) => l.isBuy);
  if (!sold || !bought || legs.length !== 2) return false;
  return sold.isCall ? sold.strike < bought.strike : sold.strike > bought.strike;
}

/**
 * The credit a sell-spread open paid `account`, raw 6-decimal USDC: USDC the
 * PositionManager sent it in the transaction, minus any close it executed for
 * the same account in that transaction (one transaction can close one spread
 * and open another — 2026-11-15 0xfbd5…).
 */
export function creditRawIn(logs: Array<{ address: string; topics: string[]; data: string }>, account: string): bigint {
  let raw = 0n;
  for (const l of logs) {
    if (l.address.toLowerCase() === USDC_BASE && l.topics[0] === TRANSFER_TOPIC) {
      if (l.topics[1]?.toLowerCase() === pad32(CALLPUT_POSITION_MANAGER) && l.topics[2]?.toLowerCase() === pad32(account)) raw += BigInt(l.data);
    } else if (l.address.toLowerCase() === CALLPUT_POSITION_MANAGER.toLowerCase()) {
      const e = decodeCallputLog({ blockNumber: '0x0', transactionHash: '', topics: l.topics, data: l.data });
      if (e?.type === 'closeExecuted' && e.account === account.toLowerCase()) raw -= e.amountOutRaw;
    }
  }
  return raw > 0n ? raw : 0n;
}
