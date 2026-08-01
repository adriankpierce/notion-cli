import { describe, expect, it, vi } from 'vitest';
import { NotionApiError } from '../../src/client.js';
import { formatCliError, withErrorHandler } from '../../src/utils/command-handler.js';

describe('withErrorHandler', () => {
  it('calls the wrapped function with all arguments', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const wrapped = withErrorHandler(fn);

    await wrapped('arg1', 'arg2', { opt: true });

    expect(fn).toHaveBeenCalledWith('arg1', 'arg2', { opt: true });
  });

  it('propagates action failures to the top-level command boundary', async () => {
    const failure = new Error('test failure');
    const wrapped = withErrorHandler(vi.fn().mockRejectedValue(failure));

    await expect(wrapped()).rejects.toBe(failure);
  });

  it('preserves non-Error rejections', async () => {
    const wrapped = withErrorHandler(vi.fn().mockRejectedValue('string failure'));

    await expect(wrapped()).rejects.toBe('string failure');
  });
});

describe('formatCliError', () => {
  it('formats ordinary and non-Error failures deterministically', () => {
    expect(formatCliError(new Error('ordinary failure'))).toBe('Error: ordinary failure');
    expect(formatCliError('string failure')).toBe('Error: string failure');
  });

  it('preserves structured Notion diagnostics', () => {
    const error = new NotionApiError('Invalid request', {
      status: 400,
      code: 'validation_error',
      requestId: 'request-123',
      additionalData: { property: 'Status' },
      retryAfterSeconds: 2,
    });

    expect(formatCliError(error)).toBe([
      'Error: Notion API Error (400): Invalid request',
      'Code: validation_error',
      'Request ID: request-123',
      'Additional data: {"property":"Status"}',
      'Retry after: 2 second(s)',
    ].join('\n'));
  });
});
