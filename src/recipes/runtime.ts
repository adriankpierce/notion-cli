import { spawn, spawnSync } from 'node:child_process';
import { TextDecoder } from 'node:util';
import { validateRecipeArtifact, validateRecipeRequest } from './schema.js';
import { RecipeError, type DiscoveredRecipe, type RecipeRequest, type RecipeRunResult, type RunRecipeOptions } from './types.js';

export const DEFAULT_RECIPE_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_STDOUT_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_STDERR_BYTES = 256 * 1024;
const MAX_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function bound(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > maximum) throw new RecipeError('invalid_request', `${name} must be an integer between 1 and ${maximum}`);
  return selected;
}

export function sanitizeRecipeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => value !== undefined && !key.toUpperCase().startsWith('NOTION_')));
}

function decode(chunks: Buffer[], label: string): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); } catch (error) {
    throw new RecipeError('invalid_output', `${label} is not valid UTF-8`, undefined, { cause: error });
  }
}

function terminateRecipeTree(child: ReturnType<typeof spawn>): void {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
  } else if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  } else {
    child.kill('SIGKILL');
  }
}

export async function runRecipe(recipe: DiscoveredRecipe, requestInput: RecipeRequest, options: RunRecipeOptions = {}): Promise<RecipeRunResult> {
  const request = validateRecipeRequest(requestInput);
  const timeoutMs = bound(options.timeoutMs, DEFAULT_RECIPE_TIMEOUT_MS, MAX_TIMEOUT_MS, 'timeoutMs');
  const maxStdoutBytes = bound(options.maxStdoutBytes, DEFAULT_MAX_STDOUT_BYTES, MAX_OUTPUT_BYTES, 'maxStdoutBytes');
  const maxStderrBytes = bound(options.maxStderrBytes, DEFAULT_MAX_STDERR_BYTES, MAX_OUTPUT_BYTES, 'maxStderrBytes');
  const started = Date.now();
  const child = spawn(recipe.executable, [...recipe.commandArguments, recipe.entryPath], {
    cwd: recipe.directory,
    env: sanitizeRecipeEnvironment(options.env ?? process.env),
    detached: process.platform !== 'win32',
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const { stdin, stdout: stdoutStream, stderr: stderrStream } = child;
  if (!stdin || !stdoutStream || !stderrStream) {
    terminateRecipeTree(child);
    throw new RecipeError('spawn_failed', 'recipe process did not expose piped standard streams');
  }

  return await new Promise<RecipeRunResult>((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const fail = (error: unknown, terminate = true): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (terminate) terminateRecipeTree(child);
      reject(error);
    };
    const succeed = (result: RecipeRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      terminateRecipeTree(child);
      resolve(result);
    };
    const timer = setTimeout(() => fail(
      new RecipeError('recipe_timeout', `recipe exceeded ${timeoutMs}ms timeout`),
    ), timeoutMs);
    stdoutStream.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) fail(new RecipeError('stdout_limit', `recipe stdout exceeded ${maxStdoutBytes} bytes`));
      else stdout.push(chunk);
    });
    stderrStream.on('data', (chunk: Buffer) => {
      if (settled) return;
      stderrBytes += chunk.length;
      if (stderrBytes > maxStderrBytes) fail(new RecipeError('stderr_limit', `recipe stderr exceeded ${maxStderrBytes} bytes`));
      else {
        stderr.push(chunk);
        try {
          options.onStderr?.(chunk.toString('utf8'));
        } catch (error) {
          fail(new RecipeError(
            'recipe_failed',
            'recipe stderr consumer failed',
            undefined,
            { cause: error },
          ));
        }
      }
    });
    child.on('error', (error) => fail(
      new RecipeError('spawn_failed', `failed to start recipe: ${error.message}`, undefined, { cause: error }),
    ));
    child.on('close', (code, signal) => {
      if (settled) return;
      let stderrText: string;
      try { stderrText = decode(stderr, 'recipe stderr'); } catch (error) { fail(error); return; }
      if (code !== 0) {
        fail(new RecipeError('recipe_failed', `recipe exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}`, { stderr: stderrText }));
        return;
      }
      let parsed: unknown;
      try {
        const text = decode(stdout, 'recipe stdout').trim();
        if (text.length === 0) throw new Error('empty output');
        parsed = JSON.parse(text) as unknown;
      } catch (error) {
        fail(new RecipeError('invalid_output', 'recipe stdout must contain exactly one JSON object', undefined, { cause: error }));
        return;
      }
      try {
        succeed({ artifact: validateRecipeArtifact(parsed), stderr: stderrText, durationMs: Date.now() - started });
      } catch (error) {
        fail(new RecipeError('invalid_output', 'recipe emitted an invalid artifact', undefined, { cause: error as Error }));
      }
    });
    stdin.on('error', () => undefined);
    stdin.end(`${JSON.stringify(request)}\n`);
  });
}
