/**
 * Frontend source analysis for olive.exchange: enumerate ALL JS chunks (the
 * webpack runtime maps lazy chunk ids → filenames), fetch them, and grep for
 * the data sources behind vol / liquidity / rates / quotes: api/v1 routes,
 * socket.io event names, the realtime_v2 handshake, and Helius RPC usage.
 */
const BASE = 'https://olive.exchange';

async function getText(url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.text();
}

async function main() {
  const html = await getText(`${BASE}/`);
  // 1) every chunk referenced directly by the HTML
  const chunkSet = new Set<string>([...html.matchAll(/\/_next\/static\/chunks\/[A-Za-z0-9._-]+\.js/g)].map((m) => m[0]));
  console.log('chunks referenced by HTML:', chunkSet.size);

  // 2) the webpack runtime maps lazy chunk ids → filenames; collect those too
  const runtimeChunks = [...chunkSet].filter((c) => /\/chunks\/(\d|[a-f0-9]{4}|main|webpack|framework)[^/]*\.js$/.test(c)).slice(0, 40);
  const lazy = new Set<string>();
  for (const c of runtimeChunks) {
    try {
      const js = await getText(BASE + c);
      for (const m of js.matchAll(/"static\/chunks\/[A-Za-z0-9._-]+\.js"/g)) lazy.add('/_' + m[0].slice(1, -1));
      for (const m of js.matchAll(/"([a-zA-Z0-9._-]+\.js)"/g)) {
        // chunk maps often use bare filenames; resolve against /_next/static/chunks/
        if (/\.(js)$/.test(m[1]) && !m[1].includes('/')) lazy.add(`/_next/static/chunks/${m[1]}`);
      }
    } catch {
      // skip
    }
  }
  const all = [...new Set([...chunkSet, ...lazy])].filter((c) => c.endsWith('.js'));
  console.log('total chunk candidates (incl. lazy):', all.length);

  // 3) fetch all + grep for data sources
  const patterns: Array<[string, RegExp]> = [
    ['api/v1 route', /["'`](\/api\/v1\/[A-Za-z0-9/_${}.?=&-]+)["'`]/g],
    ['socket emit', /\.emit\(\s*["'`]([A-Za-z0-9_.:-]+)["'`]/g],
    ['socket on', /\.on\(\s*["'`]([A-Za-z0-9_.:-]+)["'`]/g],
    ['realtime', /(realtime[A-Za-z0-9_.-]*)/g],
    ['subscribe-ish', /["'`](subscribe[A-Za-z0-9_.:-]*|join[-_][A-Za-z0-9_.:-]+|watch[-_][A-Za-z0-9_.:-]+)["'`]/g],
  ];
  const found = new Map<string, Set<string>>();
  let fetched = 0;
  for (const path of all) {
    let js: string;
    try {
      js = await getText(BASE + path);
      fetched++;
    } catch {
      continue;
    }
    for (const [label, re] of patterns) {
      for (const m of js.matchAll(re)) {
        const v = m[1];
        if (!v || v.length < 3 || v.length > 60) continue;
        if (!found.has(label)) found.set(label, new Set());
        found.get(label)!.add(v);
      }
    }
  }
  console.log('chunks fetched:', fetched);
  for (const [label, vals] of found) {
    console.log(`\n${label}:`);
    for (const v of [...vals].sort()) console.log('  ' + v);
  }
}

main().catch((e) => {
  console.error('ANALYSIS FAILED:', e);
  process.exit(1);
});
