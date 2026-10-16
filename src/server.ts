import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Disk } from './disk.ts';
import type { TouchKind } from './model.ts';
import { joinPath, looksLikeFile, pathKey, resolvePath, systemPathEnv, type PathEnv } from './paths.ts';
import { defaultCacheFile, defaultSources, scan, type Progress, type Sources } from './scan.ts';
import { KINDS, TouchTree, type Counts, type Level, type TreeNode } from './tree.ts';

/** Untouched entries a folder lists before the rest wait behind "show more". */
const UNTOUCHED_LIMIT = 300;

const PUBLIC = path.join(import.meta.dirname, '..', 'public');
const STATIC: Record<string, string> = {
  '/': 'index.html',
  '/app.js': 'app.js',
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
      const sessions = await scan(this.sources, this.cacheFile, this.env, (p) => (this.progress = p));
      this.tree = new TouchTree(sessions, this.env);
      this.disk = new Disk(this.env);
      this.generation++;
      this.scannedAt = new Date().toISOString();
    } catch (err) {
      this.error = (err as Error).message;
      console.error(err);
    } finally {
      this.scanning = false;
    }
  }

  status() {
    const sessions = this.tree?.sessions ?? [];
    return {
      scanning: this.scanning,
      progress: this.progress,
      error: this.error,
      scannedAt: this.scannedAt,
      generation: this.generation,
      windows: this.env.windows,
      sessions: { claude: sessions.filter((s) => s.agent === 'claude').length, codex: sessions.filter((s) => s.agent === 'codex').length },
      counts: this.tree?.root.counts ?? null,
      start: this.tree?.start() ?? null,
    };
  }

  /** A folder's entries: what's on disk now, plus touched paths that no longer are. */
  async children(dir: string, opts: { all?: boolean; ensure?: string }) {
    const tree = this.tree!;
    const node = tree.find(dir);
    const entries = new Map<string, Entry>();
    const listing = dir === '' ? null : await this.disk.list(dir);
    for (const d of listing ?? []) {
      const key = pathKey(d.name, this.env);
      entries.set(key, entry(d.name, joinPath(dir, d.name), d.dir, true, node?.children.get(key)));
    }
    for (const [key, child] of node?.children ?? []) {
      if (entries.has(key)) continue;
      // Gone from disk: a folder if it has children, else a file if it was read, changed or looks like one.
      const dirLike = child.children.size > 0 || (!child.own.read && !child.own.change && !looksLikeFile(child.name));
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
  async coverage(dir: string) {
    // '' is the list of drives, which has no files of its own to count.
    const total = dir ? await this.disk.total(dir) : null;
    const node = this.tree!.find(dir);
    const cov = { path: dir, total, read: 0, readExact: 0, change: 0, changeExact: 0 };
    if (total === null || !node) return cov;
    for (const n of this.tree!.nodesUnder(node)) {
      if (n.children.size || !(n.own.read || n.own.change) || !(await this.disk.counts(n.path))) continue;
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
        agent: a.session.agent,
        id: a.session.id,
        title: a.session.title,
        cwd: a.session.cwd ?? null,
        start: a.session.start ?? null,
        end: a.session.end ?? null,
        resume: resumeCommand(a.session.agent, a.session.id, a.session.cwd),
        levels: a.levels,
        tools: a.tools,
        counts: a.counts,
        exactCounts: a.exactCounts,
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
    counts: node?.counts ?? { read: 0, readExact: 0, change: 0, changeExact: 0, search: 0, searchExact: 0 },
  };
}

function touched(e: Entry): boolean {
  return KINDS.some((k) => e.counts[k] > 0);
}

function resumeCommand(agent: string, id: string, cwd: string | undefined): string {
  const command = agent === 'claude' ? `claude --resume ${id}` : `codex resume ${id}`;
  return cwd ? `cd "${cwd}"; ${command}` : command;
}

export function createServer(app: App, port: number): http.Server {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  return http.createServer((req, res) => {
    // Only this machine's browser may ask; this also turns away DNS-rebinding pages.
    if (!allowedHosts.has(req.headers.host ?? '')) {
      res.writeHead(403).end();
      return;
    }
    handle(app, req, res).catch((err: Error) => {
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: err.message });
    });
  });
}

async function handle(app: App, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const file = STATIC[url.pathname];
  if (req.method === 'GET' && file) {
    res.writeHead(200, { 'content-type': `${TYPES[path.extname(file)]}; charset=utf-8`, 'cache-control': 'no-cache' });
    res.end(fs.readFileSync(path.join(PUBLIC, file)));
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
  switch (url.pathname) {
    case '/api/children':
      send(res, 200, await app.children(p, { all: url.searchParams.has('all'), ensure: url.searchParams.get('ensure') ?? undefined }));
      return;
    case '/api/coverage':
      send(res, 200, await app.coverage(p));
      return;
    case '/api/touches':
      send(res, 200, app.touches(p));
      return;
    case '/api/resolve': {
      const resolved = resolvePath(p.replace(/^["']|["']$/g, ''), app.env.home, app.env);
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
  createServer(app, port).listen(port, '127.0.0.1', () => {
    console.log(`Did AI touch this? is running at http://localhost:${port}`);
  });
  void app.rescan();
}
