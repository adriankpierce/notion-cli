import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Command } from 'commander';

describe('Help Agent Command', () => {
  let program: Command;

  beforeEach(async () => {
    vi.resetModules();

    // Import command and register it
    const { registerHelpAgentCommand } = await import('../../src/commands/help-agent');
    program = new Command();
    registerHelpAgentCommand(program);
  });

  describe('quickstart', () => {
    it('should display quickstart guide', async () => {
      await program.parseAsync(['node', 'test', 'quickstart']);

      expect(console.log).toHaveBeenCalled();
      const output = (console.log as any).mock.calls[0][0];
      expect(output).toContain('Quick Reference');
      expect(output).toContain('Setup');
    });

    it('should explain workspace discovery and data-source resolution', async () => {
      await program.parseAsync(['node', 'test', 'quickstart']);

      const output = (console.log as any).mock.calls[0][0];
      expect(output).toContain('notion db list');
      expect(output).toContain('notion db schema');
      expect(output).toContain('Queries run against a data source');
      expect(output).toContain('--data-source-id');
    });

    it('should include search and query examples', async () => {
      await program.parseAsync(['node', 'test', 'quickstart']);

      const output = (console.log as any).mock.calls[0][0];
      expect(output).toContain('notion search');
      expect(output).toContain('notion db query');
    });

    it('should include create and update examples', async () => {
      await program.parseAsync(['node', 'test', 'quickstart']);

      const output = (console.log as any).mock.calls[0][0];
      expect(output).toContain('notion page create');
      expect(output).toContain('notion page update');
      expect(output).toContain('notion page edit');
    });

    it('should document native Markdown and file workflows', async () => {
      await program.parseAsync(['node', 'test', 'quickstart']);

      const output = (console.log as any).mock.calls[0][0];
      expect(output).toContain('Verbatim enhanced Markdown');
      expect(output).toContain('notion file upload');
      expect(output).toContain('Local files use Notion\'s upload lifecycle internally');
    });

    it('should include output and safety guidance', async () => {
      await program.parseAsync(['node', 'test', 'quickstart']);

      const output = (console.log as any).mock.calls[0][0];
      expect(output).toContain('Output and safety');
      expect(output).toContain('case-sensitive');
      expect(output).toContain('dry-run');
      expect(output).toContain('stderr');
    });

    it('should include recipe and digest-bound ingestion guidance', async () => {
      await program.parseAsync(['node', 'test', 'quickstart']);

      const output = (console.log as any).mock.calls[0][0];
      expect(output).toContain('notion recipes list');
      expect(output).toContain('notion recipes run');
      expect(output).toContain('notion ingest stage');
      expect(output).toContain('notion ingest apply');
      expect(output).toContain('notion ingest reconcile');
      expect(output).toContain('--expect-digest');
      expect(output).toContain('without rerunning the recipe');
    });

    it('should include property type documentation', async () => {
      await program.parseAsync(['node', 'test', 'quickstart']);

      const output = (console.log as any).mock.calls[0][0];
      expect(output).toContain('filter-prop-type');
      expect(output).toContain('status');
      expect(output).toContain('select');
      expect(output).toContain('checkbox');
    });

    it('does not teach retired or unsafe interfaces', async () => {
      await program.parseAsync(['node', 'test', 'quickstart']);

      const output = (console.log as any).mock.calls[0][0];
      expect(output).not.toContain('notion block');
      expect(output).not.toContain('notion batch');
      expect(output).not.toContain('notion bulk');
      expect(output).not.toContain('--token');
      expect(output).not.toContain('--llm');
      expect(output).not.toContain('notion find');
    });
  });

  describe('quickstart alias', () => {
    it('should work with qs alias', async () => {
      await program.parseAsync(['node', 'test', 'qs']);

      expect(console.log).toHaveBeenCalled();
      const output = (console.log as any).mock.calls[0][0];
      expect(output).toContain('Quick Reference');
    });
  });
});
