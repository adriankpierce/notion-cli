import { normalizeNotionId } from '../utils/database-resolver.js';
import {
  INGEST_ARTIFACT_SCHEMA_VERSION,
  MAX_INGEST_ASSETS,
  MAX_INGEST_ASSET_BYTES,
  MAX_INGEST_MARKDOWN_BYTES,
  MAX_INGEST_TOTAL_ASSET_BYTES,
  type IngestArtifactV1,
  type IngestAssetAttestation,
  type IngestRecipeIdentity,
  type IngestStageRequest,
  type IngestTarget,
  type NewPagePropertyBindings,
} from './types.js';
import { canonicalizeEnhancedMarkdown } from './verification.js';

const SHA256 = /^[0-9a-f]{64}$/;
const MIME_TYPE = /^[!#$&^_.+a-z0-9-]+\/[!#$&^_.+a-z0-9-]+$/i;
const ASSET_TYPES = new Set(['image', 'video', 'audio', 'file', 'pdf']);

export class IngestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IngestValidationError';
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IngestValidationError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new IngestValidationError(`${label} contains unsupported field(s): ${unknown.join(', ')}.`);
  }
}

function nonEmptyString(value: unknown, label: string, maximum = 10_000): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new IngestValidationError(`${label} must be a non-empty string.`);
  }
  if (value.length > maximum) throw new IngestValidationError(`${label} is too long.`);
  return value;
}

function containsUnsupportedControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) as number;
    if ((codePoint < 32 && ![9, 10, 13].includes(codePoint)) || codePoint === 127) {
      return true;
    }
  }
  return false;
}

function webUrl(value: unknown, label: string): string {
  const text = nonEmptyString(value, label);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new IngestValidationError(`${label} must be an absolute HTTP(S) URL.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new IngestValidationError(`${label} must be an absolute HTTP(S) URL without credentials.`);
  }
  return parsed.href;
}

function notionId(value: unknown, label: string): string {
  const text = nonEmptyString(value, label, 2_000);
  try {
    return normalizeNotionId(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new IngestValidationError(`${label} is invalid: ${detail}`);
  }
}

function propertyName(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return nonEmptyString(value, label, 1_000);
}

function validateAsset(input: unknown, index: number): IngestAssetAttestation {
  const asset = record(input, `artifact.assets[${index}]`);
  rejectUnknownKeys(
    asset,
    ['asset_type', 'source_url', 'sha256', 'byte_length', 'content_type'],
    `artifact.assets[${index}]`,
  );
  if (typeof asset.asset_type !== 'string' || !ASSET_TYPES.has(asset.asset_type)) {
    throw new IngestValidationError(`artifact.assets[${index}].asset_type is unsupported.`);
  }
  if (typeof asset.sha256 !== 'string' || !SHA256.test(asset.sha256)) {
    throw new IngestValidationError(`artifact.assets[${index}].sha256 must be lowercase SHA-256.`);
  }
  if (
    !Number.isSafeInteger(asset.byte_length)
    || Number(asset.byte_length) < 0
    || Number(asset.byte_length) > MAX_INGEST_ASSET_BYTES
  ) {
    throw new IngestValidationError(
      `artifact.assets[${index}].byte_length must be between 0 and ` +
      `${MAX_INGEST_ASSET_BYTES}.`,
    );
  }
  const contentType = asset.content_type === undefined
    ? undefined
    : nonEmptyString(asset.content_type, `artifact.assets[${index}].content_type`, 256)
      .toLowerCase();
  if (contentType !== undefined && !MIME_TYPE.test(contentType)) {
    throw new IngestValidationError(
      `artifact.assets[${index}].content_type must be a MIME type without parameters.`,
    );
  }
  return {
    asset_type: asset.asset_type as IngestAssetAttestation['asset_type'],
    source_url: webUrl(asset.source_url, `artifact.assets[${index}].source_url`),
    sha256: asset.sha256,
    byte_length: Number(asset.byte_length),
    ...(contentType === undefined ? {} : { content_type: contentType }),
  };
}

export function validateIngestArtifact(input: unknown): IngestArtifactV1 {
  const artifact = record(input, 'artifact');
  rejectUnknownKeys(artifact, ['schema_version', 'source_url', 'markdown', 'title', 'assets'], 'artifact');
  if (artifact.schema_version !== INGEST_ARTIFACT_SCHEMA_VERSION) {
    throw new IngestValidationError(
      `artifact.schema_version must be ${INGEST_ARTIFACT_SCHEMA_VERSION}.`,
    );
  }
  const markdown = nonEmptyString(
    artifact.markdown,
    'artifact.markdown',
    MAX_INGEST_MARKDOWN_BYTES,
  );
  if (Buffer.byteLength(markdown, 'utf8') > MAX_INGEST_MARKDOWN_BYTES) {
    throw new IngestValidationError(
      `artifact.markdown exceeds ${MAX_INGEST_MARKDOWN_BYTES} UTF-8 bytes.`,
    );
  }
  if (containsUnsupportedControl(markdown)) {
    throw new IngestValidationError(
      'artifact.markdown contains unsupported control characters.',
    );
  }
  const title = artifact.title === undefined
    ? undefined
    : nonEmptyString(artifact.title, 'artifact.title', 2_000);
  if (artifact.assets !== undefined && !Array.isArray(artifact.assets)) {
    throw new IngestValidationError('artifact.assets must be an array.');
  }
  if (Array.isArray(artifact.assets) && artifact.assets.length > MAX_INGEST_ASSETS) {
    throw new IngestValidationError(
      `artifact.assets cannot contain more than ${MAX_INGEST_ASSETS} items.`,
    );
  }
  const assets = artifact.assets === undefined
    ? undefined
    : artifact.assets.map((asset, index) => validateAsset(asset, index));
  if (assets) {
    const totalBytes = assets.reduce((total, asset) => total + asset.byte_length, 0);
    if (totalBytes > MAX_INGEST_TOTAL_ASSET_BYTES) {
      throw new IngestValidationError(
        `artifact.assets exceeds the ${MAX_INGEST_TOTAL_ASSET_BYTES}-byte aggregate limit.`,
      );
    }
    const bySource = new Map<string, IngestAssetAttestation>();
    for (const asset of assets) {
      if (bySource.has(asset.source_url)) {
        throw new IngestValidationError(
          `artifact.assets repeats source URL ${asset.source_url}.`,
        );
      }
      bySource.set(asset.source_url, asset);
    }
    const media = canonicalizeEnhancedMarkdown(markdown).media;
    const mediaSources = new Set(media.map(item => item.source));
    for (const item of media) {
      const asset = bySource.get(item.source);
      if (!asset) {
        throw new IngestValidationError(
          `artifact.assets has no attestation for ${item.type} ${item.source}.`,
        );
      }
      if (asset.asset_type !== item.type) {
        throw new IngestValidationError(
          `artifact asset ${item.source} has type ${asset.asset_type}, expected ${item.type}.`,
        );
      }
    }
    for (const source of bySource.keys()) {
      if (!mediaSources.has(source)) {
        throw new IngestValidationError(
          `artifact asset ${source} is not referenced by an enhanced-Markdown media block.`,
        );
      }
    }
  }
  return {
    schema_version: INGEST_ARTIFACT_SCHEMA_VERSION,
    source_url: webUrl(artifact.source_url, 'artifact.source_url'),
    markdown,
    ...(title === undefined ? {} : { title }),
    ...(assets === undefined ? {} : { assets }),
  };
}

function validateRecipe(input: unknown): IngestRecipeIdentity {
  const recipe = record(input, 'recipe');
  rejectUnknownKeys(recipe, ['name', 'release', 'requested_url'], 'recipe');
  return {
    name: nonEmptyString(recipe.name, 'recipe.name', 256),
    release: nonEmptyString(recipe.release, 'recipe.release', 256),
    requested_url: webUrl(recipe.requested_url, 'recipe.requested_url'),
  };
}

function validateBindings(input: unknown): NewPagePropertyBindings | undefined {
  if (input === undefined) return undefined;
  const bindings = record(input, 'target.property_bindings');
  rejectUnknownKeys(bindings, ['title_property', 'source_url_property'], 'target.property_bindings');
  const titleProperty = propertyName(bindings.title_property, 'target.property_bindings.title_property');
  const sourceUrlProperty = propertyName(
    bindings.source_url_property,
    'target.property_bindings.source_url_property',
  );
  if (titleProperty === undefined && sourceUrlProperty === undefined) {
    throw new IngestValidationError('target.property_bindings must bind at least one safe property.');
  }
  if (titleProperty !== undefined && titleProperty === sourceUrlProperty) {
    throw new IngestValidationError('Title and source URL bindings must use different properties.');
  }
  return {
    ...(titleProperty === undefined ? {} : { title_property: titleProperty }),
    ...(sourceUrlProperty === undefined ? {} : { source_url_property: sourceUrlProperty }),
  };
}

function validateTarget(input: unknown): IngestTarget {
  const target = record(input, 'target');
  if (target.kind === 'existing_page') {
    rejectUnknownKeys(target, ['kind', 'page_id'], 'target');
    return { kind: 'existing_page', page_id: notionId(target.page_id, 'target.page_id') };
  }
  if (target.kind !== 'new_page') {
    throw new IngestValidationError('target.kind must be existing_page or new_page.');
  }
  rejectUnknownKeys(target, ['kind', 'parent', 'property_bindings'], 'target');
  const parent = record(target.parent, 'target.parent');
  rejectUnknownKeys(parent, ['type', 'id'], 'target.parent');
  if (parent.type !== 'page_id' && parent.type !== 'data_source_id') {
    throw new IngestValidationError('target.parent.type must be page_id or data_source_id.');
  }
  const bindings = validateBindings(target.property_bindings);
  if (parent.type === 'page_id' && bindings !== undefined) {
    throw new IngestValidationError('Property bindings are only supported for data-source parents.');
  }
  return {
    kind: 'new_page',
    parent: { type: parent.type, id: notionId(parent.id, 'target.parent.id') },
    ...(bindings === undefined ? {} : { property_bindings: bindings }),
  };
}

export function validateIngestStageRequest(input: IngestStageRequest): {
  recipe: IngestRecipeIdentity;
  target: IngestTarget;
  artifact: IngestArtifactV1;
} {
  const request = record(input, 'stage request');
  rejectUnknownKeys(request, ['recipe', 'target', 'artifact'], 'stage request');
  const artifact = validateIngestArtifact(request.artifact);
  const target = validateTarget(request.target);
  if (
    target.kind === 'new_page'
    && artifact.title === undefined
  ) {
    throw new IngestValidationError('New-page ingestion requires artifact.title.');
  }
  if (
    target.kind === 'new_page'
    && target.parent.type === 'data_source_id'
    && !target.property_bindings?.title_property
  ) {
    throw new IngestValidationError(
      'Data-source page creation requires a digest-bound title property.',
    );
  }
  return { recipe: validateRecipe(request.recipe), target, artifact };
}
