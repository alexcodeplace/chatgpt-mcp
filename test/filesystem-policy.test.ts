import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  authorizePath,
  authorizePathRead,
  authorizePathEntryCreation,
  authorizePathEntryMutation,
  authorizeShellFilesystemMutation,
  authorizeShellFilesystemRead,
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

test('direct shell mutation guard blocks protected mkdir/rmdir/rm without affecting nested work', async () => {
  const f = await fixture();
  const existing = join(f.root, 'existing');
  const rules = [{ path: f.root, mode: 'freeze-children' as const, message: 'blocked' }];
  try {
    await mkdir(existing);
    await assert.rejects(
      () => authorizeShellFilesystemMutation('mkdir', [join(f.root, 'new-project')], existing, rules),
      (error: unknown) => (error as { code?: string }).code === 'PATH_NOT_ALLOWED',
    );
    await authorizeShellFilesystemMutation('mkdir', ['nested'], existing, rules);
    await authorizeShellFilesystemMutation('rmdir', [join(existing, 'nested')], existing, rules);
    await assert.rejects(
      () => authorizeShellFilesystemMutation('rmdir', ['-p', join(existing, 'nested')], f.root, rules),
      (error: unknown) => (error as { code?: string }).code === 'PATH_NOT_ALLOWED',
    );
    await assert.rejects(
      () => authorizeShellFilesystemMutation('rm', ['-rf', existing], f.root, rules),
      (error: unknown) => (error as { code?: string }).code === 'PATH_NOT_ALLOWED',
    );
    await authorizeShellFilesystemMutation('node', ['-e', 'process.exit(0)'], existing, rules);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});


test('direct shell read guard blocks protected explicit paths, relative aliases, and dd input while leaving ordinary files alone', async () => {
  const f = await fixture();
  const protectedDir = join(f.root, 'protected');
  const protectedFile = join(protectedDir, 'token.txt');
  const ordinary = join(f.root, 'ordinary.txt');
  const alias = join(f.root, 'alias.txt');
  const rules = [{ path: protectedDir, mode: 'deny-read' as const, message: 'use named-key tools' }];
  try {
    await mkdir(protectedDir);
    await writeFile(protectedFile, 'synthetic');
    await writeFile(ordinary, 'ok');
    await symlink(protectedFile, alias);
    for (const [command, args, cwd] of [
      ['cat', [protectedFile], f.root],
      ['head', ['-n', '1', '../protected/token.txt'], join(f.root, 'child')],
      ['base64', [alias], f.root],
      ['cp', [protectedFile, join(f.root, 'copy')], f.root],
      ['dd', [`if=${protectedFile}`, 'of=/dev/null'], f.root],
    ] as const) {
      if (cwd.endsWith('/child')) await mkdir(cwd);
      await assert.rejects(
        () => authorizeShellFilesystemRead(command, args, cwd, rules),
        (error: unknown) => (error as { code?: string; message?: string }).code === 'PATH_NOT_ALLOWED'
          && (error as { message?: string }).message === 'use named-key tools',
      );
    }
    await authorizeShellFilesystemRead('cat', [ordinary], f.root, rules);
    await authorizeShellFilesystemRead('node', ['-e', 'process.exit(0)'], f.root, rules);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test('deny-read blocks an exact file and directory descendants with the configured message', async () => {
  const f = await fixture();
  const protectedDir = join(f.root, 'protected');
  const protectedFile = join(protectedDir, 'token.txt');
  const sibling = join(f.root, 'ordinary.txt');
  try {
    await mkdir(protectedDir);
    await writeFile(protectedFile, 'synthetic');
    await writeFile(sibling, 'ok');
    const message = 'Use the brokered named-key tools for this path.';
    await assert.rejects(
      () => authorizePathRead(protectedFile, [f.root], [{ path: protectedFile, mode: 'deny-read', message }]),
      (error: unknown) => (error as { code?: string; message?: string }).code === 'PATH_NOT_ALLOWED' && (error as { message?: string }).message === message,
    );
    await assert.rejects(
      () => authorizePathRead(protectedFile, [f.root], [{ path: protectedDir, mode: 'deny-read' }]),
      (error: unknown) => (error as { code?: string }).code === 'PATH_NOT_ALLOWED',
    );
    assert.equal(await authorizePathRead(sibling, [f.root], [{ path: protectedDir, mode: 'deny-read' }]), sibling);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test('deny-read follows aliases to a protected file while freeze-children remains read-neutral', async () => {
  const f = await fixture();
  const protectedFile = join(f.root, 'protected.txt');
  const alias = join(f.root, 'alias.txt');
  try {
    await writeFile(protectedFile, 'synthetic');
    await symlink(protectedFile, alias);
    await assert.rejects(
      () => authorizePathRead(alias, [f.root], [{ path: protectedFile, mode: 'deny-read' }]),
      (error: unknown) => (error as { code?: string }).code === 'PATH_NOT_ALLOWED',
    );
    assert.equal(await authorizePathRead(protectedFile, [f.root], [{ path: f.root, mode: 'freeze-children' }]), protectedFile);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});
