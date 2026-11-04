import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Command } from 'commander';
import { mockDatabase, mockPage, createPaginatedResult, setupDatabaseResolution } from '../fixtures/notion-data';

describe('Database List and Schema Commands', () => {
  let program: Command;
  let mockClient: any;

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

  describe('db list', () => {
    it('should list indexed data sources', async () => {
      mockClient.post.mockResolvedValue(createPaginatedResult([
        mockDatabase,
        { ...mockDatabase, id: 'db-456', title: [{ plain_text: 'Second Database' }] },
      ]));

      await program.parseAsync(['node', 'test', 'database', 'list']);

      expect(mockClient.post).toHaveBeenCalledWith('search', expect.objectContaining({
        filter: { property: 'object', value: 'data_source' },
        page_size: 20,
      }), undefined, { retrySafe: true });
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Found 2 indexed data source(s)'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Test Database'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Second Database'));
    });

    it('should respect --limit option', async () => {
      mockClient.post.mockResolvedValue(createPaginatedResult([mockDatabase]));

      await program.parseAsync(['node', 'test', 'database', 'list', '--limit', '5']);

      expect(mockClient.post).toHaveBeenCalledWith('search', expect.objectContaining({
        page_size: 5,
      }), undefined, { retrySafe: true });
    });

    it('should show compact output with --compact', async () => {
      mockClient.post.mockResolvedValue(createPaginatedResult([mockDatabase]));

      await program.parseAsync(['node', 'test', 'database', 'list', '--compact']);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Test Database'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('db-123'));
    });

    it('should output JSON with --json', async () => {
      mockClient.post.mockResolvedValue(createPaginatedResult([mockDatabase]));

      await program.parseAsync(['node', 'test', 'database', 'list', '--json']);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"id": "db-123"'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"properties"'));
    });

    it('should show count in output', async () => {
      mockClient.post.mockResolvedValue(createPaginatedResult([
        mockDatabase,
        { ...mockDatabase, id: 'db-456' },
      ]));

      await program.parseAsync(['node', 'test', 'database', 'list']);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Found 2 indexed data source(s)'));
    });

    it('should handle no databases found', async () => {
      mockClient.post.mockResolvedValue(createPaginatedResult([]));

      await program.parseAsync(['node', 'test', 'database', 'list']);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Found 0 indexed data source(s)'));
    });

    it('should show [multi-source] tag for databases with data_sources', async () => {
      const multiSourceDb = {
        ...mockDatabase,
        id: 'db-multi',
        title: [{ plain_text: 'Multi Source DB' }],
        data_sources: [
          { id: 'ds-aaa', name: 'Source A' },
          { id: 'ds-bbb', name: 'Source B' },
        ],
      };
      mockClient.post.mockResolvedValue(createPaginatedResult([multiSourceDb]));

      await program.parseAsync(['node', 'test', 'database', 'list']);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[multi-source]'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('ds-aaa'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('ds-bbb'));
    });

    it('should show [multi-source] tag in compact mode', async () => {
      const multiSourceDb = {
        ...mockDatabase,
        id: 'db-multi',
        title: [{ plain_text: 'Multi Source DB' }],
        data_sources: [{ id: 'ds-aaa', name: 'Source A' }, { id: 'ds-bbb', name: 'Source B' }],
      };
      mockClient.post.mockResolvedValue(createPaginatedResult([multiSourceDb]));

      await program.parseAsync(['node', 'test', 'database', 'list', '--compact']);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Multi Source DB'));
    });

    it('should continue listing when a database has no properties', async () => {
      const dbWithNoProps = {
        object: 'database',
        id: 'db-noprops',
        title: [{ plain_text: 'Broken DB' }],
        properties: undefined,
      };
      const normalDb = { ...mockDatabase, id: 'db-normal', title: [{ plain_text: 'Normal DB' }] };
      mockClient.post.mockResolvedValue(createPaginatedResult([dbWithNoProps, normalDb]));

      await program.parseAsync(['node', 'test', 'database', 'list']);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Found 2'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Normal DB'));
    });

    it('should warn and continue when per-database processing throws', async () => {
      const badDb = {
        object: 'database',
        id: 'db-bad',
        title: [{ plain_text: 'Bad DB' }],
        get properties() { throw new Error('Unexpected error'); },
      };
      const goodDb = { ...mockDatabase, id: 'db-good', title: [{ plain_text: 'Good DB' }] };
      mockClient.post.mockResolvedValue(createPaginatedResult([badDb, goodDb]));

      await program.parseAsync(['node', 'test', 'database', 'list']);

      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('db-bad'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Good DB'));
    });

    it('should not show multi-source indicators for normal databases', async () => {
      mockClient.post.mockResolvedValue(createPaginatedResult([mockDatabase]));

      await program.parseAsync(['node', 'test', 'database', 'list']);

      const logCalls = (console.log as any).mock.calls.flat().join(' ');
      expect(logCalls).not.toContain('[multi-source]');
      expect(logCalls).not.toContain('Data sources:');
    });
  });

  describe('db schema', () => {
    it('should show detailed schema for database', async () => {
      setupDatabaseResolution(mockClient);

      await program.parseAsync(['node', 'test', 'database', 'schema', 'db-123']);

      expect(mockClient.get).toHaveBeenCalledWith('data_sources/db-123');
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Database: Test Database'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('## Properties'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Name'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Status'));
      expect(console.log).toHaveBeenCalledWith('  ID: title');
      expect(console.log).toHaveBeenCalledWith('  ID: status');
    });

    it('should output JSON with --json', async () => {
      setupDatabaseResolution(mockClient);

      await program.parseAsync(['node', 'test', 'database', 'schema', 'db-123', '--json']);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"id": "ds-456"'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"properties"'));
    });

    it('should show select options', async () => {
      const dbWithSelect = {
        ...mockDatabase,
        properties: {
          Priority: {
            id: 'priority',
            name: 'Priority',
            type: 'select',
            select: {
              options: [
                { id: 'opt-1', name: 'High', color: 'red' },
                { id: 'opt-2', name: 'Medium', color: 'yellow' },
                { id: 'opt-3', name: 'Low', color: 'green' },
              ],
            },
          },
        },
      };
      setupDatabaseResolution(mockClient, dbWithSelect);

      await program.parseAsync(['node', 'test', 'database', 'schema', 'db-123']);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Priority'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('High'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Medium'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Low'));
    });

    it('should show multi_select options', async () => {
      const dbWithMultiSelect = {
        ...mockDatabase,
        properties: {
          Tags: {
            id: 'tags',
            name: 'Tags',
            type: 'multi_select',
            multi_select: {
              options: [
                { id: 'tag-1', name: 'Important', color: 'red' },
                { id: 'tag-2', name: 'Urgent', color: 'orange' },
              ],
            },
          },
        },
      };
      setupDatabaseResolution(mockClient, dbWithMultiSelect);

      await program.parseAsync(['node', 'test', 'database', 'schema', 'db-123']);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Tags'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Important'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Urgent'));
    });

    it('should show status options with groups', async () => {
      const dbWithStatus = {
        ...mockDatabase,
        properties: {
          Status: {
            id: 'status',
            name: 'Status',
            type: 'status',
            status: {
              options: [
                { id: 'stat-1', name: 'Not Started', color: 'gray' },
                { id: 'stat-2', name: 'In Progress', color: 'blue' },
                { id: 'stat-3', name: 'Done', color: 'green' },
              ],
              groups: [
                { id: 'grp-1', name: 'To Do', option_ids: ['stat-1'] },
                { id: 'grp-2', name: 'In Progress', option_ids: ['stat-2'] },
                { id: 'grp-3', name: 'Complete', option_ids: ['stat-3'] },
              ],
            },
          },
        },
      };
      setupDatabaseResolution(mockClient, dbWithStatus);

      await program.parseAsync(['node', 'test', 'database', 'schema', 'db-123']);

      // Default format uses formatPropertyType inline: status {To Do: Not Started | In Progress: In Progress | Complete: Done}
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('To Do: Not Started'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('In Progress: In Progress'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Complete: Done'));
    });

    it('should show relation info', async () => {
      const dbWithRelation = {
        ...mockDatabase,
        properties: {
          Project: {
            id: 'project',
            name: 'Project',
            type: 'relation',
            relation: {
              database_id: 'db-projects',
            },
          },
        },
      };
      setupDatabaseResolution(mockClient, dbWithRelation);

      await program.parseAsync(['node', 'test', 'database', 'schema', 'db-123']);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Project'));
      // Default format uses formatPropertyType inline: relation -> db-proje...
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('relation'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('db-proje'));
    });

    it('should handle database fetch errors', async () => {
      mockClient.get.mockRejectedValue(new Error('Database not found'));

      await expect(
        program.parseAsync(['node', 'test', 'database', 'schema', 'invalid-db'])
      ).rejects.toThrow('Database not found');
    });
  });
});
