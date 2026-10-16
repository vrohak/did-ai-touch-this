import assert from 'node:assert/strict';
import { test } from 'node:test';
import { globBase, looksLikeFile, parentPath, resolvePath, splitPath } from '../src/paths.ts';
import { posix, win } from './env.ts';

test('Windows paths in every spelling agents use resolve to one canonical path', () => {
  const cwd = 'C:\\Users\\me\\repo';
  for (const raw of ['C:\\Users\\me\\repo\\src\\a.ts', 'c:/Users/me/repo/src/a.ts', '/c/Users/me/repo/src/a.ts', '/mnt/c/Users/me/repo/src/a.ts', 'file:///C:/Users/me/repo/src/a.ts', 'src\\a.ts', './src/a.ts', 'src/../src/a.ts', '~/repo/src/a.ts']) {
    assert.equal(resolvePath(raw, cwd, win), 'C:/Users/me/repo/src/a.ts', raw);
  }
});

test('Git Bash /tmp is the Windows temp folder', () => {
  assert.equal(resolvePath('/tmp/out.log', undefined, win), 'C:/Users/me/AppData/Local/Temp/out.log');
});

test('paths outside the filesystem resolve to nothing', () => {
  for (const raw of ['/dev/null', 'NUL', '$null', 'https://example.com/a.ts', '/usr/bin/env', '//server/share/x', '/s', '/q']) {
    assert.equal(resolvePath(raw, 'C:/x', win), null, raw);
  }
  assert.equal(resolvePath('/dev/null', '/home/me', posix), null);
  assert.equal(resolvePath('relative.ts', undefined, posix), null);
});

test('Claude Code worktrees fold into their repo', () => {
  assert.equal(resolvePath('C:/Users/me/repo/.claude/worktrees/fix-bug/src/a.ts', undefined, win), 'C:/Users/me/repo/src/a.ts');
  assert.equal(resolvePath('src/a.ts', '/home/me/repo/.claude/worktrees/x', posix), '/home/me/repo/src/a.ts');
});

test('paths split into their root and names, and back', () => {
  assert.deepEqual(splitPath('C:/Users/me'), ['C:', 'Users', 'me']);
  assert.deepEqual(splitPath('C:/'), ['C:']);
  assert.deepEqual(splitPath('/home/me'), ['/', 'home', 'me']);
  assert.equal(parentPath('C:/Users'), 'C:/');
  assert.equal(parentPath('/home'), '/');
  assert.equal(parentPath('C:/'), null);
});

test('glob bases and file-like names', () => {
  assert.equal(globBase('src/**/*.ts'), 'src/');
  assert.equal(globBase('*.md'), '.');
  assert.ok(looksLikeFile('src/app.ts'));
  assert.ok(looksLikeFile('Makefile'));
  assert.ok(looksLikeFile('.env.local'));
  assert.ok(!looksLikeFile('src'));
  assert.ok(!looksLikeFile('.github'));
});
