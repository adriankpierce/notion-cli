# Notion CLI Agent

An opinionated command-line interface for agents that work with Notion pages,
native Markdown, and data sources.

This project is deliberately not a second general-purpose Notion API client.
Notion's official [`ntn`](https://developers.notion.com/cli/get-started/overview)
CLI already provides broad endpoint coverage, authentication tooling, and a raw
API interface. This CLI concentrates on composed agent workflows: resolving a
database to its data source, inspecting a schema, building typed filters and
properties, and treating a page body as Markdown.

`ntn` now also has first-class data-source resolution/query, Markdown page
get/create/edit, and file-upload commands. Use it when those direct operations
are enough. This project remains useful for the extra agent contract around
them: schema-aware property writes and filter shorthand, guarded complete-row
pagination and JSONL, explicit property hydration, exact targeted Markdown
replacement, and deterministic stdout/error behavior.

The public interface does not expose generic block CRUD. A small internal block
operation is retained only to attach a completed local file upload to a page.
Notion Workers are complementary for hosted tools, scheduled jobs, and webhook
automation; this local CLI does not need a Worker as its transport layer.

> **Alpha:** the next release is being prepared as
> `@adriankpierce/notion-cli-agent@0.12.0-alpha.0`. It has not been published to
> npm. Command and output contracts may still change before `0.12.0`.

## Requirements and installation

- Node.js 20 or later
- A Notion personal access token (PAT) with the Notion API capability, or an
  internal/public connection token
- For connection tokens, pages and databases shared with that connection

Until the scoped package is published, install from GitHub:

```bash
npm install --global github:adriankpierce/notion-cli-agent
```

For development:

```bash
git clone https://github.com/adriankpierce/notion-cli-agent.git
cd notion-cli-agent
corepack enable
pnpm install
pnpm build
pnpm link --global
```

## Authentication

For a local user-owned CLI workflow, a Notion PAT is usually the natural auth
model: it inherits your page permissions and does not require pages to be shared
with a bot. For stable team-owned automation, use an internal connection and
share the required pages with it. In either case, pass the token through the
standard `NOTION_API_TOKEN` environment variable:

```bash
export NOTION_API_TOKEN="ntn_your_token_here"
```

`NOTION_TOKEN` and `NOTION_API_KEY` remain compatible for existing setups. The
CLI also reads `~/.config/notion/api_key` and `~/.notion/token`.
The official `ntn` credential store is not shared with this CLI, so an `ntn`
login does not remove the need to provide one of these token sources.

There is intentionally no `--token` option. Passing a secret as an argument can
expose it in shell history and process listings. Do not commit tokens to a
repository or include them in an agent prompt.

## The Notion data model

With Notion API version `2026-03-11`, a database is a container and its rows and
schema belong to a data source. Commands accept either a database ID or a data
source ID and resolve the appropriate endpoint. If a database has several data
sources, select one explicitly:

```bash
notion --data-source-id <source-id> db schema <database-id>
notion --data-source-id <source-id> db query <database-id>
```

IDs may be dashed or compact UUIDs. Page, database, file, and comment commands
also accept Notion page/database URLs and normalize them before making requests.

Workspace search and database query are different operations:

- `notion search` discovers pages and data sources by indexed title. Notion
  search is eventually consistent and is not full-text page search.
- `notion db query` queries rows in one resolved data source and is the correct
  way to filter within a known database.

## Core workflow

### Discover and inspect

```bash
notion db list --compact
notion db schema <database-or-source-id>
notion db get <database-or-source-id> --json
```

`db list` reflects the results currently indexed by Notion workspace search. It
is useful for discovery but should not be treated as an exhaustive inventory.

### Query a data source

```bash
notion db query <database-or-source-id> --limit 20
notion db query <database-or-source-id> --title "Exact title" --json
notion db query <database-or-source-id> --all --jsonl
notion db query <database-or-source-id> \
  --filter-prop Status --filter-type equals --filter-value Done \
  --sort "Created time" --sort-dir desc
```

Property types are read from the data-source schema. An explicit override is
available when necessary:

```bash
notion db query <source-id> \
  --filter-prop Status --filter-type equals --filter-value Done \
  --filter-prop-type status
```

Repeat the filter flags to create an `AND` filter. Values are supplied only for
operators that require them:

```bash
notion db query <source-id> \
  --filter-prop Status --filter-type does_not_equal --filter-value Done \
  --filter-prop Assignee --filter-type is_empty
```

For complex Notion filter objects, repeat `--filter <json>`. Use
`--filter-properties <property-id-or-name>` to reduce response size and
`--cursor` to continue a single response page from `next_cursor`. Use `--all`
to traverse every returned row and `--jsonl` to emit one returned row object per
line. The CLI stages JSONL in a private temporary file until Notion confirms the
row query is complete, so it never prints a partial stream as though it
succeeded.

Complete row traversal does not guarantee fully hydrated property values.
Notion can truncate inline title, rich-text, people, relation, formula, and
rollup data in a row object. Inspect property metadata such as `has_more`; use
`notion page property <page-id> <property-id> --all --json` when the complete
property value matters.

The CLI rejects a response marked `request_status.type = "incomplete"` instead
of silently returning Notion's 10,000-result partial set, including under
`--all`. Narrow the query with a time window and run each partition separately.

See [the filter reference](skills/notion/references/filters.md) for supported
property types and operators.

### Discover a title across the workspace

```bash
notion search "project plan" --type page --limit 10
notion search "Exact title" --exact --first --json
```

Use `db query --title` when the data source is known.

## Pages as native Markdown

The CLI uses Notion's native Markdown endpoints; it does not maintain its own
block-to-Markdown converter.

### Read

```bash
notion page get <page-id>                    # metadata and properties
notion page get <page-id> --content --json   # metadata plus Markdown response
notion page read <page-id>                   # Markdown only on stdout
notion page read <page-id> --json            # native page_markdown response
notion page read <page-id> --include-transcript -o page.md
```

Plain `page read` is a verbatim body: it does not prepend a synthetic title.
Truncated or unknown content fails before output by default. Use
`--allow-incomplete` only when a partial result is intentional. Meeting-note
transcripts are represented by a placeholder unless `--include-transcript` is
requested.

### Create

```bash
notion page create --parent <database-id> --title "Design notes" --file notes.md
printf '# Body\n\nCreated from stdin.\n' | \
  notion page create --parent <database-id> --title "New page"
notion page create --parent <page-id> --parent-type page --title "Child page"
```

Database parents are resolved to data sources before creation. By default,
property names and payload shapes are derived from the schema when one is
available:

```bash
notion page create --parent <database-id> --title "Task" \
  --prop "Status=Todo" \
  --prop "Priority=High"
```

Use `Name:type=value` only to override the schema or for a parent page without
a data-source schema, for example `Status:status=Todo`. A `json` type is the
explicit escape hatch for a complete Notion property value. Explicit type hints
bypass the schema type, and select/status option membership is not prevalidated;
inspect `db schema` and use the exact option name.

### Targeted edit

```bash
notion page edit <page-id> --search "old text" --replace "new text" --dry-run
notion page edit <page-id> --search "old text" --replace "new text"
notion page edit <page-id> --search "repeated" --replace "updated" --all
```

Search text is exact and case-sensitive. Without `--all`, Notion requires one
unambiguous match. `page edit` uses native `update_content`, so it is normally
safer than replacing the full body.

### Full replacement

```bash
notion page replace <page-id> --file replacement.md
printf '# Replacement\n' | notion page replace <page-id>
```

Replacement can delete content. Child pages and child databases are protected
unless `--allow-deleting-content` is supplied explicitly. `--async` asks Notion
to process a large create, edit, or replacement asynchronously and waits for its
task to finish.

Markdown returned by Notion can contain signed media URLs that expire. Create,
edit, and replacement commands reject those URLs by default; download and
re-upload the assets for durable content. `--allow-temporary-media` is an
explicit escape hatch when an expiring reference is truly intended.

### Page properties

```bash
notion page update <page-id> --prop "Status=Done"
notion page update <page-id> --title "New title"
notion page update <page-id> --clear-prop Assignee
notion page archive <page-id>
notion page property <page-id> <property-id> --all --json
```

`page property` retrieves a property item separately, which is important for
paginated relation, rollup, people, title, and rich-text values. Use `--cursor`
for one continuation page or `--all` for a guarded complete traversal.

## Images and files

Enhanced Markdown accepts media that already has a public URL. For example:

```markdown
![Architecture diagram](https://example.com/architecture.png)
<file src="https://example.com/specification.pdf">Specification</file>
```

For a private local file, Notion still requires its File Upload lifecycle and an
attachment step. The CLI hides that exception behind one command:

```bash
notion file upload <page-id> architecture.png --caption "Architecture"
notion file upload <page-id> --url https://example.com/specification.pdf
notion file upload <page-id> architecture.png --position top --json
```

Local files currently use Notion's single-part upload and are limited to 20 MiB.
With integration-token authentication the CLI also enforces any lower limit
reported for the bot's workspace (5 MiB on free workspaces). Personal access
tokens do not expose that value through the current-user response, so Notion
enforces any lower workspace limit when the upload is created. Larger files
require multipart support, which is not implemented yet. URL imports require
HTTPS and are polled until Notion reports success or a timeout.

URLs returned for Notion-hosted files are signed and temporary. A durable export
must download those assets rather than treating their response URLs as stable.

## Comments and raw API access

Comments remain available for review workflows:

```bash
notion comment list <page-id>
notion comment create --page <page-id> --text "Please review this section."
```

For an endpoint outside the focused surface, use the official `ntn api` command
when available. This project retains a small raw escape hatch:

```bash
notion api GET "pages/<page-id>"
notion api POST search --data '{"query":"roadmap"}'
notion api GET users --query "page_size=5" --query "start_cursor=<cursor>"
```

## Agent skill

The published package includes an agent skill with concise workflow guidance and
a detailed filter reference:

```bash
notion skill install
notion skill install /path/to/repository
notion skill install /path/to/repository --force  # replace an existing copy
```

The command installs to `.claude/skills/notion` in the target repository. The
source skill is also available directly at [`skills/notion`](skills/notion).
Existing installations are not overwritten unless `--force` is explicit.

## Output and failure behavior

- Commands that offer `--json` emit JSON on stdout unless an explicit
  `--output` path redirects the requested data to a file.
- Page Markdown and requested data go to stdout; diagnostics go to stderr.
- API errors retain the Notion status, error code, request ID, additional data,
  and retry guidance when present.
- Rate limits honor `Retry-After`. Unsafe mutations are not automatically
  replayed after ambiguous network or server failures.
- A nonzero exit status means the requested operation did not complete safely.

Use `notion quickstart` for an in-terminal agent reference and
`notion <command> --help` for the authoritative options in the installed build.

## Development

```bash
pnpm build
pnpm lint
pnpm test:run
pnpm test:coverage
pnpm package:check
```

`build` removes `dist` before compiling the public dependency graph, preventing
retired or deleted command files from leaking into the package. `package:check`
verifies the command surface and dry-runs the npm tarball.

## License

MIT
