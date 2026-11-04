/**
 * Database discovery, schema inspection, and query commands.
 */
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { once } from 'node:events';
import { getClient } from '../client.js';
import {
  formatOutput,
  formatDatabaseTitle,
  isValuelessFilterOperator,
  parseFilter,
} from '../utils/format.js';
import {
  getDatabaseSchema,
  normalizeNotionId,
  queryAllPages,
  queryDatabase,
} from '../utils/database-resolver.js';
import { withErrorHandler } from '../utils/command-handler.js';
import { getDbTitle, getDbDescription, resolvePropertyName } from '../utils/notion-helpers.js';
import type { Database, PaginatedResponse, PropertySchema } from '../types/notion.js';
import type { QueryAllOptions } from '../utils/database-resolver.js';

interface SelectOption {
  id: string;
  name: string;
  color?: string;
}

interface StatusGroup {
  id: string;
  name: string;
  option_ids: string[];
}

interface DatabaseWithDataSources extends Database {
  data_sources?: { id: string; name: string }[];
}

interface SearchResponse<T> {
  object?: string;
  results: T[];
  has_more: boolean;
  next_cursor: string | null;
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function positiveInteger(value: string, option: string, max?: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || (max !== undefined && parsed > max)) {
    const range = max === undefined ? 'a positive integer' : `an integer between 1 and ${max}`;
    throw new Error(`${option} must be ${range}.`);
  }
  return parsed;
}

function combineFilters(filters: Record<string, unknown>[]): Record<string, unknown> | undefined {
  if (filters.length === 0) return undefined;
  return filters.length === 1 ? filters[0] : { and: filters };
}

function resolveFilterProperties(
  requested: string[],
  schema: Record<string, PropertySchema>,
): string[] {
  return requested.map((input) => {
    const propertyName = resolvePropertyName(schema, input);
    if (propertyName) {
      const propertyId = schema[propertyName].id;
      if (typeof propertyId !== 'string') {
        throw new Error(`Property "${propertyName}" has no API property ID.`);
      }
      try {
        return decodeURIComponent(propertyId);
      } catch {
        throw new Error(`Property "${propertyName}" returned an invalid encoded API ID.`);
      }
    }

    let decodedInput: string | undefined;
    try {
      decodedInput = decodeURIComponent(input);
    } catch {
      decodedInput = undefined;
    }
    for (const property of Object.values(schema)) {
      if (typeof property.id !== 'string') continue;
      let decodedId: string;
      try {
        decodedId = decodeURIComponent(property.id);
      } catch {
        continue;
      }
      if (property.id === input || decodedId === decodedInput) return decodedId;
    }

    throw new Error(`Property "${input}" does not exist in the data-source schema.`);
  });
}

async function outputCompleteJsonl(
  client: ReturnType<typeof getClient>,
  databaseId: string,
  options: QueryAllOptions,
): Promise<void> {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'notion-cli-jsonl-'));
  const tempFile = path.join(tempDirectory, 'results.jsonl');
  let descriptor: number | undefined;

  try {
    descriptor = fs.openSync(tempFile, 'wx', 0o600);
    await queryAllPages(client, databaseId, {
      ...options,
      collect: false,
      onPage: (page) => {
        const line = Buffer.from(`${JSON.stringify(page)}\n`, 'utf8');
        let offset = 0;
        while (offset < line.byteLength) {
          const written = fs.writeSync(
            descriptor!,
            line,
            offset,
            line.byteLength - offset,
          );
          if (written < 1) throw new Error('Could not stage complete JSONL output.');
          offset += written;
        }
      },
    });
    fs.closeSync(descriptor);
    descriptor = undefined;

    const stream = fs.createReadStream(tempFile);
    for await (const chunk of stream) {
      if (!process.stdout.write(chunk)) await once(process.stdout, 'drain');
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}

function isMultiDataSource(db: DatabaseWithDataSources): boolean {
  return Array.isArray(db.data_sources) && db.data_sources.length > 1;
}

function formatPropertyType(prop: PropertySchema): string {
  const type = prop.type;
  const data = prop[type] as Record<string, unknown> | undefined;

  switch (type) {
    case 'select':
    case 'multi_select': {
      const options = (data?.options as SelectOption[]) || [];
      if (options.length === 0) return type;
      const optionNames = options.map(o => o.name).slice(0, 5);
      const more = options.length > 5 ? ` +${options.length - 5} more` : '';
      return `${type} [${optionNames.join(', ')}${more}]`;
    }

    case 'status': {
      const options = (data?.options as SelectOption[]) || [];
      const groups = (data?.groups as StatusGroup[]) || [];
      if (options.length === 0) return type;

      const groupedOptions: string[] = [];
      for (const group of groups) {
        const groupOptions = options
          .filter(o => group.option_ids.includes(o.id))
          .map(o => o.name);
        if (groupOptions.length > 0) {
          groupedOptions.push(`${group.name}: ${groupOptions.join(', ')}`);
        }
      }
      return `status {${groupedOptions.join(' | ')}}`;
    }

    case 'relation': {
      const relatedDb = (data?.data_source_id as string) || (data?.database_id as string) || 'unknown';
      return `relation → ${relatedDb.slice(0, 8)}...`;
    }

    case 'rollup': {
      const rollupProp = (data?.rollup_property_name as string) || '';
      const relationProp = (data?.relation_property_name as string) || '';
      return `rollup(${relationProp}.${rollupProp})`;
    }

    case 'formula': {
      return 'formula';
    }

    default:
      return type;
  }
}

export function registerDatabasesCommand(program: Command): void {
  const databases = program
    .command('database')
    .alias('databases')
    .alias('db')
    .description('Manage Notion databases');

  // List all accessible databases
  databases
    .command('list')
    .alias('ls')
    .description('Discover data sources indexed by workspace search')
    .option('-l, --limit <number>', 'Max data sources to show', '20')
    .option('--all', 'Fetch every currently indexed result')
    .option('--cursor <cursor>', 'Start from a workspace search cursor')
    .option('-j, --json', 'Output a structured discovery result')
    .option('--compact', 'Compact output (names and IDs only)')
    .action(withErrorHandler(async (options) => {
      const client = getClient();

      const limit = positiveInteger(options.limit, '--limit');
      const results: DatabaseWithDataSources[] = [];
      let cursor: string | undefined = options.cursor;
      let hasMore = false;
      let nextCursor: string | null = cursor ?? null;
      const seenCursors = new Set<string>(cursor ? [cursor] : []);

      do {
        const remaining = options.all ? 100 : limit - results.length;
        const body: Record<string, unknown> = {
          filter: { property: 'object', value: 'data_source' },
          page_size: Math.min(100, remaining),
        };
        if (cursor) body.start_cursor = cursor;

        const page = await client.post<SearchResponse<DatabaseWithDataSources>>(
          'search',
          body,
          undefined,
          { retrySafe: true },
        );
        results.push(...page.results);
        hasMore = page.has_more;
        nextCursor = page.next_cursor;

        if (page.has_more && !page.next_cursor) {
          throw new Error('Workspace search reported more results without a next cursor.');
        }
        if (!options.all && results.length >= limit) break;
        cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
        if (cursor) {
          if (seenCursors.has(cursor)) {
            throw new Error(`Workspace search repeated pagination cursor ${cursor}.`);
          }
          seenCursors.add(cursor);
        }
      } while (cursor);

      const result = {
        object: 'list',
        results,
        has_more: hasMore,
        next_cursor: nextCursor,
      };

      if (options.json) {
        console.log(formatOutput(result));
        return;
      }

      if (!options.compact) {
        console.log(`Found ${result.results.length} indexed data source(s):\n`);
      }

      for (const db of result.results) {
        try {
          const title = getDbTitle(db);
          const multiSource = isMultiDataSource(db);
          const multiTag = multiSource ? ' [multi-source]' : '';
          const desc = getDbDescription(db);

          if (options.compact) {
            console.log(`${title}  ${db.id}`);
            continue;
          }

          console.log(`${title}${multiTag}`);
          console.log(`   ID: ${db.id}`);
          if (desc) console.log(`   Description: ${desc}`);

          if (multiSource && db.data_sources) {
            console.log(`   Data sources: ${db.data_sources.map(ds => ds.id).join(', ')}`);
          }

          const properties = db.properties || {};
          const props = Object.entries(properties)
            .filter(([, p]) => p.type !== 'title')
            .slice(0, 8);

          if (props.length > 0) {
            console.log('   Properties:');
            for (const [name, prop] of props) {
              console.log(`     - ${name}: ${formatPropertyType(prop)}`);
            }

            const totalProps = Object.keys(properties).length;
            if (totalProps > 9) {
              console.log(`     ... and ${totalProps - 9} more`);
            }
          }
          console.log('');
        } catch (dbError) {
          console.warn(`   Warning: could not read database ${db?.id || 'unknown'}: ${(dbError as Error).message}`);
          if (!options.compact) console.log('');
        }
      }

      if (result.has_more) {
        const message = `More indexed results are available (cursor: ${result.next_cursor}).`;
        console.error(message);
      }
    }));

  // Get detailed schema for a database
  databases
    .command('schema <database_id>')
    .description('Get detailed schema for a database')
    .option('-j, --json', 'Output the normalized data-source schema as JSON')
    .action(withErrorHandler(async (databaseId: string, options) => {
      const client = getClient();
      const db = await getDatabaseSchema(client, databaseId);

      if (options.json) {
        console.log(formatOutput(db));
        return;
      }

      const title = getDbTitle(db);
      const desc = getDbDescription(db);

      console.log(`# Database: ${title}\n`);
      console.log(`ID: ${db.id}`);
      if (desc) console.log(`Description: ${desc}`);
      console.log(`\n## Properties\n`);

      for (const [name, prop] of Object.entries(db.properties)) {
        const typeInfo = formatPropertyType(prop);
        console.log(`- **${name}** (${typeInfo})`);
        if (typeof prop.id === 'string') console.log(`  ID: ${prop.id}`);

        if (prop.type === 'select' || prop.type === 'multi_select') {
          const data = prop[prop.type] as { options?: SelectOption[] };
          const opts = data?.options || [];
          if (opts.length > 0) {
            console.log(`  Options: ${opts.map(o => `"${o.name}"`).join(', ')}`);
          }
        } else if (prop.type === 'status') {
          const data = prop.status as { options?: SelectOption[]; groups?: StatusGroup[] };
          const opts = data?.options || [];
          const groups = data?.groups || [];

          for (const group of groups) {
            const groupOpts = opts.filter(o => group.option_ids.includes(o.id));
            if (groupOpts.length > 0) {
              console.log(`  ${group.name}: ${groupOpts.map(o => `"${o.name}"`).join(', ')}`);
            }
          }
        }
      }

      console.log(`\n## Usage Examples\n`);
      console.log('```bash');
      console.log(`# Query this database`);
      console.log(`notion db query ${normalizeNotionId(databaseId)} --limit 10`);
      console.log('');
      console.log(`# Create a new entry`);
      console.log(`notion page create --parent ${normalizeNotionId(databaseId)} --title "New Item"`);
      console.log('```');
    }));

  // Get database
  databases
    .command('get <database_id>')
    .description('Retrieve the resolved data-source schema')
    .option('-j, --json', 'Output the normalized data-source schema as JSON')
    .action(withErrorHandler(async (databaseId: string, options) => {
      const client = getClient();
      const db = await getDatabaseSchema(client, databaseId) as Database & Record<string, unknown>;

      if (options.json) {
        console.log(formatOutput(db));
      } else {
        console.log('Database:', formatDatabaseTitle(db));
        console.log('ID:', db.id);
        console.log('\nProperties:');
        for (const [name, prop] of Object.entries(db.properties)) {
          console.log(`  - ${name}: ${prop.type}`);
        }
      }
    }));

  // Query database
  databases
    .command('query <database_id>')
    .description('Query pages in a database or data source')
    .option('-f, --filter <json>', 'Raw Notion filter JSON (repeatable; combined with AND)', collectOption, [] as string[])
    .option('--filter-prop <property>', 'Property to filter on (repeatable)', collectOption, [] as string[])
    .option('--filter-type <type>', 'Filter operator: equals, contains, is_empty, etc. (repeatable)', collectOption, [] as string[])
    .option('--filter-value <value>', 'Filter value; omit for valueless operators (repeatable)', collectOption, [] as string[])
    .option('--filter-prop-type <propType>', 'Explicit property type override (repeatable; otherwise uses schema)', collectOption, [] as string[])
    .option('--filter-properties <property>', 'Return only this property ID or name (repeatable)', collectOption, [] as string[])
    .option('-s, --sort <property>', 'Sort by property')
    .option('--sort-dir <direction>', 'Sort direction: asc, desc', 'desc')
    .option('--title <value>', 'Filter by exact title (auto-detects title property)')
    .option('-l, --limit <number>', 'Results per API page (1-100)', '100')
    .option('--cursor <cursor>', 'Pagination cursor for a single-page query')
    .option('--all', 'Fetch every returned row, failing on an incomplete row query')
    .option('-j, --json', 'Output the raw/synthesized list envelope as JSON')
    .option('--jsonl', 'Output one returned row object per line after the query completes')
    .action(withErrorHandler(async (databaseId: string, options) => {
      const client = getClient();

      if (options.all && options.cursor) {
        throw new Error('--all cannot be combined with --cursor.');
      }
      if (options.json && options.jsonl) {
        throw new Error('--json and --jsonl are mutually exclusive.');
      }
      if (options.jsonl && !options.all) {
        throw new Error('--jsonl requires --all so the stream cannot silently omit later pages.');
      }

      const body: Record<string, unknown> = { result_type: 'page' };
      const filters: Record<string, unknown>[] = [];

      for (const rawFilter of options.filter as string[]) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawFilter);
        } catch (error) {
          throw new Error(`Invalid --filter JSON: ${(error as Error).message}`);
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('--filter must contain a JSON object.');
        }
        filters.push(parsed as Record<string, unknown>);
      }

      const props: string[] = options.filterProp;
      const types: string[] = options.filterType;
      const values: string[] = options.filterValue;
      const propTypes: string[] = options.filterPropType;

      if (props.length !== types.length) {
        throw new Error('--filter-prop and --filter-type must be provided the same number of times.');
      }
      if (propTypes.length !== 0 && propTypes.length !== props.length) {
        throw new Error('--filter-prop-type must be provided either for all filter groups or for none.');
      }
      const expectedValues = types.filter(type => !isValuelessFilterOperator(type)).length;
      if (values.length !== expectedValues) {
        throw new Error(
          `Expected ${expectedValues} --filter-value option(s) for ${props.length} filter(s); ` +
          'is_empty, is_not_empty, and relative date operators do not take values.',
        );
      }

      let schema: Database | undefined;
      if (
        options.title
        || options.filterProperties.length > 0
        || (props.length > 0 && propTypes.length === 0)
      ) {
        schema = await getDatabaseSchema(client, databaseId);
      }

      const filterProperties = options.filterProperties.length > 0
        ? resolveFilterProperties(options.filterProperties, schema!.properties)
        : undefined;

      if (options.title) {
        const titlePropName = Object.entries(schema!.properties)
          .find(([, property]) => property.type === 'title')?.[0];
        if (!titlePropName) {
          throw new Error(`Data source ${databaseId} has no title property.`);
        }
        filters.push({
          property: titlePropName,
          title: { equals: options.title },
        });
      }

      if (props.length > 0) {
        let valueIndex = 0;
        props.forEach((property, index) => {
          const operator = types[index];
          const value = isValuelessFilterOperator(operator) ? undefined : values[valueIndex++];
          filters.push(parseFilter(property, operator, value, propTypes[index], schema?.properties));
        });
      }

      const filter = combineFilters(filters);
      if (filter) body.filter = filter;

      // Handle sort
      let sorts: Record<string, unknown>[] | undefined;
      if (options.sort) {
        if (options.sortDir !== 'asc' && options.sortDir !== 'desc') {
          throw new Error('--sort-dir must be "asc" or "desc".');
        }
        sorts = [{
          property: options.sort,
          direction: options.sortDir === 'asc' ? 'ascending' : 'descending',
        }];
        body.sorts = sorts;
      }

      const pageSize = positiveInteger(options.limit, '--limit', 100);
      body.page_size = pageSize;
      if (options.cursor) body.start_cursor = options.cursor;

      type QueryPage = { id: string; properties: Record<string, unknown> };
      type QueryResult = Omit<PaginatedResponse<QueryPage>, 'next_cursor'> & {
        object?: string;
        next_cursor?: string | null;
      };
      let result: QueryResult;

      if (options.all && options.jsonl) {
        await outputCompleteJsonl(client, databaseId, {
          filter,
          sorts,
          filterProperties,
          pageSize,
        });
        return;
      }

      if (options.all) {
        const pages = await queryAllPages(client, databaseId, {
          filter,
          sorts,
          filterProperties,
          pageSize,
        });
        result = {
          object: 'list',
          results: pages,
          has_more: false,
          next_cursor: null,
        };
      } else {
        result = await queryDatabase<QueryResult>(
          client,
          databaseId,
          body,
          { filterProperties },
        );
      }

      if (options.json) {
        console.log(formatOutput(result));
        return;
      }

      for (const item of result.results) {
        const title = getItemTitle(item);
        console.log(`${item.id} ${title}`);
      }
      if (result.has_more) {
        console.error(`More results are available (cursor: ${result.next_cursor}).`);
      }
    }));

}

function getItemTitle(item: { properties: Record<string, unknown> }): string {
  for (const prop of Object.values(item.properties)) {
    const typedProp = prop as { type: string; title?: Array<{ plain_text: string }> };
    if (typedProp.type === 'title' && typedProp.title) {
      return typedProp.title.map(t => t.plain_text).join('') || 'Untitled';
    }
  }
  return 'Untitled';
}
