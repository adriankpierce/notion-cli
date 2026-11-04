/**
 * Shared Notion API types
 *
 * Centralizes the API response shapes shared by the focused command surface.
 */

// ─── Pages ───────────────────────────────────────────────────────────────────

export interface Page {
  id: string;
  url?: string;
  created_time: string;
  last_edited_time: string;
  properties: Record<string, unknown>;
  parent: { type: string; database_id?: string; data_source_id?: string; page_id?: string };
}

// ─── Databases ───────────────────────────────────────────────────────────────

export interface PropertySchema {
  type: string;
  [key: string]: unknown;
}

export interface Database {
  object?: 'database' | 'data_source';
  id: string;
  title?: { plain_text: string }[];
  description?: { plain_text: string }[];
  url?: string;
  properties: Record<string, PropertySchema>;
  [key: string]: unknown;
}

// ─── Native Markdown API ────────────────────────────────────────────────────

export interface PageMarkdownResponse {
  object: 'page_markdown';
  id: string;
  markdown: string;
  truncated: boolean;
  unknown_block_ids: string[];
}

export interface NotionErrorResponse {
  object?: 'error';
  status?: number;
  code?: string;
  message: string;
  additional_data?: Record<string, unknown>;
  request_id?: string;
}

export type AsyncTaskStatus = 'queued' | 'running' | 'retrying' | 'succeeded' | 'failed';

export interface AsyncTaskOperation {
  surface?: string;
  name: string;
}

export interface AsyncTask<T = unknown> {
  object: 'async_task';
  id: string;
  status: AsyncTaskStatus;
  status_url: string;
  created_time: string;
  operation: AsyncTaskOperation;
  poll_after_seconds?: number;
  result?: T;
  error?: NotionErrorResponse;
}

// ─── Pagination ──────────────────────────────────────────────────────────────

export interface PaginatedResponse<T> {
  results: T[];
  has_more: boolean;
  next_cursor?: string;
}
