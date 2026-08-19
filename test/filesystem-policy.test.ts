import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { authorizePath } from '../src/policy/filesystem.js';

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
