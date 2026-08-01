import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const outputDirectory = resolve(projectRoot, 'dist');

if (dirname(outputDirectory) !== resolve(projectRoot)) {
  throw new Error(`Refusing to clean unexpected path: ${outputDirectory}`);
}

await rm(outputDirectory, { recursive: true, force: true });
