/** Shared command-boundary helpers. */

/**
 * Keep command registration call sites concise without handling failures inside
 * individual actions. Rejections propagate to the single parseAsync boundary in
 * cli.ts, which owns stderr formatting and the process exit code.
 */
export function withErrorHandler(fn: (...args: any[]) => Promise<void>): (...args: any[]) => Promise<void> {
  return fn;
}

interface StructuredApiError {
  name?: string;
  status?: number;
  code?: string;
  requestId?: string;
  additionalData?: Record<string, unknown>;
  retryAfterSeconds?: number;
  outcomeUnknown?: boolean;
  method?: string;
  path?: string;
}

function isStructuredApiError(error: unknown): error is Error & StructuredApiError {
  return error instanceof Error
    && error.name === 'NotionApiError'
    && typeof (error as StructuredApiError).status === 'number';
}

/** Format an unknown rejection for deterministic CLI diagnostics. */
export function formatCliError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lines = [`Error: ${message}`];

  if (isStructuredApiError(error)) {
    if (error.code) lines.push(`Code: ${error.code}`);
    if (error.requestId) lines.push(`Request ID: ${error.requestId}`);
    if (error.additionalData) {
      lines.push(`Additional data: ${JSON.stringify(error.additionalData)}`);
    }
    if (error.retryAfterSeconds !== undefined) {
      lines.push(`Retry after: ${error.retryAfterSeconds} second(s)`);
    }
  } else if (error instanceof Error) {
    const structured = error as StructuredApiError;
    if (structured.code) lines.push(`Code: ${structured.code}`);
    if (structured.outcomeUnknown) lines.push('Outcome unknown: true');
    if (structured.method && structured.path) {
      lines.push(`Request: ${structured.method} ${structured.path}`);
    }
  }

  return lines.join('\n');
}
