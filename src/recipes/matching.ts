import { canonicalHttpUrl } from './schema.js';
import { RecipeError, type DiscoveredRecipe, type RecipeMatch, type RecipeSelectionOptions } from './types.js';

function matches(match: RecipeMatch | undefined, url: URL): boolean {
  if (!match) return false;
  if (match.schemes && !match.schemes.includes(url.protocol.slice(0, -1))) return false;
  const hostMatches = !match.hosts || match.hosts.includes(url.hostname);
  const suffixMatches = !match.host_suffixes || match.host_suffixes.some((suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`));
  if (match.hosts && match.host_suffixes) {
    if (!hostMatches && !suffixMatches) return false;
  } else if (!hostMatches || !suffixMatches) return false;
  if (match.path_prefixes && !match.path_prefixes.some((prefix) => url.pathname.startsWith(prefix))) return false;
  return true;
}

export function recipeMatchesUrl(recipe: DiscoveredRecipe, sourceUrl: string): boolean {
  return matches(recipe.descriptor.match, new URL(canonicalHttpUrl(sourceUrl, 'sourceUrl')));
}

export function selectRecipe(recipes: readonly DiscoveredRecipe[], options: RecipeSelectionOptions): DiscoveredRecipe {
  if (options.recipeName !== undefined) {
    const selected = recipes.find((recipe) => recipe.descriptor.name === options.recipeName);
    if (!selected) throw new RecipeError('recipe_not_found', `recipe ${JSON.stringify(options.recipeName)} was not found`);
    return selected;
  }
  const matches = recipes.filter((recipe) => recipeMatchesUrl(recipe, options.sourceUrl)).sort((a, b) => a.descriptor.name.localeCompare(b.descriptor.name));
  if (matches.length === 0) throw new RecipeError('recipe_not_found', `no recipe matches ${JSON.stringify(options.sourceUrl)}`);
  if (matches.length > 1) throw new RecipeError('ambiguous_recipe', `multiple recipes match; select one explicitly: ${matches.map((recipe) => recipe.descriptor.name).join(', ')}`, { names: matches.map((recipe) => recipe.descriptor.name) });
  return matches[0];
}
