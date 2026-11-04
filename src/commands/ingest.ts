/** Stage, apply, and reconcile digest-bound recipe ingestion. */
import { Command } from 'commander';
import { getClient } from '../client.js';
import {
  applyIngestion,
  reconcileIngestCreation,
  stageIngestion,
  type IngestArtifactV1,
  type IngestClient,
  type IngestStageRequest,
  type IngestTarget,
  type NewPagePropertyBindings,
} from '../ingest/index.js';
import type { RecipeArtifact } from '../recipes/index.js';
import { resolveDatabase } from '../utils/database-resolver.js';
import { resolvePropertyName } from '../utils/notion-helpers.js';
import { formatOutput } from '../utils/format.js';
import { withErrorHandler } from '../utils/command-handler.js';
import { executeRecipe } from './recipes.js';

interface StageOptions {
  recipe: string;
  recipesDir: string[];
  timeout?: string;
  page?: string;
  parent?: string;
  parentType?: string;
  titleProperty?: string;
  sourceUrlProperty?: string;
  manifest: string;
}

interface DigestOptions {
  expectDigest: string;
}

interface ReconcileOptions extends DigestOptions {
  page: string;
}

const unreachableClient: IngestClient = {
  async get<T>(): Promise<T> {
    throw new Error('Auth-free staging unexpectedly attempted to read Notion.');
  },
  async post<T>(): Promise<T> {
    throw new Error('Auth-free staging unexpectedly attempted to write Notion.');
  },
  async patch<T>(): Promise<T> {
    throw new Error('Auth-free staging unexpectedly attempted to write Notion.');
  },
};

function collectDirectory(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function toIngestArtifact(artifact: RecipeArtifact): IngestArtifactV1 {
  return {
    schema_version: 1,
    source_url: artifact.source_url,
    markdown: artifact.markdown,
    ...(artifact.title === undefined ? {} : { title: artifact.title }),
    ...(artifact.assets === undefined ? {} : {
      assets: artifact.assets.map(asset => ({ ...asset })),
    }),
  };
}

function propertyBindings(options: StageOptions): NewPagePropertyBindings | undefined {
  if (!options.titleProperty && !options.sourceUrlProperty) return undefined;
  return {
    ...(options.titleProperty ? { title_property: options.titleProperty } : {}),
    ...(options.sourceUrlProperty ? { source_url_property: options.sourceUrlProperty } : {}),
  };
}

function validatedPropertyBindings(
  bindings: NewPagePropertyBindings | undefined,
  schema: Record<string, { type: string }>,
): NewPagePropertyBindings {
  const validate = (
    supplied: string | undefined,
    expectedType: 'title' | 'url',
    option: string,
  ): string | undefined => {
    if (!supplied) return undefined;
    const canonical = resolvePropertyName(schema, supplied);
    if (!canonical) throw new Error(`${option} property ${JSON.stringify(supplied)} was not found.`);
    if (schema[canonical].type !== expectedType) {
      throw new Error(
        `${option} property ${JSON.stringify(canonical)} must have type ${expectedType}.`,
      );
    }
    return canonical;
  };
  const configuredTitle = validate(bindings?.title_property, 'title', '--title-property');
  const detectedTitles = Object.entries(schema)
    .filter(([_name, property]) => property.type === 'title')
    .map(([name]) => name);
  const titleProperty = configuredTitle ?? detectedTitles[0];
  if (!titleProperty) throw new Error('The parent data source has no title property.');
  const sourceUrlProperty = validate(bindings?.source_url_property, 'url', '--source-url-property');
  return {
    title_property: titleProperty,
    ...(sourceUrlProperty ? { source_url_property: sourceUrlProperty } : {}),
  };
}

async function stageTarget(options: StageOptions): Promise<{
  target: IngestTarget;
  client: IngestClient;
}> {
  const hasPage = options.page !== undefined;
  const hasParent = options.parent !== undefined;
  if (hasPage === hasParent) {
    throw new Error('Pass exactly one target: --page, or --parent with --parent-type.');
  }
  const bindings = propertyBindings(options);
  if (hasPage) {
    if (options.parentType || bindings) {
      throw new Error('--parent-type and property bindings require --parent.');
    }
    return {
      target: { kind: 'existing_page', page_id: options.page as string },
      client: getClient(),
    };
  }
  if (options.parentType !== 'page' && options.parentType !== 'database') {
    throw new Error('--parent-type must be page or database when --parent is used.');
  }
  if (options.parentType === 'page') {
    if (bindings) throw new Error('Property bindings are supported only for database parents.');
    return {
      target: {
        kind: 'new_page',
        parent: { type: 'page_id', id: options.parent as string },
      },
      client: unreachableClient,
    };
  }
  const client = getClient();
  const resolved = await resolveDatabase(client, options.parent as string);
  const validatedBindings = validatedPropertyBindings(
    bindings,
    resolved.schema.properties as Record<string, { type: string }>,
  );
  return {
    target: {
      kind: 'new_page',
      parent: { type: 'data_source_id', id: resolved.dataSourceId },
      property_bindings: validatedBindings,
    },
    client,
  };
}

function printStageResult(manifestPath: string, manifest: Awaited<ReturnType<typeof stageIngestion>>): void {
  console.log(formatOutput({
    manifest_path: manifestPath,
    digest: manifest.digest,
    recipe: manifest.recipe,
    target: manifest.target,
  }));
}

export function registerIngestCommand(program: Command): void {
  const ingest = program
    .command('ingest')
    .description('Stage and apply digest-bound recipe ingestion');

  ingest
    .command('stage <url>')
    .description('Run a recipe and write a dry-run ingestion manifest')
    .requiredOption('--recipe <name|auto>', 'Recipe name or deterministic auto selection')
    .option('--recipes-dir <directory>', 'Trusted recipe root (repeatable)', collectDirectory, [])
    .option('--timeout <milliseconds>', 'Recipe execution timeout (maximum 300000)')
    .option('--page <id>', 'Existing page to update')
    .option('--parent <id>', 'Parent for a new page')
    .option('--parent-type <page|database>', 'New-page parent type')
    .option('--title-property <name>', 'Database title property to bind from the artifact')
    .option('--source-url-property <name>', 'Database URL property to bind from the artifact')
    .requiredOption('--manifest <path>', 'Exclusive private path for the staged manifest')
    .action(withErrorHandler(async (url: string, options: StageOptions) => {
      const { target, client } = await stageTarget(options);
      const executed = await executeRecipe(url, options);
      const request: IngestStageRequest = {
        recipe: {
          name: executed.recipe.descriptor.name,
          release: executed.recipe.descriptor.recipe_version,
          requested_url: executed.requestedUrl,
        },
        target,
        artifact: toIngestArtifact(executed.artifact),
      };
      const manifest = await stageIngestion(request, options.manifest, { client });
      printStageResult(options.manifest, manifest);
    }));

  ingest
    .command('apply <manifest>')
    .description('Apply one reviewed ingestion manifest without rerunning its recipe')
    .requiredOption('--expect-digest <sha256>', 'Separately reviewed manifest digest')
    .action(withErrorHandler(async (manifestPath: string, options: DigestOptions) => {
      const result = await applyIngestion(manifestPath, options.expectDigest, { client: getClient() });
      console.log(formatOutput(result));
    }));

  ingest
    .command('reconcile <manifest>')
    .description('Reconcile an unknown new-page outcome with a known page ID')
    .requiredOption('--page <id>', 'Created page ID to verify')
    .requiredOption('--expect-digest <sha256>', 'Separately reviewed manifest digest')
    .action(withErrorHandler(async (manifestPath: string, options: ReconcileOptions) => {
      const result = await reconcileIngestCreation(
        manifestPath,
        options.expectDigest,
        options.page,
        { client: getClient() },
      );
      console.log(formatOutput(result));
    }));
}
