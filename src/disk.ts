import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { joinPath, parentPath, pathKey, splitPath, type PathEnv } from './paths.ts';

/** Folders of dependencies and caches, which coverage leaves out outside git repos. */
const SKIP = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', '.next', '.turbo', '.pnpm-store', '.gradle']);

/** How many entries counting a folder outside a repo may visit before it gives up. */
const WALK_BUDGET = 30_000;

export interface DirEntry {
  name: string;
  dir: boolean;
}

interface RepoFiles {
  files: Set<string>;
  /** Files under each folder, by relative key; '' is the repo itself. */
  perDir: Map<string, number>;
}

/**
 * The filesystem as coverage sees it. Coverage counts the files on disk that matter: inside a
 * git repo, those git tracks or would track (so ignored build output and dependencies don't
 * count); elsewhere, every file outside dependency and cache folders.
 */
export class Disk {
  private readonly env: PathEnv;
  private readonly repoRoots = new Map<string, Promise<string | null>>();
  private readonly repoFiles = new Map<string, Promise<RepoFiles | null>>();
  private readonly totals = new Map<string, Promise<number | null>>();

  constructor(env: PathEnv) {
    this.env = env;
  }

  async list(dir: string): Promise<DirEntry[] | null> {
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, dir: e.isDirectory() }));
    } catch {
      return null;
    }
  }

  /** How many files count for coverage at or under a folder, or null when there are too many to count. */
  total(dir: string): Promise<number | null> {
    const key = pathKey(dir, this.env);
    let total = this.totals.get(key);
    if (!total) {
      total = this.count(dir);
      this.totals.set(key, total);
    }
    return total;
  }

  /** Whether a file counts for coverage. */
  async counts(file: string): Promise<boolean> {
    const parent = parentPath(file);
    const root = parent ? await this.repoRoot(parent) : null;
    const repo = root ? await this.filesOf(root) : null;
    if (root && repo) return repo.files.has(this.rel(root, file));
    if (splitPath(file).some((part) => SKIP.has(part))) return false;
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  }

  private async count(dir: string): Promise<number | null> {
    if (splitPath(dir).some((part) => SKIP.has(part))) return 0;
    const root = await this.repoRoot(dir);
    const repo = root ? await this.filesOf(root) : null;
    if (root && repo) return repo.perDir.get(this.rel(root, dir)) ?? 0;

    let budget = WALK_BUDGET;
    let total = 0;
    const queue = [dir];
    while (queue.length) {
      const current = queue.pop()!;
      const entries = await this.list(current);
      if (!entries) continue;
      if (current !== dir && entries.some((e) => e.name === '.git')) {
        const nested = await this.total(current);
        if (nested === null) return null;
        total += nested;
        continue;
      }
      for (const e of entries) {
        if (--budget < 0) return null;
        if (!e.dir) total++;
        else if (!SKIP.has(e.name)) queue.push(joinPath(current, e.name));
      }
    }
    return total;
  }

  /** The git repo a folder is in: the nearest folder at or above it with a .git. */
  private repoRoot(dir: string): Promise<string | null> {
    const key = pathKey(dir, this.env);
    let root = this.repoRoots.get(key);
    if (!root) {
      root = (async () => {
        if (fs.existsSync(joinPath(dir, '.git'))) return dir;
        const parent = parentPath(dir);
        return parent ? this.repoRoot(parent) : null;
      })();
      this.repoRoots.set(key, root);
    }
    return root;
  }

  /** The files git tracks or would track in a repo, or null when git can't list them. */
  private filesOf(root: string): Promise<RepoFiles | null> {
    const key = pathKey(root, this.env);
    let files = this.repoFiles.get(key);
    if (!files) {
      files = (async () => {
        const listed = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
        if (listed === null) return null;
        const deleted = new Set((await git(root, ['ls-files', '-z', '--deleted'])) ?? []);
        const repo: RepoFiles = { files: new Set(), perDir: new Map() };
        for (const rel of listed) {
          // A nested repo shows up as its folder, ending in a slash.
          if (deleted.has(rel) || rel.endsWith('/')) continue;
          const relKey = pathKey(rel, this.env);
          if (repo.files.has(relKey)) continue;
          repo.files.add(relKey);
          const parts = relKey.split('/');
          for (let i = 0; i < parts.length; i++) {
            const dirKey = parts.slice(0, i).join('/');
            repo.perDir.set(dirKey, (repo.perDir.get(dirKey) ?? 0) + 1);
          }
        }
        return repo;
      })();
      this.repoFiles.set(key, files);
    }
    return files;
  }

  private rel(root: string, p: string): string {
    return pathKey(p.slice(root.length).replace(/^\/+/, ''), this.env);
  }
}

function git(cwd: string, args: string[]): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { maxBuffer: 512 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : stdout.split('\0').filter(Boolean));
    });
  });
}
