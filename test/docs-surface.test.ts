import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');
const readme = read('README.md');
const skill = read('skills/notion/SKILL.md');
const filters = read('skills/notion/references/filters.md');

describe('documentation contract', () => {
  it('documents the native Markdown and data-source workflow', () => {
    for (const document of [readme, skill]) {
      expect(document).toContain('notion db query');
      expect(document).toContain('notion page read');
      expect(document).toContain('notion page edit');
      expect(document).toContain('notion page replace');
      expect(document).toContain('NOTION_API_TOKEN');
    }
    expect(readme).toContain('request_status.type = "incomplete"');
    expect(readme).toContain('Complete row traversal does not guarantee fully hydrated property values');
    expect(filters).toContain('--filter-properties <property-id-or-name>');
  });

  it('positions current Notion tooling and authentication honestly', () => {
    expect(readme).toContain('`ntn` now also has first-class data-source resolution/query');
    expect(readme).toContain('personal access token (PAT)');
    expect(skill).toContain('personal access token');
    expect(readme).toContain('official `ntn` credential store is not shared');
    expect(readme).toContain('Notion Workers are complementary');
  });

  it('documents generic artifact recipes and digest-bound staged ingestion', () => {
    for (const document of [readme, skill]) {
      expect(document).toContain('notion recipes list');
      expect(document).toContain('notion recipes describe');
      expect(document).toContain('notion recipes run');
      expect(document).toContain('--recipes-dir');
      expect(document).toContain('notion ingest stage');
      expect(document).toContain('notion ingest apply');
      expect(document).toContain('notion ingest reconcile');
      expect(document).toContain('--expect-digest');
    }
    expect(readme).toContain('do not require `NOTION_API_TOKEN`');
    expect(readme).toContain('does not execute a recipe or fetch the source URL again');
    expect(readme).toContain('private companion journal files');
    expect(readme).toContain('original manifest path');
  });

  it('does not teach retired command surfaces', () => {
    const retiredExamples = [
      'notion find ',
      'notion block ',
      'notion batch ',
      'notion bulk ',
      'notion export ',
      'notion import ',
      '--llm',
    ];

    for (const document of [readme, skill, filters]) {
      for (const example of retiredExamples) {
        expect(document).not.toContain(example);
      }
    }
  });

  it('has removed the obsolete batch reference', () => {
    expect(existsSync(new URL('skills/notion/references/batch-patterns.md', root))).toBe(false);
  });

  it('uses the fork ownership metadata without claiming a published release', () => {
    const packageJson = JSON.parse(read('package.json')) as {
      name: string;
      version: string;
      repository: { url: string };
      files: string[];
    };

    expect(packageJson.name).toBe('@adriankpierce/notion-cli-agent');
    expect(packageJson.version).toBe('0.12.0-alpha.0');
    expect(packageJson.repository.url).toContain('adriankpierce/notion-cli-agent');
    expect(packageJson.files).toContain('skills');
    expect(readme).toMatch(/It has not been published to[\s>]+npm/);
  });
});
