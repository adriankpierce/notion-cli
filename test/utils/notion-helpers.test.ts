import { describe, it, expect, vi } from 'vitest';
import {
  getDbTitle,
  getDbDescription,
  resolvePropertyName,
  buildClearPayload,
  buildTrashPayload,
  writePageMarkdown,
  resolveAsyncResponse,
} from '../../src/utils/notion-helpers';
import { NotionApiError } from '../../src/client';
import type { Database } from '../../src/types/notion';

describe('native Markdown writes', () => {
  const markdownResponse = {
    object: 'page_markdown' as const,
    id: 'page-1',
    markdown: '# Updated',
    truncated: false,
    unknown_block_ids: [],
  };

  it('replaces all content with child deletion protection enabled by default', async () => {
    const client = {
      patch: vi.fn().mockResolvedValue(markdownResponse),
    };

    await expect(writePageMarkdown(client as any, 'page-1', '# Updated')).resolves.toEqual(markdownResponse);
    expect(client.patch).toHaveBeenCalledWith('pages/page-1/markdown', {
      type: 'replace_content',
      replace_content: {
        new_str: '# Updated',
        allow_deleting_content: false,
      },
    });
  });

  it('polls an opted-in async write to its normal result', async () => {
    const queuedTask = {
      object: 'async_task' as const,
      id: 'task-1',
      status: 'queued' as const,
      status_url: 'https://api.notion.com/v1/async_tasks/task-1',
      created_time: '2026-08-01T00:00:00Z',
      poll_after_seconds: 0,
      operation: { surface: 'rest', name: 'PATCH /v1/pages/:page_id/markdown' },
    };
    const client = {
      patch: vi.fn().mockResolvedValue(queuedTask),
      get: vi.fn().mockResolvedValue({
        ...queuedTask,
        status: 'succeeded',
        result: markdownResponse,
      }),
    };

    await expect(writePageMarkdown(client as any, 'page-1', '# Updated', { allowAsync: true }))
      .resolves.toEqual(markdownResponse);
    expect(client.patch).toHaveBeenCalledWith('pages/page-1/markdown', expect.objectContaining({
      allow_async: true,
    }));
    expect(client.get).toHaveBeenCalledWith('async_tasks/task-1');
  });

  it('preserves structured errors from a failed async task', async () => {
    const client = { get: vi.fn() };
    const task = {
      object: 'async_task' as const,
      id: 'task-2',
      status: 'failed' as const,
      status_url: 'https://api.notion.com/v1/async_tasks/task-2',
      created_time: '2026-08-01T00:00:00Z',
      operation: { name: 'PATCH /v1/pages/:page_id/markdown' },
      error: {
        message: 'Invalid replacement',
        status: 400,
        code: 'validation_error',
        additional_data: { child_page_ids: ['child-1'] },
        request_id: 'request-1',
      },
    };

    const error = await resolveAsyncResponse(client as any, task).catch(value => value);
    expect(error).toBeInstanceOf(NotionApiError);
    expect(error).toMatchObject({
      status: 400,
      code: 'validation_error',
      additionalData: { child_page_ids: ['child-1'] },
      requestId: 'request-1',
    });
  });
});

// ─── getDbTitle ─────────────────────────────────────────────────────────────

describe('getDbTitle()', () => {
  it('should extract title from database', () => {
    const db: Database = {
      id: 'db1',
      title: [{ plain_text: 'My Database' }],
      properties: {},
    };
    expect(getDbTitle(db)).toBe('My Database');
  });

  it('should concatenate multiple title segments', () => {
    const db: Database = {
      id: 'db1',
      title: [{ plain_text: 'Projects ' }, { plain_text: 'Tracker' }],
      properties: {},
    };
    expect(getDbTitle(db)).toBe('Projects Tracker');
  });

  it('should return "Untitled" when title is undefined', () => {
    const db: Database = { id: 'db1', properties: {} };
    expect(getDbTitle(db)).toBe('Untitled');
  });

  it('should return "Untitled" when title array is empty', () => {
    const db: Database = { id: 'db1', title: [], properties: {} };
    expect(getDbTitle(db)).toBe('Untitled');
  });
});

// ─── getDbDescription ───────────────────────────────────────────────────────

describe('getDbDescription()', () => {
  it('should extract description from database', () => {
    const db: Database = {
      id: 'db1',
      description: [{ plain_text: 'A description' }],
      properties: {},
    };
    expect(getDbDescription(db)).toBe('A description');
  });

  it('should concatenate multiple description segments', () => {
    const db: Database = {
      id: 'db1',
      description: [{ plain_text: 'Part one ' }, { plain_text: 'part two' }],
      properties: {},
    };
    expect(getDbDescription(db)).toBe('Part one part two');
  });

  it('should return empty string when description is undefined', () => {
    const db: Database = { id: 'db1', properties: {} };
    expect(getDbDescription(db)).toBe('');
  });

  it('should return empty string when description array is empty', () => {
    const db: Database = { id: 'db1', description: [], properties: {} };
    expect(getDbDescription(db)).toBe('');
  });
});

describe('resolvePropertyName()', () => {
  const schema = {
    'Status': { type: 'status' },
    'Due Date': { type: 'date' },
    'Persona encargada': { type: 'people' },
    'OKR vinculados': { type: 'relation' },
  };

  it('should resolve exact match', () => {
    expect(resolvePropertyName(schema, 'Status')).toBe('Status');
  });

  it('should resolve case-insensitive match', () => {
    expect(resolvePropertyName(schema, 'status')).toBe('Status');
    expect(resolvePropertyName(schema, 'STATUS')).toBe('Status');
  });

  it('should resolve with collapsed whitespace', () => {
    expect(resolvePropertyName(schema, 'due_date')).toBe('Due Date');
    expect(resolvePropertyName(schema, 'due date')).toBe('Due Date');
    expect(resolvePropertyName(schema, 'Due_Date')).toBe('Due Date');
  });

  it('should resolve accented properties case-insensitively', () => {
    expect(resolvePropertyName(schema, 'persona encargada')).toBe('Persona encargada');
  });

  it('should return null for no match', () => {
    expect(resolvePropertyName(schema, 'nonexistent')).toBeNull();
  });

  it('should prefer exact match over case-insensitive', () => {
    const ambiguous = { 'name': { type: 'text' }, 'Name': { type: 'title' } };
    expect(resolvePropertyName(ambiguous, 'Name')).toBe('Name');
    expect(resolvePropertyName(ambiguous, 'name')).toBe('name');
  });

  it('should reject ambiguous normalized matches', () => {
    const ambiguous = { 'Due Date': { type: 'date' }, 'Due_Date': { type: 'date' } };
    expect(() => resolvePropertyName(ambiguous, 'due   date')).toThrow('ambiguous');
  });
});

describe('buildClearPayload()', () => {
  it('should return empty array for people', () => {
    expect(buildClearPayload('people')).toEqual({ people: [] });
  });

  it('should return empty array for relation', () => {
    expect(buildClearPayload('relation')).toEqual({ relation: [] });
  });

  it('should return empty array for multi_select', () => {
    expect(buildClearPayload('multi_select')).toEqual({ multi_select: [] });
  });

  it('should return empty array for rich_text', () => {
    expect(buildClearPayload('rich_text')).toEqual({ rich_text: [] });
  });

  it('should return null for date', () => {
    expect(buildClearPayload('date')).toEqual({ date: null });
  });

  it('should return null for select', () => {
    expect(buildClearPayload('select')).toEqual({ select: null });
  });

  it('should return null for number', () => {
    expect(buildClearPayload('number')).toEqual({ number: null });
  });

  it('should return null for url', () => {
    expect(buildClearPayload('url')).toEqual({ url: null });
  });

  it('should return false for checkbox', () => {
    expect(buildClearPayload('checkbox')).toEqual({ checkbox: false });
  });

  it('should throw for status', () => {
    expect(() => buildClearPayload('status')).toThrow('Cannot clear status');
  });

  it('should throw for title', () => {
    expect(() => buildClearPayload('title')).toThrow('Cannot clear title');
  });

  it('should throw for unsupported types', () => {
    expect(() => buildClearPayload('formula')).toThrow('unsupported type');
  });
});

describe('buildTrashPayload()', () => {
  it('should return in_trash: true for trashing', () => {
    expect(buildTrashPayload(true)).toEqual({ in_trash: true });
  });

  it('should return in_trash: false for restoring', () => {
    expect(buildTrashPayload(false)).toEqual({ in_trash: false });
  });
});
