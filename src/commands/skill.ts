/**
 * Skill command - install the Notion CLI skill into a repo
 */
import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function registerSkillCommand(program: Command): void {
  const skill = program
    .command('skill')
    .description('Manage the Notion CLI agent skill');

  skill
    .command('install [target_dir]')
    .description('Install the Notion skill into a repo\'s .claude/skills/ directory')
    .option('--force', 'Replace an existing installed skill')
    .action((targetDir: string | undefined, options: { force?: boolean }) => {
      const dest = path.resolve(targetDir || '.', '.claude', 'skills', 'notion');
      const src = path.resolve(__dirname, '..', '..', 'skills', 'notion');

      if (!fs.existsSync(src)) {
        throw new Error(`Skill source not found at ${src}`);
      }

      if (fs.existsSync(dest)) {
        if (!options.force) {
          throw new Error(`Skill already exists at ${dest}; pass --force to replace it`);
        }
        fs.rmSync(dest, { recursive: true, force: true });
      }

      copyDir(src, dest);
      console.log(`Installed notion skill to ${dest}`);
    });
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
