import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RecipeError,
  createRecipeRequest,
  discoverRecipes,
  recipeMatchesUrl,
  runRecipe,
  sanitizeRecipeEnvironment,
  selectRecipe,
  validateRecipeArtifact,
  validateRecipeDescriptor,
} from '../../src/recipes/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'notion-recipe-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function descriptor(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    name,
    recipe_version: '1.0.0',
    command: ['node'],
    entry: 'main.mjs',
    ...extra,
  };
}

async function writeRecipe(root: string, name: string, program: string, extra: Record<string, unknown> = {}): Promise<string> {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'recipe.json'), JSON.stringify(descriptor(name, extra)));
  await writeFile(path.join(directory, 'main.mjs'), program);
  return directory;
}

describe('recipe schemas', () => {
  it('accepts only the closed descriptor protocol', () => {
    expect(validateRecipeDescriptor(descriptor('article-reader'))).toMatchObject({ name: 'article-reader', recipe_version: '1.0.0' });
    expect(() => validateRecipeDescriptor({ ...descriptor('reader'), version: '1' })).toThrowError(/unknown property/);
    expect(() => validateRecipeDescriptor({ ...descriptor('reader'), schema_version: 2 })).toThrowError(/schema_version/);
    expect(() => validateRecipeDescriptor({ ...descriptor('Reader') })).toThrowError(/lowercase/);
    expect(() => validateRecipeDescriptor(descriptor('auto'))).toThrowError(/reserved/);
    expect(() => validateRecipeDescriptor({ ...descriptor('reader'), match: { regex: '.*' } })).toThrowError(/unknown property/);
    expect(() => validateRecipeDescriptor({ ...descriptor('reader'), command: [] })).toThrowError(/non-empty/);
  });

  it('canonicalizes requests and strictly validates artifact provenance', () => {
    expect(createRecipeRequest('HTTPS://Example.COM')).toEqual({ schema_version: 1, source_url: 'https://example.com/' });
    expect(validateRecipeArtifact({
      schema_version: 1,
      source_url: 'https://example.com/post',
      title: 'Post',
      markdown: '# Post\n\n![Image](https://cdn.example.com/image.png)',
      assets: [{
        source_url: 'https://cdn.example.com/image.png',
        asset_type: 'image',
        sha256: 'a'.repeat(64),
        byte_length: 42,
        content_type: 'image/png',
      }],
    }).assets).toHaveLength(1);
    expect(() => validateRecipeArtifact({ schema_version: 1, source_url: 'https://example.com', markdown: '# ok' })).toThrowError(/canonical/);
    expect(() => validateRecipeArtifact({ schema_version: 1, source_url: 'https://example.com/', markdown: '', properties: {} })).toThrowError(/unknown property/);
    expect(() => validateRecipeArtifact({
      schema_version: 1,
      source_url: 'https://example.com/',
      markdown: '# ok',
      assets: [{
        source_url: 'https://example.com/a',
        asset_type: 'file',
        sha256: 'ABC',
        byte_length: -1,
      }],
    })).toThrowError(/sha256/);
    expect(() => validateRecipeArtifact({
      schema_version: 1,
      source_url: 'https://example.com/',
      markdown: '![Large](https://example.com/large.bin)',
      assets: [{
        source_url: 'https://example.com/large.bin',
        asset_type: 'image',
        sha256: 'a'.repeat(64),
        byte_length: 128 * 1024 * 1024 + 1,
      }],
    })).toThrowError(/byte_length/);
    expect(() => validateRecipeArtifact({
      schema_version: 1,
      source_url: 'https://example.com/',
      markdown: '\u{1F642}'.repeat(300_000),
    })).toThrowError(/UTF-8 bytes/);
    expect(() => validateRecipeArtifact({
      schema_version: 1,
      source_url: 'https://example.com/',
      markdown: '\u0001'.repeat(1024 * 1024),
    })).toThrowError(/control characters/);
  });
});

describe('recipe discovery and matching', () => {
  it('discovers in stable name order and performs literal, boundary-aware matching', async () => {
    const root = await temporaryDirectory();
    await writeRecipe(root, 'zeta', '', { match: { hosts: ['example.com'], path_prefixes: ['/posts/'] } });
    await writeRecipe(root, 'alpha', '', { match: { schemes: ['https'], host_suffixes: ['example.org'] } });
    const recipes = await discoverRecipes([root]);
    expect(recipes.map((recipe) => recipe.descriptor.name)).toEqual(['alpha', 'zeta']);
    expect(recipeMatchesUrl(recipes[0], 'https://sub.example.org/')).toBe(true);
    expect(recipeMatchesUrl(recipes[0], 'https://badexample.org/')).toBe(false);
    expect(recipeMatchesUrl(recipes[1], 'https://example.com/posts/one')).toBe(true);
    expect(recipeMatchesUrl(recipes[1], 'https://example.com/postscript')).toBe(false);
    expect(selectRecipe(recipes, { recipeName: 'zeta', sourceUrl: 'https://elsewhere.test/' }).descriptor.name).toBe('zeta');
  });

  it('rejects duplicate names, traversal, escaping symlinks, and ambiguous auto-selection', async () => {
    const first = await temporaryDirectory();
    const second = await temporaryDirectory();
    await writeRecipe(first, 'same', '', { match: { hosts: ['example.com'] } });
    await writeRecipe(second, 'same', '');
    await expect(discoverRecipes([first, second])).rejects.toMatchObject({ code: 'duplicate_recipe' });

    const unsafeRoot = await temporaryDirectory();
    await writeFile(path.join(unsafeRoot, 'outside.mjs'), '');
    const unsafe = await writeRecipe(unsafeRoot, 'unsafe', '', { entry: '../outside.mjs' });
    await expect(discoverRecipes([unsafe])).rejects.toMatchObject({ code: 'unsafe_path' });

    const linkRoot = await temporaryDirectory();
    const linkRecipe = await writeRecipe(linkRoot, 'linked', '');
    await rm(path.join(linkRecipe, 'main.mjs'));
    await symlink(path.join(linkRoot, 'outside.mjs'), path.join(linkRecipe, 'main.mjs'));
    await writeFile(path.join(linkRoot, 'outside.mjs'), '');
    await expect(discoverRecipes([linkRecipe])).rejects.toMatchObject({ code: 'unsafe_path' });

    const matchRoot = await temporaryDirectory();
    await writeRecipe(matchRoot, 'one', '', { match: { hosts: ['example.com'] } });
    await writeRecipe(matchRoot, 'two', '', { match: { host_suffixes: ['example.com'] } });
    const matches = await discoverRecipes([matchRoot]);
    expect(() => selectRecipe(matches, { sourceUrl: 'https://example.com/' })).toThrowError(RecipeError);
    try { selectRecipe(matches, { sourceUrl: 'https://example.com/' }); } catch (error) {
      expect(error).toMatchObject({ code: 'ambiguous_recipe', details: { names: ['one', 'two'] } });
    }
  });
});

describe('recipe subprocess runtime', () => {
  it('uses one JSON request, sanitizes credentials, captures logs, and validates one artifact', async () => {
    const root = await temporaryDirectory();
    await writeRecipe(root, 'runtime', `
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => { input += chunk; });
      process.stdin.on('end', () => {
        const request = JSON.parse(input);
        console.error('recipe log');
        process.stdout.write(JSON.stringify({
          schema_version: 1,
          source_url: request.source_url,
          markdown: process.env.NOTION_TOKEN === undefined && process.env.RECIPE_TEST_VALUE === 'kept' ? '# ok' : '# leaked'
        }));
      });
    `);
    const [recipe] = await discoverRecipes([root]);
    const logs: string[] = [];
    const result = await runRecipe(recipe, createRecipeRequest('https://example.com/post'), {
      env: { ...process.env, NOTION_TOKEN: 'secret', NOTION_OTHER: 'secret', RECIPE_TEST_VALUE: 'kept' },
      onStderr: (chunk) => logs.push(chunk),
    });
    expect(result.artifact.markdown).toBe('# ok');
    expect(result.stderr).toContain('recipe log');
    expect(logs.join('')).toContain('recipe log');
    expect(sanitizeRecipeEnvironment({ notion_token: 'x', NOTION_KEY: 'y', SAFE: 'z' })).toEqual({ SAFE: 'z' });
  });

  it('rejects multiple objects, output overflow, stderr overflow, nonzero exits, and timeouts', async () => {
    const cases: Array<[string, string, Record<string, number>, string]> = [
      ['multiple', `process.stdout.write('{}{}')`, {}, 'invalid_output'],
      ['stdout', `process.stdout.write('x'.repeat(1000))`, { maxStdoutBytes: 64 }, 'stdout_limit'],
      ['stderr', `process.stderr.write('x'.repeat(1000))`, { maxStderrBytes: 64 }, 'stderr_limit'],
      ['failure', `process.stderr.write('nope'); process.exit(7)`, {}, 'recipe_failed'],
      ['timeout', `setInterval(() => {}, 1000)`, { timeoutMs: 30 }, 'recipe_timeout'],
    ];
    for (const [name, program, options, code] of cases) {
      const root = await temporaryDirectory();
      await writeRecipe(root, name, program);
      const [recipe] = await discoverRecipes([root]);
      await expect(runRecipe(recipe, createRecipeRequest('https://example.com/'), options)).rejects.toMatchObject({ code });
    }
  });

  it('settles promptly when a timed-out recipe leaves a descendant holding its pipes', async () => {
    const root = await temporaryDirectory();
    await writeRecipe(root, 'tree-timeout', `
      const { spawn } = await import('node:child_process');
      spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: ['ignore', 'inherit', 'inherit']
      });
      setInterval(() => {}, 1000);
    `);
    const [recipe] = await discoverRecipes([root]);
    const started = Date.now();
    await expect(runRecipe(
      recipe,
      createRecipeRequest('https://example.com/'),
      { timeoutMs: 40 },
    )).rejects.toMatchObject({ code: 'recipe_timeout' });
    expect(Date.now() - started).toBeLessThan(500);
  });

});
