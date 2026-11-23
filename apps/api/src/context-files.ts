import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, open as openFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';

export class ContextFileTooLargeError extends Error {
  constructor() { super('File is too large'); this.name = 'ContextFileTooLargeError'; }
}

const storageKeyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Context files live in Nest's own directory, never in the engine's `files/` tree, which agents'
 * shells can read. A file is stored as `<dir>/<uuid>` (mode 600, directory mode 700); its user-facing
 * name stays in the product DB only.
 */
export function createContextFiles(dir: string) {
  async function ensureDir() {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  }
  const pathFor = (storageKey: string) => {
    if (!storageKeyPattern.test(storageKey)) throw new Error('Invalid storage key');
    return join(dir, storageKey);
  };

  async function save(input: ReadableStream<Uint8Array> | Blob, { maxBytes }: { maxBytes: number }) {
    if (input instanceof Blob && input.size > maxBytes) throw new ContextFileTooLargeError();
    await ensureDir();
    const storageKey = randomUUID();
    const path = pathFor(storageKey);
    const handle = await openFile(path, 'wx', 0o600);
    let size = 0;
    try {
      const reader = (input instanceof Blob ? input.stream() : input).getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) throw new ContextFileTooLargeError();
          await handle.write(value);
        }
      } finally {
        if (size > maxBytes) await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      await handle.close();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(path).catch(() => undefined);
      throw error;
    }
    return { storageKey, size };
  }

  function open(storageKey: string): ReadableStream<Uint8Array> {
    return Readable.toWeb(createReadStream(pathFor(storageKey))) as ReadableStream<Uint8Array>;
  }

  async function remove(storageKey: string) {
    try {
      await unlink(pathFor(storageKey));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  return { save, open, remove };
}
export type ContextFiles = ReturnType<typeof createContextFiles>;

/** Unlinks stored files after their rows are gone; a failed unlink is logged, never surfaced. */
export async function removeStored(files: Pick<ContextFiles, 'remove'>, storageKeys: string[]) {
  for (const key of storageKeys) {
    try { await files.remove(key); } catch (error) { console.error('Context file cleanup failed:', (error as Error).name); }
  }
}
