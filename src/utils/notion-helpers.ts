/**
 * Shared Notion API helper functions
 *
 * Exported functions:
 *   - readPageMarkdown(client, pageId, opts?)   → PageMarkdownResponse (native markdown read)
 *   - writePageMarkdown(client, pageId, md)     → PageMarkdownResponse (native markdown write)
 *   - getDbTitle(db)                             → string    (extract title from database)
 *   - getDbDescription(db)                       → string    (extract description from database)
 *   - getParentDatabaseId(parent)               → string | undefined (extract DB/DS id from parent)
 *   - isParentDatabase(parent)                   → boolean (check if parent is a database/data_source)
 */

import type { getClient } from '../client.js';
import { NotionApiError } from '../client.js';
import type { Page, Database, PageMarkdownResponse, AsyncTask } from '../types/notion.js';

// ─── Native Markdown API ────────────────────────────────────────────────────

/**
 * Read a page's content as markdown via Notion's native markdown endpoint.
 * GET /v1/pages/{id}/markdown
 */
export async function readPageMarkdown(
  client: ReturnType<typeof getClient>,
  pageId: string,
  options?: { includeTranscript?: boolean },
): Promise<PageMarkdownResponse> {
  const query: Record<string, string> = {};
  if (options?.includeTranscript) query.include_transcript = 'true';
  return client.get<PageMarkdownResponse>(`pages/${pageId}/markdown`, query);
}

/**
 * Replace a page's entire content with markdown.
 * PATCH /v1/pages/{id}/markdown  (type: replace_content)
 *
 * @param allowDeletingContent - When true, allows deletion of child pages/databases
 *   embedded in the page. Defaults to false (safe). Notion returns a validation_error
 *   if the replacement would remove child pages/databases and this is false.
 */
export async function writePageMarkdown(
  client: ReturnType<typeof getClient>,
  pageId: string,
  markdown: string,
  options?: { allowDeletingContent?: boolean; allowAsync?: boolean },
): Promise<PageMarkdownResponse> {
  const response = await client.patch<PageMarkdownResponse | AsyncTask<PageMarkdownResponse>>(`pages/${pageId}/markdown`, {
    type: 'replace_content',
    replace_content: {
      new_str: markdown,
      allow_deleting_content: options?.allowDeletingContent ?? false,
    },
    ...(options?.allowAsync ? { allow_async: true } : {}),
  });
  return resolveAsyncResponse(client, response);
}

/**
 * Apply surgical search-and-replace operations to a page's markdown content.
 * PATCH /v1/pages/{id}/markdown  (type: update_content)
 *
 * Each update's old_str must match exactly one location (case-sensitive) unless
 * replace_all_matches is true. Returns validation_error if no match found or
 * if multiple matches found without replace_all_matches.
 *
 * Max 100 content_updates per request.
 *
 * @param allowDeletingContent - When true, allows deletion of child pages/databases.
 *   Defaults to false (safe).
 */
export async function updatePageMarkdown(
  client: ReturnType<typeof getClient>,
  pageId: string,
  updates: { old_str: string; new_str: string; replace_all_matches?: boolean }[],
  options?: { allowDeletingContent?: boolean; allowAsync?: boolean },
): Promise<PageMarkdownResponse> {
  const response = await client.patch<PageMarkdownResponse | AsyncTask<PageMarkdownResponse>>(`pages/${pageId}/markdown`, {
    type: 'update_content',
    update_content: {
      content_updates: updates,
      allow_deleting_content: options?.allowDeletingContent ?? false,
    },
    ...(options?.allowAsync ? { allow_async: true } : {}),
  });
  return resolveAsyncResponse(client, response);
}

/** Poll an async Notion operation and return its normal synchronous result. */
export async function resolveAsyncResponse<T>(
  client: ReturnType<typeof getClient>,
  response: T | AsyncTask<T>,
  options?: { timeoutMs?: number },
): Promise<T> {
  if (!isAsyncTask(response)) return response;

  const timeoutMs = options?.timeoutMs ?? 5 * 60_000;
  const deadline = Date.now() + timeoutMs;
  let task = response;

  while (task.status !== 'succeeded' && task.status !== 'failed') {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error(`Timed out waiting for Notion async task ${task.id}`);

    const pollAfterSeconds = task.poll_after_seconds ?? 1;
    if (!Number.isFinite(pollAfterSeconds) || pollAfterSeconds < 0) {
      throw new Error(`Notion async task ${task.id} returned an invalid polling interval`);
    }
    const pollDelayMs = pollAfterSeconds * 1000;
    if (pollDelayMs >= remainingMs) {
      throw new Error(`Timed out waiting for Notion async task ${task.id}`);
    }
    if (pollDelayMs > 0) await new Promise(resolve => setTimeout(resolve, pollDelayMs));
    task = await client.get<AsyncTask<T>>(`async_tasks/${task.id}`);
  }

  if (task.status === 'failed') {
    const error = task.error;
    throw new NotionApiError(error?.message || `Async task ${task.id} failed`, {
      status: error?.status ?? 500,
      code: error?.code,
      additionalData: error?.additional_data,
      requestId: error?.request_id,
    });
  }

  if (task.result === undefined) {
    throw new Error(`Notion async task ${task.id} succeeded without a result`);
  }
  return task.result;
}

function isAsyncTask<T>(response: T | AsyncTask<T>): response is AsyncTask<T> {
  return typeof response === 'object'
    && response !== null
    && 'object' in response
    && (response as { object?: unknown }).object === 'async_task';
}

/**
 * Extract the plain-text title from a Notion database.
 * Returns 'Untitled' if no title is set.
 */
export function getDbTitle(db: Database): string {
  return db.title?.map(t => t.plain_text).join('') || 'Untitled';
}

/**
 * Extract the plain-text description from a Notion database.
 * Returns an empty string if no description is set.
 */
export function getDbDescription(db: Database): string {
  return db.description?.map(t => t.plain_text).join('') || '';
}

// ─── Property name resolution ────────────────────────────────────────────────

/**
 * Resolve a user-supplied property name against the schema.
 * Tries: exact match → case-insensitive → normalized (collapsed whitespace).
 * Returns the canonical schema name or null if no match.
 */
export function resolvePropertyName(
  schema: Record<string, unknown>,
  input: string,
): string | null {
  // Exact match
  if (input in schema) return input;

  const lowerInput = input.toLowerCase().trim();

  const caseInsensitiveMatches = Object.keys(schema)
    .filter(name => name.toLowerCase() === lowerInput);
  if (caseInsensitiveMatches.length === 1) return caseInsensitiveMatches[0];
  if (caseInsensitiveMatches.length > 1) {
    throw new Error(
      `Property name "${input}" is ambiguous: ${caseInsensitiveMatches.join(', ')}. Use the exact name.`,
    );
  }

  // Normalized match (collapse whitespace and underscores to spaces).
  const normalizedInput = lowerInput.replace(/[_\s]+/g, ' ');
  const normalizedMatches = Object.keys(schema).filter((name) => {
    return name.toLowerCase().replace(/[_\s]+/g, ' ').trim() === normalizedInput;
  });
  if (normalizedMatches.length === 1) return normalizedMatches[0];
  if (normalizedMatches.length > 1) {
    throw new Error(
      `Property name "${input}" is ambiguous: ${normalizedMatches.join(', ')}. Use the exact name.`,
    );
  }

  return null;
}

/**
 * Generate the correct empty/null payload to clear a property based on its type.
 * Throws for status (Notion doesn't allow clearing status).
 */
export function buildClearPayload(propType: string): unknown {
  switch (propType) {
    case 'people':
    case 'relation':
    case 'multi_select':
    case 'rich_text':
    case 'files':
      return { [propType]: [] };
    case 'date':
    case 'select':
    case 'number':
    case 'url':
    case 'email':
    case 'phone_number':
      return { [propType]: null };
    case 'checkbox':
      return { checkbox: false };
    case 'status':
      throw new Error('Cannot clear status property — Notion requires a valid status value');
    case 'title':
      throw new Error('Cannot clear title property — pages must have a title');
    default:
      throw new Error(`Cannot clear property of type "${propType}" — unsupported type`);
  }
}

// ─── Parent helpers (v2025-09-03 compat) ────────────────────────────────────

/**
 * Check if a page's parent is a database (or data_source on v2025-09-03).
 */
export function isParentDatabase(parent: Page['parent']): boolean {
  return parent.type === 'database_id' || parent.type === 'data_source_id';
}

/**
 * Extract the database ID from a page's parent, regardless of API version.
 * On v2025-09-03, parent.type is 'data_source_id' but database_id is still present.
 */
export function getParentDatabaseId(parent: Page['parent']): string | undefined {
  return parent.database_id ?? parent.data_source_id;
}

// ─── API v2026-03-11 helpers ─────────────────────────────────────────────────

/**
 * Build the trash/archive payload for the current API version.
 * v2026-03-11 uses `in_trash` instead of `archived`.
 */
export function buildTrashPayload(trash: boolean): Record<string, boolean> {
  return { in_trash: trash };
}
