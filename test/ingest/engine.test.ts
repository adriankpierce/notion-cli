import {
  mkdtempSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IngestConflictError,
  IngestManifestError,
  IngestUnknownWriteOutcomeError,
  applyIngestion,
  compareEnhancedMarkdown,
  readIngestManifest,
  reconcileIngestCreation,
  stageIngestion,
  validateIngestArtifact,
  type IngestClient,
  type IngestStageRequest,
} from '../../src/ingest/index.js';
import { NotionApiError } from '../../src/client.js';

const PAGE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PARENT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CREATED_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const OTHER_CREATED_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const EDITED = '2026-08-01T00:00:00.000Z';

function existingRequest(): IngestStageRequest {
  return {
    recipe: {
      name: 'example',
      release: '1.2.3',
      requested_url: 'https://example.com/requested',
    },
    target: { kind: 'existing_page', page_id: PAGE_ID },
    artifact: {
      schema_version: 1,
      source_url: 'https://example.com/source',
      title: 'Imported page',
      markdown: '# Imported page\n\nNew body\n',
    },
  };
}

function newRequest(): IngestStageRequest {
  return {
    ...existingRequest(),
    target: { kind: 'new_page', parent: { type: 'page_id', id: PARENT_ID } },
  };
}

function titleProperty(value = 'Imported page') {
  return {
    id: 'title',
    type: 'title',
    title: [{ plain_text: value, text: { content: value } }],
  };
}

function page(id = PAGE_ID, lastEdited = EDITED, parentId = PARENT_ID) {
  return {
    id,
    created_time: EDITED,
    last_edited_time: lastEdited,
    properties: { title: titleProperty() },
    parent: { type: 'page_id', page_id: parentId },
  };
}

function dataSourcePage(
  properties: Record<string, unknown>,
  id = CREATED_ID,
) {
  return {
    ...page(id),
    properties,
    parent: { type: 'data_source_id', data_source_id: PARENT_ID },
  };
}

function markdown(value: string, incomplete = false) {
  return {
    object: 'page_markdown',
    id: PAGE_ID,
    markdown: value,
    truncated: incomplete,
    unknown_block_ids: incomplete ? ['unknown'] : [],
  };
}

function mockClient(overrides: Partial<IngestClient> = {}): IngestClient {
  return {
    get: vi.fn(async () => { throw new Error('Unexpected GET'); }),
    post: vi.fn(async () => { throw new Error('Unexpected POST'); }),
    patch: vi.fn(async () => { throw new Error('Unexpected PATCH'); }),
    ...overrides,
  } as IngestClient;
}

describe('digest-bound ingestion engine', () => {
  let directory: string;
  let manifestPath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'notion-ingest-test-'));
    manifestPath = join(directory, 'manifest.json');
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('stages an exclusive mode-0600 manifest using reads only and rejects tampering', async () => {
    const get = vi.fn(async (path: string) => (
      path.endsWith('/markdown') ? markdown('Old body\n') : page()
    ));
    const client = mockClient({ get });
    const manifest = await stageIngestion(existingRequest(), manifestPath, {
      client,
      now: () => new Date('2026-08-01T01:00:00.000Z'),
    });

    expect(get).toHaveBeenCalledTimes(2);
    expect(client.post).not.toHaveBeenCalled();
    expect(client.patch).not.toHaveBeenCalled();
    expect(statSync(manifestPath).mode & 0o777).toBe(0o600);
    await expect(stageIngestion(existingRequest(), manifestPath, { client })).rejects.toThrow();

    const changed = JSON.parse(readFileSync(manifestPath, 'utf8'));
    changed.artifact.markdown = 'Tampered\n';
    writeFileSync(manifestPath, JSON.stringify(changed));
    expect(() => readIngestManifest(manifestPath, manifest.digest)).toThrow(IngestManifestError);
  });

  it('requires an explicit artifact title before staging a new page', async () => {
    const request = newRequest();
    request.artifact = {
      schema_version: 1,
      source_url: 'https://example.com/source',
      markdown: '# Implicit title\n\nBody',
    };
    await expect(stageIngestion(request, manifestPath, { client: mockClient() }))
      .rejects.toThrow('requires artifact.title');
  });

  it('refuses a stale existing target before attempting a write', async () => {
    const stageClient = mockClient({
      get: vi.fn(async (path: string) => path.endsWith('/markdown') ? markdown('Old body\n') : page()),
    });
    const manifest = await stageIngestion(existingRequest(), manifestPath, { client: stageClient });
    const client = mockClient({
      get: vi.fn(async (path: string) => (
        path.endsWith('/markdown') ? markdown('Someone changed this\n') : page(PAGE_ID, EDITED)
      )),
    });

    await expect(applyIngestion(manifestPath, manifest.digest, { client }))
      .rejects.toThrow(IngestConflictError);
    expect(client.patch).not.toHaveBeenCalled();
  });

  it('uses the complete staged body as an atomic update guard and strictly verifies readback', async () => {
    const staged = 'Old body\n';
    const target = '# Imported page\n\nNew body\n';
    const stageClient = mockClient({
      get: vi.fn(async (path: string) => path.endsWith('/markdown') ? markdown(staged) : page()),
    });
    const manifest = await stageIngestion(existingRequest(), manifestPath, { client: stageClient });
    let reads = 0;
    const patch = vi.fn(async () => markdown(target));
    const client = mockClient({
      get: vi.fn(async (path: string) => {
        if (!path.endsWith('/markdown')) return page();
        reads += 1;
        return markdown(reads === 1 ? staged : target);
      }),
      patch,
    });

    await expect(applyIngestion(manifestPath, manifest.digest, { client })).resolves.toMatchObject({
      status: 'applied',
      operation: 'updated',
      page_id: PAGE_ID,
    });
    expect(patch).toHaveBeenCalledWith(`pages/${PAGE_ID}/markdown`, {
      type: 'update_content',
      update_content: {
        content_updates: [{
          old_str: staged,
          new_str: target,
          replace_all_matches: false,
        }],
        allow_deleting_content: false,
      },
    });
  });

  it('resumes an already-applied existing target without another mutation', async () => {
    const stageClient = mockClient({
      get: vi.fn(async (path: string) => path.endsWith('/markdown') ? markdown('Old body\n') : page()),
    });
    const manifest = await stageIngestion(existingRequest(), manifestPath, { client: stageClient });
    const client = mockClient({
      get: vi.fn(async (path: string) => (
        path.endsWith('/markdown') ? markdown('# Imported page\n\nNew body\n') : page(PAGE_ID, 'later')
      )),
    });

    await expect(applyIngestion(manifestPath, manifest.digest, { client }))
      .resolves.toMatchObject({ status: 'already_applied' });
    expect(client.patch).not.toHaveBeenCalled();
  });

  it('stops conservatively when an existing-page write outcome is unknown', async () => {
    const stageClient = mockClient({
      get: vi.fn(async (path: string) => path.endsWith('/markdown') ? markdown('Old body\n') : page()),
    });
    const manifest = await stageIngestion(existingRequest(), manifestPath, { client: stageClient });
    const unknown = Object.assign(new Error('connection lost'), { outcomeUnknown: true });
    const client = mockClient({
      get: vi.fn(async (path: string) => path.endsWith('/markdown') ? markdown('Old body\n') : page()),
      patch: vi.fn(async () => { throw unknown; }),
    });

    await expect(applyIngestion(manifestPath, manifest.digest, { client }))
      .rejects.toThrow(IngestUnknownWriteOutcomeError);
  });

  it('never retries an unconfirmed creation and supports explicit reconciliation', async () => {
    const stageClient = mockClient();
    const manifest = await stageIngestion(newRequest(), manifestPath, { client: stageClient });
    const post = vi.fn(async () => { throw Object.assign(new Error('lost'), { outcomeUnknown: true }); });
    const uncertainClient = mockClient({
      get: vi.fn(async () => ({ id: PARENT_ID })),
      post,
    });

    await expect(applyIngestion(manifestPath, manifest.digest, { client: uncertainClient }))
      .rejects.toThrow(IngestUnknownWriteOutcomeError);
    await expect(applyIngestion(manifestPath, manifest.digest, { client: uncertainClient }))
      .rejects.toThrow('Do not retry blindly');
    expect(post).toHaveBeenCalledTimes(1);
    expect(statSync(`${manifestPath}.apply-state.json`).mode & 0o777).toBe(0o600);

    const reconciler = mockClient({
      get: vi.fn(async (path: string) => (
        path.endsWith('/markdown')
          ? markdown('# Imported page\n\nNew body\n')
          : page(CREATED_ID, EDITED, PARENT_ID)
      )),
    });
    await expect(reconcileIngestCreation(
      manifestPath,
      manifest.digest,
      CREATED_ID,
      { client: reconciler },
    )).resolves.toMatchObject({ status: 'reconciled', page_id: CREATED_ID });
  });

  it('atomically arbitrates concurrent reconciliation to different page IDs', async () => {
    const manifest = await stageIngestion(newRequest(), manifestPath, { client: mockClient() });
    const uncertainClient = mockClient({
      get: vi.fn(async () => ({ id: PARENT_ID })),
      post: vi.fn(async () => { throw new Error('connection lost'); }),
    });
    await expect(applyIngestion(manifestPath, manifest.digest, { client: uncertainClient }))
      .rejects.toThrow(IngestUnknownWriteOutcomeError);

    const reconciler = mockClient({
      get: vi.fn(async (path: string) => {
        if (path.endsWith('/markdown')) return markdown('# Imported page\n\nNew body\n');
        const requestedId = path.slice('pages/'.length);
        return page(requestedId, EDITED, PARENT_ID);
      }),
    });
    const results = await Promise.allSettled([
      reconcileIngestCreation(manifestPath, manifest.digest, CREATED_ID, { client: reconciler }),
      reconcileIngestCreation(manifestPath, manifest.digest, OTHER_CREATED_ID, { client: reconciler }),
    ]);

    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof reconcileIngestCreation>>> => (
        result.status === 'fulfilled'
      ),
    );
    expect(fulfilled).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);

    const winningPageId = fulfilled[0].value.page_id;
    const post = vi.fn();
    const resumeClient = mockClient({
      get: vi.fn(async (path: string) => (
        path.endsWith('/markdown')
          ? markdown('# Imported page\n\nNew body\n')
          : page(winningPageId, EDITED, PARENT_ID)
      )),
      post,
    });
    await expect(applyIngestion(manifestPath, manifest.digest, { client: resumeClient }))
      .resolves.toMatchObject({ status: 'already_applied', page_id: winningPageId });
    expect(post).not.toHaveBeenCalled();
  });

  it('refuses reconciliation while the original create POST is still live', async () => {
    const manifest = await stageIngestion(newRequest(), manifestPath, { client: mockClient() });
    let releasePost: ((value: ReturnType<typeof page>) => void) | undefined;
    let announcePost: (() => void) | undefined;
    const postStarted = new Promise<void>(resolve => { announcePost = resolve; });
    const deferredPost = new Promise<ReturnType<typeof page>>(resolve => { releasePost = resolve; });
    const applyClient = mockClient({
      get: vi.fn(async (path: string) => {
        if (path === `pages/${PARENT_ID}`) return { id: PARENT_ID };
        if (path.endsWith('/markdown')) return markdown('# Imported page\n\nNew body\n');
        return page(CREATED_ID, EDITED, PARENT_ID);
      }),
      post: vi.fn(async () => {
        announcePost?.();
        return deferredPost;
      }),
    });
    const applying = applyIngestion(manifestPath, manifest.digest, { client: applyClient });
    await postStarted;

    const reconciler = mockClient({
      get: vi.fn(async (path: string) => (
        path.endsWith('/markdown')
          ? markdown('# Imported page\n\nNew body\n')
          : page(OTHER_CREATED_ID, EDITED, PARENT_ID)
      )),
    });
    await expect(reconcileIngestCreation(
      manifestPath,
      manifest.digest,
      OTHER_CREATED_ID,
      { client: reconciler },
    )).rejects.toThrow(/still live|Refusing to race/);
    expect(reconciler.get).not.toHaveBeenCalled();

    releasePost?.(page(CREATED_ID, EDITED, PARENT_ID));
    await expect(applying).resolves.toMatchObject({ status: 'applied', page_id: CREATED_ID });
    await expect(reconcileIngestCreation(
      manifestPath,
      manifest.digest,
      OTHER_CREATED_ID,
      { client: reconciler },
    )).rejects.toThrow('different page ID');
  });

  it.skipIf(process.platform === 'win32')(
    'uses one creation journal through sequential manifest symlink aliases',
    async () => {
      const manifest = await stageIngestion(newRequest(), manifestPath, { client: mockClient() });
      const aliasPath = join(directory, 'manifest-alias.json');
      symlinkSync(manifestPath, aliasPath);
      const firstPost = vi.fn(async () => page(CREATED_ID));
      const firstClient = mockClient({
        get: vi.fn(async (path: string) => {
          if (path === `pages/${PARENT_ID}`) return { id: PARENT_ID };
          if (path.endsWith('/markdown')) return markdown('# Imported page\n\nNew body\n');
          return page(CREATED_ID, EDITED, PARENT_ID);
        }),
        post: firstPost,
      });
      await expect(applyIngestion(manifestPath, manifest.digest, { client: firstClient }))
        .resolves.toMatchObject({ status: 'applied', page_id: CREATED_ID });

      const secondPost = vi.fn();
      const secondClient = mockClient({
        get: vi.fn(async (path: string) => (
          path.endsWith('/markdown')
            ? markdown('# Imported page\n\nNew body\n')
            : page(CREATED_ID, EDITED, PARENT_ID)
        )),
        post: secondPost,
      });
      await expect(applyIngestion(aliasPath, manifest.digest, { client: secondClient }))
        .resolves.toMatchObject({ status: 'already_applied', page_id: CREATED_ID });
      expect(firstPost).toHaveBeenCalledTimes(1);
      expect(secondPost).not.toHaveBeenCalled();
      expect(existsSync(`${aliasPath}.apply-state.json`)).toBe(false);
    },
  );

  it('recovers an orphaned pre-response creation reservation without another POST', async () => {
    const manifest = await stageIngestion(newRequest(), manifestPath, { client: mockClient() });
    writeFileSync(`${manifestPath}.apply-state.json`, JSON.stringify({
      schema: 'notion-cli.ingest-creation-attempt',
      schema_version: 1,
      manifest_digest: manifest.digest,
      attempt_id: '11111111-1111-4111-8111-111111111111',
      started_at: '2026-08-01T01:00:00.000Z',
    }));
    const post = vi.fn();
    await expect(applyIngestion(manifestPath, manifest.digest, {
      client: mockClient({ post }),
    })).rejects.toThrow('reserved without a confirmed outcome');
    expect(post).not.toHaveBeenCalled();

    const reconciler = mockClient({
      get: vi.fn(async (path: string) => (
        path.endsWith('/markdown')
          ? markdown('# Imported page\n\nNew body\n')
          : page(CREATED_ID, EDITED, PARENT_ID)
      )),
    });
    await expect(reconcileIngestCreation(
      manifestPath,
      manifest.digest,
      CREATED_ID,
      { client: reconciler },
    )).resolves.toMatchObject({ status: 'reconciled', page_id: CREATED_ID });
  });

  it('records a confirmed API rejection as retry-safe and permits a later creation attempt', async () => {
    const manifest = await stageIngestion(newRequest(), manifestPath, { client: mockClient() });
    const post = vi.fn()
      .mockRejectedValueOnce(new NotionApiError('validation failed', {
        status: 400,
        code: 'validation_error',
      }))
      .mockResolvedValueOnce(page(CREATED_ID));
    const client = mockClient({
      get: vi.fn(async (path: string) => {
        if (path === `pages/${PARENT_ID}`) return { id: PARENT_ID };
        if (path.endsWith('/markdown')) return markdown('# Imported page\n\nNew body\n');
        return page(CREATED_ID);
      }),
      post,
    });

    await expect(applyIngestion(manifestPath, manifest.digest, { client }))
      .rejects.toBeInstanceOf(NotionApiError);
    expect(existsSync(`${manifestPath}.apply-state.json`)).toBe(true);
    expect(statSync(`${manifestPath}.apply-state.json`).mode & 0o777).toBe(0o600);

    await expect(applyIngestion(manifestPath, manifest.digest, { client }))
      .resolves.toMatchObject({ status: 'applied', page_id: CREATED_ID });
    expect(post).toHaveBeenCalledTimes(2);
    for (const entry of readdirSync(directory).filter(name => name.startsWith('manifest.json.apply-state'))) {
      expect(statSync(join(directory, entry)).mode & 0o777).toBe(0o600);
    }
  });

  it('serializes concurrent creation attempts after a confirmed rejection', async () => {
    const manifest = await stageIngestion(newRequest(), manifestPath, { client: mockClient() });
    const rejectedClient = mockClient({
      get: vi.fn(async () => ({ id: PARENT_ID })),
      post: vi.fn(async () => {
        throw new NotionApiError('validation failed', {
          status: 400,
          code: 'validation_error',
        });
      }),
    });
    await expect(applyIngestion(manifestPath, manifest.digest, { client: rejectedClient }))
      .rejects.toBeInstanceOf(NotionApiError);

    const post = vi.fn(async () => page(CREATED_ID));
    const client = mockClient({
      get: vi.fn(async (path: string) => {
        if (path === `pages/${PARENT_ID}`) {
          return { id: PARENT_ID };
        }
        if (path.endsWith('/markdown')) return markdown('# Imported page\n\nNew body\n');
        return page(CREATED_ID);
      }),
      post,
    });
    const results = await Promise.allSettled([
      applyIngestion(manifestPath, manifest.digest, { client }),
      applyIngestion(manifestPath, manifest.digest, { client }),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('treats server-side API failures as indeterminate creation outcomes', async () => {
    const manifest = await stageIngestion(newRequest(), manifestPath, { client: mockClient() });
    const post = vi.fn(async () => {
      throw new NotionApiError('internal server error', {
        status: 500,
        code: 'internal_server_error',
      });
    });
    const client = mockClient({
      get: vi.fn(async () => ({ id: PARENT_ID })),
      post,
    });

    await expect(applyIngestion(manifestPath, manifest.digest, { client }))
      .rejects.toThrow(IngestUnknownWriteOutcomeError);
    await expect(applyIngestion(manifestPath, manifest.digest, { client }))
      .rejects.toThrow('Do not retry blindly');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('binds and verifies exact title and source URL properties for data-source pages', async () => {
    const request = newRequest();
    request.target = {
      kind: 'new_page',
      parent: { type: 'data_source_id', id: PARENT_ID },
      property_bindings: { title_property: 'Name', source_url_property: 'Source' },
    };
    const manifest = await stageIngestion(request, manifestPath, { client: mockClient() });
    const created = dataSourcePage({
      Name: titleProperty(),
      Source: { id: 'source', type: 'url', url: 'https://example.com/source' },
    });
    const post = vi.fn(async () => created);
    const client = mockClient({
      get: vi.fn(async (path: string) => {
        if (path === `data_sources/${PARENT_ID}`) {
          return {
            id: PARENT_ID,
            properties: { Name: { type: 'title' }, Source: { type: 'url' } },
          };
        }
        if (path.endsWith('/markdown')) return markdown('# Imported page\n\nNew body\n');
        return created;
      }),
      post,
    });

    await expect(applyIngestion(manifestPath, manifest.digest, { client }))
      .resolves.toMatchObject({ status: 'applied', page_id: CREATED_ID });
    expect(post).toHaveBeenCalledWith('pages', expect.objectContaining({
      parent: { data_source_id: PARENT_ID },
      properties: {
        Name: { title: [{ text: { content: 'Imported page' } }] },
        Source: { url: 'https://example.com/source' },
      },
    }), undefined, { retrySafe: false });

    const wrongProperties = mockClient({
      get: vi.fn(async (path: string) => (
        path.endsWith('/markdown')
          ? markdown('# Imported page\n\nNew body\n')
          : dataSourcePage({
            Name: titleProperty(),
            Source: { id: 'source', type: 'url', url: 'https://example.com/wrong' },
          })
      )),
    });
    await expect(reconcileIngestCreation(
      manifestPath,
      manifest.digest,
      CREATED_ID,
      { client: wrongProperties },
    )).rejects.toThrow('digest-bound source URL property');
  });

  it('requires complete, type-correct asset attestations', () => {
    const digest = createHash('sha256').update('image bytes').digest('hex');
    const base = {
      schema_version: 1,
      source_url: 'https://example.com/post',
      markdown: '![Image](https://assets.example.com/image.png)',
    };
    expect(() => validateIngestArtifact({ ...base, assets: [] }))
      .toThrow('has no attestation');
    expect(() => validateIngestArtifact({
      ...base,
      assets: [{
        source_url: 'https://assets.example.com/image.png',
        asset_type: 'video',
        sha256: digest,
        byte_length: 11,
      }],
    })).toThrow('expected image');
    expect(() => validateIngestArtifact({
      ...base,
      markdown: '# No media',
      assets: [{
        source_url: 'https://assets.example.com/image.png',
        asset_type: 'image',
        sha256: digest,
        byte_length: 11,
      }],
    })).toThrow('is not referenced');

    const oversizedAssets = Array.from({ length: 5 }, (_unused, index) => ({
      source_url: `https://assets.example.com/${index}.png`,
      asset_type: 'image',
      sha256: digest,
      byte_length: 128 * 1024 * 1024,
    }));
    expect(() => validateIngestArtifact({
      ...base,
      markdown: oversizedAssets
        .map(asset => `![Image](${asset.source_url})`)
        .join('\n'),
      assets: oversizedAssets,
    })).toThrow('aggregate limit');
  });

  it('verifies rehosted asset bytes before accepting an applied page', async () => {
    const bytes = Buffer.from('image bytes');
    const request = existingRequest();
    request.artifact = {
      schema_version: 1,
      source_url: 'https://example.com/source',
      markdown: '# Imported page\n\n![Image](https://assets.example.com/image.png)',
      assets: [{
        source_url: 'https://assets.example.com/image.png',
        asset_type: 'image',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        byte_length: bytes.byteLength,
        content_type: 'image/png',
      }],
    };
    const stagedClient = mockClient({
      get: vi.fn(async (path: string) => path.endsWith('/markdown') ? markdown('Old body\n') : page()),
    });
    const manifest = await stageIngestion(request, manifestPath, { client: stagedClient });
    let markdownReads = 0;
    const client = mockClient({
      get: vi.fn(async (path: string) => {
        if (!path.endsWith('/markdown')) return page();
        markdownReads += 1;
        return markdown(markdownReads === 1
          ? 'Old body\n'
          : '# Imported page\n![Image](https://notionusercontent.com/signed.png)');
      }),
      patch: vi.fn(async () => markdown('ignored')),
    });
    const goodFetch = vi.fn(async () => new Response(bytes, {
      headers: { 'content-type': 'image/png; charset=binary' },
    }));
    await expect(applyIngestion(manifestPath, manifest.digest, {
      client,
      fetch: goodFetch as typeof globalThis.fetch,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    })).resolves.toMatchObject({ status: 'applied' });
    expect(goodFetch).toHaveBeenCalledWith(
      new URL('https://notionusercontent.com/signed.png'),
      expect.objectContaining({ redirect: 'error' }),
    );

    const secondPath = join(directory, 'wrong-asset.json');
    const secondManifest = await stageIngestion(request, secondPath, { client: stagedClient });
    markdownReads = 0;
    await expect(applyIngestion(secondPath, secondManifest.digest, {
      client,
      fetch: vi.fn(async () => new Response('wrong bytes')) as typeof globalThis.fetch,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    })).rejects.toThrow('does not match its digest-bound asset bytes');
  });

  it.each([
    ['loopback literal', 'http://127.0.0.1/secret', undefined],
    ['private literal', 'http://10.0.0.1/secret', undefined],
    ['link-local literal', 'http://169.254.169.254/latest', undefined],
    ['deprecated IPv4 relay', 'http://192.88.99.1/secret', undefined],
    ['IPv6 loopback', 'http://[::1]/secret', undefined],
    ['IPv6 benchmarking', 'http://[2001:2::1]/secret', undefined],
    ['IPv6 ORCHID', 'http://[2001:10::1]/secret', undefined],
    ['IPv6 documentation', 'http://[3fff::1]/secret', undefined],
    ['DNS to private', 'https://media.example.com/secret', '10.1.2.3'],
  ])('refuses asset readback SSRF through %s', async (_label, actualUrl, resolvedAddress) => {
    const bytes = Buffer.from('image bytes');
    const request = existingRequest();
    request.artifact = {
      schema_version: 1,
      source_url: 'https://example.com/source',
      markdown: '# Imported\n\n![Image](https://assets.example.com/image.png)',
      assets: [{
        source_url: 'https://assets.example.com/image.png',
        asset_type: 'image',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        byte_length: bytes.byteLength,
      }],
    };
    const stageClient = mockClient({
      get: vi.fn(async (path: string) => path.endsWith('/markdown') ? markdown('Old body\n') : page()),
    });
    const manifest = await stageIngestion(request, manifestPath, { client: stageClient });
    let markdownReads = 0;
    const client = mockClient({
      get: vi.fn(async (path: string) => {
        if (!path.endsWith('/markdown')) return page();
        markdownReads += 1;
        return markdown(markdownReads === 1
          ? 'Old body\n'
          : `# Imported\n![Image](${actualUrl})`);
      }),
      patch: vi.fn(async () => markdown('ignored')),
    });
    const fetch = vi.fn(async () => new Response(bytes));

    await expect(applyIngestion(manifestPath, manifest.digest, {
      client,
      fetch: fetch as typeof globalThis.fetch,
      lookup: async () => [{ address: resolvedAddress ?? '93.184.216.34', family: 4 }],
    })).rejects.toThrow(/not public|non-public/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects truncated Markdown during staging and post-write verification', async () => {
    const incompleteStage = mockClient({
      get: vi.fn(async (path: string) => path.endsWith('/markdown') ? markdown('Old', true) : page()),
    });
    await expect(stageIngestion(existingRequest(), manifestPath, { client: incompleteStage }))
      .rejects.toThrow('incomplete Markdown');
    expect(incompleteStage.patch).not.toHaveBeenCalled();

    const stageClient = mockClient({
      get: vi.fn(async (path: string) => path.endsWith('/markdown') ? markdown('Old body\n') : page()),
    });
    const manifest = await stageIngestion(existingRequest(), manifestPath, { client: stageClient });
    let markdownReads = 0;
    const applyClient = mockClient({
      get: vi.fn(async (path: string) => {
        if (!path.endsWith('/markdown')) return page();
        markdownReads += 1;
        return markdown(
          markdownReads === 1 ? 'Old body\n' : '# Imported page\n\nNew body\n',
          markdownReads > 1,
        );
      }),
      patch: vi.fn(async () => markdown('# Imported page\n\nNew body\n')),
    });
    await expect(applyIngestion(manifestPath, manifest.digest, { client: applyClient }))
      .rejects.toThrow('incomplete Markdown');
  });

  it('accepts documented Notion canonicalization without accepting semantic loss', () => {
    const expected = [
      '# Imported',
      '',
      '1. First',
      '1. Second',
      '---',
      '| Name | Count |',
      '| --- | --- |',
      '| Alpha | 2 |',
      '![Diagram](https://cdn.example.com/image.png)',
    ].join('\n');
    const actual = [
      '# Imported',
      '1. First',
      '2. Second',
      '---',
      '<table header-row="true">',
      '\t<tr><td>Name</td><td>Count</td></tr>',
      '\t<tr><td>Alpha</td><td>2</td></tr>',
      '</table>',
      '![Diagram](https://notionusercontent.com/signed-image.png)',
    ].join('\n');
    expect(compareEnhancedMarkdown(expected, actual, { ignore_media_sources: true })).toBeNull();
    expect(compareEnhancedMarkdown(
      expected,
      actual.replace('First', 'Changed'),
      { ignore_media_sources: true },
    ))
      .toContain('canonical content');
    expect(compareEnhancedMarkdown('Before\n\\---\nAfter', 'Before\n---\nAfter'))
      .toContain('canonical content');
    expect(compareEnhancedMarkdown('A\n\nB', 'A\nB')).toBeNull();
    expect(compareEnhancedMarkdown('A\n<empty-block/>\nB', 'A\nB'))
      .toContain('canonical content');
    expect(compareEnhancedMarkdown('&lt;empty-block/&gt;', '<empty-block/>'))
      .toContain('canonical content');
    expect(compareEnhancedMarkdown(expected, actual))
      .toContain('media types');
  });

  it('does not confuse user-authored text with internal canonicalization tokens', () => {
    const table = '<table><tr><td>A</td></tr></table>';
    expect(compareEnhancedMarkdown(
      `${table}\nNOTION_CLI_TABLE_0`,
      `NOTION_CLI_TABLE_0\n${table}`,
    )).toContain('canonical content');
    expect(compareEnhancedMarkdown(
      '`a`\nNOTION_CLI_LITERAL_0',
      'NOTION_CLI_LITERAL_0\n`a`',
    )).toContain('canonical content');
  });

  it('does not decode escaped rich text into semantic table or media annotations', () => {
    expect(compareEnhancedMarkdown(
      '<table><tr><td>&lt;span color="red"&gt;X&lt;/span&gt;</td></tr></table>',
      '<table><tr><td><span color="red">X</span></td></tr></table>',
    )).toContain('table rows');
    expect(compareEnhancedMarkdown(
      '<video src="https://example.com/a.mp4">&lt;span color="red"&gt;X&lt;/span&gt;</video>',
      '<video src="https://example.com/a.mp4"><span color="red">X</span></video>',
    )).toContain('canonical content');
  });

  it('handles large malformed enhanced-Markdown input in bounded time', () => {
    const malformed = '<table'.repeat(100_000);
    const started = performance.now();
    expect(compareEnhancedMarkdown(malformed, malformed)).toBeNull();
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('does not normalize link or media syntax inside literal code', () => {
    const expected = '```md\n![literal](https://example.com/a.png)\n```';
    const changed = '```md\n![literal](https://example.com/b.png)\n```';
    expect(compareEnhancedMarkdown(expected, changed)).toContain('canonical content');
  });

  it('preserves rich table cells, links, and header-column semantics', () => {
    const expected = [
      '<table fit-page-width="true" header-row="true" header-column="true">',
      '<colgroup><col color="blue"><col></colgroup>',
      '<tr color="gray"><td color="red">**Name**</td><td>[Count](https://example.com/count)</td></tr>',
      '<tr><td>Alpha</td><td>2</td></tr>',
      '</table>',
    ].join('\n');
    expect(compareEnhancedMarkdown(
      expected,
      expected.replace('**Name**', 'Name'),
    )).toContain('table rows');
    expect(compareEnhancedMarkdown(
      expected,
      expected.replace('header-column="true"', 'header-column="false"'),
    )).toContain('table rows');
    expect(compareEnhancedMarkdown(
      expected,
      expected.replace('/count', '/other'),
    )).toContain('table rows');
    for (const changed of [
      expected.replace('fit-page-width="true"', 'fit-page-width="false"'),
      expected.replace('<col color="blue">', '<col>'),
      expected.replace('<tr color="gray">', '<tr>'),
      expected.replace('<td color="red">', '<td>'),
    ]) {
      expect(compareEnhancedMarkdown(expected, changed)).toContain('table rows');
    }
  });

  it('preserves documented color semantics for image and XML media blocks', () => {
    expect(compareEnhancedMarkdown(
      '![Image](https://example.com/a.png) {color="red"}',
      '![Image](https://example.com/a.png)',
    )).toContain('media types');
    expect(compareEnhancedMarkdown(
      '<video src="https://example.com/a.mp4" color="blue">Clip</video>',
      '<video src="https://example.com/a.mp4">Clip</video>',
    )).toContain('media types');
  });
});
