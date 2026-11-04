/**
 * Search command - search pages and databases
 */
import { Command } from 'commander';
import { getClient } from '../client.js';
import { formatOutput, formatPageTitle, formatDatabaseTitle } from '../utils/format.js';
import { withErrorHandler } from '../utils/command-handler.js';

interface SearchItem {
  object: 'page' | 'database' | 'data_source';
  id: string;
  title?: Array<{ plain_text: string }>;
  properties?: Record<string, unknown>;
  parent?: { type: string; database_id?: string; data_source_id?: string; page_id?: string };
  url?: string;
}

interface SearchResult {
  object: string;
  results: SearchItem[];
  has_more: boolean;
  next_cursor: string | null;
}

function getItemTitle(item: SearchItem): string {
  if (item.object === 'page') return formatPageTitle(item);
  return formatDatabaseTitle(item);
}

function pageSize(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error('--limit must be an integer between 1 and 100.');
  }
  return parsed;
}

export function registerSearchCommand(program: Command): void {
  program
    .command('search [query]')
    .description('Discover pages and data sources by indexed title')
    .option('-t, --type <type>', 'Filter by type: page, database', '')
    .option('-s, --sort <direction>', 'Sort by last_edited_time: asc, desc', '')
    .option('-l, --limit <number>', 'Max results to return', '10')
    .option('--cursor <cursor>', 'Pagination cursor for next page')
    .option('--exact', 'Only show exact title matches')
    .option('--first', 'Return only the first result (exit 1 if none)')
    .option('-j, --json', 'Output a structured search result')
    .action(withErrorHandler(async (query: string | undefined, options) => {
      const client = getClient();

      if (options.exact && !query) {
        throw new Error('--exact requires a search query.');
      }
      if (options.type && options.type !== 'page' && options.type !== 'database') {
        throw new Error('--type must be "page" or "database".');
      }
      if (options.sort && options.sort !== 'asc' && options.sort !== 'desc') {
        throw new Error('--sort must be "asc" or "desc".');
      }

      const body: Record<string, unknown> = {};
      if (query) body.query = query;
      if (options.type) {
        const apiType = options.type === 'database' ? 'data_source' : options.type;
        body.filter = { property: 'object', value: apiType };
      }
      if (options.sort) {
        body.sort = {
          direction: options.sort,
          timestamp: 'last_edited_time',
        };
      }
      const needsPostFilter = options.exact;
      const requestLimit = pageSize(options.limit || '10');
      body.page_size = requestLimit;

      // When post-filtering an exact title match, paginate until we have enough
      // matches or exhaust the cursor. Without post-filters, single request.
      let items: SearchItem[] = [];
      let lastHasMore = false;
      let lastCursor: string | null = null;

      let cursor: string | undefined = options.cursor;
      const seenCursors = new Set<string>(cursor ? [cursor] : []);
      do {
        const requestBody: Record<string, unknown> = { ...body };
        if (cursor) requestBody.start_cursor = cursor;
        if (needsPostFilter) {
          requestBody.page_size = options.first ? 100 : Math.max(1, requestLimit - items.length);
        }
        const result = await client.post<SearchResult>(
          'search',
          requestBody,
          undefined,
          { retrySafe: true },
        );

        let batch = result.results;

        if (options.exact && query) {
          const lowerQuery = query.toLowerCase();
          batch = batch.filter(item => getItemTitle(item).toLowerCase() === lowerQuery);
        }

        items.push(...batch);
        lastHasMore = result.has_more;
        lastCursor = result.next_cursor;

        if (result.has_more && !result.next_cursor) {
          throw new Error('Workspace search reported more results without a next cursor.');
        }

        // Stop conditions: enough results, no more pages, or no post-filter
        if (!needsPostFilter) break;
        if (options.first && items.length >= 1) break;
        if (items.length >= requestLimit) break;
        cursor = result.has_more ? (result.next_cursor ?? undefined) : undefined;
        if (cursor) {
          if (seenCursors.has(cursor)) {
            throw new Error(`Workspace search repeated pagination cursor ${cursor}.`);
          }
          seenCursors.add(cursor);
        }
      } while (cursor);

      // Trim to requested limit
      if (!options.first && items.length > requestLimit) {
        items = items.slice(0, requestLimit);
      }

      // --first: return one result or mark the command unsuccessful.
      if (options.first) {
        if (items.length === 0) {
          if (options.json) console.log(formatOutput(null));
          else console.error('No matching result found.');
          process.exitCode = 1;
          return;
        }
        items = [items[0]];
      }

      if (options.json) {
        console.log(formatOutput(options.first ? items[0] : { results: items, has_more: lastHasMore, next_cursor: lastCursor }));
        return;
      }

      if (items.length === 0) {
        console.log('No results found.');
        return;
      }

      for (const item of items) {
        const title = getItemTitle(item);
        const type = item.object === 'page' ? 'page' : 'db';
        console.log(`[${type}] ${item.id} ${title}`);
      }
      if (lastHasMore && !options.first) {
        console.error('More results are available.');
      }
    }));
}
