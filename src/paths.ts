import os from 'node:os';

/**
 * Canonical paths are absolute, use `/` separators and an uppercase drive letter on Windows
 * (`C:/Users/me/x.ts`, `C:/`), and are plain POSIX paths elsewhere (`/home/me/x.ts`, `/`).
 */
export interface PathEnv {
  home: string;
  /** The temp directory, which Git Bash calls /tmp. */
  temp: string;
  windows: boolean;
  /** Whether the filesystem ignores case, so `src/App.ts` and `src/app.ts` are one file. */
  caseInsensitive: boolean;
}

export function systemPathEnv(): PathEnv {
  const windows = process.platform === 'win32';
  const env: PathEnv = { home: '', temp: '', windows, caseInsensitive: windows || process.platform === 'darwin' };
  env.home = resolvePath(os.homedir(), undefined, env) ?? '/';
  env.temp = resolvePath(os.tmpdir(), undefined, env) ?? env.home;
  return env;
}

const DRIVE = /^([a-zA-Z]):(\/|$)/;

/**
 * Resolves a path as an agent wrote it, relative to `cwd`, to a canonical path with Claude Code
 * worktrees folded into their repo. Returns null for paths outside the filesystem, such as URLs
 * or /dev/null, and for relative paths without a cwd.
 */
export function resolvePath(raw: string, cwd: string | undefined, env: PathEnv): string | null {
  let p = raw.trim();
  if (!p || p.length > 1024 || /[\n\r\0\u0001]/.test(p)) return null;
  if (/^file:\/\//i.test(p)) {
    try { p = decodeURIComponent(p.replace(/^file:\/\/(localhost)?/i, '')); } catch { return null; }
    if (env.windows) p = p.replace(/^\/([a-zA-Z]:)/, '$1');
  } else if (/^[a-z][a-z0-9+.-]+:\/\//i.test(p)) {
    return null;
  }
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = env.home + p.slice(1);

  if (env.windows) {
    if (/^(nul|con|\$null)$/i.test(p)) return null;
    p = p.replace(/\\/g, '/');
    if (p.startsWith('//')) return null; // UNC and device paths
    // /c/x is a drive in Git Bash; a bare /s is more likely a cmd switch, as in rmdir /s /q.
    const msys = /^\/(?:mnt\/|cygdrive\/)?([a-zA-Z])\//.exec(p);
    if (msys) p = `${msys[1]}:/${p.slice(msys[0].length)}`;
    else if (p === '/tmp' || p.startsWith('/tmp/')) p = env.temp + p.slice(4);
    else if (p.startsWith('/')) return null; // other MSYS paths, such as /dev/null or /usr/bin
    else if (/^[a-zA-Z]:[^/]/.test(p)) p = `${p.slice(0, 2)}/${p.slice(2)}`;
  } else if (p === '/dev' || p.startsWith('/dev/')) {
    return null;
  }

  const absolute = env.windows ? DRIVE.test(p) : p.startsWith('/');
  if (!absolute) {
    const base = cwd ? resolvePath(cwd, undefined, env) : null;
    if (!base) return null;
    p = `${base}/${p}`;
  }
  return foldWorktrees(normalize(p, env.windows));
}

/** The part of a glob pattern before its first wildcard, such as `src/` for `src/**\/*.ts`. */
export function globBase(pattern: string): string {
  let out = '';
  for (const part of pattern.split(/(?<=[\\/])/)) {
    if (/[*?[{]/.test(part)) break;
    out += part;
  }
  return out || '.';
}

function normalize(p: string, windows: boolean): string {
  let root = '/';
  let rest = p;
  if (windows) {
    root = `${p[0]!.toUpperCase()}:/`;
    rest = p.slice(2);
  }
  const out: string[] = [];
  for (const seg of rest.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return root + out.join('/');
}

/** Maps `<repo>/.claude/worktrees/<name>/x` to `<repo>/x`, so a repo's worktrees count as the repo. */
function foldWorktrees(p: string): string {
  const folded = p.replace(/\/\.claude\/worktrees\/[^/]+(?=\/|$)/gi, '');
  return folded.includes('/') ? folded : `${folded}/`;
}

/** Splits a canonical path into its root (`C:` or `/`) and names. */
export function splitPath(p: string): string[] {
  if (p === '/') return ['/'];
  if (p.startsWith('/')) return ['/', ...p.slice(1).split('/')];
  const [drive, ...rest] = p.split('/');
  return [drive!, ...rest.filter(Boolean)];
}

export function joinPath(parent: string, name: string): string {
  if (parent === '') return name === '/' ? '/' : `${name}/`;
  return parent.endsWith('/') ? parent + name : `${parent}/${name}`;
}

export function parentPath(p: string): string | null {
  const parts = splitPath(p);
  if (parts.length <= 1) return null;
  let out = '';
  for (const part of parts.slice(0, -1)) out = joinPath(out, part);
  return out;
}

export function baseName(p: string): string {
  const parts = splitPath(p);
  return parts[parts.length - 1]!;
}

/** The key two spellings of one file share. */
export function pathKey(p: string, env: PathEnv): string {
  return env.caseInsensitive ? p.toLowerCase() : p;
}

/** Whether a file or folder name looks like a file: it has an extension or is a well-known file. */
export function looksLikeFile(p: string): boolean {
  const name = p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  return name.lastIndexOf('.') > 0 || KNOWN_FILES.has(name.toLowerCase());
}

const KNOWN_FILES = new Set([
  'makefile', 'dockerfile', 'license', 'licence', 'readme', 'changelog', 'gemfile', 'rakefile',
  'procfile', 'jenkinsfile', 'vagrantfile', 'codeowners', '.gitignore', '.gitattributes',
  '.gitmodules', '.env', '.npmrc', '.nvmrc', '.editorconfig', '.prettierrc', '.eslintrc',
  '.dockerignore', '.bashrc', '.zshrc', '.profile', '.bash_profile', '.worktreeinclude',
]);
