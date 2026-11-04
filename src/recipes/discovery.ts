import { constants as fsConstants } from 'node:fs';
import { access, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { MAX_DESCRIPTOR_BYTES, validateRecipeDescriptor } from './schema.js';
import { RecipeError, type DiscoveredRecipe } from './types.js';

function assertSafeRelative(value: string, label: string): void {
  if (value.includes('\0') || value.includes('\\') || path.isAbsolute(value) || path.posix.isAbsolute(value)) throw new RecipeError('unsafe_path', `${label} must be a relative path`);
  const parts = value.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) throw new RecipeError('unsafe_path', `${label} contains an unsafe path segment`);
}

function inside(directory: string, target: string): boolean {
  const relative = path.relative(directory, target);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function safeFile(directory: string, relativePath: string, label: string): Promise<string> {
  assertSafeRelative(relativePath, label);
  let resolved: string;
  try { resolved = await realpath(path.resolve(directory, relativePath)); } catch (error) {
    throw new RecipeError('unsafe_path', `${label} does not resolve to a readable file`, undefined, { cause: error });
  }
  if (!inside(directory, resolved) || !(await stat(resolved)).isFile()) throw new RecipeError('unsafe_path', `${label} must resolve to a file inside the recipe directory`);
  return resolved;
}

async function loadRecipe(directoryInput: string): Promise<DiscoveredRecipe> {
  const directory = await realpath(directoryInput);
  const descriptorPath = await safeFile(directory, 'recipe.json', 'recipe.json');
  const info = await stat(descriptorPath);
  if (info.size > MAX_DESCRIPTOR_BYTES) throw new RecipeError('invalid_descriptor', `recipe descriptor exceeds ${MAX_DESCRIPTOR_BYTES} bytes`, { descriptorPath });
  let raw: unknown;
  try { raw = JSON.parse(await readFile(descriptorPath, 'utf8')) as unknown; } catch (error) {
    throw new RecipeError('invalid_descriptor', `cannot parse ${descriptorPath}`, { descriptorPath }, { cause: error });
  }
  const descriptor = validateRecipeDescriptor(raw);
  const entryPath = await safeFile(directory, descriptor.entry, 'entry');
  const commandArguments = descriptor.command.slice(1);
  const commandName = descriptor.command[0];
  let executable: string;
  if (commandName.includes('/') || commandName.includes('\\')) executable = await safeFile(directory, commandName, 'command executable');
  else {
    if (!/^[A-Za-z0-9._+-]+$/u.test(commandName) || commandName === '.' || commandName === '..') throw new RecipeError('unsafe_path', 'command executable is invalid');
    executable = commandName;
  }
  return { descriptor, directory, descriptorPath, entryPath, executable, commandArguments };
}

async function exists(file: string): Promise<boolean> {
  try { await access(file, fsConstants.R_OK); return true; } catch { return false; }
}

export async function discoverRecipes(roots: readonly string[]): Promise<DiscoveredRecipe[]> {
  const directories: string[] = [];
  const seenRoots = new Set<string>();
  for (const rootInput of [...roots].sort()) {
    const root = await realpath(rootInput);
    if (seenRoots.has(root)) continue;
    seenRoots.add(root);
    if ((await stat(root)).isDirectory() === false) throw new RecipeError('invalid_descriptor', `recipe root is not a directory: ${rootInput}`);
    if (await exists(path.join(root, 'recipe.json'))) directories.push(root);
    else {
      for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory() && await exists(path.join(root, entry.name, 'recipe.json'))) directories.push(path.join(root, entry.name));
      }
    }
  }
  const recipes: DiscoveredRecipe[] = [];
  const names = new Map<string, string>();
  for (const directory of directories) {
    const recipe = await loadRecipe(directory);
    const previous = names.get(recipe.descriptor.name);
    if (previous) throw new RecipeError('duplicate_recipe', `duplicate recipe name ${JSON.stringify(recipe.descriptor.name)}`, { paths: [previous, recipe.descriptorPath] });
    names.set(recipe.descriptor.name, recipe.descriptorPath);
    recipes.push(recipe);
  }
  return recipes.sort((a, b) => a.descriptor.name.localeCompare(b.descriptor.name));
}
