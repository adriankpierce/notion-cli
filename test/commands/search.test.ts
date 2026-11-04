import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Command } from 'commander';
import { mockSearchResult, createPaginatedResult, createMockPage, createMockDatabase } from '../fixtures/notion-data';

describe('Search Command', () => {
  let program: Command;
  let mockClient: any;

  function expectSearch(body: unknown): void {
    expect(mockClient.post).toHaveBeenCalledWith(
      'search',
      body,
      undefined,
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
    const { registerSearchCommand } = await import('../../src/commands/search');
    program = new Command();
    registerSearchCommand(program);
  });

  describe('Basic search', () => {
    it('should search without query', async () => {
      mockClient.post.mockResolvedValue(mockSearchResult);

      await program.parseAsync(['node', 'test', 'search']);

      expectSearch({
        page_size: 10,
      });
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Test Page'));
    });

    it('should search with query', async () => {
      mockClient.post.mockResolvedValue(mockSearchResult);

      await program.parseAsync(['node', 'test', 'search', 'test query']);

      expectSearch({
        query: 'test query',
        page_size: 10,
      });
    });

    it('should display empty results message', async () => {
      mockClient.post.mockResolvedValue(createPaginatedResult([]));

      await program.parseAsync(['node', 'test', 'search']);

      expect(console.log).toHaveBeenCalledWith('No results found.');
    });
  });

  describe('Filtering', () => {
    it('should filter by page type', async () => {
      mockClient.post.mockResolvedValue(mockSearchResult);

      await program.parseAsync(['node', 'test', 'search', '--type', 'page']);

      expectSearch({
        filter: { property: 'object', value: 'page' },
        page_size: 10,
      });
    });

    it('should filter by database type', async () => {
      mockClient.post.mockResolvedValue(mockSearchResult);

      await program.parseAsync(['node', 'test', 'search', '--type', 'database']);

      expectSearch({
        filter: { property: 'object', value: 'data_source' },
        page_size: 10,
      });
    });
  });

  describe('Sorting', () => {
    it('should sort ascending', async () => {
      mockClient.post.mockResolvedValue(mockSearchResult);

      await program.parseAsync(['node', 'test', 'search', '--sort', 'asc']);

      expectSearch({
        sort: {
          direction: 'asc',
          timestamp: 'last_edited_time',
        },
        page_size: 10,
      });
    });

    it('should sort descending', async () => {
      mockClient.post.mockResolvedValue(mockSearchResult);

      await program.parseAsync(['node', 'test', 'search', '--sort', 'desc']);

      expectSearch({
        sort: {
          direction: 'desc',
          timestamp: 'last_edited_time',
        },
        page_size: 10,
      });
    });
  });

  describe('Pagination', () => {
    it('should limit results', async () => {
      mockClient.post.mockResolvedValue(mockSearchResult);

      await program.parseAsync(['node', 'test', 'search', '--limit', '50']);

      expectSearch({
        page_size: 50,
      });
    });

    it('should use cursor for pagination', async () => {
      mockClient.post.mockResolvedValue(mockSearchResult);

      await program.parseAsync(['node', 'test', 'search', '--cursor', 'cursor-123']);

      expectSearch({
        page_size: 10,
        start_cursor: 'cursor-123',
      });
    });

    it('should show pagination hint when has_more is true', async () => {
      mockClient.post.mockResolvedValue({
        results: [createMockPage('page-1', 'Page 1')],
        has_more: true,
        next_cursor: 'next-cursor-123',
      });

      await program.parseAsync(['node', 'test', 'search']);

      expect(console.error).toHaveBeenCalledWith('More results are available.');
    });
  });

  describe('Output formats', () => {
    it('should output JSON when --json flag is used', async () => {
      mockClient.post.mockResolvedValue(mockSearchResult);

      await program.parseAsync(['node', 'test', 'search', '--json']);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"results"'));
    });

    it('should format pages with icon', async () => {
      const result = createPaginatedResult([
        createMockPage('page-1', 'My Page'),
      ]);

      mockClient.post.mockResolvedValue(result);

      await program.parseAsync(['node', 'test', 'search']);

      expect(console.log).toHaveBeenCalledWith('[page] page-1 My Page');
    });

    it('should format databases with icon', async () => {
      const result = createPaginatedResult([
        createMockDatabase('db-1', 'My Database'),
      ]);

      mockClient.post.mockResolvedValue(result);

      await program.parseAsync(['node', 'test', 'search']);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[db]'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('My Database'));
    });

    it('should display URL when available', async () => {
      const page = createMockPage('page-1', 'My Page');
      page.url = 'https://notion.so/page-1';
      const result = createPaginatedResult([page]);

      mockClient.post.mockResolvedValue(result);

      await program.parseAsync(['node', 'test', 'search']);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('page-1'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('My Page'));
    });
  });

  describe('Error handling', () => {
    it('should handle API errors', async () => {
      mockClient.post.mockRejectedValue(new Error('API Error: Rate limited'));

      await expect(
        program.parseAsync(['node', 'test', 'search'])
      ).rejects.toThrow('API Error: Rate limited');
    });
  });

  describe('--first flag', () => {
    it('should return only the first result', async () => {
      const result = createPaginatedResult([
        createMockPage('page-1', 'First'),
        createMockPage('page-2', 'Second'),
      ]);
      mockClient.post.mockResolvedValue(result);

      await program.parseAsync(['node', 'test', 'search', 'test', '--first']);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('First'));
      expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Second'));
    });

    it('should mark failure without abruptly terminating when --first has no result', async () => {
      mockClient.post.mockResolvedValue(createPaginatedResult([]));

      await program.parseAsync(['node', 'test', 'search', 'nonexistent', '--first']);

      expect(process.exit).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(console.error).toHaveBeenCalledWith('No matching result found.');
      process.exitCode = undefined;
    });

    it('should output single object in JSON mode with --first', async () => {
      const result = createPaginatedResult([createMockPage('page-1', 'Only')]);
      mockClient.post.mockResolvedValue(result);

      await program.parseAsync(['node', 'test', 'search', 'test', '--first', '--json']);

      const output = (console.log as any).mock.calls[0][0];
      const parsed = JSON.parse(output);
      expect(parsed.id).toBe('page-1');
      expect(parsed.object).toBe('page');
    });
  });

  describe('--exact flag', () => {
    it('should require an explicit title query', async () => {
      await expect(program.parseAsync(['node', 'test', 'search', '--exact']))
        .rejects.toThrow('--exact requires a search query.');

      expect(mockClient.post).not.toHaveBeenCalled();
    });

    it('should filter to exact title matches only', async () => {
      const page1 = createMockPage('page-1', 'Project Alpha');
      const page2 = createMockPage('page-2', 'Project Alpha Beta');
      mockClient.post.mockResolvedValue(createPaginatedResult([page1, page2]));

      await program.parseAsync(['node', 'test', 'search', 'Project Alpha', '--exact']);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Project Alpha'));
      expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Beta'));
    });

    it('should be case-insensitive for exact matching', async () => {
      const page1 = createMockPage('page-1', 'My Task');
      mockClient.post.mockResolvedValue(createPaginatedResult([page1]));

      await program.parseAsync(['node', 'test', 'search', 'my task', '--exact']);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('My Task'));
    });

    it('should scan exact --first discovery in full search pages', async () => {
      const nonMatch = createMockPage('page-1', 'Other');
      const match = createMockPage('page-2', 'Target');
      mockClient.post
        .mockResolvedValueOnce({ results: [nonMatch], has_more: true, next_cursor: 'next-1' })
        .mockResolvedValueOnce({ results: [match], has_more: false, next_cursor: null });

      await program.parseAsync(['node', 'test', 'search', 'Target', '--exact', '--first']);

      expect(mockClient.post).toHaveBeenNthCalledWith(1, 'search', {
        query: 'Target',
        page_size: 100,
      }, undefined, { retrySafe: true });
      expect(mockClient.post).toHaveBeenNthCalledWith(2, 'search', {
        query: 'Target',
        page_size: 100,
        start_cursor: 'next-1',
      }, undefined, { retrySafe: true });
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Target'));
    });

    it('should reject a repeated cursor while scanning exact matches', async () => {
      mockClient.post.mockResolvedValue({
        results: [createMockPage('page-1', 'Other')],
        has_more: true,
        next_cursor: 'stuck-cursor',
      });

      await expect(program.parseAsync([
        'node', 'test', 'search', 'Target', '--exact', '--limit', '2',
      ])).rejects.toThrow('repeated pagination cursor stuck-cursor');

      expect(mockClient.post).toHaveBeenCalledTimes(2);
    });
  });

  describe('compact format (default)', () => {
    it('should output compact format', async () => {
      const result = createPaginatedResult([
        createMockPage('page-1', 'Task One'),
        createMockPage('page-2', 'Task Two'),
      ]);
      mockClient.post.mockResolvedValue(result);

      await program.parseAsync(['node', 'test', 'search', 'task']);

      expect(console.log).toHaveBeenCalledWith('[page] page-1 Task One');
      expect(console.log).toHaveBeenCalledWith('[page] page-2 Task Two');
    });

    it('should show db type for databases', async () => {
      const result = createPaginatedResult([createMockDatabase('db-1', 'My DB')]);
      mockClient.post.mockResolvedValue(result);

      await program.parseAsync(['node', 'test', 'search', 'db']);

      expect(console.log).toHaveBeenCalledWith('[db] db-1 My DB');
    });
  });

  describe('Combined options', () => {
    it('should handle multiple options together', async () => {
      mockClient.post.mockResolvedValue(mockSearchResult);

      await program.parseAsync([
        'node', 'test', 'search', 'my query',
        '--type', 'page',
        '--sort', 'desc',
        '--limit', '25',
      ]);

      expectSearch({
        query: 'my query',
        filter: { property: 'object', value: 'page' },
        sort: {
          direction: 'desc',
          timestamp: 'last_edited_time',
        },
        page_size: 25,
      });
    });
  });
});
