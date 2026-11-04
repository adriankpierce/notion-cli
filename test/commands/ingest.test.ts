import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getClient: vi.fn(),
  resolveDatabase: vi.fn(),
  executeRecipe: vi.fn(),
  stageIngestion: vi.fn(),
  applyIngestion: vi.fn(),
  reconcileIngestCreation: vi.fn(),
}));

vi.mock('../../src/client.js', () => ({ getClient: mocks.getClient }));
vi.mock('../../src/utils/database-resolver.js', () => ({ resolveDatabase: mocks.resolveDatabase }));
vi.mock('../../src/commands/recipes.js', () => ({ executeRecipe: mocks.executeRecipe }));
vi.mock('../../src/ingest/index.js', () => ({
  stageIngestion: mocks.stageIngestion,
  applyIngestion: mocks.applyIngestion,
  reconcileIngestCreation: mocks.reconcileIngestCreation,
}));

import { registerIngestCommand } from '../../src/commands/ingest.js';

const fakeClient = {
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
};

const artifact = {
  schema_version: 1 as const,
  source_url: 'https://example.com/post',
  title: 'Converted title',
  markdown: '# Converted\n\n![Image](https://cdn.example.com/image.png)',
  assets: [{
    asset_type: 'image' as const,
    source_url: 'https://cdn.example.com/image.png',
    sha256: 'a'.repeat(64),
    byte_length: 42,
    content_type: 'image/png',
  }],
};

function registerProgram(): Command {
  const program = new Command();
  registerIngestCommand(program);
  return program;
}

function loggedJson(): unknown {
  const calls = vi.mocked(console.log).mock.calls;
  return JSON.parse(String(calls.at(-1)?.[0]));
}

describe('ingest command', () => {
  beforeEach(() => {
    mocks.getClient.mockReturnValue(fakeClient);
    mocks.executeRecipe.mockResolvedValue({
      recipe: {
        descriptor: { name: 'article-reader', recipe_version: '1.2.3' },
      },
      requestedUrl: 'https://example.com/post',
      artifact,
    });
    mocks.stageIngestion.mockImplementation(async (request, manifestPath) => ({
      digest: 'b'.repeat(64),
      recipe: request.recipe,
      target: request.target,
      manifestPath,
    }));
    mocks.applyIngestion.mockResolvedValue({
      status: 'applied',
      operation: 'updated',
      page_id: 'page-id',
      manifest_digest: 'c'.repeat(64),
    });
    mocks.reconcileIngestCreation.mockResolvedValue({
      status: 'reconciled',
      operation: 'created',
      page_id: 'created-page-id',
      manifest_digest: 'd'.repeat(64),
    });
  });

  it('stages an existing page with provenance and asset attestations intact', async () => {
    const program = registerProgram();
    await program.parseAsync([
      'node', 'test', 'ingest', 'stage', 'https://example.com/post',
      '--recipe', 'article-reader',
      '--recipes-dir', './trusted-recipes',
      '--page', 'page-id',
      '--manifest', './manifest.json',
    ]);

    expect(mocks.getClient).toHaveBeenCalledTimes(1);
    expect(mocks.executeRecipe).toHaveBeenCalledWith('https://example.com/post', expect.objectContaining({
      recipe: 'article-reader',
      recipesDir: ['./trusted-recipes'],
    }));
    expect(mocks.stageIngestion).toHaveBeenCalledWith({
      recipe: {
        name: 'article-reader',
        release: '1.2.3',
        requested_url: 'https://example.com/post',
      },
      target: { kind: 'existing_page', page_id: 'page-id' },
      artifact,
    }, './manifest.json', { client: fakeClient });
    expect(fakeClient.post).not.toHaveBeenCalled();
    expect(fakeClient.patch).not.toHaveBeenCalled();
    expect(loggedJson()).toEqual({
      manifest_path: './manifest.json',
      digest: 'b'.repeat(64),
      recipe: {
        name: 'article-reader',
        release: '1.2.3',
        requested_url: 'https://example.com/post',
      },
      target: { kind: 'existing_page', page_id: 'page-id' },
    });
  });

  it('keeps page-parent staging auth-free and rejects database-only property bindings', async () => {
    const program = registerProgram();
    await program.parseAsync([
      'node', 'test', 'ingest', 'stage', 'https://example.com/post',
      '--recipe', 'auto',
      '--parent', 'parent-page-id',
      '--parent-type', 'page',
      '--manifest', './manifest.json',
    ]);

    expect(mocks.getClient).not.toHaveBeenCalled();
    expect(mocks.resolveDatabase).not.toHaveBeenCalled();
    expect(mocks.stageIngestion).toHaveBeenCalledWith(
      expect.objectContaining({
        target: {
          kind: 'new_page',
          parent: { type: 'page_id', id: 'parent-page-id' },
        },
      }),
      './manifest.json',
      expect.objectContaining({ client: expect.any(Object) }),
    );
    expect(fakeClient.post).not.toHaveBeenCalled();
    expect(fakeClient.patch).not.toHaveBeenCalled();

    const invalid = registerProgram();
    await expect(invalid.parseAsync([
      'node', 'test', 'ingest', 'stage', 'https://example.com/post',
      '--recipe', 'auto',
      '--parent', 'parent-page-id',
      '--parent-type', 'page',
      '--title-property', 'Name',
      '--manifest', './manifest.json',
    ])).rejects.toThrow(/database parents/);
    expect(mocks.executeRecipe).toHaveBeenCalledTimes(1);
  });

  it('resolves database parents to data sources and binds only safe properties', async () => {
    mocks.resolveDatabase.mockResolvedValue({
      dataSourceId: 'resolved-source-id',
      schema: {
        properties: {
          Name: { type: 'title' },
          'Source URL': { type: 'url' },
        },
      },
    });
    const program = registerProgram();
    await program.parseAsync([
      'node', 'test', 'ingest', 'stage', 'https://example.com/post',
      '--recipe', 'auto',
      '--parent', 'database-id',
      '--parent-type', 'database',
      '--title-property', 'Name',
      '--source-url-property', 'Source URL',
      '--manifest', './manifest.json',
    ]);

    expect(mocks.resolveDatabase).toHaveBeenCalledWith(fakeClient, 'database-id');
    expect(mocks.stageIngestion).toHaveBeenCalledWith(
      expect.objectContaining({
        target: {
          kind: 'new_page',
          parent: { type: 'data_source_id', id: 'resolved-source-id' },
          property_bindings: {
            title_property: 'Name',
            source_url_property: 'Source URL',
          },
        },
      }),
      './manifest.json',
      { client: fakeClient },
    );
  });

  it('automatically binds the database title property for new-page ingestion', async () => {
    mocks.resolveDatabase.mockResolvedValue({
      dataSourceId: 'resolved-source-id',
      schema: {
        properties: {
          Name: { type: 'title' },
          Source: { type: 'url' },
        },
      },
    });
    const program = registerProgram();
    await program.parseAsync([
      'node', 'test', 'ingest', 'stage', 'https://example.com/post',
      '--recipe', 'article-reader',
      '--parent', 'database-id',
      '--parent-type', 'database',
      '--manifest', './manifest.json',
    ]);

    expect(mocks.stageIngestion).toHaveBeenCalledWith(
      expect.objectContaining({
        target: {
          kind: 'new_page',
          parent: { type: 'data_source_id', id: 'resolved-source-id' },
          property_bindings: { title_property: 'Name' },
        },
      }),
      './manifest.json',
      { client: fakeClient },
    );
  });

  it('applies and reconciles reviewed manifests without executing a recipe', async () => {
    const applyProgram = registerProgram();
    await applyProgram.parseAsync([
      'node', 'test', 'ingest', 'apply', './manifest.json',
      '--expect-digest', 'c'.repeat(64),
    ]);
    expect(mocks.applyIngestion).toHaveBeenCalledWith(
      './manifest.json',
      'c'.repeat(64),
      { client: fakeClient },
    );
    expect(loggedJson()).toEqual({
      status: 'applied',
      operation: 'updated',
      page_id: 'page-id',
      manifest_digest: 'c'.repeat(64),
    });

    const reconcileProgram = registerProgram();
    await reconcileProgram.parseAsync([
      'node', 'test', 'ingest', 'reconcile', './manifest.json',
      '--page', 'created-page-id',
      '--expect-digest', 'd'.repeat(64),
    ]);
    expect(mocks.reconcileIngestCreation).toHaveBeenCalledWith(
      './manifest.json',
      'd'.repeat(64),
      'created-page-id',
      { client: fakeClient },
    );
    expect(loggedJson()).toEqual({
      status: 'reconciled',
      operation: 'created',
      page_id: 'created-page-id',
      manifest_digest: 'd'.repeat(64),
    });
    expect(mocks.executeRecipe).not.toHaveBeenCalled();
  });

  it('validates target exclusivity before executing an untrusted recipe', async () => {
    const program = registerProgram();
    await expect(program.parseAsync([
      'node', 'test', 'ingest', 'stage', 'https://example.com/post',
      '--recipe', 'auto',
      '--manifest', './manifest.json',
    ])).rejects.toThrow(/exactly one target/);
    expect(mocks.executeRecipe).not.toHaveBeenCalled();
  });
});
