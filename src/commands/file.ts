/**
 * File command - upload files to Notion pages
 */
import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { getClient } from '../client.js';
import { formatOutput } from '../utils/format.js';
import { withErrorHandler } from '../utils/command-handler.js';
import { normalizeNotionId } from '../utils/database-resolver.js';

const IMAGE_EXTS = new Set([
  '.gif', '.heic', '.jpeg', '.jpg', '.png', '.svg', '.tif', '.tiff', '.webp',
  '.ico', '.bmp', '.avif', '.apng',
]);
const VIDEO_EXTS = new Set([
  '.amv', '.asf', '.wmv', '.avi', '.f4v', '.flv', '.gifv', '.m4v', '.mp4',
  '.mkv', '.webm', '.mov', '.qt', '.mpeg', '.ogv', '.3gp', '.3g2',
]);
const AUDIO_EXTS = new Set([
  '.aac', '.adts', '.mid', '.midi', '.mp3', '.mpga', '.m4a', '.m4b', '.oga',
  '.ogg', '.opus', '.wav', '.wma', '.weba', '.flac',
]);
const PDF_EXTS = new Set(['.pdf']);
const SINGLE_PART_MAX_BYTES = 20 * 1024 * 1024;
const FILE_IMPORT_TIMEOUT_MS = 2 * 60_000;

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.tiff': 'image/tiff', '.heic': 'image/heic', '.avif': 'image/avif',
  '.tif': 'image/tiff', '.bmp': 'image/bmp', '.ico': 'image/vnd.microsoft.icon',
  '.apng': 'image/apng',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.amv': 'video/x-amv', '.asf': 'video/x-ms-asf', '.wmv': 'video/x-ms-wmv',
  '.f4v': 'video/x-f4v', '.flv': 'video/x-flv', '.gifv': 'video/mp4',
  '.m4v': 'video/mp4', '.qt': 'video/quicktime', '.mpeg': 'video/mpeg',
  '.ogv': 'video/ogg', '.3gp': 'video/3gpp', '.3g2': 'video/3gpp2',
  '.mp3': 'audio/mpeg', '.mpga': 'audio/mpeg', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
  '.flac': 'audio/x-flac', '.m4a': 'audio/mp4', '.m4b': 'audio/mp4',
  '.aac': 'audio/aac', '.adts': 'audio/aac', '.mid': 'audio/midi',
  '.midi': 'audio/midi', '.wma': 'audio/x-ms-wma', '.weba': 'audio/webm',
  '.pdf': 'application/pdf',
  '.json': 'application/json', '.csv': 'text/csv',
  '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown',
  '.html': 'text/html', '.htm': 'text/html', '.xml': 'application/xml',
  '.css': 'text/css', '.yaml': 'text/yaml', '.yml': 'text/yaml',
  '.tsv': 'text/tab-separated-values', '.ics': 'text/calendar',
  '.doc': 'application/msword', '.dot': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.dotx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  '.xls': 'application/vnd.ms-excel', '.xlt': 'application/vnd.ms-excel',
  '.xla': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xltx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
  '.ppt': 'application/vnd.ms-powerpoint', '.pot': 'application/vnd.ms-powerpoint',
  '.pps': 'application/vnd.ms-powerpoint', '.ppa': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.potx': 'application/vnd.openxmlformats-officedocument.presentationml.template',
  '.rtf': 'application/rtf', '.epub': 'application/epub+zip',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.zip': 'application/zip', '.gz': 'application/gzip', '.gzip': 'application/gzip',
  '.tar': 'application/x-tar', '.7z': 'application/x-7z-compressed',
  '.bz2': 'application/x-bzip2', '.rar': 'application/vnd.rar',
};

interface BotUser {
  bot?: { workspace_limits?: { max_file_upload_size_in_bytes?: number } };
}

let cachedWorkspaceUploadLimit: number | undefined;

async function getWorkspaceUploadLimit(
  client: ReturnType<typeof getClient>,
): Promise<number | undefined> {
  if (cachedWorkspaceUploadLimit !== undefined) return cachedWorkspaceUploadLimit;
  const me = await client.get<BotUser>('users/me');
  const limit = me.bot?.workspace_limits?.max_file_upload_size_in_bytes;
  // Personal access tokens return a person rather than a bot. In that case the
  // workspace limit is not exposed here, so keep the protocol limit and let
  // Notion enforce any lower workspace-specific limit during upload creation.
  if (limit === undefined) return undefined;
  if (!Number.isFinite(limit) || limit < 1) {
    throw new Error('Notion returned an invalid workspace file-upload limit for this bot.');
  }
  cachedWorkspaceUploadLimit = limit;
  return limit;
}

interface FileUploadStatus {
  id: string;
  status: 'pending' | 'uploaded' | 'expired' | 'failed';
  filename?: string | null;
  file_import_result?: {
    type?: string;
    error?: { message?: string };
  };
}

function fileUploadFailure(upload: FileUploadStatus): Error {
  const detail = upload.file_import_result?.error?.message;
  if (upload.status === 'expired') {
    return new Error(`Notion file upload ${upload.id} expired before it could be attached`);
  }
  return new Error(detail || `Notion file upload ${upload.id} failed`);
}

async function waitForFileUpload(
  client: ReturnType<typeof getClient>,
  upload: FileUploadStatus,
  timeoutMs = FILE_IMPORT_TIMEOUT_MS,
): Promise<FileUploadStatus> {
  let current = upload;
  let pollDelayMs = 1_000;
  const deadline = Date.now() + timeoutMs;

  while (current.status === 'pending') {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for Notion file upload ${upload.id}`);
    }

    current = await client.get<FileUploadStatus>(`file_uploads/${upload.id}`);
    if (current.status !== 'pending') break;

    const remainingMs = deadline - Date.now();
    if (remainingMs <= pollDelayMs) {
      throw new Error(`Timed out waiting for Notion file upload ${upload.id}`);
    }
    await new Promise(resolve => setTimeout(resolve, pollDelayMs));
    pollDelayMs = Math.min(pollDelayMs * 2, 10_000);
  }

  if (current.status !== 'uploaded') throw fileUploadFailure(current);
  return current;
}

function detectBlockType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (PDF_EXTS.has(ext)) return 'pdf';
  return 'file';
}

function buildFileBlock(
  blockType: string,
  fileUploadId: string,
  caption?: string,
): Record<string, unknown> {
  const fileRef = {
    type: 'file_upload',
    file_upload: { id: fileUploadId },
    caption: caption
      ? [{ type: 'text', text: { content: caption } }]
      : [],
  };

  return {
    object: 'block',
    type: blockType,
    [blockType]: fileRef,
  };
}

export function registerFileCommand(program: Command): void {
  const file = program
    .command('file')
    .description('Upload files to Notion pages');

  file
    .command('upload <page_id> [file_path]')
    .description('Upload a file and attach it to a page')
    .option('--url <url>', 'Import from external URL instead of local file')
    .option('--caption <text>', 'Caption for the file')
    .option('--position <pos>', 'Where to attach: top or bottom', 'bottom')
    .option('-j, --json', 'Output a structured upload and attachment envelope')
    .action(withErrorHandler(async (pageId: string, filePath: string | undefined, options) => {
      const client = getClient();
      const normalizedPageId = normalizeNotionId(pageId);

      if (!filePath && !options.url) {
        throw new Error('Provide a file path or --url');
      }

      if (filePath && options.url) {
        throw new Error('Provide either a file path or --url, not both');
      }

      if (options.position !== 'top' && options.position !== 'bottom') {
        throw new Error('--position must be either "top" or "bottom"');
      }

      let fileUploadId: string;
      let filename: string;
      let completedUpload: FileUploadStatus;

      if (options.url) {
        // External URL mode — Notion fetches the file asynchronously
        const externalUrl = new URL(options.url);
        if (externalUrl.protocol !== 'https:') {
          throw new Error('External file imports require an HTTPS URL');
        }
        const urlFilename = decodeURIComponent(path.basename(externalUrl.pathname)) || undefined;
        const upload = await client.post<FileUploadStatus>('file_uploads', {
          mode: 'external_url',
          external_url: options.url,
          ...(urlFilename && path.extname(urlFilename) ? { filename: urlFilename } : {}),
        });
        fileUploadId = upload.id;

        // Poll until Notion finishes importing the file
        console.error('Importing from URL...');
        const completed = await waitForFileUpload(client, upload);
        completedUpload = completed;
        filename = completed.filename || urlFilename || 'file';
      } else {
        // Local file upload
        const resolvedPath = path.resolve(filePath!);
        if (!fs.existsSync(resolvedPath)) {
          throw new Error(`File not found: ${resolvedPath}`);
        }
        const stats = fs.statSync(resolvedPath);
        if (!stats.isFile()) {
          throw new Error(`Not a regular file: ${resolvedPath}`);
        }
        if (stats.size > SINGLE_PART_MAX_BYTES) {
          throw new Error(
            `File is ${stats.size} bytes; files over 20 MiB require multipart upload, which is not supported yet`,
          );
        }

        filename = path.basename(resolvedPath);
        const ext = path.extname(filename).toLowerCase();
        const contentType = MIME_TYPES[ext];
        if (!contentType) {
          throw new Error(`Unsupported Notion file type: ${ext || '(no extension)'}`);
        }
        if (Buffer.byteLength(filename, 'utf-8') > 900) {
          throw new Error('Filename exceeds Notion\'s 900-byte limit');
        }
        const workspaceLimit = await getWorkspaceUploadLimit(client);
        if (workspaceLimit !== undefined && stats.size > workspaceLimit) {
          throw new Error(
            `File is ${stats.size} bytes, above this workspace's ${workspaceLimit}-byte upload limit`,
          );
        }
        const fileBuffer = fs.readFileSync(resolvedPath);
        if (!Buffer.isBuffer(fileBuffer)) {
          throw new Error(`Could not read file as binary data: ${resolvedPath}`);
        }
        // Re-check after reading in case the file changed between stat and read.
        if (fileBuffer.byteLength > SINGLE_PART_MAX_BYTES) {
          throw new Error(
            `File is ${fileBuffer.byteLength} bytes; files over 20 MiB require multipart upload, which is not supported yet`,
          );
        }
        if (workspaceLimit !== undefined && fileBuffer.byteLength > workspaceLimit) {
          throw new Error(
            `File grew to ${fileBuffer.byteLength} bytes, above this workspace's ` +
            `${workspaceLimit}-byte upload limit`,
          );
        }

        // Step 1: Create file upload
        const upload = await client.post<FileUploadStatus>('file_uploads', {
          mode: 'single_part',
          filename,
          content_type: contentType,
        });

        // Step 2: Send the binary with correct MIME type
        let uploaded: FileUploadStatus;
        try {
          uploaded = await client.sendFile<FileUploadStatus>(
            `file_uploads/${upload.id}/send`,
            fileBuffer,
            filename,
            contentType,
          );
        } catch (error) {
          if (error instanceof Error) {
            error.message =
              `File upload ${upload.id} was created but the file data could not be sent: ` +
              error.message;
            throw error;
          }
          throw new Error(
            `File upload ${upload.id} was created but the file data could not be sent.`,
          );
        }
        completedUpload = uploaded.status === 'uploaded'
          ? uploaded
          : await waitForFileUpload(client, uploaded);
        fileUploadId = upload.id;
      }

      // Step 3: Attach to page as a block
      const blockType = detectBlockType(filename);
      const block = buildFileBlock(blockType, fileUploadId, options.caption);

      const body: Record<string, unknown> = {
        children: [block],
        ...(options.position === 'top' ? { position: { type: 'start' } } : {}),
      };

      let result: unknown;
      try {
        result = await client.patch(`blocks/${normalizedPageId}/children`, body);
      } catch (error) {
        if (error instanceof Error) {
          error.message =
            `File upload ${fileUploadId} completed but could not be attached: ${error.message}`;
          throw error;
        }
        throw new Error(`File upload ${fileUploadId} completed but could not be attached.`);
      }

      if (options.json) {
        console.log(formatOutput({
          file_upload: completedUpload,
          filename,
          block_type: blockType,
          attachment: result,
        }));
      } else {
        console.log(`Uploaded ${filename} as ${blockType} block`);
        console.log(`   File upload ID: ${fileUploadId}`);
      }
    }));
}
