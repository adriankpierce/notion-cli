import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { PageMarkdownResponse } from '../types/notion.js';
import {
  INGEST_MANIFEST_SCHEMA,
  INGEST_MANIFEST_SCHEMA_VERSION,
  type ExistingPageSnapshot,
  type IngestManifestPayloadV1,
  type IngestManifestV1,
} from './types.js';
import { validateIngestStageRequest } from './validation.js';

const SHA256 = /^[0-9a-f]{64}$/;

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new IngestManifestError(`${label} contains unsupported field(s): ${unknown.join(', ')}.`);
  }
}

export class IngestManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IngestManifestError';
  }
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function manifestDigest(payload: IngestManifestPayloadV1): string {
  return sha256(JSON.stringify(payload));
}

export function assertCompleteMarkdown(
  response: unknown,
  operation: string,
): asserts response is PageMarkdownResponse {
  const page = response as Partial<PageMarkdownResponse> | null;
  if (
    !page
    || typeof page.markdown !== 'string'
    || typeof page.truncated !== 'boolean'
    || !Array.isArray(page.unknown_block_ids)
  ) {
    throw new IngestManifestError(`${operation} returned an invalid Markdown response.`);
  }
  if (page.truncated || page.unknown_block_ids.length > 0) {
    throw new IngestManifestError(`${operation} returned incomplete Markdown; refusing to continue.`);
  }
}

export function createExistingPageSnapshot(
  pageId: string,
  lastEditedTime: string,
  markdown: PageMarkdownResponse,
): ExistingPageSnapshot {
  assertCompleteMarkdown(markdown, `Staging read for page ${pageId}`);
  if (markdown.markdown.length === 0) {
    throw new IngestManifestError(
      `Existing page ${pageId} is empty; exact-match ingestion does not support empty bodies.`,
    );
  }
  return {
    page_id: pageId,
    last_edited_time: lastEditedTime,
    markdown: markdown.markdown,
    markdown_sha256: sha256(markdown.markdown),
  };
}

export function writeIngestManifest(
  path: string,
  payload: IngestManifestPayloadV1,
): IngestManifestV1 {
  const manifest: IngestManifestV1 = { ...payload, digest: manifestDigest(payload) };
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return manifest;
}

function parseManifest(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new IngestManifestError(`Could not read ingestion manifest ${path}: ${detail}`);
  }
}

export function readIngestManifest(path: string, expectedDigest: string): IngestManifestV1 {
  if (!SHA256.test(expectedDigest)) {
    throw new IngestManifestError('The expected manifest digest must be lowercase SHA-256.');
  }
  const input = parseManifest(path) as Partial<IngestManifestV1> | null;
  if (
    !input
    || input.schema !== INGEST_MANIFEST_SCHEMA
    || input.schema_version !== INGEST_MANIFEST_SCHEMA_VERSION
    || typeof input.digest !== 'string'
  ) {
    throw new IngestManifestError(`Manifest ${path} has an unsupported schema.`);
  }
  assertExactKeys(input as Record<string, unknown>, [
    'schema',
    'schema_version',
    'staged_at',
    'recipe',
    'target',
    'artifact',
    'existing_page_snapshot',
    'digest',
  ], `Manifest ${path}`);
  if (!SHA256.test(input.digest)) {
    throw new IngestManifestError(`Manifest ${path} has an invalid digest.`);
  }
  const { digest, ...untrustedPayload } = input;
  const request = validateIngestStageRequest({
    recipe: untrustedPayload.recipe as IngestManifestPayloadV1['recipe'],
    target: untrustedPayload.target as IngestManifestPayloadV1['target'],
    artifact: untrustedPayload.artifact,
  });
  if (typeof untrustedPayload.staged_at !== 'string' || !Number.isFinite(Date.parse(untrustedPayload.staged_at))) {
    throw new IngestManifestError(`Manifest ${path} has an invalid staged_at timestamp.`);
  }
  const snapshot = untrustedPayload.existing_page_snapshot;
  if (request.target.kind === 'existing_page') {
    if (
      !snapshot
      || snapshot.page_id !== request.target.page_id
      || typeof snapshot.last_edited_time !== 'string'
      || !Number.isFinite(Date.parse(snapshot.last_edited_time))
      || typeof snapshot.markdown !== 'string'
      || snapshot.markdown.length === 0
      || snapshot.markdown_sha256 !== sha256(snapshot.markdown)
    ) {
      throw new IngestManifestError(`Manifest ${path} has an invalid existing-page snapshot.`);
    }
    assertExactKeys(snapshot as unknown as Record<string, unknown>, [
      'page_id',
      'last_edited_time',
      'markdown',
      'markdown_sha256',
    ], `Manifest ${path} existing-page snapshot`);
  } else if (snapshot !== undefined) {
    throw new IngestManifestError(`Manifest ${path} unexpectedly contains an existing-page snapshot.`);
  }
  const payload: IngestManifestPayloadV1 = {
    schema: INGEST_MANIFEST_SCHEMA,
    schema_version: INGEST_MANIFEST_SCHEMA_VERSION,
    staged_at: untrustedPayload.staged_at,
    ...request,
    ...(snapshot === undefined ? {} : { existing_page_snapshot: snapshot }),
  };
  const computed = manifestDigest(payload);
  if (computed !== digest) throw new IngestManifestError(`Manifest ${path} failed its integrity check.`);
  if (digest !== expectedDigest) {
    throw new IngestManifestError(`Manifest ${path} does not match the separately supplied digest.`);
  }
  return { ...payload, digest };
}
