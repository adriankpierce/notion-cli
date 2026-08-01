import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const expectedCommands = [
  'search',
  'page',
  'database',
  'comment',
  'quickstart',
  'skill',
  'file',
  'recipes',
  'ingest',
  'api',
];
const retiredCommands = [
  'block',
  'user',
  'export',
  'batch',
  'bulk',
  'import',
  'template',
  'stats',
  'duplicate',
  'validate',
  'backup',
  'relations',
];

const help = execFileSync(process.execPath, ['dist/cli.js', '--help'], {
  encoding: 'utf8',
});

for (const command of expectedCommands) {
  if (!new RegExp(`^  ${command}(?:[ <|]|$)`, 'm').test(help)) {
    throw new Error(`Built CLI is missing public command: ${command}`);
  }
}

for (const command of retiredCommands) {
  if (new RegExp(`^  ${command}(?:[ <]|$)`, 'm').test(help)) {
    throw new Error(`Built CLI still exposes retired command: ${command}`);
  }
}

const authFreeEnv = { ...process.env };
delete authFreeEnv.NOTION_API_TOKEN;
delete authFreeEnv.NOTION_TOKEN;
delete authFreeEnv.NOTION_API_KEY;
authFreeEnv.NOTION_CLI_DISABLE_CONFIG = '1';
const recipeList = spawnSync(
  process.execPath,
  ['dist/cli.js', 'recipes', 'list'],
  { encoding: 'utf8', env: authFreeEnv },
);
if (recipeList.status !== 0 || recipeList.stderr !== '') {
  throw new Error(`Auth-free recipe discovery failed: ${recipeList.stderr}`);
}
if (JSON.stringify(JSON.parse(recipeList.stdout)) !== '[]') {
  throw new Error('Recipe discovery should be empty unless trusted roots are supplied');
}

const ingestSmokeRoot = mkdtempSync(join(tmpdir(), 'notion-cli-ingest-smoke-'));
try {
  const recipeDirectory = join(ingestSmokeRoot, 'article-reader');
  const manifestPath = join(ingestSmokeRoot, 'manifest.json');
  mkdirSync(recipeDirectory);
  writeFileSync(join(recipeDirectory, 'recipe.json'), JSON.stringify({
    schema_version: 1,
    name: 'article-reader',
    recipe_version: '1.0.0',
    command: ['node'],
    entry: 'main.mjs',
  }));
  writeFileSync(join(recipeDirectory, 'main.mjs'), `
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => {
      const request = JSON.parse(input);
      process.stdout.write(JSON.stringify({
        schema_version: 1,
        source_url: request.source_url,
        title: 'Package smoke test',
        markdown: '# Package smoke test'
      }));
    });
  `);
  const staged = spawnSync(process.execPath, [
    'dist/cli.js', 'ingest', 'stage', 'https://example.com/post',
    '--recipe', 'article-reader',
    '--recipes-dir', ingestSmokeRoot,
    '--parent', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    '--parent-type', 'page',
    '--manifest', manifestPath,
  ], { encoding: 'utf8', env: authFreeEnv });
  if (staged.status !== 0 || staged.stderr !== '') {
    throw new Error(`Auth-free page-parent staging failed: ${staged.stderr}`);
  }
  const stagedSummary = JSON.parse(staged.stdout);
  if (stagedSummary.manifest_path !== manifestPath || !/^[a-f0-9]{64}$/.test(stagedSummary.digest)) {
    throw new Error('Page-parent staging did not emit its manifest path and digest');
  }
} finally {
  rmSync(ingestSmokeRoot, { recursive: true, force: true });
}

const publicRecipes = readdirSync('recipes').sort();
if (JSON.stringify(publicRecipes) !== JSON.stringify(['.gitkeep'])) {
  throw new Error(`Public recipes directory contains unexpected files: ${publicRecipes.join(', ')}`);
}

const failedCommand = spawnSync(
  process.execPath,
  ['dist/cli.js', 'api', 'TRACE', 'pages'],
  {
    encoding: 'utf8',
    env: { ...process.env, NOTION_API_TOKEN: 'package-smoke-token' },
  },
);
if (failedCommand.status !== 1) {
  throw new Error(`CLI error boundary returned unexpected status: ${failedCommand.status}`);
}
if (failedCommand.stdout !== '' || !failedCommand.stderr.includes('Error: Unsupported HTTP method: TRACE')) {
  throw new Error('CLI error boundary did not keep diagnostics on stderr');
}

const npmCache = mkdtempSync(join(tmpdir(), 'notion-cli-package-'));
let packOutput;
try {
  packOutput = execFileSync(
    'npm',
    ['pack', '--dry-run', '--ignore-scripts', '--json'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        npm_config_cache: npmCache,
        npm_config_ignore_scripts: 'true',
      },
    },
  );
} finally {
  rmSync(npmCache, { recursive: true, force: true });
}
const [packResult] = JSON.parse(packOutput);
const packagedFiles = new Set(packResult.files.map(({ path }) => path));

for (const required of ['dist/cli.js', 'skills/notion/SKILL.md', 'README.md', 'LICENSE']) {
  if (!packagedFiles.has(required)) {
    throw new Error(`Package is missing required file: ${required}`);
  }
}

for (const retired of retiredCommands) {
  if (packagedFiles.has(`dist/commands/${retired}.js`)) {
    throw new Error(`Package contains retired compiled command: ${retired}`);
  }
}

if ([...packagedFiles].some((path) => path.startsWith('src/'))) {
  throw new Error('Package unexpectedly contains TypeScript source files');
}

console.log(`Package smoke check passed (${packagedFiles.size} files).`);
