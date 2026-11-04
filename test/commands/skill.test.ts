import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerSkillCommand } from '../../src/commands/skill.js';

describe('skill install', () => {
  let target: string;
  let program: Command;

  beforeEach(() => {
    target = mkdtempSync(join(tmpdir(), 'notion-skill-test-'));
    program = new Command();
    registerSkillCommand(program);
  });

  afterEach(() => {
    rmSync(target, { recursive: true, force: true });
  });

  it('installs the complete bundled skill', async () => {
    await program.parseAsync(['node', 'test', 'skill', 'install', target]);

    const installed = join(target, '.claude', 'skills', 'notion');
    expect(readFileSync(join(installed, 'SKILL.md'), 'utf8')).toContain('notion page replace');
    expect(readFileSync(join(installed, 'references', 'filters.md'), 'utf8'))
      .toContain('--filter-properties');
  });

  it('refuses to overwrite an existing skill implicitly', async () => {
    await program.parseAsync(['node', 'test', 'skill', 'install', target]);

    await expect(program.parseAsync([
      'node', 'test', 'skill', 'install', target,
    ])).rejects.toThrow('pass --force to replace it');
  });

  it('replaces the destination completely with --force', async () => {
    await program.parseAsync(['node', 'test', 'skill', 'install', target]);
    const staleFile = join(
      target,
      '.claude',
      'skills',
      'notion',
      'references',
      'batch-patterns.md',
    );
    writeFileSync(staleFile, 'stale');

    await program.parseAsync(['node', 'test', 'skill', 'install', target, '--force']);

    expect(() => readFileSync(staleFile, 'utf8')).toThrow();
  });
});
