import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Command } from 'commander';

describe('File Command', () => {
  let program: Command;
  let mockClient: any;
  let mockFS: Map<string, Buffer | string>;
  let mockFileSizes: Map<string, number>;

  beforeEach(async () => {
    vi.resetModules();
    mockFS = new Map();
    mockFileSizes = new Map();

    mockClient = {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      sendFile: vi.fn(),
    };
    mockClient.get.mockResolvedValue({
      bot: { workspace_limits: { max_file_upload_size_in_bytes: 20 * 1024 * 1024 } },
    });

    vi.doMock('../../src/client', () => ({
      getClient: () => mockClient,
      initClient: vi.fn(),
    }));

    vi.doMock('fs', () => ({
      readFileSync: vi.fn((path: string) => {
        if (mockFS.has(path)) return mockFS.get(path);
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }),
      existsSync: vi.fn((path: string) => mockFS.has(path)),
      statSync: vi.fn((path: string) => ({
        isFile: () => mockFS.has(path),
        size: mockFileSizes.get(path) ?? Buffer.byteLength(mockFS.get(path) ?? ''),
      })),
    }));

    const { registerFileCommand } = await import('../../src/commands/file');
    program = new Command();
    registerFileCommand(program);
  });

  describe('file upload', () => {
    it('should upload a local image file', async () => {
      const fileBuffer = Buffer.from('fake-image-data');
      mockFS.set('/tmp/photo.jpg', fileBuffer);

      mockClient.post.mockResolvedValueOnce({ id: 'upload-123' }); // create
      mockClient.sendFile.mockResolvedValueOnce({ id: 'upload-123', status: 'uploaded' }); // send
      mockClient.patch.mockResolvedValueOnce({ results: [{ id: 'block-1' }] }); // attach

      await program.parseAsync(['node', 'test', 'file', 'upload', 'page-123', '/tmp/photo.jpg']);

      // Step 1: create file upload
      expect(mockClient.post).toHaveBeenCalledWith('file_uploads', {
        mode: 'single_part',
        filename: 'photo.jpg',
        content_type: 'image/jpeg',
      });

      // Step 2: send binary with MIME type
      expect(mockClient.sendFile).toHaveBeenCalledWith(
        'file_uploads/upload-123/send',
        fileBuffer,
        'photo.jpg',
        'image/jpeg',
      );

      // Step 3: attach as image block
      expect(mockClient.patch).toHaveBeenCalledWith('blocks/page-123/children', {
        children: [{
          object: 'block',
          type: 'image',
          image: {
            type: 'file_upload',
            file_upload: { id: 'upload-123' },
            caption: [],
          },
        }],
      });

      expect(console.log).toHaveBeenCalledWith('Uploaded photo.jpg as image block');
    });

    it('should upload with a personal access token when no bot workspace limit is returned', async () => {
      const fileBuffer = Buffer.from('personal-token-file');
      mockFS.set('/tmp/pat-photo.jpg', fileBuffer);
      mockClient.get.mockResolvedValueOnce({
        object: 'user',
        type: 'person',
        person: { email: 'owner@example.com' },
      });
      mockClient.post.mockResolvedValueOnce({ id: 'upload-pat' });
      mockClient.sendFile.mockResolvedValueOnce({ id: 'upload-pat', status: 'uploaded' });
      mockClient.patch.mockResolvedValueOnce({ results: [] });

      await program.parseAsync([
        'node', 'test', 'file', 'upload', 'page-123', '/tmp/pat-photo.jpg',
      ]);

      expect(mockClient.get).toHaveBeenCalledWith('users/me');
      expect(mockClient.post).toHaveBeenCalledWith('file_uploads', expect.objectContaining({
        mode: 'single_part',
        filename: 'pat-photo.jpg',
      }));
      expect(mockClient.sendFile).toHaveBeenCalledWith(
        'file_uploads/upload-pat/send',
        fileBuffer,
        'pat-photo.jpg',
        'image/jpeg',
      );
    });

    it('should upload from external URL', async () => {
      mockClient.post.mockResolvedValueOnce({ id: 'upload-456', status: 'pending' }); // create with external_url
      mockClient.get.mockResolvedValueOnce({ id: 'upload-456', status: 'uploaded' }); // poll status
      mockClient.patch.mockResolvedValueOnce({ results: [{ id: 'block-1' }] }); // attach

      await program.parseAsync([
        'node', 'test', 'file', 'upload', 'page-123',
        '--url', 'https://example.com/document.pdf',
      ]);

      // Should create with external_url mode
      expect(mockClient.post).toHaveBeenCalledWith('file_uploads', {
        mode: 'external_url',
        external_url: 'https://example.com/document.pdf',
        filename: 'document.pdf',
      });

      // Should NOT call sendFile
      expect(mockClient.sendFile).not.toHaveBeenCalled();

      // Should attach as pdf block
      expect(mockClient.patch).toHaveBeenCalledWith('blocks/page-123/children', {
        children: [{
          object: 'block',
          type: 'pdf',
          pdf: {
            type: 'file_upload',
            file_upload: { id: 'upload-456' },
            caption: [],
          },
        }],
      });
    });

    it('should detect block type from extension', async () => {
      const testCases = [
        { file: 'video.mp4', expectedType: 'video' },
        { file: 'song.mp3', expectedType: 'audio' },
        { file: 'doc.pdf', expectedType: 'pdf' },
        { file: 'data.csv', expectedType: 'file' },
        { file: 'photo.png', expectedType: 'image' },
      ];

      for (const { file, expectedType } of testCases) {
        vi.clearAllMocks();
        mockFS.set(`/tmp/${file}`, Buffer.from('data'));
        mockClient.post.mockResolvedValueOnce({ id: 'upload-id' });
        mockClient.sendFile.mockResolvedValueOnce({ id: 'upload-id', status: 'uploaded' });
        mockClient.patch.mockResolvedValueOnce({ results: [] });

        await program.parseAsync(['node', 'test', 'file', 'upload', 'page-123', `/tmp/${file}`]);

        expect(mockClient.patch).toHaveBeenCalledWith('blocks/page-123/children', {
          children: [expect.objectContaining({ type: expectedType })],
        });
      }
    });

    it('should add caption when --caption is provided', async () => {
      mockFS.set('/tmp/photo.jpg', Buffer.from('data'));
      mockClient.post.mockResolvedValueOnce({ id: 'upload-123' });
      mockClient.sendFile.mockResolvedValueOnce({ id: 'upload-123', status: 'uploaded' });
      mockClient.patch.mockResolvedValueOnce({ results: [] });

      await program.parseAsync([
        'node', 'test', 'file', 'upload', 'page-123', '/tmp/photo.jpg',
        '--caption', 'My vacation photo',
      ]);

      expect(mockClient.patch).toHaveBeenCalledWith('blocks/page-123/children', {
        children: [{
          object: 'block',
          type: 'image',
          image: {
            type: 'file_upload',
            file_upload: { id: 'upload-123' },
            caption: [{ type: 'text', text: { content: 'My vacation photo' } }],
          },
        }],
      });
    });

    it('should insert at top when --position top', async () => {
      mockFS.set('/tmp/photo.jpg', Buffer.from('data'));
      mockClient.post.mockResolvedValueOnce({ id: 'upload-123' });
      mockClient.sendFile.mockResolvedValueOnce({ id: 'upload-123', status: 'uploaded' });
      mockClient.patch.mockResolvedValueOnce({ results: [] });

      await program.parseAsync([
        'node', 'test', 'file', 'upload', 'page-123', '/tmp/photo.jpg',
        '--position', 'top',
      ]);

      expect(mockClient.get).toHaveBeenCalledWith('users/me');
      expect(mockClient.patch).toHaveBeenCalledWith('blocks/page-123/children', {
        children: [expect.objectContaining({ type: 'image' })],
        position: { type: 'start' },
      });
    });

    it('should output JSON with --json', async () => {
      mockFS.set('/tmp/photo.jpg', Buffer.from('data'));
      mockClient.post.mockResolvedValueOnce({ id: 'upload-123' });
      mockClient.sendFile.mockResolvedValueOnce({ id: 'upload-123', status: 'uploaded' });
      mockClient.patch.mockResolvedValueOnce({ results: [{ id: 'block-1', type: 'image' }] });

      await program.parseAsync([
        'node', 'test', 'file', 'upload', 'page-123', '/tmp/photo.jpg', '--json',
      ]);

      const output = JSON.parse(vi.mocked(console.log).mock.calls[0][0] as string);
      expect(output).toMatchObject({
        file_upload: { id: 'upload-123', status: 'uploaded' },
        filename: 'photo.jpg',
        block_type: 'image',
        attachment: { results: [{ id: 'block-1', type: 'image' }] },
      });
    });

    it('should preserve the completed upload ID when page attachment fails', async () => {
      mockFS.set('/tmp/photo.jpg', Buffer.from('data'));
      mockClient.post.mockResolvedValueOnce({ id: 'upload-recoverable' });
      mockClient.sendFile.mockResolvedValueOnce({ id: 'upload-recoverable', status: 'uploaded' });
      mockClient.patch.mockRejectedValueOnce(new Error('page is locked'));

      await expect(program.parseAsync([
        'node', 'test', 'file', 'upload', 'page-123', '/tmp/photo.jpg',
      ])).rejects.toThrow('File upload upload-recoverable completed but could not be attached: page is locked');
    });

    it('should preserve the created upload ID when sending file data fails', async () => {
      mockFS.set('/tmp/photo.jpg', Buffer.from('data'));
      mockClient.post.mockResolvedValueOnce({ id: 'upload-send-failed' });
      mockClient.sendFile.mockRejectedValueOnce(new Error('conflict while sending'));

      await expect(program.parseAsync([
        'node', 'test', 'file', 'upload', 'page-123', '/tmp/photo.jpg',
      ])).rejects.toThrow(
        'File upload upload-send-failed was created but the file data could not be sent: conflict while sending',
      );

      expect(mockClient.patch).not.toHaveBeenCalled();
    });

    it('should normalize a Notion page URL before attaching the upload', async () => {
      mockFS.set('/tmp/photo.jpg', Buffer.from('data'));
      mockClient.post.mockResolvedValueOnce({ id: 'upload-123' });
      mockClient.sendFile.mockResolvedValueOnce({ id: 'upload-123', status: 'uploaded' });
      mockClient.patch.mockResolvedValueOnce({ results: [] });

      await program.parseAsync([
        'node', 'test', 'file', 'upload',
        'https://www.notion.so/Test-0123456789abcdef0123456789abcdef',
        '/tmp/photo.jpg',
      ]);

      expect(mockClient.patch).toHaveBeenCalledWith(
        'blocks/01234567-89ab-cdef-0123-456789abcdef/children',
        expect.any(Object),
      );
    });

    it('should error when file not found', async () => {
      await expect(
        program.parseAsync(['node', 'test', 'file', 'upload', 'page-123', '/tmp/missing.jpg'])
      ).rejects.toThrow('File not found');
    });

    it('should error when neither file nor --url provided', async () => {
      await expect(
        program.parseAsync(['node', 'test', 'file', 'upload', 'page-123'])
      ).rejects.toThrow('Provide a file path or --url');
    });

    it('should error when both file and --url provided', async () => {
      mockFS.set('/tmp/photo.jpg', Buffer.from('data'));

      await expect(
        program.parseAsync([
          'node', 'test', 'file', 'upload', 'page-123', '/tmp/photo.jpg',
          '--url', 'https://example.com/photo.jpg',
        ])
      ).rejects.toThrow('Provide either a file path or --url, not both');
    });

    it('should reject files requiring multipart before reading them', async () => {
      mockFS.set('/tmp/large.bin', Buffer.from('placeholder'));
      mockFileSizes.set('/tmp/large.bin', 20 * 1024 * 1024 + 1);

      await expect(
        program.parseAsync(['node', 'test', 'file', 'upload', 'page-123', '/tmp/large.bin'])
      ).rejects.toThrow('require multipart upload');

      expect(mockClient.post).not.toHaveBeenCalled();
    });

    it('should enforce the bot workspace upload limit before reading the file', async () => {
      mockFS.set('/tmp/workspace-large.pdf', Buffer.from('placeholder'));
      mockFileSizes.set('/tmp/workspace-large.pdf', 6 * 1024 * 1024);
      mockClient.get.mockResolvedValueOnce({
        bot: { workspace_limits: { max_file_upload_size_in_bytes: 5 * 1024 * 1024 } },
      });

      await expect(program.parseAsync([
        'node', 'test', 'file', 'upload', 'page-123', '/tmp/workspace-large.pdf',
      ])).rejects.toThrow('workspace');

      expect(mockClient.post).not.toHaveBeenCalled();
      expect(mockClient.sendFile).not.toHaveBeenCalled();
    });

    it('should reject unsupported extensions before creating an upload', async () => {
      mockFS.set('/tmp/archive.exe', Buffer.from('data'));

      await expect(program.parseAsync([
        'node', 'test', 'file', 'upload', 'page-123', '/tmp/archive.exe',
      ])).rejects.toThrow('Unsupported Notion file type');

      expect(mockClient.get).not.toHaveBeenCalled();
      expect(mockClient.post).not.toHaveBeenCalled();
    });

    it('should surface external import failure details and never attach the upload', async () => {
      mockClient.post.mockResolvedValueOnce({ id: 'upload-failed', status: 'pending' });
      mockClient.get.mockResolvedValueOnce({
        id: 'upload-failed',
        status: 'failed',
        file_import_result: {
          type: 'error',
          error: { message: 'Remote server did not provide a content type' },
        },
      });

      await expect(program.parseAsync([
        'node', 'test', 'file', 'upload', 'page-123',
        '--url', 'https://example.com/file.bin',
      ])).rejects.toThrow('Remote server did not provide a content type');

      expect(mockClient.patch).not.toHaveBeenCalled();
    });
  });
});
