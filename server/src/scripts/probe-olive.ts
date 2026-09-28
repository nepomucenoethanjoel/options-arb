/**
 * Phase 2 verification + discovery: re-run the Olive data-source discovery
 * (REST probes + on-chain reads + Pyth spot) and print what works.
 * Append anything new to DATA_SOURCES.md §3.
 *
 *   npm run probe:olive
 */
import { loadConfig } from '../config';
import { OliveRestClient, OLIVE_PROBE_PATHS } from '../adapters/olive/rest';
import {
  OliveOnChainReader,
  OLIVE_POOLS,
  OLIVE_PROGRAM_ID,
  getPythSpot,
} from '../adapters/olive/onchain';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const rest = new OliveRestClient(cfg.oliveApiBase, cfg.oliveApiKey);
  const onchain = new OliveOnChainReader(cfg.solanaRpcUrl);

  console.log('\n=== Olive REST (header-gated, undocumented) ===\n');
  try {
    const health = await rest.health();
    console.log('/health →', JSON.stringify(health));
  } catch (e) {
    console.log('/health FAILED:', e instanceof Error ? e.message : e);
  }
  try {
    const status = await rest.status();
    const flags = (status as { activeFlags?: unknown }).activeFlags;
    console.log('/status → activeFlags:', JSON.stringify(flags));
  } catch (e) {
    console.log('/status FAILED:', e instanceof Error ? e.message : e);
  }
  try {
    const pools = await rest.pools();
    const data = Array.isArray(pools?.data) ? pools.data : [];
    console.log(`/pools → success=${pools?.success} count=${data.length}`);
    if (data[0]) console.log('  first pool keys:', Object.keys(data[0] as object).join(', '));
  } catch (e) {
    console.log('/pools FAILED:', e instanceof Error ? e.message : e);
  }
  console.log('\nprobing candidate market-data routes:');
  for (const path of OLIVE_PROBE_PATHS) {
    try {
      const res = await rest.get<unknown>(path);
      console.log(`  ${path} → 200 ${JSON.stringify(res).slice(0, 140)}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const short = msg.includes(':') ? msg.split(':').slice(1).join(':').trim() : msg;
      console.log(`  ${path} → ${short.slice(0, 80)}`);
    }
  }

  console.log('\n=== Olive on-chain (permissionless) ===\n');
  console.log(`rpc: ${cfg.solanaRpcUrl}`);
  console.log(`program: ${OLIVE_PROGRAM_ID}`);
  try {
    const exists = await onchain.programExists();
    console.log(`program executable: ${exists}`);
  } catch (e) {
    console.log('program check FAILED:', e instanceof Error ? e.message : e);
  }
  try {
    const poolAddr = OLIVE_POOLS['SOL'];
    const info = await onchain.getAccountInfo(poolAddr);
    console.log(`SOL pool ${poolAddr}: ${info ? `owner=${info.owner.toBase58().slice(0, 8)}… len=${info.data.length}` : 'NOT FOUND'}`);
  } catch (e) {
    console.log('SOL pool read FAILED:', e instanceof Error ? e.message : e);
  }
  try {
    const idl = await onchain.probeIdl();
    console.log(`IDL account ${idl.address}: ${idl.found ? `FOUND (${idl.dataLen} bytes, ${((idl.idl as { name?: string })?.name ?? 'unnamed')})` : `not found (${idl.dataLen ?? 0} bytes)`}`);
    if (idl.found) {
      const ix = (idl.idl as { instructions?: Array<{ name?: string }> }).instructions ?? [];
      console.log('  instructions:', ix.map((i) => i.name).filter(Boolean).slice(0, 20).join(', '));
    }
  } catch (e) {
    console.log('IDL probe FAILED:', e instanceof Error ? e.message : e);
  }
  try {
    const oracle = await onchain.readVolOracle('SOL');
    console.log(
      `SOL vol-oracle: ${oracle.exists ? `exists ts=${oracle.ts} (${oracle.ts ? ((Date.now() / 1000 - oracle.ts) / 3600).toFixed(1) : '?'}h ago) lastPrice=${oracle.lastPrice} tau=${oracle.tauSec}s minInt=${oracle.minIntervalSec}s fresh=${oracle.fresh}` : 'CLOSED/absent'}`,
    );
    const best = await onchain.readModelVol('SOL', cfg.oliveVolOverrides['SOL']);
    console.log(
      `model vol: ${best.vol != null ? `${(best.vol * 100).toFixed(2)}% (${'source' in best ? best.source : '?'})` : `unavailable (${'reason' in best ? best.reason : '?'})`}`,
    );
  } catch (e) {
    console.log('vol-oracle read FAILED:', e instanceof Error ? e.message : e);
  }

  console.log('\n=== Pyth spot ===\n');
  for (const sym of ['SOL', 'BTC', 'ETH']) {
    const spot = await getPythSpot(sym);
    console.log(`${sym}: ${spot ?? 'unavailable'}`);
  }

  console.log('\nPROBE-OLIVE DONE — append findings to DATA_SOURCES.md §3');
}

main().catch((err) => {
  console.error('PROBE-OLIVE FAILED:', err);
  process.exit(1);
});
