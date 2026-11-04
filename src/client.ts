/**
 * Notion API Client
 * Low-level HTTP client for Notion API
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2026-03-11';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_REQUESTS_PER_SECOND = 3;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MIN_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 10_000;

type QueryValue = string | number | boolean;

export interface NotionClientOptions {
  token: string;
  version?: string;
  maxRetries?: number;
  requestsPerSecond?: number;
  requestTimeoutMs?: number;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: Record<string, unknown>;
  query?: Record<string, QueryValue | readonly QueryValue[] | undefined>;
  version?: string;
  /** Opt in only when replaying the request cannot duplicate a mutation. GET defaults to true. */
  retrySafe?: boolean;
}

export interface NotionApiErrorOptions {
  status: number;
  code?: string;
  additionalData?: Record<string, unknown>;
  requestId?: string;
  retryAfterSeconds?: number;
}

/** A structured error returned by the Notion API. */
export class NotionApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly additionalData?: Record<string, unknown>;
  readonly requestId?: string;
  readonly retryAfterSeconds?: number;

  constructor(message: string, options: NotionApiErrorOptions) {
    super(`Notion API Error (${options.status}): ${message}`);
    this.name = 'NotionApiError';
    this.status = options.status;
    this.code = options.code;
    this.additionalData = options.additionalData;
    this.requestId = options.requestId;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** A mutation lost its connection before the server outcome was known. */
export class IndeterminateWriteError extends Error {
  readonly code = 'notion_write_outcome_unknown';
  readonly outcomeUnknown = true;
  readonly method: string;
  readonly path: string;

  constructor(method: string, requestPath: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `${method} ${requestPath} lost its connection before Notion confirmed the outcome. ` +
      `The write may have succeeded; inspect Notion before retrying. Cause: ${detail}`,
      { cause },
    );
    this.name = 'IndeterminateWriteError';
    this.method = method;
    this.path = requestPath;
  }
}

interface NotionErrorBody {
  message?: string;
  code?: string;
  additional_data?: Record<string, unknown>;
  request_id?: string;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;

  const retryAt = Date.parse(value);
  if (Number.isNaN(retryAt)) return undefined;
  return Math.max(0, (retryAt - Date.now()) / 1000);
}

async function buildApiError(response: Response): Promise<NotionApiError> {
  const parsed = await response.json().catch(() => ({}));
  const body = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as NotionErrorBody
    : {};
  const retryAfterSeconds = parseRetryAfter(response.headers?.get('Retry-After') ?? null);

  return new NotionApiError(body.message || response.statusText || 'Request failed', {
    status: response.status,
    code: body.code,
    additionalData: body.additional_data,
    requestId: body.request_id || response.headers?.get('x-request-id') || undefined,
    retryAfterSeconds,
  });
}

function backoffDelayMs(attempt: number): number {
  const exponential = Math.min(MIN_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
  // A small positive jitter avoids synchronized retry storms without retrying too early.
  return exponential + Math.random() * exponential * 0.25;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class RateLimiter {
  private timestamps: number[] = [];
  private readonly maxRequests: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(requestsPerSecond: number) {
    this.maxRequests = requestsPerSecond;
  }

  async wait(): Promise<void> {
    const reservation = this.queue.then(() => this.reserve());
    this.queue = reservation.catch(() => undefined);
    return reservation;
  }

  private async reserve(): Promise<void> {
    const now = Date.now();
    // Remove timestamps older than 1 second
    this.timestamps = this.timestamps.filter(t => now - t < 1000);

    if (this.timestamps.length >= this.maxRequests) {
      const oldestInWindow = this.timestamps[0];
      const waitMs = 1000 - (now - oldestInWindow);
      if (waitMs > 0) {
        await sleep(waitMs);
      }
    }

    const reservationTime = Date.now();
    this.timestamps = this.timestamps.filter(t => reservationTime - t < 1000);
    this.timestamps.push(reservationTime);
  }
}

export class NotionClient {
  private token: string;
  private version: string;
  private maxRetries: number;
  private rateLimiter: RateLimiter;
  private requestTimeoutMs: number;

  constructor(options: NotionClientOptions) {
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const requestsPerSecond = options.requestsPerSecond ?? DEFAULT_REQUESTS_PER_SECOND;
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new Error('maxRetries must be a non-negative integer.');
    }
    if (!Number.isInteger(requestsPerSecond) || requestsPerSecond < 1) {
      throw new Error('requestsPerSecond must be a positive integer.');
    }
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new Error('requestTimeoutMs must be a positive number.');
    }
    this.token = options.token;
    this.version = options.version || NOTION_VERSION;
    this.maxRetries = maxRetries;
    this.rateLimiter = new RateLimiter(requestsPerSecond);
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const { method = 'GET', body, query, version } = options;
    const retrySafe = options.retrySafe ?? method === 'GET';

    let url = `${NOTION_API_BASE}/${path}`;

    if (query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        const values = Array.isArray(value) ? value : [value];
        for (const item of values) params.append(key, String(item));
      }
      const queryString = params.toString();
      if (queryString) {
        url += `?${queryString}`;
      }
    }

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.token}`,
      'Notion-Version': version || this.version,
      'Content-Type': 'application/json',
    };

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this.rateLimiter.wait();

      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
      } catch (error) {
        // A network failure after a write may mean the server applied it. Retrying could
        // duplicate the mutation, so only requests explicitly safe to replay are retried.
        if (retrySafe && attempt < this.maxRetries) {
          await sleep(backoffDelayMs(attempt));
          continue;
        }
        if (!retrySafe) throw new IndeterminateWriteError(method, path, error);
        throw error;
      }

      if (response.ok) {
        try {
          return await response.json() as T;
        } catch (error) {
          if (!retrySafe) throw new IndeterminateWriteError(method, path, error);
          throw error;
        }
      }

      const apiError = await buildApiError(response);
      const retryableResponse = retrySafe
        && (response.status === 429 || response.status >= 500);

      if (attempt < this.maxRetries && retryableResponse) {
        const delayMs = apiError.retryAfterSeconds !== undefined
          ? apiError.retryAfterSeconds * 1000
          : backoffDelayMs(attempt);
        await sleep(delayMs);
        continue;
      }

      throw apiError;
    }

    throw new Error('Request failed after retries');
  }

  // Convenience methods
  get<T = unknown>(path: string, query?: RequestOptions['query']): Promise<T> {
    return this.request<T>(path, { method: 'GET', query });
  }

  post<T = unknown>(
    path: string,
    body?: RequestOptions['body'],
    query?: RequestOptions['query'],
    options?: Pick<RequestOptions, 'retrySafe'>,
  ): Promise<T> {
    return this.request<T>(path, { method: 'POST', body, query, ...options });
  }

  patch<T = unknown>(path: string, body?: RequestOptions['body']): Promise<T> {
    return this.request<T>(path, { method: 'PATCH', body });
  }

  delete<T = unknown>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'DELETE' });
  }

  /**
   * Upload a file via multipart/form-data.
   * Used exclusively by POST /v1/file_uploads/{id}/send.
   */
  async sendFile<T = unknown>(apiPath: string, fileBuffer: Buffer, filename: string, contentType?: string): Promise<T> {
    await this.rateLimiter.wait();

    const formData = new FormData();
    const blob = contentType
      ? new Blob([fileBuffer], { type: contentType })
      : new Blob([fileBuffer]);
    formData.append('file', blob, filename);

    const url = `${NOTION_API_BASE}/${apiPath}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Notion-Version': this.version,
        },
        body: formData,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      throw new IndeterminateWriteError('POST', apiPath, error);
    }

    if (!response.ok) {
      throw await buildApiError(response);
    }

    try {
      return await response.json() as T;
    } catch (error) {
      throw new IndeterminateWriteError('POST', apiPath, error);
    }
  }
}

// Singleton instance management
let clientInstance: NotionClient | null = null;

export function getClient(): NotionClient {
  if (!clientInstance) {
    throw new Error('Client not initialized. Call initClient() first.');
  }
  return clientInstance;
}

export function getTokenSync(): string {
  // Priority: env var > config file
  const envToken = process.env.NOTION_API_TOKEN || process.env.NOTION_TOKEN || process.env.NOTION_API_KEY;
  if (envToken) return envToken;

  // Hermetic callers can explicitly prevent ambient credentials from a user config.
  if (process.env.NOTION_CLI_DISABLE_CONFIG === '1') {
    throw new Error(
      'Notion API token not found. Set NOTION_API_TOKEN or create ~/.config/notion/api_key ' +
      '(legacy NOTION_TOKEN and NOTION_API_KEY variables are also supported).'
    );
  }

  // Try config file locations
  const configPaths = [
    path.join(os.homedir(), '.config', 'notion', 'api_key'),
    path.join(os.homedir(), '.notion', 'token'),
  ];

  for (const configPath of configPaths) {
    try {
      const token = fs.readFileSync(configPath, 'utf-8').trim();
      if (token) return token;
    } catch {
      continue;
    }
  }

  throw new Error(
    'Notion API token not found. Set NOTION_API_TOKEN or create ~/.config/notion/api_key ' +
    '(legacy NOTION_TOKEN and NOTION_API_KEY variables are also supported).'
  );
}

export function initClient(token?: string): NotionClient {
  const resolvedToken = token || getTokenSync();
  clientInstance = new NotionClient({ token: resolvedToken });
  return clientInstance;
}
