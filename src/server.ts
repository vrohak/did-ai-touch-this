import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Disk } from './disk.ts';
import type { Session, TouchKind } from './model.ts';
import { isWithin, joinPath, looksLikeFile, parentPath, pathKey, resolvePath, systemPathEnv, worktreeName, type PathEnv } from './paths.ts';
import { defaultCacheFile, defaultSources, scan, UNTITLED, type Progress, type Sources } from './scan.ts';
import { emptyCounts, KINDS, TouchTree, type Counts, type Level, type TreeNode } from './tree.ts';

/** Untouched entries a folder lists before the rest wait behind "show more". */
const UNTOUCHED_LIMIT = 300;

/** One-session trees kept built, so going back and forth between recent sessions is instant. */
const SESSION_TREES = 8;

/** Folders of changed files a session's tree opens with, so the tree stays readable. */
const OPEN_FOLDERS = 25;

/** A session key (`claude:<id>`) or a bare id. */
const SESSION_REF = /^((claude|codex):)?[0-9A-Za-z_-]{1,128}$/;
const NO_SESSION = { error: 'No session with that id' };

const PUBLIC = path.join(import.meta.dirname, '..', 'public');
const STATIC: Record<string, string> = {
  '/': 'index.html',
  '/app.js': 'app.js',
  '/sessions.js': 'sessions.js',
  '/app.css': 'app.css',
  '/favicon.svg': 'favicon.svg',
};
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

export interface Entry {
  name: string;
  path: string;
  dir: boolean;
  onDisk: boolean;
  own: Record<TouchKind, Level>;
  counts: Counts;
}

type SessionInfo = ReturnType<typeof sessionInfo>;

/** A row of the Sessions list, which leaves out what only the banner and the cards show. */
export type SessionRow = Omit<SessionInfo, 'cwd' | 'resume'> & { counts: Counts };

/** The index and the filesystem view behind the API, rebuilt by each scan. */
export class App {
  readonly env: PathEnv;
  private readonly sources: Sources;
  private readonly cacheFile: string;
  tree: TouchTree | null = null;
  disk: Disk;
  generation = 0;
  scanning = false;
  progress: Progress = { done: 0, total: 0 };
  scannedAt: string | null = null;
  error: string | null = null;
  private byKey = new Map<string, Session>();
  /** Newest first, since a bare id means the newest session with it. */
  private byId = new Map<string, Session[]>();
  /** Least recently used first. */
  private readonly trees = new Map<string, TouchTree>();
  private rows: SessionRow[] | null = null;

  constructor(env: PathEnv, sources: Sources, cacheFile: string) {
    this.env = env;
    this.sources = sources;
    this.cacheFile = cacheFile;
    this.disk = new Disk(env);
  }

  async rescan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    this.error = null;
    try {
      this.load(await scan(this.sources, this.cacheFile, this.env, (p) => (this.progress = p)));
      this.scannedAt = new Date().toISOString();
    } catch (err) {
      this.error = (err as Error).message;
      console.error(err);
    } finally {
      this.scanning = false;
    }
  }

  /** Replaces the index, and with it everything worked out from it. */
  load(sessions: Session[]): void {
    this.tree = new TouchTree(sessions, this.env);
    this.byKey = new Map(sessions.map((s) => [sessionKey(s), s]));
    this.byId = new Map();
    for (const s of sessions) this.byId.set(s.id, [...(this.byId.get(s.id) ?? []), s]);
    for (const list of this.byId.values()) if (list.length > 1) list.sort((a, b) => compare(timesOf(b).end, timesOf(a).end));
    this.trees.clear();
    this.rows = null;
    this.disk = new Disk(this.env);
    this.generation++;
  }

  /** A session by its key, or by a bare id, which means the newest session with that id. */
  findSession(ref: string): Session | undefined {
    return this.byKey.get(ref) ?? this.byId.get(ref)?.[0];
  }

  /** The tree of all sessions, or of the one session `ref` names, or undefined when there's no such session. */
  treeFor(ref?: string): TouchTree | undefined {
    if (ref === undefined) return this.tree!;
    const s = this.findSession(ref);
    if (!s) return undefined;
    const key = sessionKey(s);
    const tree = this.trees.get(key) ?? new TouchTree([s], this.env, this.tree!);
    this.trees.delete(key);
    this.trees.set(key, tree);
    if (this.trees.size > SESSION_TREES) this.trees.delete(this.trees.keys().next().value!);
    return tree;
  }

  /** Every session, newest first, with the paths it touched at all. */
  sessionRows(): SessionRow[] {
    if (!this.rows) {
      const tree = this.tree!;
      const activity = new Map(tree.activity(tree.root).map((a) => [a.session, a]));
      this.rows = tree.sessions.map((s): SessionRow => {
        const { cwd, resume, ...info } = sessionInfo(s, this.env);
        return { ...info, counts: activity.get(s)?.counts ?? emptyCounts() };
      });
      this.rows.sort((a, b) => compare(b.end, a.end) || compare(a.key, b.key));
    }
    return this.rows;
  }

  /** One session for its banner, and where its scoped tree opens. */
  session(ref: string) {
    const s = this.findSession(ref);
    if (!s) return undefined;
    const info = sessionInfo(s, this.env);
    const tree = this.treeFor(info.key)!;
    const start = tree.start();
    const inProject = info.project ? tree.find(info.project) : undefined;
    // The list of drives ('') can't be selected, so a session that spans drives otherwise opens on its busiest one.
    const busiest = [...tree.root.children.values()].sort(
      (a, b) => b.counts.read + b.counts.change - (a.counts.read + a.counts.change) || b.counts.change - a.counts.change || b.counts.search - a.counts.search,
    )[0];
    return {
      ...info,
      counts: tree.root.counts,
      // Most sessions also touch files outside their project, such as their agent's config, which
      // lifts start() to a drive or the home folder; those open at their project, when they worked in it.
      opensAt:
        inProject && touched(inProject) && (parentPath(start) === null || isWithin(info.project!, start, this.env))
          ? info.project!
          : start || tree.start(busiest),
      changedFolders: { all: changedFolders(tree, false, this.env), exact: changedFolders(tree, true, this.env) },
    };
  }

  status() {
    return {
      scanning: this.scanning,
      progress: this.progress,
      error: this.error,
      scannedAt: this.scannedAt,
      generation: this.generation,
      windows: this.env.windows,
      sessions: this.tree?.sessions.length ?? 0,
      counts: this.tree?.root.counts ?? null,
      start: this.tree?.start() ?? null,
    };
  }

  /** A folder's entries: what's on disk now, plus touched paths that no longer are. */
  async children(dir: string, opts: { all?: boolean; ensure?: string }, tree: TouchTree) {
    const node = tree.find(dir);
    const entries = new Map<string, Entry>();
    const listing = dir === '' ? null : await this.disk.list(dir);
    for (const d of listing ?? []) {
      const key = pathKey(d.name, this.env);
      entries.set(key, entry(d.name, joinPath(dir, d.name), d.dir, true, node?.children.get(key)));
    }
    for (const [key, child] of node?.children ?? []) {
      if (entries.has(key)) continue;
      // Gone from disk: a folder if any session touched something under it, else a file if it was read, changed or looks like one.
      const dirLike = tree.isFolder(child) || (!child.own.read && !child.own.change && !looksLikeFile(child.name));
      entries.set(key, entry(child.name, child.path, dirLike, dir === '', child));
    }
    const sorted = [...entries.values()].sort(
      (a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
    );
    const ensureKey = opts.ensure ? pathKey(opts.ensure, this.env) : null;
    let untouched = 0;
    let hidden = 0;
    const shown = sorted.filter((e) => {
      if (touched(e) || opts.all || pathKey(e.path, this.env) === ensureKey) return true;
      if (++untouched <= UNTOUCHED_LIMIT) return true;
      hidden++;
      return false;
    });
    return { path: dir, onDisk: listing !== null, entries: shown, hidden };
  }

  /** How much of a folder's files were read and changed, counting only files coverage counts. */
  async coverage(dir: string, tree: TouchTree) {
    // '' is the list of drives, which has no files of its own to count.
    const total = dir ? await this.disk.total(dir) : null;
    const node = tree.find(dir);
    const cov = { path: dir, total, read: 0, readExact: 0, change: 0, changeExact: 0 };
    if (total === null || !node) return cov;
    for (const n of tree.nodesUnder(node)) {
      if (tree.isFolder(n) || !(n.own.read || n.own.change) || !(await this.disk.counts(n.path))) continue;
      if (n.own.read) cov.read++;
      if (n.own.read === 2) cov.readExact++;
      if (n.own.change) cov.change++;
      if (n.own.change === 2) cov.changeExact++;
    }
    return cov;
  }

  /** "Did AI touch this?": the sessions that touched a path or anything under it. */
  touches(p: string) {
    const node = this.tree!.find(p);
    const onDisk = p !== '' && fs.existsSync(p);
    if (!node) return { path: p, onDisk, own: null, counts: null, sessions: [] };
    return {
      path: node.path,
      onDisk,
      own: node.own,
      counts: node.counts,
      sessions: this.tree!.activity(node).map((a) => ({
        ...sessionInfo(a.session, this.env),
        levels: a.levels,
        tools: a.tools,
        counts: a.counts,
        first: a.first,
        last: a.last,
      })),
    };
  }
}

function entry(name: string, p: string, dir: boolean, onDisk: boolean, node: TreeNode | undefined): Entry {
  return {
    name,
    path: p,
    dir,
    onDisk,
    own: node?.own ?? { read: 0, change: 0, search: 0 },
    counts: node?.counts ?? emptyCounts(),
  };
}

function touched(e: { counts: Counts }): boolean {
  return KINDS.some((k) => e.counts[k] > 0);
}

function sessionKey(s: Session): string {
  return `${s.agent}:${s.id}`;
}

/** The one JSON form of a session, so the list, the banner and the cards agree. */
function sessionInfo(s: Session, env: PathEnv) {
  const { start, end } = timesOf(s);
  return {
    key: sessionKey(s),
    agent: s.agent,
    id: s.id,
    title: s.title,
    untitled: s.title === UNTITLED,
    project: s.cwd ? resolvePath(s.cwd, undefined, env) : null,
    worktree: s.cwd ? worktreeName(s.cwd) : null,
    cwd: s.cwd ?? null,
    start,
    end,
    resume: resumeCommand(s.agent, s.id, s.cwd),
  };
}

/** When a session ran, from its transcript, or from its touches when the transcript has no times. */
function timesOf(s: Session): { start: string; end: string } {
  let first = '';
  let last = '';
  if (!s.start || !s.end) {
    for (const t of s.touches) {
      if (t.first && (!first || t.first < first)) first = t.first;
      if (t.last > last) last = t.last;
    }
  }
  return { start: s.start || first, end: s.end || last };
}

function resumeCommand(agent: string, id: string, cwd: string | undefined): string {
  const command = agent === 'claude' ? `claude --resume ${id}` : `codex resume ${id}`;
  return cwd ? `cd "${cwd}"; ${command}` : command;
}

/**
 * The folders holding the files a one-session tree changed, newest change first, as many as its view
 * opens: from all its changes, or only from those a file tool recorded.
 */
function changedFolders(tree: TouchTree, exact: boolean, env: PathEnv): string[] {
  const files = [...tree.nodesUnder(tree.root)]
    .filter((n) => (exact ? n.own.change === 2 : n.own.change) && !tree.isFolder(n))
    .map((n) => ({ path: n.path, last: n.hits.reduce((last, h) => (h.kind === 'change' && (h.exact || !exact) && h.last > last ? h.last : last), '') }))
    .sort((a, b) => compare(b.last, a.last) || compare(a.path, b.path));
  const folders = new Map<string, string>();
  for (const f of files) {
    if (folders.size >= OPEN_FOLDERS) break;
    const parent = parentPath(f.path);
    if (parent) folders.set(pathKey(parent, env), parent);
  }
  return [...folders.values()];
}

/** Orders ISO times and keys by code unit, the same in every locale. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function createServer(app: App): http.Server {
  const server = http.createServer((req, res) => {
    // Only this machine's browser may ask; this also turns away DNS-rebinding pages.
    const { port } = server.address() as AddressInfo;
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) {
      res.writeHead(403).end();
      return;
    }
    handle(app, req, res).catch((err: Error) => {
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: err.message });
    });
  });
  return server;
}

async function handle(app: App, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const file = STATIC[url.pathname];
  if (req.method === 'GET' && file) {
    // Read before writing the head, so a missing file still gets its 500.
    const body = fs.readFileSync(path.join(PUBLIC, file));
    res.writeHead(200, { 'content-type': `${TYPES[path.extname(file)]}; charset=utf-8`, 'cache-control': 'no-cache' });
    res.end(body);
    return;
  }
  if (url.pathname === '/api/rescan' && req.method === 'POST') {
    void app.rescan();
    send(res, 202, app.status());
    return;
  }
  if (req.method !== 'GET') {
    send(res, 405, { error: 'Method not allowed' });
    return;
  }
  if (url.pathname === '/api/status') {
    send(res, 200, app.status());
    return;
  }
  if (!url.pathname.startsWith('/api/')) {
    send(res, 404, { error: 'Not found' });
    return;
  }
  if (!app.tree) {
    send(res, 503, { error: 'Still indexing' });
    return;
  }
  const p = url.searchParams.get('path') ?? '';
  const ref = url.searchParams.get('session') ?? undefined;
  if (ref !== undefined && !SESSION_REF.test(ref)) {
    send(res, 400, { error: 'Invalid session' });
    return;
  }
  switch (url.pathname) {
    case '/api/sessions':
      send(res, 200, { generation: app.generation, sessions: app.sessionRows() });
      return;
    case '/api/session': {
      if (ref === undefined) {
        send(res, 400, { error: 'Missing session' });
        return;
      }
      const session = app.session(ref);
      send(res, session ? 200 : 404, session ?? NO_SESSION);
      return;
    }
    case '/api/children':
    case '/api/coverage': {
      const tree = app.treeFor(ref);
      if (!tree) send(res, 404, NO_SESSION);
      else if (url.pathname === '/api/coverage') send(res, 200, await app.coverage(p, tree));
      else send(res, 200, await app.children(p, { all: url.searchParams.has('all'), ensure: url.searchParams.get('ensure') ?? undefined }, tree));
      return;
    }
    case '/api/touches':
      send(res, 200, app.touches(p));
      return;
    case '/api/resolve': {
      // Each quote on its own: a path copied from Explorer or a shell comes quoted, and often loses its closing one.
      const resolved = resolvePath(p.trim().replace(/^["']|["']$/g, ''), app.env.home, app.env);
      send(res, resolved ? 200 : 400, resolved ? { path: resolved } : { error: "That isn't a path on this machine." });
      return;
    }
  }
  send(res, 404, { error: 'Not found' });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

if (import.meta.main) {
  const port = Number(process.env.PORT) || 4477;
  const app = new App(systemPathEnv(), defaultSources(), defaultCacheFile());
  createServer(app).listen(port, '127.0.0.1', () => {
    console.log(`Did AI touch this? is running at http://localhost:${port}`);
  });
  void app.rescan();
}
