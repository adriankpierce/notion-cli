import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerRecipesCommand } from '../../src/commands/recipes.js';

const temporaryDirectories: string[] = [];

async function createRecipe(
  root: string,
  name: string,
  options: { description?: string; host?: string } = {},
): Promise<void> {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'recipe.json'), JSON.stringify({
    schema_version: 1,
    name,
    recipe_version: '1.0.0',
    command: ['node'],
    entry: 'main.mjs',
    ...(options.description ? { description: options.description } : {}),
    ...(options.host ? { match: { hosts: [options.host] } } : {}),
  }));
  await writeFile(path.join(directory, 'main.mjs'), `
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => {
      const request = JSON.parse(input);
      process.stdout.write(JSON.stringify({
        schema_version: 1,
        source_url: request.source_url,
        title: 'Converted',
        markdown: '# Converted'
      }));
    });
  `);
}

function loggedJson(): unknown {
  const calls = vi.mocked(console.log).mock.calls;
  return JSON.parse(String(calls.at(-1)?.[0]));
}

describe('recipes command', () => {
  let program: Command;

  beforeEach(() => {
    program = new Command();
    registerRecipesCommand(program);
  });

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })),
    );
  });

  async function temporaryRoot(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'notion-recipes-command-'));
    temporaryDirectories.push(root);
    return root;
  }

  it('lists descriptors from repeatable trusted roots without exposing local paths', async () => {
    const firstRoot = await temporaryRoot();
    const secondRoot = await temporaryRoot();
    await createRecipe(firstRoot, 'zeta');
    await createRecipe(secondRoot, 'alpha', { description: 'Alpha recipe' });

    await program.parseAsync([
      'node', 'test', 'recipes', 'list',
      '--recipes-dir', firstRoot,
      '--recipes-dir', secondRoot,
    ]);

    const output = loggedJson() as Array<Record<string, unknown>>;
    expect(output.map(recipe => recipe.name)).toEqual(['alpha', 'zeta']);
    expect(output[0]).toMatchObject({ description: 'Alpha recipe', schema_version: 1 });
    expect(JSON.stringify(output)).not.toContain(firstRoot);
    expect(JSON.stringify(output)).not.toContain(secondRoot);
  });

  it('describes one exact recipe and fails closed for unknown names', async () => {
    const root = await temporaryRoot();
    await createRecipe(root, 'article-reader', { description: 'Generic article adapter' });

    await program.parseAsync([
      'node', 'test', 'recipes', 'describe', 'article-reader', '--recipes-dir', root,
    ]);
    expect(loggedJson()).toMatchObject({
      name: 'article-reader',
      recipe_version: '1.0.0',
      description: 'Generic article adapter',
    });

    await expect(program.parseAsync([
      'node', 'test', 'recipes', 'describe', 'missing', '--recipes-dir', root,
    ])).rejects.toMatchObject({ code: 'recipe_not_found' });
  });

  it('runs deterministic auto-selection and prints only the validated artifact', async () => {
    const root = await temporaryRoot();
    await createRecipe(root, 'article-reader', { host: 'example.com' });

    await program.parseAsync([
      'node', 'test', 'recipes', 'run', 'HTTPS://Example.COM/post',
      '--recipe', 'auto',
      '--recipes-dir', root,
    ]);

    expect(vi.mocked(console.log)).toHaveBeenCalledTimes(1);
    expect(loggedJson()).toEqual({
      schema_version: 1,
      source_url: 'https://example.com/post',
      title: 'Converted',
      markdown: '# Converted',
    });
  });

  it('rejects invalid timeout values before starting the recipe', async () => {
    const root = await temporaryRoot();
    await createRecipe(root, 'article-reader');

    await expect(program.parseAsync([
      'node', 'test', 'recipes', 'run', 'https://example.com/',
      '--recipe', 'article-reader',
      '--recipes-dir', root,
      '--timeout', '300001',
    ])).rejects.toThrow(/integer between 1 and 300000/);
  });
});
