import {
  RECIPE_SCHEMA_VERSION,
  RecipeError,
  type RecipeArtifact,
  type RecipeDescriptor,
  type RecipeMatch,
  type RecipeRequest,
} from './types.js';
import {
  MAX_INGEST_ASSET_BYTES,
  MAX_INGEST_ASSETS,
  MAX_INGEST_MARKDOWN_BYTES,
} from '../ingest/types.js';
import { validateIngestArtifact } from '../ingest/validation.js';

export const MAX_DESCRIPTOR_BYTES = 64 * 1024;
export const MAX_ASSETS = MAX_INGEST_ASSETS;

const URL_SCHEMA = { type: 'string', format: 'uri', maxLength: 8192 } as const;

export const RECIPE_DESCRIPTOR_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'name', 'recipe_version', 'command', 'entry'],
  properties: {
    schema_version: { const: RECIPE_SCHEMA_VERSION },
    name: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,63}$' },
    recipe_version: { type: 'string', minLength: 1, maxLength: 64 },
    command: {
      type: 'array', minItems: 1, maxItems: 128,
      items: { type: 'string', minLength: 1, maxLength: 4096 },
    },
    entry: { type: 'string', minLength: 1, maxLength: 1024 },
    description: { type: 'string', minLength: 1, maxLength: 1024 },
    match: {
      type: 'object', additionalProperties: false, minProperties: 1,
      properties: {
        schemes: { type: 'array', minItems: 1, maxItems: 32, uniqueItems: true, items: { type: 'string' } },
        hosts: { type: 'array', minItems: 1, maxItems: 32, uniqueItems: true, items: { type: 'string' } },
        host_suffixes: { type: 'array', minItems: 1, maxItems: 32, uniqueItems: true, items: { type: 'string' } },
        path_prefixes: { type: 'array', minItems: 1, maxItems: 32, uniqueItems: true, items: { type: 'string' } },
      },
    },
  },
} as const;

export const RECIPE_REQUEST_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object', additionalProperties: false,
  required: ['schema_version', 'source_url'],
  properties: { schema_version: { const: RECIPE_SCHEMA_VERSION }, source_url: URL_SCHEMA },
} as const;

export const RECIPE_ARTIFACT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object', additionalProperties: false,
  required: ['schema_version', 'source_url', 'markdown'],
  properties: {
    schema_version: { const: RECIPE_SCHEMA_VERSION },
    source_url: URL_SCHEMA,
    title: { type: 'string', minLength: 1, maxLength: 1000 },
    markdown: { type: 'string', minLength: 1, maxLength: MAX_INGEST_MARKDOWN_BYTES },
    assets: {
      type: 'array', maxItems: MAX_ASSETS,
      items: {
        type: 'object', additionalProperties: false,
        required: ['source_url', 'asset_type', 'sha256', 'byte_length'],
        properties: {
          source_url: URL_SCHEMA,
          asset_type: { enum: ['image', 'video', 'audio', 'file', 'pdf'] },
          sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          byte_length: { type: 'integer', minimum: 0, maximum: MAX_INGEST_ASSET_BYTES },
          content_type: { type: 'string', minLength: 1, maxLength: 256 },
        },
      },
    },
  },
} as const;

type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string, code: 'invalid_descriptor' | 'invalid_request' | 'invalid_artifact'): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RecipeError(code, `${label} must be a JSON object`);
  }
  return value as JsonObject;
}

function exact(value: JsonObject, required: readonly string[], optional: readonly string[], label: string, code: 'invalid_descriptor' | 'invalid_request' | 'invalid_artifact'): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new RecipeError(code, `${label} contains unknown property ${JSON.stringify(key)}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new RecipeError(code, `${label} is missing ${JSON.stringify(key)}`);
  }
}

function boundedString(value: unknown, label: string, max: number, code: 'invalid_descriptor' | 'invalid_artifact'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0')) {
    throw new RecipeError(code, `${label} must be a non-empty string of at most ${max} characters`);
  }
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

export function canonicalHttpUrl(value: unknown, label = 'URL'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192) {
    throw new RecipeError('invalid_request', `${label} must be an HTTP(S) URL`);
  }
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new RecipeError('invalid_request', `${label} must be an HTTP(S) URL`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new RecipeError('invalid_request', `${label} must be an HTTP(S) URL without credentials`);
  }
  return parsed.href;
}

function requireCanonicalUrl(value: unknown, label: string, code: 'invalid_request' | 'invalid_artifact'): string {
  let canonical: string;
  try { canonical = canonicalHttpUrl(value, label); } catch (error) {
    throw new RecipeError(code, `${label} must be an HTTP(S) URL without credentials`, undefined, { cause: error });
  }
  if (canonical !== value) throw new RecipeError(code, `${label} must use its canonical URL form`);
  return canonical;
}

function stringArray(value: unknown, label: string, validate: (item: string) => boolean): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) throw new RecipeError('invalid_descriptor', `${label} must be a non-empty array`);
  const result = value.map((item) => {
    if (typeof item !== 'string' || item.length === 0 || item.length > 1024 || !validate(item)) throw new RecipeError('invalid_descriptor', `${label} contains an invalid value`);
    return item;
  });
  if (new Set(result).size !== result.length) throw new RecipeError('invalid_descriptor', `${label} must not contain duplicates`);
  return result;
}

function validateHost(host: string): boolean {
  if (host !== host.toLowerCase() || /[:/@]/u.test(host)) return false;
  try { return new URL(`http://${host}/`).hostname === host; } catch { return false; }
}

function validateMatch(value: unknown): RecipeMatch {
  const match = object(value, 'match', 'invalid_descriptor');
  exact(match, [], ['schemes', 'hosts', 'host_suffixes', 'path_prefixes'], 'match', 'invalid_descriptor');
  if (Object.keys(match).length === 0) throw new RecipeError('invalid_descriptor', 'match must contain at least one matcher');
  const result: RecipeMatch = {};
  if (match.schemes !== undefined) result.schemes = stringArray(match.schemes, 'match.schemes', (item) => /^[a-z][a-z0-9+.-]*$/u.test(item));
  if (match.hosts !== undefined) result.hosts = stringArray(match.hosts, 'match.hosts', validateHost);
  if (match.host_suffixes !== undefined) result.host_suffixes = stringArray(match.host_suffixes, 'match.host_suffixes', validateHost);
  if (match.path_prefixes !== undefined) result.path_prefixes = stringArray(match.path_prefixes, 'match.path_prefixes', (item) => item.startsWith('/') && !/[?#\\\0]/u.test(item));
  return result;
}

export function validateRecipeDescriptor(value: unknown): RecipeDescriptor {
  const descriptor = object(value, 'recipe descriptor', 'invalid_descriptor');
  exact(descriptor, ['schema_version', 'name', 'recipe_version', 'command', 'entry'], ['description', 'match'], 'recipe descriptor', 'invalid_descriptor');
  if (descriptor.schema_version !== RECIPE_SCHEMA_VERSION) throw new RecipeError('invalid_descriptor', 'recipe descriptor schema_version must be 1');
  const name = boundedString(descriptor.name, 'name', 64, 'invalid_descriptor');
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(name)) throw new RecipeError('invalid_descriptor', 'name must be a lowercase recipe identifier');
  if (name === 'auto') throw new RecipeError('invalid_descriptor', 'auto is reserved for recipe selection');
  const recipeVersion = boundedString(descriptor.recipe_version, 'recipe_version', 64, 'invalid_descriptor');
  if (/\p{Cc}/u.test(recipeVersion)) throw new RecipeError('invalid_descriptor', 'recipe_version must not contain control characters');
  if (!Array.isArray(descriptor.command) || descriptor.command.length === 0 || descriptor.command.length > 128) throw new RecipeError('invalid_descriptor', 'command must be a non-empty string array');
  const command = descriptor.command.map((part) => boundedString(part, 'command item', 4096, 'invalid_descriptor'));
  const entry = boundedString(descriptor.entry, 'entry', 1024, 'invalid_descriptor');
  const result: RecipeDescriptor = { schema_version: RECIPE_SCHEMA_VERSION, name, recipe_version: recipeVersion, command, entry };
  if (descriptor.description !== undefined) result.description = boundedString(descriptor.description, 'description', 1024, 'invalid_descriptor');
  if (descriptor.match !== undefined) result.match = validateMatch(descriptor.match);
  return result;
}

export function createRecipeRequest(sourceUrl: string): RecipeRequest {
  return { schema_version: RECIPE_SCHEMA_VERSION, source_url: canonicalHttpUrl(sourceUrl, 'source_url') };
}

export function validateRecipeRequest(value: unknown): RecipeRequest {
  const request = object(value, 'recipe request', 'invalid_request');
  exact(request, ['schema_version', 'source_url'], [], 'recipe request', 'invalid_request');
  if (request.schema_version !== RECIPE_SCHEMA_VERSION) throw new RecipeError('invalid_request', 'recipe request schema_version must be 1');
  return { schema_version: RECIPE_SCHEMA_VERSION, source_url: requireCanonicalUrl(request.source_url, 'source_url', 'invalid_request') };
}

export function validateRecipeArtifact(value: unknown): RecipeArtifact {
  const artifact = object(value, 'recipe artifact', 'invalid_artifact');
  exact(artifact, ['schema_version', 'source_url', 'markdown'], ['title', 'assets'], 'recipe artifact', 'invalid_artifact');
  if (artifact.schema_version !== RECIPE_SCHEMA_VERSION) throw new RecipeError('invalid_artifact', 'recipe artifact schema_version must be 1');
  if (
    typeof artifact.markdown !== 'string'
    || artifact.markdown.length === 0
    || artifact.markdown.length > MAX_INGEST_MARKDOWN_BYTES
    || Buffer.byteLength(artifact.markdown, 'utf8') > MAX_INGEST_MARKDOWN_BYTES
    || artifact.markdown.includes('\0')
    || containsUnsupportedControl(artifact.markdown)
  ) {
    throw new RecipeError(
      'invalid_artifact',
      `markdown must be a non-empty string of at most ${MAX_INGEST_MARKDOWN_BYTES} ` +
      'UTF-8 bytes without unsupported control characters',
    );
  }
  const result: RecipeArtifact = {
    schema_version: RECIPE_SCHEMA_VERSION,
    source_url: requireCanonicalUrl(artifact.source_url, 'source_url', 'invalid_artifact'),
    markdown: artifact.markdown,
  };
  if (artifact.title !== undefined) {
    const title = boundedString(artifact.title, 'title', 1000, 'invalid_artifact');
    if (title.trim().length === 0) throw new RecipeError('invalid_artifact', 'title must not be blank');
    result.title = title;
  }
  if (artifact.assets !== undefined) {
    if (!Array.isArray(artifact.assets) || artifact.assets.length > MAX_ASSETS) throw new RecipeError('invalid_artifact', `assets must contain at most ${MAX_ASSETS} entries`);
    const seen = new Set<string>();
    result.assets = artifact.assets.map((raw, index) => {
      const asset = object(raw, `assets[${index}]`, 'invalid_artifact');
      exact(
        asset,
        ['source_url', 'asset_type', 'sha256', 'byte_length'],
        ['content_type'],
        `assets[${index}]`,
        'invalid_artifact',
      );
      const sourceUrl = requireCanonicalUrl(
        asset.source_url,
        `assets[${index}].source_url`,
        'invalid_artifact',
      );
      if (seen.has(sourceUrl)) {
        throw new RecipeError(
          'invalid_artifact',
          `assets contains duplicate source URL ${JSON.stringify(sourceUrl)}`,
        );
      }
      seen.add(sourceUrl);
      if (
        typeof asset.asset_type !== 'string'
        || !['image', 'video', 'audio', 'file', 'pdf'].includes(asset.asset_type)
      ) {
        throw new RecipeError('invalid_artifact', `assets[${index}].asset_type is invalid`);
      }
      if (typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(asset.sha256)) throw new RecipeError('invalid_artifact', `assets[${index}].sha256 is invalid`);
      if (
        !Number.isSafeInteger(asset.byte_length)
        || (asset.byte_length as number) < 0
        || (asset.byte_length as number) > MAX_INGEST_ASSET_BYTES
      ) {
        throw new RecipeError(
          'invalid_artifact',
          `assets[${index}].byte_length must be between 0 and ${MAX_INGEST_ASSET_BYTES}`,
        );
      }
      const contentType = asset.content_type === undefined
        ? undefined
        : boundedString(asset.content_type, `assets[${index}].content_type`, 256, 'invalid_artifact');
      return {
        source_url: sourceUrl,
        asset_type: asset.asset_type as NonNullable<RecipeArtifact['assets']>[number]['asset_type'],
        sha256: asset.sha256,
        byte_length: asset.byte_length as number,
        ...(contentType === undefined ? {} : { content_type: contentType }),
      };
    });
  }
  try {
    validateIngestArtifact(result);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new RecipeError(
      'invalid_artifact',
      `recipe artifact cannot be ingested safely: ${detail}`,
      undefined,
      { cause: error },
    );
  }
  return result;
}
