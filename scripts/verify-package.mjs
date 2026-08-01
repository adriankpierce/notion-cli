import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const expectedCommands = ['search', 'page', 'database', 'comment', 'quickstart', 'skill', 'file', 'api'];
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
