/**
 * Pages commands - get, create, update, archive, read, write, edit pages
 */
import { Command } from 'commander';
import * as fs from 'fs';
import { getClient } from '../client.js';
import { formatOutput, formatPageTitle, parseProperties } from '../utils/format.js';
import {
  readPageMarkdown,
  writePageMarkdown,
  updatePageMarkdown,
  resolveAsyncResponse,
  isParentDatabase,
  getParentDatabaseId,
  resolvePropertyName,
  buildClearPayload,
  buildTrashPayload,
} from '../utils/notion-helpers.js';
import { normalizeNotionId, resolveDatabase } from '../utils/database-resolver.js';
import { withErrorHandler } from '../utils/command-handler.js';
import type { AsyncTask, Page, PageMarkdownResponse } from '../types/notion.js';

/** Read markdown from a file, `--file -`, or piped stdin. */
function readMarkdownInput(filePath?: string): string | undefined {
  if (filePath) {
    if (filePath === '-') return fs.readFileSync(0, 'utf-8');
    if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
    return fs.readFileSync(filePath, 'utf-8');
  }

  if (!process.stdin.isTTY) {
    try {
      const input = fs.readFileSync(0, 'utf-8');
      return input.length > 0 ? input : undefined;
    } catch {
      // A closed stdin in CI/noninteractive shells is not piped Markdown.
      return undefined;
    }
  }
  return undefined;
}

function reportMarkdownCompleteness(response: PageMarkdownResponse, strict = false): void {
  const issues: string[] = [];
  if (response.truncated) issues.push('page Markdown was truncated by the Notion API');
  if (response.unknown_block_ids.length > 0) {
    issues.push(`${response.unknown_block_ids.length} block(s) could not be fully loaded`);
  }

  if (issues.length === 0) return;
  if (strict) throw new Error(`Incomplete Markdown response: ${issues.join('; ')}`);
  for (const issue of issues) console.error(`Warning: ${issue}`);
}

function pageSize(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error('--limit must be an integer between 1 and 100.');
  }
  return parsed;
}

interface PropertyItemList {
  object: 'list';
  results: unknown[];
  has_more: boolean;
  next_cursor: string | null;
  [key: string]: unknown;
}

function isPropertyItemList(value: unknown): value is PropertyItemList {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PropertyItemList>;
  return candidate.object === 'list'
    && Array.isArray(candidate.results)
    && typeof candidate.has_more === 'boolean';
}

function encodePropertyId(propertyId: string): string {
  try {
    return encodeURIComponent(decodeURIComponent(propertyId));
  } catch {
    throw new Error(`Invalid encoded property ID: ${propertyId}`);
  }
}

function hasTemporaryNotionMediaUrl(markdown: string): boolean {
  const normalized = markdown.replaceAll('&amp;', '&');
  const urls = normalized.match(/https:\/\/[^\s)>"']+/gi) ?? [];
  return urls.some((candidate) => {
    try {
      const url = new URL(candidate);
      const keys = new Set([...url.searchParams.keys()].map(key => key.toLowerCase()));
      return keys.has('signature')
        || keys.has('x-amz-signature')
        || keys.has('expirationtimestamp')
        || (keys.has('expires') && (keys.has('key-pair-id') || keys.has('x-amz-credential')));
    } catch {
      return false;
    }
  });
}

export function registerPagesCommand(program: Command): void {
  const pages = program
    .command('page')
    .alias('pages')
    .alias('p')
    .description('Manage Notion pages');

  // Get page
  pages
    .command('get <page_id>')
    .description('Retrieve a page by ID')
    .option('-j, --json', 'Output structured JSON')
    .option('--content', 'Also fetch page content as native Markdown')
    .option('--include-transcript', 'Include meeting-note transcripts in Markdown')
    .option('--allow-incomplete', 'Allow truncated or unknown Markdown content')
    .action(withErrorHandler(async (pageId: string, options) => {
      const client = getClient();
      const normalizedPageId = normalizeNotionId(pageId);
      if (!options.content && (options.includeTranscript || options.allowIncomplete)) {
        throw new Error('--include-transcript and --allow-incomplete require --content.');
      }
      const page = await client.get(`pages/${normalizedPageId}`);

      if (options.content) {
        const content = await readPageMarkdown(client, normalizedPageId, {
          includeTranscript: options.includeTranscript,
        });
        reportMarkdownCompleteness(content, !options.allowIncomplete);
        if (options.json) {
          console.log(formatOutput({ page, content }));
        } else {
          console.log('Page:', formatPageTitle(page));
          console.log('ID:', (page as { id: string }).id);
          console.log('\nContent:');
          process.stdout.write(content.markdown);
        }
      } else {
        console.log(options.json ? formatOutput(page) : formatPageTitle(page));
        if (!options.json) {
          console.log('ID:', (page as { id: string }).id);
          console.log('\nProperties:');
          console.log(formatOutput((page as { properties: unknown }).properties));
        }
      }
    }));

  // Create page
  pages
    .command('create')
    .description('Create a new page with optional markdown content (from file or stdin)')
    .requiredOption('--parent <id>', 'Parent page ID or database ID')
    .option('--parent-type <type>', 'Parent type: page, database', 'database')
    .option('-t, --title <title>', 'Page title (or use # h1 in markdown)')
    .option('--title-prop <name>', 'Name of title property (auto-detected if not set)')
    .option('-p, --prop <key=value...>', 'Set property (can be used multiple times)')
    .option('-f, --file <path>', 'Markdown content from file (use - for stdin)')
    .option('--allow-temporary-media', 'Allow signed media URLs that may expire')
    .option('--icon <emoji>', 'Set page icon (emoji character)')
    .option('--async', 'Run Markdown creation asynchronously and wait for completion')
    .option('-j, --json', 'Output raw JSON')
    .action(withErrorHandler(async (options) => {
      const client = getClient();
      if (options.parentType !== 'page' && options.parentType !== 'database') {
        throw new Error('--parent-type must be either "page" or "database"');
      }

      let parent: Record<string, string>;
      let parentSchema: Record<string, { type: string }> | undefined;
      if (options.parentType === 'page') {
        parent = { page_id: normalizeNotionId(options.parent) };
      } else {
        const resolved = await resolveDatabase(client, options.parent);
        parent = { data_source_id: resolved.dataSourceId };
        parentSchema = resolved.schema.properties;
      }

      const properties: Record<string, unknown> = {};

      if (options.title) {
        let titlePropName = options.titleProp;

        if (!titlePropName && parentSchema) {
          for (const [name, prop] of Object.entries(parentSchema)) {
            if (prop.type === 'title') {
              titlePropName = name;
              break;
            }
          }
          if (!titlePropName) throw new Error('The parent data source has no title property');
        }

        titlePropName = titlePropName || 'title';
        properties[titlePropName] = {
          title: [{ text: { content: options.title } }],
        };
      }

      if (options.prop) {
        const parsed = parseProperties(options.prop, parentSchema);
        Object.assign(properties, parsed);
      }

      const body: Record<string, unknown> = { parent, properties };

      if (options.icon) body.icon = { type: 'emoji', emoji: options.icon };

      const markdown = readMarkdownInput(options.file);
      if (markdown && !options.allowTemporaryMedia && hasTemporaryNotionMediaUrl(markdown)) {
        throw new Error(
          'Refusing to create content containing temporary signed media URLs; ' +
          'download/re-upload the assets or pass --allow-temporary-media to accept expiring links.',
        );
      }
      if (markdown !== undefined) body.markdown = markdown;
      if (options.async) {
        if (markdown === undefined) {
          throw new Error('--async requires Markdown input from --file or piped stdin');
        }
        body.allow_async = true;
      }

      const response = await client.post<Page | AsyncTask<Page>>('pages', body);
      const page = await resolveAsyncResponse(client, response);

      if (options.json) {
        console.log(formatOutput(page));
      } else {
        console.log('Page created');
        console.log('ID:', page.id);
        console.log('URL:', page.url);
      }
    }));

  // Update page
  pages
    .command('update <page_id>')
    .description('Update page properties')
    .option('-t, --title <title>', 'Rename the page title')
    .option('--title-prop <name>', 'Name of title property (auto-detected if not set)')
    .option('-p, --prop <key=value...>', 'Set property (can be used multiple times)')
    .option('--clear-prop <name...>', 'Clear a property (type-aware, e.g., --clear-prop "Assignee")')
    .option('--archive', 'Archive the page')
    .option('--unarchive', 'Unarchive the page')
    .option('--icon <emoji>', 'Set page icon (emoji character)')
    .option('-j, --json', 'Output raw JSON')
    .action(withErrorHandler(async (pageId: string, options) => {
      const client = getClient();
      const normalizedPageId = normalizeNotionId(pageId);
      if (options.archive && options.unarchive) {
        throw new Error('--archive and --unarchive cannot be used together');
      }

      const body: Record<string, unknown> = {};
      const properties: Record<string, unknown> = {};
      let pageSchema: Record<string, { type: string }> | undefined;
      let detectedParentType: 'database' | 'page' | null = null;

      const needsPageContext =
        (options.title && !options.titleProp) ||
        Boolean(options.prop) ||
        Boolean(options.clearProp?.length);
      if (needsPageContext) {
        const currentPage = await client.get<Page>(`pages/${normalizedPageId}`);
        const parentDbId = getParentDatabaseId(currentPage.parent);
        if (isParentDatabase(currentPage.parent) && parentDbId) {
          const resolved = await resolveDatabase(
            client,
            parentDbId,
            currentPage.parent.data_source_id,
          );
          detectedParentType = 'database';
          pageSchema = resolved.schema.properties;
        } else {
          detectedParentType = 'page';
        }
      }

      if (options.title) {
        let titlePropName = options.titleProp;

        if (!titlePropName && pageSchema) {
          for (const [name, prop] of Object.entries(pageSchema)) {
            if (prop.type === 'title') {
              titlePropName = name;
              break;
            }
          }
          if (!titlePropName) throw new Error('The parent data source has no title property');
        }

        titlePropName = titlePropName || (detectedParentType === 'database' ? 'Name' : 'title');
        properties[titlePropName] = {
          title: [{ text: { content: options.title } }],
        };
      }

      if (options.prop) {
        const parsed = parseProperties(options.prop, pageSchema);
        Object.assign(properties, parsed);
      }

      if (options.clearProp && options.clearProp.length > 0) {
        if (!pageSchema) throw new Error('--clear-prop requires a database-backed page');
        for (const rawName of options.clearProp) {
          const resolved = resolvePropertyName(pageSchema, rawName);
          if (!resolved) {
            throw new Error(`Property "${rawName}" not found in database schema`);
          }
          const propSchema = pageSchema[resolved];
          properties[resolved] = buildClearPayload(propSchema.type);
        }
      }

      if (Object.keys(properties).length > 0) body.properties = properties;

      if (options.archive) {
        Object.assign(body, buildTrashPayload(true));
      } else if (options.unarchive) {
        Object.assign(body, buildTrashPayload(false));
      }

      if (options.icon) body.icon = { type: 'emoji', emoji: options.icon };

      if (Object.keys(body).length === 0) throw new Error('No page updates specified');

      const page = await client.patch<Page>(`pages/${normalizedPageId}`, body);

      if (options.json) {
        console.log(formatOutput(page));
      } else {
        console.log('Page updated');
        console.log('ID:', page.id);
      }
    }));

  // Archive page (convenience)
  pages
    .command('archive <page_id>')
    .description('Archive a page')
    .action(withErrorHandler(async (pageId: string) => {
      const client = getClient();
      await client.patch(`pages/${normalizeNotionId(pageId)}`, buildTrashPayload(true));
      console.log('Page archived');
    }));

  // Get page property
  pages
    .command('property <page_id> <property_id>')
    .description('Get a page property value, with optional complete pagination')
    .option('-l, --limit <number>', 'Property items per API page (1-100)', '100')
    .option('--cursor <cursor>', 'Start from a property-item cursor')
    .option('--all', 'Fetch every property item, failing rather than returning partial data')
    .option('-j, --json', 'Output raw JSON')
    .action(withErrorHandler(async (pageId: string, propertyId: string, options) => {
      const client = getClient();
      const normalizedPageId = normalizeNotionId(pageId);
      if (options.all && options.cursor) {
        throw new Error('--all cannot be combined with --cursor.');
      }

      const path = `pages/${normalizedPageId}/properties/${encodePropertyId(propertyId)}`;
      const limit = pageSize(options.limit);
      let response = await client.get<unknown>(path, {
        page_size: limit,
        ...(options.cursor ? { start_cursor: options.cursor } : {}),
      });

      if (options.all && isPropertyItemList(response)) {
        const firstPage = response;
        const results = [...firstPage.results];
        const seenCursors = new Set<string>();

        while (response.has_more) {
          const cursor = response.next_cursor;
          if (!cursor) {
            throw new Error('Notion reported more property items without a next cursor.');
          }
          if (seenCursors.has(cursor)) {
            throw new Error(`Notion repeated property-item cursor ${cursor}.`);
          }
          seenCursors.add(cursor);
          response = await client.get<unknown>(path, {
            page_size: limit,
            start_cursor: cursor,
          });
          if (!isPropertyItemList(response)) {
            throw new Error('Notion changed response shape while paginating the property value.');
          }
          results.push(...response.results);
        }

        response = {
          ...firstPage,
          ...response,
          results,
          has_more: false,
          next_cursor: null,
        };
      }

      console.log(formatOutput(response));
    }));

  // Read page content as Markdown
  pages
    .command('read <page_id>')
    .description('Read page content as Markdown (outputs to stdout)')
    .option('-j, --json', 'Output the native Markdown response as JSON')
    .option('--include-transcript', 'Include meeting-note transcripts in Markdown')
    .option('--allow-incomplete', 'Allow truncated or unknown Markdown content')
    .option('-o, --output <path>', 'Write to file instead of stdout')
    .action(withErrorHandler(async (pageId: string, options) => {
      const client = getClient();
      const response = await readPageMarkdown(client, normalizeNotionId(pageId), {
        includeTranscript: options.includeTranscript,
      });
      reportMarkdownCompleteness(response, !options.allowIncomplete);
      const output = options.json ? formatOutput(response) : response.markdown;

      if (options.output) {
        fs.writeFileSync(options.output, output);
        console.error(`Written to ${options.output}`);
      } else if (options.json) {
        console.log(output);
      } else {
        process.stdout.write(output);
      }
    }));

  // Replace the complete page body with native Markdown.
  pages
    .command('replace <page_id>')
    .alias('write')
    .description('Replace all page content with Markdown from a file or stdin')
    .option('-f, --file <path>', 'Read Markdown from a file (use - for stdin)')
    .option('--allow-empty', 'Allow replacing the page with an empty body')
    .option('--allow-deleting-content', 'Allow deletion of child pages/databases')
    .option('--allow-temporary-media', 'Allow signed Notion media URLs that may expire')
    .option('--async', 'Run asynchronously and wait for completion')
    .option('-j, --json', 'Output the native Markdown response as JSON')
    .action(withErrorHandler(async (pageId: string, options) => {
      const markdown = readMarkdownInput(options.file);
      if (markdown === undefined) {
        throw new Error('No Markdown input. Pass --file <path>, --file -, or pipe content on stdin.');
      }
      if (markdown.length === 0 && !options.allowEmpty) {
        throw new Error('Refusing to replace the page with empty input; pass --allow-empty to confirm');
      }
      if (!options.allowTemporaryMedia && hasTemporaryNotionMediaUrl(markdown)) {
        throw new Error(
          'Refusing to replace content containing temporary Notion media URLs; ' +
          'download/re-upload the assets or pass --allow-temporary-media to accept expiring links.',
        );
      }

      const response = await writePageMarkdown(getClient(), normalizeNotionId(pageId), markdown, {
        allowDeletingContent: options.allowDeletingContent ?? false,
        allowAsync: options.async ?? false,
      });
      reportMarkdownCompleteness(response);

      if (options.json) console.log(formatOutput(response));
      else console.log('Page content replaced');
    }));

  // Edit page content via Notion's update_content (search-and-replace)
  pages
    .command('edit <page_id>')
    .description('Edit page content using search-and-replace on the markdown. Uses Notion\'s update_content API.')
    .requiredOption('-s, --search <text>', 'Text to find in the page markdown (exact, case-sensitive)')
    .option('-r, --replace <text>', 'Replacement text')
    .option('--replace-file <path>', 'Read replacement text from a file (use - for stdin)')
    .option('--all', 'Replace all matches (default: must match exactly once)')
    .option('--allow-deleting-content', 'Allow deletion of child pages/databases')
    .option('--allow-temporary-media', 'Allow signed media URLs that may expire')
    .option('--async', 'Run asynchronously and wait for completion')
    .option('--dry-run', 'Show what would change without making changes')
    .option('-j, --json', 'Output structured JSON response')
    .action(withErrorHandler(async (pageId: string, options) => {
      const client = getClient();
      const normalizedPageId = normalizeNotionId(pageId);
      if (options.search.length === 0) throw new Error('--search cannot be empty');
      if ((options.replace === undefined) === (options.replaceFile === undefined)) {
        throw new Error('Pass exactly one of --replace or --replace-file.');
      }
      const replacement = options.replaceFile === undefined
        ? options.replace
        : readMarkdownInput(options.replaceFile);
      if (replacement === undefined) throw new Error('--replace-file returned no replacement text.');
      if (!options.allowTemporaryMedia && hasTemporaryNotionMediaUrl(replacement)) {
        throw new Error(
          'Refusing to insert a temporary signed media URL; download/re-upload the asset or ' +
          'pass --allow-temporary-media to accept an expiring link.',
        );
      }

      if (options.dryRun) {
        const current = await readPageMarkdown(client, normalizedPageId);
        reportMarkdownCompleteness(current, true);
        const matches = current.markdown.split(options.search).length - 1;
        if (matches === 0) {
          throw new Error('Dry run found no exact match; the edit would fail.');
        }
        if (matches > 1 && !options.all) {
          throw new Error('Dry run found multiple matches; pass --all or use a more specific search.');
        }
        if (options.json) {
          console.log(formatOutput({
            dry_run: true,
            page_id: normalizedPageId,
            search: options.search,
            replacement,
            replace_all_matches: options.all ?? false,
            match_count: matches,
            would_succeed: matches > 0 && (options.all || matches === 1),
          }));
        } else {
          console.log(`Found ${matches} match(es) for search text`);
          console.log(`  Search:  "${options.search.slice(0, 80)}${options.search.length > 80 ? '...' : ''}"`);
          console.log(`  Replace: "${replacement.slice(0, 80)}${replacement.length > 80 ? '...' : ''}"`);
        }
        if (!options.json) console.log('\nDry run - no changes made');
        return;
      }

      const response = await updatePageMarkdown(client, normalizedPageId, [
        {
          old_str: options.search,
          new_str: replacement,
          replace_all_matches: options.all ?? false,
        },
      ], {
        allowDeletingContent: options.allowDeletingContent ?? false,
        allowAsync: options.async ?? false,
      });

      reportMarkdownCompleteness(response);

      if (options.json) console.log(formatOutput(response));
      else console.log('Page updated');
    }));
}
