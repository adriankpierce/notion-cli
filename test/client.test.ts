import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockFetch, mockNotionError } from './mocks/fetch.mock';
import { createMockFS } from './mocks/fs.mock';
import * as os from 'os';

describe('NotionClient', () => {
  beforeEach(() => {
    // Reset modules to clear singleton
    vi.resetModules();
  });

  describe('Constructor', () => {
    it('should create client with token', async () => {
      const { NotionClient } = await import('../src/client');
      const client = new NotionClient({ token: 'test_token' });
      expect(client).toBeDefined();
    });

    it('should accept custom version', async () => {
      const { NotionClient } = await import('../src/client');
      const client = new NotionClient({ token: 'test_token', version: '2023-01-01' });

      global.fetch = createMockFetch({ data: { success: true } });
      await client.get('test');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Notion-Version': '2023-01-01',
          }),
        })
      );
    });

    it('should use default version when not provided', async () => {
      const { NotionClient } = await import('../src/client');
      const client = new NotionClient({ token: 'test_token' });

      global.fetch = createMockFetch({ data: { success: true } });
      await client.get('test');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Notion-Version': '2026-03-11',
          }),
        })
      );
    });

    it('should reject invalid retry, rate, and timeout options', async () => {
      const { NotionClient } = await import('../src/client');
      expect(() => new NotionClient({ token: 'x', maxRetries: -1 })).toThrow('maxRetries');
      expect(() => new NotionClient({ token: 'x', requestsPerSecond: 0 })).toThrow('requestsPerSecond');
      expect(() => new NotionClient({ token: 'x', requestTimeoutMs: 0 })).toThrow('requestTimeoutMs');
    });
  });

  describe('request() Method', () => {
    it('should make GET request with auth headers', async () => {
      const { NotionClient } = await import('../src/client');
      const client = new NotionClient({ token: 'test_token_123' });

      global.fetch = createMockFetch({ data: { result: 'success' } });
      await client.request('pages/123');

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.notion.com/v1/pages/123',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Authorization': 'Bearer test_token_123',
            'Notion-Version': '2026-03-11',
            'Content-Type': 'application/json',
          }),
          signal: expect.any(AbortSignal),
        })
      );
    });

    it('should serialize concurrent rate-limit reservations', async () => {
      vi.useFakeTimers();
      try {
        const { NotionClient } = await import('../src/client');
        const client = new NotionClient({ token: 'test_token', requestsPerSecond: 1 });
        const starts: number[] = [];
        global.fetch = vi.fn().mockImplementation(() => {
          starts.push(Date.now());
          return Promise.resolve({
            ok: true,
            status: 200,
            json: vi.fn().mockResolvedValue({ ok: true }),
          });
        });

        const requests = [client.get('one'), client.get('two'), client.get('three')];
        await vi.advanceTimersByTimeAsync(0);
        expect(starts).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(starts).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(Promise.all(requests)).resolves.toHaveLength(3);
        expect(starts.map(start => start - starts[0])).toEqual([0, 1_000, 2_000]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should make POST request with body', async () => {
      const { NotionClient } = await import('../src/client');
      const client = new NotionClient({ token: 'test_token' });

      const requestBody = { parent: { database_id: 'db-123' }, title: 'Test' };
      global.fetch = createMockFetch({ data: { id: 'page-new' } });
      await client.request('pages', { method: 'POST', body: requestBody });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.notion.com/v1/pages',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(requestBody),
        })
      );
    });

    it('should make PATCH request with body', async () => {
      const { NotionClient } = await import('../src/client');
      const client = new NotionClient({ token: 'test_token' });

      const updateData = { archived: true };
      global.fetch = createMockFetch({ data: { id: 'page-123', archived: true } });
      await client.request('pages/123', { method: 'PATCH', body: updateData });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.notion.com/v1/pages/123',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify(updateData),
        })
      );
    });

    it('should make DELETE request', async () => {
      const { NotionClient } = await import('../src/client');
      const client = new NotionClient({ token: 'test_token' });

      global.fetch = createMockFetch({ data: { success: true } });
      await client.request('blocks/123', { method: 'DELETE' });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.notion.com/v1/blocks/123',
        expect.objectContaining({
          method: 'DELETE',
        })
      );
    });

    it('should handle query parameters', async () => {
      const { NotionClient } = await import('../src/client');
      const client = new NotionClient({ token: 'test_token' });

      global.fetch = createMockFetch({ data: { results: [] } });
      await client.request('databases/123/query', {
        method: 'POST',
        query: { page_size: 100, filter_properties: 'abc123' },
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.notion.com/v1/databases/123/query?page_size=100&filter_properties=abc123',
        expect.any(Object)
      );
    });

    it('should filter undefined query parameters', async () => {
      const { NotionClient } = await import('../src/client');
      const client = new NotionClient({ token: 'test_token' });

      global.fetch = createMockFetch({ data: { results: [] } });
      await client.request('search', {
        method: 'POST',
        query: { query: 'test', start_cursor: undefined },
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.notion.com/v1/search?query=test',
        expect.any(Object)
      );
    });

    it('should serialize array query values as repeated parameters', async () => {
      const { NotionClient } = await import('../src/client');
      const client = new NotionClient({ token: 'test_token' });

      global.fetch = createMockFetch({ data: { results: [] } });
      await client.get('data_sources/123/query', {
        'filter_properties[]': ['title', 'status'],
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.notion.com/v1/data_sources/123/query?filter_properties%5B%5D=title&filter_properties%5B%5D=status',
        expect.any(Object),
      );
    });

    it('should handle 400 Bad Request', async () => {
      const { NotionClient } = await import('../src/client');
      const client = new NotionClient({ token: 'test_token' });

      global.fetch = mockNotionError(400, 'Invalid request data');

      await expect(client.request('pages')).rejects.toThrow(
        'Notion API Error (400): Invalid request data'
      );
    });

    it('should handle 401 Unauthorized', async () => {
      const { NotionClient } = await import('../src/client');
      const client = new NotionClient({ token: 'invalid_token' });

      global.fetch = mockNotionError(401, 'Unauthorized');

      await expect(client.request('pages/123')).rejects.toThrow(
        'Notion API Error (401): Unauthorized'
      );
    });

    it('should handle 404 Not Found', async () => {
      const { NotionClient } = await import('../src/client');
      const client = new NotionClient({ token: 'test_token' });

      global.fetch = mockNotionError(404, 'Resource not found');

      await expect(client.request('pages/invalid')).rejects.toThrow(
        'Notion API Error (404): Resource not found'
      );
    });

    it('should preserve structured Notion error metadata', async () => {
      const { NotionClient, NotionApiError } = await import('../src/client');
      const client = new NotionClient({ token: 'test_token', maxRetries: 0 });

      global.fetch = createMockFetch({
        status: 400,
        headers: { 'x-request-id': 'header-request-id' },
        data: {
          object: 'error',
          status: 400,
          code: 'validation_error',
          message: 'Invalid request',
          additional_data: { property: 'Status' },
        },
      });

      const error = await client.get('pages/123').catch(value => value);
      expect(error).toBeInstanceOf(NotionApiError);
      expect(error).toMatchObject({
        status: 400,
        code: 'validation_error',
        additionalData: { property: 'Status' },
        requestId: 'header-request-id',
      });
    });

    it('should retry on 429 Rate Limited and throw after max retries', async () => {
      const { NotionClient } = await import('../src/client');
      const client = new NotionClient({ token: 'test_token', maxRetries: 1 });

      global.fetch = mockNotionError(429, 'Rate limited');

      await expect(client.request('search')).rejects.toThrow(
        'Notion API Error (429): Rate limited'
      );
      // 1 initial + 1 retry = 2 calls
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('should retry on 500 and succeed on second attempt', async () => {
      const { NotionClient } = await import('../src/client');
      const client = new NotionClient({ token: 'test_token', maxRetries: 2 });

      let callCount = 0;
      global.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            headers: new Headers(),
            json: () => Promise.resolve({ message: 'Internal server error' }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ id: 'page-123' }),
        });
      });

      const result = await client.request('pages/123');
      expect(result).toEqual({ id: 'page-123' });
      expect(callCount).toBe(2);
    });

    it('should throw 500 after exhausting retries', async () => {
      const { NotionClient } = await import('../src/client');
      const client = new NotionClient({ token: 'test_token', maxRetries: 0 });

      global.fetch = mockNotionError(500, 'Internal server error');

      await expect(client.request('pages/123')).rejects.toThrow(
        'Notion API Error (500): Internal server error'
      );
    });

    it('should not replay an unsafe POST after a server failure', async () => {
      const { NotionClient } = await import('../src/client');
      const client = new NotionClient({ token: 'test_token', maxRetries: 2 });

      global.fetch = mockNotionError(503, 'Service unavailable');

      await expect(client.post('pages', { markdown: '# New' })).rejects.toThrow('Service unavailable');
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should mark a disconnected mutation outcome as unknown', async () => {
      const { IndeterminateWriteError, NotionClient } = await import('../src/client');
      const client = new NotionClient({ token: 'test_token', maxRetries: 2 });
      global.fetch = vi.fn().mockRejectedValue(new Error('socket closed'));

      const error = await client.post('pages', { markdown: '# New' }).catch(value => value);
      expect(error).toBeInstanceOf(IndeterminateWriteError);
      expect(error).toMatchObject({
        code: 'notion_write_outcome_unknown',
        outcomeUnknown: true,
        method: 'POST',
        path: 'pages',
      });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should mark a successful mutation with an unreadable response body as unknown', async () => {
      const { IndeterminateWriteError, NotionClient } = await import('../src/client');
      const client = new NotionClient({ token: 'test_token', maxRetries: 0 });
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: vi.fn().mockRejectedValue(new Error('body stream reset')),
      });

      const error = await client.patch('pages/page-1', { icon: null }).catch(value => value);
      expect(error).toBeInstanceOf(IndeterminateWriteError);
      expect(error).toMatchObject({
        outcomeUnknown: true,
        method: 'PATCH',
        path: 'pages/page-1',
      });
      expect(error.message).toContain('inspect Notion before retrying');
    });

    it('should retry a POST explicitly marked as safe to replay', async () => {
      const { NotionClient } = await import('../src/client');
      const client = new NotionClient({ token: 'test_token', maxRetries: 1 });
      global.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          headers: new Headers({ 'Retry-After': '0' }),
          json: vi.fn().mockResolvedValue({ message: 'Try again' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: vi.fn().mockResolvedValue({ results: [] }),
        });

      await expect(client.post('data_sources/123/query', {}, undefined, { retrySafe: true }))
        .resolves.toEqual({ results: [] });
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('should honor Retry-After for service overload responses', async () => {
      const { NotionClient } = await import('../src/client');
      const client = new NotionClient({ token: 'test_token', maxRetries: 1 });
      global.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 529,
          statusText: 'Service Overload',
          headers: new Headers({ 'Retry-After': '0' }),
          json: vi.fn().mockResolvedValue({ code: 'service_overload', message: 'Busy' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: vi.fn().mockResolvedValue({ id: 'page-1' }),
        });

      await expect(client.patch('pages/1', { icon: null })).resolves.toEqual({ id: 'page-1' });
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('should fallback to statusText when error has no message', async () => {
      const { NotionClient } = await import('../src/client');
      const client = new NotionClient({ token: 'test_token', maxRetries: 0 });

      global.fetch = createMockFetch({
        status: 503,
        statusText: 'Service Unavailable',
        data: {},
      });

      await expect(client.request('pages/123')).rejects.toThrow(
        'Notion API Error (503): Service Unavailable'
      );
    });

    it('should handle malformed error response', async () => {
      const { NotionClient } = await import('../src/client');
      const client = new NotionClient({ token: 'test_token', maxRetries: 0 });

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Error',
        json: vi.fn().mockRejectedValue(new Error('Invalid JSON')),
      });

      await expect(client.request('pages/123')).rejects.toThrow(
        'Notion API Error (500): Internal Error'
      );
    });

    it('should handle a null error response body', async () => {
      const { NotionClient } = await import('../src/client');
      const client = new NotionClient({ token: 'test_token', maxRetries: 0 });

      global.fetch = createMockFetch({
        status: 400,
        statusText: 'Bad Request',
        data: null,
      });

      await expect(client.get('pages/123')).rejects.toThrow(
        'Notion API Error (400): Bad Request'
      );
    });
  });

  describe('Convenience Methods', () => {
    it('should call request() with GET method', async () => {
      const { NotionClient } = await import('../src/client');
      const client = new NotionClient({ token: 'test_token' });

      global.fetch = createMockFetch({ data: { id: 'page-123' } });
      const result = await client.get('pages/123');

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.notion.com/v1/pages/123',
        expect.objectContaining({ method: 'GET' })
      );
      expect(result).toEqual({ id: 'page-123' });
    });

    it('should call request() with POST method and body', async () => {
      const { NotionClient } = await import('../src/client');
      const client = new NotionClient({ token: 'test_token' });

      const body = { query: 'test' };
      global.fetch = createMockFetch({ data: { results: [] } });
      const result = await client.post('search', body);

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.notion.com/v1/search',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(body),
        })
      );
      expect(result).toEqual({ results: [] });
    });

    it('should call request() with PATCH method and body', async () => {
      const { NotionClient } = await import('../src/client');
      const client = new NotionClient({ token: 'test_token' });

      const body = { archived: true };
      global.fetch = createMockFetch({ data: { id: 'page-123', archived: true } });
      const result = await client.patch('pages/123', body);

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.notion.com/v1/pages/123',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify(body),
        })
      );
      expect(result).toEqual({ id: 'page-123', archived: true });
    });

    it('should call request() with DELETE method', async () => {
      const { NotionClient } = await import('../src/client');
      const client = new NotionClient({ token: 'test_token' });

      global.fetch = createMockFetch({ data: { success: true } });
      const result = await client.delete('blocks/123');

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.notion.com/v1/blocks/123',
        expect.objectContaining({ method: 'DELETE' })
      );
      expect(result).toEqual({ success: true });
    });
  });

  describe('sendFile()', () => {
    it('should send multipart data with auth, API version, MIME type, and timeout', async () => {
      const { NotionClient } = await import('../src/client');
      const client = new NotionClient({ token: 'upload_token', requestTimeoutMs: 12_345 });
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: vi.fn().mockResolvedValue({ id: 'upload-1', status: 'uploaded' }),
      });

      await expect(client.sendFile(
        'file_uploads/upload-1/send',
        Buffer.from('image-data'),
        'photo.jpg',
        'image/jpeg',
      )).resolves.toEqual({ id: 'upload-1', status: 'uploaded' });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.notion.com/v1/file_uploads/upload-1/send',
        expect.objectContaining({
          method: 'POST',
          headers: {
            Authorization: 'Bearer upload_token',
            'Notion-Version': '2026-03-11',
          },
          body: expect.any(FormData),
          signal: expect.any(AbortSignal),
        }),
      );
      const request = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit;
      const uploadedFile = (request.body as FormData).get('file') as File;
      expect(uploadedFile.name).toBe('photo.jpg');
      expect(uploadedFile.type).toBe('image/jpeg');
      expect(uploadedFile.size).toBe(Buffer.byteLength('image-data'));
    });

    it('should retain structured API errors from the send endpoint', async () => {
      const { NotionApiError, NotionClient } = await import('../src/client');
      const client = new NotionClient({ token: 'upload_token' });
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        statusText: 'Conflict',
        headers: new Headers({ 'x-request-id': 'request-upload' }),
        json: vi.fn().mockResolvedValue({
          code: 'conflict_error',
          message: 'Upload state conflict',
        }),
      });

      const error = await client.sendFile(
        'file_uploads/upload-1/send', Buffer.from('data'), 'file.txt', 'text/plain',
      ).catch(value => value);
      expect(error).toBeInstanceOf(NotionApiError);
      expect(error).toMatchObject({
        status: 409,
        code: 'conflict_error',
        requestId: 'request-upload',
      });
    });

    it('should mark a disconnected send outcome as unknown', async () => {
      const { IndeterminateWriteError, NotionClient } = await import('../src/client');
      const client = new NotionClient({ token: 'upload_token' });
      global.fetch = vi.fn().mockRejectedValue(new Error('socket closed'));

      const error = await client.sendFile(
        'file_uploads/upload-1/send', Buffer.from('data'), 'file.txt', 'text/plain',
      ).catch(value => value);
      expect(error).toBeInstanceOf(IndeterminateWriteError);
      expect(error).toMatchObject({
        outcomeUnknown: true,
        method: 'POST',
        path: 'file_uploads/upload-1/send',
      });
    });

    it('should mark an unreadable successful send response as unknown', async () => {
      const { IndeterminateWriteError, NotionClient } = await import('../src/client');
      const client = new NotionClient({ token: 'upload_token' });
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: vi.fn().mockRejectedValue(new Error('body stream reset')),
      });

      await expect(client.sendFile(
        'file_uploads/upload-1/send', Buffer.from('data'), 'file.txt', 'text/plain',
      )).rejects.toBeInstanceOf(IndeterminateWriteError);
    });
  });

  describe('Token Resolution', () => {
    it('should prefer the official NOTION_API_TOKEN convention', async () => {
      process.env.NOTION_API_TOKEN = 'official_token';
      process.env.NOTION_TOKEN = 'legacy_token';
      process.env.NOTION_API_KEY = 'legacy_key';

      const { getTokenSync } = await import('../src/client');
      expect(getTokenSync()).toBe('official_token');

      delete process.env.NOTION_API_TOKEN;
    });

    it('should read from NOTION_TOKEN env', async () => {
      process.env.NOTION_TOKEN = 'env_token_primary';
      delete process.env.NOTION_API_KEY;

      const { getTokenSync } = await import('../src/client');
      const token = getTokenSync();

      expect(token).toBe('env_token_primary');
    });

    it('should read from NOTION_API_KEY env', async () => {
      delete process.env.NOTION_TOKEN;
      process.env.NOTION_API_KEY = 'env_token_secondary';

      const { getTokenSync } = await import('../src/client');
      const token = getTokenSync();

      expect(token).toBe('env_token_secondary');
    });

    it('should prefer NOTION_TOKEN over NOTION_API_KEY', async () => {
      process.env.NOTION_TOKEN = 'token_primary';
      process.env.NOTION_API_KEY = 'token_secondary';

      const { getTokenSync } = await import('../src/client');
      const token = getTokenSync();

      expect(token).toBe('token_primary');
    });

    it('should read from config file if no env var', async () => {
      delete process.env.NOTION_TOKEN;
      delete process.env.NOTION_API_KEY;

      const mockFileSystem = createMockFS({
        [`${os.homedir()}/.config/notion/api_key`]: 'file_token_123\n',
      });

      vi.doMock('fs', () => ({
        readFileSync: vi.fn(mockFileSystem.readFileSync),
      }));

      const { getTokenSync } = await import('../src/client');
      const token = getTokenSync();

      expect(token).toBe('file_token_123');
      vi.doUnmock('fs');
    });

    it('should trim whitespace from file token', async () => {
      delete process.env.NOTION_TOKEN;
      delete process.env.NOTION_API_KEY;

      const mockFileSystem = createMockFS({
        [`${os.homedir()}/.config/notion/api_key`]: '  token_with_spaces  \n',
      });

      vi.doMock('fs', () => ({
        readFileSync: vi.fn(mockFileSystem.readFileSync),
      }));

      const { getTokenSync } = await import('../src/client');
      const token = getTokenSync();

      expect(token).toBe('token_with_spaces');
      vi.doUnmock('fs');
    });

    it('should try alternate config path', async () => {
      delete process.env.NOTION_TOKEN;
      delete process.env.NOTION_API_KEY;

      const mockFileSystem = createMockFS({
        [`${os.homedir()}/.notion/token`]: 'alt_path_token',
      });

      vi.doMock('fs', () => ({
        readFileSync: vi.fn(mockFileSystem.readFileSync),
      }));

      const { getTokenSync } = await import('../src/client');
      const token = getTokenSync();

      expect(token).toBe('alt_path_token');
      vi.doUnmock('fs');
    });

    it('should throw if no token found', async () => {
      delete process.env.NOTION_TOKEN;
      delete process.env.NOTION_API_KEY;

      const mockFileSystem = createMockFS({});

      vi.doMock('fs', () => ({
        readFileSync: vi.fn(mockFileSystem.readFileSync),
      }));

      const { getTokenSync } = await import('../src/client');

      expect(() => getTokenSync()).toThrow(
        'Notion API token not found. Set NOTION_API_TOKEN or create ~/.config/notion/api_key'
      );
      vi.doUnmock('fs');
    });
  });

  describe('Singleton Management', () => {
    it('should create and return client instance', async () => {
      const { initClient, getClient } = await import('../src/client');

      const client1 = initClient('test_token');
      const client2 = getClient();

      expect(client1).toBe(client2);
    });

    it('should throw if getClient called before init', async () => {
      const { getClient } = await import('../src/client');

      expect(() => getClient()).toThrow(
        'Client not initialized. Call initClient() first.'
      );
    });

    it('should use token from environment if not provided', async () => {
      process.env.NOTION_TOKEN = 'env_auto_token';

      const { initClient } = await import('../src/client');
      const client = initClient();

      global.fetch = createMockFetch({ data: { success: true } });
      await client.get('test');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Bearer env_auto_token',
          }),
        })
      );
    });

    it('should reset state between test modules', async () => {
      // First module load
      const { initClient: init1 } = await import('../src/client');
      init1('token1');

      // Reset modules
      vi.resetModules();

      // Second module load
      const { getClient: get2 } = await import('../src/client');

      // Should throw because singleton was reset
      expect(() => get2()).toThrow('Client not initialized');
    });
  });
});
