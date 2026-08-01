import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  acquireLiveAttemptLock,
  liveAttemptLockEndpoint,
} from '../../src/ingest/live-attempt-lock.js';

describe('live creation-attempt lock', () => {
  it('recovers the OS-released listener after its owner is killed', async () => {
    const key = `crash-test-${process.pid}-${randomUUID()}`;
    const endpoint = liveAttemptLockEndpoint(key);
    const fixture = fileURLToPath(new URL('../fixtures/live-attempt-lock-holder.mjs', import.meta.url));
    const child = spawn(process.execPath, [
      fixture,
      String(endpoint.port),
      endpoint.host,
    ], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    try {
      await Promise.race([
        once(child.stdout, 'data'),
        once(child, 'exit').then(([code, signal]) => {
          throw new Error(`lock holder exited before ready (${code ?? signal})`);
        }),
      ]);
      await expect(acquireLiveAttemptLock(key)).rejects.toThrow('still live');
      child.kill('SIGKILL');
      await once(child, 'exit');

      const recovered = await acquireLiveAttemptLock(key);
      await recovered.release();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
    }
  });
});
