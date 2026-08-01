import { createHash } from 'node:crypto';
import { createServer, globalAgent, request, type IncomingMessage } from 'node:http';
import type { AddressInfo, LookupFunction } from 'node:net';
import { hashPinnedHttp } from '../../src/ingest/pinned-http.js';

async function consume(response: IncomingMessage): Promise<void> {
  for await (const _chunk of response) {
    // Drain the response so the global agent may retain its socket.
  }
}

describe('DNS-pinned HTTP transport', () => {
  it('uses the pinned lookup even when the global agent has a reusable socket', async () => {
    const body = Buffer.from('verified bytes');
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'image/png');
      response.end(body);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const url = new URL(`http://media.example.com:${port}/asset.png`);
    const local = { address: '127.0.0.1', family: 4 as const };
    const warmLookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, [local]);
      else callback(null, local.address, local.family);
    };

    try {
      const warmed = await new Promise<IncomingMessage>((resolve, reject) => {
        const pending = request(url, { lookup: warmLookup }, resolve);
        pending.on('error', reject);
        pending.end();
      });
      await consume(warmed);

      let pinnedLookups = 0;
      const digest = await hashPinnedHttp({
        url,
        ...local,
        timeout_ms: 1_000,
        max_bytes: 100,
        on_lookup: () => { pinnedLookups += 1; },
      });

      expect(pinnedLookups).toBe(1);
      expect(digest).toEqual({
        sha256: createHash('sha256').update(body).digest('hex'),
        byte_length: body.byteLength,
        content_type: 'image/png',
      });
    } finally {
      globalAgent.destroy();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('aborts as soon as the remaining byte budget is exceeded', async () => {
    const server = createServer((_request, response) => response.end('too many bytes'));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(hashPinnedHttp({
        url: new URL(`http://media.example.com:${port}/asset`),
        address: '127.0.0.1',
        family: 4,
        timeout_ms: 1_000,
        max_bytes: 3,
      })).rejects.toThrow('remaining byte budget');
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('destroys rejected redirect responses instead of draining their bodies', async () => {
    let writes = 0;
    let interval: NodeJS.Timeout | undefined;
    let resolveClosed: (() => void) | undefined;
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    const server = createServer((_request, response) => {
      response.writeHead(302, { location: 'https://elsewhere.example/asset' });
      interval = setInterval(() => {
        writes += 1;
        response.write(Buffer.alloc(64 * 1024));
      }, 1);
      response.once('close', () => {
        if (interval) clearInterval(interval);
        resolveClosed?.();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(hashPinnedHttp({
        url: new URL(`http://media.example.com:${port}/redirect`),
        address: '127.0.0.1',
        family: 4,
        timeout_ms: 1_000,
        max_bytes: 1,
      })).rejects.toThrow('HTTP 302');
      let closeTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          closed,
          new Promise<never>((_resolve, reject) => {
            closeTimer = setTimeout(
              () => reject(new Error('redirect response was not closed')),
              500,
            );
          }),
        ]);
      } finally {
        if (closeTimer) clearTimeout(closeTimer);
      }
      const writesAfterClose = writes;
      await new Promise<void>(resolve => setTimeout(resolve, 10));
      expect(writes).toBe(writesAfterClose);
    } finally {
      if (interval) clearInterval(interval);
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
