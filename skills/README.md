# Notion CLI agent skill

The `notion` skill teaches an agent the focused CLI workflow without loading a
general Notion API manual into context.

```text
skills/notion/
├── SKILL.md
└── references/
    └── filters.md
```

`SKILL.md` covers discovery, schema-aware data-source queries, page metadata and
native Markdown, guarded edits and replacements, and file uploads. The filter
reference is loaded only when a query needs operator-level detail.

The alpha package is not published to npm yet. Install the CLI from GitHub, then
copy the bundled skill into a repository:

```bash
npm install --global github:adriankpierce/notion-cli-agent
notion skill install /path/to/repository
```

`skill install` writes `.claude/skills/notion` below the target directory. Other
agent runtimes can consume [`notion/SKILL.md`](notion/SKILL.md) directly or copy
the directory to their own skill location. Pass `--force` only when an existing
installed copy should be replaced completely.
