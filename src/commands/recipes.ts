/** Discover and execute trusted, user-supplied ingestion recipes. */
import { Command } from 'commander';
import {
  RecipeError,
  createRecipeRequest,
  discoverRecipes,
  runRecipe,
  selectRecipe,
  type DiscoveredRecipe,
  type RecipeArtifact,
} from '../recipes/index.js';
import { formatOutput } from '../utils/format.js';
import { withErrorHandler } from '../utils/command-handler.js';

interface RecipeDirectoryOptions {
  recipesDir: string[];
}

interface RecipeRunOptions extends RecipeDirectoryOptions {
  recipe: string;
  timeout?: string;
}

export interface ExecutedRecipe {
  recipe: DiscoveredRecipe;
  requestedUrl: string;
  artifact: RecipeArtifact;
}

function collectDirectory(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseTimeout(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new Error('--timeout must be an integer between 1 and 300000 milliseconds.');
  }
  return timeoutMs;
}

function addRecipeDirectories(command: Command): Command {
  return command.option(
    '--recipes-dir <directory>',
    'Trusted recipe root (repeatable)',
    collectDirectory,
    [],
  );
}

export async function executeRecipe(
  sourceUrl: string,
  options: RecipeRunOptions,
): Promise<ExecutedRecipe> {
  const request = createRecipeRequest(sourceUrl);
  const recipes = await discoverRecipes(options.recipesDir);
  const recipe = selectRecipe(recipes, {
    sourceUrl: request.source_url,
    ...(options.recipe === 'auto' ? {} : { recipeName: options.recipe }),
  });
  const result = await runRecipe(recipe, request, {
    timeoutMs: parseTimeout(options.timeout),
    onStderr: chunk => process.stderr.write(chunk),
  });
  return { recipe, requestedUrl: request.source_url, artifact: result.artifact };
}

export function registerRecipesCommand(program: Command): void {
  const recipes = program
    .command('recipes')
    .description('Discover and run trusted URL-to-Markdown recipes');

  addRecipeDirectories(recipes
    .command('list')
    .description('List discovered recipes as JSON'))
    .action(withErrorHandler(async (options: RecipeDirectoryOptions) => {
      const discovered = await discoverRecipes(options.recipesDir);
      console.log(formatOutput(discovered.map(recipe => recipe.descriptor)));
    }));

  addRecipeDirectories(recipes
    .command('describe <name>')
    .description('Describe one discovered recipe as JSON'))
    .action(withErrorHandler(async (name: string, options: RecipeDirectoryOptions) => {
      const discovered = await discoverRecipes(options.recipesDir);
      const recipe = discovered.find(candidate => candidate.descriptor.name === name);
      if (!recipe) {
        throw new RecipeError('recipe_not_found', `recipe ${JSON.stringify(name)} was not found`);
      }
      console.log(formatOutput(recipe.descriptor));
    }));

  addRecipeDirectories(recipes
    .command('run <url>')
    .description('Run one recipe and emit its artifact JSON')
    .requiredOption('--recipe <name|auto>', 'Recipe name or deterministic auto selection')
    .option('--timeout <milliseconds>', 'Recipe execution timeout (maximum 300000)'))
    .action(withErrorHandler(async (url: string, options: RecipeRunOptions) => {
      const executed = await executeRecipe(url, options);
      console.log(formatOutput(executed.artifact));
    }));
}
