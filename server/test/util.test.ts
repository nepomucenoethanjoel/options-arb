import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchWithTimeout, withDeadline } from '../src/util';

describe('withDeadline', () => {
  it('passes a prompt answer through and rejects a slow one at the deadline', async () => {
    await expect(withDeadline(Promise.resolve(7), 50, 'fast')).resolves.toBe(7);
    const t0 = Date.now();
    await expect(withDeadline(new Promise(() => {}), 50, 'okx chain BTC')).rejects.toThrow('okx chain BTC: no answer within 50 ms');
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

let server: Server | null = null;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  return new Promise((r) => server!.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`)));
}

describe('fetchWithTimeout', () => {
  it('aborts a request whose server never answers', async () => {
    const url = await listen(() => {}); // hangs forever
    const t0 = Date.now();
    await expect(fetchWithTimeout(url, {}, 200)).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(2_000);
    server!.closeAllConnections();
  });

  it('bounds the body read too, not just the headers', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200);
      res.write('{"partial":'); // never ends
    });
    const res = await fetchWithTimeout(url, {}, 200);
    await expect(res.text()).rejects.toThrow();
    server!.closeAllConnections();
  });

  it('passes normal responses through', async () => {
    const url = await listen((_req, res) => res.end('ok'));
    expect(await (await fetchWithTimeout(url)).text()).toBe('ok');
  });
});
