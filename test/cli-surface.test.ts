import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const cliSource = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string; bin: Record<string, string> };

describe('published CLI surface', () => {
  it('registers only the focused top-level command groups', () => {
    const expectedRegistrations = [
      'registerSearchCommand',
      'registerPagesCommand',
      'registerDatabasesCommand',
      'registerCommentsCommand',
      'registerHelpAgentCommand',
      'registerSkillCommand',
      'registerFileCommand',
    ];
    const retiredRegistrations = [
      'registerBlocksCommand',
      'registerUsersCommand',
      'registerExportCommand',
      'registerBatchCommand',
      'registerBulkCommand',
      'registerImportCommand',
      'registerTemplateCommand',
      'registerStatsCommand',
      'registerDuplicateCommand',
      'registerValidateCommand',
      'registerBackupCommand',
      'registerRelationsCommand',
    ];

    for (const registration of expectedRegistrations) {
      expect(cliSource).toContain(`${registration}(program)`);
    }
    for (const registration of retiredRegistrations) {
      expect(cliSource).not.toContain(registration);
    }
  });

  it('does not accept integration tokens on the command line', () => {
    expect(cliSource).not.toContain(".option('--token");
  });

  it('awaits asynchronous commands behind one rejection boundary', () => {
    expect(cliSource).toContain('program.parseAsync().catch');
    expect(cliSource).toContain('process.exitCode = 1');
  });

  it('publishes the expected alpha version and binary', () => {
    expect(packageJson.version).toBe('0.12.0-alpha.0');
    expect(packageJson.bin).toEqual({ notion: 'dist/cli.js' });
  });
});
