import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Command } from 'commander';
import { mockPage, mockDatabase, setupDatabaseResolution } from '../fixtures/notion-data';

const mockMarkdownResponse = {
  object: 'page_markdown',
  id: 'page-123',
  markdown: 'This is a test paragraph.\n\n# Test Heading\n',
  truncated: false,
  unknown_block_ids: [],
};

describe('Pages Command', () => {
  let program: Command;
  let mockClient: any;
  let mockFS: Map<string | number, string>;

  beforeEach(async () => {
    vi.resetModules();
    mockFS = new Map();

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

    // Mock fs module (needed for page write/edit commands)
    vi.doMock('fs', () => ({
      readFileSync: vi.fn((path: string | number) => {
        if (mockFS.has(path)) {
          return mockFS.get(path);
        }
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }),
      existsSync: vi.fn((path: string) => mockFS.has(path)),
      writeFileSync: vi.fn(),
    }));

    // Import command and register it
    const { registerPagesCommand } = await import('../../src/commands/pages');
    program = new Command();
    registerPagesCommand(program);
  });

  describe('page get', () => {
    it('should get page by ID', async () => {
      mockClient.get.mockResolvedValue(mockPage);

      await program.parseAsync(['node', 'test', 'page', 'get', 'page-123']);

      expect(mockClient.get).toHaveBeenCalledWith('pages/page-123');
      expect(console.log).toHaveBeenCalledWith('Test Page');
      expect(console.log).toHaveBeenCalledWith('ID:', 'page-123');
    });

    it('should get page with content', async () => {
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      mockClient.get.mockResolvedValueOnce(mockPage).mockResolvedValueOnce(mockMarkdownResponse);

      await program.parseAsync(['node', 'test', 'page', 'get', 'page-123', '--content']);

      expect(mockClient.get).toHaveBeenCalledWith('pages/page-123');
      expect(mockClient.get).toHaveBeenCalledWith('pages/page-123/markdown', {});
      expect(console.log).toHaveBeenCalledWith('Page:', 'Test Page');
      expect(console.log).toHaveBeenCalledWith('ID:', 'page-123');
      expect(stdoutSpy).toHaveBeenCalledWith(mockMarkdownResponse.markdown);
      stdoutSpy.mockRestore();
    });

    it('should output JSON when --json flag is used', async () => {
      mockClient.get.mockResolvedValue(mockPage);

      await program.parseAsync(['node', 'test', 'page', 'get', 'page-123', '--json']);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"object": "page"'));
    });

    it('should output JSON with content when both --json and --content are used', async () => {
      mockClient.get.mockResolvedValueOnce(mockPage).mockResolvedValueOnce(mockMarkdownResponse);

      await program.parseAsync(['node', 'test', 'page', 'get', 'page-123', '--content', '--json']);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"page"'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"markdown"'));
    });

    it('should reject Markdown-only options without --content before making a request', async () => {
      await expect(program.parseAsync([
        'node', 'test', 'page', 'get', 'page-123', '--include-transcript',
      ])).rejects.toThrow('require --content');

      expect(mockClient.get).not.toHaveBeenCalled();
    });
  });

  describe('page create', () => {
    it('should create page in database with title', async () => {
      const createdPage = { ...mockPage, id: 'new-page-123', url: 'https://notion.so/new-page-123' };
      setupDatabaseResolution(mockClient);
      mockClient.post.mockResolvedValue(createdPage);

      await program.parseAsync([
        'node', 'test', 'page', 'create',
        '--parent', 'db-123',
        '--title', 'New Page',
      ]);

      expect(mockClient.post).toHaveBeenCalledWith('pages', {
        parent: { data_source_id: 'db-123' },
        properties: {
          Name: {
            title: [{ text: { content: 'New Page' } }],
          },
        },
      });

      expect(console.log).toHaveBeenCalledWith('Page created');
      expect(console.log).toHaveBeenCalledWith('ID:', 'new-page-123');
      expect(console.log).toHaveBeenCalledWith('URL:', 'https://notion.so/new-page-123');
    });

    it('should create page under parent page using "title" property key', async () => {
      const createdPage = { ...mockPage, id: 'new-page-123', url: 'https://notion.so/new-page-123' };
      mockClient.post.mockResolvedValue(createdPage);

      await program.parseAsync([
        'node', 'test', 'page', 'create',
        '--parent', 'page-456',
        '--parent-type', 'page',
        '--title', 'Subpage',
      ]);

      // Non-DB pages use 'title' as property key, not 'Name'
      expect(mockClient.post).toHaveBeenCalledWith('pages', {
        parent: { page_id: 'page-456' },
        properties: {
          title: {
            title: [{ text: { content: 'Subpage' } }],
          },
        },
      });
    });

    it('should normalize a Notion URL used as a page parent', async () => {
      const createdPage = { ...mockPage, id: 'new-page-123', url: 'https://notion.so/new-page-123' };
      mockClient.post.mockResolvedValue(createdPage);

      await program.parseAsync([
        'node', 'test', 'page', 'create',
        '--parent', 'https://www.notion.so/Parent-0123456789abcdef0123456789abcdef',
        '--parent-type', 'page',
        '--title', 'Child',
      ]);

      expect(mockClient.post).toHaveBeenCalledWith('pages', expect.objectContaining({
        parent: { page_id: '01234567-89ab-cdef-0123-456789abcdef' },
      }));
    });

    it('should reject an unknown parent type before making API calls', async () => {
      await expect(program.parseAsync([
        'node', 'test', 'page', 'create',
        '--parent', 'parent-1', '--parent-type', 'workspace',
      ])).rejects.toThrow('--parent-type must be either');

      expect(mockClient.get).not.toHaveBeenCalled();
      expect(mockClient.post).not.toHaveBeenCalled();
    });

    it('should auto-detect title property from database schema', async () => {
      const customDb = {
        ...mockDatabase,
        properties: {
          'Task Name': { id: 'task-name', type: 'title', title: {} },
          Status: { id: 'status', type: 'status', status: {} },
        },
      };
      setupDatabaseResolution(mockClient, customDb);

      const createdPage = { ...mockPage, id: 'new-page-123', url: 'https://notion.so/new-page-123' };
      mockClient.post.mockResolvedValue(createdPage);

      await program.parseAsync([
        'node', 'test', 'page', 'create',
        '--parent', 'db-123',
        '--title', 'New Task',
      ]);

      expect(mockClient.get).toHaveBeenCalledWith('data_sources/db-123');
      expect(mockClient.post).toHaveBeenCalledWith('pages', {
        parent: { data_source_id: 'db-123' },
        properties: {
          'Task Name': {
            title: [{ text: { content: 'New Task' } }],
          },
        },
      });
    });

    it('should use custom title property name', async () => {
      const createdPage = { ...mockPage, id: 'new-page-123', url: 'https://notion.so/new-page-123' };
      setupDatabaseResolution(mockClient);
      mockClient.post.mockResolvedValue(createdPage);

      await program.parseAsync([
        'node', 'test', 'page', 'create',
        '--parent', 'db-123',
        '--title', 'New Page',
        '--title-prop', 'Title',
      ]);

      expect(mockClient.post).toHaveBeenCalledWith('pages', {
        parent: { data_source_id: 'db-123' },
        properties: {
          Title: {
            title: [{ text: { content: 'New Page' } }],
          },
        },
      });
    });

    it('should create page with additional properties', async () => {
      const createdPage = { ...mockPage, id: 'new-page-123', url: 'https://notion.so/new-page-123' };
      setupDatabaseResolution(mockClient);
      mockClient.post.mockResolvedValue(createdPage);

      await program.parseAsync([
        'node', 'test', 'page', 'create',
        '--parent', 'db-123',
        '--title', 'New Page',
        '--prop', 'Status=Done',
        '--prop', 'Priority=High',
      ]);

      expect(mockClient.post).toHaveBeenCalledWith('pages', {
        parent: { data_source_id: 'db-123' },
        properties: {
          Name: {
            title: [{ text: { content: 'New Page' } }],
          },
          Status: {
            status: { name: 'Done' },
          },
          Priority: {
            select: { name: 'High' },
          },
        },
      });
    });

    it('should create page with markdown content from file', async () => {
      const createdPage = { ...mockPage, id: 'new-page-123', url: 'https://notion.so/new-page-123' };
      setupDatabaseResolution(mockClient);
      mockClient.post.mockResolvedValue(createdPage);
      mockFS.set('content.md', '# Hello\n\nThis is content.');

      await program.parseAsync([
        'node', 'test', 'page', 'create',
        '--parent', 'db-123',
        '--title', 'New Page',
        '--file', 'content.md',
      ]);

      expect(mockClient.post).toHaveBeenCalledWith('pages', {
        parent: { data_source_id: 'db-123' },
        properties: {
          Name: {
            title: [{ text: { content: 'New Page' } }],
          },
        },
        markdown: '# Hello\n\nThis is content.',
      });
    });

    it('should output JSON when --json flag is used', async () => {
      const createdPage = { ...mockPage, id: 'new-page-123' };
      setupDatabaseResolution(mockClient);
      mockClient.post.mockResolvedValue(createdPage);

      await program.parseAsync([
        'node', 'test', 'page', 'create',
        '--parent', 'db-123',
        '--title', 'New Page',
        '--json',
      ]);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"object": "page"'));
    });

    it('should create page with emoji icon', async () => {
      const createdPage = { ...mockPage, id: 'new-page-123', url: 'https://notion.so/new-page-123' };
      setupDatabaseResolution(mockClient);
      mockClient.post.mockResolvedValue(createdPage);

      await program.parseAsync([
        'node', 'test', 'page', 'create',
        '--parent', 'db-123',
        '--title', 'New Page',
        '--icon', '📝',
      ]);

      expect(mockClient.post).toHaveBeenCalledWith('pages', expect.objectContaining({
        icon: { type: 'emoji', emoji: '📝' },
      }));
    });
  });

  describe('page update', () => {
    it('should update page properties', async () => {
      const updatedPage = { ...mockPage, id: 'page-123' };
      mockClient.get.mockResolvedValueOnce(mockPage);
      setupDatabaseResolution(mockClient);
      mockClient.patch.mockResolvedValue(updatedPage);

      await program.parseAsync([
        'node', 'test', 'page', 'update', 'page-123',
        '--prop', 'Status=Done',
        '--prop', 'Priority=High',
      ]);

      expect(mockClient.patch).toHaveBeenCalledWith('pages/page-123', {
        properties: {
          Status: {
            status: { name: 'Done' },
          },
          Priority: {
            select: { name: 'High' },
          },
        },
      });

      expect(console.log).toHaveBeenCalledWith('Page updated');
      expect(console.log).toHaveBeenCalledWith('ID:', 'page-123');
    });

    it('should archive page with --archive flag', async () => {
      const updatedPage = { ...mockPage, id: 'page-123', archived: true };
      mockClient.patch.mockResolvedValue(updatedPage);

      await program.parseAsync([
        'node', 'test', 'page', 'update', 'page-123',
        '--archive',
      ]);

      expect(mockClient.patch).toHaveBeenCalledWith('pages/page-123', {
        in_trash: true,
      });
    });

    it('should unarchive page with --unarchive flag', async () => {
      const updatedPage = { ...mockPage, id: 'page-123', in_trash: false };
      mockClient.patch.mockResolvedValue(updatedPage);

      await program.parseAsync([
        'node', 'test', 'page', 'update', 'page-123',
        '--unarchive',
      ]);

      expect(mockClient.patch).toHaveBeenCalledWith('pages/page-123', {
        in_trash: false,
      });
    });

    it('should reject conflicting archive flags', async () => {
      await expect(program.parseAsync([
        'node', 'test', 'page', 'update', 'page-123', '--archive', '--unarchive',
      ])).rejects.toThrow('--archive and --unarchive cannot be used together');

      expect(mockClient.patch).not.toHaveBeenCalled();
    });

    it('should reject a no-op update', async () => {
      await expect(
        program.parseAsync(['node', 'test', 'page', 'update', 'page-123'])
      ).rejects.toThrow('No page updates specified');

      expect(mockClient.patch).not.toHaveBeenCalled();
    });

    it('should update properties and archive together', async () => {
      const updatedPage = { ...mockPage, id: 'page-123', in_trash: true };
      mockClient.get.mockResolvedValueOnce(mockPage);
      setupDatabaseResolution(mockClient);
      mockClient.patch.mockResolvedValue(updatedPage);

      await program.parseAsync([
        'node', 'test', 'page', 'update', 'page-123',
        '--prop', 'Status=Done',
        '--archive',
      ]);

      expect(mockClient.patch).toHaveBeenCalledWith('pages/page-123', {
        properties: {
          Status: {
            status: { name: 'Done' },
          },
        },
        in_trash: true,
      });
    });

    it('should output JSON when --json flag is used', async () => {
      const updatedPage = { ...mockPage, id: 'page-123' };
      mockClient.get.mockResolvedValueOnce(mockPage);
      setupDatabaseResolution(mockClient);
      mockClient.patch.mockResolvedValue(updatedPage);

      await program.parseAsync([
        'node', 'test', 'page', 'update', 'page-123',
        '--prop', 'Status=Done',
        '--json',
      ]);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"object": "page"'));
    });

    it('should update page icon', async () => {
      mockClient.patch.mockResolvedValue({ ...mockPage, id: 'page-123' });

      await program.parseAsync([
        'node', 'test', 'page', 'update', 'page-123',
        '--icon', '🚀',
      ]);

      expect(mockClient.patch).toHaveBeenCalledWith('pages/page-123', {
        icon: { type: 'emoji', emoji: '🚀' },
      });
    });

    it('should update icon together with properties', async () => {
      mockClient.get.mockResolvedValueOnce(mockPage);
      setupDatabaseResolution(mockClient);
      mockClient.patch.mockResolvedValue({ ...mockPage, id: 'page-123' });

      await program.parseAsync([
        'node', 'test', 'page', 'update', 'page-123',
        '--prop', 'Status=Done',
        '--icon', '✅',
      ]);

      expect(mockClient.patch).toHaveBeenCalledWith('pages/page-123', {
        properties: { Status: { status: { name: 'Done' } } },
        icon: { type: 'emoji', emoji: '✅' },
      });
    });

    it('should rename title by auto-detecting title property from parent database', async () => {
      // First call: get page (to find parent DB), then resolver: discovery + schema
      mockClient.get.mockResolvedValueOnce(mockPage);
      setupDatabaseResolution(mockClient);
      mockClient.patch.mockResolvedValue({ ...mockPage, id: 'page-123' });

      await program.parseAsync([
        'node', 'test', 'page', 'update', 'page-123',
        '--title', 'Renamed Page',
      ]);

      expect(mockClient.get).toHaveBeenCalledWith('pages/page-123');
      expect(mockClient.get).toHaveBeenCalledWith('data_sources/ds-456');
      expect(mockClient.patch).toHaveBeenCalledWith('pages/page-123', {
        properties: {
          Name: { title: [{ text: { content: 'Renamed Page' } }] },
        },
      });
    });

    it('should rename title using "title" property key when page has non-DB parent', async () => {
      // Page whose parent is another page, not a database
      const nonDbPage = { ...mockPage, parent: { type: 'page_id', page_id: 'parent-page-456' } };
      mockClient.get.mockResolvedValueOnce(nonDbPage);
      mockClient.patch.mockResolvedValue({ ...nonDbPage, id: 'page-123' });

      await program.parseAsync([
        'node', 'test', 'page', 'update', 'page-123',
        '--title', 'Renamed Subpage',
      ]);

      expect(mockClient.get).toHaveBeenCalledWith('pages/page-123');
      // Should NOT fetch DB schema (no database_id to resolve)
      expect(mockClient.get).toHaveBeenCalledTimes(1);
      // Non-DB pages use 'title' as property key, not 'Name'
      expect(mockClient.patch).toHaveBeenCalledWith('pages/page-123', {
        properties: {
          title: { title: [{ text: { content: 'Renamed Subpage' } }] },
        },
      });
    });

    it('should not hide page lookup failures while resolving the title schema', async () => {
      mockClient.get.mockRejectedValueOnce(new Error('Network error'));
      mockClient.patch.mockResolvedValue({ ...mockPage, id: 'page-123' });

      await expect(program.parseAsync([
          'node', 'test', 'page', 'update', 'page-123',
          '--title', 'Renamed Page',
        ])).rejects.toThrow('Network error');

      expect(mockClient.patch).not.toHaveBeenCalled();
    });

    it('should rename title using explicit --title-prop without fetching schema', async () => {
      mockClient.patch.mockResolvedValue({ ...mockPage, id: 'page-123' });

      await program.parseAsync([
        'node', 'test', 'page', 'update', 'page-123',
        '--title', 'Renamed Page',
        '--title-prop', 'Task Name',
      ]);

      // Should NOT fetch page or DB when --title-prop is provided
      expect(mockClient.get).not.toHaveBeenCalled();
      expect(mockClient.patch).toHaveBeenCalledWith('pages/page-123', {
        properties: {
          'Task Name': { title: [{ text: { content: 'Renamed Page' } }] },
        },
      });
    });

    it('should rename title together with other properties', async () => {
      mockClient.get.mockResolvedValueOnce(mockPage);
      setupDatabaseResolution(mockClient);
      mockClient.patch.mockResolvedValue({ ...mockPage, id: 'page-123' });

      await program.parseAsync([
        'node', 'test', 'page', 'update', 'page-123',
        '--title', 'Renamed Page',
        '--prop', 'Status=Done',
      ]);

      expect(mockClient.patch).toHaveBeenCalledWith('pages/page-123', {
        properties: {
          Name: { title: [{ text: { content: 'Renamed Page' } }] },
          Status: { status: { name: 'Done' } },
        },
      });
    });
  });

  describe('page archive', () => {
    it('should archive page', async () => {
      mockClient.patch.mockResolvedValue({ ...mockPage, in_trash: true });

      await program.parseAsync(['node', 'test', 'page', 'archive', 'page-123']);

      expect(mockClient.patch).toHaveBeenCalledWith('pages/page-123', {
        in_trash: true,
      });

      expect(console.log).toHaveBeenCalledWith('Page archived');
    });
  });

  describe('page property', () => {
    it('should get specific page property', async () => {
      const property = {
        object: 'property_item',
        id: 'prop-123',
        type: 'rollup',
        rollup: { type: 'array', array: [{ type: 'number', number: 42 }] },
      };

      mockClient.get.mockResolvedValue(property);

      await program.parseAsync(['node', 'test', 'page', 'property', 'page-123', 'prop-123']);

      expect(mockClient.get).toHaveBeenCalledWith('pages/page-123/properties/prop-123', {
        page_size: 100,
      });
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"property_item"'));
    });

    it('should output JSON when --json flag is used', async () => {
      const property = { object: 'property_item', id: 'prop-123', type: 'title' };

      mockClient.get.mockResolvedValue(property);

      await program.parseAsync(['node', 'test', 'page', 'property', 'page-123', 'prop-123', '--json']);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"object": "property_item"'));
    });

    it('should decode API property IDs once and fetch every property-item page', async () => {
      mockClient.get
        .mockResolvedValueOnce({
          object: 'list',
          results: [{ id: 'one' }],
          has_more: true,
          next_cursor: 'cursor-2',
        })
        .mockResolvedValueOnce({
          object: 'list',
          results: [{ id: 'two' }],
          has_more: false,
          next_cursor: null,
        });

      await program.parseAsync([
        'node', 'test', 'page', 'property', 'page-123', 'f%5C%5C%3Ap', '--all', '--json',
      ]);

      expect(mockClient.get).toHaveBeenNthCalledWith(
        1,
        'pages/page-123/properties/f%5C%5C%3Ap',
        { page_size: 100 },
      );
      expect(mockClient.get).toHaveBeenNthCalledWith(
        2,
        'pages/page-123/properties/f%5C%5C%3Ap',
        { page_size: 100, start_cursor: 'cursor-2' },
      );
      const output = JSON.parse(vi.mocked(console.log).mock.calls[0][0] as string);
      expect(output).toMatchObject({
        results: [{ id: 'one' }, { id: 'two' }],
        has_more: false,
        next_cursor: null,
      });
    });

    it('should preserve the terminal rollup metadata when aggregating property pages', async () => {
      mockClient.get
        .mockResolvedValueOnce({
          object: 'list',
          results: [{ id: 'one' }],
          has_more: true,
          next_cursor: 'cursor-2',
          property_item: { type: 'rollup', rollup: { type: 'incomplete' }, next_url: 'temporary' },
        })
        .mockResolvedValueOnce({
          object: 'list',
          results: [{ id: 'two' }],
          has_more: false,
          next_cursor: null,
          property_item: { type: 'rollup', rollup: { type: 'number', number: 2 }, next_url: null },
        });

      await program.parseAsync([
        'node', 'test', 'page', 'property', 'page-123', 'rollup-id', '--all', '--json',
      ]);

      const output = JSON.parse(vi.mocked(console.log).mock.calls[0][0] as string);
      expect(output.property_item).toEqual({
        type: 'rollup',
        rollup: { type: 'number', number: 2 },
        next_url: null,
      });
    });

    it('should reject a repeated property-item cursor', async () => {
      mockClient.get.mockResolvedValue({
        object: 'list',
        results: [],
        has_more: true,
        next_cursor: 'stuck-cursor',
      });

      await expect(program.parseAsync([
        'node', 'test', 'page', 'property', 'page-123', 'prop-123', '--all',
      ])).rejects.toThrow('repeated property-item cursor stuck-cursor');

      expect(mockClient.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('Error handling', () => {
    it('should handle get errors', async () => {
      mockClient.get.mockRejectedValue(new Error('Page not found'));

      await expect(
        program.parseAsync(['node', 'test', 'page', 'get', 'invalid-id'])
      ).rejects.toThrow('Page not found');
    });

    it('should handle create errors', async () => {
      mockClient.get.mockRejectedValue(new Error('Invalid parent'));

      await expect(
        program.parseAsync([
          'node', 'test', 'page', 'create',
          '--parent', 'invalid-id',
          '--title', 'New Page',
        ])
      ).rejects.toThrow('Invalid parent');
    });

    it('should handle update errors', async () => {
      mockClient.get.mockResolvedValueOnce(mockPage);
      setupDatabaseResolution(mockClient);
      mockClient.patch.mockRejectedValue(new Error('Permission denied'));

      await expect(
        program.parseAsync([
          'node', 'test', 'page', 'update', 'page-123',
          '--prop', 'Status:status=Done',
        ])
      ).rejects.toThrow('Permission denied');
    });

    it('should handle archive errors', async () => {
      mockClient.patch.mockRejectedValue(new Error('Already archived'));

      await expect(
        program.parseAsync(['node', 'test', 'page', 'archive', 'page-123'])
      ).rejects.toThrow('Already archived');
    });

    it('should handle property errors', async () => {
      mockClient.get.mockRejectedValue(new Error('Property not found'));

      await expect(
        program.parseAsync(['node', 'test', 'page', 'property', 'page-123', 'invalid-prop'])
      ).rejects.toThrow('Property not found');
    });
  });

  describe('page read', () => {
    it('should write the native Markdown verbatim without a synthetic title', async () => {
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      mockClient.get.mockResolvedValueOnce(mockMarkdownResponse);

      await program.parseAsync(['node', 'test', 'page', 'read', 'page-123']);

      expect(mockClient.get).toHaveBeenCalledWith('pages/page-123/markdown', {});
      expect(mockClient.get).toHaveBeenCalledTimes(1);

      const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
      expect(output).toBe(mockMarkdownResponse.markdown);

      stdoutSpy.mockRestore();
    });

    it('should output the native response metadata with --json', async () => {
      mockClient.get.mockResolvedValueOnce(mockMarkdownResponse);

      await program.parseAsync(['node', 'test', 'page', 'read', 'page-123', '--json']);

      const output = vi.mocked(console.log).mock.calls[0][0] as string;
      expect(JSON.parse(output)).toEqual(mockMarkdownResponse);
    });

    it('should normalize a Notion page URL before reading', async () => {
      mockClient.get.mockResolvedValueOnce(mockMarkdownResponse);

      await program.parseAsync([
        'node', 'test', 'page', 'read',
        'https://www.notion.so/Test-0123456789abcdef0123456789abcdef?pvs=4',
        '--json',
      ]);

      expect(mockClient.get).toHaveBeenCalledWith(
        'pages/01234567-89ab-cdef-0123-456789abcdef/markdown',
        {},
      );
    });

    it('should request meeting transcripts only when explicitly enabled', async () => {
      mockClient.get.mockResolvedValueOnce(mockMarkdownResponse);

      await program.parseAsync([
        'node', 'test', 'page', 'read', 'page-123', '--include-transcript', '--json',
      ]);

      expect(mockClient.get).toHaveBeenCalledWith('pages/page-123/markdown', {
        include_transcript: 'true',
      });
    });

    it('should fail by default before emitting incomplete Markdown', async () => {
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      mockClient.get.mockResolvedValueOnce({
        ...mockMarkdownResponse,
        truncated: true,
        unknown_block_ids: ['block-1'],
      });

      await expect(
        program.parseAsync(['node', 'test', 'page', 'read', 'page-123'])
      ).rejects.toThrow('Incomplete Markdown response');

      expect(stdoutSpy).not.toHaveBeenCalled();
      stdoutSpy.mockRestore();
    });

    it('should emit incomplete Markdown only with explicit opt-in', async () => {
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      mockClient.get.mockResolvedValueOnce({ ...mockMarkdownResponse, truncated: true });

      await program.parseAsync([
        'node', 'test', 'page', 'read', 'page-123', '--allow-incomplete',
      ]);

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('truncated'));
      expect(stdoutSpy).toHaveBeenCalledWith(mockMarkdownResponse.markdown);
      stdoutSpy.mockRestore();
    });

    it('should handle read errors', async () => {
      mockClient.get.mockRejectedValue(new Error('Page not found'));

      await expect(
        program.parseAsync(['node', 'test', 'page', 'read', 'page-123'])
      ).rejects.toThrow('Page not found');
    });
  });

  describe('page replace', () => {
    it('should replace the complete page body from a file with safe deletion defaults', async () => {
      mockFS.set('replacement.md', '# Replacement\n');
      mockClient.patch.mockResolvedValue({
        ...mockMarkdownResponse,
        markdown: '# Replacement\n',
      });

      await program.parseAsync([
        'node', 'test', 'page', 'replace', 'page-123',
        '--file', 'replacement.md',
      ]);

      expect(mockClient.patch).toHaveBeenCalledWith('pages/page-123/markdown', {
        type: 'replace_content',
        replace_content: {
          new_str: '# Replacement\n',
          allow_deleting_content: false,
        },
      });
      expect(console.log).toHaveBeenCalledWith('Page content replaced');
    });

    it('should read replacement Markdown from stdin with --file -', async () => {
      mockFS.set(0, 'Piped content\n');
      mockClient.patch.mockResolvedValue({
        ...mockMarkdownResponse,
        markdown: 'Piped content\n',
      });

      await program.parseAsync([
        'node', 'test', 'page', 'replace', 'page-123', '--file', '-', '--json',
      ]);

      expect(mockClient.patch).toHaveBeenCalledWith('pages/page-123/markdown', {
        type: 'replace_content',
        replace_content: {
          new_str: 'Piped content\n',
          allow_deleting_content: false,
        },
      });
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"page_markdown"'));
    });

    it('should consume non-empty piped stdin without requiring --file', async () => {
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
      mockFS.set(0, 'Implicit piped content\n');
      mockClient.patch.mockResolvedValue({
        ...mockMarkdownResponse,
        markdown: 'Implicit piped content\n',
      });

      await program.parseAsync(['node', 'test', 'page', 'replace', 'page-123']);

      expect(mockClient.patch).toHaveBeenCalledWith('pages/page-123/markdown', {
        type: 'replace_content',
        replace_content: {
          new_str: 'Implicit piped content\n',
          allow_deleting_content: false,
        },
      });
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    });

    it('should reject temporary signed media before replacing content', async () => {
      mockFS.set('signed.md', '![asset](https://s3.example.test/a.png?X-Amz-Signature=abc)');

      await expect(program.parseAsync([
        'node', 'test', 'page', 'replace', 'page-123', '--file', 'signed.md',
      ])).rejects.toThrow('temporary');

      expect(mockClient.patch).not.toHaveBeenCalled();
    });

    it('should allow temporary signed media only with explicit opt-in', async () => {
      const markdown = '![asset](https://s3.example.test/a.png?X-Amz-Signature=abc)';
      mockFS.set('signed.md', markdown);
      mockClient.patch.mockResolvedValue({ ...mockMarkdownResponse, markdown });

      await program.parseAsync([
        'node', 'test', 'page', 'replace', 'page-123', '--file', 'signed.md',
        '--allow-temporary-media',
      ]);

      expect(mockClient.patch).toHaveBeenCalledWith('pages/page-123/markdown', expect.objectContaining({
        replace_content: expect.objectContaining({ new_str: markdown }),
      }));
    });

    it('should require an explicit input source when stdin is interactive', async () => {
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

      await expect(
        program.parseAsync(['node', 'test', 'page', 'replace', 'page-123'])
      ).rejects.toThrow('No Markdown input');

      expect(mockClient.patch).not.toHaveBeenCalled();
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    });

    it('should require confirmation before clearing all page content', async () => {
      mockFS.set('empty.md', '');

      await expect(program.parseAsync([
        'node', 'test', 'page', 'replace', 'page-123', '--file', 'empty.md',
      ])).rejects.toThrow('--allow-empty');

      expect(mockClient.patch).not.toHaveBeenCalled();
    });
  });


  describe('page edit', () => {
    const existingMarkdown = {
      object: 'page_markdown',
      id: 'page-123',
      markdown: '# Title\nPara 1\nPara 2\nPara 3',
      truncated: false,
      unknown_block_ids: [],
    };

    const mockUpdateResponse = {
      object: 'page_markdown',
      id: 'page-123',
      markdown: '# Title\nReplaced\nPara 2\nPara 3',
      truncated: false,
      unknown_block_ids: [],
    };

    it('should search and replace text via update_content', async () => {
      mockClient.patch.mockResolvedValue(mockUpdateResponse);

      await program.parseAsync([
        'node', 'test', 'page', 'edit', 'page-123',
        '--search', 'Para 1',
        '--replace', 'Replaced',
      ]);

      expect(mockClient.patch).toHaveBeenCalledWith('pages/page-123/markdown', {
        type: 'update_content',
        update_content: {
          content_updates: [{
            old_str: 'Para 1',
            new_str: 'Replaced',
            replace_all_matches: false,
          }],
          allow_deleting_content: false,
        },
      });
      expect(console.log).toHaveBeenCalledWith('Page updated');
    });

    it('should replace all matches with --all', async () => {
      mockClient.patch.mockResolvedValue(mockUpdateResponse);

      await program.parseAsync([
        'node', 'test', 'page', 'edit', 'page-123',
        '--search', 'Para',
        '--replace', 'Line',
        '--all',
      ]);

      expect(mockClient.patch).toHaveBeenCalledWith('pages/page-123/markdown', {
        type: 'update_content',
        update_content: {
          content_updates: [{
            old_str: 'Para',
            new_str: 'Line',
            replace_all_matches: true,
          }],
          allow_deleting_content: false,
        },
      });
    });

    it('should show dry run for edit', async () => {
      mockClient.get.mockResolvedValueOnce(existingMarkdown);

      await program.parseAsync([
        'node', 'test', 'page', 'edit', 'page-123',
        '--search', 'Para 1',
        '--replace', 'New content',
        '--dry-run',
      ]);

      expect(mockClient.patch).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('1 match'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Dry run'));
    });

    it('should emit a structured JSON dry run', async () => {
      mockClient.get.mockResolvedValueOnce(existingMarkdown);

      await program.parseAsync([
        'node', 'test', 'page', 'edit', 'page-123',
        '--search', 'Para 1',
        '--replace', 'New content',
        '--dry-run',
        '--json',
      ]);

      const output = JSON.parse(vi.mocked(console.log).mock.calls[0][0] as string);
      expect(output).toEqual(expect.objectContaining({
        dry_run: true,
        page_id: 'page-123',
        match_count: 1,
        would_succeed: true,
      }));
      expect(mockClient.patch).not.toHaveBeenCalled();
    });

    it('should output JSON with --json', async () => {
      mockClient.patch.mockResolvedValue(mockUpdateResponse);

      await program.parseAsync([
        'node', 'test', 'page', 'edit', 'page-123',
        '--search', 'Para 1',
        '--replace', 'Replaced',
        '--json',
      ]);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('"page_markdown"')
      );
    });
  });
});
