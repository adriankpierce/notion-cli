/** Concise, in-terminal workflow reference for agents. */
import { Command } from 'commander';

export function registerHelpAgentCommand(program: Command): void {
  program
    .command('quickstart')
    .alias('qs')
    .description('Quick reference guide for AI agents')
    .action(() => {
      console.log(`
# notion-cli Quick Reference

## Setup
Provide a Notion personal access token or connection token through the calling
environment or a secret manager. The following is a placeholder, not a
recommendation to paste a real token into an interactive shell:

\`\`\`bash
export NOTION_API_TOKEN="ntn_xxx"
\`\`\`

A PAT inherits its creator's page permissions. An internal/public connection
must be shared with every page or database it should access.

## 1. Discover and inspect data sources
\`\`\`bash
notion db list                         # Search visible data sources
notion db list --compact               # Names and IDs only
notion db schema <database-or-source>  # Property types and allowed values
\`\`\`

Notion databases are containers. Queries run against a data source; the CLI
resolves a database ID when it contains exactly one data source. For a database
with several sources, pass global \`--data-source-id <id>\`.
Notion URLs, compact IDs, and dashed IDs are accepted.

## 2. Query rows or discover a title
\`\`\`bash
notion db query <database-or-source> --limit 10
notion db query <database-or-source> --title "Exact Name"
notion db query <database-or-source> --all --jsonl
notion search "title words" --type page --limit 10
\`\`\`

Use \`db query\` for rows in a known data source. Workspace search is an
eventually consistent title-discovery API, not full-text search. An \`--all\`
query completes row pagination, but individual property values can still be
truncated; use \`page property <page-id> <property-id> --all\` when a fully
hydrated relation, rollup, people, title, or rich-text value matters.

## 3. Read page metadata and Markdown
\`\`\`bash
notion page get <page-id>       # Metadata and properties
notion page read <page-id>      # Verbatim enhanced Markdown
notion page read <page-id> --json
\`\`\`

## 4. Create and update pages
\`\`\`bash
notion page create --parent <database-or-source> --title "New Entry" --file body.md
notion page create --parent <database-or-source> --title "Task" \\
  --prop "Status:status=Todo" --prop "Priority:select=High"
notion page update <page-id> --prop "Status:status=Done"
notion page edit <page-id> --search "old text" --replace "new text"
notion page edit <page-id> --search "typo" --replace "fixed" --dry-run
notion page replace <page-id> --file complete-body.md
\`\`\`

Prefer \`page edit\` for a targeted change. \`page replace\` overwrites the full
body and protects child pages/databases unless explicitly allowed. Markdown
reads fail by default if Notion reports incomplete content. Signed, expiring
media URLs are rejected by Markdown writes unless explicitly allowed.

## 5. Attach media
\`\`\`bash
notion file upload <page-id> image.png --caption "Diagram"
notion file upload <page-id> --url https://example.com/report.pdf
\`\`\`

For public media URLs, enhanced Markdown also supports images and media tags.
Local files use Notion's upload lifecycle internally.

## 6. Convert URLs and stage ingestion

\`\`\`bash
notion recipes list --recipes-dir ./team-recipes
notion recipes run https://example.com/post --recipe auto \
  --recipes-dir ./team-recipes > artifact.json
notion ingest stage https://example.com/post --recipe auto \
  --recipes-dir ./team-recipes --page <page-id> --manifest ingest.json
notion ingest apply ingest.json --expect-digest <reviewed-sha256>
notion ingest reconcile ingest.json --page <created-page-id> \
  --expect-digest <reviewed-sha256>
\`\`\`

Recipe commands emit artifacts without Notion authentication. Recipes are
executable local code; load only trusted directories. Staging may read its
Notion target but never mutates it. Apply consumes the reviewed manifest and
digest without rerunning the recipe or refetching the source URL.
An unknown new-page outcome requires explicit reconciliation with its page ID;
never retry that creation blindly or reconcile while its apply process is alive.
Keep apply's private companion journal files beside the original manifest, and
always resume or reconcile using that original manifest path.

## Typed properties and filters

Inspect \`db schema\` first. Property names and select/status values are
case-sensitive. When a type cannot be inferred from the schema, specify it:

- status, select, multi_select, number, date, checkbox, people, relation

Example:
\`\`\`bash
notion db query <database-or-source> \\
  --filter-prop "Status" --filter-type equals --filter-value "Done" \\
  --filter-prop-type status
\`\`\`

## Output and safety

- Default output is compact and intended for terminals and agents.
- Use a command's \`--json\` option when a structured representation is available.
- Use \`--dry-run\` before a content edit.
- Diagnostics go to stderr; redirect stdout safely.

For an endpoint not covered by the focused commands, use \`notion api\` or the
official \`ntn api\` CLI. Public block CRUD is intentionally not exposed.

## Help

\`\`\`bash
notion --help
notion <command> --help
\`\`\`
`);
    });
}
