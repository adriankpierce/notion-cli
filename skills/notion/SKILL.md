---
name: notion
description: Use the local Notion CLI for schema-aware data-source queries and safe page metadata, property, native Markdown, comment, and file workflows. Use when an agent should work with Notion through deterministic shell commands and structured output.
---

# Notion CLI

Use `notion` as a focused interface to Notion pages, native enhanced Markdown,
and data sources. It intentionally does not expose general block CRUD.

Authentication comes from `NOTION_API_TOKEN`. A personal access token is a good
fit for local user-owned workflows; an internal connection token is appropriate
for stable bot-owned automation. Legacy `NOTION_TOKEN` and `NOTION_API_KEY` are
accepted, as are the local config files documented in the project README. Never
put a token in a command argument, prompt, log, or file in the repository.

## Start by resolving the data model

A Notion database is a container. Its rows and schema belong to a data source.
The CLI accepts a database ID or data-source ID and resolves the source when the
database contains exactly one. For a multi-source database, add the global
`--data-source-id <id>` option before the command.

Commands accept dashed UUIDs, compact UUIDs, and Notion page/database URLs.

```bash
notion db list --compact
notion db schema <database-or-source-id>
notion --data-source-id <source-id> db schema <database-id>
```

`db list` and `search` use Notion's eventually consistent title index. They are
discovery tools, not exhaustive inventories or full-text search.

## Query rows

Use `db query`, never workspace search, to filter rows in a known data source.

```bash
notion db query <database-or-source-id> --limit 20 --json
notion db query <database-or-source-id> --title "Exact title" --json
notion db query <database-or-source-id> --all --jsonl
notion db query <database-or-source-id> \
  --filter-prop Status --filter-type equals --filter-value Done
```

The CLI loads the schema to determine the property type. Repeat each shorthand
flag group to combine filters with `AND`. Omit `--filter-value` for operators
such as `is_empty`, `is_not_empty`, and relative-date operators.

```bash
notion db query <source-id> \
  --filter-prop Status --filter-type does_not_equal --filter-value Done \
  --filter-prop Assignee --filter-type is_empty \
  --filter-properties Name --filter-properties Status --json
```

Use repeated `--filter '<json>'` for advanced Notion filter objects. Read
`references/filters.md` before constructing a property filter whose operator or
type is uncertain.

Use `--all` for complete row traversal and `--jsonl` for one returned row object
per line. The CLI stages JSONL in a private temporary file until row-query
completeness is known. If Notion marks a query incomplete at its 10,000-result
limit, the CLI fails without emitting a partial stream. Narrow the filter into
non-overlapping time windows; do not treat a partial set as complete.

Row pagination does not fully hydrate every property. Notion can truncate
inline title, rich-text, people, relation, formula, and rollup values. Inspect
property metadata such as `has_more`; when a complete value matters, run
`notion page property <page-id> <property-id> --all --json`.

## Read pages

Choose the smallest operation that supplies the needed data:

```bash
notion page get <page-id> --json                 # metadata and properties
notion page property <page-id> <property-id> --all --json
notion page read <page-id>                       # verbatim Markdown on stdout
notion page read <page-id> --json                # native response metadata
notion page read <page-id> --include-transcript -o page.md
```

Use `page property --all` for a complete potentially paginated property value.
Markdown reads fail before output when truncated or unknown by default; pass
`--allow-incomplete` only when partial content is explicitly acceptable.
Meeting-note transcripts require `--include-transcript`.

## Create pages

Provide Markdown through `--file`, `--file -`, or piped stdin:

```bash
notion page create --parent <database-id> --title "Meeting notes" --file notes.md
printf '# Body\n' | notion page create --parent <database-id> --title "New page"
notion page create --parent <page-id> --parent-type page --title "Child page"
```

For database-backed pages, untyped `--prop 'Name=value'` values are resolved
from the schema. An explicit `Name:type=value` overrides it. Prefer schema-backed
values; use `Name:json=<complete-property-json>` only as an API-level escape
hatch.

```bash
notion page create --parent <database-id> --title "Task" \
  --prop "Status=Todo" --prop "Priority=High"
```

## Update pages safely

Update properties independently from the body:

```bash
notion page update <page-id> --prop "Status=Done"
notion page update <page-id> --clear-prop Assignee
notion page update <page-id> --title "New title"
```

Prefer a targeted native Markdown edit and preview it first:

```bash
notion page edit <page-id> --search "old text" --replace "new text" --dry-run
notion page edit <page-id> --search "old text" --replace "new text"
```

Search is exact and case-sensitive. Use `--all` only after confirming that every
match should change.

Full replacement is destructive and should be used only when the complete
desired body is known:

```bash
notion page replace <page-id> --file replacement.md
printf '# Replacement\n' | notion page replace <page-id>
```

Child pages and databases are protected unless
`--allow-deleting-content` is explicitly passed. Do not pass it without user
authorization and an understanding of what will be removed. `--async` is
available for large create, edit, and replace operations; the CLI waits for the
Notion task result.

Notion Markdown can contain temporary signed media URLs. Markdown writes reject
those URLs by default because copying them creates future broken links. Download
and re-upload durable assets; use `--allow-temporary-media` only with explicit
acceptance of expiry.

## Files

Publicly hosted media can be inserted through enhanced Markdown. Private local
files require Notion's upload lifecycle and an internal attachment step:

```bash
notion file upload <page-id> diagram.png --caption "Architecture"
notion file upload <page-id> --url https://example.com/report.pdf
```

Local uploads above 20 MiB are rejected until multipart upload is implemented.
For integration tokens, the CLI also enforces the bot workspace limit when it
is reported. Personal access tokens do not expose that value through the
current-user response, so Notion enforces any lower limit at upload creation.
Do not retain Notion-hosted response URLs as permanent asset URLs; they expire.

## Recipes and staged ingestion

Recipes convert a URL into a reviewable JSON artifact without contacting Notion.
This package ships no source-specific recipes. Load executable recipes only from
trusted directories and make discovery explicit:

```bash
notion recipes list --recipes-dir ./team-recipes
notion recipes describe article --recipes-dir ./team-recipes
notion recipes run https://example.com/post \
  --recipe auto --recipes-dir ./team-recipes --timeout 30000 > artifact.json
```

Recipe commands do not require `NOTION_API_TOKEN`. Prefer a named recipe for
unattended work; `auto` must resolve one deterministic, unambiguous match.
Recipes are unsandboxed executable code that can access files, the network, and
spawn processes. Use only explicitly trusted recipe directories.

Use staged ingestion for Notion writes. Stage performs no mutation, even when it
reads a target page to bind the plan:

```bash
notion ingest stage https://example.com/post \
  --recipe article --recipes-dir ./team-recipes \
  --page <page-id> --manifest ./ingest-manifest.json
notion ingest apply ./ingest-manifest.json \
  --expect-digest <sha256-printed-by-stage>
```

For a new page, replace `--page` with `--parent <id> --parent-type page|database`.
The recipe artifact must include a title for new pages. Database staging binds
the schema title property automatically; `--title-property` is an explicit
override.
Review both the private manifest and the separately printed digest. Apply takes
content only from that manifest: it does not rerun the recipe or refetch the
source, though it still reads Notion and any readback asset URLs to verify
preconditions and results. If apply reports an unknown new-page write outcome,
do not rerun it blindly. Once the created page ID is known, reconcile it
explicitly, but only after the original apply process has terminated:

```bash
notion ingest reconcile ./ingest-manifest.json --page <created-page-id> \
  --expect-digest <sha256-printed-by-stage>
```

Apply writes private companion journal files beside the manifest. After a
creation attempt, keep them with the manifest and continue from the original
manifest path; never move, copy, or delete the manifest independently.

## Comments

```bash
notion comment list <page-id> --json
notion comment create --page <page-id> --text "Please review this section."
```

Comments are page-oriented review metadata; they do not expose general block
editing.

## Output and failure rules

- Prefer `--json` for metadata, queries, properties, and mutation results.
- Treat stdout as data and stderr as diagnostics.
- A nonzero status means the workflow did not complete safely.
- Do not discard `truncated`, `unknown_block_ids`, `request_status`, cursors, or
  partial-operation errors.
- Inspect schema before writing select/status values; names are case-sensitive.
- Use `notion <command> --help` when an option is not shown here.
- For low-level endpoints, prefer the official `ntn api`; use `notion api` only
  when the focused CLI must provide the transport.

## Reference

- `references/filters.md` — property types, filter operators, repeated filters,
  and raw filter escape hatches
