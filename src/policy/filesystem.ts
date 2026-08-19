import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { adapterError } from '../errors.js';

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function nearestExistingAncestor(path: string): Promise<string> {
  let current = path;
  for (;;) {
    try {
      await stat(current);
      return current;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

export async function authorizePath(
  requestedPath: string,
  configuredRoots: readonly string[],
  operation: string,
): Promise<string> {
  if (configuredRoots.length === 0) {
    throw adapterError('PATH_NOT_ALLOWED', operation, 'No filesystem roots are configured.');
  }

  const candidate = resolve(requestedPath);
  for (const rawRoot of configuredRoots) {
    const root = resolve(rawRoot);
    if (!isWithin(root, candidate)) continue;

    try {
      const rootReal = await realpath(root);
      const ancestor = await nearestExistingAncestor(candidate);
      const ancestorReal = await realpath(ancestor);
      if (isWithin(rootReal, ancestorReal)) return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }

  throw adapterError('PATH_NOT_ALLOWED', operation, 'Path is outside the configured filesystem roots.', {
    path: candidate,
  });
}
