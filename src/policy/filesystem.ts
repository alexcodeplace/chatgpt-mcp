import { lstat, realpath, readdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { adapterError } from '../errors.js';

export interface FilesystemBlockRule {
  readonly path: string;
  readonly mode: 'freeze-children';
  readonly message?: string | undefined;
}

export interface FilesystemMountPolicy {
  readonly readOnlyPaths: readonly string[];
  readonly readWritePaths: readonly string[];
  readonly inaccessiblePaths: readonly string[];
  readonly messages: readonly string[];
}

const DEFAULT_FREEZE_MESSAGE = 'Filesystem policy prevents changing entries directly inside this directory.';

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

async function canonicalRulePath(rule: FilesystemBlockRule, operation: string): Promise<string> {
  try {
    return await realpath(resolve(rule.path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw adapterError(
        'PATH_NOT_ALLOWED',
        operation,
        'A configured filesystem blocklist path does not exist; refusing the operation so the policy fails closed.',
        { blocklistPath: resolve(rule.path), mode: rule.mode },
      );
    }
    throw error;
  }
}

function blocked(rule: FilesystemBlockRule, operation: string, candidate: string): never {
  throw adapterError(
    'PATH_NOT_ALLOWED',
    operation,
    rule.message ?? DEFAULT_FREEZE_MESSAGE,
    { path: candidate, blocklistPath: resolve(rule.path), mode: rule.mode },
  );
}

async function frozenParentRuleFor(parent: string, rules: readonly FilesystemBlockRule[], operation: string): Promise<FilesystemBlockRule | undefined> {
  let parentReal: string;
  try {
    parentReal = await realpath(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  for (const rule of rules) {
    if (rule.mode !== 'freeze-children') continue;
    if (parentReal === await canonicalRulePath(rule, operation)) return rule;
  }
  return undefined;
}

/**
 * Authorize an operation that may create a filesystem entry. Existing entries
 * are allowed because writing their contents does not mutate the protected
 * parent's directory-entry set. For recursive creation, the nearest existing
 * ancestor catches attempts such as /protected/new/nested in one call.
 */
export async function authorizePathEntryCreation(
  requestedPath: string,
  rules: readonly FilesystemBlockRule[],
  operation: string,
): Promise<void> {
  if (rules.length === 0) return;
  const candidate = resolve(requestedPath);
  try {
    await lstat(candidate);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const ancestor = await nearestExistingAncestor(candidate);
  const ancestorReal = await realpath(ancestor);
  for (const rule of rules) {
    if (rule.mode !== 'freeze-children') continue;
    if (ancestorReal === await canonicalRulePath(rule, operation)) blocked(rule, operation, candidate);
  }
}

/** Authorize removing, renaming, or moving a direct child of a frozen parent. */
export async function authorizePathEntryMutation(
  requestedPath: string,
  rules: readonly FilesystemBlockRule[],
  operation: string,
): Promise<void> {
  if (rules.length === 0) return;
  const candidate = resolve(requestedPath);
  const rule = await frozenParentRuleFor(dirname(candidate), rules, operation);
  if (rule !== undefined) blocked(rule, operation, candidate);
}

/**
 * Build a mount policy for arbitrary shell children. A frozen parent is mounted
 * read-only while each entry that already existed at invocation time is
 * re-exposed read-write. This freezes the parent's directory entries at the
 * kernel mount boundary, so mkdir(2), rename(2), Git, Python, Node, archive
 * extractors, rsync, and similar programs cannot create a bypass by using a
 * different executable.
 *
 * The user systemd manager sockets are hidden from restricted children so a
 * command cannot ask the manager to launch an unrestricted sibling unit and
 * escape the mount namespace.
 */
export async function buildFilesystemMountPolicy(
  rules: readonly FilesystemBlockRule[],
  operation = 'shell.exec',
): Promise<FilesystemMountPolicy> {
  const readOnlyPaths = new Set<string>();
  const readWritePaths = new Set<string>();
  const inaccessiblePaths = new Set<string>();
  const messages = new Set<string>();

  for (const rule of rules) {
    if (rule.mode !== 'freeze-children') continue;
    const root = await canonicalRulePath(rule, operation);
    readOnlyPaths.add(root);
    if (rule.message !== undefined) messages.add(rule.message);

    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      // A symlink's target is not made read-only merely because the symlink's
      // containing directory is mounted read-only. Rebinding it would instead
      // resolve and potentially widen write access outside the protected tree.
      if (entry.isSymbolicLink()) continue;
      readWritePaths.add(join(root, entry.name));
    }
  }

  if (readOnlyPaths.size > 0 && process.platform === 'linux') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    const runtimeRoots = new Set<string>();
    if (process.env.XDG_RUNTIME_DIR !== undefined) runtimeRoots.add(resolve(process.env.XDG_RUNTIME_DIR));
    if (uid !== undefined) runtimeRoots.add(`/run/user/${uid}`);
    for (const runtimeRoot of runtimeRoots) {
      for (const socketPath of [join(runtimeRoot, 'systemd', 'private'), join(runtimeRoot, 'bus')]) {
        try {
          await lstat(socketPath);
          inaccessiblePaths.add(socketPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }
  }

  return {
    readOnlyPaths: [...readOnlyPaths],
    readWritePaths: [...readWritePaths],
    inaccessiblePaths: [...inaccessiblePaths],
    messages: [...messages],
  };
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
