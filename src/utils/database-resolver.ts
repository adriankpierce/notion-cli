/**
 * Database Resolver — routes database operations to /v1/data_sources/
 *
 * Database containers can hold one or more data sources. Data-source objects
 * own row schemas and are the target of query/schema operations, so this
 * module resolves either kind of ID to the appropriate /v1/data_sources/
 * endpoint.
 *
 * Design: This module is the ONLY place that knows about endpoint routing.
 * Command files call getDatabaseSchema(), queryDatabase(), etc. and never
 * construct database/data_source paths themselves.
 */

import type { NotionClient } from '../client.js';
import type { Database, PaginatedResponse, Page } from '../types/notion.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ResolvedDatabase {
  type: 'data_source';
  databaseId: string;
  dataSourceId: string;
  schemaPath: string;
  queryPath: string;
  schema: Database;
}

export interface ResolverOptions {
  dataSourceId?: string;
}

export interface QueryAllOptions extends ResolverOptions {
  filter?: Record<string, unknown>;
  sorts?: Record<string, unknown>[];
  filterProperties?: string[];
  pageSize?: number;
  limit?: number;
  onProgress?: (fetched: number) => void;
  onPage?: (page: Page) => void | Promise<void>;
  collect?: boolean;
}

export interface QueryOptions extends ResolverOptions {
  filterProperties?: string[];
}

export class IncompleteQueryError extends Error {
  readonly code = 'notion_query_incomplete';

  constructor(dataSourceId: string) {
    super(
      `Notion stopped query ${dataSourceId} at its 10,000-result safety limit. ` +
      'The result is incomplete; narrow the filter (for example with a created_time window) and retry.',
    );
    this.name = 'IncompleteQueryError';
  }
}

// ─── Global data-source-id fallback ─────────────────────────────────────────

let globalDataSourceId: string | undefined;

/**
 * Set the global data-source-id fallback from CLI's --data-source-id option.
 * Called once from cli.ts preAction hook. Commands don't need to thread
 * this option — the resolver picks it up automatically.
 */
export function setGlobalDataSourceId(id?: string): void {
  globalDataSourceId = id;
}

function effectiveDataSourceId(explicit?: string): string | undefined {
  return explicit ?? globalDataSourceId;
}

// ─── Cache ──────────────────────────────────────────────────────────────────

const cache = new Map<string, Promise<ResolvedDatabase>>();

function cacheKey(databaseId: string, dataSourceId?: string): string {
  return dataSourceId ? `${databaseId}::${dataSourceId}` : databaseId;
}

export function clearResolverCache(): void {
  cache.clear();
}

// ─── Core resolution ────────────────────────────────────────────────────────

function buildPaths(dataSourceId: string) {
  return {
    schemaPath: `data_sources/${dataSourceId}`,
    queryPath: `data_sources/${dataSourceId}/query`,
  };
}

/** Normalize a Notion URL, dashed UUID, or compact UUID for API requests. */
export function normalizeNotionId(input: string): string {
  const value = input.trim();
  let candidate = value;

  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`Invalid Notion URL: ${input}`);
    }
    const hostname = url.hostname.toLowerCase();
    const isNotionHost = hostname === 'notion.so'
      || hostname === 'notion.site'
      || hostname === 'notion.com'
      || hostname.endsWith('.notion.so')
      || hostname.endsWith('.notion.site')
      || hostname.endsWith('.notion.com');
    if (!isNotionHost) {
      throw new Error(`Expected a Notion URL, received ${url.hostname}.`);
    }
    candidate = decodeURIComponent(url.pathname).replace(/\/$/, '').split('/').pop() ?? '';
  }

  const match = candidate.match(/([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (!match) {
    if (/^https?:\/\//i.test(value)) {
      throw new Error(`Could not find a Notion ID in URL: ${input}`);
    }
    return value;
  }

  const compact = match[1].replace(/-/g, '').toLowerCase();
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ].join('-');
}

/**
 * Discover and resolve a database/data_source ID in one step.
 *
 * Workspace search returns data-source IDs, while Notion URLs and callers may
 * still provide a database-container ID. We try GET /data_sources/{id} first;
 * a 404 alone triggers GET /databases/{id} to discover the contained sources.
 *
 * Returns a fully resolved database — avoids a redundant second fetch.
 */
async function discoverAndResolve(
  client: NotionClient,
  databaseId: string,
): Promise<ResolvedDatabase> {
  // Search and other data-source APIs commonly return this form directly.
  try {
    const ds = await client.get<Record<string, unknown>>(`data_sources/${databaseId}`);
    if (ds.object === 'data_source') {
      return {
        type: 'data_source',
        databaseId,
        dataSourceId: databaseId,
        ...buildPaths(databaseId),
        schema: normalizeToDatabase(ds, databaseId),
      };
    }
  } catch (error) {
    // Only a genuine not-found response means the ID may be a database
    // container. Authentication, rate-limit, network, and server errors must
    // retain their original meaning instead of being masked by a second call.
    if (!isNotFoundError(error)) throw error;
  }

  // A database container exposes its available data sources.
  const db = await client.get<{ data_sources?: { id: string; name: string }[] }>(
    `databases/${databaseId}`,
  );

  const sources = db.data_sources;
  if (!sources || sources.length === 0) {
    throw new Error(
      `Database ${databaseId} has no data sources. Use --data-source-id to specify one.`,
    );
  }

  if (sources.length > 1) {
    const list = sources.map(s => `  - ${s.id} (${s.name})`).join('\n');
    throw new Error(
      `Database ${databaseId} has ${sources.length} data sources:\n${list}\n` +
      `Use --data-source-id <id> to specify which one.`,
    );
  }

  return fetchDataSource(client, databaseId, sources[0].id);
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { status?: number; message?: string };
  return candidate.status === 404 || /Notion API Error \(404\)/.test(candidate.message ?? '');
}

/**
 * Fetch the data_source schema and build a ResolvedDatabase.
 */
async function fetchDataSource(
  client: NotionClient,
  databaseId: string,
  dataSourceId: string,
  validateParent = false,
): Promise<ResolvedDatabase> {
  const ds = await client.get<Record<string, unknown>>(
    `data_sources/${dataSourceId}`,
  );
  if (validateParent && databaseId !== dataSourceId) {
    const parent = ds.parent as { type?: string; database_id?: string } | undefined;
    if (parent?.type !== 'database_id' || !parent.database_id) {
      throw new Error(
        `Cannot verify that data source ${dataSourceId} belongs to database ${databaseId}.`,
      );
    }
    const actualDatabaseId = normalizeNotionId(parent.database_id);
    if (actualDatabaseId !== databaseId) {
      throw new Error(
        `Data source ${dataSourceId} belongs to database ${actualDatabaseId}, not ${databaseId}.`,
      );
    }
  }
  return {
    type: 'data_source',
    databaseId,
    dataSourceId,
    ...buildPaths(dataSourceId),
    schema: normalizeToDatabase(ds, dataSourceId),
  };
}

/**
 * Resolve a database ID to the correct API endpoints.
 *
 * Resolution strategy:
 * 1. If explicit dataSourceId is provided, fetch it and verify its parent
 * 2. Otherwise, GET /databases/{id} to discover data_sources, then fetch schema
 * 3. Cache the result for the lifetime of the process
 */
export function resolveDatabase(
  client: NotionClient,
  databaseId: string,
  dataSourceId?: string,
): Promise<ResolvedDatabase> {
  const selectedDataSourceId = dataSourceId ?? globalDataSourceId;
  const normalizedDatabaseId = normalizeNotionId(databaseId);
  const normalizedDataSourceId = selectedDataSourceId
    ? normalizeNotionId(selectedDataSourceId)
    : undefined;
  const key = cacheKey(normalizedDatabaseId, normalizedDataSourceId);

  if (!cache.has(key)) {
    const promise = normalizedDataSourceId
      ? fetchDataSource(client, normalizedDatabaseId, normalizedDataSourceId, true)
      : discoverAndResolve(client, normalizedDatabaseId);

    cache.set(key, promise);

    // Remove from cache on failure so retries work
    promise.catch(() => cache.delete(key));
  }

  return cache.get(key)!;
}

// ─── High-level helpers ─────────────────────────────────────────────────────

/**
 * Get the schema (properties, title, etc.) for a database.
 * Discovers the data_source automatically.
 */
export async function getDatabaseSchema(
  client: NotionClient,
  databaseId: string,
  opts?: ResolverOptions,
): Promise<Database> {
  const resolved = await resolveDatabase(client, databaseId, effectiveDataSourceId(opts?.dataSourceId));
  return resolved.schema;
}

/**
 * Query a database. Resolves endpoint automatically.
 */
export async function queryDatabase<T = unknown>(
  client: NotionClient,
  databaseId: string,
  body: Record<string, unknown> = {},
  opts?: QueryOptions,
): Promise<T> {
  const resolved = await resolveDatabase(client, databaseId, effectiveDataSourceId(opts?.dataSourceId));
  return queryDatabaseDirect<T>(client, resolved, body, opts);
}

/**
 * Query using an already-resolved database (avoids re-resolution).
 * Useful in loops/pagination where resolution already happened.
 */
export async function queryDatabaseDirect<T = unknown>(
  client: NotionClient,
  resolved: ResolvedDatabase,
  body: Record<string, unknown> = {},
  opts?: Pick<QueryOptions, 'filterProperties'>,
): Promise<T> {
  const filterProperties = opts?.filterProperties?.filter(Boolean).map((propertyId) => {
    try {
      // Property IDs in API responses are already URL-encoded. Decode them
      // before URLSearchParams performs the one required encoding pass.
      return decodeURIComponent(propertyId);
    } catch {
      throw new Error(`Invalid encoded property ID: ${propertyId}`);
    }
  });
  const result = filterProperties?.length
    ? await client.post<T>(resolved.queryPath, body, {
        filter_properties: filterProperties,
      }, { retrySafe: true })
    : await client.post<T>(resolved.queryPath, body, undefined, { retrySafe: true });

  assertCompleteQueryResult(result, resolved.dataSourceId);
  return result;
}

function assertCompleteQueryResult(result: unknown, dataSourceId: string): void {
  const requestStatus = (result as { request_status?: { type?: string } } | null)?.request_status;
  if (requestStatus?.type === 'incomplete') {
    throw new IncompleteQueryError(dataSourceId);
  }
}

// ─── Pagination helper ──────────────────────────────────────────────────────

/**
 * Fetch all pages from a database, handling pagination automatically.
 */
export async function queryAllPages(
  client: NotionClient,
  databaseId: string,
  opts: QueryAllOptions = {},
): Promise<Page[]> {
  const resolved = await resolveDatabase(client, databaseId, effectiveDataSourceId(opts.dataSourceId));
  const pageSize = opts.pageSize ?? 100;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new Error('pageSize must be an integer between 1 and 100.');
  }
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
    throw new Error('limit must be a positive integer.');
  }

  const pages: Page[] = [];
  let fetched = 0;
  let cursor: string | undefined;
  const seenCursors = new Set<string>();

  do {
    const body: Record<string, unknown> = {
      page_size: pageSize,
      result_type: 'page',
    };
    if (opts.filter) body.filter = opts.filter;
    if (opts.sorts) body.sorts = opts.sorts;
    if (cursor) body.start_cursor = cursor;

    const result = await queryDatabaseDirect<PaginatedResponse<Page>>(
      client, resolved, body, { filterProperties: opts.filterProperties },
    );

    const remaining = opts.limit === undefined ? result.results.length : opts.limit - fetched;
    const accepted = result.results.slice(0, Math.max(0, remaining));
    for (const page of accepted) await opts.onPage?.(page);
    if (opts.collect !== false) pages.push(...accepted);
    fetched += accepted.length;
    if (result.has_more && !result.next_cursor) {
      throw new Error(
        `Notion reported more results for ${resolved.dataSourceId} without a next cursor. ` +
        'Refusing to return a silently truncated result.',
      );
    }
    cursor = result.has_more ? result.next_cursor : undefined;
    if (cursor) {
      if (seenCursors.has(cursor)) {
        throw new Error(
          `Notion repeated pagination cursor ${cursor} for ${resolved.dataSourceId}. ` +
          'Refusing to loop or return a potentially incomplete result.',
        );
      }
      seenCursors.add(cursor);
    }

    opts.onProgress?.(fetched);

    if (opts.limit && fetched >= opts.limit) break;
  } while (cursor);

  return pages;
}

// ─── Normalization ──────────────────────────────────────────────────────────

/**
 * Preserve a data-source response while guaranteeing the schema fields used
 * by commands. The object discriminator must remain truthful for JSON users.
 */
function normalizeToDatabase(
  ds: Record<string, unknown>,
  id: string,
): Database {
  return {
    ...ds,
    object: 'data_source' as const,
    id: (ds.id as string) || id,
    title: ds.title as Database['title'],
    description: ds.description as Database['description'],
    url: ds.url as string | undefined,
    properties: (ds.properties as Database['properties']) || {},
  };
}
