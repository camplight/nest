import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContextFiles, ContextFileTooLargeError } from './context-files';

const text = async (stream: ReadableStream<Uint8Array>) => new Response(stream).text();
const streamOf = (...chunks: string[]) => new ReadableStream<Uint8Array>({
  start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); },
});

describe('context file storage', () => {
  let root: string, dir: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'nest-context-files-')); dir = join(root, 'context-files'); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('saves a blob or stream under a uuid key, opens it and removes it', async () => {
    const files = createContextFiles(dir);
    const blob = await files.save(new Blob(['hello context']), { maxBytes: 100 });
    expect(blob).toEqual({ storageKey: expect.stringMatching(/^[0-9a-f-]{36}$/), size: 13 });
    expect(await text(files.open(blob.storageKey))).toBe('hello context');
    const streamed = await files.save(streamOf('ab', 'cd'), { maxBytes: 4 });
    expect(streamed.size).toBe(4);
    expect(await text(files.open(streamed.storageKey))).toBe('abcd');
    expect(readdirSync(dir).sort()).toEqual([blob.storageKey, streamed.storageKey].sort());
    await files.remove(blob.storageKey);
    await files.remove(blob.storageKey);
    expect(readdirSync(dir)).toEqual([streamed.storageKey]);
  });

  it('writes files with mode 600 inside a mode 700 directory', async () => {
    const files = createContextFiles(dir);
    const { storageKey } = await files.save(new Blob(['secret']), { maxBytes: 100 });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, storageKey)).mode & 0o777).toBe(0o600);
  });

  it('aborts past maxBytes and leaves nothing on disk', async () => {
    const files = createContextFiles(dir);
    await expect(files.save(streamOf('abc', 'def'), { maxBytes: 5 })).rejects.toBeInstanceOf(ContextFileTooLargeError);
    await expect(files.save(new Blob(['123456']), { maxBytes: 5 })).rejects.toBeInstanceOf(ContextFileTooLargeError);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('accepts only uuid storage keys', async () => {
    const files = createContextFiles(dir);
    expect(() => files.open('../nest.sqlite')).toThrow();
    await expect(files.remove('../nest.sqlite')).rejects.toThrow();
  });
});
