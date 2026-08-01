import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:net';

export class LiveAttemptLockError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LiveAttemptLockError';
  }
}

export interface LiveAttemptLock {
  release(): Promise<void>;
}

export interface LiveAttemptLockEndpoint {
  host: string;
  port: number;
}

/**
 * Map a canonical manifest path to one deterministic unprivileged loopback
 * port. A rare collision with another local listener fails closed.
 */
export function liveAttemptLockEndpoint(key: string): LiveAttemptLockEndpoint {
  const digest = createHash('sha256').update(key).digest();
  return {
    host: '127.0.0.1',
    port: 1_024 + (digest.readUInt16BE(0) % (65_535 - 1_024 + 1)),
  };
}

function listen(server: Server, endpoint: LiveAttemptLockEndpoint): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: endpoint.host, port: endpoint.port, exclusive: true });
  });
}

/**
 * Hold an OS-released loopback listener while a page-create attempt may be
 * live. There is no filesystem socket to clean up or steal after a crash.
 */
export async function acquireLiveAttemptLock(key: string): Promise<LiveAttemptLock> {
  const endpoint = liveAttemptLockEndpoint(key);
  const server = createServer(socket => socket.destroy());
  try {
    await listen(server, endpoint);
  } catch (error) {
    const occupied = (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
    throw new LiveAttemptLockError(
      occupied
        ? 'Another creation or reconciliation process is still live.'
        : 'Could not acquire the live creation-attempt lock.',
      { cause: error },
    );
  }
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    },
  };
}
