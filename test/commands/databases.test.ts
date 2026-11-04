import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Command } from 'commander';
import { mockDatabase, mockPage, createPaginatedResult, setupDatabaseResolution } from '../fixtures/notion-data';

describe('Databases Command', () => {
  let program: Command;
  let mockClient: any;

  function expectQuery(body: unknown, query?: unknown): void {
    const expectedBody = {
      result_type: 'page',
      ...(body as Record<string, unknown>),
    };
    expect(mockClient.post).toHaveBeenCalledWith(
      'data_sources/db-123/query',
      expectedBody,
      query,
      { retrySafe: true },
    );
  }

  beforeEach(async () => {
    vi.resetModules();

    // Create mock client
    mockClient = {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    };

    // Mock the client module
    vi.doMock('../../src/client', () => ({
      getClient: () => mockClient,
      initClient: vi.fn(),
    }));

    // Import command and register it
    const { registerDatabasesCommand } = await import('../../src/commands/databases');
    program = new Command();
    registerDatabasesCommand(program);
  });

  describe('database list', () => {
    it('should paginate explicitly with --all and preserve terminal metadata', async () => {
      const first = { ...mockDatabase, id: 'ds-1', object: 'data_source' };
      const second = { ...mockDatabase, id: 'ds-2', object: 'data_source' };
      mockClient.post
        .mockResolvedValueOnce({ results: [first], has_more: true, next_cursor: 'next-1' })
        .mockResolvedValueOnce({ results: [second], has_more: false, next_cursor: null });

      await program.parseAsync(['node', 'test', 'database', 'list', '--all', '--json']);

      expect(mockClient.post).toHaveBeenNthCalledWith(1, 'search', {
        filter: { property: 'object', value: 'data_source' },
        page_size: 100,
      }, undefined, { retrySafe: true });
      expect(mockClient.post).toHaveBeenNthCalledWith(2, 'search', {
        filter: { property: 'object', value: 'data_source' },
        page_size: 100,
        start_cursor: 'next-1',
      }, undefined, { retrySafe: true });

      const output = JSON.parse((console.log as any).mock.calls[0][0]);
      expect(output).toMatchObject({ has_more: false, next_cursor: null });
      expect(output.results.map((item: { id: string }) => item.id)).toEqual(['ds-1', 'ds-2']);
    });

    it('should reject a repeated cursor instead of looping forever', async () => {
      mockClient.post.mockResolvedValue({
        results: [{ ...mockDatabase, id: 'ds-1', object: 'data_source' }],
        has_more: true,
        next_cursor: 'stuck-cursor',
      });

      await expect(program.parseAsync([
        'node', 'test', 'database', 'list', '--all', '--json',
      ])).rejects.toThrow('repeated pagination cursor stuck-cursor');

      expect(mockClient.post).toHaveBeenCalledTimes(2);
    });

    it('should keep compact stdout record-only and send continuation metadata to stderr', async () => {
      mockClient.post.mockResolvedValue({
        results: [{ ...mockDatabase, id: 'ds-1', object: 'data_source' }],
        has_more: true,
        next_cursor: 'next-1',
      });

      await program.parseAsync([
        'node', 'test', 'database', 'list', '--compact', '--limit', '1',
      ]);

      expect(console.log).toHaveBeenCalledTimes(1);
      expect(console.log).toHaveBeenCalledWith('Test Database  ds-1');
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('next-1'));
    });
  });

  describe('database get', () => {
    it('should get database by ID', async () => {
      setupDatabaseResolution(mockClient);

      await program.parseAsync(['node', 'test', 'database', 'get', 'db-123']);

      expect(mockClient.get).toHaveBeenCalledWith('data_sources/db-123');
      expect(console.log).toHaveBeenCalledWith('Database:', 'Test Database');
      expect(console.log).toHaveBeenCalledWith('ID:', 'ds-456');
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Properties:'));
    });

    it('should output JSON when --json flag is used', async () => {
      setupDatabaseResolution(mockClient);

      await program.parseAsync(['node', 'test', 'database', 'get', 'db-123', '--json']);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"object": "data_source"'));
    });
  });

  describe('database query', () => {
    it('should query database without filters', async () => {
      setupDatabaseResolution(mockClient);
      const result = createPaginatedResult([mockPage]);
      mockClient.post.mockResolvedValue(result);

      await program.parseAsync(['node', 'test', 'database', 'query', 'db-123']);

      expectQuery({
        page_size: 100,
      });
    });

    it('should query with JSON filter', async () => {
      setupDatabaseResolution(mockClient);
      const result = createPaginatedResult([mockPage]);
      mockClient.post.mockResolvedValue(result);

      const filter = JSON.stringify({ property: 'Status', status: { equals: 'Done' } });
      await program.parseAsync([
        'node', 'test', 'database', 'query', 'db-123',
        '--filter', filter,
      ]);

      expectQuery({
        filter: { property: 'Status', status: { equals: 'Done' } },
        page_size: 100,
      });
    });

    it('should query with simple filter options', async () => {
      setupDatabaseResolution(mockClient);
      const result = createPaginatedResult([mockPage]);
      mockClient.post.mockResolvedValue(result);

      await program.parseAsync([
        'node', 'test', 'database', 'query', 'db-123',
        '--filter-prop', 'Status',
        '--filter-type', 'equals',
        '--filter-value', 'Done',
        '--filter-prop-type', 'status',
      ]);

      expectQuery({
        filter: {
          property: 'Status',
          status: { equals: 'Done' },
        },
        page_size: 100,
      });
    });

    it('should query with sorting (descending)', async () => {
      setupDatabaseResolution(mockClient);
      const result = createPaginatedResult([mockPage]);
      mockClient.post.mockResolvedValue(result);

      await program.parseAsync([
        'node', 'test', 'database', 'query', 'db-123',
        '--sort', 'Created',
      ]);

      expectQuery({
        sorts: [{
          property: 'Created',
          direction: 'descending',
        }],
        page_size: 100,
      });
    });

    it('should query with sorting (ascending)', async () => {
      setupDatabaseResolution(mockClient);
      const result = createPaginatedResult([mockPage]);
      mockClient.post.mockResolvedValue(result);

      await program.parseAsync([
        'node', 'test', 'database', 'query', 'db-123',
        '--sort', 'Priority',
        '--sort-dir', 'asc',
      ]);

      expectQuery({
        sorts: [{
          property: 'Priority',
          direction: 'ascending',
        }],
        page_size: 100,
      });
    });

    it('should query with limit', async () => {
      setupDatabaseResolution(mockClient);
      const result = createPaginatedResult([mockPage]);
      mockClient.post.mockResolvedValue(result);

      await program.parseAsync([
        'node', 'test', 'database', 'query', 'db-123',
        '--limit', '50',
      ]);

      expectQuery({
        page_size: 50,
      });
    });

    it('should query with cursor', async () => {
      setupDatabaseResolution(mockClient);
      const result = createPaginatedResult([mockPage]);
      mockClient.post.mockResolvedValue(result);

      await program.parseAsync([
        'node', 'test', 'database', 'query', 'db-123',
        '--cursor', 'cursor-123',
      ]);

      expectQuery({
        page_size: 100,
        start_cursor: 'cursor-123',
      });
    });

    it('should show pagination hint when has_more is true', async () => {
      setupDatabaseResolution(mockClient);
      const result = createPaginatedResult([mockPage], 'next-cursor-123', true);
      mockClient.post.mockResolvedValue(result);

      await program.parseAsync(['node', 'test', 'database', 'query', 'db-123']);

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('More results are available (cursor:')
      );
    });

    it('should output JSON when --json flag is used', async () => {
      setupDatabaseResolution(mockClient);
      const result = createPaginatedResult([mockPage]);
      mockClient.post.mockResolvedValue(result);

      await program.parseAsync(['node', 'test', 'database', 'query', 'db-123', '--json']);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"object": "list"'));
    });

    it('should combine filter, sort, and pagination', async () => {
      setupDatabaseResolution(mockClient);
      const result = createPaginatedResult([mockPage]);
      mockClient.post.mockResolvedValue(result);

      await program.parseAsync([
        'node', 'test', 'database', 'query', 'db-123',
        '--filter-prop', 'Status',
        '--filter-type', 'equals',
        '--filter-value', 'In Progress',
        '--filter-prop-type', 'status',
        '--sort', 'Priority',
        '--sort-dir', 'asc',
        '--limit', '25',
      ]);

      expectQuery({
        filter: {
          property: 'Status',
          status: { equals: 'In Progress' },
        },
        sorts: [{
          property: 'Priority',
          direction: 'ascending',
        }],
        page_size: 25,
      });
    });
  });

  describe('database query --all and --jsonl', () => {
    it('should document complete pagination and JSONL in command help', () => {
      const database = program.commands.find(command => command.name() === 'database');
      const query = database?.commands.find(command => command.name() === 'query');
      const help = query?.helpInformation() ?? '';

      expect(help).toContain('--all');
      expect(help).toContain('Fetch every returned row');
      expect(help).toContain('--jsonl');
      expect(help).toContain('Results per API page');
    });

    it('should drain every page with filters, sorts, projection, and a configured page size', async () => {
      setupDatabaseResolution(mockClient);
      const secondPage = { ...mockPage, id: 'page-456' };
      mockClient.post
        .mockResolvedValueOnce(createPaginatedResult([mockPage], 'cursor-2', true))
        .mockResolvedValueOnce(createPaginatedResult([secondPage]));

      await program.parseAsync([
        'node', 'test', 'database', 'query', 'db-123',
        '--all',
        '--json',
        '--limit', '50',
        '--filter-prop', 'Status',
        '--filter-type', 'equals',
        '--filter-value', 'Done',
        '--filter-prop-type', 'status',
        '--sort', 'Name',
        '--sort-dir', 'asc',
        '--filter-properties', 'title',
        '--filter-properties', 'status',
      ]);

      const commonBody = {
        page_size: 50,
        result_type: 'page',
        filter: { property: 'Status', status: { equals: 'Done' } },
        sorts: [{ property: 'Name', direction: 'ascending' }],
      };
      const query = { filter_properties: ['title', 'status'] };
      expect(mockClient.post).toHaveBeenNthCalledWith(
        1, 'data_sources/db-123/query', commonBody, query, { retrySafe: true },
      );
      expect(mockClient.post).toHaveBeenNthCalledWith(
        2,
        'data_sources/db-123/query',
        { ...commonBody, start_cursor: 'cursor-2' },
        query,
        { retrySafe: true },
      );

      const output = JSON.parse((console.log as any).mock.calls[0][0]);
      expect(output).toMatchObject({ object: 'list', has_more: false, next_cursor: null });
      expect(output.results.map((page: { id: string }) => page.id))
        .toEqual(['page-123', 'page-456']);
    });

    it('should emit one returned row object per JSONL line', async () => {
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      setupDatabaseResolution(mockClient);
      const secondPage = { ...mockPage, id: 'page-456' };
      mockClient.post.mockResolvedValue(createPaginatedResult([mockPage, secondPage]));

      await program.parseAsync([
        'node', 'test', 'database', 'query', 'db-123', '--all', '--jsonl',
      ]);

      const output = stdoutSpy.mock.calls.map(([chunk]) => chunk.toString()).join('');
      const lines = output.trim().split('\n').map(line => JSON.parse(line));
      expect(lines.map((page: { id: string }) => page.id)).toEqual(['page-123', 'page-456']);
      stdoutSpy.mockRestore();
    });

    it('should not emit partial JSONL when a later response is incomplete', async () => {
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      setupDatabaseResolution(mockClient);
      mockClient.post
        .mockResolvedValueOnce(createPaginatedResult([mockPage], 'cursor-2', true))
        .mockResolvedValueOnce({
          ...createPaginatedResult([{ ...mockPage, id: 'page-456' }]),
          request_status: { type: 'incomplete' },
        });

      await expect(program.parseAsync([
        'node', 'test', 'database', 'query', 'db-123', '--all', '--jsonl',
      ])).rejects.toThrow('10,000-result safety limit');

      expect(console.log).not.toHaveBeenCalled();
      expect(stdoutSpy).not.toHaveBeenCalled();
      stdoutSpy.mockRestore();
    });

    it('should reject JSONL without complete row traversal', async () => {
      await expect(program.parseAsync([
        'node', 'test', 'database', 'query', 'db-123', '--jsonl',
      ])).rejects.toThrow('--jsonl requires --all');

      expect(mockClient.get).not.toHaveBeenCalled();
      expect(mockClient.post).not.toHaveBeenCalled();
    });

    it('should reject --all with a starting cursor before querying', async () => {
      await expect(program.parseAsync([
        'node', 'test', 'database', 'query', 'db-123', '--all', '--cursor', 'cursor-1',
      ])).rejects.toThrow('--all cannot be combined with --cursor');

      expect(mockClient.get).not.toHaveBeenCalled();
      expect(mockClient.post).not.toHaveBeenCalled();
    });

    it('should reject mutually exclusive JSON formats before querying', async () => {
      await expect(program.parseAsync([
        'node', 'test', 'database', 'query', 'db-123', '--json', '--jsonl',
      ])).rejects.toThrow('--json and --jsonl are mutually exclusive');

      expect(mockClient.get).not.toHaveBeenCalled();
      expect(mockClient.post).not.toHaveBeenCalled();
    });
  });

  describe('database query multi-filter', () => {
    it('should combine two filter groups with { and: [...] }', async () => {
      setupDatabaseResolution(mockClient);
      const result = createPaginatedResult([mockPage]);
      mockClient.post.mockResolvedValue(result);

      await program.parseAsync([
        'node', 'test', 'database', 'query', 'db-123',
        '--filter-prop', 'Due Date',
        '--filter-type', 'before',
        '--filter-value', '2024-01-01',
        '--filter-prop-type', 'date',
        '--filter-prop', 'Done',
        '--filter-type', 'equals',
        '--filter-value', 'true',
        '--filter-prop-type', 'checkbox',
      ]);

      expectQuery({
        filter: {
          and: [
            { property: 'Due Date', date: { before: '2024-01-01' } },
            { property: 'Done', checkbox: { equals: true } },
          ],
        },
        page_size: 100,
      });
    });

    it('should combine three filter groups with { and: [...] }', async () => {
      setupDatabaseResolution(mockClient);
      const result = createPaginatedResult([mockPage]);
      mockClient.post.mockResolvedValue(result);

      await program.parseAsync([
        'node', 'test', 'database', 'query', 'db-123',
        '--filter-prop', 'Status',
        '--filter-type', 'equals',
        '--filter-value', 'Done',
        '--filter-prop-type', 'status',
        '--filter-prop', 'Priority',
        '--filter-type', 'equals',
        '--filter-value', 'High',
        '--filter-prop-type', 'select',
        '--filter-prop', 'Done',
        '--filter-type', 'equals',
        '--filter-value', 'true',
        '--filter-prop-type', 'checkbox',
      ]);

      expectQuery({
        filter: {
          and: [
            { property: 'Status', status: { equals: 'Done' } },
            { property: 'Priority', select: { equals: 'High' } },
            { property: 'Done', checkbox: { equals: true } },
          ],
        },
        page_size: 100,
      });
    });

    it('should reject when filter flag counts are mismatched', async () => {
      await expect(
        program.parseAsync([
          'node', 'test', 'database', 'query', 'db-123',
          '--filter-prop', 'Status',
          '--filter-prop', 'Priority',
          '--filter-type', 'equals',
          '--filter-value', 'Done',
        ])
      ).rejects.toThrow('--filter-prop and --filter-type must be provided the same number of times.');
    });

    it('should reject when --filter-prop-type count does not match filter group count', async () => {
      await expect(
        program.parseAsync([
          'node', 'test', 'database', 'query', 'db-123',
          '--filter-prop', 'Title',
          '--filter-type', 'contains',
          '--filter-value', 'foo',
          '--filter-prop', 'Status',
          '--filter-type', 'equals',
          '--filter-value', 'Done',
          '--filter-prop-type', 'status',
        ])
      ).rejects.toThrow('--filter-prop-type must be provided either for all filter groups or for none.');
    });

    it('should produce plain filter object for single filter group (regression)', async () => {
      setupDatabaseResolution(mockClient);
      const result = createPaginatedResult([mockPage]);
      mockClient.post.mockResolvedValue(result);

      await program.parseAsync([
        'node', 'test', 'database', 'query', 'db-123',
        '--filter-prop', 'Status',
        '--filter-type', 'equals',
        '--filter-value', 'Done',
        '--filter-prop-type', 'status',
      ]);

      expectQuery({
        filter: { property: 'Status', status: { equals: 'Done' } },
        page_size: 100,
      });
    });

    it('should use raw --filter JSON unchanged (regression)', async () => {
      setupDatabaseResolution(mockClient);
      const result = createPaginatedResult([mockPage]);
      mockClient.post.mockResolvedValue(result);

      const filter = JSON.stringify({ property: 'Status', status: { equals: 'Done' } });
      await program.parseAsync([
        'node', 'test', 'database', 'query', 'db-123',
        '--filter', filter,
      ]);

      expectQuery({
        filter: { property: 'Status', status: { equals: 'Done' } },
        page_size: 100,
      });
    });

    it('should combine repeated raw filters with AND', async () => {
      setupDatabaseResolution(mockClient);
      mockClient.post.mockResolvedValue(createPaginatedResult([mockPage]));

      await program.parseAsync([
        'node', 'test', 'database', 'query', 'db-123',
        '--filter', JSON.stringify({ property: 'Status', status: { equals: 'Done' } }),
        '--filter', JSON.stringify({ property: 'Value', number: { greater_than: 5 } }),
      ]);

      expectQuery({
        filter: {
          and: [
            { property: 'Status', status: { equals: 'Done' } },
            { property: 'Value', number: { greater_than: 5 } },
          ],
        },
        page_size: 100,
      });
    });

    it('should resolve an unhinted filter type from the data-source schema', async () => {
      setupDatabaseResolution(mockClient);
      mockClient.post.mockResolvedValue(createPaginatedResult([mockPage]));

      await program.parseAsync([
        'node', 'test', 'database', 'query', 'db-123',
        '--filter-prop', 'Status',
        '--filter-type', 'equals',
        '--filter-value', 'Active',
      ]);

      expectQuery({
        filter: { property: 'Status', status: { equals: 'Active' } },
        page_size: 100,
      });
    });

    it('should accept valueless operators without --filter-value', async () => {
      setupDatabaseResolution(mockClient);
      mockClient.post.mockResolvedValue(createPaginatedResult([mockPage]));

      await program.parseAsync([
        'node', 'test', 'database', 'query', 'db-123',
        '--filter-prop', 'Status',
        '--filter-type', 'is_empty',
      ]);

      expectQuery({
        filter: { property: 'Status', status: { is_empty: true } },
        page_size: 100,
      });
    });

    it('should pass repeated filter_properties query parameters', async () => {
      setupDatabaseResolution(mockClient);
      mockClient.post.mockResolvedValue(createPaginatedResult([mockPage]));

      await program.parseAsync([
        'node', 'test', 'database', 'query', 'db-123',
        '--filter-properties', 'title',
        '--filter-properties', 'status',
      ]);

      expectQuery(
        { page_size: 100 },
        { filter_properties: ['title', 'status'] },
      );
    });
  });

  describe('--title flag', () => {
    it('should auto-detect title property and filter by exact title', async () => {
      // First resolution (for --title schema lookup), then another for query
      setupDatabaseResolution(mockClient);
      // The resolver caches, so query uses cached resolution
      mockClient.post.mockResolvedValue(createPaginatedResult([mockPage]));

      await program.parseAsync(['node', 'test', 'database', 'query', 'db-123', '--title', 'My Task']);

      expect(mockClient.post).toHaveBeenCalledWith(
        'data_sources/db-123/query',
        expect.objectContaining({
          filter: { property: 'Name', title: { equals: 'My Task' } },
        }),
        undefined,
        { retrySafe: true },
      );
    });
  });

  describe('compact format on query', () => {
    it('should output compact format', async () => {
      setupDatabaseResolution(mockClient);
      mockClient.post.mockResolvedValue(createPaginatedResult([mockPage]));

      await program.parseAsync(['node', 'test', 'database', 'query', 'db-123']);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('page-123 Test Page'));
    });
  });

  describe('Error handling', () => {
    it('should handle get errors', async () => {
      mockClient.get.mockRejectedValue(new Error('Database not found'));

      await expect(
        program.parseAsync(['node', 'test', 'database', 'get', 'invalid-id'])
      ).rejects.toThrow('Database not found');
    });

    it('should handle query errors', async () => {
      setupDatabaseResolution(mockClient);
      mockClient.post.mockRejectedValue(new Error('Invalid filter'));

      await expect(
        program.parseAsync(['node', 'test', 'database', 'query', 'db-123'])
      ).rejects.toThrow('Invalid filter');
    });

    it('should handle invalid JSON filter', async () => {
      await expect(
        program.parseAsync([
          'node', 'test', 'database', 'query', 'db-123',
          '--filter', '{invalid json}',
        ])
      ).rejects.toThrow('Invalid --filter JSON');
    });
  });
});
