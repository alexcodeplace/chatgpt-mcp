import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { adapterError } from '../errors.js';

const locks = new Map<string, Promise<unknown>>();
export const sha256 = (content: string | Buffer): string => createHash('sha256').update(content).digest('hex');

/** Cooperating MCP replacements serialize per canonical path. Not a kernel CAS against external writers. */
export async function replaceUtf8(
  path: string, content: string, expectedSha256: string | null, maxReadBytes: number,
  authorizeTemporary: (path: string) => Promise<void>,
): Promise<{ sha256: string }> {
  const key = join(await realpath(dirname(path)), basename(path));
  const prior = locks.get(key) ?? Promise.resolve();
  const task = prior.catch(() => {}).then(async () => {
    const temporary = join(dirname(path), `.mcp-replace-${randomUUID()}.tmp`);
    let existing: Awaited<ReturnType<typeof open>> | undefined;
    try {
      try {
        const metadata = await lstat(path);
        if (!metadata.isFile() || metadata.isSymbolicLink()) throw adapterError('INVALID_INPUT', 'fs.replace', 'Atomic replacement requires a regular file, not a symlink or device.');
        existing = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const original = await existing?.stat();
      let digest: string | null = null;
      if (existing !== undefined && original !== undefined) {
        if (original.size > maxReadBytes) throw adapterError('OUTPUT_LIMIT', 'fs.replace', 'Existing file exceeds the comparison byte limit.');
        const buffer = Buffer.alloc(maxReadBytes + 1);
        let bytes = 0;
        while (bytes < buffer.length) {
          const chunk = await existing.read(buffer, bytes, buffer.length - bytes, bytes);
          if (chunk.bytesRead === 0) break;
          bytes += chunk.bytesRead;
        }
        if (bytes > maxReadBytes) throw adapterError('OUTPUT_LIMIT', 'fs.replace', 'Existing file grew beyond the comparison byte limit.');
        digest = sha256(buffer.subarray(0, bytes));
      }
      if (digest !== expectedSha256) throw adapterError('CONFLICT', 'fs.replace', 'File changed since the supplied content hash; no write was performed.', { actualSha256: digest });
      await authorizeTemporary(temporary);
      const stage = await open(temporary, 'wx', original === undefined ? 0o600 : original.mode & 0o777);
      try { await stage.writeFile(content, 'utf8'); await stage.sync(); } finally { await stage.close(); }
      if (original === undefined) {
        // link is atomic and refuses an entry created by another writer in the meantime.
        try { await link(temporary, path); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw adapterError('CONFLICT', 'fs.replace', 'File appeared during creation; no write was performed.');
          throw error;
        }
      } else {
        const current = await lstat(path);
        if (current.ino !== original.ino || current.dev !== original.dev || current.mtimeMs !== original.mtimeMs || current.size !== original.size) {
          throw adapterError('CONFLICT', 'fs.replace', 'File changed during staging; no replacement was performed.');
        }
        await rename(temporary, path);
      }
      if (process.platform !== 'win32') {
        const directory = await open(dirname(path), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
      return { sha256: sha256(content) };
    } finally {
      await existing?.close();
      await rm(temporary, { force: true });
    }
  });
  locks.set(key, task);
  try { return await task; } finally { if (locks.get(key) === task) locks.delete(key); }
}
