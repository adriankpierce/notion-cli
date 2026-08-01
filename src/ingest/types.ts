/** Closed protocol types for staging and applying recipe-produced Markdown. */

export const INGEST_ARTIFACT_SCHEMA_VERSION = 1 as const;
export const INGEST_MANIFEST_SCHEMA = 'notion-cli.ingest-manifest' as const;
export const INGEST_MANIFEST_SCHEMA_VERSION = 1 as const;
export const INGEST_CREATION_ATTEMPT_SCHEMA = 'notion-cli.ingest-creation-attempt' as const;
export const INGEST_CREATION_ATTEMPT_SCHEMA_VERSION = 1 as const;
export const INGEST_CREATION_DECISION_SCHEMA = 'notion-cli.ingest-creation-decision' as const;
export const INGEST_CREATION_DECISION_SCHEMA_VERSION = 1 as const;
export const MAX_INGEST_MARKDOWN_BYTES = 1024 * 1024;
export const MAX_INGEST_ASSETS = 128;
export const MAX_INGEST_ASSET_BYTES = 128 * 1024 * 1024;
export const MAX_INGEST_TOTAL_ASSET_BYTES = 512 * 1024 * 1024;

export type IngestAssetType = 'image' | 'video' | 'audio' | 'file' | 'pdf';

/** Optional provenance for an asset already referenced by the enhanced Markdown. */
export interface IngestAssetAttestation {
  asset_type: IngestAssetType;
  source_url: string;
  sha256: string;
  byte_length: number;
  content_type?: string;
}

/** Content-only output from a recipe. It deliberately contains no executable behavior. */
export interface IngestArtifactV1 {
  schema_version: typeof INGEST_ARTIFACT_SCHEMA_VERSION;
  source_url: string;
  markdown: string;
  title?: string;
  assets?: IngestAssetAttestation[];
}

export interface IngestRecipeIdentity {
  name: string;
  release: string;
  requested_url: string;
}

export interface ExistingPageTarget {
  kind: 'existing_page';
  page_id: string;
}

export interface NewPagePropertyBindings {
  /** Data-source property that receives artifact.title as a title value. */
  title_property?: string;
  /** Data-source property that receives artifact.source_url as a URL value. */
  source_url_property?: string;
}

export interface NewPageTarget {
  kind: 'new_page';
  parent: {
    type: 'page_id' | 'data_source_id';
    id: string;
  };
  /** Only safe title and URL shapes are supported; arbitrary property payloads are not. */
  property_bindings?: NewPagePropertyBindings;
}

export type IngestTarget = ExistingPageTarget | NewPageTarget;

export interface IngestStageRequest {
  recipe: IngestRecipeIdentity;
  target: IngestTarget;
  artifact: unknown;
}

export interface ExistingPageSnapshot {
  page_id: string;
  last_edited_time: string;
  markdown: string;
  markdown_sha256: string;
}

export interface IngestManifestPayloadV1 {
  schema: typeof INGEST_MANIFEST_SCHEMA;
  schema_version: typeof INGEST_MANIFEST_SCHEMA_VERSION;
  staged_at: string;
  recipe: IngestRecipeIdentity;
  target: IngestTarget;
  artifact: IngestArtifactV1;
  existing_page_snapshot?: ExistingPageSnapshot;
}

export interface IngestManifestV1 extends IngestManifestPayloadV1 {
  digest: string;
}

export type IngestApplyStatus = 'applied' | 'already_applied' | 'reconciled';
export type IngestApplyOperation = 'updated' | 'created';

export interface IngestApplyResult {
  status: IngestApplyStatus;
  operation: IngestApplyOperation;
  page_id: string;
  manifest_digest: string;
}

export interface IngestCreationAttemptV1 {
  schema: typeof INGEST_CREATION_ATTEMPT_SCHEMA;
  schema_version: typeof INGEST_CREATION_ATTEMPT_SCHEMA_VERSION;
  manifest_digest: string;
  attempt_id: string;
  started_at: string;
  previous_attempt_id?: string;
}

export interface IngestCreationDecisionV1 {
  schema: typeof INGEST_CREATION_DECISION_SCHEMA;
  schema_version: typeof INGEST_CREATION_DECISION_SCHEMA_VERSION;
  manifest_digest: string;
  attempt_id: string;
  kind: 'page' | 'rejected';
  decided_at: string;
  page_id?: string;
  detail?: string;
}

type QueryValue = string | number | boolean;

/** Minimal structural client contract accepted by the ingestion engine. */
export interface IngestClient {
  get<T = unknown>(
    path: string,
    query?: Record<string, QueryValue | readonly QueryValue[] | undefined>,
  ): Promise<T>;
  post<T = unknown>(
    path: string,
    body?: Record<string, unknown>,
    query?: Record<string, QueryValue | readonly QueryValue[] | undefined>,
    options?: { retrySafe?: boolean },
  ): Promise<T>;
  patch<T = unknown>(path: string, body?: Record<string, unknown>): Promise<T>;
}

export interface IngestDependencies {
  client: IngestClient;
  now?: () => Date;
  fetch?: typeof globalThis.fetch;
  lookup?: (hostname: string) => Promise<readonly {
    address: string;
    family: number;
  }[]>;
}
