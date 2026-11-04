import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  mockDataSource,
  mockPage,
  createPaginatedResult,
  createMockDataSource,
  mockMultiDsDatabase,
} from '../fixtures/notion-data';

describe('DatabaseResolver (API v2026-03-11)', () => {
  let mockClient: any;
  let resolver: typeof import('../../src/utils/database-resolver');

  beforeEach(async () => {
    vi.resetModules();
    mockClient = {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      request: vi.fn(),
    };
    resolver = await import('../../src/utils/database-resolver');
    resolver.clearResolverCache();
    resolver.setGlobalDataSourceId(undefined);
  });

  /**
   * Helper: set up mock for the new resolution flow.
   * GET /data_sources/{databaseId} → returns { object: 'data_source', ... }
   * The resolver treats the input databaseId as the dataSourceId directly.
   */
  function setupResolutionMocks(databaseId = 'db-123') {
    mockClient.get
      .mockResolvedValueOnce({ ...mockDataSource, object: 'data_source', id: databaseId });
  }

  /**
   * Helper: set up mock for explicit data-source-id path.
   * Only GET /data_sources/{id} (skip discovery).
   */
  function setupExplicitDsMock(dataSourceId = 'ds-456', databaseId = 'any-id') {
    mockClient.get.mockResolvedValueOnce({
      ...mockDataSource,
      id: dataSourceId,
      parent: { type: 'database_id', database_id: databaseId },
    });
  }

  describe('normalizeNotionId()', () => {
    it('normalizes compact IDs and IDs embedded in Notion URLs', () => {
      expect(resolver.normalizeNotionId('2C98284A864381409380DEAF158A1077'))
        .toBe('2c98284a-8643-8140-9380-deaf158a1077');
      expect(resolver.normalizeNotionId(
        'https://www.notion.so/acme/Tasks-2c98284a864381409380deaf158a1077?v=view-id',
      )).toBe('2c98284a-8643-8140-9380-deaf158a1077');
      expect(resolver.normalizeNotionId(
        'https://app.notion.com/p/2c98284a864381409380deaf158a1077?v=view-id',
      )).toBe('2c98284a-8643-8140-9380-deaf158a1077');
    });

    it('rejects unrelated URLs and Notion URLs without an ID', () => {
      expect(() => resolver.normalizeNotionId('https://example.com/2c98284a864381409380deaf158a1077'))
        .toThrow('Expected a Notion URL');
      expect(() => resolver.normalizeNotionId('https://www.notion.so/acme/tasks'))
        .toThrow('Could not find a Notion ID');
    });
  });

  // ─── resolveDatabase ──────────────────────────────────────────────────────

  describe('resolveDatabase()', () => {
    it('should resolve data_source directly via GET /data_sources/{databaseId}', async () => {
      setupResolutionMocks();

      const result = await resolver.resolveDatabase(mockClient, 'db-123');

      expect(result.type).toBe('data_source');
      expect(result.schemaPath).toBe('data_sources/db-123');
      expect(result.queryPath).toBe('data_sources/db-123/query');
      expect(result.schema.properties).toBeDefined();
      expect(result.databaseId).toBe('db-123');
      expect(result.dataSourceId).toBe('db-123');
      // Single call: GET /data_sources/{databaseId}
      expect(mockClient.get).toHaveBeenCalledWith('data_sources/db-123');
      expect(mockClient.get).toHaveBeenCalledTimes(1);
    });

    it('should fall back to legacy discovery and error with helpful message when multiple data sources exist', async () => {
      // First call: GET /data_sources/{id} fails (not a data_source)
      mockClient.get
        .mockRejectedValueOnce(Object.assign(new Error('Not found'), { status: 404 }))
        .mockResolvedValueOnce({
          ...mockMultiDsDatabase,
          data_sources: [
            { id: 'ds-1', name: 'Source A' },
            { id: 'ds-2', name: 'Source B' },
          ],
        });

      await expect(resolver.resolveDatabase(mockClient, 'multi-ds-db-123'))
        .rejects.toThrow('--data-source-id');
    });

    it('should fall back to legacy discovery and error when database has no data sources', async () => {
      // First call: GET /data_sources/{id} fails (not a data_source)
      mockClient.get
        .mockRejectedValueOnce(Object.assign(new Error('Not found'), { status: 404 }))
        .mockResolvedValueOnce({
          ...mockMultiDsDatabase,
          data_sources: [],
        });

      await expect(resolver.resolveDatabase(mockClient, 'empty-db'))
        .rejects.toThrow('no data sources');
    });

    it('should use explicit dataSourceId without discovery', async () => {
      setupExplicitDsMock('ds-explicit', 'any-db-id');

      const result = await resolver.resolveDatabase(mockClient, 'any-db-id', 'ds-explicit');

      expect(result.type).toBe('data_source');
      expect(result.schemaPath).toBe('data_sources/ds-explicit');
      expect(result.queryPath).toBe('data_sources/ds-explicit/query');
      // Only one GET call (no discovery step)
      expect(mockClient.get).toHaveBeenCalledTimes(1);
      expect(mockClient.get).toHaveBeenCalledWith('data_sources/ds-explicit');
    });

    it('should reject an explicit data source owned by a different database', async () => {
      setupExplicitDsMock('ds-explicit', 'different-db');

      await expect(resolver.resolveDatabase(mockClient, 'requested-db', 'ds-explicit'))
        .rejects.toThrow('belongs to database different-db, not requested-db');

      expect(mockClient.get).toHaveBeenCalledTimes(1);
      expect(mockClient.get).toHaveBeenCalledWith('data_sources/ds-explicit');
    });

    it('should cache resolution results for same database ID', async () => {
      setupResolutionMocks();

      const result1 = await resolver.resolveDatabase(mockClient, 'db-123');
      const result2 = await resolver.resolveDatabase(mockClient, 'db-123');

      expect(result1).toBe(result2);
      expect(mockClient.get).toHaveBeenCalledTimes(1); // single call, then cached
    });

    it('should cache resolution with explicit dataSourceId using composite key', async () => {
      setupExplicitDsMock('ds-1', 'db-x');

      const result1 = await resolver.resolveDatabase(mockClient, 'db-x', 'ds-1');
      const result2 = await resolver.resolveDatabase(mockClient, 'db-x', 'ds-1');

      expect(result1).toBe(result2);
      expect(mockClient.get).toHaveBeenCalledTimes(1);
    });

    it('should not share cache between different database IDs', async () => {
      const ds1 = createMockDataSource('db-1', 'DS One');
      const ds2 = createMockDataSource('db-2', 'DS Two');

      mockClient.get
        .mockResolvedValueOnce({ ...ds1, object: 'data_source' })
        .mockResolvedValueOnce({ ...ds2, object: 'data_source' });

      const result1 = await resolver.resolveDatabase(mockClient, 'db-1');
      const result2 = await resolver.resolveDatabase(mockClient, 'db-2');

      expect(result1.dataSourceId).toBe('db-1');
      expect(result2.dataSourceId).toBe('db-2');
      expect(mockClient.get).toHaveBeenCalledTimes(2);
    });

    it('should propagate errors when both direct and legacy paths fail', async () => {
      mockClient.get.mockRejectedValue(new Error('Notion API Error (404): Resource not found'));

      await expect(resolver.resolveDatabase(mockClient, 'bad-id'))
        .rejects.toThrow('Notion API Error (404)');
    });

    it('should propagate network errors when both paths fail', async () => {
      mockClient.get.mockRejectedValue(new Error('fetch failed'));

      await expect(resolver.resolveDatabase(mockClient, 'db-123'))
        .rejects.toThrow('fetch failed');
      expect(mockClient.get).toHaveBeenCalledTimes(1);
    });

    it('should clear cache when clearResolverCache is called', async () => {
      setupResolutionMocks();
      await resolver.resolveDatabase(mockClient, 'db-123');

      resolver.clearResolverCache();

      setupResolutionMocks();
      await resolver.resolveDatabase(mockClient, 'db-123');

      expect(mockClient.get).toHaveBeenCalledTimes(2); // 1 per resolution
    });

    it('should normalize data_source response to Database shape', async () => {
      setupResolutionMocks();

      const result = await resolver.resolveDatabase(mockClient, 'db-123');

      expect(result.schema.id).toBeDefined();
      expect(result.schema.properties).toBeDefined();
      expect(result.schema.title).toBeDefined();
      expect(result.schema.object).toBe('data_source');
    });

    it('should handle database ID with dashes (UUID format)', async () => {
      const uuidId = '2c98284a-8643-8140-9380-deaf158a1077';
      mockClient.get
        .mockResolvedValueOnce({ ...mockDataSource, object: 'data_source', id: uuidId });

      const result = await resolver.resolveDatabase(mockClient, uuidId);

      expect(result.databaseId).toBe(uuidId);
      expect(mockClient.get).toHaveBeenCalledWith(`data_sources/${uuidId}`);
    });

    it('should resolve a database URL using its normalized ID', async () => {
      const uuidId = '2c98284a-8643-8140-9380-deaf158a1077';
      mockClient.get.mockResolvedValueOnce({ ...mockDataSource, object: 'data_source', id: uuidId });

      const result = await resolver.resolveDatabase(
        mockClient,
        `https://www.notion.so/Tasks-${uuidId.replace(/-/g, '')}`,
      );

      expect(result.databaseId).toBe(uuidId);
      expect(mockClient.get).toHaveBeenCalledWith(`data_sources/${uuidId}`);
    });

    it('should handle data_source with minimal properties', async () => {
      const minimalDs = { object: 'data_source', id: 'db-minimal', properties: {} };
      mockClient.get.mockResolvedValueOnce(minimalDs);

      const result = await resolver.resolveDatabase(mockClient, 'db-minimal');

      expect(result.schema.properties).toEqual({});
      expect(result.type).toBe('data_source');
    });

    it('should handle concurrent resolutions for same ID without duplicate calls', async () => {
      let resolveGet: (value: any) => void;
      const pendingGet = new Promise((resolve) => { resolveGet = resolve; });
      mockClient.get.mockReturnValueOnce(pendingGet);

      const promise1 = resolver.resolveDatabase(mockClient, 'db-concurrent', 'ds-explicit');
      const promise2 = resolver.resolveDatabase(mockClient, 'db-concurrent', 'ds-explicit');

      resolveGet!({
        ...mockDataSource,
        id: 'ds-explicit',
        parent: { type: 'database_id', database_id: 'db-concurrent' },
      });

      const [result1, result2] = await Promise.all([promise1, promise2]);

      expect(result1).toBe(result2);
      expect(mockClient.get).toHaveBeenCalledTimes(1);
    });
  });

  // ─── getDatabaseSchema ─────────────────────────────────────────────────────

  describe('getDatabaseSchema()', () => {
    it('should return schema via direct data_source lookup', async () => {
      setupResolutionMocks();

      const schema = await resolver.getDatabaseSchema(mockClient, 'db-123');

      expect(schema.properties).toBeDefined();
      expect(mockClient.get).toHaveBeenCalledWith('data_sources/db-123');
      expect(mockClient.get).toHaveBeenCalledTimes(1);
    });

    it('should return schema for explicit data source ID', async () => {
      setupExplicitDsMock('ds-456');

      const schema = await resolver.getDatabaseSchema(mockClient, 'any-id', { dataSourceId: 'ds-456' });

      expect(schema.properties).toBeDefined();
      expect(mockClient.get).toHaveBeenCalledWith('data_sources/ds-456');
    });

    it('should use cached resolution on repeated calls', async () => {
      setupResolutionMocks();

      await resolver.getDatabaseSchema(mockClient, 'db-123');
      await resolver.getDatabaseSchema(mockClient, 'db-123');

      expect(mockClient.get).toHaveBeenCalledTimes(1); // single call, then cached
    });
  });

  // ─── queryDatabase ─────────────────────────────────────────────────────────

  describe('queryDatabase()', () => {
    it('should query via data_sources path', async () => {
      setupResolutionMocks();
      const queryResult = createPaginatedResult([mockPage]);
      mockClient.post.mockResolvedValue(queryResult);

      const result = await resolver.queryDatabase(mockClient, 'db-123', { page_size: 10 });

      expect(mockClient.post).toHaveBeenCalledWith(
        'data_sources/db-123/query', { page_size: 10 }, undefined, { retrySafe: true },
      );
      expect(result).toEqual(queryResult);
    });

    it('should query with explicit data source ID', async () => {
      setupExplicitDsMock('ds-456');
      const queryResult = createPaginatedResult([mockPage]);
      mockClient.post.mockResolvedValue(queryResult);

      await resolver.queryDatabase(mockClient, 'any-id', { page_size: 20 }, { dataSourceId: 'ds-456' });

      expect(mockClient.post).toHaveBeenCalledWith(
        'data_sources/ds-456/query', { page_size: 20 }, undefined, { retrySafe: true },
      );
    });

    it('should pass empty body when none provided', async () => {
      setupResolutionMocks();
      mockClient.post.mockResolvedValue(createPaginatedResult([mockPage]));

      await resolver.queryDatabase(mockClient, 'db-123');

      expect(mockClient.post).toHaveBeenCalledWith(
        'data_sources/db-123/query', {}, undefined, { retrySafe: true },
      );
    });

    it('should pass complex filter bodies through unchanged', async () => {
      setupResolutionMocks();
      mockClient.post.mockResolvedValue(createPaginatedResult([mockPage]));

      const complexBody = {
        filter: { and: [{ property: 'Status', status: { equals: 'Done' } }] },
        sorts: [{ property: 'Name', direction: 'ascending' }],
        page_size: 50,
        start_cursor: 'cursor-abc',
      };

      await resolver.queryDatabase(mockClient, 'db-123', complexBody);

      expect(mockClient.post).toHaveBeenCalledWith(
        'data_sources/db-123/query', complexBody, undefined, { retrySafe: true },
      );
    });

    it('should send filter_properties as repeated query parameters', async () => {
      setupResolutionMocks();
      mockClient.post.mockResolvedValue(createPaginatedResult([mockPage]));

      await resolver.queryDatabase(mockClient, 'db-123', {}, {
        filterProperties: ['title-id', 'status-id'],
      });

      expect(mockClient.post).toHaveBeenCalledWith(
        'data_sources/db-123/query',
        {},
        { filter_properties: ['title-id', 'status-id'] },
        { retrySafe: true },
      );
    });

    it('should reject an incomplete 10,000-result response', async () => {
      setupResolutionMocks();
      mockClient.post.mockResolvedValue({
        ...createPaginatedResult([mockPage]),
        request_status: { type: 'incomplete' },
      });

      await expect(resolver.queryDatabase(mockClient, 'db-123'))
        .rejects.toMatchObject({ name: 'IncompleteQueryError', code: 'notion_query_incomplete' });
    });

    it('should use cached resolution for subsequent queries', async () => {
      setupResolutionMocks();
      mockClient.post.mockResolvedValue(createPaginatedResult([mockPage]));

      await resolver.queryDatabase(mockClient, 'db-123', {});
      await resolver.queryDatabase(mockClient, 'db-123', { page_size: 5 });

      // get called once for resolution (direct data_source), post called twice for queries
      expect(mockClient.get).toHaveBeenCalledTimes(1);
      expect(mockClient.post).toHaveBeenCalledTimes(2);
    });
  });

  // ─── updateDatabase ────────────────────────────────────────────────────────

  // ─── queryDatabaseDirect ──────────────────────────────────────────────────

  describe('queryDatabaseDirect()', () => {
    it('should query using pre-resolved path', async () => {
      setupResolutionMocks();
      const queryResult = createPaginatedResult([mockPage]);
      mockClient.post.mockResolvedValue(queryResult);

      const resolved = await resolver.resolveDatabase(mockClient, 'db-123');
      const result = await resolver.queryDatabaseDirect(mockClient, resolved, { page_size: 10 });

      expect(mockClient.post).toHaveBeenCalledWith(
        'data_sources/db-123/query', { page_size: 10 }, undefined, { retrySafe: true },
      );
      expect(result).toEqual(queryResult);
    });
  });

  // ─── queryAllPages ──────────────────────────────────────────────────────────

  describe('queryAllPages()', () => {
    it('should fetch all pages with automatic pagination', async () => {
      setupResolutionMocks();
      const page1 = { ...mockPage, id: 'page-1' };
      const page2 = { ...mockPage, id: 'page-2' };
      const page3 = { ...mockPage, id: 'page-3' };

      mockClient.post
        .mockResolvedValueOnce(createPaginatedResult([page1, page2], 'cursor-2', true))
        .mockResolvedValueOnce(createPaginatedResult([page3]));

      const pages = await resolver.queryAllPages(mockClient, 'db-123');

      expect(pages).toHaveLength(3);
      expect(pages.map(p => p.id)).toEqual(['page-1', 'page-2', 'page-3']);
      expect(mockClient.post).toHaveBeenCalledTimes(2);
    });

    it('should pass filter and sorts to every query call', async () => {
      setupResolutionMocks();
      mockClient.post.mockResolvedValue(createPaginatedResult([mockPage]));

      const filter = { property: 'Status', status: { equals: 'Done' } };
      const sorts = [{ property: 'Name', direction: 'ascending' }];

      await resolver.queryAllPages(mockClient, 'db-123', { filter, sorts: sorts as any });

      expect(mockClient.post).toHaveBeenCalledWith('data_sources/db-123/query', {
        page_size: 100,
        result_type: 'page',
        filter,
        sorts,
      }, undefined, { retrySafe: true });
    });

    it('should respect limit and truncate results', async () => {
      setupResolutionMocks();
      const pages = Array.from({ length: 5 }, (_, i) => ({ ...mockPage, id: `page-${i}` }));
      mockClient.post.mockResolvedValue(createPaginatedResult(pages, 'cursor-next', true));

      const result = await resolver.queryAllPages(mockClient, 'db-123', { limit: 3 });

      expect(result).toHaveLength(3);
      expect(mockClient.post).toHaveBeenCalledTimes(1);
    });

    it('should use custom pageSize', async () => {
      setupResolutionMocks();
      mockClient.post.mockResolvedValue(createPaginatedResult([mockPage]));

      await resolver.queryAllPages(mockClient, 'db-123', { pageSize: 50 });

      expect(mockClient.post).toHaveBeenCalledWith('data_sources/db-123/query', {
        page_size: 50,
        result_type: 'page',
      }, undefined, { retrySafe: true });
    });

    it('should call onProgress callback with running count', async () => {
      setupResolutionMocks();
      const page1 = { ...mockPage, id: 'page-1' };
      const page2 = { ...mockPage, id: 'page-2' };

      mockClient.post
        .mockResolvedValueOnce(createPaginatedResult([page1], 'cursor-2', true))
        .mockResolvedValueOnce(createPaginatedResult([page2]));

      const progressCalls: number[] = [];
      await resolver.queryAllPages(mockClient, 'db-123', {
        onProgress: (n) => progressCalls.push(n),
      });

      expect(progressCalls).toEqual([1, 2]);
    });

    it('should handle empty results', async () => {
      setupResolutionMocks();
      mockClient.post.mockResolvedValue(createPaginatedResult([]));

      const pages = await resolver.queryAllPages(mockClient, 'db-123');

      expect(pages).toHaveLength(0);
    });

    it('should pass start_cursor on subsequent pages', async () => {
      setupResolutionMocks();
      mockClient.post
        .mockResolvedValueOnce(createPaginatedResult([mockPage], 'cursor-xyz', true))
        .mockResolvedValueOnce(createPaginatedResult([mockPage]));

      await resolver.queryAllPages(mockClient, 'db-123');

      expect(mockClient.post).toHaveBeenCalledWith('data_sources/db-123/query', {
        page_size: 100,
        result_type: 'page',
        start_cursor: 'cursor-xyz',
      }, undefined, { retrySafe: true });
    });

    it('should fail instead of truncating when has_more has no cursor', async () => {
      setupResolutionMocks();
      mockClient.post.mockResolvedValue({
        results: [mockPage],
        has_more: true,
        next_cursor: null,
      });

      await expect(resolver.queryAllPages(mockClient, 'db-123'))
        .rejects.toThrow('without a next cursor');
    });

    it('should reject incomplete results before returning partial pages', async () => {
      setupResolutionMocks();
      mockClient.post.mockResolvedValue({
        results: [mockPage],
        has_more: false,
        next_cursor: null,
        request_status: { type: 'incomplete' },
      });

      await expect(resolver.queryAllPages(mockClient, 'db-123'))
        .rejects.toThrow('10,000-result safety limit');
    });

    it('should validate pagination options before querying', async () => {
      setupResolutionMocks();

      await expect(resolver.queryAllPages(mockClient, 'db-123', { pageSize: 101 }))
        .rejects.toThrow('between 1 and 100');
      expect(mockClient.post).not.toHaveBeenCalled();
    });

    it('should reject a repeated cursor instead of looping forever', async () => {
      setupResolutionMocks();
      mockClient.post
        .mockResolvedValueOnce(createPaginatedResult([mockPage], 'same-cursor', true))
        .mockResolvedValueOnce(createPaginatedResult([mockPage], 'same-cursor', true));

      await expect(resolver.queryAllPages(mockClient, 'db-123'))
        .rejects.toThrow('repeated pagination cursor');
      expect(mockClient.post).toHaveBeenCalledTimes(2);
    });
  });

  // ─── Global data-source-id fallback ─────────────────────────────────────────

  describe('setGlobalDataSourceId()', () => {
    it('should use global data-source-id when no explicit option is provided', async () => {
      setupExplicitDsMock('ds-global', 'any-db');

      resolver.setGlobalDataSourceId('ds-global');
      await resolver.getDatabaseSchema(mockClient, 'any-db');

      expect(mockClient.get).toHaveBeenCalledWith('data_sources/ds-global');
    });

    it('should prefer explicit dataSourceId over global', async () => {
      setupExplicitDsMock('ds-explicit', 'any-db');

      resolver.setGlobalDataSourceId('ds-global');
      await resolver.getDatabaseSchema(mockClient, 'any-db', { dataSourceId: 'ds-explicit' });

      expect(mockClient.get).toHaveBeenCalledWith('data_sources/ds-explicit');
    });

    it('should not use global when cleared', async () => {
      setupResolutionMocks();

      resolver.setGlobalDataSourceId('ds-global');
      resolver.setGlobalDataSourceId(undefined);
      await resolver.getDatabaseSchema(mockClient, 'db-123');

      // Without global, goes through direct data_source lookup
      expect(mockClient.get).toHaveBeenCalledWith('data_sources/db-123');
    });

    it('should flow through to queryDatabase', async () => {
      setupExplicitDsMock('ds-global', 'any-db');
      const queryResult = createPaginatedResult([mockPage]);
      mockClient.post.mockResolvedValue(queryResult);

      resolver.setGlobalDataSourceId('ds-global');
      await resolver.queryDatabase(mockClient, 'any-db', { page_size: 10 });

      expect(mockClient.post).toHaveBeenCalledWith(
        'data_sources/ds-global/query', { page_size: 10 }, undefined, { retrySafe: true },
      );
    });

    it('should flow through to queryAllPages', async () => {
      setupExplicitDsMock('ds-global', 'any-db');
      mockClient.post.mockResolvedValue(createPaginatedResult([mockPage]));

      resolver.setGlobalDataSourceId('ds-global');
      await resolver.queryAllPages(mockClient, 'any-db');

      expect(mockClient.post).toHaveBeenCalledWith(
        'data_sources/ds-global/query',
        { page_size: 100, result_type: 'page' },
        undefined,
        { retrySafe: true },
      );
    });

  });
});
