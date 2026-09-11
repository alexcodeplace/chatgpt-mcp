import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  authorizePath,
  authorizePathEntryCreation,
  authorizePathEntryMutation,
  buildFilesystemMountPolicy,
} from '../src/policy/filesystem.js';

async function fixture(): Promise<{ base: string; root: string; outside: string }> {
  const base = await mkdtemp(join(tmpdir(), 'chatgpt-mcp-policy-'));
  const root = join(base, 'allowed');
  const outside = join(base, 'outside');
  await mkdir(root);
  await mkdir(outside);
  return { base, root, outside };
}

test('path inside configured root is authorized', async () => {
  const f = await fixture();
  try {
    const file = join(f.root, 'a.txt');
    await writeFile(file, 'ok');
    assert.equal(await authorizePath(file, [f.root], 'fs.read'), file);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test('root itself is authorized', async () => {
  const f = await fixture();
  try {
    assert.equal(await authorizePath(f.root, [f.root], 'fs.list'), f.root);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test('parent traversal and sibling-prefix escape are rejected', async () => {
  const f = await fixture();
  try {
    await assert.rejects(() => authorizePath(join(f.root, '..', 'outside'), [f.root], 'fs.read'));
    const sibling = `${f.root}2`;
    await mkdir(sibling);
    await assert.rejects(() => authorizePath(sibling, [f.root], 'fs.read'));
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test('existing symlink cannot escape an allowed root', async () => {
  const f = await fixture();
  try {
    const link = join(f.root, 'escape');
    await symlink(f.outside, link);
    await assert.rejects(() => authorizePath(join(link, 'secret.txt'), [f.root], 'fs.read'));
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test('creation beneath a symlinked ancestor cannot escape root', async () => {
  const f = await fixture();
  try {
    const link = join(f.root, 'escape');
    await symlink(f.outside, link);
    await assert.rejects(() => authorizePath(join(link, 'new', 'file.txt'), [f.root], 'fs.write'));
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test('one of multiple configured roots may authorize a path', async () => {
  const f = await fixture();
  try {
    const second = join(f.base, 'second');
    await mkdir(second);
    const file = join(second, 'b.txt');
    await writeFile(file, 'ok');
    assert.equal(await authorizePath(file, [f.root, second], 'fs.read'), file);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test('freeze-children blocks a new direct child and returns the configured agent message', async () => {
  const f = await fixture();
  const message = 'Create worktrees under the current project .worktrees/ directory.';
  try {
    await assert.rejects(
      () => authorizePathEntryCreation(join(f.root, 'new-project'), [{ path: f.root, mode: 'freeze-children', message }], 'fs.mkdir'),
      (error: unknown) => {
        const candidate = error as { code?: string; message?: string };
        return candidate.code === 'PATH_NOT_ALLOWED' && candidate.message === message;
      },
    );
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test('freeze-children allows creation below an existing child but blocks recursive creation through a new child', async () => {
  const f = await fixture();
  const existing = join(f.root, 'existing');
  const rules = [{ path: f.root, mode: 'freeze-children' as const }];
  try {
    await mkdir(existing);
    await authorizePathEntryCreation(join(existing, 'nested'), rules, 'fs.mkdir');
    await assert.rejects(
      () => authorizePathEntryCreation(join(f.root, 'new-project', 'nested'), rules, 'fs.mkdir'),
      (error: unknown) => (error as { code?: string }).code === 'PATH_NOT_ALLOWED',
    );
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test('freeze-children follows a symlink alias to the protected parent', async () => {
  const f = await fixture();
  const alias = join(f.base, 'alias');
  try {
    await symlink(f.root, alias);
    await assert.rejects(
      () => authorizePathEntryCreation(join(alias, 'new-project'), [{ path: f.root, mode: 'freeze-children' }], 'fs.mkdir'),
      (error: unknown) => (error as { code?: string }).code === 'PATH_NOT_ALLOWED',
    );
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test('freeze-children blocks rename or removal of an existing direct child', async () => {
  const f = await fixture();
  const existing = join(f.root, 'existing');
  try {
    await mkdir(existing);
    await assert.rejects(
      () => authorizePathEntryMutation(existing, [{ path: f.root, mode: 'freeze-children' }], 'fs.move'),
      (error: unknown) => (error as { code?: string }).code === 'PATH_NOT_ALLOWED',
    );
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test('freeze-children also blocks mutation of the protected root itself', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => authorizePathEntryMutation(f.root, [{ path: f.root, mode: 'freeze-children', message: 'root protected' }], 'fs.move'),
      (error: unknown) => {
        const candidate = error as { code?: string; message?: string };
        return candidate.code === 'PATH_NOT_ALLOWED' && candidate.message === 'root protected';
      },
    );
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test('shell mount policy freezes the parent and re-exposes existing non-symlink children', async () => {
  const f = await fixture();
  const existing = join(f.root, 'existing with spaces');
  const alias = join(f.root, 'alias');
  try {
    await mkdir(existing);
    await writeFile(join(f.root, 'existing.txt'), 'ok');
    await symlink(f.outside, alias);
    const policy = await buildFilesystemMountPolicy([
      { path: f.root, mode: 'freeze-children', message: 'blocked' },
    ]);
    assert.deepEqual(policy.readOnlyPaths, [f.root]);
    assert.ok(policy.readWritePaths.includes(existing));
    assert.ok(policy.readWritePaths.includes(join(f.root, 'existing.txt')));
    assert.equal(policy.readWritePaths.includes(alias), false);
    assert.deepEqual(policy.messages, ['blocked']);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});
