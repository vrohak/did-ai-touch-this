import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { Session, Touch } from '../src/model.ts';
import { resolvePath, systemPathEnv } from '../src/paths.ts';
import { UNTITLED } from '../src/scan.ts';
import { App, createServer } from '../src/server.ts';
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

test('a folder that only one session "read" is a search in that session\'s own tree too', () => {
  const reader = session('a', [touch('C:/repo/src', 'read', false)]);
  const all = new TouchTree([reader, session('b', [touch('C:/repo/src/a.ts', 'change', true)])], win);
  const own = new TouchTree([reader], win, all);
  assert.equal(own.isFolder(own.find('C:/repo/src')!), true);
  assert.deepEqual(own.root.counts, { read: 0, readExact: 0, change: 0, changeExact: 0, search: 1, searchExact: 0 });
});

test('the tree opens at a folder, even when one file holds all the touches', () => {
  const tree = new TouchTree([session('a', [touch('C:/repo/src/a.ts', 'change', true)])], win);
  assert.equal(tree.start(), 'C:/repo/src');
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
  assert.deepEqual(activity[0]!.counts, { read: 0, readExact: 0, change: 2, changeExact: 0, search: 0, searchExact: 0 });
  assert.deepEqual(activity[0]!.levels, { read: 0, change: 1, search: 0 });
});

test('activity counts a folder once when a session both read and searched it', () => {
  const tree = new TouchTree([session('a', [touch('C:/repo/src', 'read', false), touch('C:/repo/src', 'search', true), touch('C:/repo/src/a.ts', 'read', true)])], win);
  const [a] = tree.activity(tree.root);
  assert.deepEqual(a!.counts, { read: 1, readExact: 1, change: 0, changeExact: 0, search: 1, searchExact: 1 });
});

// Sessions, one at a time, in an index of Windows paths that no test reads from disk.

const shop = 'C:/Users/me/shop';
const second = (i: number): string => new Date(Date.UTC(2026, 8, 29, 10, 0, i)).toISOString();
const index = new App(win, { claudeProjects: 'none', codexHome: 'none' }, 'none');
index.load([
  {
    ...session('a', [
      touch(`${shop}/src/a.ts`, 'change', true),
      touch(`${shop}/src`, 'read', false),
      touch(`${shop}/src`, 'search', true),
      // A folder only because session b touched a file in it.
      touch(`${shop}/docs`, 'read', false),
    ]),
    cwd: 'C:\\Users\\me\\shop\\.claude\\worktrees\\discounts',
    start: '2026-10-01T09:00:00.000Z',
    end: '2026-10-01T10:00:00.000Z',
  },
  // No transcript times, so its touches give them.
  {
    ...session('b', [touch(`${shop}/docs/guide.md`, 'read', false, '2026-10-02T08:00:00.000Z'), touch(`${shop}/src/a.ts`, 'read', true, '2026-10-02T09:30:00.000Z')], 'codex'),
    cwd: 'C:\\Users\\me\\shop',
  },
  { ...session('c', [touch('C:/Users/me/notes/todo.md', 'read', true)]), cwd: undefined, end: '2026-10-01T10:00:00.000Z' },
  { ...session('d', [touch(`${shop}/x.ts`, 'read', true), touch('D:/data/y.csv', 'read', true)]), cwd: 'C:\\Users\\me\\shop', end: '2026-09-30T10:00:00.000Z' },
  {
    ...session('h', [touch(`${shop}/lib/y.ts`, 'change', true), touch('C:/Users/me/.claude/settings.json', 'read', true)]),
    cwd: 'C:\\Users\\me\\shop',
    end: '2026-09-30T09:00:00.000Z',
  },
  {
    ...session('gen', [touch(`${shop}/gen`, 'change', false), ...Array.from({ length: 102 }, (_, i) => touch(`${shop}/gen/f${String(i).padStart(3, '0')}.ts`, 'change', i % 2 === 0, second(i)))], 'codex'),
    end: second(102),
  },
  { ...session('dup', [touch(`${shop}/x.ts`, 'read', true)]), end: '2026-09-01T00:00:00.000Z' },
  { ...session('dup', [touch(`${shop}/x.ts`, 'read', true)], 'codex'), end: '2026-09-02T00:00:00.000Z' },
]);

const server = createServer(index);
let base = '';
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const call = async (url: string): Promise<{ status: number; body: any }> => {
  const res = await fetch(base + url);
  return { status: res.status, body: await res.json() };
};
const get = async (url: string) => {
  const { status, body } = await call(url);
  assert.equal(status, 200, url);
  return body;
};

test("a session's counts are the same in the list, in its own tree and on its card at the root", () => {
  const cards = new Map(index.touches('').sessions.map((c) => [c.key, c]));
  const rows = index.sessionRows();
  assert.equal(rows.length, 8);
  for (const row of rows) {
    assert.deepEqual(row.counts, index.treeFor(row.key)!.root.counts, row.key);
    assert.deepEqual(row.counts, cards.get(row.key)!.counts, row.key);
  }
});

test('the Sessions list is newest first, folds worktrees into their project, and dates sessions by their touches when it must', async () => {
  const { generation, sessions } = await get('/api/sessions');
  assert.equal(generation, index.generation);
  assert.deepEqual(
    sessions.map((s: { key: string }) => s.key),
    ['codex:b', 'claude:a', 'claude:c', 'claude:d', 'claude:h', 'codex:gen', 'codex:dup', 'claude:dup'],
  );
  const [b, a, c] = sessions;
  assert.deepEqual([a.project, a.worktree], [shop, 'discounts']);
  assert.deepEqual([b.project, b.worktree], [shop, null]);
  assert.deepEqual([c.project, c.worktree], [null, null]);
  assert.deepEqual([b.start, b.end], ['2026-10-02T08:00:00.000Z', '2026-10-02T09:30:00.000Z']);
  assert.deepEqual(Object.keys(a).sort(), ['agent', 'counts', 'end', 'id', 'key', 'project', 'start', 'title', 'untitled', 'worktree']);
});

test('a session opens at its own folder, with the folders of the files it changed', async () => {
  const gen = await get('/api/session?session=codex:gen');
  assert.equal(gen.opensAt, `${shop}/gen`);
  assert.deepEqual(gen.changedFolders, { all: [`${shop}/gen`], exact: [`${shop}/gen`] }, 'the folder it changed is not a file');

  assert.equal((await get('/api/session?session=claude:h')).opensAt, shop, 'its config read in the home folder does not lift it out of its project');
  const d = await get('/api/session?session=claude:d');
  assert.equal(d.opensAt, shop, 'a session across drives opens at its project');
  assert.equal(d.cwd, 'C:\\Users\\me\\shop');
  assert.equal(d.resume, 'cd "C:\\Users\\me\\shop"; claude --resume d');
  assert.deepEqual(d.counts, { read: 2, readExact: 2, change: 0, changeExact: 0, search: 0, searchExact: 0 });
});

test('a session is found by its key or a bare id, and anything else is an error', async () => {
  assert.equal((await get('/api/session?session=a')).key, 'claude:a');
  assert.equal((await get('/api/session?session=dup')).key, 'codex:dup', 'a bare id means the newest session with it');
  assert.deepEqual((await get('/api/children?path=&session=c')).entries.map((e: { name: string }) => e.name), ['C:']);
  assert.deepEqual(await call('/api/session'), { status: 400, body: { error: 'Missing session' } });
  for (const url of ['/api/session?session=claude:nope', '/api/children?path=&session=codex:a', '/api/coverage?path=&session=nope']) {
    assert.deepEqual(await call(url), { status: 404, body: { error: 'No session with that id' } }, url);
  }
  for (const url of ['/api/session?session=', '/api/session?session=..%2Fa', '/api/children?path=&session=gpt:a', '/api/coverage?path=&session=a%20b']) {
    assert.deepEqual(await call(url), { status: 400, body: { error: 'Invalid session' } }, url);
  }
});

test("the cards of a file's sessions say which session, project and worktree each is", () => {
  const cards = index.touches(`${shop}/src/a.ts`).sessions.map(({ key, project, worktree }) => ({ key, project, worktree }));
  assert.deepEqual(cards, [
    { key: 'codex:b', project: shop, worktree: null },
    { key: 'claude:a', project: shop, worktree: 'discounts' },
  ]);
});

const emptyApp = (): App => new App(win, { claudeProjects: 'none', codexHome: 'none' }, 'none');

test('a session opens the folders of its newest changes, however many files it changed in one folder', () => {
  const app = emptyApp();
  const edits = ['src/checkout/cart.ts', 'src/api/orders.ts', 'lib/money.ts'].map((f, i) => touch(`${shop}/${f}`, 'change', true, second(i)));
  const snapshots = Array.from({ length: 120 }, (_, i) => touch(`${shop}/test/__snapshots__/s${i}.snap`, 'change', false, second(10 + i)));
  const wide = Array.from({ length: 30 }, (_, i) => touch(`${shop}/m${String(i).padStart(2, '0')}/x.ts`, 'change', true, second(i)));
  app.load([session('big', [...edits, ...snapshots]), session('wide', wide)]);
  assert.deepEqual(app.session('big')!.changedFolders, {
    all: [`${shop}/test/__snapshots__`, `${shop}/lib`, `${shop}/src/api`, `${shop}/src/checkout`],
    exact: [`${shop}/lib`, `${shop}/src/api`, `${shop}/src/checkout`],
  });
  const { all } = app.session('wide')!.changedFolders;
  assert.equal(all.length, 25);
  assert.deepEqual([all[0], all.at(-1)], [`${shop}/m29`, `${shop}/m05`]);
});

test('a session opens at its project only when it touched something there', () => {
  const app = emptyApp();
  app.load([
    { ...session('home', [touch('C:/Users/me/a/x.ts', 'read', true), touch('C:/Users/me/b/y.ts', 'change', true)]), cwd: 'C:\\Users\\me\\shop' },
    { ...session('drive', [touch('D:/a/x.ts', 'read', true), touch('D:/b/y.ts', 'change', true)]), cwd: 'C:\\Users\\me\\shop' },
    // Across two drives, so its own tree starts at the list of drives, which can't be selected.
    {
      ...session('drives', [touch('D:/exports/orders.csv', 'read', true), touch('C:/Users/me/notes/orders.md', 'change', true), touch('C:/Users/me/notes', 'search', true)]),
      cwd: 'C:\\Users\\me\\shop',
    },
    { ...session('searches', [touch('C:/a', 'search', true), touch('D:/b', 'search', true), touch('D:/c', 'search', true)]), cwd: 'C:\\Users\\me\\shop' },
  ]);
  assert.equal(app.session('home')!.opensAt, 'C:/Users/me');
  assert.equal(app.session('drive')!.opensAt, 'D:/');
  assert.equal(app.session('drives')!.opensAt, 'C:/Users/me/notes', 'the drive with as many paths read or changed, and more changed');
  assert.equal(app.session('searches')!.opensAt, 'D:/', 'the drive with the most searches, when it only searched');
});

test('a quoted path resolves as the plain one does, even with its closing quote lost', async () => {
  for (const p of ['C:\\Users\\me\\shop\\x.ts', '"C:\\Users\\me\\shop\\x.ts"', '"C:\\Users\\me\\shop\\x.ts', "  'C:\\Users\\me\\shop\\x.ts'  "]) {
    assert.deepEqual(await get(`/api/resolve?path=${encodeURIComponent(p)}`), { path: `${shop}/x.ts` }, p);
  }
});

test('loading a new index replaces every count worked out from the old one', () => {
  const app = emptyApp();
  app.load([session('a', [touch(`${shop}/a.ts`, 'read', true)])]);
  const generation = app.generation;
  assert.equal(app.sessionRows()[0]!.counts.read, 1);
  assert.equal(app.treeFor('a')!.root.counts.read, 1);
  app.load([session('a', [touch(`${shop}/a.ts`, 'read', true), touch(`${shop}/b.ts`, 'read', true)])]);
  assert.equal(app.generation, generation + 1);
  assert.equal(app.sessionRows()[0]!.counts.read, 2);
  assert.equal(app.treeFor('a')!.root.counts.read, 2);
  assert.equal(app.session('a')!.counts.read, 2);
});

test('an untitled session is marked so by the server, which names it', () => {
  const app = emptyApp();
  app.load([{ ...session('a', [touch(`${shop}/a.ts`, 'read', true)]), title: UNTITLED }, session('b', [touch(`${shop}/a.ts`, 'read', true)])]);
  assert.deepEqual(app.sessionRows().map((r) => [r.key, r.untitled]).sort(), [['claude:a', true], ['claude:b', false]]);
});

// Coverage and folder listings against a real git repo and a plain folder.

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
  app.load([
    session('s1', [
      touch(at('repo', 'src', 'a.ts'), 'read', true),
      touch(at('repo', 'src', 'b.ts'), 'change', false),
      touch(at('repo', 'node_modules', 'lib', 'x.js'), 'read', false),
      touch(at('repo', 'src', 'deleted.ts'), 'change', true),
      touch(at('plain', 'a.txt'), 'read', true),
    ]),
    session('s2', [touch(at('repo', '.gitignore'), 'read', true), touch(at('repo', 'lib', 'gone.ts'), 'change', true)], 'codex'),
  ]);
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('coverage in a repo counts only files git tracks or would track', async () => {
  assert.deepEqual(await app.coverage(at('repo'), app.treeFor()!), { path: at('repo'), total: 4, read: 2, readExact: 2, change: 1, changeExact: 0 });
  assert.equal((await app.coverage(at('repo', 'node_modules'), app.treeFor()!)).total, 0);
});

test('coverage outside a repo leaves out dependency folders', async () => {
  assert.deepEqual(await app.coverage(at('plain'), app.treeFor()!), { path: at('plain'), total: 1, read: 1, readExact: 1, change: 0, changeExact: 0 });
});

test("a session's coverage counts only its files, out of the same files on disk", async () => {
  assert.deepEqual(await app.coverage(at('repo'), app.treeFor('s1')!), { path: at('repo'), total: 4, read: 1, readExact: 1, change: 1, changeExact: 0 });
  assert.deepEqual(await app.coverage(at('repo'), app.treeFor('s2')!), { path: at('repo'), total: 4, read: 1, readExact: 1, change: 0, changeExact: 0 });
});

test('a folder lists what is on disk, plus touched files that are gone', async () => {
  const { entries } = await app.children(at('repo', 'src'), {}, app.treeFor()!);
  assert.deepEqual(
    entries.map((e) => `${e.name} ${e.onDisk ? 'on disk' : 'gone'}`),
    ['a.ts on disk', 'b.ts on disk', 'deleted.ts gone'],
  );
  const repo = await app.children(at('repo'), {}, app.treeFor()!);
  assert.deepEqual(repo.entries.map((e) => e.name), ['.git', 'dist', 'lib', 'node_modules', 'src', '.gitignore', 'README.md']);
});

test("a session's folder listing has only its counts, and only its touched paths that are gone", async () => {
  const listing = async (dir: string, ref: string) =>
    (await app.children(dir, {}, app.treeFor(ref)!)).entries.map((e) => `${e.name} ${e.onDisk ? 'on disk' : 'gone'} ${e.counts.read}/${e.counts.change}`);
  assert.deepEqual(await listing(at('repo', 'src'), 's1'), ['a.ts on disk 1/0', 'b.ts on disk 0/1', 'deleted.ts gone 0/1']);
  assert.deepEqual(await listing(at('repo', 'src'), 's2'), ['a.ts on disk 0/0', 'b.ts on disk 0/0']);
  assert.deepEqual(await listing(at('repo'), 's2'), [
    '.git on disk 0/0',
    'dist on disk 0/0',
    'lib gone 0/1',
    'node_modules on disk 0/0',
    'src on disk 0/0',
    '.gitignore on disk 1/0',
    'README.md on disk 0/0',
  ]);
});

test('"did AI touch this?" lists the sessions with how they touched the file and how to resume them', () => {
  const result = app.touches(at('repo', 'src', 'a.ts'));
  assert.equal(result.onDisk, true);
  assert.equal(result.sessions.length, 1);
  assert.deepEqual(result.sessions[0]!.levels, { read: 2, change: 0, search: 0 });
  assert.equal(result.sessions[0]!.resume, 'cd "C:\\repo"; claude --resume s1');
  assert.deepEqual(app.touches(at('repo', 'README.md')).sessions, []);
});
