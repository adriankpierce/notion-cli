import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';

export interface PinnedHttpDigest {
  sha256: string;
  byte_length: number;
  content_type?: string;
}

export interface PinnedHttpOptions {
  url: URL;
  address: string;
  family: number;
  timeout_ms: number;
  max_bytes: number;
  /** Test/diagnostic hook; callers must not use it to change lookup behavior. */
  on_lookup?: () => void;
}

/** Download one URL without redirects, DNS rebinding, or shared socket pools. */
export async function hashPinnedHttp(options: PinnedHttpOptions): Promise<PinnedHttpDigest> {
  const selected = { address: options.address, family: options.family as 4 | 6 };
  const lookup: LookupFunction = (_hostname, lookupOptions, callback) => {
    options.on_lookup?.();
    if (lookupOptions.all) callback(null, [selected]);
    else callback(null, selected.address, selected.family);
  };
  const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    const request = (options.url.protocol === 'https:' ? httpsRequest : httpRequest)(
      options.url,
      {
        agent: false,
        headers: { 'accept-encoding': 'identity' },
        lookup,
        signal: AbortSignal.timeout(options.timeout_ms),
      },
      resolve,
    );
    request.on('error', reject);
    request.end();
  });
  const status = response.statusCode ?? 0;
  if (status < 200 || status >= 300) {
    response.destroy();
    throw new Error(`Readback asset fetch failed with HTTP ${status}.`);
  }
  const contentLength = Array.isArray(response.headers['content-length'])
    ? response.headers['content-length'][0]
    : response.headers['content-length'];
  if (contentLength) {
    const declaredLength = Number(contentLength);
    if (Number.isFinite(declaredLength) && declaredLength > options.max_bytes) {
      response.destroy();
      throw new Error('Readback asset exceeds its remaining byte budget.');
    }
  }
  const contentEncoding = response.headers['content-encoding'];
  if (contentEncoding && contentEncoding !== 'identity') {
    response.destroy();
    throw new Error('Readback asset returned an unsupported content encoding.');
  }
  const hash = createHash('sha256');
  let byteLength = 0;
  for await (const chunk of response) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    byteLength += bytes.byteLength;
    if (byteLength > options.max_bytes) {
      response.destroy();
      throw new Error('Readback asset exceeds its remaining byte budget.');
    }
    hash.update(bytes);
  }
  const rawContentType = response.headers['content-type'];
  const contentType = (Array.isArray(rawContentType) ? rawContentType[0] : rawContentType)
    ?.split(';', 1)[0]
    .trim()
    .toLowerCase();
  return {
    sha256: hash.digest('hex'),
    byte_length: byteLength,
    ...(contentType ? { content_type: contentType } : {}),
  };
}
