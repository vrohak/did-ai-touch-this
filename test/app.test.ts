import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { Session, Touch } from '../src/model.ts';
import { resolvePath, systemPathEnv } from '../src/paths.ts';
import { App } from '../src/server.ts';
import { TouchTree } from '../src/tree.ts';
import { win } from './env.ts';

const touch = (p: string, kind: Touch['kind'], exact: boolean, when = '2026-10-01T10:00:00.000Z'): Touch => ({ path: p, kind, exact, tools: ['t'], first: when, last: when });
const session = (id: string, touches: Touch[], agent: Session['agent'] = 'claude'): Session => ({ agent, id, title: `Session ${id}`, cwd: 'C:\\repo', touches });

test('folders count the paths under them, in all and only from file tools', () => {
  const tree = new TouchTree(
    [
      session('a', [touch('C:/repo/src/a.ts', 'read', true), touch('C:/repo/src/b.ts', 'change', false), touch('C:/repo/README.md', 'read', false)]),
      session('b', [touch('C:/repo/src/a.ts', 'change', true), touch('C:/repo/src', 'search', true)]),
    ],
    win,
  );
  const repo = tree.find('C:/repo')!;
  assert.deepEqual(repo.counts, { read: 2, readExact: 1, change: 2, changeExact: 1, search: 1, searchExact: 1 });
  assert.deepEqual(tree.find('c:/REPO/src/A.ts')?.own, { read: 2, change: 2, search: 0 });
  assert.equal(tree.start(), 'C:/repo');
});

test('a "read" of a folder counts as searching it', () => {
  const tree = new TouchTree([session('a', [touch('C:/repo/src', 'read', false), touch('C:/repo/src/a.ts', 'read', true)])], win);
  assert.deepEqual(tree.find('C:/repo/src')!.own, { read: 0, change: 0, search: 1 });
  assert.equal(tree.find('C:/repo')!.counts.read, 1);
});

test('activity lists the sessions under a path, most recent first', () => {
  const tree = new TouchTree(
    [
      session('old', [touch('C:/repo/a.ts', 'read', true, '2026-01-01T00:00:00.000Z')]),
      session('new', [touch('C:/repo/a.ts', 'change', false, '2026-05-01T00:00:00.000Z'), touch('C:/repo/b.ts', 'change', false, '2026-05-01T00:00:00.000Z')], 'codex'),
    ],
    win,
  );
  const activity = tree.activity(tree.find('C:/repo')!);
  assert.deepEqual(activity.map((a) => a.session.id), ['new', 'old']);
  assert.deepEqual(activity[0]!.counts, { read: 0, change: 2, search: 0 });
  assert.deepEqual(activity[0]!.exactCounts, { read: 0, change: 0, search: 0 });
  assert.deepEqual(activity[0]!.levels, { read: 0, change: 1, search: 0 });
});

// Coverage against a real git repo and a plain folder.

const env = systemPathEnv();
let root = '';
const at = (...parts: string[]): string => resolvePath(path.join(root, ...parts), undefined, env)!;
const write = (rel: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), 'x');
};
let app: App;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dait-'));
  for (const f of ['repo/.gitignore', 'repo/README.md', 'repo/src/a.ts', 'repo/src/b.ts', 'repo/node_modules/lib/x.js', 'repo/dist/out.js', 'plain/a.txt', 'plain/node_modules/dep.js']) write(f);
  fs.writeFileSync(path.join(root, 'repo/.gitignore'), 'node_modules/\ndist/\n');
  execFileSync('git', ['init', '-q', path.join(root, 'repo')]);
  app = new App(env, { claudeProjects: path.join(root, 'none'), codexHome: path.join(root, 'none') }, path.join(root, 'cache.json'));
  app.tree = new TouchTree(
    [
      session('s1', [
        touch(at('repo', 'src', 'a.ts'), 'read', true),
        touch(at('repo', 'src', 'b.ts'), 'change', false),
        touch(at('repo', 'node_modules', 'lib', 'x.js'), 'read', false),
        touch(at('repo', 'src', 'deleted.ts'), 'change', true),
        touch(at('plain', 'a.txt'), 'read', true),
      ]),
    ],
    env,
  );
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('coverage in a repo counts only files git tracks or would track', async () => {
  assert.deepEqual(await app.coverage(at('repo')), { path: at('repo'), total: 4, read: 1, readExact: 1, change: 1, changeExact: 0 });
  assert.equal((await app.coverage(at('repo', 'node_modules'))).total, 0);
});

test('coverage outside a repo leaves out dependency folders', async () => {
  assert.deepEqual(await app.coverage(at('plain')), { path: at('plain'), total: 1, read: 1, readExact: 1, change: 0, changeExact: 0 });
});

test('a folder lists what is on disk, plus touched files that are gone', async () => {
  const { entries } = await app.children(at('repo', 'src'), {});
  assert.deepEqual(
    entries.map((e) => `${e.name} ${e.onDisk ? 'on disk' : 'gone'}`),
    ['a.ts on disk', 'b.ts on disk', 'deleted.ts gone'],
  );
  const repo = await app.children(at('repo'), {});
  assert.deepEqual(repo.entries.map((e) => e.name), ['.git', 'dist', 'node_modules', 'src', '.gitignore', 'README.md']);
});

test('"did AI touch this?" lists the sessions with how they touched the file and how to resume them', () => {
  const result = app.touches(at('repo', 'src', 'a.ts'));
  assert.equal(result.onDisk, true);
  assert.equal(result.sessions.length, 1);
  assert.deepEqual(result.sessions[0]!.levels, { read: 2, change: 0, search: 0 });
  assert.equal(result.sessions[0]!.resume, 'cd "C:\\repo"; claude --resume s1');
  assert.deepEqual(app.touches(at('repo', 'README.md')).sessions, []);
});
