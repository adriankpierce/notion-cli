import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { dirname } from 'node:path';
import { NotionApiError } from '../client.js';
import type { Page, PageMarkdownResponse } from '../types/notion.js';
import {
  INGEST_CREATION_ATTEMPT_SCHEMA,
  INGEST_CREATION_ATTEMPT_SCHEMA_VERSION,
  INGEST_CREATION_DECISION_SCHEMA,
  INGEST_CREATION_DECISION_SCHEMA_VERSION,
  INGEST_MANIFEST_SCHEMA,
  INGEST_MANIFEST_SCHEMA_VERSION,
  MAX_INGEST_ASSET_BYTES,
  MAX_INGEST_TOTAL_ASSET_BYTES,
  type IngestApplyResult,
  type IngestArtifactV1,
  type IngestClient,
  type IngestCreationAttemptV1,
  type IngestCreationDecisionV1,
  type IngestDependencies,
  type IngestManifestPayloadV1,
  type IngestManifestV1,
  type IngestStageRequest,
  type NewPageTarget,
} from './types.js';
import {
  IngestManifestError,
  assertCompleteMarkdown,
  createExistingPageSnapshot,
  readIngestManifest,
  writeIngestManifest,
} from './manifest.js';
import { validateIngestStageRequest } from './validation.js';
import { canonicalizeEnhancedMarkdown, compareEnhancedMarkdown } from './verification.js';
import { hashPinnedHttp } from './pinned-http.js';
import {
  LiveAttemptLockError,
  acquireLiveAttemptLock,
  type LiveAttemptLock,
} from './live-attempt-lock.js';

export class IngestConflictError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'IngestConflictError';
  }
}

export class IngestUnknownWriteOutcomeError extends Error {
  readonly outcomeUnknown = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'IngestUnknownWriteOutcomeError';
  }
}

const ASSET_REQUEST_TIMEOUT_MS = 120_000;
const ASSET_VERIFICATION_TIMEOUT_MS = 5 * 60_000;
const DNS_LOOKUP_TIMEOUT_MS = 10_000;
type HostLookup = NonNullable<IngestDependencies['lookup']>;

function ipv4Bytes(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map(part => Number(part));
  return bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    ? bytes
    : null;
}

function ipv6Bytes(address: string): number[] | null {
  let normalized = address.toLowerCase().split('%', 1)[0];
  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    const embedded = ipv4Bytes(normalized.slice(lastColon + 1));
    if (lastColon < 0 || !embedded) return null;
    normalized = `${normalized.slice(0, lastColon)}:${(
      (embedded[0] << 8) | embedded[1]
    ).toString(16)}:${((embedded[2] << 8) | embedded[3]).toString(16)}`;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const parseGroups = (value: string): number[] | null => {
    if (value === '') return [];
    const groups = value.split(':');
    if (groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null;
    return groups.map(group => Number.parseInt(group, 16));
  };
  const left = parseGroups(halves[0]);
  const right = parseGroups(halves[1] ?? '');
  if (!left || !right) return null;
  const omitted = 8 - left.length - right.length;
  if (
    omitted < 0
    || (halves.length === 1 && omitted !== 0)
    || (halves.length === 2 && omitted < 1)
  ) return null;
  const groups = [...left, ...Array<number>(omitted).fill(0), ...right];
  return groups.flatMap(group => [group >> 8, group & 0xff]);
}

function forbiddenIpv4(bytes: readonly number[]): boolean {
  const [first, second, third] = bytes;
  return first === 0
    || first === 10
    || first === 127
    || first >= 224
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 192 && second === 0 && (third === 0 || third === 2))
    || (first === 192 && second === 31 && third === 196)
    || (first === 192 && second === 52 && third === 193)
    || (first === 192 && second === 88 && third === 99)
    || (first === 192 && second === 175 && third === 48)
    || (first === 198 && (second === 18 || second === 19))
    || (first === 198 && second === 51 && third === 100)
    || (first === 203 && second === 0 && third === 113);
}

function forbiddenAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const bytes = ipv4Bytes(address);
    return !bytes || forbiddenIpv4(bytes);
  }
  if (family !== 6) return true;
  const bytes = ipv6Bytes(address);
  if (!bytes) return true;
  const allZeroPrefix = (length: number): boolean => (
    bytes.slice(0, length).every(byte => byte === 0)
  );
  const unspecified = bytes.every(byte => byte === 0);
  const loopback = allZeroPrefix(15) && bytes[15] === 1;
  const uniqueLocal = (bytes[0] & 0xfe) === 0xfc;
  const linkLocal = bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80;
  const multicast = bytes[0] === 0xff;
  const documentation = bytes[0] === 0x20
    && bytes[1] === 0x01
    && bytes[2] === 0x0d
    && bytes[3] === 0xb8;
  const mappedIpv4 = allZeroPrefix(10) && bytes[10] === 0xff && bytes[11] === 0xff;
  const compatibleIpv4 = allZeroPrefix(12);
  const private6to4 = bytes[0] === 0x20
    && bytes[1] === 0x02
    && forbiddenIpv4(bytes.slice(2, 6));
  // Conservatively deny every current IANA special-purpose allocation inside
  // 2000::/3, including protocol assignments and globally reachable anycast.
  const protocolAssignments = bytes[0] === 0x20
    && bytes[1] === 0x01
    && bytes[2] < 0x02;
  const sixToFour = bytes[0] === 0x20 && bytes[1] === 0x02;
  const as112 = bytes[0] === 0x26
    && bytes[1] === 0x20
    && bytes[2] === 0x00
    && bytes[3] === 0x4f
    && bytes[4] === 0x80
    && bytes[5] === 0x00;
  const documentationV2 = bytes[0] === 0x3f && (bytes[1] & 0xf0) === 0xf0;
  const globalUnicast = (bytes[0] & 0xe0) === 0x20;
  return !globalUnicast
    || unspecified
    || loopback
    || uniqueLocal
    || linkLocal
    || multicast
    || documentation
    || (mappedIpv4 && forbiddenIpv4(bytes.slice(12)))
    || (compatibleIpv4 && forbiddenIpv4(bytes.slice(12)))
    || private6to4
    || protocolAssignments
    || sixToFour
    || as112
    || documentationV2;
}

const defaultHostLookup: HostLookup = async (hostname) => (
  await dnsLookup(hostname, { all: true, verbatim: true })
);

async function lookupWithTimeout(
  hostname: string,
  lookupImplementation: HostLookup,
  deadline: number,
): Promise<readonly { address: string; family: number }[]> {
  const timeoutMs = Math.min(DNS_LOOKUP_TIMEOUT_MS, deadline - Date.now());
  if (timeoutMs <= 0) throw new Error('Asset verification deadline expired before DNS lookup.');
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      lookupImplementation(hostname),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('DNS lookup timed out')), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function assertPublicAssetUrl(
  url: URL,
  lookupImplementation: HostLookup,
  deadline: number,
): Promise<readonly { address: string; family: number }[]> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    if (forbiddenAddress(hostname)) {
      throw new IngestConflictError(`Readback asset address is not public: ${hostname}.`);
    }
    return [{ address: hostname, family: literalFamily }];
  }
  if (
    hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname.endsWith('.home.arpa')
    || !hostname.includes('.')
  ) {
    throw new IngestConflictError(`Readback asset host is not public: ${hostname}.`);
  }
  let resolved: readonly { address: string; family: number }[];
  try {
    resolved = await lookupWithTimeout(hostname, lookupImplementation, deadline);
  } catch (error) {
    throw new IngestConflictError(
      `Readback asset host could not be resolved safely: ${hostname}.`,
      { cause: error },
    );
  }
  if (resolved.length === 0 || resolved.some(result => forbiddenAddress(result.address))) {
    throw new IngestConflictError(`Readback asset host resolves to a non-public address: ${hostname}.`);
  }
  return resolved;
}

function nowIso(dependencies: IngestDependencies): string {
  return (dependencies.now?.() ?? new Date()).toISOString();
}

function requirePage(value: unknown, operation: string): Page {
  const page = value as Partial<Page> | null;
  if (!page || typeof page.id !== 'string' || typeof page.last_edited_time !== 'string') {
    throw new IngestManifestError(`${operation} returned an invalid page response.`);
  }
  return page as Page;
}

function comparableId(value: string | undefined): string {
  return (value ?? '').replaceAll('-', '').toLowerCase();
}

function isUnknownOutcome(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'outcomeUnknown' in error
    && (error as { outcomeUnknown?: unknown }).outcomeUnknown === true,
  );
}

function isKnownRejectedWrite(error: unknown): boolean {
  return error instanceof NotionApiError
    && [400, 401, 403, 404, 409, 422, 429].includes(error.status);
}

async function readCompleteMarkdown(
  client: IngestClient,
  pageId: string,
  operation: string,
): Promise<PageMarkdownResponse> {
  const response = await client.get<PageMarkdownResponse>(`pages/${pageId}/markdown`);
  assertCompleteMarkdown(response, operation);
  return response;
}

export async function stageIngestion(
  request: IngestStageRequest,
  manifestPath: string,
  dependencies: IngestDependencies,
): Promise<IngestManifestV1> {
  const validated = validateIngestStageRequest(request);
  let snapshot: IngestManifestPayloadV1['existing_page_snapshot'];
  if (validated.target.kind === 'existing_page') {
    const page = requirePage(
      await dependencies.client.get<Page>(`pages/${validated.target.page_id}`),
      `Staging page lookup for ${validated.target.page_id}`,
    );
    const markdown = await readCompleteMarkdown(
      dependencies.client,
      validated.target.page_id,
      `Staging read for page ${validated.target.page_id}`,
    );
    snapshot = createExistingPageSnapshot(
      validated.target.page_id,
      page.last_edited_time,
      markdown,
    );
  }
  const payload: IngestManifestPayloadV1 = {
    schema: INGEST_MANIFEST_SCHEMA,
    schema_version: INGEST_MANIFEST_SCHEMA_VERSION,
    staged_at: nowIso(dependencies),
    ...validated,
    ...(snapshot === undefined ? {} : { existing_page_snapshot: snapshot }),
  };
  return writeIngestManifest(manifestPath, payload);
}

interface ReadbackAssetDigest {
  sha256: string;
  byte_length: number;
  content_type?: string;
}

function checkedDeclaredLength(raw: string | undefined | null, maxBytes: number): void {
  if (raw === undefined || raw === null || raw === '') return;
  const declaredLength = Number(raw);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new IngestConflictError('Readback asset exceeds its remaining byte budget.');
  }
}

async function hashWithFetch(
  url: URL,
  fetchImplementation: typeof globalThis.fetch,
  timeoutMs: number,
  maxBytes: number,
): Promise<ReadbackAssetDigest> {
  const response = await fetchImplementation(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new IngestConflictError(`Readback asset fetch failed with HTTP ${response.status}.`);
  }
  checkedDeclaredLength(response.headers.get('content-length'), maxBytes);
  const hash = createHash('sha256');
  let byteLength = 0;
  const reader = response.body?.getReader();
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        throw new IngestConflictError('Readback asset exceeds its remaining byte budget.');
      }
      hash.update(value);
    }
  } else {
    const bytes = new Uint8Array(await response.arrayBuffer());
    byteLength = bytes.byteLength;
    if (byteLength > maxBytes) {
      throw new IngestConflictError('Readback asset exceeds its remaining byte budget.');
    }
    hash.update(bytes);
  }
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  return {
    sha256: hash.digest('hex'),
    byte_length: byteLength,
    ...(contentType ? { content_type: contentType } : {}),
  };
}

async function hashReadbackAsset(
  source: string,
  fetchImplementation: typeof globalThis.fetch | undefined,
  lookupImplementation: HostLookup,
  deadline: number,
  maxBytes: number,
): Promise<ReadbackAssetDigest> {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new IngestConflictError(`Readback asset source is not a valid URL: ${source}.`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new IngestConflictError(`Readback asset source is not credential-free HTTP(S): ${source}.`);
  }
  const resolved = await assertPublicAssetUrl(url, lookupImplementation, deadline);
  const timeoutMs = Math.min(ASSET_REQUEST_TIMEOUT_MS, deadline - Date.now());
  if (timeoutMs <= 0) {
    throw new IngestConflictError('Readback asset verification exceeded five minutes.');
  }
  if (fetchImplementation) {
    return hashWithFetch(url, fetchImplementation, timeoutMs, maxBytes);
  }
  try {
    return await hashPinnedHttp({
      url,
      address: resolved[0].address,
      family: resolved[0].family,
      timeout_ms: timeoutMs,
      max_bytes: maxBytes,
    });
  } catch (error) {
    throw new IngestConflictError('Readback asset request failed.', { cause: error });
  }
}

async function verifyAssetAttestations(
  markdown: PageMarkdownResponse,
  artifact: IngestArtifactV1,
  fetchImplementation: typeof globalThis.fetch | undefined,
  lookupImplementation: HostLookup,
): Promise<void> {
  if (!artifact.assets || artifact.assets.length === 0) return;
  const expectedMedia = canonicalizeEnhancedMarkdown(artifact.markdown).media;
  const actualMedia = canonicalizeEnhancedMarkdown(markdown.markdown).media;
  const assets = new Map(artifact.assets.map(asset => [asset.source_url, asset]));
  const cache = new Map<string, {
    sha256: string;
    byte_length: number;
    content_type?: string;
  }>();
  const deadline = Date.now() + ASSET_VERIFICATION_TIMEOUT_MS;
  let verifiedBytes = 0;
  for (let index = 0; index < expectedMedia.length; index += 1) {
    const attestation = assets.get(expectedMedia[index].source);
    if (!attestation) {
      throw new IngestConflictError(`Artifact has no attestation for media ${index + 1}.`);
    }
    const actualSource = actualMedia[index]?.source;
    if (!actualSource) {
      throw new IngestConflictError(`Readback has no source for media ${index + 1}.`);
    }
    let digest = cache.get(actualSource);
    if (!digest) {
      if (deadline - Date.now() <= 0) {
        throw new IngestConflictError('Readback asset verification exceeded five minutes.');
      }
      const remainingBytes = MAX_INGEST_TOTAL_ASSET_BYTES - verifiedBytes;
      digest = await hashReadbackAsset(
        actualSource,
        fetchImplementation,
        lookupImplementation,
        deadline,
        Math.min(MAX_INGEST_ASSET_BYTES, remainingBytes),
      );
      verifiedBytes += digest.byte_length;
      if (verifiedBytes > MAX_INGEST_TOTAL_ASSET_BYTES) {
        throw new IngestConflictError(
          'Readback assets exceed the 512 MiB aggregate safety limit.',
        );
      }
      cache.set(actualSource, digest);
    }
    if (
      digest.sha256 !== attestation.sha256
      || digest.byte_length !== attestation.byte_length
      || (
        attestation.content_type !== undefined
        && digest.content_type !== attestation.content_type
      )
    ) {
      throw new IngestConflictError(
        `Readback media ${index + 1} does not match its digest-bound asset bytes.`,
      );
    }
  }
}

async function verifyExactContent(
  markdown: PageMarkdownResponse,
  artifact: IngestArtifactV1,
  operation: string,
  fetchImplementation: typeof globalThis.fetch | undefined,
  lookupImplementation: HostLookup,
): Promise<void> {
  assertCompleteMarkdown(markdown, operation);
  const difference = compareEnhancedMarkdown(artifact.markdown, markdown.markdown, {
    ignore_media_sources: artifact.assets !== undefined,
  });
  if (difference) {
    throw new IngestConflictError(
      `${operation} did not match the digest-bound enhanced Markdown: ${difference}.`,
    );
  }
  await verifyAssetAttestations(
    markdown,
    artifact,
    fetchImplementation,
    lookupImplementation,
  );
}

function contentMatchesArtifact(markdown: string, artifact: IngestArtifactV1): boolean {
  return compareEnhancedMarkdown(artifact.markdown, markdown, {
    ignore_media_sources: artifact.assets !== undefined,
  }) === null;
}

async function reconcileExistingAfterError(
  manifest: IngestManifestV1,
  dependencies: IngestDependencies,
  cause: unknown,
): Promise<IngestApplyResult> {
  const target = manifest.target;
  if (target.kind !== 'existing_page') throw new Error('Expected an existing-page manifest.');
  try {
    const current = await readCompleteMarkdown(
      dependencies.client,
      target.page_id,
      `Reconciliation read for page ${target.page_id}`,
    );
    if (contentMatchesArtifact(current.markdown, manifest.artifact)) {
      await verifyAssetAttestations(
        current,
        manifest.artifact,
        dependencies.fetch,
        dependencies.lookup ?? defaultHostLookup,
      );
      return {
        status: 'reconciled',
        operation: 'updated',
        page_id: target.page_id,
        manifest_digest: manifest.digest,
      };
    }
  } catch {
    // Preserve the indeterminate mutation as the primary safety signal.
  }
  if (isUnknownOutcome(cause)) {
    throw new IngestUnknownWriteOutcomeError(
      `The update outcome for page ${target.page_id} is unknown and could not be reconciled. ` +
      'Stop and inspect the page before retrying.',
      { cause },
    );
  }
  throw cause;
}

async function applyExistingPage(
  manifest: IngestManifestV1,
  dependencies: IngestDependencies,
): Promise<IngestApplyResult> {
  if (manifest.target.kind !== 'existing_page' || !manifest.existing_page_snapshot) {
    throw new IngestManifestError('Existing-page apply requires a staged snapshot.');
  }
  const target = manifest.target;
  const snapshot = manifest.existing_page_snapshot;
  const page = requirePage(
    await dependencies.client.get<Page>(`pages/${target.page_id}`),
    `Pre-apply page lookup for ${target.page_id}`,
  );
  const current = await readCompleteMarkdown(
    dependencies.client,
    target.page_id,
    `Pre-apply read for page ${target.page_id}`,
  );
  if (contentMatchesArtifact(current.markdown, manifest.artifact)) {
    await verifyAssetAttestations(
      current,
      manifest.artifact,
      dependencies.fetch,
      dependencies.lookup ?? defaultHostLookup,
    );
    return {
      status: 'already_applied',
      operation: 'updated',
      page_id: target.page_id,
      manifest_digest: manifest.digest,
    };
  }
  if (page.last_edited_time !== snapshot.last_edited_time || current.markdown !== snapshot.markdown) {
    throw new IngestConflictError(
      `Page ${target.page_id} changed after staging; refusing to overwrite it.`,
    );
  }
  try {
    await dependencies.client.patch<PageMarkdownResponse>(`pages/${target.page_id}/markdown`, {
      type: 'update_content',
      update_content: {
        content_updates: [{
          old_str: snapshot.markdown,
          new_str: manifest.artifact.markdown,
          replace_all_matches: false,
        }],
        allow_deleting_content: false,
      },
    });
  } catch (error) {
    return reconcileExistingAfterError(manifest, dependencies, error);
  }
  const verified = await readCompleteMarkdown(
    dependencies.client,
    target.page_id,
    `Post-apply read for page ${target.page_id}`,
  );
  await verifyExactContent(
    verified,
    manifest.artifact,
    `Post-apply verification for page ${target.page_id}`,
    dependencies.fetch,
    dependencies.lookup ?? defaultHostLookup,
  );
  return {
    status: 'applied',
    operation: 'updated',
    page_id: target.page_id,
    manifest_digest: manifest.digest,
  };
}

function creationStatePath(manifestPath: string): string {
  return `${manifestPath}.apply-state.json`;
}

const CREATION_JOURNAL_LIMIT = 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readJsonFile(path: string, description: string): unknown | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const candidate = error as NodeJS.ErrnoException;
    if (candidate.code === 'ENOENT') return null;
    throw new IngestUnknownWriteOutcomeError(
      `Could not safely read ${description} ${path}; refusing to retry creation.`,
      { cause: error },
    );
  }
  return parsed;
}

function readCreationAttempt(
  path: string,
  expectedDigest: string,
  expectedPreviousId?: string,
): IngestCreationAttemptV1 | null {
  const parsed = readJsonFile(path, 'creation attempt');
  if (parsed === null) return null;
  const attempt = parsed as Partial<IngestCreationAttemptV1> | null;
  if (
    !attempt
    || attempt.schema !== INGEST_CREATION_ATTEMPT_SCHEMA
    || attempt.schema_version !== INGEST_CREATION_ATTEMPT_SCHEMA_VERSION
    || attempt.manifest_digest !== expectedDigest
    || typeof attempt.attempt_id !== 'string'
    || !UUID_PATTERN.test(attempt.attempt_id)
    || typeof attempt.started_at !== 'string'
    || !Number.isFinite(Date.parse(attempt.started_at))
    || attempt.previous_attempt_id !== expectedPreviousId
  ) {
    throw new IngestUnknownWriteOutcomeError(
      `Creation attempt ${path} is invalid or belongs to another manifest; refusing to continue.`,
    );
  }
  const allowed = new Set([
    'schema', 'schema_version', 'manifest_digest', 'attempt_id', 'started_at',
    'previous_attempt_id',
  ]);
  const unknown = Object.keys(attempt).filter(key => !allowed.has(key));
  if (unknown.length > 0) {
    throw new IngestUnknownWriteOutcomeError(
      `Creation attempt ${path} contains unsupported field(s): ${unknown.join(', ')}.`,
    );
  }
  return attempt as IngestCreationAttemptV1;
}

function creationDecisionPath(rootPath: string, attemptId: string): string {
  if (!UUID_PATTERN.test(attemptId)) throw new Error('Invalid creation attempt ID.');
  return `${rootPath}.decision-${attemptId}.json`;
}

function nextCreationAttemptPath(rootPath: string, attemptId: string): string {
  if (!UUID_PATTERN.test(attemptId)) throw new Error('Invalid creation attempt ID.');
  return `${rootPath}.next-${attemptId}.json`;
}

function readCreationDecision(
  rootPath: string,
  attempt: IngestCreationAttemptV1,
): IngestCreationDecisionV1 | null {
  const path = creationDecisionPath(rootPath, attempt.attempt_id);
  const parsed = readJsonFile(path, 'creation decision');
  if (parsed === null) return null;
  const decision = parsed as Partial<IngestCreationDecisionV1> | null;
  if (
    !decision
    || decision.schema !== INGEST_CREATION_DECISION_SCHEMA
    || decision.schema_version !== INGEST_CREATION_DECISION_SCHEMA_VERSION
    || decision.manifest_digest !== attempt.manifest_digest
    || decision.attempt_id !== attempt.attempt_id
    || !['page', 'rejected'].includes(decision.kind ?? '')
    || typeof decision.decided_at !== 'string'
    || !Number.isFinite(Date.parse(decision.decided_at))
    || (decision.detail !== undefined && typeof decision.detail !== 'string')
  ) {
    throw new IngestUnknownWriteOutcomeError(
      `Creation decision ${path} is invalid; refusing to continue.`,
    );
  }
  const normalizedPageId = decision.page_id?.replaceAll('-', '').toLowerCase();
  if (
    (decision.kind === 'page' && (!normalizedPageId || !/^[0-9a-f]{32}$/.test(normalizedPageId)))
    || (decision.kind === 'rejected' && decision.page_id !== undefined)
  ) {
    throw new IngestUnknownWriteOutcomeError(
      `Creation decision ${path} has an invalid result; refusing to continue.`,
    );
  }
  const allowed = new Set([
    'schema', 'schema_version', 'manifest_digest', 'attempt_id', 'kind',
    'decided_at', 'page_id', 'detail',
  ]);
  const unknown = Object.keys(decision).filter(key => !allowed.has(key));
  if (unknown.length > 0) {
    throw new IngestUnknownWriteOutcomeError(
      `Creation decision ${path} contains unsupported field(s): ${unknown.join(', ')}.`,
    );
  }
  return decision as IngestCreationDecisionV1;
}

function fsyncParentDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(dirname(path), 'r');
    fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(code ?? '')) throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writeDurableExclusive(path: string, content: string): void {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const descriptor = openSync(temporaryPath, 'wx', 0o600);
  try {
    writeFileSync(descriptor, content, { encoding: 'utf8' });
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    linkSync(temporaryPath, path);
    fsyncParentDirectory(path);
  } finally {
    try {
      unlinkSync(temporaryPath);
      fsyncParentDirectory(temporaryPath);
    } catch {
      // A complete, linked destination is authoritative; a leftover temp is harmless.
    }
  }
}

function writeCreationRecordExclusive(
  path: string,
  record: IngestCreationAttemptV1 | IngestCreationDecisionV1,
): void {
  writeDurableExclusive(path, `${JSON.stringify(record, null, 2)}\n`);
}

type CreationJournalResolution =
  | {
    kind: 'available';
    path: string;
    previous_attempt_id?: string;
  }
  | {
    kind: 'undecided';
    attempt: IngestCreationAttemptV1;
  }
  | {
    kind: 'page';
    attempt: IngestCreationAttemptV1;
    decision: IngestCreationDecisionV1 & { kind: 'page'; page_id: string };
  };

function resolveCreationJournal(
  rootPath: string,
  manifestDigest: string,
): CreationJournalResolution {
  let path = rootPath;
  let previousAttemptId: string | undefined;
  const visited = new Set<string>();
  for (let depth = 0; depth < CREATION_JOURNAL_LIMIT; depth += 1) {
    const attempt = readCreationAttempt(path, manifestDigest, previousAttemptId);
    if (!attempt) {
      return {
        kind: 'available',
        path,
        ...(previousAttemptId ? { previous_attempt_id: previousAttemptId } : {}),
      };
    }
    if (visited.has(attempt.attempt_id)) {
      throw new IngestUnknownWriteOutcomeError('Creation journal contains an attempt cycle.');
    }
    visited.add(attempt.attempt_id);
    const decision = readCreationDecision(rootPath, attempt);
    if (!decision) return { kind: 'undecided', attempt };
    if (decision.kind === 'page' && decision.page_id) {
      return {
        kind: 'page',
        attempt,
        decision: decision as IngestCreationDecisionV1 & { kind: 'page'; page_id: string },
      };
    }
    previousAttemptId = attempt.attempt_id;
    path = nextCreationAttemptPath(rootPath, attempt.attempt_id);
  }
  throw new IngestUnknownWriteOutcomeError(
    `Creation journal exceeds ${CREATION_JOURNAL_LIMIT} attempts; refusing to continue.`,
  );
}

function createCreationAttempt(
  resolution: Extract<CreationJournalResolution, { kind: 'available' }>,
  manifestDigest: string,
  dependencies: IngestDependencies,
): IngestCreationAttemptV1 {
  const attempt: IngestCreationAttemptV1 = {
    schema: INGEST_CREATION_ATTEMPT_SCHEMA,
    schema_version: INGEST_CREATION_ATTEMPT_SCHEMA_VERSION,
    manifest_digest: manifestDigest,
    attempt_id: randomUUID(),
    started_at: nowIso(dependencies),
    ...(resolution.previous_attempt_id
      ? { previous_attempt_id: resolution.previous_attempt_id }
      : {}),
  };
  writeCreationRecordExclusive(resolution.path, attempt);
  return attempt;
}

function decideCreation(
  rootPath: string,
  attempt: IngestCreationAttemptV1,
  candidate: IngestCreationDecisionV1,
): IngestCreationDecisionV1 {
  const path = creationDecisionPath(rootPath, attempt.attempt_id);
  try {
    writeCreationRecordExclusive(path, candidate);
    return candidate;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const winner = readCreationDecision(rootPath, attempt);
    if (!winner) {
      throw new IngestUnknownWriteOutcomeError(
        `Creation decision ${path} raced with another process but could not be read safely.`,
        { cause: error },
      );
    }
    return winner;
  }
}

function plainText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.map((item) => {
    if (!item || typeof item !== 'object') return '';
    const richText = item as {
      plain_text?: unknown;
      text?: { content?: unknown };
    };
    if (typeof richText.plain_text === 'string') return richText.plain_text;
    return typeof richText.text?.content === 'string' ? richText.text.content : '';
  }).join('');
}

function pageProperty(page: Page, name: string): Record<string, unknown> | undefined {
  const value = page.properties[name];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function assertCreatedProperties(
  page: Page,
  target: NewPageTarget,
  artifact: IngestArtifactV1,
): void {
  if (target.parent.type === 'page_id') {
    if (artifact.title !== undefined) {
      const actual = plainText(pageProperty(page, 'title')?.title);
      if (actual !== artifact.title) {
        throw new IngestConflictError(
          `Created page ${page.id} does not have the digest-bound title.`,
        );
      }
    }
    return;
  }
  const bindings = target.property_bindings;
  if (!bindings) return;
  if (bindings.title_property && artifact.title !== undefined) {
    const actual = plainText(pageProperty(page, bindings.title_property)?.title);
    if (actual !== artifact.title) {
      throw new IngestConflictError(
        `Created page ${page.id} does not have the digest-bound title property.`,
      );
    }
  }
  if (bindings.source_url_property) {
    const actual = pageProperty(page, bindings.source_url_property)?.url;
    if (actual !== artifact.source_url) {
      throw new IngestConflictError(
        `Created page ${page.id} does not have the digest-bound source URL property.`,
      );
    }
  }
}

function safeCreationProperties(target: NewPageTarget, artifact: IngestArtifactV1): Record<string, unknown> | undefined {
  if (target.parent.type === 'page_id') {
    if (!artifact.title) return undefined;
    return { title: { title: [{ text: { content: artifact.title } }] } };
  }
  const bindings = target.property_bindings;
  if (!bindings) return undefined;
  const properties: Record<string, unknown> = {};
  if (bindings.title_property && artifact.title) {
    properties[bindings.title_property] = { title: [{ text: { content: artifact.title } }] };
  }
  if (bindings.source_url_property) {
    properties[bindings.source_url_property] = { url: artifact.source_url };
  }
  return Object.keys(properties).length === 0 ? undefined : properties;
}

function creationBody(target: NewPageTarget, artifact: IngestArtifactV1): Record<string, unknown> {
  const properties = safeCreationProperties(target, artifact);
  return {
    parent: { [target.parent.type]: target.parent.id },
    markdown: artifact.markdown,
    ...(properties === undefined ? {} : { properties }),
  };
}

async function assertCreationParent(
  target: NewPageTarget,
  client: IngestClient,
): Promise<void> {
  const path = target.parent.type === 'page_id'
    ? `pages/${target.parent.id}`
    : `data_sources/${target.parent.id}`;
  const parent = await client.get<Record<string, unknown>>(path);
  if (!parent || typeof parent !== 'object' || comparableId(parent.id as string) !== comparableId(target.parent.id)) {
    throw new IngestConflictError('The digest-bound creation parent could not be verified.');
  }
  if (target.parent.type !== 'data_source_id' || !target.property_bindings) return;
  const properties = parent.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new IngestConflictError('The parent data source returned no property schema.');
  }
  const schema = properties as Record<string, { type?: unknown }>;
  const bindings = target.property_bindings;
  if (
    bindings.title_property
    && schema[bindings.title_property]?.type !== 'title'
  ) {
    throw new IngestConflictError('The digest-bound title property is missing or no longer a title.');
  }
  if (
    bindings.source_url_property
    && schema[bindings.source_url_property]?.type !== 'url'
  ) {
    throw new IngestConflictError('The digest-bound source URL property is missing or no longer a URL.');
  }
}

function assertCreatedParent(page: Page, target: NewPageTarget): void {
  const actual = target.parent.type === 'page_id'
    ? page.parent?.page_id
    : page.parent?.data_source_id;
  if (comparableId(actual) !== comparableId(target.parent.id)) {
    throw new IngestConflictError(`Created page ${page.id} does not have the digest-bound parent.`);
  }
}

async function verifyCreatedPage(
  manifest: IngestManifestV1,
  pageId: string,
  dependencies: IngestDependencies,
): Promise<void> {
  if (manifest.target.kind !== 'new_page') throw new Error('Expected a new-page manifest.');
  const page = requirePage(
    await dependencies.client.get<Page>(`pages/${pageId}`),
    `Created page lookup for ${pageId}`,
  );
  assertCreatedParent(page, manifest.target);
  assertCreatedProperties(page, manifest.target, manifest.artifact);
  const markdown = await readCompleteMarkdown(
    dependencies.client,
    pageId,
    `Created page read for ${pageId}`,
  );
  await verifyExactContent(
    markdown,
    manifest.artifact,
    `Created page verification for ${pageId}`,
    dependencies.fetch,
    dependencies.lookup ?? defaultHostLookup,
  );
}

function completedCreationResult(manifest: IngestManifestV1, pageId: string, status: 'already_applied' | 'reconciled'): IngestApplyResult {
  return {
    status,
    operation: 'created',
    page_id: pageId,
    manifest_digest: manifest.digest,
  };
}

async function releaseLiveAttemptLock(lock: LiveAttemptLock): Promise<void> {
  try {
    await lock.release();
  } catch (error) {
    throw new IngestUnknownWriteOutcomeError(
      'The creation operation finished, but its live-attempt lock could not be released safely.',
      { cause: error },
    );
  }
}

async function withLiveAttemptLock<T>(
  canonicalManifestPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  let lock: LiveAttemptLock;
  try {
    lock = await acquireLiveAttemptLock(canonicalManifestPath);
  } catch (error) {
    const detail = error instanceof LiveAttemptLockError ? error.message : 'Lock setup failed.';
    throw new IngestUnknownWriteOutcomeError(
      `${detail} Refusing to race a page-creation outcome.`,
      { cause: error },
    );
  }
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    try {
      await lock.release();
    } catch {
      // Preserve the operation error. Process termination releases the OS listener.
    }
    throw error;
  }
  await releaseLiveAttemptLock(lock);
  return result;
}

function resolveManifestPath(manifestPath: string): string {
  try {
    return realpathSync(manifestPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new IngestManifestError(`Could not resolve ingestion manifest ${manifestPath}: ${detail}`);
  }
}

async function applyNewPageLocked(
  manifest: IngestManifestV1,
  manifestPath: string,
  dependencies: IngestDependencies,
): Promise<IngestApplyResult> {
  if (manifest.target.kind !== 'new_page') throw new Error('Expected a new-page manifest.');
  const statePath = creationStatePath(manifestPath);
  let attempt: IngestCreationAttemptV1;
  while (true) {
    const resolution = resolveCreationJournal(statePath, manifest.digest);
    if (resolution.kind === 'page') {
      await verifyCreatedPage(manifest, resolution.decision.page_id, dependencies);
      return completedCreationResult(
        manifest,
        resolution.decision.page_id,
        'already_applied',
      );
    }
    if (resolution.kind === 'undecided') {
      throw new IngestUnknownWriteOutcomeError(
        `A creation attempt for manifest ${manifest.digest} is reserved without a confirmed outcome. `
        + 'Do not retry blindly; after the original apply process has terminated, inspect Notion '
        + 'and reconcile an identified page explicitly.',
      );
    }
    await assertCreationParent(manifest.target, dependencies.client);
    try {
      attempt = createCreationAttempt(resolution, manifest.digest, dependencies);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
  }

  let created: Page;
  try {
    created = requirePage(await dependencies.client.post<Page>(
      'pages',
      creationBody(manifest.target, manifest.artifact),
      undefined,
      { retrySafe: false },
    ), 'Create page');
  } catch (error) {
    if (isKnownRejectedWrite(error)) {
      const rejected: IngestCreationDecisionV1 = {
        schema: INGEST_CREATION_DECISION_SCHEMA,
        schema_version: INGEST_CREATION_DECISION_SCHEMA_VERSION,
        manifest_digest: manifest.digest,
        attempt_id: attempt.attempt_id,
        kind: 'rejected',
        decided_at: nowIso(dependencies),
        detail: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
      };
      let winner: IngestCreationDecisionV1;
      try {
        winner = decideCreation(statePath, attempt, rejected);
      } catch (decisionError) {
        throw new IngestUnknownWriteOutcomeError(
          'Notion rejected page creation, but the durable rejection decision could not be recorded.',
          { cause: decisionError },
        );
      }
      if (winner.kind === 'page' && winner.page_id) {
        await verifyCreatedPage(manifest, winner.page_id, dependencies);
        return completedCreationResult(manifest, winner.page_id, 'reconciled');
      }
      throw error;
    }
    throw new IngestUnknownWriteOutcomeError(
      'Page creation did not return a confirmed page ID. The write may have succeeded; '
      + 'do not retry this manifest until the outcome is reconciled.',
      { cause: error },
    );
  }

  const completed: IngestCreationDecisionV1 = {
    schema: INGEST_CREATION_DECISION_SCHEMA,
    schema_version: INGEST_CREATION_DECISION_SCHEMA_VERSION,
    manifest_digest: manifest.digest,
    attempt_id: attempt.attempt_id,
    kind: 'page',
    decided_at: nowIso(dependencies),
    page_id: created.id,
  };
  let winner: IngestCreationDecisionV1;
  try {
    winner = decideCreation(statePath, attempt, completed);
  } catch (error) {
    throw new IngestUnknownWriteOutcomeError(
      `Notion created page ${created.id}, but its durable page decision could not be recorded. `
      + `Do not retry; reconcile page ${created.id} explicitly.`,
      { cause: error },
    );
  }
  if (winner.kind !== 'page' || !winner.page_id) {
    throw new IngestConflictError(
      `Notion created page ${created.id}, but this creation attempt was already recorded as rejected.`,
    );
  }
  if (comparableId(winner.page_id) !== comparableId(created.id)) {
    throw new IngestConflictError(
      `Notion created page ${created.id}, but reconciliation already confirmed a different page ID.`,
    );
  }
  await verifyCreatedPage(manifest, created.id, dependencies);
  return {
    status: 'applied',
    operation: 'created',
    page_id: created.id,
    manifest_digest: manifest.digest,
  };
}

async function applyNewPage(
  manifest: IngestManifestV1,
  manifestPath: string,
  dependencies: IngestDependencies,
): Promise<IngestApplyResult> {
  return withLiveAttemptLock(
    manifestPath,
    () => applyNewPageLocked(manifest, manifestPath, dependencies),
  );
}

export async function applyIngestion(
  manifestPath: string,
  expectedDigest: string,
  dependencies: IngestDependencies,
): Promise<IngestApplyResult> {
  const canonicalManifestPath = resolveManifestPath(manifestPath);
  const manifest = readIngestManifest(canonicalManifestPath, expectedDigest);
  return manifest.target.kind === 'existing_page'
    ? applyExistingPage(manifest, dependencies)
    : applyNewPage(manifest, canonicalManifestPath, dependencies);
}

async function reconcileIngestCreationLocked(
  manifestPath: string,
  expectedDigest: string,
  pageId: string,
  dependencies: IngestDependencies,
): Promise<IngestApplyResult> {
  const manifest = readIngestManifest(manifestPath, expectedDigest);
  if (manifest.target.kind !== 'new_page') {
    throw new IngestManifestError('Creation reconciliation requires a new-page manifest.');
  }
  const normalizedPageId = pageId.replaceAll('-', '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(normalizedPageId)) {
    throw new IngestManifestError('Creation reconciliation requires a Notion page ID.');
  }
  const statePath = creationStatePath(manifestPath);
  const resolution = resolveCreationJournal(statePath, manifest.digest);
  if (resolution.kind === 'available') {
    throw new IngestManifestError(
      'Creation reconciliation requires a recorded unknown creation outcome.',
    );
  }
  if (
    resolution.kind === 'page'
    && comparableId(resolution.decision.page_id) !== comparableId(pageId)
  ) {
    throw new IngestConflictError(
      `Creation journal ${statePath} already confirms a different page ID.`,
    );
  }
  await verifyCreatedPage(manifest, pageId, dependencies);
  if (resolution.kind === 'page') {
    return completedCreationResult(manifest, pageId, 'already_applied');
  }
  const candidate: IngestCreationDecisionV1 = {
    schema: INGEST_CREATION_DECISION_SCHEMA,
    schema_version: INGEST_CREATION_DECISION_SCHEMA_VERSION,
    manifest_digest: manifest.digest,
    attempt_id: resolution.attempt.attempt_id,
    kind: 'page',
    decided_at: nowIso(dependencies),
    page_id: pageId,
  };
  let winner: IngestCreationDecisionV1;
  try {
    winner = decideCreation(statePath, resolution.attempt, candidate);
  } catch (error) {
    throw new IngestUnknownWriteOutcomeError(
      `Could not durably reconcile page ${pageId}.`,
      { cause: error },
    );
  }
  if (winner.kind !== 'page' || !winner.page_id) {
    throw new IngestConflictError(
      'This creation attempt was already recorded as rejected and cannot be reconciled.',
    );
  }
  if (comparableId(winner.page_id) !== comparableId(pageId)) {
    throw new IngestConflictError(
      `Creation journal ${statePath} already confirms a different page ID.`,
    );
  }
  return completedCreationResult(manifest, pageId, 'reconciled');
}

export async function reconcileIngestCreation(
  manifestPath: string,
  expectedDigest: string,
  pageId: string,
  dependencies: IngestDependencies,
): Promise<IngestApplyResult> {
  const canonicalManifestPath = resolveManifestPath(manifestPath);
  return withLiveAttemptLock(
    canonicalManifestPath,
    () => reconcileIngestCreationLocked(
      canonicalManifestPath,
      expectedDigest,
      pageId,
      dependencies,
    ),
  );
}
