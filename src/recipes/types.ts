export const RECIPE_SCHEMA_VERSION = 1 as const;

export interface RecipeMatch {
  schemes?: string[];
  hosts?: string[];
  host_suffixes?: string[];
  path_prefixes?: string[];
}

export interface RecipeDescriptor {
  schema_version: typeof RECIPE_SCHEMA_VERSION;
  name: string;
  recipe_version: string;
  command: string[];
  entry: string;
  description?: string;
  match?: RecipeMatch;
}

export interface DiscoveredRecipe {
  descriptor: RecipeDescriptor;
  directory: string;
  descriptorPath: string;
  entryPath: string;
  executable: string;
  commandArguments: string[];
}

export interface RecipeRequest {
  schema_version: typeof RECIPE_SCHEMA_VERSION;
  source_url: string;
}

export interface RecipeArtifactAsset {
  source_url: string;
  asset_type: 'image' | 'video' | 'audio' | 'file' | 'pdf';
  sha256: string;
  byte_length: number;
  content_type?: string;
}

export interface RecipeArtifact {
  schema_version: typeof RECIPE_SCHEMA_VERSION;
  source_url: string;
  title?: string;
  markdown: string;
  assets?: RecipeArtifactAsset[];
}

export interface RecipeSelectionOptions {
  recipeName?: string;
  sourceUrl: string;
}

export interface RunRecipeOptions {
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  env?: NodeJS.ProcessEnv;
  onStderr?: (chunk: string) => void;
}

export interface RecipeRunResult {
  artifact: RecipeArtifact;
  stderr: string;
  durationMs: number;
}

export type RecipeErrorCode =
  | 'invalid_descriptor'
  | 'invalid_request'
  | 'invalid_artifact'
  | 'unsafe_path'
  | 'duplicate_recipe'
  | 'recipe_not_found'
  | 'ambiguous_recipe'
  | 'spawn_failed'
  | 'recipe_timeout'
  | 'stdout_limit'
  | 'stderr_limit'
  | 'recipe_failed'
  | 'invalid_output';

export class RecipeError extends Error {
  readonly code: RecipeErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: RecipeErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RecipeError';
    this.code = code;
    this.details = details;
  }
}
