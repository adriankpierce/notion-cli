#!/usr/bin/env node
/**
 * Agent-oriented command line interface for Notion pages and data sources.
 */

import { createRequire } from 'node:module';
import { Command } from 'commander';
import { initClient } from './client.js';
import { setGlobalDataSourceId } from './utils/database-resolver.js';
import { formatCliError } from './utils/command-handler.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');
import { registerSearchCommand } from './commands/search.js';
import { registerPagesCommand } from './commands/pages.js';
import { registerDatabasesCommand } from './commands/databases.js';
import { registerCommentsCommand } from './commands/comments.js';
import { registerHelpAgentCommand } from './commands/help-agent.js';
import { registerSkillCommand } from './commands/skill.js';
import { registerFileCommand } from './commands/file.js';
import { registerRecipesCommand } from './commands/recipes.js';
import { registerIngestCommand } from './commands/ingest.js';

function collectQueryParam(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function belongsToCommand(command: Command, name: string): boolean {
  let current: Command | null = command;
  while (current) {
    if (current.name() === name) return true;
    current = current.parent;
  }
  return false;
}

function isAuthFreeCommand(command: Command): boolean {
  if (
    command.name() === 'quickstart'
    || belongsToCommand(command, 'skill')
    || belongsToCommand(command, 'recipes')
  ) {
    return true;
  }

  return belongsToCommand(command, 'ingest')
    && command.name() === 'stage'
    && command.opts().parentType === 'page';
}

const program = new Command();

program
  .name('notion')
  .description('Agent-oriented CLI for Notion pages, Markdown, and data sources\n\n  Run "notion quickstart" for the core workflow')
  .version(version)
  .option('--data-source-id <id>', 'Explicit data source ID for multi-data-source databases')
  .hook('preAction', (thisCommand, actionCommand) => {
    // Skip auth for commands that don't need the Notion API
    if (isAuthFreeCommand(actionCommand)) {
      return;
    }
    const opts = thisCommand.opts();
    initClient();
    setGlobalDataSourceId(opts.dataSourceId);
  });

// Keep the public surface focused on agent workflows. More specialized endpoint
// access remains available through `notion api`.
registerSearchCommand(program);
registerPagesCommand(program);
registerDatabasesCommand(program);
registerCommentsCommand(program);
registerHelpAgentCommand(program);
registerSkillCommand(program);
registerFileCommand(program);
registerRecipesCommand(program);
registerIngestCommand(program);

// Raw API command for advanced users
program
  .command('api <method> <path>')
  .description('Make a raw API request')
  .option('-d, --data <json>', 'Request body as JSON')
  .option('-q, --query <param>', 'Query parameter as key=value (repeatable)', collectQueryParam, [])
  .action(async (method: string, path: string, options) => {
    const { getClient } = await import('./client.js');
    const client = getClient();

    let body: Record<string, unknown> | undefined;
    if (options.data) {
      body = JSON.parse(options.data);
    }

    let query: Record<string, string | string[]> | undefined;
    if (options.query.length > 0) {
      query = {};
      for (const pair of options.query as string[]) {
        const separator = pair.indexOf('=');
        if (separator <= 0) {
          throw new Error(`Invalid query parameter: ${pair}`);
        }
        const key = pair.slice(0, separator);
        const value = pair.slice(separator + 1);
        const previous = query[key];
        if (previous === undefined) query[key] = value;
        else if (Array.isArray(previous)) previous.push(value);
        else query[key] = [previous, value];
      }
    }

    const normalizedMethod = method.toUpperCase();
    if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(normalizedMethod)) {
      throw new Error(`Unsupported HTTP method: ${method}`);
    }

    const result = await client.request(path, {
      method: normalizedMethod as 'GET' | 'POST' | 'PATCH' | 'DELETE',
      body,
      query,
    });

    console.log(JSON.stringify(result, null, 2));
  });

// Commander does not await asynchronous actions when parse() is used. Keeping a
// single rejection boundary also prevents unhandled promise rejections.
program.parseAsync().catch((error: unknown) => {
  console.error(formatCliError(error));
  process.exitCode = 1;
});
